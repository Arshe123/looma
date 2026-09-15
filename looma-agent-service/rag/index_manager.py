from __future__ import annotations

import asyncio

import hashlib
import json
import threading
from contextlib import contextmanager
from datetime import datetime, timezone
from json import JSONDecodeError
from pathlib import Path, PurePosixPath, PureWindowsPath
from typing import Any, AsyncIterator, Literal

from providers.base import ProviderConnectionError
from rag import index_service
from rag.index_transaction import staged_index_update
from rag.index_service import build_index as build_vector_index, get_persist_dir, has_index
from rag.index_service import scan_indexable_files
from schemas import IndexBuildRequest, IndexRequest, IndexStatusRequest, KnowledgeConfig

INDEX_DIR = ".looma/index"
MANIFEST_FILE = "index_manifest.json"
METADATA_FILE = "index_metadata.json"
INDEX_VERSION = 1
PARSER_VERSION = 1
PARSER_TYPE = "markdown-text"

STATUSES = ["indexed", "not_indexed", "outdated", "deleted", "failed", "ignored"]
REQUIRED_INDEX_FILES = {"index_store.json", "docstore.json", "default__vector_store.json"}
_index_locks: dict[str, threading.RLock] = {}
_index_locks_guard = threading.Lock()


class CorruptIndexError(RuntimeError):
    def __init__(self, persist_dir: Path, detail: str):
        self.persist_dir = persist_dir
        self.detail = detail
        super().__init__("本地向量索引文件已损坏，无法安全执行单文件操作。请先在索引库执行“全量重建”。")


def normalize_relative_path(path: str | Path) -> str:
    return str(path).replace("\\", "/").strip("/")


def _metadata_relative_path(value: Any, workspace: Path) -> str | None:
    """Resolve legacy metadata identities without matching arbitrary suffixes."""
    raw = str(value or "").replace("\\", "/")
    prefix = str(workspace).replace("\\", "/").rstrip("/") + "/"
    if raw.startswith(prefix):
        raw = raw[len(prefix):]
    elif PurePosixPath(raw).is_absolute() or PureWindowsPath(raw).is_absolute():
        return None
    if not raw or any(part in {".", ".."} for part in raw.split("/")):
        return None
    return raw


@contextmanager
def index_operation_lock(persist_dir: Path):
    key = str(persist_dir.resolve())
    with _index_locks_guard:
        lock = _index_locks.setdefault(key, threading.RLock())
    with lock:
        yield


def validate_persisted_index_json(persist_dir: Path) -> None:
    for filename in REQUIRED_INDEX_FILES:
        path = persist_dir / filename
        if not path.is_file():
            continue
        try:
            with path.open("r", encoding="utf-8") as handle:
                json.load(handle)
        except JSONDecodeError as exc:
            raise CorruptIndexError(persist_dir, f"{filename}: {exc}") from exc


def corrupt_index_response(error: CorruptIndexError, path: str = "") -> dict[str, Any]:
    return {
        "success": False,
        "status": "corrupt_index",
        "path": path,
        "chunkCount": 0,
        "chunks": [],
        "error": str(error),
        "technicalDetail": error.detail,
        "persist_dir": str(error.persist_dir),
        "requiresRebuild": True,
    }



def file_doc_id(workspace: Path, rel: str) -> str:
    raw = f"{workspace}|{rel}"
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def _remove_doc_vectors(workspace: Path, persist_dir: Path, doc_id: str, rel: str | None = None) -> int:
    """Delete all vector nodes for a file. Returns count removed."""
    if not persist_dir.is_dir():
        return 0
    if not all((persist_dir / f).is_file() for f in REQUIRED_INDEX_FILES):
        return 0

    validate_persisted_index_json(persist_dir)
    from llama_index.core import StorageContext

    storage_context = StorageContext.from_defaults(persist_dir=str(persist_dir))
    vector_store = storage_context.vector_store
    if not hasattr(vector_store, "_data"):
        return 0

    normalized_rel = normalize_relative_path(rel or "")
    data = vector_store._data
    nodes_to_delete: set[str] = set()
    for node_id, ref_id in list(data.text_id_to_ref_doc_id.items()):
        if ref_id == doc_id:
            nodes_to_delete.add(node_id)

    # Compatibility fallback: older Windows-built indexes used backslash paths in
    # doc_id and metadata. Match metadata too so reindex removes duplicate old chunks.
    if normalized_rel:
        for node_id, metadata in list(getattr(data, "metadata_dict", {}).items()):
            source = _metadata_relative_path(
                metadata.get("source") or metadata.get("path") or metadata.get("file_path"), workspace
            )
            if source == normalized_rel:
                nodes_to_delete.add(node_id)

    removed = len(nodes_to_delete)
    for node_id in nodes_to_delete:
        data.embedding_dict.pop(node_id, None)
        data.text_id_to_ref_doc_id.pop(node_id, None)
        data.metadata_dict.pop(node_id, None)
        docstore = getattr(storage_context, "docstore", None)
        if docstore and hasattr(docstore, "delete_document"):
            try:
                docstore.delete_document(node_id, raise_error=False)
            except TypeError:
                try:
                    docstore.delete_document(node_id)
                except Exception:
                    pass

    if removed:
        storage_context.persist(persist_dir=str(persist_dir))
    return removed


