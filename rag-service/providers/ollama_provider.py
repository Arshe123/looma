import json
from typing import AsyncIterator, List

import httpx

from schemas import ChatMessage, ChatModelConfig, EmbeddingModelConfig
from providers.base import BaseChatProvider, BaseEmbeddingProvider


class OllamaChatProvider(BaseChatProvider):
    def __init__(self, config: ChatModelConfig):
        self.model = config.model
        self.base_url = config.base_url or "http://localhost:11434"
        self.temperature = config.temperature

    async def chat(self, messages: List[ChatMessage]) -> str:
        url = f"{self.base_url}/api/chat"

        payload = {
            "model": self.model,
            "messages": [m.model_dump() for m in messages],
            "stream": False,
            "options": {
                "temperature": self.temperature
            }
        }

        async with httpx.AsyncClient(timeout=None) as client:
            response = await client.post(url, json=payload)
            response.raise_for_status()
            data = response.json()

        return data["message"]["content"]

    async def stream_chat(self, messages: List[ChatMessage]) -> AsyncIterator[str]:
        url = f"{self.base_url}/api/chat"

        payload = {
            "model": self.model,
            "messages": [m.model_dump() for m in messages],
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