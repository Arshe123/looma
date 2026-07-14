import builtins
import json
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import patch

from pydantic import ValidationError

from agent.tools.base import AgentToolContext, validate_tool_args
from agent.tools.rag_search import RagSearchArgs, RagSearchTool
from agent.tools.registry import ToolRegistry
from rag.index_manager import CorruptIndexError
from rag.query_service import IndexMissingError, load_index
from schemas import (
    AIConfig,
    ChatModelConfig,
    EmbeddingModelConfig,
    KnowledgeConfig,
    RagQueryRequest,
    WorkspaceContext,
)


def make_ai_config(api_key="super-secret"):
    return AIConfig(
        chat=ChatModelConfig(provider="openai", model="chat", api_key=api_key),
        embedding=EmbeddingModelConfig(provider="openai", model="embed", api_key=api_key),
    )


def make_context(workspace, *, top_k=5, ai_config=None, knowledge=None):
    return AgentToolContext(
        workspace_path=workspace,
        ai_config=ai_config or make_ai_config(),
        knowledge=knowledge or KnowledgeConfig(top_k=top_k),
    )


class RagSearchArgsTest(unittest.TestCase):
    def test_accepts_non_empty_query_and_top_k_boundaries(self):
        self.assertEqual(validate_tool_args(RagSearchArgs, {"query": "needle", "top_k": 1}).top_k, 1)
        self.assertEqual(validate_tool_args(RagSearchArgs, {"query": "needle", "top_k": 50}).top_k, 50)
        self.assertIsNone(validate_tool_args(RagSearchArgs, {"query": "needle"}).top_k)

    def test_rejects_empty_query_and_out_of_range_top_k(self):
        for arguments in (
            {"query": ""},
            {"query": "needle", "top_k": 0},
            {"query": "needle", "top_k": 51},
            {"query": "needle", "unexpected": True},
        ):
            with self.subTest(arguments=arguments), self.assertRaises(ValidationError):
                validate_tool_args(RagSearchArgs, arguments)