def _insert_doc_vectors(workspace: Path, persist_dir: Path, file_path: Path, request: IndexRequest) -> int:
    """Insert all documents/pages with one explicit transformation pipeline."""
    from llama_index.core import StorageContext, VectorStoreIndex, load_index_from_storage
    from llama_index.core.ingestion import run_transformations

    if request.ai_config is None or request.ai_config.embedding is None:
        raise ValueError("单文件重建需要配置嵌入模型。")
    documents = index_service.load_documents([file_path], workspace)
    if not documents:
        return 0
    embedding = index_service.make_embedding_model(request.ai_config.embedding)
    transformations = index_service.make_node_transformations(request.knowledge or KnowledgeConfig())
    nodes = run_transformations(documents, transformations=transformations)
    if persist_dir.exists():
        validate_persisted_index_json(persist_dir)
        storage_context = StorageContext.from_defaults(persist_dir=str(persist_dir))
        index = load_index_from_storage(storage_context, embed_model=embedding, transformations=transformations)
    else:
        index = VectorStoreIndex(nodes=[], embed_model=embedding, transformations=transformations)
    index.insert_nodes(nodes)
    for document in documents:
        index.docstore.set_document_hash(document.id_, document.hash)
    index.storage_context.persist(persist_dir=str(persist_dir))
    return len(nodes)


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def workspace_id_for_path(workspace: Path) -> str:
    digest = hashlib.sha256(str(workspace).encode("utf-8")).hexdigest()[:12]
    return f"{workspace.name or 'workspace'}-{digest}"


def index_dir(workspace: Path) -> Path:
    return workspace / INDEX_DIR


def manifest_path(workspace: Path) -> Path:
    return index_dir(workspace) / MANIFEST_FILE


def metadata_path(workspace: Path) -> Path:
    return index_dir(workspace) / METADATA_FILE


def read_json(path: Path, fallback: dict[str, Any]) -> dict[str, Any]:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return fallback
    except json.JSONDecodeError:
        return fallback


def write_json(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding="utf-8")


def empty_manifest(workspace: Path) -> dict[str, Any]:
    timestamp = now_iso()
    return {
        "version": INDEX_VERSION,
        "workspaceId": workspace_id_for_path(workspace),
        "createdAt": timestamp,
        "updatedAt": timestamp,
        "files": {},
    }


def load_manifest(workspace: Path) -> dict[str, Any]:
    manifest = read_json(manifest_path(workspace), empty_manifest(workspace))
    if not isinstance(manifest.get("files"), dict):
        manifest["files"] = {}
    manifest.setdefault("version", INDEX_VERSION)
    manifest.setdefault("workspaceId", workspace_id_for_path(workspace))
    return manifest


def save_manifest(workspace: Path, manifest: dict[str, Any]) -> None:
    manifest["updatedAt"] = now_iso()
    write_json(manifest_path(workspace), manifest)


def current_metadata(request: IndexRequest, workspace: Path) -> dict[str, Any]:
    embedding = request.ai_config.embedding if request.ai_config else None
    knowledge = request.knowledge or KnowledgeConfig()
    timestamp = now_iso()
    return {
        "indexVersion": INDEX_VERSION,
        "workspaceId": workspace_id_for_path(workspace),
        "createdAt": timestamp,
        "updatedAt": timestamp,
        "embedding": {
            "provider": embedding.provider if embedding else "",
            "model": embedding.model if embedding else "",
            "dimension": embedding.dimension if embedding else None,
        },
        "chunking": {
            "strategy": knowledge.chunking_strategy,
            "chunkSize": knowledge.chunk_size,
            "chunkOverlap": knowledge.chunk_overlap,
        },
        "parser": {
            "type": PARSER_TYPE,
            "version": PARSER_VERSION,
        },
    }


def load_metadata(workspace: Path) -> dict[str, Any] | None:
    path = metadata_path(workspace)
    if not path.exists():
        return None
    return read_json(path, {})


