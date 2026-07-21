import asyncio
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from pydantic import Field

from agent.models import (
    AgentFinalAnswer,
    AgentInvalidToolCall,
    AgentToolBatch,
    AgentToolCall,
)
from agent.runtime import AgentRuntime
from agent.tools.base import AgentTool, AgentToolContext, StrictToolArgs
from agent.tools.registry import ToolRegistry
from schemas import AgentConfig, AgentRunRequest, ChatMessage, WorkspaceContext


class EchoArgs(StrictToolArgs):
    value: str = Field(..., min_length=1)


class FakeTool(AgentTool):
    name = "workspace_search"
    description = "Search fake workspace content."
    risk_level = "read"
    args_model = EchoArgs

    def __init__(self, result=None, delay=0.0):
        self.result = {"value": "ok"} if result is None else result
        self.delay = delay
        self.calls = 0
        self.cancelled = False

    async def execute(self, context, args):
        self.calls += 1
        try:
            if self.delay:
                await asyncio.sleep(self.delay)
            return self.result
        except asyncio.CancelledError:
            self.cancelled = True
            raise


class FakeRagTool(FakeTool):
    name = "rag_search"


class FailingFakeTool(FakeTool):
    async def execute(self, context, args):
        self.calls += 1
        raise RuntimeError("api_key=tool-secret")


class FakeWriteTool(FakeTool):
    name = "file_patch"
    risk_level = "write"


class FakeProvider:
    def __init__(self, decisions, delay=0.0):
        self.decisions = list(decisions)
        self.delay = delay
        self.calls = []
        self.cancelled = False

    async def complete_structured(self, messages, tool_schemas):
        self.calls.append((list(messages), tool_schemas))
        try:
            if self.delay:
                await asyncio.sleep(self.delay)
            decision = self.decisions.pop(0)
            if isinstance(decision, BaseException):
                raise decision
            return decision
        except asyncio.CancelledError:
            self.cancelled = True
            raise


async def collect(runtime, **kwargs):
    return [event async for event in runtime.run(**kwargs)]


def build_runtime(provider, *tools):
    registry = ToolRegistry(allowed_tools=["rag_search", "workspace_search", "file_patch"])
    for tool in tools:
        registry.register(tool)
    return AgentRuntime(
        provider=provider,
        registry=registry,
        context=AgentToolContext(workspace_path="."),
    )


