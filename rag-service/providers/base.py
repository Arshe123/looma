from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import Any, AsyncIterator, List

from agent.decision_parser import (
    AgentDecisionParseError,
    parse_agent_decision_text,
    prepare_agent_decision_messages,
)
from agent.models import AgentDecision
from schemas import ChatMessage


_MAX_REPAIR_RESPONSE_CHARS = 20_000


@dataclass(frozen=True)
class StructuredChatResponse:
    content: str
    reasoning_content: str | None = None
    finish_reason: str | None = None


def _structured_content(response: str | StructuredChatResponse) -> str:
    return response.content if isinstance(response, StructuredChatResponse) else response


def _attach_provider_state(
    decision: AgentDecision,
    response: str | StructuredChatResponse,
) -> AgentDecision:
    if isinstance(response, StructuredChatResponse) and response.finish_reason:
        decision._provider_state["finish_reason"] = response.finish_reason
    return decision


class BaseChatProvider(ABC):
    @abstractmethod
    async def chat(self, messages: List[ChatMessage]) -> str:
        pass

    @abstractmethod
    async def stream_chat(self, messages: List[ChatMessage]) -> AsyncIterator[str]:
        pass

    async def complete_structured(
        self, messages: List[ChatMessage], tool_schemas: Any
    ) -> AgentDecision:
        """Request one decision, with exactly one repair attempt for invalid output."""

        prompted_messages, allowed_tools = prepare_agent_decision_messages(
            messages, tool_schemas
        )
        first_response = await self.chat_structured(prompted_messages)
        first_content = _structured_content(first_response)
        try:
            decision = parse_agent_decision_text(first_content, allowed_tools=allowed_tools)
            return _attach_provider_state(decision, first_response)
        except AgentDecisionParseError:
            repair_messages = [*prompted_messages]
            if isinstance(first_content, str) and first_content.strip():
                repair_messages.append(ChatMessage(
                    role="assistant",
                    content=first_content[:_MAX_REPAIR_RESPONSE_CHARS],
                ))
            repair_messages.append(ChatMessage(
                role="user",
                content=(
                    "上一个响应的 content 为空或不符合约定。请重新生成，并严格按同一 schema "
                    "仅输出一个 JSON（json）object；不要输出 Markdown、代码围栏、DSML 或解释。"
                ),
            ))
            second_response = await self.chat_structured(repair_messages)
            decision = parse_agent_decision_text(
                _structured_content(second_response), allowed_tools=allowed_tools
            )
            return _attach_provider_state(decision, second_response)

    async def chat_structured(
        self, messages: List[ChatMessage]
    ) -> str | StructuredChatResponse:
        """Use provider-native structured output when available."""

        return await self.chat(messages)


class BaseEmbeddingProvider(ABC):
    @abstractmethod
    async def embed_text(self, text: str) -> List[float]:
        pass

    @abstractmethod
    async def embed_documents(self, texts: List[str]) -> List[List[float]]:
        pass
