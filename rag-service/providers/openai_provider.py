import json
from typing import AsyncIterator, List

from openai import AsyncOpenAI

from schemas import ChatMessage, ChatModelConfig, EmbeddingModelConfig
from providers.base import BaseChatProvider, BaseEmbeddingProvider, StructuredChatResponse


def _openai_chat_messages(messages: List[ChatMessage]) -> list[dict]:
    payloads = [message.model_dump(exclude_none=True) for message in messages]
    for payload in payloads:
        for call in payload.get("tool_calls", []):
            call["function"]["arguments"] = json.dumps(
                call["function"]["arguments"],
                ensure_ascii=False,
                separators=(",", ":"),
                allow_nan=False,
            )
    return payloads


class OpenAIChatProvider(BaseChatProvider):
    def __init__(self, config: ChatModelConfig):
        if not config.api_key:
            raise ValueError("OpenAI api_key is required")

        self.client = AsyncOpenAI(
            api_key=config.api_key,
            base_url=config.base_url
        )

        self.model = config.model
        self.temperature = config.temperature
        self.max_tokens = config.max_tokens

    async def chat(self, messages: List[ChatMessage]) -> str:
        response = await self.client.chat.completions.create(
            model=self.model,
            messages=_openai_chat_messages(messages),
            temperature=self.temperature,
            max_tokens=self.max_tokens
        )

        return response.choices[0].message.content or ""

    async def chat_structured(self, messages: List[ChatMessage]) -> StructuredChatResponse:
        response = await self.client.chat.completions.create(
            model=self.model,
            messages=_openai_chat_messages(messages),
            temperature=self.temperature,
            max_tokens=self.max_tokens,
        )
        message = response.choices[0].message
        reasoning_content = getattr(message, "reasoning_content", None)
        if not isinstance(reasoning_content, str):
            model_extra = getattr(message, "model_extra", None)
            reasoning_content = (
                model_extra.get("reasoning_content")
                if isinstance(model_extra, dict)
                else None
            )
        return StructuredChatResponse(
            content=message.content or "",
            reasoning_content=(
                reasoning_content if isinstance(reasoning_content, str) else None
            ),
        )

    async def stream_chat(self, messages: List[ChatMessage]) -> AsyncIterator[str]:
        stream = await self.client.chat.completions.create(
            model=self.model,
            messages=_openai_chat_messages(messages),
            temperature=self.temperature,
            max_tokens=self.max_tokens,
            stream=True
        )

        async for chunk in stream:
            delta = chunk.choices[0].delta.content
            if delta:
                yield delta


class OpenAIEmbeddingProvider(BaseEmbeddingProvider):
    def __init__(self, config: EmbeddingModelConfig):
        if not config.api_key:
            raise ValueError("OpenAI api_key is required")

        self.client = AsyncOpenAI(
            api_key=config.api_key,
            base_url=config.base_url
        )

        self.model = config.model

    async def embed_text(self, text: str) -> List[float]:
        vectors = await self.embed_documents([text])
        return vectors[0]

    async def embed_documents(self, texts: List[str]) -> List[List[float]]:
        response = await self.client.embeddings.create(
            model=self.model,
            input=texts
        )

        return [item.embedding for item in response.data]