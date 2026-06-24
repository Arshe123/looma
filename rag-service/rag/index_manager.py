from __future__ import annotations

import asyncio
import fnmatch
import hashlib
import json
import shutil
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, AsyncIterator, Literal

from rag.index_service import build_index as build_vector_index, configure_llama_index, get_persist_dir, has_index
from schemas import IndexBuildRequest, IndexRequest, IndexStatusRequest, KnowledgeConfig

INDEX_DIR = ".looma/index"
MANIFEST_FILE = "index_manifest.json"
METADATA_FILE = "index_metadata.json"
INDEX_VERSION = 1
PARSER_VERSION = 1
PARSER_TYPE = "markdown-text"
SUPPORTED_EXTENSIONS = {".md", ".txt"}
EXCLUDE_PARTS = {".git", "node_modules", "dist", "build", ".looma"}
EXCLUDE_GLOBS = {
    "*.log",
    "*.tmp",
    "*.png",
    "*.jpg",
    "*.jpeg",
    "*.gif",
    "*.exe",
}
STATUSES = ["indexed", "not_indexed", "outdated", "deleted", "failed", "ignored"]



def file_doc_id(workspace: Path, rel: str) -> str:
    raw = f"{workspace}|{rel}"
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def _remove_doc_vectors(workspace: Path, persist_dir: Path, doc_id: str) -> int:
    """Delete all vector nodes whose ref_doc_id matches doc_id.  Returns count removed."""
    if not persist_dir.is_dir():
        return 0
    required = {"index_store.json", "docstore.json", "default__vector_store.json"}
    if not all((persist_dir / f).is_file() for f in required):
        return 0

    from llama_index.core import StorageContext, load_index_from_storage

    storage_context = StorageContext.from_defaults(persist_dir=str(persist_dir))
    index = load_index_from_storage(storage_context)
    vector_store = index._vector_store if hasattr(index, "_vector_store") else getattr(index, "vector_store", None)
    if not hasattr(vector_store, "_data"):
        return 0

    data = vector_store._data
    nodes_to_delete: set[str] = set()
    for node_id, ref_id in list(data.text_id_to_ref_doc_id.items()):
        if ref_id == doc_id:
            nodes_to_delete.add(node_id)

    removed = len(nodes_to_delete)
    for node_id in nodes_to_delete:
        if node_id in data.embedding_dict:
            del data.embedding_dict[node_id]
        if node_id in data.text_id_to_ref_doc_id:
            del data.text_id_to_ref_doc_id[node_id]
        if node_id in data.metadata_dict:
            del data.metadata_dict[node_id]

    if removed:
        index.storage_context.persist(persist_dir=str(persist_dir))
    return removed


def _insert_doc_vectors(workspace: Path, persist_dir: Path, file_path: Path, request: IndexRequest) -> int:
    """Insert a single file's vectors into an existing index.  Returns chunk count."""
    from llama_index.core import StorageContext, load_index_from_storage
    from llama_index.core import Document

    relative = str(file_path.resolve().relative_to(workspace))
    doc_id = file_doc_id(workspace, relative)

    suffix = file_path.suffix.lower()
    metadata = {
        "source": relative,
        "file_path": str(file_path),
        "path": relative,
        "extension": suffix,
    }
    if suffix in {".md", ".txt"}:
        text = file_path.read_text(encoding="utf-8", errors="ignore")
        if not text.strip():
            return 0
        doc = Document(text=text, metadata=metadata, doc_id=doc_id)
    elif suffix == ".pdf":
        from llama_index.core import SimpleDirectoryReader
        loaded = SimpleDirectoryReader(input_files=[str(file_path)]).load_data()
        if not loaded:
            return 0
        doc = loaded[0]
        doc.metadata = {**metadata, **getattr(doc, "metadata", {})}
        doc.doc_id = doc_id
    else:
        return 0

    # Load existing index and insert
    storage_context = StorageContext.from_defaults(persist_dir=str(persist_dir))
    index = load_index_from_storage(storage_context)
    index.insert(doc)
    index.storage_context.persist(persist_dir=str(persist_dir))

    # Count nodes (chunks) - approximate from node parser settings
    from llama_index.core import Settings
    nodes = Settings.node_parser.get_nodes_from_documents([doc]) if hasattr(Settings, "node_parser") else []
    return len(nodes) or 1
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
            "chunkSize": request.knowledge.chunk_size,
            "chunkOverlap": request.knowledge.chunk_overlap,
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


