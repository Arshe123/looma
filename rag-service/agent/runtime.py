from __future__ import annotations

import asyncio
import json
import re
import time
import uuid
from collections.abc import AsyncIterator, Awaitable
from dataclasses import dataclass, replace
from datetime import datetime, timedelta, timezone
from typing import Any

from pydantic import ValidationError

from agent.decision_parser import (
    AgentContextExhaustedError,
    AgentDecisionParseError,
    AgentEmptyDecisionError,
)
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
from agent.tools.staging import AgentStagingArea
from schemas import AgentConfig, ChatMessage, ChatToolCall, ChatToolFunction


class _RunCancelled(Exception):
    pass


_SAFE_PROVIDER_CALL_ID = re.compile(r"^[A-Za-z0-9_-]{1,128}$")


def _provider_http_status(exc: Exception) -> int | None:
    """Extract only the HTTP status from SDK exceptions; never persist raw responses."""

    candidates = (
        getattr(exc, "status_code", None),
        getattr(getattr(exc, "response", None), "status_code", None),
    )
    for value in candidates:
        if isinstance(value, int) and not isinstance(value, bool) and 100 <= value <= 599:
            return value
    return None


def _provider_agent_error(exc: Exception) -> AgentError:
    error_type = type(exc).__name__[:120]
    status = _provider_http_status(exc)
    technical_detail = (
        f"{error_type} (HTTP {status})" if status is not None else error_type
    )
    mappings: dict[int, tuple[str, str, bool]] = {
        401: (
            "provider_auth_failed",
            "模型服务认证失败，请检查 API Key 后重试。",
            False,
        ),
        402: (
            "provider_insufficient_balance",
            "模型服务账户余额不足，请充值后重试。",
            False,
        ),
        403: (
            "provider_access_denied",
            "模型服务拒绝访问，请检查 API Key 权限或模型权限。",
            False,
        ),
        408: (
            "provider_timeout",
            "模型服务响应超时，请稍后重试。",
            True,
        ),
        413: (
            "provider_request_too_large",
            "发送给模型的上下文过大，请缩小任务范围或开始新对话。",
            False,
        ),
        429: (
            "provider_rate_limited",
            "模型服务请求过于频繁，请稍后重试。",
            True,
        ),
    }
    if status in mappings:
        code, message, retryable = mappings[status]
        return AgentError(
            code=code,
            message=message,
            technical_detail=technical_detail,
            retryable=retryable,
        )
    if status is not None and status >= 500:
        return AgentError(
            code="provider_unavailable",
            message="模型服务暂时不可用，请稍后重试。",
            technical_detail=technical_detail,
            retryable=True,
        )
    if status is not None:
        return AgentError(
            code="provider_request_failed",
            message="模型服务拒绝了本次请求，请检查模型配置后重试。",
            technical_detail=technical_detail,
            retryable=status in {409, 425},
        )
    return AgentError(
        code="agent_failed",
        message="Agent 运行失败，请稍后重试。",
        technical_detail=technical_detail,
        retryable=True,
    )


async def _wait_with_cancellation(
    operation: Awaitable[Any], cancel_event: asyncio.Event | None
) -> Any:
    if cancel_event is None:
        return await operation
    operation_task = asyncio.ensure_future(operation)
    cancel_task = asyncio.create_task(cancel_event.wait())
    try:
        done, _ = await asyncio.wait(
            {operation_task, cancel_task}, return_when=asyncio.FIRST_COMPLETED
        )
        if cancel_task in done and cancel_task.result():
            operation_task.cancel()
            await asyncio.gather(operation_task, return_exceptions=True)
            raise _RunCancelled
        return operation_task.result()
    except asyncio.CancelledError:
        operation_task.cancel()
        cancel_task.cancel()
        await asyncio.gather(
            operation_task, cancel_task, return_exceptions=True,
        )
        raise
    finally:
        if not cancel_task.done():
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
    reuse_from: _ToolPlan | None = None
    result: ToolResult | None = None
    duration_ms: int = 0


