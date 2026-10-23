#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
if [[ $EUID == 0 ]]; then
    echo 'Build as your regular user. Only installation needs sudo.' >&2
    exit 1
fi
BUN=${BUN:-bun}
for tool in "$BUN" go zip python3; do
    command -v "$tool" >/dev/null || { echo "Missing build tool: $tool" >&2; exit 1; }
done
export PATH="$(dirname "$(command -v "$BUN")"):$PWD/node_modules/.bin:$PATH"
"$BUN" install --frozen-lockfile
"$BUN" run check
"$BUN" test
bash tests/install.sh
bash tests/sync.sh
python3 -B tests/consolidation.py
"$BUN" run build:gs
"$BUN" scripts/build.ts
"$BUN" x --no-install electron-builder --linux dir --publish never
python3 scripts/build-manifest.py
