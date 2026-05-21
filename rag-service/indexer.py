from pathlib import Path

from llama_index.core import (
    SimpleDirectoryReader,
    VectorStoreIndex,
    Settings,
)
from llama_index.core.node_parser import SentenceSplitter
from llama_index.llms.ollama import Ollama
from llama_index.embeddings.ollama import OllamaEmbedding

from config import OLLAMA_BASE_URL, LLM_MODEL, EMBED_MODEL

REQUIRED_INDEX_FILES = {
    "index_store.json",
    "docstore.json",
    "default__vector_store.json",
}


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

    Settings.node_parser = SentenceSplitter(
        chunk_size=800,
        chunk_overlap=100,
    )


def get_persist_dir(workspace_path: str) -> Path:
    resolved = Path(workspace_path).expanduser().resolve()
    return resolved / ".looma" / "rag-index"


def has_index(workspace_path: str) -> bool:
    persist_dir = get_persist_dir(workspace_path)
    return persist_dir.is_dir() and all(
        (persist_dir / filename).is_file()
        for filename in REQUIRED_INDEX_FILES
    )


def get_index_status(workspace_path: str):
    notes_dir = Path(workspace_path).expanduser().resolve()
    persist_dir = get_persist_dir(str(notes_dir))
    if not notes_dir.exists() or not notes_dir.is_dir():
        return {
            "exists": False,
            "persist_dir": str(persist_dir),
            "error": "工作空间不存在或不是文件夹。",
        }

    return {
        "exists": has_index(str(notes_dir)),
        "persist_dir": str(persist_dir),
    }


def collect_indexable_files(notes_dir: Path):
    supported_exts = {".md", ".txt", ".pdf"}
    files = []
    for path in notes_dir.rglob("*"):
        if not path.is_file():
            continue
        try:
            relative = path.relative_to(notes_dir)
        except ValueError:
            continue
        if ".looma" in relative.parts:
            continue
        if path.suffix.lower() in supported_exts:
            files.append(str(path))
    return files


def build_index(workspace_path: str):
    init_settings()

    notes_dir = Path(workspace_path).expanduser().resolve()
    print(notes_dir)
    persist_dir = get_persist_dir(str(notes_dir))
    if not notes_dir.exists() or not notes_dir.is_dir():
        return {
            "status": "error",
            "exists": False,
            "persist_dir": str(persist_dir),
            "error": "工作空间不存在或不是文件夹。",
        }

    input_files = collect_indexable_files(notes_dir)
    if not input_files:
        return {
            "status": "ok",
            "document_count": 0,
            "exists": False,
            "persist_dir": str(persist_dir),
        }

    documents = SimpleDirectoryReader(input_files=input_files).load_data()

    if not documents:
        return {
            "status": "ok",
            "document_count": 0,
            "exists": False,
            "persist_dir": str(persist_dir),
        }

    index = VectorStoreIndex.from_documents(documents)

    persist_dir.mkdir(parents=True, exist_ok=True)
    index.storage_context.persist(persist_dir=str(persist_dir))
    exists = has_index(str(notes_dir))
    if not exists:
        return {
            "status": "error",
            "document_count": len(documents),
            "exists": False,
            "persist_dir": str(persist_dir),
            "error": "索引文件未写入预期目录。",
        }

    return {
        "status": "ok",
        "document_count": len(documents),
        "exists": exists,
        "persist_dir": str(persist_dir),
    }
