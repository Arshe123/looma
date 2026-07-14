from abc import ABC, abstractmethod
from typing import Any, AsyncIterator, List

from agent.decision_parser import (
    AgentDecisionParseError,
    parse_agent_decision_text,
    prepare_agent_decision_messages,
)
from agent.models import AgentDecision
from schemas import ChatMessage


_MAX_REPAIR_RESPONSE_CHARS = 20_000


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
        try:
            return parse_agent_decision_text(first_response, allowed_tools=allowed_tools)
        except AgentDecisionParseError:
            failed_content = (
                first_response[:_MAX_REPAIR_RESPONSE_CHARS]
                if isinstance(first_response, str) and first_response.strip()
                else "[invalid or empty response]"
            )
            repair_messages = [
                *prompted_messages,
                ChatMessage(role="assistant", content=failed_content),
                ChatMessage(
                    role="user",
                    content=(
                        "上一个响应不符合约定。请修复格式，并严格按同一 schema "
                        "仅输出一个 JSON object；不要输出 Markdown、代码围栏或解释。"
                    ),
                ),
            ]
            second_response = await self.chat_structured(repair_messages)
            return parse_agent_decision_text(second_response, allowed_tools=allowed_tools)

    async def chat_structured(self, messages: List[ChatMessage]) -> str:
        """Use provider-native structured output when available."""

        return await self.chat(messages)


class BaseEmbeddingProvider(ABC):
    @abstractmethod
    async def embed_text(self, text: str) -> List[float]:
        pass

    @abstractmethod
    async def embed_documents(self, texts: List[str]) -> List[List[float]]:
        pass
