"""Regression checks for the reversible, same-filesystem data consolidation."""
import importlib.util
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('consolidation', Path(__file__).parents[1] / 'scripts/consolidate-data.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class ConsolidationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='winboat-consolidation-test-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.home = self.root / 'home'
        self.workspace = self.root / 'workspace'
        self.workspace.mkdir()
        for directory in ['.winboat', 'winboat', '.config/winboat']:
            (self.home / directory).mkdir(parents=True)
        (self.home / '.winboat/docker-compose.yml').write_text('original compose')
        (self.home / '.config/winboat/config.json').write_text('{}')
        self.disk = self.home / 'winboat/data.img'
        with self.disk.open('wb') as stream:
            stream.seek(16 * 1024 * 1024)
            stream.write(b'windows fixture')
        self.addCleanup(patch.stopall)
        patch.object(module, 'ensure_stopped').start()
        patch.dict(os.environ, {'XDG_DATA_HOME': str(self.home / '.local/share')}).start()

    def test_move_and_rollback_preserve_sparse_disk_identity(self):
        before = self.disk.stat()
        module.consolidate(self.home, self.workspace, apply=True)
        moved = self.disk.stat()
        self.assertEqual((before.st_ino, before.st_size, before.st_blocks, before.st_mtime_ns),
                         (moved.st_ino, moved.st_size, moved.st_blocks, moved.st_mtime_ns))
        self.assertTrue((self.home / 'winboat').is_symlink())
        journal = next((self.workspace / 'backups').glob('*/migration.json'))
        module.undo(journal)
        self.assertFalse((self.home / 'winboat').is_symlink())
        self.assertEqual(self.disk.stat().st_ino, before.st_ino)
        self.assertEqual((self.home / '.winboat/docker-compose.yml').read_text(), 'original compose')

    def test_existing_destination_leaves_originals_untouched(self):
        (self.workspace / 'data/installations/legacy').mkdir(parents=True)
        before = self.disk.stat().st_ino
        with self.assertRaisesRegex(RuntimeError, 'already exists'):
            module.consolidate(self.home, self.workspace, apply=True)
        self.assertFalse((self.home / '.winboat').is_symlink())
        self.assertEqual(self.disk.stat().st_ino, before)

    def test_symlink_failure_rolls_moves_back(self):
        before = self.disk.stat().st_ino
        with patch.object(Path, 'symlink_to', side_effect=OSError('simulated symlink failure')):
            with self.assertRaisesRegex(OSError, 'simulated'):
                module.consolidate(self.home, self.workspace, apply=True)
        self.assertTrue((self.home / '.winboat').is_dir())
        self.assertFalse((self.home / '.winboat').is_symlink())
        self.assertEqual(self.disk.stat().st_ino, before)

    def test_dry_run_changes_nothing(self):
        module.consolidate(self.home, self.workspace)
        self.assertEqual(list(self.workspace.iterdir()), [])
        self.assertFalse((self.home / '.winboat').is_symlink())


if __name__ == '__main__':
    unittest.main()
