import unittest

from providers.tool_call_repair import (
    ToolCallFormatError,
    contains_textual_tool_call,
    parse_tool_arguments,
    repair_tool_name,
)


class ToolCallRepairTest(unittest.TestCase):
    def test_parses_object_and_empty_values(self):
        self.assertEqual(parse_tool_arguments({"path": "."}), {"path": "."})
        for value in (None, "", "   ", "None"):
            with self.subTest(value=value):
                self.assertEqual(parse_tool_arguments(value), {})

    def test_repairs_trailing_comma_missing_closer_and_control_character(self):
        self.assertEqual(parse_tool_arguments('{"path":".",}'), {"path": "."})
        self.assertEqual(parse_tool_arguments('{"path":"."'), {"path": "."})
        self.assertEqual(
            parse_tool_arguments('{"query":"first\nsecond"}'),
            {"query": "first\nsecond"},
        )

    def test_repairs_extra_final_closer(self):
        self.assertEqual(parse_tool_arguments('{"path":"."}}'), {"path": "."})

    def test_rejects_non_object_oversize_and_unrepairable_json(self):
        for value in (
            [],
            {"value": float("nan")},
            "[]",
            "1",
            '"x"',
            '{"path":[}',
            "x" * 50_001,
        ):
            with self.subTest(value_type=type(value).__name__):
                with self.assertRaises(ToolCallFormatError):
                    parse_tool_arguments(value)

    def test_repairs_names_only_inside_allowlist(self):
        allowed = frozenset({"workspace_list", "file_read"})
        self.assertEqual(repair_tool_name("WORKSPACE_LIST", allowed), "workspace_list")
        self.assertEqual(repair_tool_name("workspace-list", allowed), "workspace_list")
        self.assertEqual(repair_tool_name("WorkspaceListTool", allowed), "workspace_list")
        self.assertIsNone(repair_tool_name("shell_exec", allowed))
        self.assertIsNone(repair_tool_name("", allowed))

    def test_fuzzy_matching_is_fail_closed_for_all_tools(self):
        allowed = frozenset({"file_read", "file_patch", "terminal", "rag_search"})
        self.assertIsNone(repair_tool_name("file_path", allowed))
        self.assertIsNone(repair_tool_name("termnal", allowed))
        self.assertIsNone(repair_tool_name("rag_searh", allowed))
        self.assertEqual(repair_tool_name("file_patch", allowed), "file_patch")
        self.assertEqual(repair_tool_name("FilePatchTool", allowed), "file_patch")

    def test_detects_text_tool_blocks_but_not_normal_json_or_prose(self):
        self.assertTrue(contains_textual_tool_call("<tool_call>{}</tool_call>"))
        self.assertTrue(contains_textual_tool_call("<invoke name='x'></invoke>"))
        self.assertFalse(contains_textual_tool_call('{"type":"final"}'))
        self.assertFalse(contains_textual_tool_call("普通回答"))


if __name__ == "__main__":
    unittest.main()
