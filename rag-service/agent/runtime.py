from __future__ import annotations

import asyncio
import json
import re
import time
import uuid
from collections.abc import AsyncIterator, Awaitable
from dataclasses import dataclass
from typing import Any

from agent.approvals import ApprovalManager, ApprovalResolution
from pydantic import ValidationError

from agent.decision_parser import AgentDecisionParseError, AgentEmptyDecisionError
from agent.events import (
    error_event,
    event,
    tool_result_event,
    usage_event,
    utc_iso_z,
)
from agent.models import (
    AgentError,
    AgentFinalAnswer,
    AgentInvalidToolCall,
    AgentToolBatch,
    AgentToolCall,
    ToolResult,
    parse_agent_decision,
)
from agent.prompts import final_only_prompt, observation_prompt
from agent.tools.base import AgentToolContext
from agent.tools.registry import ToolRegistry
from schemas import AgentConfig, ChatMessage, ChatToolCall, ChatToolFunction


class _RunCancelled(Exception):
    pass


class _AgentTimedOut(Exception):
    pass


_SAFE_PROVIDER_CALL_ID = re.compile(r"^[A-Za-z0-9_-]{1,128}$")


@dataclass
class _AwaitBudget:
    remaining: float

    async def wait(self, operation: Awaitable[Any], cancel_event: asyncio.Event | None) -> Any:
        if self.remaining <= 0:
            if hasattr(operation, "close"):
                operation.close()  # type: ignore[attr-defined]
            raise _AgentTimedOut
        loop = asyncio.get_running_loop()
        started = loop.time()
        operation_task = asyncio.ensure_future(operation)
        cancel_task = (
            asyncio.create_task(cancel_event.wait()) if cancel_event is not None else None
        )
        wait_set = {operation_task}
        if cancel_task is not None:
            wait_set.add(cancel_task)
        try:
            done, _ = await asyncio.wait(
                wait_set, timeout=self.remaining, return_when=asyncio.FIRST_COMPLETED
            )
            self.remaining -= loop.time() - started
            if cancel_task is not None and cancel_task in done and cancel_task.result():
                operation_task.cancel()
                await asyncio.gather(operation_task, return_exceptions=True)
                raise _RunCancelled
            if operation_task in done:
                return operation_task.result()
            operation_task.cancel()
            await asyncio.gather(operation_task, return_exceptions=True)
            raise _AgentTimedOut
        except asyncio.CancelledError:
            operation_task.cancel()
            if cancel_task is not None:
                cancel_task.cancel()
            await asyncio.gather(
                operation_task,
                *([cancel_task] if cancel_task is not None else []),
                return_exceptions=True,
            )
            raise
        finally:
            if cancel_task is not None and not cancel_task.done():
                cancel_task.cancel()
                await asyncio.gather(cancel_task, return_exceptions=True)


@dataclass
class _ToolPlan:
    call: AgentToolCall | AgentInvalidToolCall
    step: int
    step_id: str
    call_id: str
    signature: str | None = None
    revision_at_execution: int | None = None
    result: ToolResult | None = None
    duration_ms: int = 0


