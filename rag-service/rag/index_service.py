from __future__ import annotations

import asyncio
import hashlib
import threading
from pathlib import Path
from typing import Any, AsyncIterator, Iterable

from pydantic import PrivateAttr

from providers.factory import create_embedding_provider
from schemas import EmbeddingModelConfig, IndexRequest

SUPPORTED_EXTENSIONS = {".md", ".txt", ".pdf"}
REQUIRED_INDEX_FILES = {
    "index_store.json",
    "docstore.json",
    "default__vector_store.json",
}


def run_coroutine_blocking(coro):
    """Run an async provider call from sync llama-index embedding hooks.

    llama-index still calls sync embedding methods in several paths. FastAPI handlers
    already run in an event loop, so asyncio.run() alone would fail. In that case,
    execute the coroutine in a short-lived thread with its own loop.
    """
    try:
        asyncio.get_running_loop()
    except RuntimeError:
        return asyncio.run(coro)

    result: dict[str, Any] = {}

    def runner():
        try:
            result["value"] = asyncio.run(coro)
        except BaseException as exc:  # noqa: BLE001 - propagate original failure
            result["error"] = exc

    thread = threading.Thread(target=runner, daemon=True)
    thread.start()
    thread.join()
    if "error" in result:
        raise result["error"]
    return result.get("value")


def get_workspace_path(request: IndexRequest) -> Path:
    return Path(request.workspace.workspace_path).expanduser().resolve()


def get_persist_dir(workspace_path: str | Path, vector_store_path: str) -> Path:
    workspace = Path(workspace_path).expanduser().resolve()
    raw_vector_path = Path((vector_store_path or ".looma/rag-index").strip())
    if raw_vector_path.is_absolute():
        raise ValueError("向量存储路径必须是相对于工作空间的路径。")
    persist_dir = (workspace / raw_vector_path).resolve()
    try:
        persist_dir.relative_to(workspace)
    except ValueError as exc:
        raise ValueError("向量存储路径不能指向工作空间外。") from exc
    return persist_dir


def has_index(workspace_path: str | Path, vector_store_path: str) -> bool:
    try:
        persist_dir = get_persist_dir(workspace_path, vector_store_path)
    except ValueError:
        return False
    return persist_dir.is_dir() and all((persist_dir / filename).is_file() for filename in REQUIRED_INDEX_FILES)


def get_index_status(workspace_path: str, vector_store_path: str) -> dict[str, Any]:
    workspace = Path(workspace_path).expanduser().resolve()
    try:
        persist_dir = get_persist_dir(workspace, vector_store_path)
    except ValueError as exc:
        return {"exists": False, "error": str(exc)}
    if not workspace.exists() or not workspace.is_dir():
        return {
            "exists": False,
            "persist_dir": str(persist_dir),
            "error": "工作空间不存在或不是文件夹。",
        }
    return {
        "exists": has_index(workspace, vector_store_path),
        "persist_dir": str(persist_dir),
    }


def collect_indexable_files(workspace_path: str | Path) -> list[Path]:
    workspace = Path(workspace_path).expanduser().resolve()
    files: list[Path] = []
    for path in workspace.rglob("*"):
        if not path.is_file() or path.suffix.lower() not in SUPPORTED_EXTENSIONS:
            continue
        try:
            relative = path.relative_to(workspace)
        except ValueError:
            continue
        if ".looma" in relative.parts:
            continue
        files.append(path)
    return sorted(files, key=lambda item: str(item).lower())