@dataclass(frozen=True)
class _BlockedToolCall:
    revision: int | None
    outcome: str
    result: ToolResult


def _reused_success_result(tool_name: str, previous: ToolResult) -> ToolResult:
    return ToolResult(
        tool=tool_name,
        success=True,
        summary="相同调用已经成功执行，本次未重复执行并复用已有结果。",
        data={
            "status": "reused_previous_success",
            "instruction": (
                "请使用 previousResult 继续决策；不要再次使用相同工具和参数。"
            ),
            "previousResult": previous.data,
        },
        truncated=previous.truncated,
    )


class AgentRuntime:
    """Bounded provider/tool decision loop with one terminal stream event."""

    def __init__(
        self,
        *,
        provider: Any,
        registry: ToolRegistry,
        context: AgentToolContext,
    ):
        self.provider = provider
        self.registry = registry
        self.context = context

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
        run_context = replace(self.context, run_id=run_id)
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
        iterations = 0
        tool_steps = 0
        active_steps: dict[str, tuple[int, str]] = {}
        blocked_call_signatures: dict[str, _BlockedToolCall] = {}
        seen_call_ids = {
            call.id
            for message in history
            for call in (message.tool_calls or [])
        }
        workspace_revision = 0
        chat_config = getattr(getattr(self.context, "ai_config", None), "chat", None)
        provider_name = str(getattr(chat_config, "provider", "unknown"))
        model_name = str(getattr(chat_config, "model", "unknown"))
        pending_approvals: dict[str, dict[str, Any]] = {}
        try:
            while True:
                forced_final = iterations >= config.max_iterations
                decision_messages = messages
                decision_schemas = schemas
                if forced_final:
                    decision_messages = [
                        *messages,
                        ChatMessage(
                            role="system",
                            content=final_only_prompt(config.max_iterations),
                        ),
                    ]
                    decision_schemas = []
                else:
                    iterations += 1

                decision_started = time.perf_counter()
                try:
                    raw_decision = await _wait_with_cancellation(
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
                except (_RunCancelled, asyncio.CancelledError):
                    raise
                except Exception as exc:
                    if forced_final:
                        provider_error = _provider_agent_error(exc)
                        if provider_error.code != "agent_failed":
                            yield error_event(run_id, provider_error)
                            return
                        yield error_event(run_id, AgentError(
                            code="max_iterations_exceeded",
                            message="Agent 已达到内循环上限，且模型无法生成最终答案。",
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
                    answer = decision.answer
                    if forced_final:
                        answer = (
                            f"{answer}\n\n> 提示：本次 Agent 已达到 "
                            f"{config.max_iterations} 次内循环上限，模型已停止调用工具并基于现有信息输出最终答案。"
                        )
                    yield event(
                        "delta", run_id, text=answer, content=answer
                    )
                    for approval_event in pending_approvals.values():
                        yield approval_event
                    yield event(
                        "done", run_id, status="completed", answer=answer
                    )
                    return

                if forced_final:
                    yield error_event(run_id, AgentError(
                        code="max_iterations_exceeded",
                        message="Agent 已达到内循环上限，模型仍未提供最终答案。",
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
                batch_signatures: dict[str, _ToolPlan] = {}
                assistant_calls: list[ChatToolCall] = []
                for call in batch_calls:
                    tool_steps += 1
                    step_id = f"step_{tool_steps}_{uuid.uuid4().hex[:12]}"
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
                        call=call, step=tool_steps, step_id=step_id, call_id=call_id
                    )
                    plans.append(plan)
                    active_steps[call_id] = (tool_steps, step_id)
                    assistant_calls.append(ChatToolCall(
                        id=call_id,
                        function=ChatToolFunction(
                            name=call.tool, arguments=call.arguments
                        ),
                    ))
                    yield event(
                        "timeline", run_id, step=tool_steps, stepId=step_id,
                        status="running", summary=call.thought_summary,
                    )
                    yield event(
                        "tool_call", run_id, step=tool_steps, stepId=step_id,
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
                    first_batch_plan = batch_signatures.get(call_signature)
                    if first_batch_plan is not None:
                        # Defer the duplicate until the first canonical call has
                        # completed, then mirror its sanitized result without
                        # executing the tool twice.
                        plan.signature = None
                        plan.reuse_from = first_batch_plan
                        continue
                    batch_signatures[call_signature] = plan

                    previous_call = blocked_call_signatures.get(call_signature)
                    repeated_call = (
                        previous_call is not None
                        and (
                            previous_call.revision is None
                            or previous_call.revision == workspace_revision
                        )
                    )
                    if repeated_call:
                        assert previous_call is not None
                        # A synthesized duplicate result must never replace the real
                        # canonical outcome stored for this signature.
                        plan.signature = None
                        if previous_call.outcome == "success":
                            plan.result = _reused_success_result(
                                call.tool, previous_call.result
                            )
                        else:
                            repeated_message = (
                                "相同工具和参数此前已发生不可重试的失败，请调整参数或更换方案。"
                            )
                            plan.result = ToolResult(
                                tool=call.tool,
                                success=False,
                                summary=(
                                    "相同调用此前已发生不可重试的失败，未再次执行；Agent 将继续决策。"
                                ),
                                data={"callId": call_id},
                                error=AgentError(
                                    code="repeated_tool_call",
                                    message=repeated_message,
                                    technical_detail=(
                                        "duplicate canonical tool call after "
                                        "non_retryable_failure"
                                    ),
                                    retryable=False,
                                ),
                            )

                async def execute_plan(plan: _ToolPlan) -> tuple[ToolResult, int]:
                    started = time.perf_counter()
                    result = await self.registry.execute(
                        plan.call.tool,
                        run_context,
                        plan.call.arguments,
                        enabled_tools=config.enabled_tools,
                        allow_write=config.allow_write,
                        tool_timeout_seconds=config.tool_timeout_seconds,
                    )
                    duration_ms = int((time.perf_counter() - started) * 1000)
                    return result, duration_ms

                runnable = [
                    plan for plan in plans
                    if plan.result is None and plan.reuse_from is None
                ]
                parallel = [
                    plan for plan in runnable
                    if tool_risk_levels.get(plan.call.tool) in {"read", "network"}
                ]
                serial = [plan for plan in runnable if plan not in parallel]
                if parallel:
                    completed = await _wait_with_cancellation(
                        asyncio.gather(*(execute_plan(plan) for plan in parallel)),
                        cancel_event,
                    )
                    for plan, (result, duration_ms) in zip(parallel, completed):
                        plan.result = result
                        plan.duration_ms = duration_ms
                        plan.revision_at_execution = workspace_revision
                for plan in serial:
                    result, duration_ms = await _wait_with_cancellation(
                        execute_plan(plan), cancel_event
                    )
                    plan.result = result
                    plan.duration_ms = duration_ms

                for plan in plans:
                    if plan.reuse_from is None:
                        continue
                    source_result = plan.reuse_from.result
                    assert source_result is not None
                    if source_result.success:
                        plan.result = _reused_success_result(
                            plan.call.tool, source_result
                        )
                    else:
                        assert source_result.error is not None
                        plan.result = ToolResult(
                            tool=plan.call.tool,
                            success=False,
                            summary=(
                                "同一批次中的首个相同调用已失败，本次未重复执行。"
                            ),
                            data={
                                "status": "reused_previous_failure",
                                "previousResult": source_result.data,
                            },
                            error=source_result.error,
                            truncated=source_result.truncated,
                        )

                for plan in plans:
                    assert plan.result is not None
                    if not self._requires_approval(plan.call.tool, plan.result):
                        continue
                    requested_at = datetime.now(timezone.utc)
                    approval_id = f"approval_{uuid.uuid4().hex}"
                    approval_event = event(
                        "approval_required", run_id, step=plan.step,
                        approvalId=approval_id,
                        stepId=plan.step_id,
                        callId=plan.call_id,
                        tool=plan.call.tool,
                        proposal=self._approval_proposal(plan.result),
                        requestedAt=requested_at.isoformat(timespec="milliseconds").replace("+00:00", "Z"),
                        deadlineAt=(requested_at + timedelta(days=7)).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
                    )
                    proposal = self._approval_proposal(plan.result) or {}
                    proposal_path = proposal.get("path")
                    if isinstance(proposal_path, str):
                        pending_approvals[proposal_path] = approval_event
                    plan.result = self._pending_approval_tool_result(plan.call.tool, plan.result)

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
                        blocked_call_signatures[plan.signature] = _BlockedToolCall(
                            revision=revision,
                            outcome=outcome,
                            result=result,
                        )
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
        except _RunCancelled:
            pending_steps = list(active_steps.values()) or [
                (tool_steps + 1, f"step_{tool_steps + 1}_cancelled")
            ]
            for step, step_id in pending_steps:
                yield event(
                    "timeline", run_id, step=step, stepId=step_id,
                    status="cancelled", summary="Agent 运行已取消。",
                )
            yield event("done", run_id, status="cancelled")
        except asyncio.CancelledError:
            raise
        except AgentEmptyDecisionError as exc:
            yield error_event(run_id, AgentError(
                code="decision_empty",
                message="模型本次未生成有效回答，请重试或切换模型。",
                technical_detail=type(exc).__name__,
                retryable=True,
            ))
        except AgentContextExhaustedError as exc:
            yield error_event(run_id, AgentError(
                code="decision_context_exhausted",
                message=(
                    "模型上下文已满，无法继续生成 Agent 决策。"
                    "请开始新对话，或减少单次任务中的大段文件修改。"
                ),
                technical_detail=type(exc).__name__,
                retryable=False,
            ))
        except (AgentDecisionParseError, ValidationError, ValueError, TypeError) as exc:
            yield error_event(run_id, AgentError(
                code="decision_invalid",
                message="模型返回了无效的 Agent 决策，请重试。",
                technical_detail=type(exc).__name__,
                retryable=True,
            ))
        except Exception as exc:
            yield error_event(run_id, _provider_agent_error(exc))
        finally:
            try:
                AgentStagingArea(run_context.workspace_path, run_id).cleanup_run()
            except Exception:
                # Main owns immutable review artifacts; staging is only a run-local cache.
                # Cleanup failure must not mask the canonical terminal event.
                pass

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
        proposal = AgentRuntime._approval_proposal(result)
        return (
            tool_name == "file_patch"
            and result.success
            and isinstance(proposal, dict)
            and proposal.get("requiresApproval") is True
        )

    @staticmethod
    def _approval_proposal(result: ToolResult) -> dict[str, Any] | None:
        private_payload = getattr(result, "_approval_payload", None)
        if isinstance(private_payload, dict):
            return private_payload
        return result.data if isinstance(result.data, dict) else None

    @staticmethod
    def _pending_approval_tool_result(
        tool_name: str, pending_result: ToolResult
    ) -> ToolResult:
        payload = AgentRuntime._approval_proposal(pending_result) or {}
        safe_proposal = {
            key: value
            for key, value in payload.items()
            if key in {"path", "operation", "expected_sha256", "proposed_sha256"}
        }
        return ToolResult(
            tool=tool_name,
            success=True,
            summary=(
                "文件修改已写入本次运行的暂存视图；正式工作区尚未改变。后续 "
                "file_read/file_patch 会继续使用暂存版本，只有整轮成功结束后的最终累计版本才会进入审查。"
            ),
            data={
                "status": "staged_for_end_of_run_review",
                "applied": False,
                "diskState": "unchanged_until_approved",
                "stagedView": "updated",
                "subsequentFileAccess": "staging_first",
                "proposal": safe_proposal,
            },
        )