class AgentRuntime:
    """Bounded provider/tool decision loop with one terminal stream event."""

    def __init__(
        self,
        *,
        provider: Any,
        registry: ToolRegistry,
        context: AgentToolContext,
        approval_manager: ApprovalManager | None = None,
    ):
        self.provider = provider
        self.registry = registry
        self.context = context
        self.approval_manager = approval_manager

    async def run(
        self,
        *,
        input: str,
        history: list[ChatMessage],
        config: AgentConfig,
        run_id: str | None = None,
        cancel_event: asyncio.Event | None = None,
    ) -> AsyncIterator[dict[str, Any]]:
        run_id = run_id or f"run_{uuid.uuid4().hex}"
        yield event("run_started", run_id, startedAt=utc_iso_z())

        messages = [*history, ChatMessage(role="user", content=input)]
        schemas = self.registry.tool_schemas(
            enabled_tools=config.enabled_tools, allow_write=config.allow_write
        )
        tool_risk_levels = {
            tool.name: tool.risk_level
            for tool in self.registry.list_tools(
                enabled_tools=config.enabled_tools,
                allow_write=config.allow_write,
            )
        }
        steps = 0
        budget = _AwaitBudget(float(config.run_timeout_seconds))
        active_steps: dict[str, tuple[int, str]] = {}
        blocked_call_signatures: dict[str, tuple[int | None, str]] = {}
        seen_call_ids = {
            call.id
            for message in history
            for call in (message.tool_calls or [])
        }
        workspace_revision = 0
        chat_config = getattr(getattr(self.context, "ai_config", None), "chat", None)
        provider_name = str(getattr(chat_config, "provider", "unknown"))
        model_name = str(getattr(chat_config, "model", "unknown"))
        try:
            while True:
                forced_final = steps >= config.max_steps
                decision_messages = messages
                decision_schemas = schemas
                if forced_final:
                    decision_messages = [
                        *messages,
                        ChatMessage(role="system", content=final_only_prompt()),
                    ]
                    decision_schemas = []

                decision_started = time.perf_counter()
                try:
                    raw_decision = await budget.wait(
                        self.provider.complete_structured(
                            decision_messages, decision_schemas
                        ),
                        cancel_event,
                    )
                    decision = (
                        raw_decision
                        if isinstance(
                            raw_decision,
                            (AgentToolCall, AgentToolBatch, AgentFinalAnswer),
                        )
                        else parse_agent_decision(raw_decision)
                    )
                except (_RunCancelled, _AgentTimedOut, asyncio.CancelledError):
                    raise
                except Exception:
                    if forced_final:
                        yield error_event(run_id, AgentError(
                            code="max_steps_exceeded",
                            message="已达到最大工具步数，且无法生成最终答案。",
                            technical_detail="forced final decision failed",
                            retryable=False,
                        ))
                        return
                    raise

                decision_latency_ms = int((time.perf_counter() - decision_started) * 1000)
                yield usage_event(
                    run_id,
                    operation_id=f"usage_{uuid.uuid4().hex}",
                    phase="final" if isinstance(decision, AgentFinalAnswer) else "decision",
                    provider=provider_name,
                    model=model_name,
                    latency_ms=decision_latency_ms,
                )

                if isinstance(decision, AgentFinalAnswer):
                    yield event(
                        "delta", run_id, text=decision.answer, content=decision.answer
                    )
                    yield event(
                        "done", run_id, status="completed", answer=decision.answer
                    )
                    return

                if forced_final:
                    yield error_event(run_id, AgentError(
                        code="max_steps_exceeded",
                        message="已达到最大工具步数，模型仍未提供最终答案。",
                        technical_detail="non-final decision after tool budget exhausted",
                        retryable=False,
                    ))
                    return

                batch_calls = (
                    decision.calls
                    if isinstance(decision, AgentToolBatch)
                    else [decision]
                )
                batch_state = getattr(decision, "_provider_state", {})
                assistant_content = batch_state.get("content")
                if not isinstance(assistant_content, str) or not assistant_content:
                    assistant_content = None
                reasoning_content = batch_state.get("reasoning_content")
                if not isinstance(reasoning_content, str) or not reasoning_content:
                    reasoning_content = (
                        " "
                        if batch_state.get("requires_reasoning_echo") is True
                        else None
                    )

                plans: list[_ToolPlan] = []
                batch_signatures: set[str] = set()
                assistant_calls: list[ChatToolCall] = []
                for call in batch_calls:
                    steps += 1
                    step_id = f"step_{steps}_{uuid.uuid4().hex[:12]}"
                    call_state = getattr(call, "_provider_state", {})
                    provider_call_id = call_state.get("tool_call_id")
                    call_id = (
                        provider_call_id
                        if isinstance(provider_call_id, str)
                        and _SAFE_PROVIDER_CALL_ID.fullmatch(provider_call_id)
                        and provider_call_id not in seen_call_ids
                        else f"call_{uuid.uuid4().hex}"
                    )
                    seen_call_ids.add(call_id)
                    plan = _ToolPlan(
                        call=call, step=steps, step_id=step_id, call_id=call_id
                    )
                    plans.append(plan)
                    active_steps[call_id] = (steps, step_id)
                    assistant_calls.append(ChatToolCall(
                        id=call_id,
                        function=ChatToolFunction(
                            name=call.tool, arguments=call.arguments
                        ),
                    ))
                    yield event(
                        "timeline", run_id, step=steps, stepId=step_id,
                        status="running", summary=call.thought_summary,
                    )
                    yield event(
                        "tool_call", run_id, step=steps, stepId=step_id,
                        callId=call_id, tool=call.tool,
                        arguments=call.arguments,
                        thought_summary=call.thought_summary,
                    )

                    if isinstance(call, AgentInvalidToolCall):
                        messages_by_code = {
                            "invalid_tool_call": "模型生成的工具调用格式无效。",
                            "unknown_tool": "模型请求了不存在或未启用的工具。",
                            "invalid_arguments": "模型生成的工具参数不是有效的 JSON 对象。",
                        }
                        plan.result = ToolResult(
                            tool=call.tool,
                            success=False,
                            summary=messages_by_code[call.error_code],
                            data={"callId": call_id},
                            error=AgentError(
                                code=call.error_code,
                                message=messages_by_code[call.error_code],
                                technical_detail=call.error_code,
                                retryable=True,
                            ),
                        )
                        continue

                    if steps > config.max_steps:
                        plan.result = ToolResult(
                            tool=call.tool,
                            success=False,
                            summary="工具调用超过本次 Agent 的步骤上限，未执行。",
                            data={"callId": call_id},
                            error=AgentError(
                                code="max_steps_exceeded",
                                message="工具调用超过本次运行允许的步骤上限。",
                                technical_detail="batch tool call exceeded step budget",
                                retryable=False,
                            ),
                        )
                        continue

                    try:
                        canonical_arguments = json.dumps(
                            call.arguments,
                            ensure_ascii=False,
                            sort_keys=True,
                            separators=(",", ":"),
                            allow_nan=False,
                        )
                    except (TypeError, ValueError):
                        raise ValueError("tool arguments are not canonical JSON") from None
                    call_signature = f"{call.tool}:{canonical_arguments}"
                    plan.signature = call_signature
                    if call_signature in batch_signatures:
                        plan.result = ToolResult(
                            tool=call.tool,
                            success=False,
                            summary="同一批次中的重复工具调用未再次执行。",
                            data={"callId": call_id},
                            error=AgentError(
                                code="repeated_tool_call",
                                message="同一批次已包含相同工具和参数。",
                                technical_detail="duplicate canonical tool call in one batch",
                                retryable=False,
                            ),
                        )
                        continue
                    batch_signatures.add(call_signature)

                    previous_call = blocked_call_signatures.get(call_signature)
                    repeated_call = (
                        previous_call is not None
                        and (
                            previous_call[0] is None
                            or previous_call[0] == workspace_revision
                        )
                    )
                    if repeated_call:
                        previous_outcome = previous_call[1]
                        if previous_outcome == "success":
                            repeated_message = (
                                "相同工具和参数已经成功执行，请使用已有结果或调整参数。"
                            )
                            repeated_summary = (
                                "相同调用已经成功执行，未再次执行；Agent 将继续决策。"
                            )
                        else:
                            repeated_message = (
                                "相同工具和参数此前已发生不可重试的失败，请调整参数或更换方案。"
                            )
                            repeated_summary = (
                                "相同调用此前已发生不可重试的失败，未再次执行；Agent 将继续决策。"
                            )
                        plan.result = ToolResult(
                            tool=call.tool,
                            success=False,
                            summary=repeated_summary,
                            data={"callId": call_id},
                            error=AgentError(
                                code="repeated_tool_call",
                                message=repeated_message,
                                technical_detail=(
                                    f"duplicate canonical tool call after {previous_outcome}"
                                ),
                                retryable=False,
                            ),
                        )

                async def execute_plan(plan: _ToolPlan) -> tuple[ToolResult, int]:
                    started = time.perf_counter()
                    result = await self.registry.execute(
                        plan.call.tool,
                        self.context,
                        plan.call.arguments,
                        enabled_tools=config.enabled_tools,
                        allow_write=config.allow_write,
                        tool_timeout_seconds=config.tool_timeout_seconds,
                    )
                    duration_ms = int((time.perf_counter() - started) * 1000)
                    return result, duration_ms

                runnable = [plan for plan in plans if plan.result is None]
                parallel = [
                    plan for plan in runnable
                    if tool_risk_levels.get(plan.call.tool) in {"read", "network"}
                ]
                serial = [plan for plan in runnable if plan not in parallel]
                if parallel:
                    completed = await budget.wait(
                        asyncio.gather(*(execute_plan(plan) for plan in parallel)),
                        cancel_event,
                    )
                    for plan, (result, duration_ms) in zip(parallel, completed):
                        plan.result = result
                        plan.duration_ms = duration_ms
                        plan.revision_at_execution = workspace_revision
                for plan in serial:
                    result, duration_ms = await budget.wait(
                        execute_plan(plan), cancel_event
                    )
                    plan.result = result
                    plan.duration_ms = duration_ms

                cancelled_during_approval = False
                for plan in plans:
                    assert plan.result is not None
                    if not self._requires_approval(plan.call.tool, plan.result):
                        continue
                    if cancelled_during_approval:
                        plan.result = self._approval_tool_result(
                            plan.call.tool,
                            plan.result,
                            ApprovalResolution(
                                status="cancelled", reason="run cancelled"
                            ),
                        )
                        continue
                    if self.approval_manager is None:
                        raise RuntimeError("approval manager is required for file_patch")
                    approval = self.approval_manager.create(
                        run_id=run_id,
                        step_id=plan.step_id,
                        call_id=plan.call_id,
                        tool_name=plan.call.tool,
                        payload=plan.result.data,
                    )
                    yield event(
                        "approval_required", run_id, step=plan.step,
                        **approval.as_event(),
                    )
                    try:
                        resolution = await budget.wait(
                            self.approval_manager.wait_for_resolution(approval.approval_id),
                            cancel_event,
                        )
                    except _RunCancelled:
                        await self.approval_manager.cancel_run(run_id)
                        resolution = ApprovalResolution(
                            status="cancelled", reason="run cancelled"
                        )
                        cancelled_during_approval = True
                    yield event(
                        "approval_resolved", run_id, step=plan.step,
                        stepId=plan.step_id, callId=plan.call_id,
                        approvalId=approval.approval_id,
                        resolution=resolution.as_dict(),
                    )
                    plan.result = self._approval_tool_result(
                        plan.call.tool, plan.result, resolution
                    )

                for plan in plans:
                    result = plan.result
                    assert result is not None
                    if (
                        plan.signature is not None
                        and (
                            result.success
                            or (result.error is not None and not result.error.retryable)
                        )
                    ):
                        risk_level = tool_risk_levels.get(plan.call.tool)
                        revision = (
                            plan.revision_at_execution
                            if risk_level == "read"
                            else None
                        )
                        outcome = "success" if result.success else "non_retryable_failure"
                        blocked_call_signatures[plan.signature] = (revision, outcome)
                        if result.success and risk_level in {"write", "terminal"}:
                            workspace_revision += 1
                    yield tool_result_event(
                        run_id, step=plan.step, step_id=plan.step_id,
                        call_id=plan.call_id, result=result,
                        duration_ms=plan.duration_ms,
                    )
                    if (
                        plan.call.tool == "rag_search"
                        and result.success
                        and isinstance(result.data, dict)
                        and isinstance(result.data.get("sources"), list)
                    ):
                        retrieval_id = f"ret_{uuid.uuid4().hex}"
                        safe_sources = self._safe_sources(
                            result.data["sources"], run_id=run_id,
                            retrieval_id=retrieval_id,
                        )
                        yield event(
                            "sources", run_id, callId=plan.call_id,
                            retrievalId=retrieval_id, sources=safe_sources,
                        )
                    yield event(
                        "timeline", run_id, step=plan.step,
                        stepId=plan.step_id,
                        status=(
                            "cancelled"
                            if result.error and result.error.code == "approval_cancelled"
                            else ("completed" if result.success else "failed")
                        ),
                        summary=result.summary,
                    )
                    active_steps.pop(plan.call_id, None)

                messages.append(ChatMessage(
                    role="assistant", content=assistant_content,
                    reasoning_content=reasoning_content,
                    tool_calls=assistant_calls,
                ))
                messages.extend(
                    ChatMessage(
                        role="tool", name=plan.call.tool,
                        tool_call_id=plan.call_id,
                        content=observation_prompt(plan.result),
                    )
                    for plan in plans
                )
                if cancelled_during_approval:
                    yield event("done", run_id, status="cancelled")
                    return
        except _RunCancelled:
            if self.approval_manager is not None:
                await self.approval_manager.cancel_run(run_id)
            pending_steps = list(active_steps.values()) or [
                (steps + 1, f"step_{steps + 1}_cancelled")
            ]
            for step, step_id in pending_steps:
                yield event(
                    "timeline", run_id, step=step, stepId=step_id,
                    status="cancelled", summary="Agent 运行已取消。",
                )
            yield event("done", run_id, status="cancelled")
        except _AgentTimedOut:
            yield error_event(run_id, AgentError(
                code="agent_timeout",
                message="Agent 运行超过总时间限制，请重试或缩小任务范围。",
                technical_detail="run deadline exceeded",
                retryable=True,
            ))
        except asyncio.CancelledError:
            raise
        except AgentEmptyDecisionError as exc:
            yield error_event(run_id, AgentError(
                code="decision_empty",
                message="模型本次未生成有效回答，请重试或切换模型。",
                technical_detail=type(exc).__name__,
                retryable=True,
            ))
        except (AgentDecisionParseError, ValidationError, ValueError, TypeError) as exc:
            yield error_event(run_id, AgentError(
                code="decision_invalid",
                message="模型返回了无效的 Agent 决策，请重试。",
                technical_detail=type(exc).__name__,
                retryable=True,
            ))
        except Exception as exc:
            yield error_event(run_id, AgentError(
                code="agent_failed",
                message="Agent 运行失败，请稍后重试。",
                technical_detail=type(exc).__name__,
                retryable=True,
            ))

    @staticmethod
    def _safe_sources(
        sources: list[Any],
        *,
        run_id: str | None = None,
        retrieval_id: str | None = None,
    ) -> list[Any]:
        def sanitize(value: Any) -> Any:
            if isinstance(value, list):
                return [sanitize(item) for item in value]
            if not isinstance(value, dict):
                return value
            cleaned = {}
            for key, item in value.items():
                if key in {"path", "source", "file_path"} and isinstance(item, str):
                    normalized = item.replace("\\", "/")
                    segments = normalized.split("/")
                    if (
                        normalized.startswith("/")
                        or re.match(r"^[A-Za-z]:", normalized)
                        or "\x00" in normalized
                        or any(
                            segment in {"", ".", ".."}
                            or segment.lower() == ".looma"
                            for segment in segments
                        )
                    ):
                        continue
                    cleaned[key] = normalized
                elif isinstance(item, (dict, list)):
                    cleaned[key] = sanitize(item)
                else:
                    cleaned[key] = item
            return cleaned

        safe_sources: list[Any] = []
        for index, source in enumerate(sources):
            cleaned = sanitize(source)
            if isinstance(cleaned, dict) and run_id and retrieval_id:
                cleaned = {
                    **cleaned,
                    "sourceId": f"src_{uuid.uuid4().hex}",
                    "retrievalId": retrieval_id,
                    "runId": run_id,
                }
            safe_sources.append(cleaned)
        return safe_sources

    @staticmethod
    def _requires_approval(tool_name: str, result: ToolResult) -> bool:
        return (
            tool_name == "file_patch"
            and result.success
            and isinstance(result.data, dict)
            and result.data.get("requiresApproval") is True
        )

    @staticmethod
    def _approval_tool_result(
        tool_name: str, pending_result: ToolResult, resolution: ApprovalResolution
    ) -> ToolResult:
        payload = pending_result.data if isinstance(pending_result.data, dict) else {}
        safe_proposal = {
            key: value
            for key, value in payload.items()
            if key in {"path", "operation", "expected_sha256", "proposed_sha256"}
        }
        data = {
            "status": resolution.status,
            "reason": resolution.reason,
            "applied": resolution.applied,
            "proposal": safe_proposal,
        }
        if resolution.status == "approved":
            if resolution.applied is not True:
                return ToolResult(
                    tool=tool_name,
                    success=False,
                    summary="Patch was approved but could not be applied.",
                    data=data,
                    error=AgentError(
                        code="patch_apply_failed",
                        message="文件修改已获批准，但写入失败。",
                        technical_detail=resolution.reason,
                        retryable=True,
                    ),
                )
            return ToolResult(
                tool=tool_name,
                success=True,
                summary="Patch proposal approved.",
                data=data,
            )
        error_codes = {
            "rejected": "approval_rejected",
            "expired": "approval_expired",
            "cancelled": "approval_cancelled",
        }
        messages = {
            "rejected": "Patch proposal was rejected.",
            "expired": "Patch proposal approval timed out.",
            "cancelled": "Patch proposal approval was cancelled.",
        }
        return ToolResult(
            tool=tool_name,
            success=False,
            summary=messages[resolution.status],
            data=data,
            error=AgentError(
                code=error_codes[resolution.status],
                message=messages[resolution.status],
                retryable=resolution.status == "expired",
            ),
        )