def make_embedding_model(config: EmbeddingModelConfig):
    from llama_index.core.embeddings import BaseEmbedding

    class ProviderEmbedding(BaseEmbedding):
        _provider: Any = PrivateAttr()
        _model_name: str = PrivateAttr()

        def __init__(self, embedding_config: EmbeddingModelConfig):
            super().__init__(model_name=embedding_config.model)
            self._provider = create_embedding_provider(embedding_config)
            self._model_name = embedding_config.model

        @classmethod
        def class_name(cls) -> str:
            return "LoomaProviderEmbedding"

        def _get_query_embedding(self, query: str) -> list[float]:
            return run_coroutine_blocking(self._provider.embed_text(query))

        async def _aget_query_embedding(self, query: str) -> list[float]:
            return await self._provider.embed_text(query)

        def _get_text_embedding(self, text: str) -> list[float]:
            return run_coroutine_blocking(self._provider.embed_text(text))

        async def _aget_text_embedding(self, text: str) -> list[float]:
            return await self._provider.embed_text(text)

        def _get_text_embeddings(self, texts: list[str]) -> list[list[float]]:
            return run_coroutine_blocking(self._provider.embed_documents(texts))

        async def _aget_text_embeddings(self, texts: list[str]) -> list[list[float]]:
            return await self._provider.embed_documents(texts)

    return ProviderEmbedding(config)


def file_doc_id(workspace_path: Path, relative: str) -> str:
    """Stable per-file doc_id used as ref_doc_id for all chunks of a file."""
    raw = f"{workspace_path}|{relative}"
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def load_documents(input_files: Iterable[Path], workspace_path: Path):
    from llama_index.core import Document, SimpleDirectoryReader

    documents = []
    for file_path in input_files:
        relative = str(file_path.resolve().relative_to(workspace_path))
        suffix = file_path.suffix.lower()
        metadata = {
            "source": relative,
            "file_path": str(file_path),
            "path": relative,
            "extension": suffix,
        }
        if suffix in {".md", ".txt"}:
            text = file_path.read_text(encoding="utf-8", errors="ignore")
            if text.strip():
                doc_id = file_doc_id(workspace_path, relative)
                documents.append(Document(text=text, metadata=metadata, doc_id=doc_id))
            continue

        # Let llama-index handle PDFs and any parser-specific metadata.
        loaded = SimpleDirectoryReader(input_files=[str(file_path)]).load_data()
        for document in loaded:
            document.metadata = {**metadata, **getattr(document, "metadata", {})}
            documents.append(document)
    return documents


def configure_llama_index(embedding_config: EmbeddingModelConfig, chunk_size: int = 800, chunk_overlap: int = 100):
    from llama_index.core import Settings
    from llama_index.core.node_parser import SentenceSplitter

    Settings.embed_model = make_embedding_model(embedding_config)
    Settings.node_parser = SentenceSplitter(chunk_size=chunk_size, chunk_overlap=chunk_overlap)
    # Avoid llama-index trying to instantiate its own default LLM during indexing.
    Settings.llm = None


def build_index(request: IndexRequest) -> dict[str, Any]:
    from llama_index.core import VectorStoreIndex

    if request.ai_config is None or request.ai_config.embedding is None:
        raise ValueError("ai_config.embedding is required for index building")

    workspace = get_workspace_path(request)
    persist_dir = get_persist_dir(workspace, request.knowledge.vector_store_path)
    if not workspace.exists() or not workspace.is_dir():
        raise ValueError("工作空间不存在或不是文件夹。")

    input_files = collect_indexable_files(workspace)
    if not input_files:
        return {
            "success": True,
            "status": "ok",
            "document_count": 0,
            "exists": False,
            "persist_dir": str(persist_dir),
        }

    configure_llama_index(request.ai_config.embedding, request.knowledge.chunk_size, request.knowledge.chunk_overlap)
    documents = load_documents(input_files, workspace)
    if not documents:
        return {
            "success": True,
            "status": "ok",
            "document_count": 0,
            "exists": False,
            "persist_dir": str(persist_dir),
        }

    index = VectorStoreIndex.from_documents(documents)
    persist_dir.mkdir(parents=True, exist_ok=True)
    index.storage_context.persist(persist_dir=str(persist_dir))

    return {
        "success": True,
        "status": "ok",
        "document_count": len(documents),
        "file_count": len(input_files),
        "exists": has_index(workspace, request.knowledge.vector_store_path),
        "persist_dir": str(persist_dir),
        "embedding_model": request.ai_config.embedding.model,
        "embedding_provider": request.ai_config.embedding.provider,
        "chunk_size": request.knowledge.chunk_size,
        "chunk_overlap": request.knowledge.chunk_overlap,
    }