def save_metadata(workspace: Path, metadata: dict[str, Any]) -> None:
    previous = load_metadata(workspace)
    if previous and previous.get("createdAt"):
        metadata["createdAt"] = previous["createdAt"]
    metadata["updatedAt"] = now_iso()
    write_json(metadata_path(workspace), metadata)


def validate_metadata_compatibility(current: dict[str, Any], stored: dict[str, Any] | None) -> dict[str, Any]:
    if not stored:
        return {
            "compatible": False,
            "needRebuild": True,
            "reason": "索引元数据不存在，需要构建索引。",
        }

    checks = [
        ("embedding.provider", stored.get("embedding", {}).get("provider"), current.get("embedding", {}).get("provider")),
        ("embedding.model", stored.get("embedding", {}).get("model"), current.get("embedding", {}).get("model")),
        ("embedding.dimension", stored.get("embedding", {}).get("dimension"), current.get("embedding", {}).get("dimension")),
        ("chunking.strategy", stored.get("chunking", {}).get("strategy", "fixed"), current.get("chunking", {}).get("strategy", "fixed")),
        ("chunking.chunkSize", stored.get("chunking", {}).get("chunkSize"), current.get("chunking", {}).get("chunkSize")),
        ("chunking.chunkOverlap", stored.get("chunking", {}).get("chunkOverlap"), current.get("chunking", {}).get("chunkOverlap")),
        ("parser.type", stored.get("parser", {}).get("type"), current.get("parser", {}).get("type")),
        ("parser.version", stored.get("parser", {}).get("version"), current.get("parser", {}).get("version")),
    ]
    for name, old, new in checks:
        if old != new:
            return {
                "compatible": False,
                "needRebuild": True,
                "reason": f"{name} changed from {old or '未设置'} to {new or '未设置'}",
            }
    return {"compatible": True, "needRebuild": False, "reason": "索引配置兼容。"}


def scan_workspace(workspace: Path) -> tuple[list[Path], list[Path]]:
    return scan_indexable_files(workspace)


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return "sha256:" + digest.hexdigest()


def file_entry(path: Path, workspace: Path, status: str, previous: dict[str, Any] | None = None, *, computed_hash: str | None = None) -> dict[str, Any]:
    stat = path.stat()
    rel = str(path.relative_to(workspace)).replace("\\", "/")
    content_hash = previous.get("contentHash") if previous else None
    should_hash = (
        not previous
        or previous.get("status") != "indexed"
        or previous.get("size") != stat.st_size
        or previous.get("mtimeMs") != int(stat.st_mtime * 1000)
        or status in {"not_indexed", "outdated"}
    )
    if computed_hash is not None:
        content_hash = computed_hash
    elif should_hash:
        content_hash = file_sha256(path)
    return {
        "path": rel,
        "contentHash": content_hash,
        "mtimeMs": int(stat.st_mtime * 1000),
        "size": stat.st_size,
        "chunkIds": previous.get("chunkIds", []) if previous else [],
        "chunkCount": previous.get("chunkCount", 0) if previous else 0,
        "status": status,
        "lastIndexedAt": previous.get("lastIndexedAt") if previous else None,
        "error": previous.get("error") if previous and status == "failed" else None,
    }


