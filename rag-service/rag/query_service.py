from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any

from rag.index_service import configure_llama_index, get_persist_dir, has_index
from schemas import RagQueryRequest


def _node_to_source(node_with_score: Any) -> dict[str, Any]:
    node = getattr(node_with_score, "node", node_with_score)
    score = getattr(node_with_score, "score", None)
    metadata = dict(getattr(node, "metadata", {}) or {})
    text = ""
    if hasattr(node, "get_content"):
        text = node.get_content(metadata_mode="none")
    elif hasattr(node, "text"):
        text = node.text or ""

    source = metadata.get("source") or metadata.get("file_path") or metadata.get("path") or ""
    return {
        "score": score,
        "text": text,
        "metadata": {
            **metadata,
            "source": source,
        },
    }


def load_index(request: RagQueryRequest):
    from llama_index.core import StorageContext, load_index_from_storage

    if request.ai_config is None or request.ai_config.embedding is None:
        raise ValueError("ai_config.embedding is required for RAG query")

    workspace = Path(request.workspace.workspace_path).expanduser().resolve()
    persist_dir = get_persist_dir(workspace, request.knowledge.vector_store_path)

    if not workspace.exists() or not workspace.is_dir():
        raise ValueError("工作空间不存在或不是文件夹。")
    if not has_index(workspace, request.knowledge.vector_store_path):
        raise FileNotFoundError(f"当前工作空间还没有可用索引：{persist_dir}")

    configure_llama_index(request.ai_config.embedding, request.knowledge.chunk_size, request.knowledge.chunk_overlap)
    storage_context = StorageContext.from_defaults(persist_dir=str(persist_dir))
    return load_index_from_storage(storage_context)


def retrieve_context_sources_sync(request: RagQueryRequest) -> list[dict[str, Any]]:
    index = load_index(request)
    retriever = index.as_retriever(similarity_top_k=request.knowledge.top_k)
    nodes = retriever.retrieve(request.question)
    return [_node_to_source(node) for node in nodes]


async def retrieve_context_sources(request: RagQueryRequest) -> list[dict[str, Any]]:
    # Loading the persisted index and running vector retrieval can do disk IO and
    # sync embedding calls, so keep it off the FastAPI event loop.
    return await asyncio.to_thread(retrieve_context_sources_sync, request)
