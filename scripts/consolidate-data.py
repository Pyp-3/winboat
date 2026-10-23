#!/usr/bin/env python3
"""Move legacy WinBoat data together, keeping its original paths usable.

Dry-run by default. This never copies or edits a Windows disk and never edits
Docker configuration. Run as the desktop user while WinBoat and Windows stop.
"""
import argparse
import datetime
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys


def ensure_stopped():
    for entry in Path('/proc').iterdir():
        if not entry.name.isdecimal():
            continue
        try:
            if (entry / 'comm').read_text().strip().lower() == 'winboat':
                raise RuntimeError('Close the WinBoat application first.')
        except (FileNotFoundError, PermissionError, ProcessLookupError):
            pass
    result = subprocess.run(['docker', 'inspect', 'WinBoat', '--format', '{{.State.Status}}'],
                            text=True, capture_output=True, check=True)
    if result.stdout.strip() not in ('exited', 'created'):
        raise RuntimeError('Shut down the existing Windows VM before moving its files.')


def write_journal(file, data):
    temp = file.with_suffix('.tmp')
    with temp.open('w') as stream:
        json.dump(data, stream, indent=2)
        stream.flush()
        os.fsync(stream.fileno())
    temp.chmod(0o600)
    temp.replace(file)


def undo(journal):
    data = json.loads(journal.read_text())
    for operation in reversed(data['operations']):
        old, new = Path(operation['old']), Path(operation['new'])
        if operation['kind'] == 'link':
            if old.is_symlink() and old.resolve() == new.resolve():
                old.unlink()
        else:
            # Recover whether interruption occurred before or after symlink creation.
            if new.exists():
                if old.is_symlink() and old.resolve() == new.resolve():
                    old.unlink()
                if old.exists() or old.is_symlink():
                    raise RuntimeError(f'Refusing to overwrite {old} during rollback.')
                new.rename(old)
    data['status'] = 'rolled-back'
    write_journal(journal, data)


def consolidate(home, workspace, apply=False):
    root = workspace / 'data'
    legacy = root / 'installations' / 'legacy'
    xdg = Path(os.environ.get('XDG_DATA_HOME', str(home / '.local/share'))) / 'winboat-app'
    moves = [(home / '.winboat', legacy), (home / 'winboat', legacy / 'storage'),
             (home / '.config/winboat', root / 'electron-user-data')]
    if all(old.is_symlink() and old.resolve() == new.resolve() for old, new in moves):
        print('Legacy data is already consolidated.')
        return
    for old, new in moves:
        if old.is_symlink() or not old.is_dir():
            raise RuntimeError(f'Expected an ordinary directory at {old}; no files moved.')
        if new.exists() or new.is_symlink():
            raise RuntimeError(f'Destination already exists: {new}; no files moved.')
        if old.stat().st_dev != workspace.stat().st_dev:
            raise RuntimeError('Source and destination must be on the same filesystem; no copy fallback.')
    if xdg.exists() or xdg.is_symlink():
        raise RuntimeError(f'Existing XDG data directory needs manual reconciliation: {xdg}')
    disk = home / 'winboat/data.img'
    if not disk.is_file():
        raise RuntimeError('Expected legacy data.img was not found; no files moved.')
    for old, new in moves:
        print(f'{old} -> {new} (keep compatibility symlink)')
    print(f'{xdg} -> {root}')
    if not apply:
        print('Dry run. Add --apply to perform these moves.')
        return
    ensure_stopped()
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    backup = workspace / 'backups' / ('consolidation-' + stamp)
    backup.mkdir(parents=True, mode=0o700)
    backup.parent.chmod(0o700)
    shutil.copytree(home / '.winboat', backup / 'legacy-config', symlinks=True)
    shutil.copytree(home / '.config/winboat', backup / 'electron-config', symlinks=True)
    stat = disk.stat()
    journal = backup / 'migration.json'
    data = {'status': 'in-progress', 'disk': {'inode': stat.st_ino, 'device': stat.st_dev,
            'size': stat.st_size, 'blocks': stat.st_blocks, 'mtime_ns': stat.st_mtime_ns}, 'operations': []}
    write_journal(journal, data)
    root.mkdir(mode=0o700, exist_ok=True)
    root.chmod(0o700)
    try:
        for old, new in moves:
            new.parent.mkdir(parents=True, exist_ok=True)
            data['operations'].append({'kind': 'move', 'old': str(old), 'new': str(new)})
            write_journal(journal, data)
            old.rename(new)
            old.symlink_to(new, target_is_directory=True)
        xdg.parent.mkdir(parents=True, exist_ok=True)
        data['operations'].append({'kind': 'link', 'old': str(xdg), 'new': str(root)})
        write_journal(journal, data)
        xdg.symlink_to(root, target_is_directory=True)
        after = disk.stat()
        assert (after.st_dev, after.st_ino, after.st_size, after.st_blocks, after.st_mtime_ns) == (
            stat.st_dev, stat.st_ino, stat.st_size, stat.st_blocks, stat.st_mtime_ns)
        data['status'] = 'complete'
        write_journal(journal, data)
    except BaseException:
        undo(journal)
        raise
    print(f'Consolidated successfully. Windows disk inode, size, allocation and modification time unchanged.\nJournal: {journal}')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--workspace', type=Path, default=Path('/opt/winboat-workspace'))
    parser.add_argument('--home', type=Path, default=Path.home())
    parser.add_argument('--apply', action='store_true')
    parser.add_argument('--undo', type=Path, metavar='JOURNAL')
    args = parser.parse_args()
    if os.geteuid() == 0:
        parser.error('Run as the desktop user, not root.')
    if args.undo:
        ensure_stopped()
        undo(args.undo)
        print('Original data paths restored. Configuration backups remain with the journal.')
    else:
        consolidate(args.home.resolve(), args.workspace.resolve(), args.apply)


if __name__ == '__main__':
    try:
        main()
    except (OSError, RuntimeError, subprocess.CalledProcessError) as error:
        print(f'Cannot consolidate: {error}', file=sys.stderr)
        sys.exit(1)
