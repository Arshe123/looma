from __future__ import annotations

from collections.abc import Awaitable, Callable
from pathlib import PurePosixPath, PureWindowsPath
from typing import Any

from pydantic import Field

from agent.tools.base import AgentTool, AgentToolContext, StrictToolArgs
from rag.index_manager import CorruptIndexError
from rag.query_service import IndexMissingError, retrieve_context_sources
from schemas import KnowledgeConfig, RagQueryRequest, WorkspaceContext


class RagSearchArgs(StrictToolArgs):
    query: str = Field(..., min_length=1)
    top_k: int | None = Field(default=None, ge=1, le=50)


Retriever = Callable[[RagQueryRequest], Awaitable[list[dict[str, Any]]]]


def _copy_knowledge(config: KnowledgeConfig, top_k: int | None) -> KnowledgeConfig:
    update = {} if top_k is None else {"top_k": top_k}
    model_copy = getattr(config, "model_copy", None)
    if model_copy is not None:
        return model_copy(update=update, deep=True)
    return config.copy(update=update, deep=True)


def _absolute_path_style(value: str) -> str | None:
    if PureWindowsPath(value).is_absolute():
        return "windows"
    if PurePosixPath(value).is_absolute() and "\\" not in value:
        return "posix"
    return None


def _normalized_source(value: Any, workspace: Any) -> str | None:
    if not isinstance(value, (str, PurePosixPath, PureWindowsPath)):
        return None
    raw = str(value)
    if not raw:
        return None

    segments = raw.replace("\\", "/").split("/")
    if any(segment in {".", ".."} for segment in segments):
        return None

    windows_candidate = PureWindowsPath(raw)
    posix_candidate = PurePosixPath(raw)
    candidate_style = _absolute_path_style(raw)
    if candidate_style is None:
        if windows_candidate.drive or windows_candidate.root or posix_candidate.root:
            return None
        return PurePosixPath(raw.replace("\\", "/")).as_posix()

    workspace_raw = str(workspace)
    if _absolute_path_style(workspace_raw) != candidate_style:
        return None

    path_type = PureWindowsPath if candidate_style == "windows" else PurePosixPath
    candidate = path_type(raw)
    workspace_path = path_type(workspace_raw)
    try:
        relative = candidate.relative_to(workspace_path)
    except ValueError:
        return None
    if not relative.parts:
        return None
    return relative.as_posix()


def _normalize_result_source(item: dict[str, Any], workspace: Any) -> dict[str, Any]:
    metadata = dict(item.get("metadata") or {})
    source = None
    for key in ("source", "path", "file_path"):
        source = _normalized_source(metadata.get(key), workspace)
        if source is not None:
            break
    if source is not None:
        metadata["source"] = source
        metadata["path"] = source
        metadata["file_path"] = source
    else:
        metadata.pop("source", None)
        metadata.pop("path", None)
        metadata.pop("file_path", None)
    return {
        "score": item.get("score"),
        "text": item.get("text", ""),
        "metadata": metadata,
    }


class RagSearchTool(AgentTool):
    name = "rag_search"
    description = "Search the current workspace knowledge index for relevant context."
    risk_level = "read"
    args_model = RagSearchArgs

    def __init__(self, *, retriever: Retriever = retrieve_context_sources) -> None:
        self._retriever = retriever

    async def execute(self, context: AgentToolContext, args: StrictToolArgs) -> dict[str, Any]:
        if not isinstance(args, RagSearchArgs):
            raise TypeError("args must be RagSearchArgs")

        empty = {"query": args.query, "count": 0, "sources": []}
        if (
            context.knowledge is None
            or context.ai_config is None
            or context.ai_config.embedding is None
        ):
            return {
                "status": "config_missing",
                **empty,
                "message": "RAG 搜索需要知识库和嵌入模型配置。",
            }

        knowledge = _copy_knowledge(context.knowledge, args.top_k)
        request = RagQueryRequest(
            question=args.query,
            workspace=WorkspaceContext(workspace_path=str(context.workspace_path)),
            knowledge=knowledge,
            ai_config=context.ai_config,
        )

        try:
            raw_sources = await self._retriever(request)
        except IndexMissingError:
            return {
                "status": "index_missing",
                **empty,
                "message": "当前工作空间尚无可用索引，请先构建索引。",
            }
        except CorruptIndexError:
            return {
                "status": "corrupt_index",
                **empty,
                "requiresRebuild": True,
                "message": "本地索引已损坏，请在索引库执行全量重建。",
            }

        sources = [
            _normalize_result_source(source, context.workspace_path)
            for source in raw_sources
        ]
        return {
            "status": "ok" if sources else "no_results",
            "query": args.query,
            "count": len(sources),
            "sources": sources,
        }
