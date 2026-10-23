#!/usr/bin/env bash
set -euo pipefail
repo=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
scratch=$(mktemp -d)
trap 'rm -rf -- "$scratch"' EXIT
export GIT_CONFIG_NOSYSTEM=1
export GIT_CONFIG_GLOBAL=/dev/null
export GIT_AUTHOR_NAME='WinBoat tests' GIT_COMMITTER_NAME='WinBoat tests'
export GIT_AUTHOR_EMAIL='test@example.invalid' GIT_COMMITTER_EMAIL='test@example.invalid'
git init -q -b main "$scratch/upstream"
mkdir -p "$scratch/upstream/scripts"
cp "$repo/scripts/sync-upstream.sh" "$scratch/upstream/scripts/"
cat > "$scratch/upstream/Makefile" <<'MAKE'
build:
	mkdir -p dist/linux-unpacked
	printf '#!/bin/sh\nexit 0\n' > dist/linux-unpacked/winboat
	chmod +x dist/linux-unpacked/winboat
	printf '{}' > dist/linux-unpacked/build-manifest.json
package:
	@true
MAKE
printf 'dist\n' > "$scratch/upstream/.gitignore"
printf 'base\n' > "$scratch/upstream/conflict.txt"
git -C "$scratch/upstream" add .
git -C "$scratch/upstream" commit -qm initial
git clone -q "$scratch/upstream" "$scratch/workspace/source"
git -C "$scratch/workspace/source" remote rename origin upstream
sync_command() { bash "$scratch/workspace/source/scripts/sync-upstream.sh" > "$scratch/sync.log" 2>&1; }
printf 'upstream feature\n' > "$scratch/upstream/feature.txt"
git -C "$scratch/upstream" add .
git -C "$scratch/upstream" commit -qm feature
sync_command || { cat "$scratch/sync.log"; exit 1; }
[[ -x $scratch/workspace/source/dist/linux-unpacked/winboat ]]
[[ $(git -C "$scratch/workspace/source" rev-parse HEAD) == $(git -C "$scratch/upstream" rev-parse HEAD) ]]
printf 'local change\n' > "$scratch/workspace/source/conflict.txt"
git -C "$scratch/workspace/source" add .
git -C "$scratch/workspace/source" commit -qm local
before=$(git -C "$scratch/workspace/source" rev-parse HEAD)
printf 'remote change\n' > "$scratch/upstream/conflict.txt"
git -C "$scratch/upstream" add .
git -C "$scratch/upstream" commit -qm conflict
if sync_command; then echo 'Sync accepted a conflicting merge' >&2; exit 1; fi
[[ $(git -C "$scratch/workspace/source" rev-parse HEAD) == "$before" ]]
[[ -z $(git -C "$scratch/workspace/source" status --porcelain) ]]
[[ -x $scratch/workspace/source/dist/linux-unpacked/winboat ]]
# A cleanly merged candidate must also pass its build before changing the branch.
git -C "$scratch/upstream" revert --no-edit HEAD >/dev/null
printf 'build:\n\tfalse\npackage:\n\ttrue\n' > "$scratch/upstream/Makefile"
git -C "$scratch/upstream" add .
git -C "$scratch/upstream" commit -qm broken-build
if sync_command; then echo 'Sync accepted a failed build' >&2; exit 1; fi
[[ $(git -C "$scratch/workspace/source" rev-parse HEAD) == "$before" ]]
[[ -z $(git -C "$scratch/workspace/source" status --porcelain) ]]
[[ -x $scratch/workspace/source/dist/linux-unpacked/winboat ]]
printf 'uncommitted\n' > "$scratch/workspace/source/untracked"
if sync_command; then echo 'Sync accepted uncommitted changes' >&2; exit 1; fi
[[ $(git -C "$scratch/workspace/source" rev-parse HEAD) == "$before" ]]
printf 'Sync tests passed (success, conflict, failed build, dirty checkout preservation).\n'
