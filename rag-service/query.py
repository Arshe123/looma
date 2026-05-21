from pathlib import Path
import json

from llama_index.core import (
    StorageContext,
    load_index_from_storage,
    Settings,
)
from llama_index.llms.ollama import Ollama
from llama_index.embeddings.ollama import OllamaEmbedding

from config import (
    OLLAMA_BASE_URL,
    LLM_MODEL,
    EMBED_MODEL,
)
from indexer import get_persist_dir, has_index


def init_settings():
    Settings.llm = Ollama(
        model=LLM_MODEL,
        base_url=OLLAMA_BASE_URL,
        request_timeout=120.0,
    )

    Settings.embed_model = OllamaEmbedding(
        model_name=EMBED_MODEL,
        base_url=OLLAMA_BASE_URL,
    )


def ask(workspace_path: str, question: str):
    init_settings()

    notes_dir = Path(workspace_path).expanduser().resolve()
    if not notes_dir.exists() or not notes_dir.is_dir():
        return {
            "answer": "工作空间不存在或不是文件夹。",
            "sources": [],
        }

    persist_dir = get_persist_dir(str(notes_dir))
    if not has_index(str(notes_dir)):
        return {
            "answer": "当前还没有建立索引，请先索引笔记。",
            "sources": [],
        }

    storage_context = StorageContext.from_defaults(
        persist_dir=str(persist_dir)
    )

    index = load_index_from_storage(storage_context)

    query_engine = index.as_query_engine(
        similarity_top_k=5,
    )

    response = query_engine.query(question)

    sources = []

    for source_node in response.source_nodes:
        node = source_node.node

        sources.append({
            "score": float(source_node.score) if source_node.score else None,
            "text": node.get_text()[:500],
            "metadata": node.metadata,
        })

    return {
        "answer": str(response),
        "sources": sources,
    }


def format_sources(source_nodes):
    sources = []

    for source_node in source_nodes:
        node = source_node.node
        sources.append({
            "score": float(source_node.score) if source_node.score else None,
            "text": node.get_text()[:500],
            "metadata": node.metadata,
        })

    return sources


def stream_event(event_type: str, **payload):
    return json.dumps(
        {
            "type": event_type,
            **payload,
        },
        ensure_ascii=False,
    ) + "\n"


def ask_stream(workspace_path: str, question: str):
    try:
        init_settings()

        notes_dir = Path(workspace_path).expanduser().resolve()
        if not notes_dir.exists() or not notes_dir.is_dir():
            yield stream_event("error", error="工作空间不存在或不是文件夹。")
            return

        persist_dir = get_persist_dir(str(notes_dir))
        if not has_index(str(notes_dir)):
            yield stream_event("error", error="当前还没有建立索引，请先索引笔记。")
            return

        storage_context = StorageContext.from_defaults(
            persist_dir=str(persist_dir)
        )

        index = load_index_from_storage(storage_context)

        retriever = index.as_retriever(similarity_top_k=5)
        nodes = retriever.retrieve(question)

        context = "\n\n".join(
            node.node.get_content()
            for node in nodes
        )

        prompt = f"""
        你是一个笔记助手。请根据下面资料回答用户问题。

        资料：
        {context}

        用户问题：
        {question}
        """

        for r in Settings.llm.stream_complete(prompt):
            delta = getattr(r, "delta", None)
            if delta:
                yield stream_event("delta", text=delta)

        sources = []
        for node in nodes:
            sources.append({
                "score": node.score,
                "text": node.node.get_content(),
                "metadata": node.node.metadata,
            })

        yield stream_event("sources", sources=sources)
        yield stream_event("done")
    except Exception as exc:
        yield stream_event("error", error=str(exc))