class RagSearchToolTest(unittest.IsolatedAsyncioTestCase):
    async def _search_metadata(self, workspace, metadata):
        async def retrieve(_request):
            return [{"score": 1.0, "text": "hit", "metadata": metadata}]

        result = await RagSearchTool(retriever=retrieve).execute(
            make_context(workspace), RagSearchArgs(query="needle")
        )
        return result["sources"][0]["metadata"]

    async def test_builds_canonical_request_and_overrides_top_k_without_mutation(self):
        captured = []

        async def retrieve(request):
            captured.append(request)
            return []

        knowledge = KnowledgeConfig(top_k=7, chunk_size=512)
        context = make_context("C:\\workspace", knowledge=knowledge)
        result = await RagSearchTool(retriever=retrieve).execute(
            context, RagSearchArgs(query="needle", top_k=3)
        )

        self.assertEqual(result["status"], "no_results")
        self.assertEqual(len(captured), 1)
        request = captured[0]
        self.assertIsInstance(request, RagQueryRequest)
        self.assertEqual(request.question, "needle")
        self.assertEqual(request.workspace.workspace_path, "C:\\workspace")
        self.assertIs(request.ai_config, context.ai_config)
        self.assertEqual(request.knowledge.top_k, 3)
        self.assertEqual(request.knowledge.chunk_size, 512)
        self.assertEqual(context.knowledge.top_k, 7)
        self.assertIsNot(request.knowledge, context.knowledge)

    async def test_success_normalizes_all_workspace_path_aliases(self):
        async def retrieve(_request):
            return [
                {
                    "score": 0.9,
                    "text": "matched text",
                    "metadata": {
                        "file_path": "C:\\workspace\\docs\\guide.md",
                        "title": "Guide",
                    },
                }
            ]

        result = await RagSearchTool(retriever=retrieve).execute(
            make_context("C:\\workspace"), RagSearchArgs(query="needle")
        )

        self.assertEqual(result["status"], "ok")
        self.assertEqual(result["query"], "needle")
        self.assertEqual(result["count"], 1)
        source = result["sources"][0]
        self.assertEqual(source["score"], 0.9)
        self.assertEqual(source["text"], "matched text")
        self.assertEqual(source["metadata"]["source"], "docs/guide.md")
        self.assertEqual(source["metadata"]["path"], "docs/guide.md")
        self.assertEqual(source["metadata"]["file_path"], "docs/guide.md")
        self.assertEqual(source["metadata"]["title"], "Guide")
        serialized = json.dumps(result).replace("\\\\", "\\")
        self.assertNotIn(r"C:\workspace", serialized)

    async def test_unsafe_absolute_sources_are_omitted(self):
        cases = (
            (r"C:\workspace", {"source": r"D:\secret\a.md"}),
            (r"C:\workspace", {"file_path": r"D:\secret\a.md"}),
            (r"C:\workspace", {"source": r"C:\secret\a.md"}),
            ("/workspace", {"source": "/etc/passwd"}),
        )

        for workspace, original in cases:
            with self.subTest(workspace=workspace, metadata=original):
                metadata = await self._search_metadata(workspace, original)
                self.assertNotIn("source", metadata)
                self.assertNotIn("path", metadata)
                self.assertNotIn("file_path", metadata)
                serialized = json.dumps(metadata).replace("\\\\", "\\")
                for absolute_prefix in (r"C:\workspace", r"D:\secret", "/etc/passwd"):
                    self.assertNotIn(absolute_prefix, serialized)

    async def test_result_json_contains_no_absolute_path_prefixes(self):
        async def retrieve(_request):
            return [
                {
                    "text": "windows",
                    "metadata": {"source": r"D:\secret\a.md", "title": "Secret"},
                },
                {
                    "text": "workspace",
                    "metadata": {"file_path": r"C:\workspace\docs\guide.md"},
                },
                {
                    "text": "posix",
                    "metadata": {"path": "/etc/passwd"},
                },
            ]

        result = await RagSearchTool(retriever=retrieve).execute(
            make_context(r"C:\workspace"), RagSearchArgs(query="needle")
        )

        serialized = json.dumps(result).replace("\\\\", "\\")
        for absolute_prefix in (r"C:\workspace", r"D:\secret", "/etc/passwd"):
            self.assertNotIn(absolute_prefix, serialized)
        self.assertEqual(result["sources"][0]["metadata"]["title"], "Secret")

    async def test_mismatched_absolute_path_styles_are_omitted(self):
        cases = (
            (r"C:\workspace", "/workspace/docs/a.md"),
            ("/workspace", r"C:\workspace\docs\a.md"),
        )

        for workspace, source in cases:
            with self.subTest(workspace=workspace, source=source):
                metadata = await self._search_metadata(workspace, {"source": source})
                self.assertNotIn("source", metadata)
                self.assertNotIn("path", metadata)
                self.assertNotIn("file_path", metadata)

    async def test_unsafe_relative_and_drive_relative_sources_are_omitted(self):
        for source in ("../secret.md", "docs/../secret.md", r"C:secret.md"):
            with self.subTest(source=source):
                metadata = await self._search_metadata(r"C:\workspace", {"source": source})
                self.assertNotIn("source", metadata)
                self.assertNotIn("path", metadata)
                self.assertNotIn("file_path", metadata)

    async def test_unsafe_source_falls_back_to_safe_workspace_file_path(self):
        metadata = await self._search_metadata(
            r"C:\workspace",
            {
                "source": r"D:\secret\a.md",
                "file_path": r"C:\workspace\docs\safe.md",
            },
        )

        self.assertEqual(metadata["source"], "docs/safe.md")
        self.assertEqual(metadata["path"], "docs/safe.md")
        self.assertEqual(metadata["file_path"], "docs/safe.md")
        serialized = json.dumps(metadata).replace("\\\\", "\\")
        self.assertNotIn(r"C:\workspace", serialized)
        self.assertNotIn(r"D:\secret", serialized)

    async def test_uses_first_safe_candidate_after_rejecting_unsafe_source(self):
        metadata = await self._search_metadata(
            r"C:\workspace",
            {
                "source": r"D:\secret\a.md",
                "path": "docs/from-path.md",
                "file_path": r"C:\workspace\docs\from-file-path.md",
            },
        )

        self.assertEqual(metadata["source"], "docs/from-path.md")
        self.assertEqual(metadata["path"], "docs/from-path.md")
        self.assertEqual(metadata["file_path"], "docs/from-path.md")
        serialized = json.dumps(metadata).replace("\\\\", "\\")
        self.assertNotIn(r"C:\workspace", serialized)
        self.assertNotIn(r"D:\secret", serialized)

    async def test_safe_relative_source_remains_posix(self):
        metadata = await self._search_metadata(r"C:\workspace", {"source": r"docs\a.md"})

        self.assertEqual(metadata["source"], "docs/a.md")
        self.assertEqual(metadata["path"], "docs/a.md")
        self.assertEqual(metadata["file_path"], "docs/a.md")

    async def test_no_results_returns_normal_observation(self):
        async def retrieve(_request):
            return []

        result = await RagSearchTool(retriever=retrieve).execute(
            make_context("."), RagSearchArgs(query="nothing")
        )

        self.assertEqual(
            result,
            {"status": "no_results", "query": "nothing", "count": 0, "sources": []},
        )

    async def test_missing_config_returns_serializable_observation_without_secret(self):
        called = False

        async def retrieve(_request):
            nonlocal called
            called = True
            return []

        context = AgentToolContext(
            workspace_path=".",
            ai_config=AIConfig(
                chat=ChatModelConfig(provider="openai", model="chat", api_key="do-not-leak"),
                embedding=None,
            ),
            knowledge=None,
        )
        result = await RagSearchTool(retriever=retrieve).execute(
            context, RagSearchArgs(query="needle")
        )

        self.assertEqual(result["status"], "config_missing")
        self.assertEqual(result["count"], 0)
        self.assertEqual(result["sources"], [])
        self.assertFalse(called)
        self.assertNotIn("do-not-leak", json.dumps(result))

    async def test_missing_index_is_a_normal_observation(self):
        async def retrieve(_request):
            raise IndexMissingError("private absolute index path")

        result = await RagSearchTool(retriever=retrieve).execute(
            make_context("."), RagSearchArgs(query="needle")
        )

        self.assertEqual(result["status"], "index_missing")
        self.assertEqual(result["count"], 0)
        self.assertEqual(result["sources"], [])
        self.assertIn("索引", result["message"])
        self.assertNotIn("private absolute", result["message"])

    async def test_corrupt_index_requires_full_rebuild(self):
        async def retrieve(_request):
            raise CorruptIndexError(Path("private-index"), "secret detail")

        result = await RagSearchTool(retriever=retrieve).execute(
            make_context("."), RagSearchArgs(query="needle")
        )

        self.assertEqual(result["status"], "corrupt_index")
        self.assertTrue(result["requiresRebuild"])
        self.assertEqual(result["sources"], [])
        self.assertIn("全量重建", result["message"])
        self.assertNotIn("secret detail", json.dumps(result))

    async def test_generic_file_not_found_error_propagates(self):
        async def retrieve(_request):
            raise FileNotFoundError("unrelated file missing")

        with self.assertRaisesRegex(FileNotFoundError, "unrelated file missing"):
            await RagSearchTool(retriever=retrieve).execute(
                make_context("."), RagSearchArgs(query="needle")
            )

    async def test_generic_json_decode_error_propagates(self):
        async def retrieve(_request):
            raise json.JSONDecodeError("bad", "{", 0)

        with self.assertRaises(json.JSONDecodeError):
            await RagSearchTool(retriever=retrieve).execute(
                make_context("."), RagSearchArgs(query="needle")
            )

    async def test_unexpected_exception_propagates(self):
        async def retrieve(_request):
            raise RuntimeError("backend exploded")

        with self.assertRaisesRegex(RuntimeError, "backend exploded"):
            await RagSearchTool(retriever=retrieve).execute(
                make_context("."), RagSearchArgs(query="needle")
            )

    async def test_registers_and_executes_through_registry(self):
        async def retrieve(_request):
            return [{"score": 1.0, "text": "hit", "metadata": {"source": "docs/a.md"}}]

        registry = ToolRegistry()
        tool = RagSearchTool(retriever=retrieve)
        registry.register(tool)
        result = await registry.execute(
            "rag_search",
            make_context("."),
            {"query": "needle"},
            enabled_tools={"rag_search"},
        )

        self.assertEqual(tool.name, "rag_search")
        self.assertEqual(tool.risk_level, "read")
        self.assertTrue(result.success)
        self.assertEqual(result.data["status"], "ok")
        self.assertEqual(result.data["sources"][0]["metadata"]["path"], "docs/a.md")


