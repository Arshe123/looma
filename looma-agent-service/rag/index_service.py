from __future__ import annotations

import asyncio
import hashlib
import os
import re
import stat
import threading
from pathlib import Path
from typing import TYPE_CHECKING, Any, Iterable

from pydantic import PrivateAttr

from providers.factory import create_embedding_provider
from schemas import EmbeddingModelConfig, IndexRequest, KnowledgeConfig

if TYPE_CHECKING:
    from llama_index.core.schema import TransformComponent

SUPPORTED_EXTENSIONS = {".md", ".txt", ".pdf"}
EXCLUDE_PARTS = {".git", "node_modules", "dist", "build", ".looma"}
REQUIRED_INDEX_FILES = {
    "index_store.json",
    "docstore.json",
    "default__vector_store.json",
}
SENTENCE_BOUNDARY_PATTERN = re.compile(
    r'[。！？!?]+[”’"\'）】》]*[ \t]*|'
    r'\.[”’"\'）】》]*(?:[ \t]+|(?=\r?\n|$))|'
    r'\r?\n+'
)


def split_sentences(text: str) -> list[str]:
    """Split Chinese and English sentences without LlamaIndex's optional NLTK dependency."""
    if not text:
        return []

    sentences: list[str] = []
    start = 0
    for match in SENTENCE_BOUNDARY_PATTERN.finditer(text):
        end = match.end()
        if end > start:
            sentences.append(text[start:end])
        start = end
    if start < len(text):
        sentences.append(text[start:])
    return sentences


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


def _is_link_or_reparse(path: Path) -> bool:
    info = path.lstat()
    return stat.S_ISLNK(info.st_mode) or bool(
        getattr(info, "st_file_attributes", 0) & getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0)
    )


def is_indexable_file(path: Path, workspace: Path) -> bool:
    try:
        relative = path.relative_to(workspace)
        if any(part.casefold() in EXCLUDE_PARTS or part == ".." for part in relative.parts):
            return False
        if path.suffix.lower() not in SUPPORTED_EXTENSIONS:
            return False
        current = workspace
        for part in relative.parts:
            current = current / part
            if _is_link_or_reparse(current):
                return False
        return path.is_file() and path.resolve().is_relative_to(workspace)
    except (OSError, ValueError):
        return False


def scan_indexable_files(workspace: Path) -> tuple[list[Path], list[Path]]:
    workspace = workspace.expanduser().resolve()
    accepted: list[Path] = []
    ignored: list[Path] = []
    for directory, dirs, filenames in os.walk(workspace, followlinks=False):
        for name in list(dirs):
            path = Path(directory) / name
            if _is_link_or_reparse(path):
                dirs.remove(name)
                ignored.append(path)
        for name in filenames:
            path = Path(directory) / name
            (accepted if is_indexable_file(path, workspace) else ignored).append(path)
    key = lambda path: (str(path).casefold(), str(path))
    return sorted(accepted, key=key), sorted(ignored, key=key)


def collect_indexable_files(workspace_path: str | Path) -> list[Path]:
    return scan_indexable_files(Path(workspace_path))[0]


def make_embedding_model(config: EmbeddingModelConfig):
    from llama_index.core.embeddings import BaseEmbedding

    class ProviderEmbedding(BaseEmbedding):
        _provider: Any = PrivateAttr()

        def __init__(self, embedding_config: EmbeddingModelConfig):
            super().__init__(model_name=embedding_config.model)
            self._provider = create_embedding_provider(embedding_config)

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
        relative = str(file_path.resolve().relative_to(workspace_path)).replace("\\", "/")
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
        doc_id = file_doc_id(workspace_path, relative)
        for page_index, document in enumerate(loaded):
            document.metadata = {**getattr(document, "metadata", {}), **metadata}
            # Parsers key original documents by ID. Shared IDs overwrite earlier
            # pages' metadata; keep page IDs distinct and match files by source.
            document.doc_id = f"{doc_id}:page:{page_index}"
            documents.append(document)
    return documents


def make_node_transformations(knowledge: KnowledgeConfig) -> list[TransformComponent]:
    from llama_index.core.node_parser import MarkdownNodeParser, SentenceSplitter

    sentence_splitter = SentenceSplitter(
        chunk_size=knowledge.chunk_size,
        chunk_overlap=knowledge.chunk_overlap,
        # SentenceSplitter defaults to NLTK. NLTK is intentionally excluded
        # from the frozen service because its PyInstaller hook scans external
        # data directories; use Looma's deterministic built-in splitter instead.
        chunking_tokenizer_fn=split_sentences,
    )
    if knowledge.chunking_strategy == "markdown":
        return [
            MarkdownNodeParser.from_defaults(include_metadata=True, include_prev_next_rel=True),
            sentence_splitter,
        ]
    return [sentence_splitter]


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

    embedding = make_embedding_model(request.ai_config.embedding)
    transformations = make_node_transformations(request.knowledge or KnowledgeConfig())
    documents = load_documents(input_files, workspace)
    if not documents:
        return {
            "success": True,
            "status": "ok",
            "document_count": 0,
            "exists": False,
            "persist_dir": str(persist_dir),
        }

    index = VectorStoreIndex.from_documents(documents, embed_model=embedding, transformations=transformations)
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
        "chunking_strategy": request.knowledge.chunking_strategy,
    }
