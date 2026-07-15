import asyncio
import json
import uuid
from typing import AsyncIterator

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse

from agent.approvals import ApprovalManager, ApprovalResolution
from agent.events import error_event, event, utc_iso_z
from agent.models import AgentError
from agent.runtime import AgentRuntime
from agent.tools import (
    AgentToolContext,
    FilePatchTool,
    FileReadTool,
    RagSearchTool,
    ToolRegistry,
    WorkspaceListTool,
    WorkspaceSearchTool,
)
from config import with_global_ai_config, with_global_knowledge_config
from providers.factory import create_chat_provider

from rag.index_service import build_index as build_knowledge_index, build_index_events, get_index_status
from rag.index_manager import (
    build_managed_index,
    build_managed_index_events,
    build_status_snapshot,
    delete_file_index,
    delete_index_data,
    get_file_chunks,
    reindex_file,
)
from schemas import (
    AIConfig,
    AgentApprovalResolveRequest,
    AgentRunRequest,
    ChatMessage,
    AgentSummarizeRequest,
    IndexRequest,
    IndexBuildRequest,
    IndexStatusRequest,
    RagQueryRequest,
    DEFAULT_AGENT_TOOLS,
)

app = FastAPI(title="Looma RAG Service")
approval_manager = ApprovalManager()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


def ndjson_event(event_type: str, **payload) -> str:
    return json.dumps({"type": event_type, **payload}, ensure_ascii=False) + "\n"


def resolve_request_config(request: RagQueryRequest | IndexRequest | IndexBuildRequest | AgentRunRequest):
    request.ai_config = with_global_ai_config(request.ai_config)
    if hasattr(request, "knowledge"):
        request.knowledge = with_global_knowledge_config(getattr(request, "knowledge"))
    return request



def get_index_status_result(request: IndexStatusRequest):
    ai_config = with_global_ai_config(None)
    knowledge = with_global_knowledge_config()
    if request.vector_store_path:
        knowledge.vector_store_path = request.vector_store_path
    return build_status_snapshot(IndexRequest(
        workspace={"workspace_path": request.workspace_path},
        knowledge=knowledge,
        ai_config=ai_config,
    ))


@app.get("/health")
def health():
    return {
        "status": "ok",
        "service": "looma-rag",
    }


@app.post("/agent/summarize")
async def agent_summarize(request: AgentSummarizeRequest):
    ai_config = with_global_ai_config(None)
    chat_provider = create_chat_provider(ai_config.chat)
    messages = [
        ChatMessage(
            role="system",
            content="你是 Looma Agent 的上下文压缩器。保留用户目标、关键事实、已确认结论、未完成事项、约束和专有名词，不得添加不存在的信息。",
        ),
        *request.messages,
        ChatMessage(
            role="user",
            content=f"请将以上早期上下文压缩为不超过 {request.max_chars} 个中文字符的 Markdown 摘要。",
        ),
    ]
    answer = await chat_provider.chat(messages)
    return {"answer": answer}


async def build_index_result(request: IndexRequest):
    request = resolve_request_config(request)
    require_embedding_config(request)
    return await asyncio.to_thread(build_knowledge_index, request)


@app.post("/rag/index")
async def build_index(request: IndexRequest):
    return await build_index_result(request)


@app.post("/rag/index/status")
def rag_index_status(request: IndexStatusRequest):
    return get_index_status_result(request)


@app.post("/rag/index/build")
async def rag_index_build(request: IndexBuildRequest):
    request = resolve_request_config(request)
    index_request = IndexRequest(workspace=request.workspace, knowledge=request.knowledge, ai_config=request.ai_config)
    return await asyncio.to_thread(build_managed_index, index_request, request.mode)


@app.post("/rag/index/build/stream")
async def rag_index_build_stream(request: IndexBuildRequest):
    request = resolve_request_config(request)
    index_request = IndexRequest(workspace=request.workspace, knowledge=request.knowledge, ai_config=request.ai_config)

    async def ndjson_stream() -> AsyncIterator[str]:
        async for event in build_managed_index_events(index_request, request.mode):
            yield ndjson_event(event.pop("type", "done"), **event)

    return StreamingResponse(
        ndjson_stream(),
        media_type="application/x-ndjson; charset=utf-8",
    )


@app.post("/rag/index/file/chunks")
async def rag_index_file_chunks(request: IndexBuildRequest):
    request = resolve_request_config(request)
    return await asyncio.to_thread(get_file_chunks, request)


@app.post("/rag/index/file/reindex")
async def rag_index_file_reindex(request: IndexBuildRequest):
    request = resolve_request_config(request)
    return await asyncio.to_thread(reindex_file, request)


@app.delete("/rag/index/file")
async def rag_index_file_delete(request: IndexBuildRequest):
    request = resolve_request_config(request)
    return await asyncio.to_thread(delete_file_index, request)


@app.delete("/rag/index")
async def rag_index_delete(request: IndexBuildRequest):
    request = resolve_request_config(request)
    return await asyncio.to_thread(delete_index_data, request)


async def index_events(request: IndexRequest) -> AsyncIterator[str]:
    try:
        request = resolve_request_config(request)
        async for event in build_index_events(request):
            event_type = event.pop("type")
            yield ndjson_event(event_type, **event)
    except HTTPException as e:
        yield ndjson_event("error", stepId="validate-workspace", error=str(e.detail), message=str(e.detail))
    except Exception as e:
        yield ndjson_event("error", stepId="build-vectors", error=str(e), message=str(e))


@app.post("/rag/index/stream")
async def rag_index_stream(request: IndexRequest):
    return StreamingResponse(
        index_events(request),
        media_type="application/x-ndjson; charset=utf-8",
    )


def _agent_ndjson(value: dict) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":")) + "\n"


async def agent_run_events(request: AgentRunRequest) -> AsyncIterator[str]:
    """Build and stream one bounded Agent run without leaking setup exceptions."""

    run_id = f"run_{uuid.uuid4().hex}"
    read_tools = set(DEFAULT_AGENT_TOOLS)
    run_started_sent = False

    try:
        request = resolve_request_config(request)
        if read_tools.intersection(request.agent.enabled_tools) and request.workspace is None:
            yield _agent_ndjson(event("run_started", run_id, startedAt=utc_iso_z()))
            run_started_sent = True
            yield _agent_ndjson(error_event(run_id, AgentError(
                code="workspace_required",
                message="使用工作空间工具时必须选择一个工作空间。",
                technical_detail="workspace is required for enabled read tools",
                retryable=False,
            )))
            return

        provider = create_chat_provider(request.ai_config.chat)
        # Product policy explicitly allows every built-in Agent tool. Write-risk tools
        # still require request.agent.allow_write and always pause for Electron approval.
        registry = ToolRegistry(allowed_tools=DEFAULT_AGENT_TOOLS)
        registry.register(RagSearchTool())
        registry.register(WorkspaceListTool())
        registry.register(WorkspaceSearchTool())
        registry.register(FileReadTool())
        registry.register(FilePatchTool())
        runtime = AgentRuntime(
            provider=provider,
            registry=registry,
            context=AgentToolContext(
                workspace_path=(
                    request.workspace.workspace_path if request.workspace is not None else "."
                ),
                ai_config=request.ai_config,
                knowledge=request.knowledge,
            ),
            approval_manager=approval_manager,
        )
        async for runtime_event in runtime.run(
            input=request.input,
            history=request.history,
            config=request.agent,
            run_id=run_id,
        ):
            line = _agent_ndjson(runtime_event)
            if runtime_event.get("type") == "run_started":
                run_started_sent = True
            yield line
    except asyncio.CancelledError:
        raise
    except Exception as exc:
        if not run_started_sent:
            yield _agent_ndjson(event("run_started", run_id, startedAt=utc_iso_z()))
        yield _agent_ndjson(error_event(run_id, AgentError(
            code="agent_setup_failed",
            message="Agent 初始化失败，请检查模型和工作空间配置后重试。",
            technical_detail=type(exc).__name__,
            retryable=True,
        )))


@app.post("/agent/run/stream")
async def agent_run_stream(request: AgentRunRequest):
    return StreamingResponse(
        agent_run_events(request),
        media_type="application/x-ndjson; charset=utf-8",
    )


@app.post("/agent/approvals/resolve")
async def agent_approval_resolve(request: AgentApprovalResolveRequest):
    try:
        approval = await approval_manager.resolve(
            request.approval_id,
            ApprovalResolution(
                status=request.status,
                reason=request.reason,
                applied=request.applied,
            ),
        )
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="approval not found") from exc
    return {
        "approvalId": approval.approval_id,
        "runId": approval.run_id,
        "status": request.status,
    }
