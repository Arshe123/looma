import json
import os
import stat
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

from pydantic import ValidationError

from agent.security import WorkspaceSecurityError
from agent.tools import (
    FileReadArgs,
    FileReadTool,
    WorkspaceListArgs,
    WorkspaceListTool,
    WorkspaceSearchArgs,
    WorkspaceSearchTool,
)
from agent.tools.base import AgentToolContext, StrictToolArgs, validate_tool_args
from agent.tools.registry import ToolRegistry
from agent.tools import file_read, workspace_common, workspace_list, workspace_search


class WorkspaceToolsTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.workspace = Path(self.temp_dir.name) / "workspace"
        self.workspace.mkdir()
        (self.workspace / "Alpha.txt").write_text("First line\nNeedle here\nLast line\n", encoding="utf-8")
        (self.workspace / "docs").mkdir()
        (self.workspace / "docs" / "Guide.MD").write_text(
            "# Guide\nA NEEDLE in documentation\n" + ("z" * 300) + " needle tail\n",
            encoding="utf-8",
        )
        (self.workspace / "docs" / "nested").mkdir()
        (self.workspace / "docs" / "nested" / "deep.py").write_text(
            "print('needle')\n", encoding="utf-8"
        )
        for ignored in (".git", "node_modules", "dist", "out", ".looma"):
            directory = self.workspace / ignored
            directory.mkdir()
            (directory / "secret.txt").write_text("needle hidden", encoding="utf-8")
        (self.workspace / "binary.bin").write_bytes(b"needle before marker\n\x00binary")
        (self.workspace / "invalid.txt").write_bytes(b"needle before invalid\n\xff")
        (self.workspace / "huge.txt").write_bytes(b"needle" + b"x" * (2 * 1024 * 1024))
        (self.workspace / "empty.txt").write_text("", encoding="utf-8")
        self.context = AgentToolContext(workspace_path=self.workspace)

    def tearDown(self):
        self.temp_dir.cleanup()

    @staticmethod
    def serialized(value):
        return json.dumps(value, ensure_ascii=False).replace("\\\\", "\\")

    def assertNoWorkspacePrefix(self, value):
        self.assertNotIn(str(self.workspace), self.serialized(value))

    def test_argument_models_are_strict_and_validate_boundaries(self):
        for model in (WorkspaceListArgs, WorkspaceSearchArgs, FileReadArgs):
            self.assertTrue(issubclass(model, StrictToolArgs))
        self.assertEqual(validate_tool_args(WorkspaceListArgs, {}).path, ".")
        self.assertEqual(validate_tool_args(WorkspaceListArgs, {"depth": 0, "limit": 1000}).depth, 0)
        self.assertEqual(validate_tool_args(WorkspaceSearchArgs, {"query": "  Needle  "}).query, "Needle")
        for model, arguments in (
            (WorkspaceListArgs, {"depth": 6}),
            (WorkspaceListArgs, {"limit": 0}),
            (WorkspaceSearchArgs, {"query": "   "}),
            (WorkspaceSearchArgs, {"query": "x", "glob": "../*.py"}),
            (WorkspaceSearchArgs, {"query": "x", "glob": str(self.workspace / "*")}),
            (WorkspaceSearchArgs, {"query": "x", "max_results": 201}),
            (FileReadArgs, {"path": "Alpha.txt", "start_line": 0}),
            (FileReadArgs, {"path": "Alpha.txt", "start_line": 3, "end_line": 2}),
            (FileReadArgs, {"path": "Alpha.txt", "max_chars": 50001}),
            (FileReadArgs, {"path": "Alpha.txt", "unexpected": True}),
        ):
            with self.subTest(model=model.__name__, arguments=arguments), self.assertRaises(ValidationError):
                validate_tool_args(model, arguments)

    async def test_all_tools_register_and_execute_through_registry(self):
        registry = ToolRegistry()
        cases = (
            (WorkspaceListTool(), {}, "workspace_list"),
            (WorkspaceSearchTool(), {"query": "needle", "max_results": 2}, "workspace_search"),
            (FileReadTool(), {"path": "Alpha.txt"}, "file_read"),
        )
        for tool, arguments, name in cases:
            with self.subTest(name=name):
                registry.register(tool)
                result = await registry.execute(name, self.context, arguments, enabled_tools={name})
                self.assertEqual(tool.risk_level, "read")
                self.assertTrue(result.success, result.error)
                self.assertEqual(result.data["status"], "ok")
                self.assertNoWorkspacePrefix(result.data)

    async def test_list_root_depth_sorting_and_ignored_directories(self):
        result = await WorkspaceListTool().execute(self.context, WorkspaceListArgs(depth=1))
        self.assertEqual(result["status"], "ok")
        self.assertEqual(result["path"], ".")
        self.assertEqual(result["count"], len(result["entries"]))
        paths = [entry["path"] for entry in result["entries"]]
        self.assertEqual(paths, sorted(paths, key=lambda item: (item.casefold(), item)))
        self.assertIn("docs", paths)
        self.assertIn("Alpha.txt", paths)
        self.assertNotIn("docs/Guide.MD", paths)
        for ignored in (".git", "node_modules", "dist", "out", ".looma"):
            self.assertNotIn(ignored, paths)
        alpha = next(entry for entry in result["entries"] if entry["path"] == "Alpha.txt")
        self.assertEqual(alpha["type"], "file")
        self.assertIsInstance(alpha["size"], int)
        self.assertFalse(result["truncated"])
        self.assertNoWorkspacePrefix(result)

    async def test_list_depth_zero_and_nested_depth(self):
        zero = await WorkspaceListTool().execute(self.context, WorkspaceListArgs(path="docs", depth=0))
        nested = await WorkspaceListTool().execute(self.context, WorkspaceListArgs(path="docs", depth=2))
        self.assertEqual(zero["path"], "docs")
        self.assertEqual(zero["entries"], [])
        self.assertEqual(zero["count"], 0)
        self.assertEqual(
            [entry["path"] for entry in nested["entries"]],
            ["docs/Guide.MD", "docs/nested", "docs/nested/deep.py"],
        )

    async def test_list_limit_stops_and_marks_truncated(self):
        result = await WorkspaceListTool().execute(self.context, WorkspaceListArgs(depth=5, limit=2))
        self.assertEqual(result["count"], 2)
        self.assertEqual(len(result["entries"]), 2)
        self.assertTrue(result["truncated"])

    async def test_list_exact_limit_is_not_truncated_but_one_more_entry_is(self):
        exact = self.workspace / "exact-list"
        exact.mkdir()
        (exact / "a.txt").write_text("a", encoding="utf-8")
        (exact / "b.txt").write_text("b", encoding="utf-8")
        ignored = exact / ".git"
        ignored.mkdir()
        (ignored / "ignored.txt").write_text("ignored", encoding="utf-8")

        result = await WorkspaceListTool().execute(
            self.context, WorkspaceListArgs(path="exact-list", depth=1, limit=2)
        )
        self.assertEqual(result["count"], 2)
        self.assertFalse(result["truncated"])

        (exact / "c.txt").write_text("c", encoding="utf-8")
        result = await WorkspaceListTool().execute(
            self.context, WorkspaceListArgs(path="exact-list", depth=1, limit=2)
        )
        self.assertEqual(result["count"], 2)
        self.assertTrue(result["truncated"])

    async def test_list_global_scan_budget_bounds_large_directory(self):
        crowded = self.workspace / "crowded-list"
        crowded.mkdir()
        for index in range(10):
            (crowded / f"file-{index}.txt").write_text("x", encoding="utf-8")

        with patch.object(workspace_list, "MAX_SCAN_ENTRIES", 3):
            result = await WorkspaceListTool().execute(
                self.context, WorkspaceListArgs(path="crowded-list", depth=1, limit=100)
            )

        self.assertLessEqual(result["count"], 3)
        self.assertTrue(result["truncated"])

    async def test_list_missing_and_file_targets_are_observations(self):
        missing = await WorkspaceListTool().execute(self.context, WorkspaceListArgs(path="missing"))
        file_target = await WorkspaceListTool().execute(self.context, WorkspaceListArgs(path="Alpha.txt"))
        self.assertEqual(missing, {"status": "not_found", "path": "missing", "entries": [], "count": 0, "truncated": False})
        self.assertEqual(file_target["status"], "not_directory")
        self.assertEqual(file_target["path"], "Alpha.txt")
        self.assertNoWorkspacePrefix((missing, file_target))

    async def test_search_filename_content_casefold_glob_and_snippets(self):
        result = await WorkspaceSearchTool().execute(
            self.context, WorkspaceSearchArgs(query="nEeDlE", glob="docs/*.MD")
        )
        self.assertEqual(result["status"], "ok")
        self.assertEqual(result["query"], "nEeDlE")
        self.assertTrue(result["matches"])
        self.assertTrue(all(match["path"] == "docs/Guide.MD" for match in result["matches"]))
        content = [match for match in result["matches"] if match["matchType"] == "content"]
        self.assertEqual([match["line"] for match in content], [2, 3])
        self.assertTrue(all(len(match["snippet"]) <= 240 for match in result["matches"]))
        self.assertTrue(all("\n" not in match["snippet"] for match in result["matches"]))
        self.assertNoWorkspacePrefix(result)

    async def test_search_reports_filename_and_content_matches(self):
        (self.workspace / "Needle-name.txt").write_text("needle body\n", encoding="utf-8")
        result = await WorkspaceSearchTool().execute(self.context, WorkspaceSearchArgs(query="needle"))
        matches = [match for match in result["matches"] if match["path"] == "Needle-name.txt"]
        self.assertEqual([match["matchType"] for match in matches], ["filename", "content"])
        self.assertEqual(matches[0]["line"], 0)
        self.assertEqual(matches[1]["line"], 1)

    async def test_search_max_results_and_skips_unsafe_files(self):
        result = await WorkspaceSearchTool().execute(
            self.context, WorkspaceSearchArgs(query="needle", max_results=3)
        )
        self.assertEqual(result["count"], 3)
        self.assertEqual(len(result["matches"]), 3)
        self.assertTrue(result["truncated"])
        searched_paths = {match["path"] for match in result["matches"]}
        self.assertNotIn("binary.bin", searched_paths)
        self.assertNotIn("invalid.txt", searched_paths)
        self.assertNotIn("huge.txt", searched_paths)
        self.assertFalse(any("secret.txt" in path for path in searched_paths))

    async def test_search_exact_max_is_not_truncated_but_one_more_match_is(self):
        token = "exact-search-token"
        (self.workspace / "search-exact.txt").write_text(
            f"{token} first\n{token} second\n", encoding="utf-8"
        )
        result = await WorkspaceSearchTool().execute(
            self.context,
            WorkspaceSearchArgs(query=token, glob="search-exact.txt", max_results=2),
        )
        self.assertEqual(result["count"], 2)
        self.assertFalse(result["truncated"])

        (self.workspace / "search-exact.txt").write_text(
            f"{token} first\n{token} second\n{token} third\n", encoding="utf-8"
        )
        result = await WorkspaceSearchTool().execute(
            self.context,
            WorkspaceSearchArgs(query=token, glob="search-exact.txt", max_results=2),
        )
        self.assertEqual(result["count"], 2)
        self.assertTrue(result["truncated"])

    async def test_search_filename_match_counts_toward_exact_max(self):
        (self.workspace / "filename-token.txt").write_text("filename-token body\n", encoding="utf-8")
        result = await WorkspaceSearchTool().execute(
            self.context,
            WorkspaceSearchArgs(query="filename-token", glob="filename-token.txt", max_results=2),
        )
        self.assertEqual(
            [match["matchType"] for match in result["matches"]],
            ["filename", "content"],
        )
        self.assertFalse(result["truncated"])

    async def test_search_full_results_skip_binary_invalid_huge_and_ignored(self):
        result = await WorkspaceSearchTool().execute(
            self.context, WorkspaceSearchArgs(query="needle", max_results=200)
        )
        paths = {match["path"] for match in result["matches"]}
        self.assertNotIn("binary.bin", paths)
        self.assertNotIn("invalid.txt", paths)
        self.assertNotIn("huge.txt", paths)
        self.assertFalse(any(path.endswith("secret.txt") for path in paths))
        self.assertFalse(result["truncated"])

    async def test_search_reads_at_most_limit_plus_one_and_skips_over_limit(self):
        exact = self.workspace / "search-limit-exact.txt"
        over = self.workspace / "search-limit-over.txt"
        exact.write_bytes(b"needle!")
        over.write_bytes(b"needle!!")
        real_fdopen = os.fdopen
        read_sizes: list[int] = []

        class RecordingReader:
            def __init__(self, handle):
                self.handle = handle

            def __enter__(self):
                self.handle.__enter__()
                return self

            def __exit__(self, *args):
                return self.handle.__exit__(*args)

            def read(self, size=-1):
                read_sizes.append(size)
                return self.handle.read(size)

        def recording_fdopen(fd, *args, **kwargs):
            return RecordingReader(real_fdopen(fd, *args, **kwargs))

        with (
            patch.object(workspace_search, "MAX_SEARCH_FILE_BYTES", 7),
            patch.object(workspace_search.os, "fdopen", side_effect=recording_fdopen),
            patch.object(Path, "read_bytes", side_effect=AssertionError("Path.read_bytes must not be used")),
        ):
            result = await WorkspaceSearchTool().execute(
                self.context,
                WorkspaceSearchArgs(query="needle", glob="search-limit-*.txt", max_results=20),
            )

        self.assertEqual({match["path"] for match in result["matches"]}, {exact.name})
        self.assertTrue(read_sizes)
        self.assertTrue(all(0 <= size <= 8 for size in read_sizes), read_sizes)

    async def test_search_global_scan_budget_stops_even_without_matches(self):
        crowded = self.workspace / "crowded-search"
        crowded.mkdir()
        for index in range(10):
            (crowded / f"file-{index}.txt").write_text("haystack", encoding="utf-8")

        with patch.object(workspace_search, "MAX_SCAN_ENTRIES", 3):
            result = await WorkspaceSearchTool().execute(
                self.context,
                WorkspaceSearchArgs(query="absent", glob="crowded-search/*.txt", max_results=200),
            )

        self.assertEqual(result["count"], 0)
        self.assertTrue(result["truncated"])

    def test_scan_budget_exactly_consumed_before_subdirectory_marks_exhausted(self):
        root = self.workspace / "exact-scan-budget"
        child = root / "child"
        child.mkdir(parents=True)
        (child / "needle.txt").write_text("needle", encoding="utf-8")

        budget = workspace_common.ScanBudget(1)
        paths = list(workspace_common.iter_workspace_files(root, budget))

        self.assertEqual(paths, [])
        self.assertTrue(budget.exhausted)

    async def test_read_line_range_total_lines_and_empty_file(self):
        result = await FileReadTool().execute(
            self.context, FileReadArgs(path="Alpha.txt", start_line=2, end_line=2)
        )
        self.assertEqual(result["status"], "ok")
        self.assertEqual(result["path"], "Alpha.txt")
        self.assertEqual(result["content"], "Needle here\n")
        self.assertEqual(result["startLine"], 2)
        self.assertEqual(result["endLine"], 2)
        self.assertEqual(result["totalLines"], 3)
        self.assertFalse(result["truncated"])
        empty = await FileReadTool().execute(self.context, FileReadArgs(path="empty.txt"))
        self.assertEqual(empty["content"], "")
        self.assertEqual(empty["totalLines"], 0)
        self.assertEqual(empty["endLine"], 0)
        self.assertNoWorkspacePrefix((result, empty))

    async def test_read_character_truncation_never_exceeds_cap(self):
        result = await FileReadTool().execute(
            self.context, FileReadArgs(path="docs/Guide.MD", max_chars=20)
        )
        self.assertEqual(len(result["content"]), 20)
        self.assertTrue(result["truncated"])
        self.assertEqual(result["totalLines"], 3)
        self.assertGreaterEqual(result["endLine"], 1)

    async def test_read_start_beyond_eof_returns_accurate_empty_result(self):
        result = await FileReadTool().execute(
            self.context, FileReadArgs(path="Alpha.txt", start_line=99)
        )
        self.assertEqual(result["content"], "")
        self.assertEqual(result["startLine"], 99)
        self.assertEqual(result["endLine"], 0)
        self.assertEqual(result["totalLines"], 3)
        self.assertFalse(result["truncated"])

    async def test_read_trailing_lf_counts_lines_like_python_text_lines(self):
        (self.workspace / "trailing-lf.txt").write_bytes(b"a\nb\n")
        result = await FileReadTool().execute(self.context, FileReadArgs(path="trailing-lf.txt"))
        self.assertEqual(result["content"], "a\nb\n")
        self.assertEqual(result["totalLines"], 2)
        self.assertEqual(result["endLine"], 2)

    async def test_read_normalizes_crlf_across_chunks_and_lone_cr(self):
        (self.workspace / "mixed-newlines.txt").write_bytes(b"a\r\nb\rc\n")
        with patch("agent.tools.file_read.READ_CHUNK_BYTES", 2):
            result = await FileReadTool().execute(
                self.context, FileReadArgs(path="mixed-newlines.txt")
            )
        self.assertEqual(result["content"], "a\nb\nc\n")
        self.assertEqual(result["totalLines"], 3)
        self.assertEqual(result["endLine"], 3)
        self.assertFalse(result["truncated"])

        (self.workspace / "final-cr.txt").write_bytes(b"tail\r")
        with patch("agent.tools.file_read.READ_CHUNK_BYTES", 2):
            final_cr = await FileReadTool().execute(
                self.context, FileReadArgs(path="final-cr.txt")
            )
        self.assertEqual(final_cr["content"], "tail\n")
        self.assertEqual(final_cr["totalLines"], 1)
        self.assertEqual(final_cr["endLine"], 1)

    async def test_read_large_single_line_is_bounded_and_counts_one_line(self):
        size = 5 * 1024 * 1024
        (self.workspace / "long-line.txt").write_bytes(b"x" * size)
        result = await FileReadTool().execute(
            self.context, FileReadArgs(path="long-line.txt", max_chars=7)
        )
        self.assertEqual(result["status"], "ok")
        self.assertEqual(result["content"], "x" * 7)
        self.assertEqual(result["totalLines"], 1)
        self.assertEqual(result["endLine"], 1)
        self.assertTrue(result["truncated"])

    async def test_read_does_not_use_path_text_open(self):
        with patch.object(Path, "open", side_effect=AssertionError("Path.open must not be used")):
            result = await FileReadTool().execute(self.context, FileReadArgs(path="Alpha.txt"))
        self.assertEqual(result["status"], "ok")
        self.assertEqual(result["content"], "First line\nNeedle here\nLast line\n")

    async def test_read_uses_verified_regular_file_descriptor(self):
        with (
            patch.object(file_read, "open_regular_no_follow", return_value=None) as safe_open,
            patch.object(file_read.os, "open", side_effect=AssertionError("raw os.open must not be used")),
        ):
            result = await FileReadTool().execute(self.context, FileReadArgs(path="Alpha.txt"))
        safe_open.assert_called_once_with(self.workspace / "Alpha.txt")
        self.assertEqual(result["status"], "inaccessible")

    def test_open_regular_no_follow_closes_identity_mismatch(self):
        regular_mode = stat.S_IFREG | 0o600
        before = SimpleNamespace(st_mode=regular_mode, st_dev=1, st_ino=10, st_file_attributes=0)
        after = SimpleNamespace(st_mode=regular_mode, st_dev=1, st_ino=11)
        close = Mock()
        with (
            patch.object(workspace_common.os, "lstat", return_value=before),
            patch.object(workspace_common.os, "open", return_value=123),
            patch.object(workspace_common.os, "fstat", return_value=after),
            patch.object(workspace_common.os, "close", close),
        ):
            descriptor = workspace_common.open_regular_no_follow(self.workspace / "Alpha.txt")
        self.assertIsNone(descriptor)
        close.assert_called_once_with(123)

    async def test_read_missing_directory_binary_and_invalid_utf8_are_observations(self):
        cases = (
            ("missing.txt", "not_found"),
            ("docs", "not_file"),
            ("binary.bin", "binary_file"),
            ("invalid.txt", "binary_file"),
        )
        for path, status in cases:
            with self.subTest(path=path):
                result = await FileReadTool().execute(self.context, FileReadArgs(path=path))
                self.assertEqual(result["status"], status)
                self.assertEqual(result["path"], path)
                self.assertNoWorkspacePrefix(result)

    async def test_user_path_security_violations_propagate(self):
        tool_cases = (
            (WorkspaceListTool(), WorkspaceListArgs, {}),
            (FileReadTool(), FileReadArgs, {}),
        )
        for unsafe in (str(self.workspace), "../outside", ".looma/secret.txt"):
            for tool, model, extra in tool_cases:
                with self.subTest(tool=tool.name, unsafe=unsafe), self.assertRaises(WorkspaceSecurityError):
                    await tool.execute(self.context, model(path=unsafe, **extra))

    async def test_security_violation_is_wrapped_by_registry(self):
        registry = ToolRegistry()
        registry.register(FileReadTool())
        result = await registry.execute(
            "file_read", self.context, {"path": "../secret"}, enabled_tools={"file_read"}
        )
        self.assertFalse(result.success)
        self.assertEqual(result.error.code, "tool_execution_failed")
        self.assertNotIn(str(self.workspace), result.summary)

    async def test_symlink_escape_is_rejected_or_skipped(self):
        outside = Path(self.temp_dir.name) / "outside"
        outside.mkdir()
        (outside / "secret.txt").write_text("needle", encoding="utf-8")
        file_link = self.workspace / "linked.txt"
        dir_link = self.workspace / "linked-dir"
        try:
            os.symlink(outside / "secret.txt", file_link)
            os.symlink(outside, dir_link, target_is_directory=True)
        except (OSError, NotImplementedError):
            self.skipTest("symbolic links are unavailable on this platform")
        with self.assertRaises(WorkspaceSecurityError):
            await FileReadTool().execute(self.context, FileReadArgs(path="linked.txt"))
        listed = await WorkspaceListTool().execute(self.context, WorkspaceListArgs(depth=5, limit=1000))
        searched = await WorkspaceSearchTool().execute(
            self.context, WorkspaceSearchArgs(query="needle", max_results=200)
        )
        self.assertNotIn("linked-dir", {entry["path"] for entry in listed["entries"]})
        self.assertNotIn("linked.txt", {entry["path"] for entry in listed["entries"]})
        self.assertFalse(any(match["path"].startswith("linked") for match in searched["matches"]))
        self.assertNoWorkspacePrefix((listed, searched))

    async def test_user_paths_reject_internal_file_and_directory_links(self):
        target_file = self.workspace / "Alpha.txt"
        target_dir = self.workspace / "docs"
        file_link = self.workspace / "internal-file-link.txt"
        dir_link = self.workspace / "internal-dir-link"
        try:
            os.symlink(target_file, file_link)
            os.symlink(target_dir, dir_link, target_is_directory=True)
        except (OSError, NotImplementedError):
            self.skipTest("symbolic links are unavailable on this platform")

        for tool, args in (
            (FileReadTool(), FileReadArgs(path="internal-file-link.txt")),
            (WorkspaceListTool(), WorkspaceListArgs(path="internal-dir-link")),
        ):
            with self.subTest(tool=tool.name), self.assertRaises(WorkspaceSecurityError) as raised:
                await tool.execute(self.context, args)
            self.assertEqual(raised.exception.code, "workspace_link_not_allowed")
            self.assertNotIn(str(self.workspace), raised.exception.message)


if __name__ == "__main__":
    unittest.main()
