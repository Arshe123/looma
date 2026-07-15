import asyncio
import json
import unittest
from pathlib import Path

from agent.approvals import ApprovalManager, ApprovalResolution
from agent.models import AgentFinalAnswer, AgentToolCall
from agent.runtime import AgentRuntime
from agent.tools import AgentToolContext, FilePatchTool, ToolRegistry
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

    async def test_main_resolve_endpoint_and_route(self):
        import main

        manager = ApprovalManager(default_timeout_seconds=30)
        approval = manager.create(
            run_id="run-1",
            step_id="step-1",
            call_id="call-1",
            tool_name="file_patch",
            payload={"path": "a.txt"},
        )
        original = main.approval_manager
        main.approval_manager = manager
        try:
            response = await main.agent_approval_resolve(
                main.AgentApprovalResolveRequest(
                    approval_id=approval.approval_id,
                    status="approved",
                    reason="ok",
                    applied=True,
                )
            )
            self.assertEqual(response["approvalId"], approval.approval_id)
            self.assertEqual(response["status"], "approved")
            self.assertIn("/agent/approvals/resolve", {route.path for route in main.app.routes})
        finally:
            main.approval_manager = original


class AgentApprovalRuntimeTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        import tempfile

        self.manager = ApprovalManager(default_timeout_seconds=30)
        self.registry = ToolRegistry(allowed_tools={"file_patch"})
        self.registry.register(FilePatchTool())
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
            approval_manager=self.manager,
        )

    async def test_approval_required_then_approved_continues_to_final(self):
        provider = FakeProvider([
            AgentToolCall(
                type="tool_call",
                thought_summary="准备修改文件",
                tool="file_patch",
                arguments={"path": "note.md", "new_content": "hello\n"},
            ),
            AgentFinalAnswer(type="final", answer="已生成 patch 提案。"),
        ])
        runtime = self.build_runtime(provider)

        task = asyncio.create_task(collect(
            runtime,
            input="创建文件",
            history=[],
            config=AgentConfig(enabled_tools=["file_patch"], allow_write=True),
        ))
        approval_id = None
        while approval_id is None:
            for pending in list(self.manager.pending_approvals()):
                approval_id = pending.approval_id
                break
            await asyncio.sleep(0)
        await self.manager.resolve(
            approval_id,
            ApprovalResolution(status="approved", reason="ok", applied=True),
        )
        events = await task

        types = [event["type"] for event in events]
        self.assertIn("approval_required", types)
        self.assertIn("approval_resolved", types)
        self.assertIn("tool_result", types)
        self.assertEqual(events[-1]["type"], "done")
        tool_result = next(event["result"] for event in events if event["type"] == "tool_result")
        self.assertTrue(tool_result["success"])
        observation = provider.calls[-1][0][-1].content
        self.assertIn('"status":"approved"', observation)
        self.assertNotIn("proposed_content", observation)

    async def test_approved_but_apply_failed_returns_structured_failure(self):
        provider = FakeProvider([
            AgentToolCall(
                type="tool_call",
                thought_summary="准备修改文件",
                tool="file_patch",
                arguments={"path": "note.md", "new_content": "hello\n"},
            ),
            AgentFinalAnswer(type="final", answer="写入失败。"),
        ])
        runtime = self.build_runtime(provider)
        task = asyncio.create_task(collect(
            runtime,
            input="创建文件",
            history=[],
            config=AgentConfig(enabled_tools=["file_patch"], allow_write=True),
        ))
        while not self.manager.pending_approvals():
            await asyncio.sleep(0)
        approval_id = self.manager.pending_approvals()[0].approval_id
        await self.manager.resolve(
            approval_id,
            ApprovalResolution(
                status="approved",
                reason="file changed since proposal",
                applied=False,
            ),
        )
        events = await task
        result = next(event["result"] for event in events if event["type"] == "tool_result")
        self.assertFalse(result["success"])
        self.assertEqual(result["error"]["code"], "patch_apply_failed")

    async def test_rejected_resolution_returns_unsuccessful_tool_result_and_final(self):
        provider = FakeProvider([
            AgentToolCall(
                type="tool_call",
                thought_summary="准备修改文件",
                tool="file_patch",
                arguments={"path": "note.md", "new_content": "hello\n"},
            ),
            AgentFinalAnswer(type="final", answer="已拒绝修改。"),
        ])
        runtime = self.build_runtime(provider)

        task = asyncio.create_task(collect(
            runtime,
            input="创建文件",
            history=[],
            config=AgentConfig(enabled_tools=["file_patch"], allow_write=True),
        ))
        approval_id = None
        while approval_id is None:
            for pending in list(self.manager.pending_approvals()):
                approval_id = pending.approval_id
                break
            await asyncio.sleep(0)
        await self.manager.resolve(
            approval_id,
            ApprovalResolution(status="rejected", reason="不要改"),
        )
        events = await task

        resolved = next(event for event in events if event["type"] == "approval_resolved")
        self.assertEqual(resolved["resolution"]["status"], "rejected")
        tool_result = next(event["result"] for event in events if event["type"] == "tool_result")
        self.assertFalse(tool_result["success"])
        self.assertEqual(tool_result["error"]["code"], "approval_rejected")
        self.assertEqual(events[-1]["status"], "completed")

    async def test_expired_resolution_returns_unsuccessful_tool_result_and_final(self):
        manager = ApprovalManager(default_timeout_seconds=0.01)
        runtime = AgentRuntime(
            provider=FakeProvider([
                AgentToolCall(
                    type="tool_call",
                    thought_summary="准备修改文件",
                    tool="file_patch",
                    arguments={"path": "note.md", "new_content": "hello\n"},
                ),
                AgentFinalAnswer(type="final", answer="审批超时。"),
            ]),
            registry=self.registry,
            context=self.context,
            approval_manager=manager,
        )

        events = await collect(
            runtime,
            input="创建文件",
            history=[],
            config=AgentConfig(enabled_tools=["file_patch"], allow_write=True),
        )

        resolved = next(event for event in events if event["type"] == "approval_resolved")
        self.assertEqual(resolved["resolution"]["status"], "expired")
        tool_result = next(event["result"] for event in events if event["type"] == "tool_result")
        self.assertEqual(tool_result["error"]["code"], "approval_expired")

    async def test_cancel_while_waiting_for_approval_marks_run_cancelled(self):
        provider = FakeProvider([
            AgentToolCall(
                type="tool_call",
                thought_summary="准备修改文件",
                tool="file_patch",
                arguments={"path": "note.md", "new_content": "hello\n"},
            ),
        ])
        cancel = asyncio.Event()
        runtime = self.build_runtime(provider)

        task = asyncio.create_task(collect(
            runtime,
            input="创建文件",
            history=[],
            config=AgentConfig(enabled_tools=["file_patch"], allow_write=True),
            cancel_event=cancel,
        ))
        while not list(self.manager.pending_approvals()):
            await asyncio.sleep(0)
        cancel.set()
        events = await task

        resolved = next(event for event in events if event["type"] == "approval_resolved")
        self.assertEqual(resolved["resolution"]["status"], "cancelled")
        self.assertEqual(events[-1]["status"], "cancelled")


if __name__ == "__main__":
    unittest.main()
