from abc import ABC, abstractmethod
from typing import AsyncIterator, List

from schemas import ChatMessage


class BaseChatProvider(ABC):
    @abstractmethod
    async def chat(self, messages: List[ChatMessage]) -> str:
        pass

    @abstractmethod
    async def stream_chat(self, messages: List[ChatMessage]) -> AsyncIterator[str]:
        pass


class BaseEmbeddingProvider(ABC):
    @abstractmethod
    async def embed_text(self, text: str) -> List[float]:
        pass

    @abstractmethod
    async def embed_documents(self, texts: List[str]) -> List[List[float]]:
        pass