class QueryServiceEarlyCheckTest(unittest.TestCase):
    def _request(self, workspace, vector_store_path=".looma/rag-index"):
        return RagQueryRequest(
            question="needle",
            workspace=WorkspaceContext(workspace_path=str(workspace)),
            ai_config=make_ai_config(),
            knowledge=KnowledgeConfig(vector_store_path=vector_store_path),
        )

    @staticmethod
    def _reject_llama_import(original_import):
        def guarded_import(name, *args, **kwargs):
            if name == "llama_index" or name.startswith("llama_index."):
                raise AssertionError("llama_index imported before early index checks")
            return original_import(name, *args, **kwargs)

        return guarded_import

    def test_missing_index_is_detected_before_llama_index_import(self):
        with tempfile.TemporaryDirectory() as workspace:
            original_import = builtins.__import__
            with patch("builtins.__import__", side_effect=self._reject_llama_import(original_import)):
                with self.assertRaises(IndexMissingError):
                    load_index(self._request(workspace))

    def test_corrupt_index_is_detected_before_llama_index_import(self):
        with tempfile.TemporaryDirectory() as workspace:
            persist_dir = Path(workspace) / ".looma" / "rag-index"
            persist_dir.mkdir(parents=True)
            for filename in ("index_store.json", "docstore.json", "default__vector_store.json"):
                (persist_dir / filename).write_text("{}", encoding="utf-8")
            (persist_dir / "docstore.json").write_text("{broken", encoding="utf-8")

            original_import = builtins.__import__
            with patch("builtins.__import__", side_effect=self._reject_llama_import(original_import)):
                with self.assertRaises(CorruptIndexError):
                    load_index(self._request(workspace))

    def test_unicode_corruption_is_wrapped_before_llama_index_import(self):
        with tempfile.TemporaryDirectory() as workspace:
            persist_dir = Path(workspace) / ".looma" / "rag-index"
            persist_dir.mkdir(parents=True)
            with (
                patch("rag.query_service.has_index", return_value=True),
                patch(
                    "rag.query_service._validate_persisted_index_json",
                    side_effect=UnicodeDecodeError("utf-8", b"\xff", 0, 1, "invalid"),
                ),
            ):
                with self.assertRaises(CorruptIndexError) as raised:
                    load_index(self._request(workspace))
            self.assertIsInstance(raised.exception.__cause__, UnicodeDecodeError)


