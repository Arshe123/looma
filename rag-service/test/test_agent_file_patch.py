import asyncio
import hashlib
import os
import tempfile
import unittest
from pathlib import Path

from agent.tools import AgentToolContext, FilePatchTool, ToolRegistry


def sha256_text(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


class FilePatchToolTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.workspace = Path(self.temp_dir.name) / "workspace"
        self.workspace.mkdir()
        self.context = AgentToolContext(workspace_path=self.workspace)
        self.registry = ToolRegistry(allowed_tools={"file_patch"})
        self.registry.register(FilePatchTool())

    def tearDown(self):
        self.temp_dir.cleanup()

    async def execute(self, **arguments):
        return await self.registry.execute(
            "file_patch",
            self.context,
            arguments,
            enabled_tools={"file_patch"},
            allow_write=True,
        )

    async def test_create_proposal_uses_relative_path_and_utf8_content(self):
        result = await self.execute(
            path="notes/todo.md",
            new_content="# Todo\n\n- item\n",
        )

        self.assertTrue(result.success)
        self.assertEqual(result.data["operation"], "create")
        self.assertEqual(result.data["path"], "notes/todo.md")
        self.assertIsNone(result.data["expected_sha256"])
        self.assertEqual(result.data["proposed_content"], "# Todo\n\n- item\n")
        self.assertIn("--- /dev/null", result.data["unified_diff"])
        self.assertFalse((self.workspace / "notes" / "todo.md").exists())

    async def test_update_proposal_includes_expected_hash_and_diff(self):
        target = self.workspace / "notes.md"
        target.write_text("alpha\nbeta\n", encoding="utf-8", newline="\n")

        result = await self.execute(
            path="notes.md",
            old_text="beta",
            new_text="gamma",
        )

        self.assertTrue(result.success)
        self.assertEqual(result.data["operation"], "update")
        self.assertEqual(result.data["expected_sha256"], sha256_text("alpha\nbeta\n"))
        self.assertEqual(result.data["proposed_content"], "alpha\ngamma\n")
        self.assertIn("-beta", result.data["unified_diff"])
        self.assertIn("+gamma", result.data["unified_diff"])
        self.assertEqual(target.read_text(encoding="utf-8"), "alpha\nbeta\n")

    async def test_unique_replace_is_required_for_update(self):
        target = self.workspace / "repeat.txt"
        target.write_text("same same", encoding="utf-8", newline="\n")

        result = await self.execute(
            path="repeat.txt",
            old_text="same",
            new_text="other",
        )

        self.assertFalse(result.success)
        self.assertEqual(result.error.code, "tool_invalid_arguments")

    async def test_update_requires_existing_match(self):
        target = self.workspace / "missing-match.txt"
        target.write_text("content", encoding="utf-8", newline="\n")

        result = await self.execute(
            path="missing-match.txt",
            old_text="absent",
            new_text="next",
        )

        self.assertFalse(result.success)
        self.assertEqual(result.error.code, "tool_invalid_arguments")

    async def test_escape_and_internal_paths_are_rejected(self):
        for path in ("../outside.txt", ".looma/config.json", str(self.workspace / "abs.txt")):
            with self.subTest(path=path):
                result = await self.execute(path=path, new_content="x")
                self.assertFalse(result.success)
                self.assertEqual(result.error.code, "tool_invalid_arguments")

    async def test_binary_and_large_files_are_rejected(self):
        binary = self.workspace / "bin.dat"
        binary.write_bytes(b"\x00\x01\x02")
        large = self.workspace / "large.txt"
        large.write_text("x" * 200_001, encoding="utf-8")

        binary_result = await self.execute(
            path="bin.dat",
            old_text="",
            new_text="next",
        )
        large_result = await self.execute(
            path="large.txt",
            old_text="x",
            new_text="y",
        )

        self.assertFalse(binary_result.success)
        self.assertEqual(binary_result.error.code, "tool_invalid_arguments")
        self.assertFalse(large_result.success)
        self.assertEqual(large_result.error.code, "tool_invalid_arguments")

    async def test_existing_target_for_create_is_rejected(self):
        target = self.workspace / "exists.txt"
        target.write_text("hello", encoding="utf-8", newline="\n")

        result = await self.execute(path="exists.txt", new_content="new")

        self.assertFalse(result.success)
        self.assertEqual(result.error.code, "tool_invalid_arguments")

    async def test_symlink_and_junction_like_targets_are_rejected_when_supported(self):
        target = self.workspace / "real.txt"
        target.write_text("hello", encoding="utf-8", newline="\n")
        alias = self.workspace / "alias.txt"
        try:
            os.symlink(target, alias)
        except (OSError, NotImplementedError):
            self.skipTest("symbolic links are unavailable on this platform")

        result = await self.execute(
            path="alias.txt",
            old_text="hello",
            new_text="bye",
        )

        self.assertFalse(result.success)
        self.assertEqual(result.error.code, "tool_invalid_arguments")

    async def test_write_access_must_be_explicitly_allowed(self):
        result = await self.registry.execute(
            "file_patch",
            self.context,
            {"path": "a.txt", "new_content": "x"},
            enabled_tools={"file_patch"},
            allow_write=False,
        )

        self.assertFalse(result.success)
        self.assertEqual(result.error.code, "tool_write_not_allowed")


if __name__ == "__main__":
    unittest.main()
