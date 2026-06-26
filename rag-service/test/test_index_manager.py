import json
import tempfile
import unittest
from pathlib import Path

from rag.index_manager import (
    CorruptIndexError,
    corrupt_index_response,
    file_doc_id,
    get_persisted_chunk_counts,
    load_metadata,
    normalize_relative_path,
    save_manifest,
    update_metadata_after_file_reindex,
    validate_persisted_index_json,
)
from schemas import AIConfig, ChatModelConfig, EmbeddingModelConfig, IndexRequest, KnowledgeConfig, WorkspaceContext


class IndexManagerRegressionTest(unittest.TestCase):
    def test_normalize_relative_path_keeps_doc_id_stable_on_windows_paths(self):
        workspace = Path("E:/workspace").resolve()
        rel_from_windows = normalize_relative_path("notes\\a.md")
        rel_from_posix = normalize_relative_path("notes/a.md")

        self.assertEqual(rel_from_windows, "notes/a.md")
        self.assertEqual(file_doc_id(workspace, rel_from_windows), file_doc_id(workspace, rel_from_posix))

    def test_validate_persisted_index_json_reports_corrupt_vector_store(self):
        with tempfile.TemporaryDirectory() as tmp:
            persist_dir = Path(tmp)
            (persist_dir / "index_store.json").write_text(json.dumps({"ok": True}), encoding="utf-8")
            (persist_dir / "docstore.json").write_text(json.dumps({"ok": True}), encoding="utf-8")
            (persist_dir / "default__vector_store.json").write_text('{"broken": ', encoding="utf-8")

            with self.assertRaises(CorruptIndexError) as ctx:
                validate_persisted_index_json(persist_dir)

            response = corrupt_index_response(ctx.exception, "notes/a.md")
            self.assertFalse(response["success"])
            self.assertEqual(response["status"], "corrupt_index")
            self.assertTrue(response["requiresRebuild"])
            self.assertIn("全量重建", response["error"])
            self.assertIn("default__vector_store.json", response["technicalDetail"])
    def test_full_build_manifest_counts_use_persisted_vector_nodes_not_estimates(self):
        with tempfile.TemporaryDirectory() as tmp:
            workspace = Path(tmp).resolve()
            persist_dir = workspace / ".looma" / "rag-index"
            persist_dir.mkdir(parents=True, exist_ok=True)
            rel_a = "notes/a.md"
            rel_b = "notes/b.md"
            doc_a = file_doc_id(workspace, rel_a)
            doc_b = file_doc_id(workspace, rel_b)
            (persist_dir / "index_store.json").write_text(json.dumps({"ok": True}), encoding="utf-8")
            (persist_dir / "docstore.json").write_text(json.dumps({"ok": True}), encoding="utf-8")
            (persist_dir / "default__vector_store.json").write_text(json.dumps({
                "embedding_dict": {"a1": [0.1], "a2": [0.2], "b1": [0.3]},
                "text_id_to_ref_doc_id": {"a1": doc_a, "a2": doc_a, "b1": doc_b},
                "metadata_dict": {
                    "a1": {"source": rel_a},
                    "a2": {"source": rel_a},
                    "b1": {"source": rel_b},
                },
            }), encoding="utf-8")

            counts = get_persisted_chunk_counts(workspace, persist_dir, [rel_a, rel_b])

            self.assertEqual(counts, {rel_a: 2, rel_b: 1})

    def test_full_build_manifest_counts_support_metadata_fallback_for_legacy_nodes(self):
        with tempfile.TemporaryDirectory() as tmp:
            workspace = Path(tmp).resolve()
            persist_dir = workspace / ".looma" / "rag-index"
            persist_dir.mkdir(parents=True, exist_ok=True)
            rel = "notes/a.md"
            (persist_dir / "index_store.json").write_text(json.dumps({"ok": True}), encoding="utf-8")
            (persist_dir / "docstore.json").write_text(json.dumps({"ok": True}), encoding="utf-8")
            (persist_dir / "default__vector_store.json").write_text(json.dumps({
                "embedding_dict": {"legacy-1": [0.1], "legacy-2": [0.2]},
                "text_id_to_ref_doc_id": {"legacy-1": "old-doc", "legacy-2": "old-doc"},
                "metadata_dict": {
                    "legacy-1": {"source": "notes\\a.md"},
                    "legacy-2": {"file_path": str(workspace / "notes" / "a.md")},
                },
            }), encoding="utf-8")

            counts = get_persisted_chunk_counts(workspace, persist_dir, [rel])

            self.assertEqual(counts, {rel: 2})

    def test_single_file_reindex_updates_index_metadata(self):
        with tempfile.TemporaryDirectory() as tmp:
            workspace = Path(tmp).resolve()
            previous_metadata_dir = workspace / ".looma" / "index"
            previous_metadata_dir.mkdir(parents=True, exist_ok=True)
            (previous_metadata_dir / "index_metadata.json").write_text(json.dumps({
                "createdAt": "2026-01-01T00:00:00Z",
                "lastBuild": {
                    "indexedAt": "2026-01-01T00:00:00Z",
                    "fileCount": 2,
                    "documentCount": 2,
                    "chunkCount": 9,
                    "status": "ok",
                },
            }), encoding="utf-8")
            save_manifest(workspace, {
                "version": 1,
                "workspaceId": "test-workspace",
                "files": {
                    "notes/a.md": {"path": "notes/a.md", "status": "indexed", "chunkCount": 3},
                    "notes/b.md": {"path": "notes/b.md", "status": "indexed", "chunkCount": 4},
                    "notes/c.md": {"path": "notes/c.md", "status": "failed", "chunkCount": 99},
                },
            })
            request = IndexRequest(
                workspace=WorkspaceContext(workspace_path=str(workspace)),
                knowledge=KnowledgeConfig(chunk_size=512, chunk_overlap=64),
                ai_config=AIConfig(
                    chat=ChatModelConfig(provider="ollama", model="qwen2.5"),
                    embedding=EmbeddingModelConfig(provider="ollama", model="nomic-embed-text", dimension=768),
                ),
            )

            metadata = update_metadata_after_file_reindex(request, workspace, "notes/a.md", 3, "2026-02-02T00:00:00Z")
            stored = load_metadata(workspace)

            self.assertEqual(stored, metadata)
            self.assertEqual(metadata["createdAt"], "2026-01-01T00:00:00Z")
            self.assertEqual(metadata["lastBuild"]["mode"], "single_file")
            self.assertEqual(metadata["lastBuild"]["indexedAt"], "2026-02-02T00:00:00Z")
            self.assertEqual(metadata["lastBuild"]["fileCount"], 2)
            self.assertEqual(metadata["lastBuild"]["documentCount"], 2)
            self.assertEqual(metadata["lastBuild"]["chunkCount"], 7)
            self.assertEqual(metadata["lastFileReindex"]["path"], "notes/a.md")
            self.assertEqual(metadata["lastFileReindex"]["chunkCount"], 3)
            self.assertEqual(metadata["previousLastBuild"]["chunkCount"], 9)


if __name__ == "__main__":
    unittest.main()
