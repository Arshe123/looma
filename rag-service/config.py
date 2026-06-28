from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

from schemas import AIConfig, ChatModelConfig, EmbeddingModelConfig, KnowledgeConfig

DEFAULT_OLLAMA_BASE_URL = "http://127.0.0.1:11434"


def _settings_path_candidates() -> list[Path]:
    explicit = os.environ.get("LOOMA_SETTINGS_PATH") or os.environ.get("APP_SETTINGS_PATH")
    candidates: list[Path] = []
    if explicit:
        candidates.append(Path(explicit).expanduser())

    appdata = os.environ.get("APPDATA")
    if appdata:
        candidates.append(Path(appdata) / "workspace-meta" / "looma" / "settings.json")

    home = Path.home()
    candidates.append(home / "AppData" / "Roaming" / "workspace-meta" / "looma" / "settings.json")
    candidates.append(home / ".config" / "looma" / "settings.json")
    return candidates


def get_settings_path() -> Path:
    for candidate in _settings_path_candidates():
        if candidate.is_file():
            return candidate
    return _settings_path_candidates()[0]


def read_app_settings() -> dict[str, Any]:
    path = get_settings_path()
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {}
    except json.JSONDecodeError as exc:
        raise ValueError(f"全局 AI 设置文件格式不正确：{path} ({exc})") from exc


def _record(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _string(value: Any, fallback: str = "") -> str:
    return value.strip() if isinstance(value, str) and value.strip() else fallback


def _optional_string(value: Any, fallback: str | None = None) -> str | None:
    if isinstance(value, str):
        return value.strip()
    return fallback


def _number(value: Any, fallback: float | int | None = None):
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return value
    if isinstance(value, str) and value.strip():
        try:
            parsed = float(value)
            return int(parsed) if parsed.is_integer() else parsed
        except ValueError:
            return fallback
    return fallback


def _provider(value: Any, fallback: str = "ollama") -> str:
    allowed = {"ollama", "openai", "openai-compatible", "deepseek", "qwen", "custom"}
    return value if value in allowed else fallback


def _chunking_strategy(value: Any, fallback: str = "fixed") -> str:
    allowed = {"fixed", "markdown", "semantic", "parent_child", "code_aware"}
    return value if value in allowed else fallback


def default_ai_config() -> AIConfig:
    return AIConfig(
        chat=ChatModelConfig(
            provider="ollama",
            model="qwen2.5:7b",
            base_url=DEFAULT_OLLAMA_BASE_URL,
            api_key="",
            temperature=0.7,
        ),
        embedding=EmbeddingModelConfig(
            provider="ollama",
            model="bge-m3:latest",
            base_url=DEFAULT_OLLAMA_BASE_URL,
            api_key="",
        ),
    )


def default_knowledge_config() -> KnowledgeConfig:
    return KnowledgeConfig()


def load_global_ai_config() -> AIConfig:
    settings = read_app_settings()
    ai = _record(settings.get("ai"))
    defaults = default_ai_config()

    chat = _record(ai.get("chat"))
    embedding = _record(ai.get("embedding"))

    chat_provider = _provider(chat.get("provider"), defaults.chat.provider)
    embedding_provider = _provider(embedding.get("provider"), defaults.embedding.provider if defaults.embedding else "ollama")

    return AIConfig(
        chat=ChatModelConfig(
            provider=chat_provider,
            model=_string(chat.get("model"), defaults.chat.model),
            base_url=_optional_string(chat.get("baseUrl") or chat.get("base_url"), defaults.chat.base_url),
            api_key=_optional_string(chat.get("apiKey") or chat.get("api_key"), defaults.chat.api_key),
            temperature=_number(chat.get("temperature"), defaults.chat.temperature),
            max_tokens=_number(chat.get("maxTokens") or chat.get("max_tokens"), defaults.chat.max_tokens),
        ),
        embedding=EmbeddingModelConfig(
            provider=embedding_provider,
            model=_string(embedding.get("model"), defaults.embedding.model if defaults.embedding else "bge-m3:latest"),
            base_url=_optional_string(embedding.get("baseUrl") or embedding.get("base_url"), defaults.embedding.base_url if defaults.embedding else DEFAULT_OLLAMA_BASE_URL),
            api_key=_optional_string(embedding.get("apiKey") or embedding.get("api_key"), defaults.embedding.api_key if defaults.embedding else ""),
            dimension=_number(embedding.get("dimension"), defaults.embedding.dimension if defaults.embedding else None),
        ),
    )


def load_global_knowledge_config() -> KnowledgeConfig:
    settings = read_app_settings()
    ai = _record(settings.get("ai"))
    defaults = default_knowledge_config()
    return KnowledgeConfig(
        vector_store_path=_string(ai.get("vectorStorePath") or ai.get("vector_store_path"), defaults.vector_store_path),
        top_k=int(_number(ai.get("topK") or ai.get("top_k"), defaults.top_k)),
        include_sources=bool(ai.get("enableSourceCitation")) if isinstance(ai.get("enableSourceCitation"), bool) else defaults.include_sources,
        rerank=bool(ai.get("rerank")) if isinstance(ai.get("rerank"), bool) else defaults.rerank,
        chunk_size=int(_number(ai.get("chunkSize") or ai.get("chunk_size"), defaults.chunk_size)),
        chunk_overlap=int(_number(ai.get("chunkOverlap") or ai.get("chunk_overlap"), defaults.chunk_overlap)),
        chunking_strategy=_chunking_strategy(ai.get("chunkingStrategy") or ai.get("chunking_strategy"), defaults.chunking_strategy),
    )


def with_global_ai_config(request_ai_config: AIConfig | None) -> AIConfig:
    return request_ai_config or load_global_ai_config()


def with_global_knowledge_config(request_knowledge: KnowledgeConfig | None = None) -> KnowledgeConfig:
    global_config = load_global_knowledge_config()
    if request_knowledge is None:
        return global_config
    dump = lambda model: model.model_dump() if hasattr(model, "model_dump") else model.dict()
    data = dump(request_knowledge)
    # Requests may override per-workspace values when explicitly provided, but the
    # common Electron path now omits them so the backend reads settings.json directly.
    return KnowledgeConfig(**{**dump(global_config), **data})