class QueryServiceLoadFailureTest(unittest.TestCase):
    def _request(self, workspace):
        return RagQueryRequest(
            question="needle",
            workspace=WorkspaceContext(workspace_path=str(workspace)),
            ai_config=make_ai_config(),
            knowledge=KnowledgeConfig(),
        )

    @staticmethod
    def _fake_llama_module(*, storage_error=None, load_error=None):
        core = types.ModuleType("llama_index.core")

        class StorageContext:
            @staticmethod
            def from_defaults(**_kwargs):
                if storage_error is not None:
                    raise storage_error
                return object()

        def load_index_from_storage(_storage_context):
            if load_error is not None:
                raise load_error
            return object()

        core.StorageContext = StorageContext
        core.load_index_from_storage = load_index_from_storage
        package = types.ModuleType("llama_index")
        package.core = core
        return {"llama_index": package, "llama_index.core": core}

    def test_structural_value_error_from_index_loading_is_wrapped(self):
        with tempfile.TemporaryDirectory() as workspace:
            fake_modules = self._fake_llama_module(load_error=ValueError("bad persisted shape"))
            with (
                patch("rag.query_service.has_index", return_value=True),
                patch("rag.query_service.validate_persisted_index_json"),
                patch("rag.query_service.configure_llama_index"),
                patch.dict(sys.modules, fake_modules),
                self.assertRaises(CorruptIndexError) as raised,
            ):
                load_index(self._request(workspace))
            self.assertIn("bad persisted shape", raised.exception.detail)

    def test_configure_value_error_is_not_misclassified_as_corruption(self):
        with tempfile.TemporaryDirectory() as workspace:
            fake_modules = self._fake_llama_module()
            with (
                patch("rag.query_service.has_index", return_value=True),
                patch("rag.query_service.validate_persisted_index_json"),
                patch("rag.query_service.configure_llama_index", side_effect=ValueError("bad provider config")),
                patch.dict(sys.modules, fake_modules),
                self.assertRaisesRegex(ValueError, "bad provider config"),
            ):
                load_index(self._request(workspace))


if __name__ == "__main__":
    unittest.main()
