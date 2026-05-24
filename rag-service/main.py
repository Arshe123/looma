from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from indexer import (
    DEFAULT_OLLAMA_BASE_URL,
    DEFAULT_VECTOR_STORE_PATH,
    build_index,
    get_index_status,
)
from query import ask, ask_stream

DEFAULT_LLM_MODEL = "qwen2.5:7b"
DEFAULT_EMBED_MODEL = "bge-m3:latest"

app = FastAPI(title="Looma RAG Service")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class AskRequest(BaseModel):
    workspace_path: str
    question: str
    llm_model: str = DEFAULT_LLM_MODEL
    embed_model: str = DEFAULT_EMBED_MODEL
    ollama_base_url: str = DEFAULT_OLLAMA_BASE_URL
    vector_store_path: str = DEFAULT_VECTOR_STORE_PATH


class IndexRequest(BaseModel):
    workspace_path: str
    llm_model: str = DEFAULT_LLM_MODEL
    embed_model: str = DEFAULT_EMBED_MODEL
    ollama_base_url: str = DEFAULT_OLLAMA_BASE_URL
    vector_store_path: str = DEFAULT_VECTOR_STORE_PATH


@app.get("/health")
def health():
    return {
        "status": "ok",
        "service": "looma-rag",
    }


@app.post("/index")
def index_notes(req: IndexRequest):
    return build_index(
        req.workspace_path,
        req.llm_model,
        req.embed_model,
        req.ollama_base_url,
        req.vector_store_path,
    )


@app.post("/index/status")
def index_status(req: IndexRequest):
    return get_index_status(req.workspace_path, req.vector_store_path)


@app.post("/ask")
def ask_notes(req: AskRequest):
    return ask(
        req.workspace_path,
        req.question,
        req.llm_model,
        req.embed_model,
        req.ollama_base_url,
        req.vector_store_path,
    )


@app.post("/ask/stream")
def ask_notes_stream(req: AskRequest):
    return StreamingResponse(
        ask_stream(
            req.workspace_path,
            req.question,
            req.llm_model,
            req.embed_model,
            req.ollama_base_url,
            req.vector_store_path,
        ),
        media_type="application/x-ndjson; charset=utf-8",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )
