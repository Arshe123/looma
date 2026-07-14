import os
import tempfile
import unittest
from pathlib import Path

from agent.security import WorkspaceSecurityError, resolve_workspace_path


class WorkspaceSecurityTest(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.workspace = Path(self.temp_dir.name) / "workspace"
        self.workspace.mkdir()
        (self.workspace / "docs").mkdir()
        (self.workspace / "docs" / "guide.md").write_text("guide", encoding="utf-8")

    def tearDown(self):
        self.temp_dir.cleanup()

    def assertSecurityCode(self, expected_code, workspace, relative_path, **kwargs):
        with self.assertRaises(WorkspaceSecurityError) as caught:
            resolve_workspace_path(workspace, relative_path, **kwargs)
        self.assertEqual(caught.exception.code, expected_code)

    def test_dot_resolves_workspace_root(self):
        resolved = resolve_workspace_path(self.workspace, ".")

        self.assertEqual(resolved, self.workspace.resolve())

    def test_normal_child_and_both_separators_resolve(self):
        for path in ("docs/guide.md", r"docs\guide.md"):
            with self.subTest(path=path):
                resolved = resolve_workspace_path(self.workspace, path, must_exist=True)
                self.assertEqual(resolved, (self.workspace / "docs" / "guide.md").resolve())

    def test_parent_escape_is_rejected(self):
        self.assertSecurityCode("workspace_path_escape", self.workspace, "../outside.txt")

    def test_parent_segment_is_rejected_even_when_normalized_inside_workspace(self):
        self.assertSecurityCode("workspace_path_escape", self.workspace, "a/../safe.txt")

    def test_absolute_paths_are_rejected(self):
        invalid_paths = (
            "/etc/passwd",
            r"C:\Windows\system.ini",
            r"C:relative.txt",
            r"\\server\share\file.txt",
            "//server/share/file.txt",
        )
        for path in invalid_paths:
            with self.subTest(path=path):
                self.assertSecurityCode("workspace_path_absolute", self.workspace, path)

    def test_empty_and_invalid_types_are_rejected(self):
        for path in ("", "   ", None, 123):
            with self.subTest(path=path):
                self.assertSecurityCode("workspace_path_invalid", self.workspace, path)

    def test_internal_looma_path_is_case_insensitively_rejected(self):
        for path in (".looma", ".LOOMA/index", "docs/.LooMa/cache"):
            with self.subTest(path=path):
                self.assertSecurityCode("workspace_internal_path", self.workspace, path)

        allowed = resolve_workspace_path(self.workspace, ".looma/index", allow_internal=True)
        self.assertEqual(allowed, (self.workspace / ".looma" / "index").resolve())

    def test_missing_or_non_directory_workspace_is_rejected(self):
        missing = Path(self.temp_dir.name) / "missing"
        self.assertSecurityCode("workspace_invalid", missing, ".")

        file_workspace = Path(self.temp_dir.name) / "file.txt"
        file_workspace.write_text("not a directory", encoding="utf-8")
        self.assertSecurityCode("workspace_invalid", file_workspace, ".")

    def test_must_exist_rejects_missing_target(self):
        self.assertSecurityCode(
            "workspace_target_missing",
            self.workspace,
            "docs/missing.md",
            must_exist=True,
        )

    def test_symlink_escape_is_rejected_when_supported(self):
        outside = Path(self.temp_dir.name) / "outside"
        outside.mkdir()
        link = self.workspace / "external"
        try:
            os.symlink(outside, link, target_is_directory=True)
        except (OSError, NotImplementedError):
            self.skipTest("symbolic links are unavailable on this platform")

        self.assertSecurityCode("workspace_path_escape", self.workspace, "external/secret.txt")

    def test_symlink_alias_to_internal_looma_is_rejected_when_supported(self):
        internal = self.workspace / ".looma"
        internal.mkdir()
        (internal / "secret.txt").write_text("secret", encoding="utf-8")
        alias = self.workspace / "cache"
        try:
            os.symlink(internal, alias, target_is_directory=True)
        except (OSError, NotImplementedError):
            self.skipTest("symbolic links are unavailable on this platform")

        self.assertSecurityCode(
            "workspace_internal_path", self.workspace, "cache/secret.txt"
        )


if __name__ == "__main__":
    unittest.main()
