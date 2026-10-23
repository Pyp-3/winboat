#!/usr/bin/env python3
"""Identify exactly the payload that was built, without reading user VM data."""
import datetime
import hashlib
import json
from pathlib import Path
import subprocess

root = Path(__file__).resolve().parent.parent
payload = root / 'dist/linux-unpacked'
version = json.loads((root / 'package.json').read_text())['version']
commit = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=root, text=True).strip()
dirty = bool(subprocess.check_output(['git', 'status', '--porcelain'], cwd=root, text=True).strip())
digest = hashlib.sha256()
for file in sorted(payload.rglob('*')):
    if file.is_symlink():
        raise SystemExit(f'Unexpected symlink in build: {file}')
    if file.is_file() and file.name != 'build-manifest.json':
        digest.update(str(file.relative_to(payload)).encode())
        with file.open('rb') as data:
            for block in iter(lambda: data.read(1024 * 1024), b''):
                digest.update(block)
built = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
manifest = {'version': version, 'commit': commit, 'dirty': dirty, 'builtAt': built,
            'payloadSha256': digest.hexdigest(),
            'releaseId': f'{version}-{commit[:12]}-{digest.hexdigest()[:12]}'}
(payload / 'build-manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
print(f'Built {manifest["releaseId"]}; install with sudo make install')
