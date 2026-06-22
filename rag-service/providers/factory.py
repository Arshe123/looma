from schemas import ChatModelConfig, EmbeddingModelConfig
from providers.base import BaseChatProvider, BaseEmbeddingProvider
from providers.ollama_provider import OllamaChatProvider, OllamaEmbeddingProvider
from providers.openai_provider import OpenAIChatProvider, OpenAIEmbeddingProvider
from providers.openai_compatible_provider import (
    OpenAICompatibleChatProvider,
    OpenAICompatibleEmbeddingProvider,
)


OPENAI_COMPATIBLE_PROVIDERS = {
    "deepseek",
    "qwen",
    "openai-compatible",
    "custom",
}


def create_chat_provider(config: ChatModelConfig) -> BaseChatProvider:
    if config.provider == "ollama":
        return OllamaChatProvider(config)

    if config.provider == "openai":
        return OpenAIChatProvider(config)

    if config.provider in OPENAI_COMPATIBLE_PROVIDERS:
        return OpenAICompatibleChatProvider(config)

    raise ValueError(f"Unsupported chat provider: {config.provider}")


def create_embedding_provider(config: EmbeddingModelConfig) -> BaseEmbeddingProvider:
    if config.provider == "ollama":
        return OllamaEmbeddingProvider(config)

    if config.provider == "openai":
        return OpenAIEmbeddingProvider(config)

    if config.provider in OPENAI_COMPATIBLE_PROVIDERS:
        return OpenAICompatibleEmbeddingProvider(config)

    raise ValueError(f"Unsupported embedding provider: {config.provider}")