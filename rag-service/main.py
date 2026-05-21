from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from indexer import build_index, get_index_status
from query import ask, ask_stream

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


class IndexRequest(BaseModel):
    workspace_path: str


@app.get("/health")
def health():
    return {
        "status": "ok",
        "service": "looma-rag",
    }


@app.post("/index")
def index_notes(req: IndexRequest):
    return build_index(req.workspace_path)


@app.post("/index/status")
def index_status(req: IndexRequest):
    return get_index_status(req.workspace_path)


@app.post("/ask")
def ask_notes(req: AskRequest):
    return ask(req.workspace_path, req.question)


@app.post("/ask/stream")
def ask_notes_stream(req: AskRequest):
    return StreamingResponse(
        ask_stream(req.workspace_path, req.question),
        media_type="application/x-ndjson; charset=utf-8",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )
