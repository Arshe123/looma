import asyncio
import json
from typing import AsyncIterator

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse

from config import with_global_ai_config, with_global_knowledge_config
from providers.factory import create_chat_provider
from prompt.main import BASE_SYSTEM_PROMPT, build_rag_context_prompt
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
from rag.query_service import retrieve_context_sources
from schemas import (
    AgentRunRequest,
    ChatMessage,
    ChatRequest,
    IndexRequest,
    IndexBuildRequest,
    IndexStatusRequest,
    RagQueryRequest,
)

app = FastAPI(title="Looma RAG Service")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


def ndjson_event(event_type: str, **payload) -> str:
    return json.dumps({"type": event_type, **payload}, ensure_ascii=False) + "\n"


def resolve_request_config(request: ChatRequest | RagQueryRequest | IndexRequest | IndexBuildRequest | AgentRunRequest):
    request.ai_config = with_global_ai_config(request.ai_config)
    if hasattr(request, "knowledge"):
        request.knowledge = with_global_knowledge_config(getattr(request, "knowledge"))
    return request


def build_chat_messages(request: ChatRequest) -> list[ChatMessage]:
    request = resolve_request_config(request)
    return [
        ChatMessage(role="system", content=BASE_SYSTEM_PROMPT),
        *request.history,
        ChatMessage(role="user", content=request.question),
    ]


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


@app.post("/chat")
async def chat(request: ChatRequest):
    request = resolve_request_config(request)
    chat_provider = create_chat_provider(request.ai_config.chat)
    answer = await chat_provider.chat(build_chat_messages(request))
    return {"answer": answer}


@app.post("/chat/stream")
async def stream_chat(request: ChatRequest):
    request = resolve_request_config(request)
    chat_provider = create_chat_provider(request.ai_config.chat)
    messages = build_chat_messages(request)

    async def generate() -> AsyncIterator[str]:
        try:
            async for chunk in chat_provider.stream_chat(messages):
                yield ndjson_event("delta", text=chunk, content=chunk)
            yield ndjson_event("done")
        except Exception as e:
            yield ndjson_event("error", error=str(e), message=str(e))

    return StreamingResponse(generate(), media_type="application/x-ndjson; charset=utf-8")


async def rag_query_events(request: RagQueryRequest) -> AsyncIterator[str]:
    try:
        request = resolve_request_config(request)
        yield ndjson_event(
            "timeline",
            stepId="validate-workspace",
            status="completed",
            title="检查工作空间",
            detail="请求参数已验证。",
        )

        chat_provider = create_chat_provider(request.ai_config.chat)

        yield ndjson_event(
            "timeline",
            stepId="retrieve-context",
            status="active",
            title="检索上下文",
            detail="正在加载本地 LlamaIndex 索引并检索相关笔记。",
        )
        sources = await retrieve_context_sources(request)
        yield ndjson_event("sources", sources=sources)
        yield ndjson_event(
            "timeline",
            stepId="retrieve-context",
            status="completed",
            title="检索上下文",
            detail=f"命中 {len(sources)} 个相关片段。",
            outputs=[{"type": "metric", "title": "命中片段", "value": len(sources), "unit": "个"}],
        )

        context_prompt = build_rag_context_prompt(sources)
        messages = [
            ChatMessage(role="system", content=BASE_SYSTEM_PROMPT),
            *request.history,
            ChatMessage(role="system", content=context_prompt),
            ChatMessage(role="user", content=request.question),
        ]

        yield ndjson_event(
            "timeline",
            stepId="compose-answer",
            status="active",
            title="生成回复",
            detail="正在流式生成最终回答。",
        )
        async for chunk in chat_provider.stream_chat(messages):
            yield ndjson_event("delta", text=chunk, content=chunk)
        yield ndjson_event(
            "timeline",
            stepId="compose-answer",
            status="completed",
            title="生成回复",
            detail="最终回复已生成。",
        )
        yield ndjson_event("done")
    except HTTPException as e:
        yield ndjson_event("error", stepId="validate-workspace", error=str(e.detail), message=str(e.detail))
    except Exception as e:
        yield ndjson_event("error", stepId="compose-answer", error=str(e), message=str(e))


async def rag_answer_result(request: RagQueryRequest):
    request = resolve_request_config(request)
    chat_provider = create_chat_provider(request.ai_config.chat)
    require_embedding_config(request)
    sources = await retrieve_context_sources(request)
    context_prompt = build_rag_context_prompt(sources)
    messages = [
        ChatMessage(role="system", content=BASE_SYSTEM_PROMPT),
        *request.history,
        ChatMessage(role="system", content=context_prompt),
        ChatMessage(role="user", content=request.question),
    ]
    answer = await chat_provider.chat(messages)
    return {"answer": answer, "sources": sources}


@app.post("/rag/query")
async def rag_query(request: RagQueryRequest):
    return await rag_answer_result(request)


@app.post("/rag/query/stream")
async def rag_query_stream(request: RagQueryRequest):
    return StreamingResponse(
        rag_query_events(request),
        media_type="application/x-ndjson; charset=utf-8",
    )


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


@app.post("/agent/run/stream")
async def agent_run_stream(request: AgentRunRequest):
    request = resolve_request_config(request)
    async def generate() -> AsyncIterator[str]:
        yield ndjson_event(
            "timeline",
            stepId="agent-start",
            status="active",
            title="启动 Agent",
            detail=f"Agent 模式：{request.agent.mode}，最大步数：{request.agent.max_steps}。",
        )
        yield ndjson_event(
            "delta",
            text="Agent 执行入口已预留，后续可在这里接入规划、工具调用和多步执行。",
            content="Agent 执行入口已预留，后续可在这里接入规划、工具调用和多步执行。",
        )
        yield ndjson_event("timeline", stepId="agent-start", status="completed", title="启动 Agent", detail="Agent 入口响应完成。")
        yield ndjson_event("done")

    return StreamingResponse(generate(), media_type="application/x-ndjson; charset=utf-8")