async def build_index_events(request: IndexRequest) -> AsyncIterator[dict[str, Any]]:
    workspace = get_workspace_path(request)
    persist_dir = get_persist_dir(workspace, request.knowledge.vector_store_path)

    yield {
        "type": "timeline",
        "stepId": "validate-workspace",
        "status": "active",
        "title": "检查工作空间",
        "detail": "正在确认工作空间和索引目录。",
    }
    if not workspace.exists() or not workspace.is_dir():
        raise ValueError("工作空间不存在或不是文件夹。")
    if request.ai_config is None or request.ai_config.embedding is None:
        raise ValueError("ai_config.embedding is required for index building")
    yield {"type": "timeline", "stepId": "validate-workspace", "status": "completed", "detail": "工作空间可用。"}

    yield {"type": "timeline", "stepId": "scan-files", "status": "active", "title": "扫描文件", "detail": "正在查找 Markdown、文本和 PDF 文件。"}
    input_files = collect_indexable_files(workspace)
    yield {
        "type": "timeline",
        "stepId": "scan-files",
        "status": "completed",
        "detail": f"找到 {len(input_files)} 个可索引文件。",
        "outputs": [{"type": "metric", "title": "可索引文件", "value": len(input_files), "unit": "个"}],
    }
    if not input_files:
        yield {"type": "done", "result": {"status": "ok", "document_count": 0, "exists": False, "persist_dir": str(persist_dir)}}
        return

    configure_llama_index(request.ai_config.embedding, request.knowledge.chunk_size, request.knowledge.chunk_overlap)
    yield {"type": "timeline", "stepId": "load-documents", "status": "active", "title": "读取文档", "detail": "正在读取文件内容。"}
    documents = []
    for index, file_path in enumerate(input_files, start=1):
        relative = str(file_path.resolve().relative_to(workspace))
        yield {"type": "progress", "stepId": "load-documents", "current": index, "total": len(input_files), "message": f"正在读取：{relative}"}
        documents.extend(load_documents([file_path], workspace))
    yield {
        "type": "timeline",
        "stepId": "load-documents",
        "status": "completed",
        "detail": f"已读取 {len(input_files)} 个文件，生成 {len(documents)} 个文档。",
        "outputs": [
            {"type": "metric", "title": "文件数量", "value": len(input_files), "unit": "个"},
            {"type": "metric", "title": "文档数量", "value": len(documents), "unit": "个"},
        ],
    }
    if not documents:
        yield {"type": "done", "result": {"status": "ok", "document_count": 0, "exists": False, "persist_dir": str(persist_dir)}}
        return

    from llama_index.core import VectorStoreIndex

    yield {"type": "timeline", "stepId": "build-vectors", "status": "active", "title": "构建向量", "detail": f"正在为 {len(documents)} 个文档生成向量索引。"}
    index = VectorStoreIndex.from_documents(documents)
    yield {"type": "timeline", "stepId": "build-vectors", "status": "completed", "detail": "向量索引已构建完成。"}

    yield {"type": "timeline", "stepId": "persist-index", "status": "active", "title": "写入索引", "detail": "正在写入索引文件。"}
    persist_dir.mkdir(parents=True, exist_ok=True)
    index.storage_context.persist(persist_dir=str(persist_dir))
    yield {
        "type": "timeline",
        "stepId": "persist-index",
        "status": "completed",
        "detail": "索引文件已写入。",
        "outputs": [{"type": "source", "title": "索引目录", "path": str(persist_dir)}],
    }

    exists = has_index(workspace, request.knowledge.vector_store_path)
    result = {
        "status": "ok",
        "document_count": len(documents),
        "file_count": len(input_files),
        "exists": exists,
        "persist_dir": str(persist_dir),
        "embedding_model": request.ai_config.embedding.model,
        "embedding_provider": request.ai_config.embedding.provider,
        "chunk_size": request.knowledge.chunk_size,
        "chunk_overlap": request.knowledge.chunk_overlap,
    }
    yield {"type": "timeline", "stepId": "verify-index", "status": "completed", "title": "验证索引", "detail": "索引文件验证完成。"}
    yield {"type": "done", "result": result, **result}