class AgentRuntimeTest(unittest.IsolatedAsyncioTestCase):
    async def test_final_only_emits_ordered_serializable_events(self):
        history = [ChatMessage(role="assistant", content="旧消息")]
        provider = FakeProvider([AgentFinalAnswer(type="final", answer="完成")])
        events = await collect(
            build_runtime(provider),
            input="开始",
            history=history,
            config=AgentConfig(enabled_tools=[]),
            run_id="run-fixed",
        )

        self.assertEqual([e["type"] for e in events], ["run_started", "usage_updated", "delta", "done"])
        self.assertTrue(all(e["runId"] == "run-fixed" for e in events))
        usage = events[1]
        self.assertEqual(usage["phase"], "final")
        self.assertGreaterEqual(usage["latencyMs"], 0)
        self.assertEqual(events[2]["text"], "完成")
        self.assertEqual(events[2]["content"], "完成")
        self.assertEqual(events[3], {"type": "done", "runId": "run-fixed", "status": "completed", "answer": "完成"})
        self.assertTrue(events[0]["startedAt"].endswith("Z"))
        json.dumps(events, ensure_ascii=False)
        self.assertEqual(history, [ChatMessage(role="assistant", content="旧消息")])
        sent = provider.calls[0][0]
        self.assertEqual([m.content for m in sent], ["旧消息", "开始"])

    async def test_tool_then_final_has_schema_ids_bounded_sanitized_observation_and_sources(self):
        secret = "TOP-SECRET-DETAIL"
        sources = [{"path": "docs/a.md", "text": "x", "score": 0.9}]
        tool = FakeRagTool(result={"sources": sources, "blob": "z" * 13_000})
        tool_decision = AgentToolCall(
            type="tool_call",
            thought_summary="检索资料",
            tool="rag_search",
            arguments={"value": "q"},
        )
        provider = FakeProvider([
            tool_decision,
            AgentFinalAnswer(type="final", answer="答案"),
        ])
        events = await collect(
            build_runtime(provider, tool),
            input="问",
            history=[],
            config=AgentConfig(enabled_tools=["rag_search"]),
        )

        types = [e["type"] for e in events]
        self.assertEqual(types, ["run_started", "usage_updated", "timeline", "tool_call", "tool_result", "sources", "timeline", "usage_updated", "delta", "done"])
        running = next(e for e in events if e["type"] == "timeline" and e["status"] == "running")
        call = next(e for e in events if e["type"] == "tool_call")
        result = next(e for e in events if e["type"] == "tool_result")
        completed = next(e for e in events if e["type"] == "timeline" and e["status"] == "completed")
        self.assertEqual((running["step"], call["step"], result["step"]), (1, 1, 1))
        self.assertEqual(running["stepId"], completed["stepId"])
        self.assertEqual(call["callId"], result["callId"])
        schemas = provider.calls[0][1]
        self.assertEqual([s["name"] for s in schemas], ["rag_search"])
        self.assertIn("properties", schemas[0]["parameters"])
        observation = provider.calls[1][0][-1].content
        self.assertLessEqual(len(observation), 12000)
        parsed = json.loads(observation)
        assistant_call = provider.calls[1][0][-2]
        tool_result = provider.calls[1][0][-1]
        self.assertEqual(tool_result.role, "tool")
        self.assertEqual(tool_result.name, "rag_search")
        self.assertEqual(tool_result.tool_call_id, assistant_call.tool_calls[0].id)
        self.assertIsNone(assistant_call.reasoning_content)
        self.assertEqual(assistant_call.tool_calls[0].function.name, "rag_search")
        self.assertEqual(assistant_call.tool_calls[0].function.arguments, {"value": "q"})
        self.assertNotIn("technical_detail", json.dumps(parsed))
        self.assertNotIn(secret, observation)
        self.assertIsInstance(parsed["truncated"], bool)
        self.assertIn("modelContext", parsed)
        self.assertNotIn("data", parsed)
        self.assertNotIn("summary", parsed)
        self.assertEqual(set(parsed), {"tool", "success", "modelContext", "error", "truncated"})
        self.assertIsNone(assistant_call.content)
        self.assertNotIn("thought_summary", json.dumps(parsed, ensure_ascii=False))
        source_event = next(e for e in events if e["type"] == "sources")
        self.assertTrue(source_event["retrievalId"].startswith("ret_"))
        self.assertEqual(source_event["callId"], call["callId"])
        self.assertEqual(source_event["sources"][0]["path"], "docs/a.md")
        self.assertEqual(source_event["sources"][0]["retrievalId"], source_event["retrievalId"])
        self.assertEqual(source_event["sources"][0]["runId"], call["runId"])
        self.assertTrue(source_event["sources"][0]["sourceId"].startswith("src_"))

    async def test_tool_batch_executes_read_tools_concurrently_and_echoes_all_results(self):
        first = FakeTool(delay=0.2)
        second = FakeRagTool(delay=0.2)
        call_a = AgentToolCall(
            type="tool_call", thought_summary="搜索代码",
            tool="workspace_search", arguments={"value": "a"},
        )
        call_b = AgentToolCall(
            type="tool_call", thought_summary="检索知识库",
            tool="rag_search", arguments={"value": "b"},
        )
        call_a._provider_state["tool_call_id"] = "call_a"
        call_b._provider_state["tool_call_id"] = "call_b"
        batch = AgentToolBatch(type="tool_calls", calls=[call_a, call_b])
        batch._provider_state.update({
            "reasoning_content": "PRIVATE_BATCH_REASONING",
            "requires_reasoning_echo": True,
        })
        provider = FakeProvider([
            batch,
            AgentFinalAnswer(type="final", answer="并发完成"),
        ])

        started = asyncio.get_running_loop().time()
        events = await collect(
            build_runtime(provider, first, second),
            input="同时查询",
            history=[],
            config=AgentConfig(
                enabled_tools=["workspace_search", "rag_search"],
                max_steps=4,
            ),
        )
        elapsed = asyncio.get_running_loop().time() - started

        self.assertLess(elapsed, 0.35)
        self.assertEqual((first.calls, second.calls), (1, 1))
        calls = [event for event in events if event["type"] == "tool_call"]
        results = [event for event in events if event["type"] == "tool_result"]
        self.assertEqual([event["callId"] for event in calls], ["call_a", "call_b"])
        self.assertEqual([event["callId"] for event in results], ["call_a", "call_b"])
        self.assertLess(
            max(index for index, item in enumerate(events) if item["type"] == "tool_call"),
            min(index for index, item in enumerate(events) if item["type"] == "tool_result"),
        )
        followup = provider.calls[1][0]
        assistant = followup[-3]
        tool_messages = followup[-2:]
        self.assertEqual(
            [call.id for call in assistant.tool_calls], ["call_a", "call_b"]
        )
        self.assertEqual(
            [message.tool_call_id for message in tool_messages],
            ["call_a", "call_b"],
        )
        self.assertEqual(assistant.reasoning_content, "PRIVATE_BATCH_REASONING")
        self.assertNotIn("PRIVATE_BATCH_REASONING", json.dumps(events, ensure_ascii=False))

    async def test_invalid_call_in_batch_does_not_cancel_valid_sibling(self):
        valid_tool = FakeTool()
        invalid = AgentInvalidToolCall(
            type="invalid_tool_call",
            thought_summary="工具参数无效",
            tool="workspace_search",
            arguments={},
            error_code="invalid_arguments",
        )
        valid = AgentToolCall(
            type="tool_call", thought_summary="正常搜索",
            tool="workspace_search", arguments={"value": "ok"},
        )
        invalid._provider_state["tool_call_id"] = "call_bad"
        valid._provider_state["tool_call_id"] = "call_good"
        provider = FakeProvider([
            AgentToolBatch(type="tool_calls", calls=[invalid, valid]),
            AgentFinalAnswer(type="final", answer="已处理"),
        ])

        events = await collect(
            build_runtime(provider, valid_tool),
            input="执行",
            history=[],
            config=AgentConfig(enabled_tools=["workspace_search"]),
        )

        self.assertEqual(valid_tool.calls, 1)
        results = [event for event in events if event["type"] == "tool_result"]
        self.assertEqual([event["callId"] for event in results], ["call_bad", "call_good"])
        self.assertEqual(results[0]["result"]["error"]["code"], "invalid_arguments")
        self.assertTrue(results[1]["result"]["success"])
        followup = provider.calls[1][0]
        self.assertEqual(len(followup[-3].tool_calls), 2)
        self.assertEqual([message.role for message in followup[-2:]], ["tool", "tool"])

    async def test_deepseek_provider_state_is_echoed_only_in_model_history(self):
        tool = FakeTool()
        tool_decision = AgentToolCall(
            type="tool_call",
            thought_summary="读取资料",
            tool="workspace_search",
            arguments={"value": "q"},
        )
        tool_decision._provider_state.update({
            "tool_call_id": "call_deepseek_native",
            "reasoning_content": "PRIVATE_REASONING",
            "requires_reasoning_echo": True,
        })
        provider = FakeProvider([
            tool_decision,
            AgentFinalAnswer(type="final", answer="完成"),
        ])

        events = await collect(
            build_runtime(provider, tool),
            input="问",
            history=[],
            config=AgentConfig(enabled_tools=["workspace_search"]),
        )

        call_event = next(item for item in events if item["type"] == "tool_call")
        result_event = next(item for item in events if item["type"] == "tool_result")
        self.assertEqual(call_event["callId"], "call_deepseek_native")
        self.assertEqual(result_event["callId"], "call_deepseek_native")
        assistant_call, tool_result = provider.calls[1][0][-2:]
        self.assertEqual(assistant_call.reasoning_content, "PRIVATE_REASONING")
        self.assertEqual(assistant_call.tool_calls[0].id, "call_deepseek_native")
        self.assertEqual(tool_result.role, "tool")
        self.assertEqual(tool_result.tool_call_id, "call_deepseek_native")
        self.assertNotIn("PRIVATE_REASONING", json.dumps(events, ensure_ascii=False))

    async def test_missing_deepseek_reasoning_uses_nonempty_space_pad(self):
        tool = FakeTool()
        tool_decision = AgentToolCall(
            type="tool_call",
            thought_summary="读取资料",
            tool="workspace_search",
            arguments={"value": "q"},
        )
        tool_decision._provider_state["requires_reasoning_echo"] = True
        provider = FakeProvider([
            tool_decision,
            AgentFinalAnswer(type="final", answer="完成"),
        ])

        await collect(
            build_runtime(provider, tool),
            input="问",
            history=[],
            config=AgentConfig(enabled_tools=["workspace_search"]),
        )

        assistant_call = provider.calls[1][0][-2]
        self.assertEqual(assistant_call.reasoning_content, " ")

    async def test_duplicate_provider_call_id_falls_back_to_new_canonical_id(self):
        tool = FakeTool()
        first = AgentToolCall(
            type="tool_call",
            thought_summary="第一次",
            tool="workspace_search",
            arguments={"value": "one"},
        )
        second = AgentToolCall(
            type="tool_call",
            thought_summary="第二次",
            tool="workspace_search",
            arguments={"value": "two"},
        )
        first._provider_state["tool_call_id"] = "call_reused"
        second._provider_state["tool_call_id"] = "call_reused"
        provider = FakeProvider([
            first,
            second,
            AgentFinalAnswer(type="final", answer="完成"),
        ])

        events = await collect(
            build_runtime(provider, tool),
            input="问",
            history=[],
            config=AgentConfig(enabled_tools=["workspace_search"]),
        )

        call_ids = [item["callId"] for item in events if item["type"] == "tool_call"]
        self.assertEqual(call_ids[0], "call_reused")
        self.assertNotEqual(call_ids[1], "call_reused")
        self.assertNotEqual(call_ids[0], call_ids[1])

    async def test_empty_decision_after_repair_is_friendly_retryable_error(self):
        from agent.decision_parser import AgentEmptyDecisionError

        provider = FakeProvider([AgentEmptyDecisionError()])
        events = await collect(
            build_runtime(provider),
            input="问",
            history=[],
            config=AgentConfig(enabled_tools=[]),
        )

        self.assertEqual([event["type"] for event in events], ["run_started", "error"])
        error = events[-1]["error"]
        self.assertEqual(error["code"], "decision_empty")
        self.assertEqual(error["message"], "模型本次未生成有效回答，请重试或切换模型。")
        self.assertEqual(error["technical_detail"], "AgentEmptyDecisionError")
        self.assertTrue(error["retryable"])

    async def test_tool_timeout_cancels_tool_and_model_can_recover(self):
        tool = FakeTool(delay=1)
        provider = FakeProvider([
            AgentToolCall(type="tool_call", thought_summary="慢调用", tool="workspace_search", arguments={"value": "q"}),
            AgentFinalAnswer(type="final", answer="已根据超时恢复"),
        ])
        events = await collect(
            build_runtime(provider, tool),
            input="问",
            history=[],
            config=AgentConfig(enabled_tools=["workspace_search"], tool_timeout_seconds=1),
        )
        result = next(e["result"] for e in events if e["type"] == "tool_result")
        self.assertEqual(result["error"]["code"], "tool_timeout")
        self.assertTrue(result["error"]["retryable"])
        self.assertTrue(tool.cancelled)
        self.assertEqual(events[-1]["status"], "completed")

    async def test_total_timeout_is_terminal_sanitized_error(self):
        provider = FakeProvider([], delay=1)
        events = await collect(
            build_runtime(provider),
            input="问",
            history=[],
            config=AgentConfig(enabled_tools=[], run_timeout_seconds=1),
        )
        self.assertEqual([e["type"] for e in events], ["run_started", "error"])
        self.assertEqual(events[-1]["error"]["code"], "agent_timeout")
        self.assertTrue(events[-1]["error"]["retryable"])
        self.assertTrue(provider.cancelled)

    async def test_explicit_cancel_interrupts_provider_and_emits_cancelled_done(self):
        provider = FakeProvider([], delay=10)
        cancel = asyncio.Event()
        task = asyncio.create_task(collect(
            build_runtime(provider), input="问", history=[],
            config=AgentConfig(enabled_tools=[]), cancel_event=cancel,
        ))
        await asyncio.sleep(0)
        cancel.set()
        events = await task
        self.assertEqual(events[-2]["type"], "timeline")
        self.assertEqual(events[-2]["status"], "cancelled")
        self.assertEqual(events[-1]["type"], "done")
        self.assertEqual(events[-1]["status"], "cancelled")
        self.assertTrue(provider.cancelled)

    async def test_explicit_cancel_interrupts_tool(self):
        tool = FakeTool(delay=10)
        provider = FakeProvider([AgentToolCall(type="tool_call", thought_summary="调用", tool="workspace_search", arguments={"value": "q"})])
        cancel = asyncio.Event()
        task = asyncio.create_task(collect(
            build_runtime(provider, tool), input="问", history=[],
            config=AgentConfig(enabled_tools=["workspace_search"]), cancel_event=cancel,
        ))
        while tool.calls == 0:
            await asyncio.sleep(0)
        cancel.set()
        events = await task
        self.assertEqual(events[-1]["status"], "cancelled")
        self.assertTrue(tool.cancelled)
        self.assertEqual(next(e for e in reversed(events) if e["type"] == "timeline")["status"], "cancelled")

    async def test_external_task_cancel_propagates_and_cancels_child(self):
        provider = FakeProvider([], delay=10)
        task = asyncio.create_task(collect(
            build_runtime(provider), input="问", history=[], config=AgentConfig(enabled_tools=[]),
        ))
        await asyncio.sleep(0)
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task
        self.assertTrue(provider.cancelled)

    async def test_duplicate_successful_tool_call_is_reported_and_agent_continues(self):
        tool = FakeTool()
        repeated = AgentToolCall(type="tool_call", thought_summary="重复", tool="workspace_search", arguments={"value": "same"})
        provider = FakeProvider([
            repeated,
            repeated,
            AgentFinalAnswer(type="final", answer="使用已有结果完成"),
        ])
        events = await collect(
            build_runtime(provider, tool), input="问", history=[],
            config=AgentConfig(enabled_tools=["workspace_search"]),
        )
        self.assertEqual(tool.calls, 1)
        duplicate_result = [e["result"] for e in events if e["type"] == "tool_result"][-1]
        self.assertEqual(duplicate_result["error"]["code"], "repeated_tool_call")
        self.assertFalse(duplicate_result["error"]["retryable"])
        self.assertEqual(events[-1]["type"], "done")
        self.assertEqual(events[-1]["status"], "completed")
        self.assertEqual(events[-1]["answer"], "使用已有结果完成")
        self.assertIn("已经成功执行", provider.calls[2][0][-1].content)

    async def test_failed_tool_call_with_same_arguments_can_retry(self):
        class FlakyTool(FakeTool):
            async def execute(self, context, args):
                self.calls += 1
                if self.calls == 1:
                    raise asyncio.TimeoutError()
                return self.result

        tool = FlakyTool()
        repeated = AgentToolCall(type="tool_call", thought_summary="重试", tool="workspace_search", arguments={"value": "same"})
        provider = FakeProvider([
            repeated,
            repeated,
            AgentFinalAnswer(type="final", answer="重试成功"),
        ])

        events = await collect(
            build_runtime(provider, tool), input="问", history=[],
            config=AgentConfig(enabled_tools=["workspace_search"]),
        )

        self.assertEqual(tool.calls, 2)
        results = [e["result"] for e in events if e["type"] == "tool_result"]
        self.assertEqual(results[0]["error"]["code"], "tool_timeout")
        self.assertTrue(results[0]["error"]["retryable"])
        self.assertTrue(results[1]["success"])
        self.assertEqual(events[-1]["answer"], "重试成功")

    async def test_non_retryable_failure_is_not_executed_twice(self):
        tool = FailingFakeTool()
        repeated = AgentToolCall(type="tool_call", thought_summary="重试", tool="workspace_search", arguments={"value": "same"})
        provider = FakeProvider([
            repeated,
            repeated,
            AgentFinalAnswer(type="final", answer="改用其他方案"),
        ])

        events = await collect(
            build_runtime(provider, tool), input="问", history=[],
            config=AgentConfig(enabled_tools=["workspace_search"]),
        )

        self.assertEqual(tool.calls, 1)
        results = [e["result"] for e in events if e["type"] == "tool_result"]
        self.assertEqual(results[0]["error"]["code"], "tool_execution_failed")
        self.assertEqual(results[1]["error"]["code"], "repeated_tool_call")
        self.assertIn("不可重试", provider.calls[2][0][-1].content)
        self.assertEqual(events[-1]["answer"], "改用其他方案")

    async def test_successful_write_invalidates_previous_read_signature(self):
        read_tool = FakeTool()
        write_tool = FakeWriteTool()
        read = AgentToolCall(type="tool_call", thought_summary="读取", tool="workspace_search", arguments={"value": "same"})
        write = AgentToolCall(type="tool_call", thought_summary="修改", tool="file_patch", arguments={"value": "change"})
        provider = FakeProvider([
            read,
            write,
            read,
            AgentFinalAnswer(type="final", answer="重新读取完成"),
        ])

        events = await collect(
            build_runtime(provider, read_tool, write_tool), input="问", history=[],
            config=AgentConfig(
                enabled_tools=["workspace_search", "file_patch"],
                allow_write=True,
            ),
        )

        self.assertEqual(read_tool.calls, 2)
        self.assertEqual(write_tool.calls, 1)
        self.assertNotIn(
            "repeated_tool_call",
            [
                result.get("error", {}).get("code")
                for result in (e["result"] for e in events if e["type"] == "tool_result")
                if result.get("error")
            ],
        )
        self.assertEqual(events[-1]["answer"], "重新读取完成")

    async def test_duplicate_successful_write_is_not_executed_twice(self):
        tool = FakeWriteTool()
        repeated = AgentToolCall(type="tool_call", thought_summary="修改", tool="file_patch", arguments={"value": "same"})
        provider = FakeProvider([
            repeated,
            repeated,
            AgentFinalAnswer(type="final", answer="没有重复写入"),
        ])

        events = await collect(
            build_runtime(provider, tool), input="问", history=[],
            config=AgentConfig(enabled_tools=["file_patch"], allow_write=True),
        )

        self.assertEqual(tool.calls, 1)
        duplicate_result = [e["result"] for e in events if e["type"] == "tool_result"][-1]
        self.assertEqual(duplicate_result["error"]["code"], "repeated_tool_call")
        self.assertEqual(events[-1]["answer"], "没有重复写入")

    async def test_max_steps_forces_final_without_tools(self):
        tool = FakeTool()
        provider = FakeProvider([
            AgentToolCall(type="tool_call", thought_summary="调用", tool="workspace_search", arguments={"value": "one"}),
            AgentFinalAnswer(type="final", answer="强制总结"),
        ])
        events = await collect(
            build_runtime(provider, tool), input="问", history=[],
            config=AgentConfig(enabled_tools=["workspace_search"], max_steps=1),
        )
        self.assertEqual(provider.calls[1][1], [])
        self.assertIn("不得再调用工具", provider.calls[1][0][-1].content)
        self.assertEqual(events[-1]["status"], "completed")

    async def test_max_steps_forced_final_failure_is_terminal_error(self):
        tool = FakeTool()
        provider = FakeProvider([
            AgentToolCall(type="tool_call", thought_summary="调用", tool="workspace_search", arguments={"value": "one"}),
            RuntimeError("raw secret API_KEY=abc"),
        ])
        events = await collect(
            build_runtime(provider, tool), input="问", history=[],
            config=AgentConfig(enabled_tools=["workspace_search"], max_steps=1),
        )
        self.assertEqual(events[-1]["error"]["code"], "max_steps_exceeded")
        self.assertNotIn("API_KEY", json.dumps(events[-1]))

    async def test_policy_filters_disabled_and_write_tool_schemas(self):
        read = FakeTool()
        write = FakeWriteTool()
        provider = FakeProvider([AgentFinalAnswer(type="final", answer="好")])
        await collect(
            build_runtime(provider, read, write), input="问", history=[],
            config=AgentConfig(enabled_tools=["workspace_search", "file_patch"], allow_write=False),
        )
        self.assertEqual([s["name"] for s in provider.calls[0][1]], ["workspace_search"])

    async def test_provider_error_is_sanitized(self):
        provider = FakeProvider([RuntimeError("api_key=super-secret")])
        events = await collect(
            build_runtime(provider), input="问", history=[], config=AgentConfig(enabled_tools=[]),
        )
        self.assertEqual(events[-1]["error"]["code"], "agent_failed")
        rendered = json.dumps(events[-1])
        self.assertNotIn("super-secret", rendered)
        self.assertIn("RuntimeError", events[-1]["error"]["technical_detail"])

    async def test_tool_exception_detail_is_sanitized_before_client_event(self):
        tool = FailingFakeTool()
        provider = FakeProvider([
            AgentToolCall(
                type="tool_call",
                thought_summary="尝试搜索",
                tool="workspace_search",
                arguments={"value": "q"},
            ),
            AgentFinalAnswer(type="final", answer="工具失败后完成"),
        ])
        events = await collect(
            build_runtime(provider, tool),
            input="问",
            history=[],
            config=AgentConfig(enabled_tools=["workspace_search"]),
        )

        rendered = json.dumps(events, ensure_ascii=False)
        self.assertNotIn("tool-secret", rendered)
        result = next(event["result"] for event in events if event["type"] == "tool_result")
        self.assertEqual(result["error"]["technical_detail"], "RuntimeError")

    def test_source_events_drop_absolute_parent_and_internal_paths_recursively(self):
        sources = AgentRuntime._safe_sources([
            {"path": "docs/safe.md", "metadata": {"source": "nested/safe.md"}},
            {
                "path": "C:\\secret\\token.txt",
                "metadata": {
                    "file_path": ".Looma/private.json",
                    "nested": [{"source": "../outside.md"}, {"path": "ok/file.md"}],
                },
            },
        ])

        self.assertEqual(sources[0]["path"], "docs/safe.md")
        self.assertEqual(sources[0]["metadata"]["source"], "nested/safe.md")
        self.assertNotIn("path", sources[1])
        self.assertNotIn("file_path", sources[1]["metadata"])
        self.assertNotIn("source", sources[1]["metadata"]["nested"][0])
        self.assertEqual(sources[1]["metadata"]["nested"][1]["path"], "ok/file.md")


