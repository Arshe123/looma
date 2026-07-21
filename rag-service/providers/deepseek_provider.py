from __future__ import annotations

import json
import re
import uuid
from dataclasses import dataclass
from typing import Any, Sequence

from agent.decision_parser import (
    AgentDecisionParseError,
    AgentEmptyDecisionError,
    prepare_native_tool_schemas,
)
from agent.models import (
    AgentDecision,
    AgentFinalAnswer,
    AgentInvalidToolCall,
    AgentToolBatch,
    AgentToolCall,
)
from providers.openai_provider import OpenAIChatProvider, _openai_chat_messages
from providers.tool_call_repair import (
    ToolCallFormatError,
    contains_textual_tool_call,
    parse_tool_arguments,
    repair_tool_name,
)
from schemas import ChatMessage, ChatModelConfig


_MIN_AGENT_MAX_TOKENS = 8192
_MAX_REPAIR_CONTENT_CHARS = 20_000
_MAX_FINAL_CONTENT_CHARS = 50_000
_SAFE_CALL_ID = re.compile(r"^[A-Za-z0-9_-]{1,128}$")
_SAFE_TOOL_NAME = re.compile(r"^[A-Za-z0-9_-]{1,128}$")
_MAX_NATIVE_TOOL_CALLS = 16


@dataclass
class _RawToolCall:
    id: str
    name: str
    arguments: Any


class _NativeDecisionError(Exception):
    def __init__(
        self,
        code: str,
        *,
        raw_call: _RawToolCall | None = None,
        content: str = "",
        reasoning_content: str | None = None,
    ) -> None:
        self.code = code
        self.raw_call = raw_call
        self.content = content
        self.reasoning_content = reasoning_content
        super().__init__(code)