def is_ignored(path: Path, workspace: Path) -> bool:
    try:
        relative = path.relative_to(workspace)
    except ValueError:
        return True
    if any(part in EXCLUDE_PARTS for part in relative.parts):
        return True
    name = path.name.lower()
    return any(fnmatch.fnmatch(name, pattern) for pattern in EXCLUDE_GLOBS)


def scan_workspace(workspace: Path) -> tuple[list[Path], list[Path]]:
    indexed: list[Path] = []
    ignored: list[Path] = []
    for path in workspace.rglob("*"):
        if not path.is_file():
            continue
        if is_ignored(path, workspace):
            ignored.append(path)
            continue
        if path.suffix.lower() in SUPPORTED_EXTENSIONS:
            indexed.append(path)
        else:
            ignored.append(path)
    return sorted(indexed, key=lambda item: str(item).lower()), sorted(ignored, key=lambda item: str(item).lower())


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return "sha256:" + digest.hexdigest()


def file_entry(path: Path, workspace: Path, status: str, previous: dict[str, Any] | None = None) -> dict[str, Any]:
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
    if should_hash:
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
                if previous.get("contentHash") != file_sha256(path):
                    status = "outdated"
        files.append(file_entry(path, workspace, status, previous))

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
    else:
        compatibility = {"compatible": True, "needRebuild": False, "reason": "未提供当前模型配置，仅返回文件状态。"}
        persist_dir = get_persist_dir(workspace, request.vector_store_path or ".looma/rag-index")
        vector_exists = persist_dir.exists()

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


def mark_all_scanned_indexed(request: IndexRequest, build_result: dict[str, Any]) -> dict[str, Any]:
    workspace = Path(request.workspace.workspace_path).expanduser().resolve()
    manifest = load_manifest(workspace)
    scanned, _ignored = scan_workspace(workspace)
    files: dict[str, Any] = {}
    workspace_id = workspace_id_for_path(workspace)
    indexed_at = now_iso()
    for path in scanned:
        entry = file_entry(path, workspace, "indexed")
        chunk_count = estimate_chunk_count(path, request.knowledge.chunk_size)
        entry["chunkCount"] = chunk_count
        entry["chunkIds"] = chunk_ids(workspace_id, entry["path"], entry.get("contentHash") or "", chunk_count)
        entry["lastIndexedAt"] = indexed_at
        entry["error"] = None
        files[entry["path"]] = entry
    manifest["files"] = files
    save_manifest(workspace, manifest)

    total_chunks = sum(int(item.get("chunkCount") or 0) for item in files.values())
    metadata = current_metadata(request, workspace)
    metadata["lastBuild"] = {
        "indexedAt": indexed_at,
        "documentCount": build_result.get("document_count", len(scanned)),
        "fileCount": build_result.get("file_count", len(scanned)),
        "chunkCount": total_chunks,
        "status": build_result.get("status", "ok"),
        "embeddingProvider": metadata.get("embedding", {}).get("provider"),
        "embeddingModel": metadata.get("embedding", {}).get("model"),
        "chunkSize": metadata.get("chunking", {}).get("chunkSize"),
        "chunkOverlap": metadata.get("chunking", {}).get("chunkOverlap"),
        "parserType": metadata.get("parser", {}).get("type"),
        "parserVersion": metadata.get("parser", {}).get("version"),
    }
    save_metadata(workspace, metadata)
    build_result["chunk_count"] = total_chunks
    build_result["metadata"] = metadata
    return build_result


