import json
import unittest
from unittest.mock import patch

from pydantic import ValidationError

from agent.decision_parser import (
    AgentDecisionParseError,
    build_agent_decision_messages,
    parse_agent_decision_text,
)
from agent.models import AgentFinalAnswer, AgentToolCall
from providers.base import BaseChatProvider
from providers.ollama_provider import OllamaChatProvider
from providers.openai_compatible_provider import OpenAICompatibleChatProvider
from providers.openai_provider import OpenAIChatProvider
from schemas import ChatMessage


class AgentDecisionTextTests(unittest.TestCase):
    def test_parses_plain_tool_call(self):
        decision = parse_agent_decision_text(
            '{"type":"tool_call","thought_summary":"  查找配置  ",'
            '"tool":"workspace_search","arguments":{"query":"api_key"}}'
        )
        self.assertIsInstance(decision, AgentToolCall)
        self.assertEqual(decision.thought_summary, "查找配置")
        self.assertEqual(decision.arguments, {"query": "api_key"})

    def test_parses_complete_json_fence(self):
        decision = parse_agent_decision_text(
            '  ```json\n{"type":"tool_call","thought_summary":"读取文件",'
            '"tool":"file_read","arguments":{"path":"README.md"}}\n```  '
        )
        self.assertIsInstance(decision, AgentToolCall)

    def test_parses_unlabelled_complete_fence(self):
        decision = parse_agent_decision_text(
            '```\n{"type":"final","answer":"完成"}\n```'
        )
        self.assertEqual(decision.answer, "完成")

    def test_parses_final_answer(self):
        decision = parse_agent_decision_text('{"type":"final","answer":"可以"}')
        self.assertIsInstance(decision, AgentFinalAnswer)

    def test_rejects_malformed_json_without_leaking_input(self):
        secret = "SECRET_API_KEY"
        with self.assertRaises(AgentDecisionParseError) as raised:
            parse_agent_decision_text('{"type":"final","answer":"%s"' % secret)
        self.assertNotIn(secret, str(raised.exception))
        self.assertIsNone(raised.exception.__context__)
        self.assertIsNone(raised.exception.__cause__)
        self.assertEqual(raised.exception.code, "invalid_agent_decision")
        self.assertTrue(raised.exception.retryable)

    def test_rejects_non_string_blank_and_prose_wrapped_json(self):
        for value in (None, 123, "", "  ", 'Here: {"type":"final","answer":"x"}'):
            with self.subTest(value=value):
                with self.assertRaises(AgentDecisionParseError):
                    parse_agent_decision_text(value)  # type: ignore[arg-type]

    def test_rejects_oversize_raw_response_before_json_loads(self):
        oversized = (" " * 50_000) + '{"type":"final","answer":"ok"}'
        with patch("agent.decision_parser.json.loads") as loads:
            with self.assertRaises(AgentDecisionParseError) as raised:
                parse_agent_decision_text(oversized)
        loads.assert_not_called()
        self.assertIsNone(raised.exception.__context__)
        self.assertIsNone(raised.exception.__cause__)

    def test_rejects_excessive_json_nesting_before_json_loads(self):
        deeply_nested = '{"type":"final","answer":' + ("[" * 65) + "0" + ("]" * 65) + "}"
        with patch("agent.decision_parser.json.loads") as loads:
            with self.assertRaises(AgentDecisionParseError):
                parse_agent_decision_text(deeply_nested)
        loads.assert_not_called()

    def test_json_structure_scan_ignores_brackets_and_escapes_inside_strings(self):
        answer = ('[{}]\\"' * 100) + "done"
        decision = parse_agent_decision_text(
            json.dumps({"type": "final", "answer": answer})
        )
        self.assertEqual(decision.answer, answer)

    def test_rejects_excessive_json_nodes_before_json_loads(self):
        wide_array = "[" + ",".join("0" for _ in range(10_001)) + "]"
        response = '{"type":"final","answer":' + wide_array + "}"
        with patch("agent.decision_parser.json.loads") as loads:
            with self.assertRaises(AgentDecisionParseError):
                parse_agent_decision_text(response)
        loads.assert_not_called()

    def test_json_loads_recursion_error_is_sanitized(self):
        secret = "SECRET_RECURSION_DETAIL"
        with patch(
            "agent.decision_parser.json.loads",
            side_effect=RecursionError(secret),
        ):
            with self.assertRaises(AgentDecisionParseError) as raised:
                parse_agent_decision_text('{"type":"final","answer":"ok"}')
        self.assertNotIn(secret, str(raised.exception))
        self.assertIsNone(raised.exception.__context__)
        self.assertIsNone(raised.exception.__cause__)

    def test_rejects_unknown_field(self):
        with self.assertRaises(AgentDecisionParseError):
            parse_agent_decision_text(
                '{"type":"final","answer":"ok","hidden_reasoning":"secret"}'
            )

    def test_rejects_illegal_tool(self):
        with self.assertRaises(AgentDecisionParseError):
            parse_agent_decision_text(
                '{"type":"tool_call","thought_summary":"run",'
                '"tool":"shell_exec","arguments":{}}'
            )

    def test_rejects_canonical_tool_outside_runtime_allowlist(self):
        with self.assertRaises(AgentDecisionParseError):
            parse_agent_decision_text(
                '{"type":"tool_call","thought_summary":"run",'
                '"tool":"terminal","arguments":{}}',
                allowed_tools=frozenset({"file_read"}),
            )

    def test_runtime_allowlist_does_not_restrict_final_answer(self):
        decision = parse_agent_decision_text(
            '{"type":"final","answer":"done"}', allowed_tools=frozenset()
        )
        self.assertEqual(decision.answer, "done")

    def test_strips_thought_summary_before_length_validation(self):
        payload = {
            "type": "tool_call",
            "thought_summary": "  " + ("x" * 500) + "  ",
            "tool": "rag_search",
            "arguments": {},
        }
        decision = parse_agent_decision_text(json.dumps(payload))
        self.assertEqual(decision.thought_summary, "x" * 500)

    def test_rejects_blank_or_oversize_thought_summary(self):
        for summary in ("   ", "x" * 501):
            with self.subTest(length=len(summary)):
                payload = {
                    "type": "tool_call",
                    "thought_summary": summary,
                    "tool": "rag_search",
                    "arguments": {},
                }
                with self.assertRaises(AgentDecisionParseError):
                    parse_agent_decision_text(json.dumps(payload))