class DeepSeekChatProvider(OpenAIChatProvider):
    """DeepSeek Chat Completions with native tools and thinking-state echo."""

    def __init__(self, config: ChatModelConfig):
        super().__init__(config)
        self.agent_max_tokens = max(config.max_tokens or 0, _MIN_AGENT_MAX_TOKENS)

    async def complete_structured(
        self, messages: list[ChatMessage], tool_schemas: Any
    ) -> AgentDecision:
        native_tools, allowed_tools = prepare_native_tool_schemas(tool_schemas)
        request_messages = self._agent_messages(messages, bool(native_tools))
        last_error: _NativeDecisionError | None = None

        for attempt in range(2):
            response = await self._create_agent_completion(request_messages, native_tools)
            try:
                return self._parse_native_decision(response, allowed_tools)
            except _NativeDecisionError as exc:
                last_error = exc
                if attempt == 1:
                    break
                request_messages = self._repair_messages(
                    request_messages,
                    exc,
                    allowed_tools=allowed_tools,
                    thinking_enabled=self._thinking_enabled(),
                )

        if last_error is not None and last_error.code == "empty_decision":
            raise AgentEmptyDecisionError() from None
        raise AgentDecisionParseError() from None

    async def chat_structured(self, messages: list[ChatMessage]):
        """Compatibility hook: DeepSeek Agent decisions use complete_structured()."""

        return await super().chat_structured(messages)

    async def _create_agent_completion(
        self,
        messages: list[dict[str, Any]],
        native_tools: list[dict[str, Any]],
    ):
        kwargs: dict[str, Any] = {
            "model": self.model,
            "messages": messages,
            "temperature": self.temperature,
            "max_tokens": self.agent_max_tokens,
        }
        if native_tools:
            kwargs["tools"] = native_tools
        if self._thinking_enabled():
            kwargs["extra_body"] = {"thinking": {"type": "enabled"}}
        return await self.client.chat.completions.create(**kwargs)

    def _agent_messages(
        self, messages: Sequence[ChatMessage], tools_available: bool
    ) -> list[dict[str, Any]]:
        if tools_available:
            instruction = (
                "你是 Looma Agent。需要外部信息或操作时，只能使用 API 提供的原生 function tools；"
                "可以在同一轮调用多个互相独立的工具。不要在 content 中输出 XML、DSML、<tool_call> 或伪造的工具 JSON。"
                "无需工具时，直接在 content 中给出普通最终答案。"
            )
        else:
            instruction = (
                "你是 Looma Agent。本轮没有可用工具；请仅根据已有上下文直接给出普通最终答案。"
                "不要输出 JSON 决策包装、XML、DSML 或工具调用。"
            )
        payloads = _openai_chat_messages(list(messages))
        # DeepSeek's thinking/tool-call guide replays the complete assistant
        # message. Preserve an explicit JSON null instead of dropping content.
        for payload in payloads:
            if payload.get("role") == "assistant" and payload.get("tool_calls"):
                payload.setdefault("content", None)
        return [{"role": "system", "content": instruction}, *payloads]

    def _parse_native_decision(
        self, response: Any, allowed_tools: frozenset[str]
    ) -> AgentDecision:
        try:
            choice = response.choices[0]
            message = choice.message
        except (AttributeError, IndexError, TypeError):
            raise _NativeDecisionError("invalid_response") from None

        content = getattr(message, "content", None) or ""
        reasoning_content = self._reasoning_content(message)
        finish_reason = getattr(choice, "finish_reason", None)
        tool_calls = getattr(message, "tool_calls", None) or []

        if tool_calls:
            if len(tool_calls) > _MAX_NATIVE_TOOL_CALLS:
                raise _NativeDecisionError(
                    "too_many_tool_calls",
                    content=content,
                    reasoning_content=reasoning_content,
                )
            calls = [self._parse_native_tool_call(value, allowed_tools) for value in tool_calls]
            display_content = self._tool_call_display_content(content, reasoning_content)
            if display_content:
                for call in calls:
                    call.thought_summary = display_content
            common_state = {
                "finish_reason": finish_reason,
                "content": content,
                "reasoning_content": reasoning_content,
                "requires_reasoning_echo": self._thinking_enabled(),
            }
            if len(calls) == 1 and isinstance(calls[0], AgentToolCall):
                calls[0]._provider_state.update(common_state)
                return calls[0]
            decision = AgentToolBatch(type="tool_calls", calls=calls)
            decision._provider_state.update(common_state)
            return decision

        if not isinstance(content, str) or len(content) > _MAX_FINAL_CONTENT_CHARS:
            raise _NativeDecisionError(
                "invalid_content",
                reasoning_content=reasoning_content,
            )
        if finish_reason == "length":
            raise _NativeDecisionError(
                "truncated_content",
                content=content,
                reasoning_content=reasoning_content,
            )
        if contains_textual_tool_call(content):
            raise _NativeDecisionError(
                "textual_tool_call",
                content=content,
                reasoning_content=reasoning_content,
            )
        if not content.strip():
            raise _NativeDecisionError(
                "empty_decision",
                content="",
                reasoning_content=reasoning_content,
            )

        decision = AgentFinalAnswer(type="final", answer=content.strip())
        decision._provider_state["finish_reason"] = finish_reason
        return decision

    def _parse_native_tool_call(
        self, value: Any, allowed_tools: frozenset[str]
    ) -> AgentToolCall | AgentInvalidToolCall:
        raw_call = self._raw_tool_call(value)
        if raw_call is None:
            call = AgentInvalidToolCall(
                type="invalid_tool_call",
                thought_summary="工具调用格式无效",
                tool="invalid_tool_call",
                arguments={},
                error_code="invalid_tool_call",
            )
            call_id = self._raw_call_id(value)
        else:
            call_id = raw_call.id
            repaired_name = repair_tool_name(raw_call.name, allowed_tools)
            if repaired_name is None:
                call = AgentInvalidToolCall(
                    type="invalid_tool_call",
                    thought_summary="工具名称无效",
                    tool=(
                        raw_call.name
                        if _SAFE_TOOL_NAME.fullmatch(raw_call.name)
                        else "invalid_tool_call"
                    ),
                    arguments={},
                    error_code="unknown_tool",
                )
            else:
                try:
                    arguments = parse_tool_arguments(raw_call.arguments)
                except ToolCallFormatError:
                    call = AgentInvalidToolCall(
                        type="invalid_tool_call",
                        thought_summary=f"工具参数无效：{repaired_name}",
                        tool=repaired_name,
                        arguments={},
                        error_code="invalid_arguments",
                    )
                else:
                    call = AgentToolCall(
                        type="tool_call",
                        thought_summary=f"调用工具：{repaired_name}",
                        tool=repaired_name,
                        arguments=arguments,
                    )
        if isinstance(call_id, str) and _SAFE_CALL_ID.fullmatch(call_id):
            call._provider_state["tool_call_id"] = call_id
        return call

    @staticmethod
    def _raw_tool_call(value: Any) -> _RawToolCall | None:
        if isinstance(value, dict):
            call_id = value.get("id")
            function = value.get("function")
            if not isinstance(function, dict):
                return None
            name = function.get("name")
            arguments = function.get("arguments")
        else:
            call_id = getattr(value, "id", None)
            function = getattr(value, "function", None)
            if function is None:
                return None
            name = getattr(function, "name", None)
            arguments = getattr(function, "arguments", None)
        if not isinstance(name, str):
            return None
        safe_id = call_id if isinstance(call_id, str) and call_id else "invalid_call"
        return _RawToolCall(id=safe_id, name=name, arguments=arguments)

    @staticmethod
    def _raw_call_id(value: Any) -> str | None:
        call_id = value.get("id") if isinstance(value, dict) else getattr(value, "id", None)
        return call_id if isinstance(call_id, str) else None

    @staticmethod
    def _reasoning_content(message: Any) -> str | None:
        direct = getattr(message, "reasoning_content", None)
        if isinstance(direct, str) and direct:
            return direct
        model_extra = getattr(message, "model_extra", None)
        if isinstance(model_extra, dict):
            extra = model_extra.get("reasoning_content")
            if isinstance(extra, str) and extra:
                return extra
        return None

    @staticmethod
    def _tool_call_display_content(content: Any, reasoning_content: Any) -> str | None:
        """Choose bounded user-visible text for a native tool-call response.

        DeepSeek can return ordinary ``content`` alongside ``tool_calls`` and,
        for thinking models, may only return ``reasoning_content``. The UI uses
        content first, then reasoning, and keeps the generated tool label only
        when both are blank.
        """

        for value in (content, reasoning_content):
            if isinstance(value, str) and value.strip():
                return value.strip()[:500]
        return None

    @staticmethod
    def _repair_messages(
        messages: list[dict[str, Any]],
        error: _NativeDecisionError,
        *,
        allowed_tools: frozenset[str],
        thinking_enabled: bool,
    ) -> list[dict[str, Any]]:
        repaired = [*messages]
        available = ", ".join(sorted(allowed_tools)) or "无"
        if error.raw_call is not None:
            used_call_ids = {
                call.get("id")
                for message in messages
                for call in (message.get("tool_calls") or [])
                if isinstance(call, dict) and isinstance(call.get("id"), str)
            }
            call_id = (
                error.raw_call.id
                if _SAFE_CALL_ID.fullmatch(error.raw_call.id)
                and error.raw_call.id not in used_call_ids
                else f"repair_{uuid.uuid4().hex}"
            )
            name = error.raw_call.name if _SAFE_TOOL_NAME.fullmatch(error.raw_call.name) else "invalid_tool_call"
            raw_arguments = error.raw_call.arguments
            if isinstance(raw_arguments, str):
                arguments = raw_arguments[:_MAX_REPAIR_CONTENT_CHARS]
            elif isinstance(raw_arguments, dict):
                try:
                    arguments = json.dumps(
                        raw_arguments,
                        ensure_ascii=False,
                        separators=(",", ":"),
                        allow_nan=False,
                    )[:_MAX_REPAIR_CONTENT_CHARS]
                except (TypeError, ValueError, OverflowError, RecursionError):
                    arguments = "{}"
            else:
                arguments = "{}"
            assistant: dict[str, Any] = {
                "role": "assistant",
                "content": error.content[:_MAX_REPAIR_CONTENT_CHARS] or None,
                "tool_calls": [{
                    "id": call_id,
                    "type": "function",
                    "function": {"name": name, "arguments": arguments},
                }],
            }
            if thinking_enabled:
                assistant["reasoning_content"] = error.reasoning_content or " "
            repaired.extend([
                assistant,
                {
                    "role": "tool",
                    "tool_call_id": call_id,
                    "name": name,
                    "content": (
                        "Error: invalid tool call. Generate one or more native function calls with "
                        f"a valid tool name and JSON object arguments. Available tools: {available}."
                    ),
                },
            ])
            return repaired

        assistant_content = error.content[:_MAX_REPAIR_CONTENT_CHARS]
        if assistant_content:
            assistant: dict[str, Any] = {"role": "assistant", "content": assistant_content}
            if thinking_enabled:
                assistant["reasoning_content"] = error.reasoning_content or " "
            repaired.append(assistant)
        repaired.append({
            "role": "user",
            "content": (
                "上一个响应为空或使用了文本/XML/DSML 伪工具格式。"
                "如需工具，请生成一个或多个 API 原生 function tool call；否则直接给出普通最终答案。"
                f"当前可用工具：{available}。"
            ),
        })
        return repaired

    def _thinking_enabled(self) -> bool:
        model = self.model.strip().lower()
        if model == "deepseek-reasoner":
            return True
        match = re.match(r"^deepseek-v(\d+)(?:\b|[-_.])", model)
        return bool(match and int(match.group(1)) >= 4)