def clear_vector_store(request: IndexRequest) -> None:
    workspace = Path(request.workspace.workspace_path).expanduser().resolve()
    persist_dir = get_persist_dir(workspace, request.knowledge.vector_store_path)
    if persist_dir.exists():
        shutil.rmtree(persist_dir)


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

    if mode == "full" or status_before.get("needRebuild"):
        clear_vector_store(request)
    elif mode == "incremental" and not status_before.get("needRebuild") and targets:
        # Per-file incremental: delete outdated vectors and rebuild them alongside new files.
        # For simplicity (and correctness) we still call the full build_vector_index which
        # creates a fresh index with doc_id-tagged documents.  The doc_id ensures future
        # single-file deletes work.
        pass

    try:
        build_result = build_vector_index(request)
    except Exception as exc:
        manifest = load_manifest(workspace)
        for item in targets:
            rel = item.get("path")
            if not rel or item.get("status") == "deleted":
                continue
            failed = dict(item)
            failed["status"] = "failed"
            failed["error"] = str(exc)
            manifest.setdefault("files", {})[rel] = failed
        save_manifest(workspace, manifest)
        raise

    mark_all_scanned_indexed(request, build_result)
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
    result = await asyncio.to_thread(build_managed_index, request, mode)
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

    # Physically remove vectors from the vector store
    removed = _remove_doc_vectors(workspace, persist_dir, doc_id)

    # Remove from manifest
    manifest = load_manifest(workspace)
    existed = rel in manifest.get("files", {})
    manifest.get("files", {}).pop(rel, None)
    save_manifest(workspace, manifest)

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

    if request.ai_config and request.ai_config.embedding:
        configure_llama_index(request.ai_config.embedding, knowledge.chunk_size, knowledge.chunk_overlap)

    from llama_index.core import StorageContext, load_index_from_storage

    storage_context = StorageContext.from_defaults(persist_dir=str(persist_dir))
    index = load_index_from_storage(storage_context)
    vector_store_obj = index._vector_store if hasattr(index, "_vector_store") else getattr(index, "vector_store", None)
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

    cleared = False
    if persist_dir.exists():
        shutil.rmtree(persist_dir)
        cleared = True

    manifest_file = manifest_path(workspace)
    if manifest_file.exists():
        manifest_file.unlink()

    metadata_file = metadata_path(workspace)
    if metadata_file.exists():
        metadata_file.unlink()

    return {
        "success": True,
        "status": "ok",
        "cleared": cleared,
        "persist_dir": str(persist_dir),
    }


def reindex_file(request: IndexBuildRequest) -> dict[str, Any]:
    if not request.path:
        raise ValueError("path is required")

    workspace = Path(request.workspace.workspace_path).expanduser().resolve()
    rel = request.path.strip().replace("\\", "/")
    file_path = workspace / rel

    if not file_path.exists():
        raise ValueError(f"文件不存在：{rel}")

    knowledge = request.knowledge or KnowledgeConfig()
    vector_store = knowledge.vector_store_path or ".looma/rag-index"
    persist_dir = get_persist_dir(workspace, vector_store)
    doc_id = file_doc_id(workspace, rel)

    # Delete old vectors for this file
    _remove_doc_vectors(workspace, persist_dir, doc_id)

    # Ensure embedding is configured
    if not request.ai_config or not request.ai_config.embedding:
        raise ValueError("ai_config.embedding is required for reindex")

    index_request = IndexRequest(workspace=request.workspace, knowledge=request.knowledge, ai_config=request.ai_config)
    configure_llama_index(request.ai_config.embedding, knowledge.chunk_size, knowledge.chunk_overlap)

    # Insert new vectors
    chunks = _insert_doc_vectors(workspace, persist_dir, file_path, index_request)

    # Update manifest
    manifest = load_manifest(workspace)
    entry = file_entry(file_path, workspace, "indexed")
    entry["chunkCount"] = chunks
    entry["chunkIds"] = chunk_ids(workspace_id_for_path(workspace), rel, entry.get("contentHash") or "", chunks)
    entry["lastIndexedAt"] = now_iso()
    entry["error"] = None
    manifest["files"][rel] = entry
    save_manifest(workspace, manifest)

    return {
        "success": True,
        "status": "ok",
        "path": rel,
        "chunks": chunks,
        "document_count": 1,
    }
