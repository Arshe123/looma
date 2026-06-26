import json
import os
import tempfile
import unittest
from pathlib import Path

from config import load_global_knowledge_config
from rag.index_manager import current_metadata, validate_metadata_compatibility
from schemas import AIConfig, ChatModelConfig, EmbeddingModelConfig, IndexRequest, KnowledgeConfig, WorkspaceContext


class ChunkingStrategyRegressionTest(unittest.TestCase):
    def test_knowledge_config_accepts_markdown_chunking_strategy(self):
        knowledge = KnowledgeConfig(chunking_strategy="markdown")

        self.assertEqual(knowledge.chunking_strategy, "markdown")

    def test_global_settings_loads_markdown_chunking_strategy_from_camel_case(self):
        with tempfile.TemporaryDirectory() as tmp:
            settings_path = Path(tmp) / "settings.json"
            settings_path.write_text(json.dumps({
                "ai": {
                    "chunkingStrategy": "markdown",
                    "chunkSize": 512,
                    "chunkOverlap": 64,
                },
            }), encoding="utf-8")
            previous = os.environ.get("LOOMA_SETTINGS_PATH")
            os.environ["LOOMA_SETTINGS_PATH"] = str(settings_path)
            try:
                knowledge = load_global_knowledge_config()
            finally:
                if previous is None:
                    os.environ.pop("LOOMA_SETTINGS_PATH", None)
                else:
                    os.environ["LOOMA_SETTINGS_PATH"] = previous

        self.assertEqual(knowledge.chunking_strategy, "markdown")
        self.assertEqual(knowledge.chunk_size, 512)
        self.assertEqual(knowledge.chunk_overlap, 64)

    def test_index_metadata_records_chunking_strategy_and_detects_changes(self):
        with tempfile.TemporaryDirectory() as tmp:
            workspace = Path(tmp).resolve()
            ai_config = AIConfig(
                chat=ChatModelConfig(provider="ollama", model="qwen2.5"),
                embedding=EmbeddingModelConfig(provider="ollama", model="bge-m3", dimension=1024),
            )
            request = IndexRequest(
                workspace=WorkspaceContext(workspace_path=str(workspace)),
                knowledge=KnowledgeConfig(chunking_strategy="markdown", chunk_size=512, chunk_overlap=64),
                ai_config=ai_config,
            )

            metadata = current_metadata(request, workspace)
            stored = {
                **metadata,
                "chunking": {
                    **metadata["chunking"],
                    "strategy": "fixed",
                },
            }
            compatibility = validate_metadata_compatibility(metadata, stored)

        self.assertEqual(metadata["chunking"]["strategy"], "markdown")
        self.assertFalse(compatibility["compatible"])
        self.assertTrue(compatibility["needRebuild"])
        self.assertIn("chunking.strategy", compatibility["reason"])


if __name__ == "__main__":
    unittest.main()
