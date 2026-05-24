from pathlib import Path

from llama_index.core import (
    SimpleDirectoryReader,
    VectorStoreIndex,
    Settings,
)
from llama_index.core.node_parser import SentenceSplitter
from llama_index.llms.ollama import Ollama
from llama_index.embeddings.ollama import OllamaEmbedding

DEFAULT_OLLAMA_BASE_URL = "http://127.0.0.1:11434"
DEFAULT_VECTOR_STORE_PATH = ".looma/rag-index"

REQUIRED_INDEX_FILES = {
    "index_store.json",
    "docstore.json",
    "default__vector_store.json",
}


def init_settings(llm_model: str, embed_model: str, ollama_base_url: str = DEFAULT_OLLAMA_BASE_URL):
    Settings.llm = Ollama(
        model=llm_model,
        base_url=ollama_base_url,
        request_timeout=120.0,
    )

    Settings.embed_model = OllamaEmbedding(
        model_name=embed_model,
        base_url=ollama_base_url,
    )

    Settings.node_parser = SentenceSplitter(
        chunk_size=800,
        chunk_overlap=100,
    )


def get_persist_dir(workspace_path: str, vector_store_path: str = DEFAULT_VECTOR_STORE_PATH) -> Path:
    resolved = Path(workspace_path).expanduser().resolve()
    raw_path = (vector_store_path or DEFAULT_VECTOR_STORE_PATH).strip()
    relative_path = Path(raw_path)
    if relative_path.is_absolute():
        raise ValueError("向量存储路径必须是相对于工作空间的路径。")
    persist_dir = (resolved / relative_path).resolve()
    try:
        persist_dir.relative_to(resolved)
    except ValueError as exc:
        raise ValueError("向量存储路径不能指向工作空间外。") from exc
    return persist_dir


def has_index(workspace_path: str, vector_store_path: str = DEFAULT_VECTOR_STORE_PATH) -> bool:
    persist_dir = get_persist_dir(workspace_path, vector_store_path)
    return persist_dir.is_dir() and all(
        (persist_dir / filename).is_file()
        for filename in REQUIRED_INDEX_FILES
    )


def get_index_status(workspace_path: str, vector_store_path: str = DEFAULT_VECTOR_STORE_PATH):
    notes_dir = Path(workspace_path).expanduser().resolve()
    try:
        persist_dir = get_persist_dir(str(notes_dir), vector_store_path)
    except ValueError as exc:
        return {
            "exists": False,
            "error": str(exc),
        }
    if not notes_dir.exists() or not notes_dir.is_dir():
        return {
            "exists": False,
            "persist_dir": str(persist_dir),
            "error": "工作空间不存在或不是文件夹。",
        }

    return {
        "exists": has_index(str(notes_dir), vector_store_path),
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


def build_index(
    workspace_path: str,
    llm_model: str,
    embed_model: str,
    ollama_base_url: str = DEFAULT_OLLAMA_BASE_URL,
    vector_store_path: str = DEFAULT_VECTOR_STORE_PATH,
):
    notes_dir = Path(workspace_path).expanduser().resolve()
    print(notes_dir)
    try:
        persist_dir = get_persist_dir(str(notes_dir), vector_store_path)
    except ValueError as exc:
        return {
            "status": "error",
            "exists": False,
            "error": str(exc),
        }

    init_settings(llm_model, embed_model, ollama_base_url)

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
    exists = has_index(str(notes_dir), vector_store_path)
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
