import unittest

from pydantic import ValidationError

from agent.models import (
    AgentError,
    AgentFinalAnswer,
    AgentToolCall,
    ToolResult,
    parse_agent_decision,
)
from schemas import AgentConfig, AgentRunRequest, WorkspaceContext


class AgentRequestContractTest(unittest.TestCase):
    def test_canonical_agent_run_request_uses_global_ai_and_knowledge_defaults(self):
        request = AgentRunRequest(
            input="总结当前工作区",
            workspace=WorkspaceContext(workspace_path="/workspace"),
        )

        self.assertIsNone(request.ai_config)
        self.assertIsNone(request.knowledge)
        self.assertEqual(
            request.agent.enabled_tools,
            ["rag_search", "workspace_list", "workspace_search", "file_read"],
        )
        self.assertEqual(request.agent.max_steps, 8)
        self.assertEqual(request.agent.tool_timeout_seconds, 30)
        self.assertFalse(request.agent.allow_write)
        self.assertFalse(hasattr(request.agent, "mode"))

    def test_agent_config_rejects_unknown_tool(self):
        with self.assertRaises(ValidationError):
            AgentConfig(enabled_tools=["unknown_tool"])

    def test_agent_config_does_not_enable_write_network_or_terminal_by_default(self):
        enabled = AgentConfig().enabled_tools

        self.assertNotIn("file_write", enabled)
        self.assertNotIn("web_search", enabled)
        self.assertNotIn("terminal", enabled)

    def test_agent_config_rejects_max_steps_outside_bounds(self):
        for value in (0, 51):
            with self.subTest(value=value), self.assertRaises(ValidationError):
                AgentConfig(max_steps=value)

    def test_agent_config_rejects_timeout_outside_bounds(self):
        for value in (0, 301):
            with self.subTest(value=value), self.assertRaises(ValidationError):
                AgentConfig(tool_timeout_seconds=value)

    def test_agent_config_forbids_extra_fields(self):
        with self.assertRaises(ValidationError):
            AgentConfig(mode="rag")


class AgentDecisionContractTest(unittest.TestCase):
    def test_tool_call_decision_parses(self):
        decision = parse_agent_decision({
            "type": "tool_call",
            "thought_summary": "先检索相关文档",
            "tool": "rag_search",
            "arguments": {"query": "发布流程"},
        })

        self.assertIsInstance(decision, AgentToolCall)
        self.assertEqual(decision.tool, "rag_search")
        self.assertEqual(decision.arguments, {"query": "发布流程"})

    def test_final_decision_parses(self):
        decision = parse_agent_decision({"type": "final", "answer": "已完成。"})

        self.assertIsInstance(decision, AgentFinalAnswer)
        self.assertEqual(decision.answer, "已完成。")

    def test_empty_or_invalid_decision_is_rejected(self):
        invalid_decisions = (
            {},
            {"type": "tool_call", "thought_summary": "", "tool": "rag_search", "arguments": {}},
            {"type": "tool_call", "thought_summary": "检索", "tool": "bad_tool", "arguments": {}},
            {"type": "final", "answer": ""},
            {"type": "other", "answer": "no"},
        )

        for decision in invalid_decisions:
            with self.subTest(decision=decision), self.assertRaises(ValidationError):
                parse_agent_decision(decision)

    def test_decision_models_forbid_extra_fields(self):
        with self.assertRaises(ValidationError):
            parse_agent_decision({"type": "final", "answer": "完成", "unexpected": True})


class ToolResultContractTest(unittest.TestCase):
    def test_success_result_carries_summary_data_and_truncation(self):
        result = ToolResult(
            tool="file_read",
            success=True,
            summary="读取了文件前 100 行",
            data={"path": "README.md"},
            truncated=True,
        )

        self.assertTrue(result.success)
        self.assertTrue(result.truncated)
        self.assertIsNone(result.error)

    def test_error_result_carries_stable_and_technical_details(self):
        error = AgentError(
            code="tool_timeout",
            message="工具执行超时",
            technical_detail="deadline exceeded after 30 seconds",
            retryable=True,
        )
        result = ToolResult(
            tool="rag_search",
            success=False,
            summary="检索失败",
            error=error,
        )

        self.assertEqual(result.error.code, "tool_timeout")
        self.assertTrue(result.error.retryable)

    def test_tool_result_success_and_error_must_be_consistent(self):
        with self.assertRaises(ValidationError):
            ToolResult(tool="rag_search", success=False, summary="失败")
        with self.assertRaises(ValidationError):
            ToolResult(
                tool="rag_search",
                success=True,
                summary="成功",
                error=AgentError(code="unexpected", message="不应存在"),
            )

    def test_tool_result_and_error_forbid_extra_fields(self):
        with self.assertRaises(ValidationError):
            ToolResult(tool="rag_search", success=True, summary="成功", extra_value=1)
        with self.assertRaises(ValidationError):
            AgentError(code="failed", message="失败", detail="wrong field name")


if __name__ == "__main__":
    unittest.main()
