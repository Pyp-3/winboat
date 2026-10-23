#!/usr/bin/env bash
set -euo pipefail
repo=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
scratch=$(mktemp -d)
trap 'rm -rf -- "$scratch"' EXIT
payload="$scratch/payload"
mkdir -p "$payload/resources"
printf '#!/bin/sh\nexit 0\n' > "$payload/winboat"
chmod +x "$payload/winboat"
manifest() {
    python3 - "$payload" "$1" <<'PY'
import hashlib,json,pathlib,sys
root=pathlib.Path(sys.argv[1]); release=sys.argv[2]
(root/'resources/app.asar').write_text(release)
h=hashlib.sha256()
for p in sorted(root.rglob('*')):
    if p.is_file() and p.name != 'build-manifest.json':
        h.update(str(p.relative_to(root)).encode());h.update(p.read_bytes())
(root/'build-manifest.json').write_text(json.dumps({'releaseId':release,'payloadSha256':h.hexdigest()}))
PY
}
run_install() { bash "$repo/scripts/install.sh" "$1" "$payload" /opt/winboat-test /usr/local "$scratch/stage" >/dev/null; }
manifest release-one
run_install install
[[ $(readlink "$scratch/stage/opt/winboat-test/current") == releases/release-one ]]
[[ -x $scratch/stage/usr/local/bin/winboat ]]
manifest release-two
run_install install
[[ $(readlink "$scratch/stage/opt/winboat-test/current") == releases/release-two ]]
[[ $(readlink "$scratch/stage/opt/winboat-test/previous") == releases/release-one ]]
run_install rollback
[[ $(readlink "$scratch/stage/opt/winboat-test/current") == releases/release-one ]]
printf 'corrupt\n' >> "$payload/resources/app.asar"
if run_install install 2>/dev/null; then echo 'Installer accepted a corrupt payload' >&2; exit 1; fi
[[ $(readlink "$scratch/stage/opt/winboat-test/current") == releases/release-one ]]
manifest release-three
printf 'unrelated launcher\n' > "$scratch/stage/usr/local/bin/winboat"
if run_install install 2>/dev/null; then echo 'Installer overwrote an unrelated launcher' >&2; exit 1; fi
grep -q '^unrelated launcher$' "$scratch/stage/usr/local/bin/winboat"
[[ $(readlink "$scratch/stage/opt/winboat-test/current") == releases/release-one ]]
[[ -f $scratch/stage/opt/winboat-test/releases/release-two/resources/app.asar ]]
printf 'Installer tests passed (activation, rollback, corruption, collision preservation).\n'
