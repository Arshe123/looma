import json
import math
import re
from typing import Any, AsyncIterator, List

import httpx

from agent.decision_parser import (
    AgentContextExhaustedError,
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
from providers.base import BaseChatProvider, BaseEmbeddingProvider, StructuredChatResponse
from providers.tool_call_repair import (
    ToolCallFormatError,
    contains_textual_tool_call,
    parse_tool_arguments,
    repair_tool_name,
)
from schemas import ChatMessage, ChatModelConfig, EmbeddingModelConfig


_MAX_NATIVE_TOOL_CALLS = 16
_MAX_FINAL_CONTENT_CHARS = 50_000
_MAX_AGENT_DECISION_ATTEMPTS = 3
_MIN_AGENT_CONTEXT_TOKENS = 16_384
_MAX_AGENT_CONTEXT_TOKENS = 65_536
_MIN_AGENT_OUTPUT_TOKENS = 8_192
_SAFE_CALL_ID = re.compile(r"^[A-Za-z0-9_-]{1,128}$")
_SAFE_TOOL_NAME = re.compile(r"^[A-Za-z0-9_-]{1,128}$")


class _OllamaDecisionError(Exception):
    def __init__(self, code: str, content: str = "") -> None:
        self.code = code
        self.content = content
        super().__init__(code)


def _ollama_chat_messages(messages: List[ChatMessage]) -> list[dict]:
    payloads = []
    for message in messages:
        payload = {"role": message.role, "content": message.content or ""}
        if message.tool_calls:
            payload["tool_calls"] = [
                {
                    "function": {
                        "name": call.function.name,
                        "arguments": call.function.arguments,
                    }
                }
                for call in message.tool_calls
            ]
        if message.role == "tool" and message.name:
            payload["tool_name"] = message.name
        payloads.append(payload)
    return payloads


class OllamaChatProvider(BaseChatProvider):
    def __init__(self, config: ChatModelConfig):
        self.model = config.model
        self.base_url = config.base_url or "http://localhost:11434"
        self.temperature = config.temperature
        self.max_tokens = config.max_tokens

    async def complete_structured(
        self, messages: List[ChatMessage], tool_schemas: Any
    ) -> AgentDecision:
        """Use Ollama's native function tools instead of prompt-only JSON decisions."""

        native_tools, allowed_tools = prepare_native_tool_schemas(tool_schemas)
        request_messages = self._agent_messages(messages, bool(native_tools))
        context_tokens = self._agent_context_tokens(request_messages, native_tools)
        last_error: _OllamaDecisionError | None = None
        for attempt in range(_MAX_AGENT_DECISION_ATTEMPTS):
            try:
                response = await self._create_agent_completion(
                    request_messages, native_tools, context_tokens
                )
            except httpx.HTTPStatusError as exc:
                status_code = exc.response.status_code
                if status_code != 500 or attempt == _MAX_AGENT_DECISION_ATTEMPTS - 1:
                    raise
                last_error = _OllamaDecisionError("provider_tool_parse_failed")
                request_messages = self._repair_messages(request_messages, last_error)
                continue
            try:
                return self._parse_native_decision(response, allowed_tools)
            except _OllamaDecisionError as exc:
                last_error = exc
                if (
                    exc.code == "truncated_content"
                    and self._response_exhausted_context(response, context_tokens)
                ):
                    if context_tokens >= _MAX_AGENT_CONTEXT_TOKENS:
                        raise AgentContextExhaustedError() from None
                    context_tokens = min(
                        context_tokens * 2, _MAX_AGENT_CONTEXT_TOKENS
                    )
                    continue
                if attempt == _MAX_AGENT_DECISION_ATTEMPTS - 1:
                    break
                request_messages = self._repair_messages(request_messages, exc)

        if last_error is not None and last_error.code == "empty_decision":
            raise AgentEmptyDecisionError() from None
        if last_error is not None and last_error.code == "truncated_content":
            raise AgentContextExhaustedError() from None
        raise AgentDecisionParseError() from None

    @staticmethod
    def _agent_context_tokens(
        messages: list[dict[str, Any]], native_tools: list[dict[str, Any]]
    ) -> int:
        """Reserve output space instead of letting a large transcript fill num_ctx."""

        serialized = json.dumps(
            {"messages": messages, "tools": native_tools},
            ensure_ascii=False,
            separators=(",", ":"),
        )
        ascii_chars = sum(character.isascii() for character in serialized)
        non_ascii_chars = len(serialized) - ascii_chars
        estimated_prompt_tokens = (
            math.ceil(ascii_chars / 4)
            + math.ceil(non_ascii_chars * 1.5)
            + 512
        )
        required_tokens = estimated_prompt_tokens + _MIN_AGENT_OUTPUT_TOKENS
        rounded_tokens = 1 << max(0, required_tokens - 1).bit_length()
        return min(
            _MAX_AGENT_CONTEXT_TOKENS,
            max(_MIN_AGENT_CONTEXT_TOKENS, rounded_tokens),
        )

    @staticmethod
    def _response_exhausted_context(
        response: dict[str, Any], context_tokens: int
    ) -> bool:
        prompt_tokens = response.get("prompt_eval_count")
        output_tokens = response.get("eval_count")
        return (
            isinstance(prompt_tokens, int)
            and not isinstance(prompt_tokens, bool)
            and isinstance(output_tokens, int)
            and not isinstance(output_tokens, bool)
            and prompt_tokens + output_tokens >= context_tokens
        )

    def _agent_messages(
        self, messages: List[ChatMessage], tools_available: bool
    ) -> list[dict[str, Any]]:
        instruction = (
            "你是 Looma Agent。需要外部信息或操作时，只能使用 API 提供的原生 function tools；"
            "可以在同一轮调用多个互相独立的工具。不要在 content 中输出 XML、DSML、"
            "<tool_call> 或伪造的工具 JSON。无需工具时，直接在 content 中给出普通最终答案。"
            if tools_available
            else (
                "你是 Looma Agent。本轮没有可用工具；请仅根据已有上下文直接给出普通最终答案。"
                "不要输出 JSON 决策包装、XML、DSML 或工具调用。"
            )
        )
        return [{"role": "system", "content": instruction}, *_ollama_chat_messages(messages)]

    async def _create_agent_completion(
        self,
        messages: list[dict[str, Any]],
        native_tools: list[dict[str, Any]],
        context_tokens: int,
    ) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "model": self.model,
            "messages": messages,
            "stream": False,
            "think": False,
            "options": {
                "temperature": min(self.temperature, 0.2),
                "num_ctx": context_tokens,
                "num_predict": max(self.max_tokens or 0, _MIN_AGENT_OUTPUT_TOKENS),
            },
        }
        if native_tools:
            payload["tools"] = native_tools
        async with httpx.AsyncClient(timeout=None) as client:
            response = await client.post(f"{self.base_url}/api/chat", json=payload)
            response.raise_for_status()
            data = response.json()
        if not isinstance(data, dict):
            raise _OllamaDecisionError("invalid_response")
        return data

    def _parse_native_decision(
        self, data: dict[str, Any], allowed_tools: frozenset[str]
    ) -> AgentDecision:
        message = data.get("message")
        if not isinstance(message, dict):
            raise _OllamaDecisionError("invalid_response")
        content = message.get("content") or ""
        if not isinstance(content, str) or len(content) > _MAX_FINAL_CONTENT_CHARS:
            raise _OllamaDecisionError("invalid_content")
        finish_reason = data.get("done_reason")
        tool_calls = message.get("tool_calls") or []
        if not isinstance(tool_calls, list):
            raise _OllamaDecisionError("invalid_tool_calls", content)
        if tool_calls:
            if len(tool_calls) > _MAX_NATIVE_TOOL_CALLS:
                raise _OllamaDecisionError("too_many_tool_calls", content)
            calls = [
                self._parse_native_tool_call(value, allowed_tools, content)
                for value in tool_calls
            ]
            state = {"finish_reason": finish_reason, "content": content}
            if len(calls) == 1 and isinstance(calls[0], AgentToolCall):
                calls[0]._provider_state.update(state)
                return calls[0]
            decision = AgentToolBatch(type="tool_calls", calls=calls)
            decision._provider_state.update(state)
            return decision
        if finish_reason == "length":
            raise _OllamaDecisionError("truncated_content", content)
        if contains_textual_tool_call(content):
            raise _OllamaDecisionError("textual_tool_call", content)
        if not content.strip():
            raise _OllamaDecisionError("empty_decision")
        decision = AgentFinalAnswer(type="final", answer=content.strip())
        decision._provider_state["finish_reason"] = finish_reason
        return decision

    @staticmethod
    def _parse_native_tool_call(
        value: Any,
        allowed_tools: frozenset[str],
        content: str,
    ) -> AgentToolCall | AgentInvalidToolCall:
        function = value.get("function") if isinstance(value, dict) else None
        call_id = value.get("id") if isinstance(value, dict) else None
        if not isinstance(function, dict) or not isinstance(function.get("name"), str):
            call: AgentToolCall | AgentInvalidToolCall = AgentInvalidToolCall(
                type="invalid_tool_call",
                thought_summary="工具调用格式无效",
                tool="invalid_tool_call",
                arguments={},
                error_code="invalid_tool_call",
            )
        else:
            raw_name = function["name"]
            name = repair_tool_name(raw_name, allowed_tools)
            if name is None:
                call = AgentInvalidToolCall(
                    type="invalid_tool_call",
                    thought_summary="工具名称无效",
                    tool=raw_name if _SAFE_TOOL_NAME.fullmatch(raw_name) else "invalid_tool_call",
                    arguments={},
                    error_code="unknown_tool",
                )
            else:
                try:
                    arguments = parse_tool_arguments(function.get("arguments"))
                except ToolCallFormatError:
                    call = AgentInvalidToolCall(
                        type="invalid_tool_call",
                        thought_summary=f"工具参数无效：{name}",
                        tool=name,
                        arguments={},
                        error_code="invalid_arguments",
                    )
                else:
                    call = AgentToolCall(
                        type="tool_call",
                        thought_summary=(content.strip()[:500] or f"调用工具：{name}"),
                        tool=name,
                        arguments=arguments,
                    )
        if isinstance(call_id, str) and _SAFE_CALL_ID.fullmatch(call_id):
            call._provider_state["tool_call_id"] = call_id
        return call

    @staticmethod
    def _repair_messages(
        messages: list[dict[str, Any]], error: _OllamaDecisionError
    ) -> list[dict[str, Any]]:
        # Never replay malformed/truncated pseudo-tool text as an assistant example;
        # doing so reinforces the invalid format and consumes the repair context.
        repaired = [*messages]
        repaired.append({
            "role": "user",
            "content": (
                "上一个响应为空、被截断，或其原生工具调用被模型服务拒绝。"
                "如需工具，请重新使用 API 原生 function tool call，并确保工具名称与参数结构完整；"
                "否则直接给出普通最终答案。"
            ),
        })
        return repaired

    async def chat(self, messages: List[ChatMessage]) -> str:
        return await self._chat(messages, structured=False)

    async def chat_structured(
        self, messages: List[ChatMessage]
    ) -> StructuredChatResponse:
        return await self._chat(messages, structured=True)

    async def _chat(
        self, messages: List[ChatMessage], *, structured: bool
    ) -> str | StructuredChatResponse:
        url = f"{self.base_url}/api/chat"

        payload = {
            "model": self.model,
            "messages": _ollama_chat_messages(messages),
            "stream": False,
            "options": {
                "temperature": min(self.temperature, 0.2) if structured else self.temperature
            }
        }
        if self.max_tokens is not None:
            payload["options"]["num_predict"] = self.max_tokens
        if structured:
            payload["format"] = "json"
            payload["think"] = False

        async with httpx.AsyncClient(timeout=None) as client:
            response = await client.post(url, json=payload)
            response.raise_for_status()
            data = response.json()

        content = data.get("message", {}).get("content") or ""
        if structured:
            return StructuredChatResponse(
                content=content,
                finish_reason=data.get("done_reason"),
            )
        return content

    async def stream_chat(self, messages: List[ChatMessage]) -> AsyncIterator[str]:
        url = f"{self.base_url}/api/chat"

        payload = {
            "model": self.model,
            "messages": _ollama_chat_messages(messages),
            "stream": True,
            "options": {
                "temperature": self.temperature
            }
        }

        async with httpx.AsyncClient(timeout=None) as client:
            async with client.stream("POST", url, json=payload) as response:
                response.raise_for_status()

                async for line in response.aiter_lines():
                    if not line:
                        continue

                    data = json.loads(line)

                    if data.get("done"):
                        break

                    content = data.get("message", {}).get("content")
                    if content:
                        yield content


class OllamaEmbeddingProvider(BaseEmbeddingProvider):
    def __init__(self, config: EmbeddingModelConfig):
        self.model = config.model
        self.base_url = config.base_url or "http://localhost:11434"

    async def embed_text(self, text: str) -> List[float]:
        vectors = await self.embed_documents([text])
        return vectors[0]

    async def embed_documents(self, texts: List[str]) -> List[List[float]]:
        url = f"{self.base_url}/api/embed"

        payload = {
            "model": self.model,
            "input": texts
        }

        async with httpx.AsyncClient(timeout=None) as client:
            response = await client.post(url, json=payload)
            response.raise_for_status()
            data = response.json()

        return data["embeddings"]
