from __future__ import annotations

import asyncio
import json
import re
import uuid
from collections.abc import AsyncIterator, Awaitable
from dataclasses import dataclass
from typing import Any

from agent.approvals import ApprovalManager, ApprovalResolution
from pydantic import ValidationError

from agent.decision_parser import AgentDecisionParseError
from agent.events import error_event, event, model_dump, tool_result_event, utc_iso_z
from agent.models import (
    AgentError,
    AgentFinalAnswer,
    AgentToolCall,
    ToolResult,
    parse_agent_decision,
)
from agent.prompts import decision_prompt, final_only_prompt, observation_prompt
from agent.tools.base import AgentToolContext
from agent.tools.registry import ToolRegistry
from schemas import AgentConfig, ChatMessage, ChatToolCall, ChatToolFunction


class _RunCancelled(Exception):
    pass


class _AgentTimedOut(Exception):
    pass


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
        fingerprints: set[str] = set()
        steps = 0
        budget = _AwaitBudget(float(config.run_timeout_seconds))
        active_step: tuple[int, str] | None = None

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

                try:
                    raw_decision = await budget.wait(
                        self.provider.complete_structured(
                            decision_messages, decision_schemas
                        ),
                        cancel_event,
                    )
                    decision = (
                        raw_decision
                        if isinstance(raw_decision, (AgentToolCall, AgentFinalAnswer))
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

                try:
                    canonical_arguments = json.dumps(
                        decision.arguments,
                        ensure_ascii=False,
                        sort_keys=True,
                        separators=(",", ":"),
                        allow_nan=False,
                    )
                except (TypeError, ValueError):
                    raise ValueError("tool arguments are not canonical JSON") from None
                fingerprint = f"{decision.tool}:{canonical_arguments}"
                steps += 1
                step_id = f"step_{steps}_{uuid.uuid4().hex[:12]}"
                call_id = f"call_{uuid.uuid4().hex}"
                active_step = (steps, step_id)
                yield event(
                    "timeline", run_id, step=steps, stepId=step_id,
                    status="running", summary=decision.thought_summary,
                )
                yield event(
                    "tool_call", run_id, step=steps, stepId=step_id,
                    callId=call_id, tool=decision.tool,
                    arguments=decision.arguments,
                    thought_summary=decision.thought_summary,
                )

                if fingerprint in fingerprints:
                    result = ToolResult(
                        tool=decision.tool,
                        success=False,
                        summary="已阻止重复工具调用。",
                        error=AgentError(
                            code="repeated_tool_call",
                            message="检测到完全相同的重复工具调用，运行已停止。",
                            retryable=False,
                        ),
                    )
                    yield tool_result_event(
                        run_id, step=steps, step_id=step_id,
                        call_id=call_id, result=result,
                    )
                    yield event(
                        "timeline", run_id, step=steps, stepId=step_id,
                        status="failed", summary=result.summary,
                    )
                    yield error_event(run_id, result.error)
                    return
                fingerprints.add(fingerprint)

                result = await budget.wait(
                    self.registry.execute(
                        decision.tool,
                        self.context,
                        decision.arguments,
                        enabled_tools=config.enabled_tools,
                        allow_write=config.allow_write,
                        tool_timeout_seconds=config.tool_timeout_seconds,
                    ),
                    cancel_event,
                )
                if self._requires_approval(decision.tool, result):
                    if self.approval_manager is None:
                        raise RuntimeError("approval manager is required for file_patch")
                    approval = self.approval_manager.create(
                        run_id=run_id,
                        step_id=step_id,
                        call_id=call_id,
                        tool_name=decision.tool,
                        payload=result.data,
                    )
                    yield event(
                        "approval_required",
                        run_id,
                        step=steps,
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
                            status="cancelled",
                            reason="run cancelled",
                        )
                    yield event(
                        "approval_resolved",
                        run_id,
                        step=steps,
                        stepId=step_id,
                        callId=call_id,
                        approvalId=approval.approval_id,
                        resolution=resolution.as_dict(),
                    )
                    result = self._approval_tool_result(decision.tool, result, resolution)
                yield tool_result_event(
                    run_id, step=steps, step_id=step_id,
                    call_id=call_id, result=result,
                )
                if (
                    decision.tool == "rag_search"
                    and result.success
                    and isinstance(result.data, dict)
                    and isinstance(result.data.get("sources"), list)
                ):
                    yield event(
                        "sources", run_id,
                        sources=self._safe_sources(result.data["sources"]),
                    )
                yield event(
                    "timeline", run_id, step=steps, stepId=step_id,
                    status=(
                        "cancelled"
                        if result.error and result.error.code == "approval_cancelled"
                        else ("completed" if result.success else "failed")
                    ),
                    summary=result.summary,
                )
                active_step = None
                if result.error and result.error.code == "approval_cancelled":
                    yield event("done", run_id, status="cancelled")
                    return
                messages.extend([
                    ChatMessage(
                        role="assistant",
                        content=decision_prompt(decision),
                        reasoning_content=decision._provider_state.get("reasoning_content"),
                        tool_calls=[ChatToolCall(
                            id=call_id,
                            function=ChatToolFunction(
                                name=decision.tool,
                                arguments=decision.arguments,
                            ),
                        )],
                    ),
                    ChatMessage(
                        role="tool",
                        name=decision.tool,
                        tool_call_id=call_id,
                        content=observation_prompt(result),
                    ),
                ])
        except _RunCancelled:
            step, step_id = active_step or (steps + 1, f"step_{steps + 1}_cancelled")
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
    def _safe_sources(sources: list[Any]) -> list[Any]:
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

        return [sanitize(source) for source in sources]

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