class AgentMainStreamTest(unittest.IsolatedAsyncioTestCase):
    async def test_agent_run_events_returns_complete_ndjson_lines_with_run_ids(self):
        import main

        request = AgentRunRequest(task_id="task_test", run_id="run_test", input="直接回答", agent=AgentConfig(enabled_tools=[]))

        class RuntimeStub:
            async def run(self, **kwargs):
                yield {"type": "run_started", "runId": "stub", "startedAt": "2026-01-01T00:00:00Z"}
                yield {"type": "done", "runId": "stub", "status": "completed", "answer": "ok"}

        ai = {"chat": {"provider": "ollama", "model": "fake"}}
        with patch.object(main, "resolve_request_config", side_effect=lambda value: value), \
             patch.object(main, "create_chat_provider", return_value=object()), \
             patch.object(main, "AgentRuntime", return_value=RuntimeStub()):
            request.ai_config = main.AIConfig(**ai)
            lines = [line async for line in main.agent_run_events(request)]

        self.assertTrue(all(isinstance(line, str) and line.endswith("\n") for line in lines))
        parsed = [json.loads(line) for line in lines]
        self.assertTrue(all(item["runId"] for item in parsed))
        self.assertNotIn("入口已预留", "".join(lines))

    async def test_missing_workspace_is_structured_error_after_run_started(self):
        import main

        request = AgentRunRequest(task_id="task_test", run_id="run_test", input="搜索", agent=AgentConfig(enabled_tools=["file_read"]))
        with patch.object(main, "resolve_request_config", side_effect=lambda value: value):
            lines = [line async for line in main.agent_run_events(request)]
        events = [json.loads(line) for line in lines]
        self.assertEqual([e["type"] for e in events], ["run_started", "error"])
        self.assertEqual(events[-1]["error"]["code"], "workspace_required")
        self.assertTrue(all(e["runId"] == events[0]["runId"] for e in events))

    async def test_setup_failure_is_sanitized_and_keeps_one_run_id(self):
        import main

        request = AgentRunRequest(task_id="task_test", run_id="run_test", input="直接回答", agent=AgentConfig(enabled_tools=[]))
        with patch.object(
            main,
            "resolve_request_config",
            side_effect=RuntimeError("api_key=must-not-leak"),
        ):
            lines = [line async for line in main.agent_run_events(request)]

        events = [json.loads(line) for line in lines]
        self.assertEqual([event["type"] for event in events], ["run_started", "error"])
        self.assertEqual(events[-1]["error"]["code"], "agent_setup_failed")
        self.assertTrue(all(event["runId"] == events[0]["runId"] for event in events))
        self.assertNotIn("must-not-leak", "".join(lines))

    async def test_runtime_stream_failure_does_not_repeat_run_started(self):
        import main

        request = AgentRunRequest(task_id="task_test", run_id="run_test", input="直接回答", agent=AgentConfig(enabled_tools=[]))

        class RuntimeStub:
            async def run(self, **kwargs):
                yield {"type": "run_started", "runId": kwargs["run_id"], "startedAt": "2026-01-01T00:00:00Z"}
                raise RuntimeError("must-not-leak")

        ai = {"chat": {"provider": "ollama", "model": "fake"}}
        with patch.object(main, "resolve_request_config", side_effect=lambda value: value), \
             patch.object(main, "create_chat_provider", return_value=object()), \
             patch.object(main, "AgentRuntime", return_value=RuntimeStub()):
            request.ai_config = main.AIConfig(**ai)
            lines = [line async for line in main.agent_run_events(request)]

        events = [json.loads(line) for line in lines]
        self.assertEqual([event["type"] for event in events], ["run_started", "error"])
        self.assertTrue(all(event["runId"] == events[0]["runId"] for event in events))
        self.assertNotIn("must-not-leak", "".join(lines))

    async def test_main_product_policy_exposes_file_patch_when_request_allows_write(self):
        import main

        captured = {}

        class RuntimeStub:
            async def run(self, **kwargs):
                yield {"type": "run_started", "runId": kwargs["run_id"], "startedAt": "2026-01-01T00:00:00Z"}
                yield {"type": "done", "runId": kwargs["run_id"], "status": "completed", "answer": "ok"}

        def runtime_factory(**kwargs):
            captured["tools"] = [
                schema["name"]
                for schema in kwargs["registry"].tool_schemas(
                    enabled_tools=["rag_search", "workspace_list", "workspace_search", "file_read", "file_patch"],
                    allow_write=True,
                )
            ]
            return RuntimeStub()

        request = AgentRunRequest(
            task_id="task_test",
            run_id="run_test",
            input="列出工具",
            workspace=WorkspaceContext(workspace_path="."),
            agent=AgentConfig(allow_write=True),
        )
        ai = {"chat": {"provider": "ollama", "model": "fake"}}
        with patch.object(main, "resolve_request_config", side_effect=lambda value: value), \
             patch.object(main, "create_chat_provider", return_value=object()), \
             patch.object(main, "AgentRuntime", side_effect=runtime_factory):
            request.ai_config = main.AIConfig(**ai)
            _ = [line async for line in main.agent_run_events(request)]

        self.assertEqual(captured["tools"], [
            "rag_search", "workspace_list", "workspace_search", "file_read", "file_patch"
        ])

    async def test_agent_routes_are_registered_without_legacy_conversation_routes(self):
        import main

        paths = {route.path for route in main.app.routes}
        self.assertIn("/agent/run/stream", paths)
        self.assertIn("/agent/summarize", paths)
        self.assertNotIn("/chat", paths)
        self.assertNotIn("/chat/stream", paths)
        self.assertNotIn("/rag/query", paths)
        self.assertNotIn("/rag/query/stream", paths)


if __name__ == "__main__":
    unittest.main()
