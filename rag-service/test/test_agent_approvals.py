import asyncio
import json
import unittest
from pathlib import Path

from agent.approvals import ApprovalManager, ApprovalResolution
from agent.models import AgentFinalAnswer, AgentToolCall
from agent.runtime import AgentRuntime
from agent.tools import AgentToolContext, FilePatchTool, FileReadTool, ToolRegistry
from schemas import AgentConfig


class FakeProvider:
    def __init__(self, decisions):
        self.decisions = list(decisions)
        self.calls = []

    async def complete_structured(self, messages, tool_schemas):
        self.calls.append((list(messages), list(tool_schemas)))
        return self.decisions.pop(0)


async def collect(runtime, **kwargs):
    return [event async for event in runtime.run(**kwargs)]


class ApprovalManagerTest(unittest.IsolatedAsyncioTestCase):
    async def test_reject_unknown_approval(self):
        manager = ApprovalManager()

        with self.assertRaises(KeyError):
            await manager.resolve("missing", ApprovalResolution(status="approved"))

    async def test_wait_times_out(self):
        manager = ApprovalManager(default_timeout_seconds=0.01)
        approval = manager.create(
            run_id="run-1",
            step_id="step-1",
            call_id="call-1",
            tool_name="file_patch",
            payload={"path": "a.txt"},
        )

        resolution = await manager.wait_for_resolution(approval.approval_id)

        self.assertEqual(resolution.status, "expired")
        self.assertFalse(manager.has_pending(approval.approval_id))

    async def test_cancel_run_resolves_pending_approval(self):
        manager = ApprovalManager(default_timeout_seconds=30)
        approval = manager.create(
            run_id="run-1",
            step_id="step-1",
            call_id="call-1",
            tool_name="file_patch",
            payload={"path": "a.txt"},
        )

        waiter = asyncio.create_task(manager.wait_for_resolution(approval.approval_id))
        await asyncio.sleep(0)
        await manager.cancel_run("run-1")
        resolution = await waiter

        self.assertEqual(resolution.status, "cancelled")

class AgentApprovalRuntimeTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        import tempfile

        self.registry = ToolRegistry(allowed_tools={"file_patch", "file_read"})
        self.registry.register(FilePatchTool())
        self.registry.register(FileReadTool())
        self._temp_dir = tempfile.TemporaryDirectory()
        self.workspace = Path(self._temp_dir.name)
        self.context = AgentToolContext(workspace_path=self.workspace)

    async def asyncTearDown(self):
        self._temp_dir.cleanup()

    def build_runtime(self, provider):
        return AgentRuntime(
            provider=provider,
            registry=self.registry,
            context=self.context,
        )

    async def test_file_patch_is_queued_without_blocking_final_answer(self):
        provider = FakeProvider([
            AgentToolCall(
                type="tool_call",
                thought_summary="准备修改文件",
                tool="file_patch",
                arguments={"path": "note.md", "new_content": "hello\n"},
            ),
            AgentFinalAnswer(type="final", answer="已生成 patch 提案并继续完成任务。"),
        ])
        events = await asyncio.wait_for(collect(
            self.build_runtime(provider),
            input="创建文件",
            history=[],
            config=AgentConfig(enabled_tools=["file_patch"], allow_write=True),
        ), timeout=2)

        types = [item["type"] for item in events]
        self.assertIn("approval_required", types)
        self.assertNotIn("approval_resolved", types)
        self.assertIn("tool_result", types)
        self.assertEqual(events[-1]["type"], "done")
        self.assertEqual(len(provider.calls), 2)
        approval = next(item for item in events if item["type"] == "approval_required")
        self.assertTrue(approval["approvalId"].startswith("approval_"))
        self.assertEqual(approval["proposal"]["path"], "note.md")

        result = next(item["result"] for item in events if item["type"] == "tool_result")
        self.assertTrue(result["success"])
        structured = result["modelContext"]["structuredData"]
        self.assertEqual(structured["status"], "pending_approval")
        self.assertFalse(structured["applied"])
        self.assertNotIn("proposed_content", json.dumps(result, ensure_ascii=False))

        observation = provider.calls[-1][0][-1].content
        self.assertIn('"status":"pending_approval"', observation)
        self.assertIn('"diskState":"unchanged_until_approved"', observation)
        self.assertNotIn("proposed_content", observation)

    async def test_multiple_patch_proposals_queue_and_continue_together(self):
        from agent.models import AgentToolBatch

        provider = FakeProvider([
            AgentToolBatch(type="tool_calls", calls=[
                AgentToolCall(type="tool_call", thought_summary="修改 A", tool="file_patch", arguments={"path": "a.md", "new_content": "a\n"}),
                AgentToolCall(type="tool_call", thought_summary="修改 B", tool="file_patch", arguments={"path": "b.md", "new_content": "b\n"}),
            ]),
            AgentFinalAnswer(type="final", answer="两个提案均已进入审查队列。"),
        ])
        events = await asyncio.wait_for(collect(
            self.build_runtime(provider),
            input="创建两个文件",
            history=[],
            config=AgentConfig(enabled_tools=["file_patch"], allow_write=True),
        ), timeout=2)

        approvals = [item for item in events if item["type"] == "approval_required"]
        results = [item for item in events if item["type"] == "tool_result"]
        self.assertEqual(len(approvals), 2)
        self.assertEqual(len(results), 2)
        self.assertEqual(events[-1]["status"], "completed")

    async def test_runtime_binds_tools_to_run_staging_and_following_read_sees_patch(self):
        provider = FakeProvider([
            AgentToolCall(
                type="tool_call",
                thought_summary="创建暂存文件",
                tool="file_patch",
                arguments={"path": "staged.md", "new_content": "staged value\n"},
            ),
            AgentToolCall(
                type="tool_call",
                thought_summary="复查暂存文件",
                tool="file_read",
                arguments={"path": "staged.md"},
            ),
            AgentFinalAnswer(type="final", answer="暂存内容可以继续读取。"),
        ])

        events = await collect(
            self.build_runtime(provider),
            input="创建并复查文件",
            history=[],
            config=AgentConfig(enabled_tools=["file_patch", "file_read"], allow_write=True),
            run_id="run_staging_read",
        )

        self.assertEqual(events[-1]["type"], "done")
        self.assertFalse((self.workspace / "staged.md").exists())
        self.assertEqual(
            (self.workspace / ".looma" / "agent-staging" / "run_staging_read" / "files" / "staged.md").read_text(encoding="utf-8"),
            "staged value\n",
        )
        read_observation = provider.calls[2][0][-1].content
        self.assertIn('"source":"staging"', read_observation)
        self.assertIn("staged value", read_observation)


if __name__ == "__main__":
    unittest.main()