class PromptBuilderTests(unittest.TestCase):
    def test_prepends_strict_prompt_with_runtime_tools_without_mutation(self):
        original = [ChatMessage(role="user", content="查找 README")]
        snapshot = list(original)
        tools = [{"name": "file_read", "parameters": {"type": "object"}}]

        prompted = build_agent_decision_messages(original, tools)

        self.assertEqual(original, snapshot)
        self.assertIsNot(prompted, original)
        self.assertEqual(prompted[1:], original)
        system = prompted[0]
        self.assertEqual(system.role, "system")
        self.assertIn('"type":"tool_call"', system.content)
        self.assertIn('"type":"final"', system.content)
        self.assertIn("thought_summary", system.content)
        self.assertIn("500", system.content)
        self.assertIn("仅输出", system.content)
        self.assertIn("禁止 Markdown", system.content)
        self.assertIn(json.dumps(tools, ensure_ascii=False, separators=(",", ":")), system.content)

    def test_rejects_invalid_or_oversize_tool_schemas(self):
        invalid_values = [{"bad": {1, 2}}, {"bad": float("nan")}, "x" * 50_001]
        for value in invalid_values:
            with self.subTest(value_type=type(value).__name__):
                with self.assertRaises(ValueError):
                    build_agent_decision_messages([], value)

    def test_accepts_empty_tool_schema_list(self):
        prompted = build_agent_decision_messages([], [])
        self.assertIn("[]", prompted[0].content)

    def test_rejects_non_list_and_invalid_schema_items_without_leaking_content(self):
        secret = "SECRET_SCHEMA_VALUE"
        invalid_values = [
            None,
            {"name": "file_read"},
            "file_read",
            7,
            ["file_read"],
            [{}],
            [{"name": ""}],
            [{"name": "   "}],
            [{"name": 123}],
            [{"name": secret}],
            [{"name": "file_read"}, {"name": "file_read", "description": secret}],
        ]
        for value in invalid_values:
            with self.subTest(value_type=type(value).__name__, value=repr(value)):
                with self.assertRaises(ValueError) as raised:
                    build_agent_decision_messages([], value)
                self.assertNotIn(secret, str(raised.exception))

    def test_rejects_recursive_tool_schema_as_safe_value_error(self):
        recursive = {"name": "file_read"}
        recursive["parameters"] = recursive
        with self.assertRaises(ValueError) as raised:
            build_agent_decision_messages([], [recursive])
        self.assertNotIn("file_read", str(raised.exception))

    def test_rejects_deep_tool_schema_before_json_dumps(self):
        nested = {}
        cursor = nested
        for _ in range(65):
            child = {}
            cursor["child"] = child
            cursor = child
        schemas = [{"name": "file_read", "parameters": nested}]
        with patch("agent.decision_parser.json.dumps") as dumps:
            with self.assertRaisesRegex(ValueError, "^Invalid tool_schemas$"):
                build_agent_decision_messages([], schemas)
        dumps.assert_not_called()

    def test_rejects_wide_tool_schema_before_json_dumps(self):
        schemas = [
            {
                "name": "file_read",
                "parameters": {str(index): None for index in range(10_001)},
            }
        ]
        with patch("agent.decision_parser.json.dumps") as dumps:
            with self.assertRaisesRegex(ValueError, "^Invalid tool_schemas$"):
                build_agent_decision_messages([], schemas)
        dumps.assert_not_called()

    def test_rejects_huge_description_before_json_dumps(self):
        schemas = [{"name": "file_read", "description": "x" * 50_001}]
        with patch("agent.decision_parser.json.dumps") as dumps:
            with self.assertRaisesRegex(ValueError, "^Invalid tool_schemas$"):
                build_agent_decision_messages([], schemas)
        dumps.assert_not_called()

    def test_rejects_huge_name_before_hashing_or_json_dumps(self):
        schemas = [{"name": "x" * 50_001}]
        with patch("agent.decision_parser.json.dumps") as dumps:
            with self.assertRaisesRegex(ValueError, "^Invalid tool_schemas$"):
                build_agent_decision_messages([], schemas)
        dumps.assert_not_called()

    def test_control_character_escape_estimate_rejects_before_json_dumps(self):
        schemas = [{"name": "file_read", "description": "\x00" * 9_000}]
        with patch("agent.decision_parser.json.dumps") as dumps:
            with self.assertRaisesRegex(ValueError, "^Invalid tool_schemas$"):
                build_agent_decision_messages([], schemas)
        dumps.assert_not_called()

    def test_accepts_normal_nested_tool_schema_after_preflight(self):
        schemas = [
            {
                "name": "file_read",
                "description": "读取文件",
                "parameters": {
                    "type": "object",
                    "properties": {"path": {"type": "string"}},
                    "required": ["path"],
                },
            }
        ]
        prompted = build_agent_decision_messages([], schemas)
        self.assertIn('\"description\":\"读取文件\"', prompted[0].content)


