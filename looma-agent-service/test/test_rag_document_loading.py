import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from llama_index.core import Document
from rag import index_service as service


class DocumentLoadingTests(unittest.TestCase):
    def test_shared_scan_excludes_generated_files_and_symlinks(self):
        with tempfile.TemporaryDirectory() as directory, tempfile.TemporaryDirectory() as outside:
            workspace = Path(directory).resolve()
            accepted = ['a.md', 'notes/b.TXT', 'paper.pdf']
            ignored = ['.looma/a.md', '.git/a.md', 'node_modules/a.txt', 'dist/a.pdf', 'build/a.md', 'a.log', 'image.png', 'other.csv']
            for name in accepted + ignored:
                path = workspace / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text('example')
            external = Path(outside) / 'private.md'
            external.write_text('private')
            (workspace / 'external.md').symlink_to(external)
            (workspace / 'alias.md').symlink_to(workspace / 'a.md')
            (workspace / 'external-dir').symlink_to(Path(outside), target_is_directory=True)
            scanned, excluded = service.scan_indexable_files(workspace)
            self.assertEqual({p.relative_to(workspace).as_posix() for p in scanned}, set(accepted))
            self.assertTrue(set(ignored + ['external.md', 'alias.md']).issubset({p.relative_to(workspace).as_posix() for p in excluded}))
            self.assertEqual(scanned, service.collect_indexable_files(workspace))
            self.assertTrue(all(isinstance(path, Path) for path in excluded))


if __name__ == '__main__':
    unittest.main()
