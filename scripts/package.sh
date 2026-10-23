#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
[[ -x dist/linux-unpacked/winboat && -f dist/linux-unpacked/build-manifest.json ]] || {
    echo 'No complete build. Run make build first.' >&2; exit 1;
}
release_id=$(python3 -c 'import json; print(json.load(open("dist/linux-unpacked/build-manifest.json"))["releaseId"])')
[[ $release_id =~ ^[A-Za-z0-9._-]+$ ]] || exit 1
stage=$(mktemp -d "$PWD/dist/.package.XXXXXX")
trap 'rm -rf -- "$stage"' EXIT
mkdir -p "$stage/winboat/scripts" "$stage/winboat/icons" "$stage/winboat/dist"
cp Makefile "$stage/winboat/"
cp scripts/install.sh "$stage/winboat/scripts/"
cp icons/winboat_logo.svg "$stage/winboat/icons/"
cp docs/custom-build.md "$stage/winboat/README.md"
cp -a dist/linux-unpacked "$stage/winboat/dist/"
artifact="dist/winboat-$release_id-$(uname -m).tar.gz"
tar -C "$stage" -czf "$artifact" winboat
(cd dist && sha256sum "$(basename "$artifact")" > "$(basename "$artifact").sha256")
printf 'Installable archive: %s\n' "$artifact"