class FakeChatProvider(BaseChatProvider):
    def __init__(self, responses):
        self.responses = iter(responses)
        self.calls = []

    async def chat(self, messages):
        self.calls.append(messages)
        response = next(self.responses)
        if isinstance(response, Exception):
            raise response
        return response

    async def stream_chat(self, messages):
        if False:
            yield ""


class StructuredCompletionTests(unittest.IsolatedAsyncioTestCase):
    async def test_returns_first_valid_response_without_retry(self):
        provider = FakeChatProvider(['{"type":"final","answer":"ok"}'])
        result = await provider.complete_structured(
            [ChatMessage(role="user", content="hello")], []
        )
        self.assertEqual(result.answer, "ok")
        self.assertEqual(len(provider.calls), 1)

    async def test_repairs_once_after_parse_failure(self):
        failed = "not json SECRET_RAW"
        provider = FakeChatProvider(
            [failed, '{"type":"final","answer":"repaired"}']
        )
        result = await provider.complete_structured(
            [ChatMessage(role="user", content="hello")], []
        )
        self.assertEqual(result.answer, "repaired")
        self.assertEqual(len(provider.calls), 2)
        retry_messages = provider.calls[1]
        self.assertEqual(retry_messages[-2].role, "assistant")
        self.assertEqual(retry_messages[-2].content, failed)
        self.assertEqual(retry_messages[-1].role, "user")
        self.assertIn("仅输出", retry_messages[-1].content)
        self.assertEqual(provider.calls[0], retry_messages[:-2])

    async def test_repairs_canonical_tool_not_supplied_this_round(self):
        provider = FakeChatProvider(
            [
                '{"type":"tool_call","thought_summary":"run",'
                '"tool":"terminal","arguments":{}}',
                '{"type":"tool_call","thought_summary":"read",'
                '"tool":"file_read","arguments":{"path":"README.md"}}',
            ]
        )
        result = await provider.complete_structured(
            [], [{"name": "file_read", "parameters": {"type": "object"}}]
        )
        self.assertEqual(result.tool, "file_read")
        self.assertEqual(len(provider.calls), 2)

    async def test_second_runtime_disallowed_tool_is_sanitized(self):
        raw = (
            '{"type":"tool_call","thought_summary":"SECRET_RAW",'
            '"tool":"terminal","arguments":{}}'
        )
        provider = FakeChatProvider([raw, raw])
        with self.assertRaises(AgentDecisionParseError) as raised:
            await provider.complete_structured([], [{"name": "file_read"}])
        self.assertEqual(len(provider.calls), 2)
        self.assertNotIn("SECRET_RAW", str(raised.exception))

    async def test_accepts_tool_supplied_this_round_without_retry(self):
        provider = FakeChatProvider(
            [
                '{"type":"tool_call","thought_summary":"read",'
                '"tool":"file_read","arguments":{}}'
            ]
        )
        result = await provider.complete_structured([], [{"name": "file_read"}])
        self.assertEqual(result.tool, "file_read")
        self.assertEqual(len(provider.calls), 1)

    async def test_truncates_large_failed_response_before_repair(self):
        marker = "SECRET_TAIL_MARKER"
        failed = ("x" * 25_000) + marker
        provider = FakeChatProvider(
            [failed, '{"type":"final","answer":"repaired"}']
        )
        result = await provider.complete_structured([], [])
        self.assertEqual(result.answer, "repaired")
        self.assertEqual(len(provider.calls), 2)
        repair_content = provider.calls[1][-2].content
        self.assertLessEqual(len(repair_content), 20_000)
        self.assertNotIn(marker, repair_content)

    async def test_empty_failed_response_uses_safe_placeholder(self):
        provider = FakeChatProvider(
            ["", '{"type":"final","answer":"repaired"}']
        )
        await provider.complete_structured([], [])
        self.assertTrue(provider.calls[1][-2].content.strip())

    async def test_second_parse_failure_is_sanitized_and_stops(self):
        raw_one = "SECRET_ONE"
        raw_two = "SECRET_TWO"
        provider = FakeChatProvider([raw_one, raw_two])
        with self.assertRaises(AgentDecisionParseError) as raised:
            await provider.complete_structured([], [])
        self.assertEqual(len(provider.calls), 2)
        message = str(raised.exception)
        self.assertNotIn(raw_one, message)
        self.assertNotIn(raw_two, message)

    async def test_provider_exception_is_not_retried_or_wrapped(self):
        provider = FakeChatProvider([RuntimeError("network down")])
        with self.assertRaisesRegex(RuntimeError, "network down"):
            await provider.complete_structured([], [])
        self.assertEqual(len(provider.calls), 1)

    async def test_provider_exception_during_repair_is_not_wrapped(self):
        provider = FakeChatProvider(["bad json", RuntimeError("network down")])
        with self.assertRaisesRegex(RuntimeError, "network down"):
            await provider.complete_structured([], [])
        self.assertEqual(len(provider.calls), 2)

    def test_all_concrete_chat_providers_expose_base_structured_completion(self):
        for provider_class in (
            OllamaChatProvider,
            OpenAIChatProvider,
            OpenAICompatibleChatProvider,
        ):
            with self.subTest(provider=provider_class.__name__):
                self.assertTrue(issubclass(provider_class, BaseChatProvider))
                self.assertIs(
                    provider_class.complete_structured,
                    BaseChatProvider.complete_structured,
                )


if __name__ == "__main__":
    unittest.main()
