import asyncio
import time
import unittest
from typing import Literal
from unittest.mock import patch

from pydantic import BaseModel, Field

from agent.tools.base import AgentTool, AgentToolContext, StrictToolArgs, ToolRiskLevel
from agent.tools.registry import ToolRegistry
from agent.tools.workspace_search import WorkspaceSearchTool


class FakeArgs(StrictToolArgs):
    query: str = Field(..., min_length=1)
    secret: str | None = None


class FakeTool(AgentTool):
    name: Literal["rag_search"] = "rag_search"
    description = "Fake read-only search"
    risk_level: ToolRiskLevel = "read"
    args_model = FakeArgs

    async def execute(self, context: AgentToolContext, args: FakeArgs):
        return {"query": args.query, "workspace": str(context.workspace_path)}


class FailingTool(FakeTool):
    async def execute(self, context: AgentToolContext, args: FakeArgs):
        raise RuntimeError("backend exploded")


class LargeOutputTool(FakeTool):
    async def execute(self, context: AgentToolContext, args: FakeArgs):
        return {"content": "x" * 500}


class CircularOutputTool(FakeTool):
    async def execute(self, context: AgentToolContext, args: FakeArgs):
        output = []
        output.append(output)
        return output


class SharedContainerOutputTool(FakeTool):
    async def execute(self, context: AgentToolContext, args: FakeArgs):
        shared = {"value": 1}
        return {"left": shared, "right": shared}


class CustomOutput:
    pass


class CustomObjectOutputTool(FakeTool):
    async def execute(self, context: AgentToolContext, args: FakeArgs):
        return CustomOutput()


class NonFiniteOutputTool(FakeTool):
    async def execute(self, context: AgentToolContext, args: FakeArgs):
        return {"score": float("nan")}


class NonStrictArgs(BaseModel):
    query: str


class NonStrictArgsTool(FakeTool):
    args_model = NonStrictArgs


class MalformedRiskTool(FakeTool):
    risk_level = "Read"


class WriteTool(AgentTool):
    name: Literal["file_patch"] = "file_patch"
    description = "Fake write tool"
    risk_level: ToolRiskLevel = "write"
    args_model = FakeArgs

    async def execute(self, context: AgentToolContext, args: FakeArgs):
        return {"written": True}


class NetworkTool(AgentTool):
    name: Literal["web_search"] = "web_search"
    description = "Fake network tool"
    risk_level: ToolRiskLevel = "network"
    args_model = FakeArgs

    async def execute(self, context: AgentToolContext, args: FakeArgs):
        return {"fetched": True}


class TerminalTool(AgentTool):
    name: Literal["terminal"] = "terminal"
    description = "Fake terminal tool"
    risk_level: ToolRiskLevel = "terminal"
    args_model = FakeArgs

    async def execute(self, context: AgentToolContext, args: FakeArgs):
        return {"executed": True}


class ToolRegistryTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.context = AgentToolContext(workspace_path=".")

    def test_register_and_list_only_request_and_policy_allowed_tools(self):
        registry = ToolRegistry(allowed_tools={"rag_search"})
        registry.register(FakeTool())
        registry.register(WriteTool())

        listed = registry.list_tools(enabled_tools={"rag_search", "file_patch"})

        self.assertEqual([tool.name for tool in listed], ["rag_search"])

    def test_register_rejects_duplicate_name(self):
        registry = ToolRegistry()
        registry.register(FakeTool())

        with self.assertRaisesRegex(ValueError, "already registered"):
            registry.register(FakeTool())

    def test_register_rejects_non_strict_args_model(self):
        registry = ToolRegistry()

        with self.assertRaisesRegex(ValueError, "StrictToolArgs"):
            registry.register(NonStrictArgsTool())

    def test_register_rejects_malformed_risk_level(self):
        registry = ToolRegistry()

        with self.assertRaisesRegex(ValueError, "risk_level"):
            registry.register(MalformedRiskTool())

    async def test_unknown_tool_returns_structured_failure_and_preserves_name(self):
        result = await ToolRegistry().execute(
            "totally_unknown", self.context, {}, enabled_tools={"totally_unknown"}
        )

        self.assertFalse(result.success)
        self.assertEqual(result.error.code, "tool_not_found")
        self.assertEqual(result.tool, "totally_unknown")

    async def test_empty_tool_name_returns_structured_failure(self):
        result = await ToolRegistry().execute("", self.context, {}, enabled_tools=set())

        self.assertFalse(result.success)
        self.assertEqual(result.error.code, "tool_not_found")
        self.assertTrue(result.tool)

    async def test_request_disabled_tool_returns_structured_failure(self):
        registry = ToolRegistry()
        registry.register(FakeTool())

        result = await registry.execute(
            "rag_search", self.context, {"query": "x"}, enabled_tools=set()
        )

        self.assertFalse(result.success)
        self.assertEqual(result.error.code, "tool_not_enabled")

    async def test_default_policy_denies_high_risk_tools(self):
        cases = (
            (WriteTool(), "file_patch"),
            (NetworkTool(), "web_search"),
            (TerminalTool(), "terminal"),
        )
        for tool, name in cases:
            with self.subTest(risk_level=tool.risk_level):
                registry = ToolRegistry()
                registry.register(tool)

                result = await registry.execute(
                    name,
                    self.context,
                    {"query": "x"},
                    enabled_tools={name},
                )

                self.assertFalse(result.success)
                self.assertEqual(result.error.code, "tool_policy_denied")

    async def test_write_tool_requires_request_level_allow_write(self):
        registry = ToolRegistry(allowed_tools={"file_patch"})
        registry.register(WriteTool())

        result = await registry.execute(
            "file_patch",
            self.context,
            {"query": "x"},
            enabled_tools={"file_patch"},
        )

        self.assertFalse(result.success)
        self.assertEqual(result.error.code, "tool_write_not_allowed")

    async def test_explicit_global_request_and_allow_write_allows_write_tool(self):
        registry = ToolRegistry(allowed_tools={"file_patch"})
        registry.register(WriteTool())

        result = await registry.execute(
            "file_patch",
            self.context,
            {"query": "x"},
            enabled_tools={"file_patch"},
            allow_write=True,
        )

        self.assertTrue(result.success)
        self.assertEqual(result.data, {"written": True})

    def test_list_tools_requires_allow_write_for_write_tool(self):
        registry = ToolRegistry(allowed_tools={"rag_search", "file_patch"})
        registry.register(FakeTool())
        registry.register(WriteTool())

        denied = registry.list_tools(enabled_tools={"rag_search", "file_patch"})
        allowed = registry.list_tools(
            enabled_tools={"rag_search", "file_patch"}, allow_write=True
        )

        self.assertEqual([tool.name for tool in denied], ["rag_search"])
        self.assertEqual(
            [tool.name for tool in allowed], ["rag_search", "file_patch"]
        )

    async def test_invalid_arguments_return_structured_failure(self):
        registry = ToolRegistry()
        registry.register(FakeTool())

        result = await registry.execute(
            "rag_search", self.context, {"query": ""}, enabled_tools={"rag_search"}
        )

        self.assertFalse(result.success)
        self.assertEqual(result.error.code, "tool_invalid_arguments")
        self.assertIsNotNone(result.error.technical_detail)

    async def test_unknown_arguments_return_structured_failure(self):
        registry = ToolRegistry()
        registry.register(FakeTool())

        result = await registry.execute(
            "rag_search",
            self.context,
            {"query": "x", "unexpected": True},
            enabled_tools={"rag_search"},
        )

        self.assertFalse(result.success)
        self.assertEqual(result.error.code, "tool_invalid_arguments")

    async def test_valid_arguments_execute_fake_tool(self):
        registry = ToolRegistry()
        registry.register(FakeTool())

        result = await registry.execute(
            "rag_search", self.context, {"query": "needle"}, enabled_tools={"rag_search"}
        )

        self.assertTrue(result.success)
        self.assertEqual(result.data["query"], "needle")
        self.assertFalse(result.truncated)

    async def test_execution_exception_is_wrapped_without_secret_in_summary(self):
        registry = ToolRegistry()
        registry.register(FailingTool())

        result = await registry.execute(
            "rag_search",
            self.context,
            {"query": "x", "secret": "top-secret-token"},
            enabled_tools={"rag_search"},
        )

        self.assertFalse(result.success)
        self.assertEqual(result.error.code, "tool_execution_failed")
        self.assertEqual(result.error.technical_detail, "RuntimeError")
        self.assertNotIn("backend exploded", result.error.technical_detail)
        self.assertNotIn("top-secret-token", result.summary)

    async def test_large_output_is_truncated(self):
        registry = ToolRegistry(max_output_chars=80)
        registry.register(LargeOutputTool())

        result = await registry.execute(
            "rag_search", self.context, {"query": "x"}, enabled_tools={"rag_search"}
        )

        self.assertTrue(result.success)
        self.assertTrue(result.truncated)
        self.assertIsInstance(result.data, str)
        self.assertLessEqual(len(result.data), 80)
        self.assertIn("truncated", result.summary.lower())

    async def test_unserializable_output_returns_structured_failure(self):
        registry = ToolRegistry()
        registry.register(CircularOutputTool())

        result = await registry.execute(
            "rag_search", self.context, {"query": "x"}, enabled_tools={"rag_search"}
        )

        self.assertFalse(result.success)
        self.assertEqual(result.error.code, "tool_execution_failed")
        self.assertIn("invalid result", result.error.message.lower())
        self.assertIn("ValueError", result.error.technical_detail)

    async def test_shared_container_output_remains_valid_json(self):
        registry = ToolRegistry()
        registry.register(SharedContainerOutputTool())

        result = await registry.execute(
            "rag_search", self.context, {"query": "x"}, enabled_tools={"rag_search"}
        )

        self.assertTrue(result.success)
        self.assertEqual(result.data, {"left": {"value": 1}, "right": {"value": 1}})
        self.assertFalse(result.truncated)

    async def test_custom_object_output_returns_structured_failure(self):
        registry = ToolRegistry()
        registry.register(CustomObjectOutputTool())

        result = await registry.execute(
            "rag_search", self.context, {"query": "x"}, enabled_tools={"rag_search"}
        )

        self.assertFalse(result.success)
        self.assertEqual(result.error.code, "tool_execution_failed")
        self.assertIsNone(result.data)
        self.assertIn("TypeError", result.error.technical_detail)

    async def test_non_finite_output_is_rejected_as_non_standard_json(self):
        registry = ToolRegistry()
        registry.register(NonFiniteOutputTool())

        result = await registry.execute(
            "rag_search", self.context, {"query": "x"}, enabled_tools={"rag_search"}
        )

        self.assertFalse(result.success)
        self.assertEqual(result.error.code, "tool_execution_failed")
        self.assertEqual(result.error.technical_detail, "ValueError")

    async def test_builtin_workspace_io_does_not_block_timeout_or_event_loop(self):
        registry = ToolRegistry()
        tool = WorkspaceSearchTool()
        registry.register(tool)

        def slow_sync(*_args):
            time.sleep(0.2)
            return {"status": "ok", "matches": [], "count": 0, "truncated": False}

        loop = asyncio.get_running_loop()
        started = loop.time()
        with patch.object(tool, "_execute_sync", side_effect=slow_sync):
            result = await registry.execute(
                "workspace_search",
                self.context,
                {"query": "x"},
                enabled_tools={"workspace_search"},
                tool_timeout_seconds=0.02,
            )

        self.assertLess(loop.time() - started, 0.15)
        self.assertEqual(result.error.code, "tool_timeout")


if __name__ == "__main__":
    unittest.main()
