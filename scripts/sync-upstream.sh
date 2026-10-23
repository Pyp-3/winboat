#!/usr/bin/env bash
# Merge and build away from the working branch. Never install or push implicitly.
set -euo pipefail
repo=$(git -C "$(dirname "${BASH_SOURCE[0]}")/.." rev-parse --show-toplevel)
cd "$repo"
fail() { echo "WinBoat sync: $*" >&2; exit 1; }
[[ $EUID != 0 ]] || fail 'Run sync as your regular user, not with sudo.'
branch=$(git symbolic-ref --quiet --short HEAD) || fail 'Check out your custom branch before syncing.'
[[ -z $(git status --porcelain) ]] || fail 'Commit or stash your changes, including untracked files, before syncing.'
[[ ! -e $(git rev-parse --git-path MERGE_HEAD) && ! -d $(git rev-parse --git-path rebase-merge) && ! -d $(git rev-parse --git-path rebase-apply) ]] || fail 'Finish the current Git operation first.'
git remote get-url upstream >/dev/null || fail 'Add the upstream remote before syncing.'
upstream_branch=${WINBOAT_UPSTREAM_BRANCH:-main}
[[ $upstream_branch != -* ]] || fail 'Invalid upstream branch.'
git check-ref-format "refs/heads/$upstream_branch" >/dev/null || fail 'Invalid upstream branch.'
common_git=$(realpath "$(git rev-parse --git-common-dir)")
exec 9>"$common_git/winboat-sync.lock"
flock -n 9 || fail 'Another upstream sync is in progress.'
original=$(git rev-parse HEAD)
workspace=$(dirname "$repo")
mkdir -p "$workspace/worktrees" "$workspace/build-backups"
candidate=$(mktemp -d "$workspace/worktrees/sync.XXXXXX")
rmdir "$candidate"
cleanup() {
    if [[ -d $candidate ]]; then git worktree remove --force "$candidate" >/dev/null 2>&1 || true; fi
}
trap cleanup EXIT
printf 'Fetching upstream/%s...\n' "$upstream_branch"
git fetch upstream "$upstream_branch"
upstream_commit=$(git rev-parse FETCH_HEAD)
git worktree add --detach "$candidate" "$original"
if ! git -C "$candidate" merge --no-edit "$upstream_commit"; then
    git -C "$candidate" merge --abort >/dev/null 2>&1 || true
    fail 'Upstream cannot merge cleanly. Your branch and installed app have not changed.'
fi
printf 'Validating and building the candidate merge in %s...\n' "$candidate"
export PATH="$workspace/tools/bin:$PATH"
if ! make -C "$candidate" build package; then
    fail 'Candidate checks or build failed. Your branch and installed app have not changed.'
fi
[[ -x $candidate/dist/linux-unpacked/winboat && -f $candidate/dist/linux-unpacked/build-manifest.json ]] || fail 'Candidate build is incomplete.'
[[ $(git rev-parse HEAD) == "$original" && $(git symbolic-ref --short HEAD) == "$branch" && -z $(git status --porcelain) ]] || fail 'The working branch changed during validation. Nothing was applied.'
[[ ! -L $repo/dist ]] || fail 'dist is a symlink; refusing to replace it.'
new_commit=$(git -C "$candidate" rev-parse HEAD)
# The candidate is a descendant of the original commit. Only a fast-forward is allowed here.
git merge --ff-only "$new_commit"
backup=''
if [[ -d $repo/dist ]]; then
    backup=$(mktemp -d "$workspace/build-backups/build.XXXXXX")
    rmdir "$backup"
    mv -- "$repo/dist" "$backup"
fi
if ! mv -- "$candidate/dist" "$repo/dist"; then
    [[ -z $backup ]] || mv -- "$backup" "$repo/dist"
    fail "Could not move the validated build. Source is at $new_commit; the installed app is unchanged."
fi
printf '\nUpstream merged and a validated build is ready at %s/dist.\n' "$repo"
printf 'Install it when ready: cd %q && sudo make install\n' "$repo"
printf 'Push the branch separately when desired: git push origin %q\n' "$branch"
[[ -z $backup ]] || printf 'Previous uninstalled build saved in %s\n' "$backup"