def estimate_chunk_count(path: Path, chunk_size: int) -> int:
    try:
        text = path.read_text(encoding="utf-8", errors="ignore")
    except Exception:
        return 0
    if not text.strip():
        return 0
    return max(1, (len(text) + max(1, chunk_size) - 1) // max(1, chunk_size))


def chunk_ids(workspace_id: str, rel: str, content_hash: str, chunk_count: int) -> list[str]:
    ids: list[str] = []
    for index in range(chunk_count):
        raw = f"{workspace_id}|{rel}|{content_hash}|{index}"
        ids.append(hashlib.sha256(raw.encode("utf-8")).hexdigest())
    return ids


def build_status_snapshot(request: IndexRequest | IndexStatusRequest) -> dict[str, Any]:
    workspace = Path(request.workspace.workspace_path if isinstance(request, IndexRequest) else request.workspace_path).expanduser().resolve()
    vector_store = (request.knowledge or KnowledgeConfig()).vector_store_path if isinstance(request, IndexRequest) else request.vector_store_path or ".looma/rag-index"
    with index_operation_lock(get_persist_dir(workspace, vector_store)):
        return _build_status_snapshot_locked(request)


def _build_status_snapshot_locked(request: IndexRequest | IndexStatusRequest) -> dict[str, Any]:
    workspace = Path(request.workspace.workspace_path if isinstance(request, IndexRequest) else request.workspace_path).expanduser().resolve()
    if not workspace.exists() or not workspace.is_dir():
        return {
            "workspaceId": workspace_id_for_path(workspace),
            "exists": False,
            "indexCompatible": False,
            "needRebuild": True,
            "compatibility": {"compatible": False, "needRebuild": True, "reason": "工作空间不存在或不是文件夹。"},
            "summary": {"indexed": 0, "notIndexed": 0, "outdated": 0, "deleted": 0, "failed": 0, "ignored": 0},
            "files": [],
            "error": "工作空间不存在或不是文件夹。",
        }

    manifest = load_manifest(workspace)
    manifest_files: dict[str, Any] = manifest.get("files", {})
    scanned, ignored = scan_workspace(workspace)
    seen: set[str] = set()
    files: list[dict[str, Any]] = []

    for path in scanned:
        rel = str(path.relative_to(workspace)).replace("\\", "/")
        seen.add(rel)
        previous = manifest_files.get(rel)
        computed_hash = None
        if not previous:
            status = "not_indexed"
        elif previous.get("status") == "failed":
            status = "failed"
        else:
            stat = path.stat()
            status = "indexed"
            if previous.get("size") != stat.st_size:
                status = "outdated"
            elif previous.get("mtimeMs") != int(stat.st_mtime * 1000):
                computed_hash = file_sha256(path)
                if previous.get("contentHash") != computed_hash:
                    status = "outdated"
        files.append(file_entry(path, workspace, status, previous, computed_hash=computed_hash))

    for rel, previous in manifest_files.items():
        if rel in seen:
            continue
        item = dict(previous)
        item["path"] = rel
        item["status"] = "deleted"
        files.append(item)

    for path in ignored[:500]:
        rel = str(path.relative_to(workspace)).replace("\\", "/")
        files.append({"path": rel, "status": "ignored", "chunkCount": 0, "error": None})

    summary = {status: 0 for status in STATUSES}
    for item in files:
        status = item.get("status")
        if status in summary:
            summary[status] += 1

    if isinstance(request, IndexRequest):
        current = current_metadata(request, workspace)
        compatibility = validate_metadata_compatibility(current, load_metadata(workspace))
        persist_dir = get_persist_dir(workspace, request.knowledge.vector_store_path)
        vector_exists = has_index(workspace, request.knowledge.vector_store_path)
        try:
            if vector_exists:
                validate_persisted_index_json(persist_dir)
        except CorruptIndexError as exc:
            vector_exists = False
            compatibility = {"compatible": False, "needRebuild": True, "reason": str(exc), "technicalDetail": exc.detail}
    else:
        compatibility = {"compatible": True, "needRebuild": False, "reason": "未提供当前模型配置，仅返回文件状态。"}
        persist_dir = get_persist_dir(workspace, request.vector_store_path or ".looma/rag-index")
        vector_exists = persist_dir.exists()
        try:
            if vector_exists and all((persist_dir / file_name).is_file() for file_name in REQUIRED_INDEX_FILES):
                validate_persisted_index_json(persist_dir)
        except CorruptIndexError as exc:
            vector_exists = False
            compatibility = {"compatible": False, "needRebuild": True, "reason": str(exc), "technicalDetail": exc.detail}

    return {
        "workspaceId": workspace_id_for_path(workspace),
        "exists": vector_exists,
        "persist_dir": str(persist_dir),
        "indexCompatible": bool(compatibility.get("compatible")),
        "needRebuild": bool(compatibility.get("needRebuild")),
        "compatibility": compatibility,
        "summary": {
            "indexed": summary["indexed"],
            "notIndexed": summary["not_indexed"],
            "outdated": summary["outdated"],
            "deleted": summary["deleted"],
            "failed": summary["failed"],
            "ignored": summary["ignored"],
        },
        "files": sorted(files, key=lambda item: (str(item.get("status", "")), str(item.get("path", "")))),
        "metadata": load_metadata(workspace),
    }


def summarize_indexed_manifest_files(manifest: dict[str, Any]) -> dict[str, int]:
    indexed_files = [
        item for item in manifest.get("files", {}).values()
        if isinstance(item, dict) and item.get("status") == "indexed"
    ]
    total_chunks = sum(int(item.get("chunkCount") or 0) for item in indexed_files)
    return {
        "fileCount": len(indexed_files),
        "documentCount": len(indexed_files),
        "chunkCount": total_chunks,
    }


def create_last_build_metadata(metadata: dict[str, Any], indexed_at: str, summary: dict[str, int], status: str = "ok", mode: str | None = None) -> dict[str, Any]:
    result = {
        "indexedAt": indexed_at,
        "documentCount": summary.get("documentCount", 0),
        "fileCount": summary.get("fileCount", 0),
        "chunkCount": summary.get("chunkCount", 0),
        "status": status,
        "embeddingProvider": metadata.get("embedding", {}).get("provider"),
        "embeddingModel": metadata.get("embedding", {}).get("model"),
        "chunkingStrategy": metadata.get("chunking", {}).get("strategy", "fixed"),
        "chunkSize": metadata.get("chunking", {}).get("chunkSize"),
        "chunkOverlap": metadata.get("chunking", {}).get("chunkOverlap"),
        "parserType": metadata.get("parser", {}).get("type"),
        "parserVersion": metadata.get("parser", {}).get("version"),
    }
    if mode:
        result["mode"] = mode
    return result


def update_metadata_after_file_reindex(request: IndexRequest, workspace: Path, rel: str, chunks: int, indexed_at: str) -> dict[str, Any]:
    manifest = load_manifest(workspace)
    summary = summarize_indexed_manifest_files(manifest)
    metadata = current_metadata(request, workspace)
    previous = load_metadata(workspace) or {}
    if previous.get("lastBuild"):
        metadata["previousLastBuild"] = previous.get("lastBuild")
    metadata["lastBuild"] = create_last_build_metadata(metadata, indexed_at, summary, "ok", "single_file")
    metadata["lastFileReindex"] = {
        "indexedAt": indexed_at,
        "path": rel,
        "chunkCount": chunks,
        "status": "ok",
    }
    save_metadata(workspace, metadata)
    return metadata


def get_persisted_chunk_counts(workspace: Path, persist_dir: Path, relative_paths: list[str]) -> dict[str, int]:
    """Read actual per-file chunk counts from SimpleVectorStore JSON.

    Manifest counts must reflect persisted vector nodes, not text-length estimates.
    This function avoids importing llama-index so metadata reconciliation remains
    testable in lightweight environments.
    """
    vector_path = persist_dir / "default__vector_store.json"
    if not vector_path.is_file():
        return {}

    validate_persisted_index_json(persist_dir)
    try:
        payload = json.loads(vector_path.read_text(encoding="utf-8"))
    except (OSError, JSONDecodeError):
        return {}

    text_ref_map = payload.get("text_id_to_ref_doc_id") or {}
    metadata_map = payload.get("metadata_dict") or {}
    if not isinstance(text_ref_map, dict):
        text_ref_map = {}
    if not isinstance(metadata_map, dict):
        metadata_map = {}

    normalized_paths = [normalize_relative_path(path) for path in relative_paths]
    doc_to_rel = {file_doc_id(workspace, rel): rel for rel in normalized_paths}
    counts = {rel: 0 for rel in normalized_paths}

    for node_id, ref_doc_id in text_ref_map.items():
        rel = doc_to_rel.get(str(ref_doc_id))
        if not rel:
            metadata = metadata_map.get(node_id) or {}
            if isinstance(metadata, dict):
                source = _metadata_relative_path(
                    metadata.get("source") or metadata.get("path") or metadata.get("file_path"), workspace
                )
                rel = source if source in counts else ""
        if rel:
            counts[rel] = counts.get(rel, 0) + 1

    return counts


def mark_all_scanned_indexed(request: IndexRequest, build_result: dict[str, Any]) -> dict[str, Any]:
    workspace = Path(request.workspace.workspace_path).expanduser().resolve()
    manifest = load_manifest(workspace)
    scanned, _ignored = scan_workspace(workspace)
    files: dict[str, Any] = {}
    workspace_id = workspace_id_for_path(workspace)
    indexed_at = now_iso()
    relative_paths = [str(path.relative_to(workspace)).replace("\\", "/") for path in scanned]
    persist_dir = get_persist_dir(workspace, request.knowledge.vector_store_path)
    persisted_chunk_counts = get_persisted_chunk_counts(workspace, persist_dir, relative_paths)
    for path in scanned:
        entry = file_entry(path, workspace, "indexed")
        chunk_count = persisted_chunk_counts.get(entry["path"])
        if chunk_count is None:
            chunk_count = 0 if not build_result.get("exists") else estimate_chunk_count(path, request.knowledge.chunk_size)
        entry["chunkCount"] = chunk_count
        entry["chunkIds"] = chunk_ids(workspace_id, entry["path"], entry.get("contentHash") or "", chunk_count)
        entry["lastIndexedAt"] = indexed_at
        entry["error"] = None
        files[entry["path"]] = entry
    manifest["files"] = files
    save_manifest(workspace, manifest)

    summary = summarize_indexed_manifest_files(manifest)
    metadata = current_metadata(request, workspace)
    metadata["lastBuild"] = create_last_build_metadata(
        metadata,
        indexed_at,
        {
            "documentCount": int(build_result.get("document_count", len(scanned)) or 0),
            "fileCount": int(build_result.get("file_count", len(scanned)) or 0),
            "chunkCount": summary["chunkCount"],
        },
        build_result.get("status", "ok"),
        build_result.get("mode"),
    )
    save_metadata(workspace, metadata)
    build_result["chunk_count"] = summary["chunkCount"]
    build_result["metadata"] = metadata
    return build_result


def _validate_transaction_target(workspace: Path, persist_dir: Path) -> None:
    if persist_dir == workspace or index_dir(workspace).is_relative_to(persist_dir):
        raise ValueError("向量存储目录不能覆盖工作空间或索引管理目录。")


def target_statuses_for_mode(mode: str) -> set[str]:
    if mode == "retry_failed":
        return {"failed"}
    if mode == "incremental":
        return {"not_indexed", "outdated", "deleted"}
    return {"indexed", "not_indexed", "outdated", "deleted", "failed"}


def build_managed_index(request: IndexRequest, mode: Literal["incremental", "full", "retry_failed"] = "incremental") -> dict[str, Any]:
    workspace = Path(request.workspace.workspace_path).expanduser().resolve()
    if not workspace.exists() or not workspace.is_dir():
        raise ValueError("工作空间不存在或不是文件夹。")
    persist_dir = get_persist_dir(workspace, request.knowledge.vector_store_path)
    with index_operation_lock(persist_dir):
        return _build_managed_index_locked(request, mode)


def _build_managed_index_locked(request: IndexRequest, mode: Literal["incremental", "full", "retry_failed"] = "incremental") -> dict[str, Any]:
    workspace = Path(request.workspace.workspace_path).expanduser().resolve()

    status_before = build_status_snapshot(request)
    targets = [item for item in status_before.get("files", []) if item.get("status") in target_statuses_for_mode(mode)]
    if mode != "full" and not targets and status_before.get("exists") and not status_before.get("needRebuild"):
        return {
            "success": True,
            "status": "ok",
            "mode": mode,
            "skipped": True,
            "message": "索引已经是最新状态。",
            "processed_count": 0,
            "statusBefore": status_before,
            "statusAfter": status_before,
            "exists": status_before.get("exists", False),
            "document_count": status_before.get("summary", {}).get("indexed", 0),
            "file_count": status_before.get("summary", {}).get("indexed", 0),
        }

    persist_dir = get_persist_dir(workspace, request.knowledge.vector_store_path)
    _validate_transaction_target(workspace, persist_dir)
    with staged_index_update(
        persist_dir, [manifest_path(workspace), metadata_path(workspace)], copy_existing=False
    ) as staged_dir:
        # Build privately, including the empty-corpus case. Absence of a staged
        # store commits an empty index instead of leaving stale vectors behind.
        staged_knowledge = request.knowledge.model_copy(update={
            "vector_store_path": staged_dir.relative_to(workspace).as_posix(),
        })
        staged_request = request.model_copy(update={"knowledge": staged_knowledge})
        build_result = build_vector_index(staged_request)
        mark_all_scanned_indexed(staged_request, build_result)
    build_result["persist_dir"] = str(persist_dir)
    status_after = build_status_snapshot(request)
    return {
        **build_result,
        "mode": mode,
        "processed_count": len(targets) if mode != "full" else status_after.get("summary", {}).get("indexed", 0),
        "statusBefore": status_before,
        "statusAfter": status_after,
    }


async def build_managed_index_events(request: IndexRequest, mode: str = "incremental") -> AsyncIterator[dict[str, Any]]:
    yield {"type": "timeline", "stepId": "scan-index", "status": "active", "title": "扫描索引状态", "detail": "正在对比文件系统和索引清单。"}
    status_before = build_status_snapshot(request)
    summary = status_before.get("summary", {})
    yield {
        "type": "timeline",
        "stepId": "scan-index",
        "status": "completed",
        "title": "扫描索引状态",
        "detail": f"已索引 {summary.get('indexed', 0)}，未索引 {summary.get('notIndexed', 0)}，过期 {summary.get('outdated', 0)}，删除 {summary.get('deleted', 0)}，失败 {summary.get('failed', 0)}。",
        "outputs": [{"type": "json", "title": "索引摘要", "content": json.dumps(summary, ensure_ascii=False)}],
    }
    yield {"type": "timeline", "stepId": "build-index", "status": "active", "title": "同步向量索引", "detail": f"模式：{mode}。当前存储后端会在需要更新时重建本地向量库以保证一致性。"}
    try:
        result = await asyncio.to_thread(build_managed_index, request, mode)
    except ProviderConnectionError as exc:
        yield {
            "type": "error",
            "stepId": "build-index",
            "error": str(exc),
            "message": str(exc),
            "code": exc.code,
            "technicalDetail": exc.technical_detail,
        }
        return
    yield {"type": "timeline", "stepId": "build-index", "status": "completed", "title": "同步向量索引", "detail": "索引同步完成。"}
    yield {"type": "done", "result": result, **{k: v for k, v in result.items() if k in {"status", "document_count", "file_count", "exists", "persist_dir", "mode", "processed_count"}}}


def delete_file_index(request: IndexBuildRequest) -> dict[str, Any]:
    workspace = Path(request.workspace.workspace_path).expanduser().resolve()
    rel = (request.path or "").strip().replace("\\", "/")
    if not rel:
        raise ValueError("path is required")

    knowledge = request.knowledge or KnowledgeConfig()
    vector_store = knowledge.vector_store_path or ".looma/rag-index"
    persist_dir = get_persist_dir(workspace, vector_store)
    doc_id = file_doc_id(workspace, rel)

    _validate_transaction_target(workspace, persist_dir)
    try:
        with index_operation_lock(persist_dir), staged_index_update(
            persist_dir, [manifest_path(workspace), metadata_path(workspace)], copy_existing=True
        ) as staged_dir:
            removed = _remove_doc_vectors(workspace, staged_dir, doc_id, rel)
            manifest = load_manifest(workspace)
            existed = rel in manifest.get("files", {})
            manifest.get("files", {}).pop(rel, None)
            save_manifest(workspace, manifest)
    except CorruptIndexError as exc:
        return corrupt_index_response(exc, rel)

    return {
        "success": True,
        "status": "ok",
        "path": rel,
        "deleted": existed,
        "vector_nodes_removed": removed,
    }


def _node_text(node: Any) -> str:
    if hasattr(node, "get_content"):
        try:
            return node.get_content(metadata_mode="none") or ""
        except TypeError:
            return node.get_content() or ""
    return getattr(node, "text", "") or ""


def _node_metadata(node: Any) -> dict[str, Any]:
    return dict(getattr(node, "metadata", {}) or {})


def get_file_chunks(request: IndexBuildRequest) -> dict[str, Any]:
    """Return persisted chunk/node details for one indexed file."""
    workspace = Path(request.workspace.workspace_path).expanduser().resolve()
    knowledge = request.knowledge or KnowledgeConfig()
    with index_operation_lock(get_persist_dir(workspace, knowledge.vector_store_path)):
        return _get_file_chunks_locked(request)


def _get_file_chunks_locked(request: IndexBuildRequest) -> dict[str, Any]:
    workspace = Path(request.workspace.workspace_path).expanduser().resolve()
    if not workspace.exists() or not workspace.is_dir():
        raise ValueError("工作空间不存在或不是文件夹。")

    rel = (request.path or "").strip().replace("\\", "/")
    if not rel:
        raise ValueError("path is required")

    knowledge = request.knowledge or KnowledgeConfig()
    vector_store = knowledge.vector_store_path or ".looma/rag-index"
    persist_dir = get_persist_dir(workspace, vector_store)
    required = {"index_store.json", "docstore.json", "default__vector_store.json"}
    if not persist_dir.is_dir() or not all((persist_dir / file_name).is_file() for file_name in required):
        return {
            "success": False,
            "status": "missing_index",
            "path": rel,
            "chunkCount": 0,
            "chunks": [],
            "error": "索引不存在，请先构建索引。",
        }

    try:
        validate_persisted_index_json(persist_dir)
    except CorruptIndexError as exc:
        return corrupt_index_response(exc, rel)

    from llama_index.core import StorageContext

    with index_operation_lock(persist_dir):
        try:
            storage_context = StorageContext.from_defaults(persist_dir=str(persist_dir))
        except JSONDecodeError as exc:
            return corrupt_index_response(CorruptIndexError(persist_dir, str(exc)), rel)
    vector_store_obj = storage_context.vector_store
    docstore = getattr(storage_context, "docstore", None)
    docs = dict(getattr(docstore, "docs", {}) or {})

    doc_id = file_doc_id(workspace, rel)
    target_node_ids: list[str] = []
    data = getattr(vector_store_obj, "_data", None)
    ref_map = getattr(data, "text_id_to_ref_doc_id", {}) if data is not None else {}
    for node_id, ref_id in list(ref_map.items()):
        if ref_id == doc_id:
            target_node_ids.append(node_id)

    # Compatibility fallback for older indexes that were built before stable doc_id
    # support: find nodes by source/path metadata.
    if not target_node_ids:
        for node_id, node in docs.items():
            metadata = _node_metadata(node)
            source = str(metadata.get("source") or metadata.get("path") or "").replace("\\", "/")
            if source == rel:
                target_node_ids.append(node_id)

    chunks: list[dict[str, Any]] = []
    seen: set[str] = set()
    for index_number, node_id in enumerate(target_node_ids):
        if node_id in seen:
            continue
        seen.add(node_id)
        node = docs.get(node_id)
        if node is None:
            continue
        metadata = _node_metadata(node)
        text = _node_text(node)
        chunks.append({
            "id": node_id,
            "index": len(chunks),
            "text": text,
            "metadata": metadata,
            "textLength": len(text),
            "filePath": rel,
        })

    manifest = load_manifest(workspace)
    file_record = manifest.get("files", {}).get(rel)
    return {
        "success": True,
        "status": "ok",
        "path": rel,
        "chunkCount": len(chunks),
        "chunks": chunks,
        "manifest": file_record,
        "persist_dir": str(persist_dir),
        "requiresRebuild": len(chunks) == 0 and bool(file_record and file_record.get("chunkCount")),
    }

def delete_index_data(request: IndexBuildRequest) -> dict[str, Any]:
    """Completely purge the vector store, manifest, and metadata for a workspace."""
    workspace = Path(request.workspace.workspace_path).expanduser().resolve()
    if not workspace.exists() or not workspace.is_dir():
        raise ValueError("工作空间不存在或不是文件夹。")

    knowledge = request.knowledge or KnowledgeConfig()
    vector_store = knowledge.vector_store_path or ".looma/rag-index"
    persist_dir = get_persist_dir(workspace, vector_store)

    _validate_transaction_target(workspace, persist_dir)
    with index_operation_lock(persist_dir), staged_index_update(
        persist_dir, [manifest_path(workspace), metadata_path(workspace)], copy_existing=False
    ):
        cleared = persist_dir.exists()
        manifest_path(workspace).unlink(missing_ok=True)
        metadata_path(workspace).unlink(missing_ok=True)

    return {
        "success": True,
        "status": "ok",
        "cleared": cleared,
        "persist_dir": str(persist_dir),
    }


def reindex_file(request: IndexBuildRequest) -> dict[str, Any]:
    if not request.path:
        raise ValueError("必须提供工作空间相对路径。")

    workspace = Path(request.workspace.workspace_path).expanduser().resolve()
    rel = request.path.strip().replace("\\", "/")
    if PurePosixPath(rel).is_absolute() or PureWindowsPath(rel).is_absolute() or ".." in rel.split("/"):
        raise ValueError("文件路径必须位于工作空间内。")
    if not index_service.is_indexable_file(workspace / rel, workspace):
        raise ValueError("文件格式不支持或该文件已排除索引。")
    file_path = (workspace / rel).resolve()
    try:
        rel = file_path.relative_to(workspace).as_posix()
    except ValueError as exc:
        raise ValueError("文件路径必须位于工作空间内。") from exc
    if not file_path.is_file():
        raise ValueError(f"文件不存在或不是普通文件：{rel}")

    knowledge = request.knowledge or KnowledgeConfig()
    vector_store = knowledge.vector_store_path or ".looma/rag-index"
    persist_dir = get_persist_dir(workspace, vector_store)
    doc_id = file_doc_id(workspace, rel)
    _validate_transaction_target(workspace, persist_dir)
    if not request.ai_config or not request.ai_config.embedding:
        raise ValueError("单文件重建需要配置嵌入模型。")
    index_request = IndexRequest(workspace=request.workspace, knowledge=knowledge, ai_config=request.ai_config)
    try:
        with index_operation_lock(persist_dir), staged_index_update(
            persist_dir, [manifest_path(workspace), metadata_path(workspace)], copy_existing=True
        ) as staged_dir:
            _remove_doc_vectors(workspace, staged_dir, doc_id, rel)
            chunks = _insert_doc_vectors(workspace, staged_dir, file_path, index_request)
            manifest = load_manifest(workspace)
            entry = file_entry(file_path, workspace, "indexed")
            indexed_at = now_iso()
            entry["chunkCount"] = chunks
            entry["chunkIds"] = chunk_ids(workspace_id_for_path(workspace), rel, entry.get("contentHash") or "", chunks)
            entry["lastIndexedAt"] = indexed_at
            entry["error"] = None
            manifest["files"][rel] = entry
            save_manifest(workspace, manifest)
            metadata = update_metadata_after_file_reindex(index_request, workspace, rel, chunks, indexed_at)
    except CorruptIndexError as exc:
        return corrupt_index_response(exc, rel)

    return {
        "success": True,
        "status": "ok",
        "path": rel,
        "chunks": chunks,
        "document_count": 1,
        "metadata": metadata,
    }
