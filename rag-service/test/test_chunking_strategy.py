import json
import os
import tempfile
import unittest
from pathlib import Path

from config import default_ai_config, load_global_ai_config, load_global_knowledge_config
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

    def test_global_ai_config_ignores_removed_legacy_flat_provider_fields(self):
        with tempfile.TemporaryDirectory() as tmp:
            settings_path = Path(tmp) / "settings.json"
            settings_path.write_text(json.dumps({
                "ai": {
                    "llmProvider": "openai",
                    "llmModel": "legacy-chat-model",
                    "llmBaseUrl": "https://legacy-chat.example/v1",
                    "llmApiKey": "legacy-chat-key",
                    "temperature": 0.1,
                    "maxTokens": 4096,
                    "embedProvider": "qwen",
                    "embedModel": "legacy-embed-model",
                    "embedBaseUrl": "https://legacy-embed.example/v1",
                    "embedApiKey": "legacy-embed-key",
                    "embedDimensions": 1024,
                },
            }), encoding="utf-8")
            previous = os.environ.get("LOOMA_SETTINGS_PATH")
            os.environ["LOOMA_SETTINGS_PATH"] = str(settings_path)
            try:
                ai_config = load_global_ai_config()
            finally:
                if previous is None:
                    os.environ.pop("LOOMA_SETTINGS_PATH", None)
                else:
                    os.environ["LOOMA_SETTINGS_PATH"] = previous

        defaults = default_ai_config()
        self.assertEqual(ai_config, defaults)

    def test_global_ai_config_loads_current_nested_provider_fields(self):
        with tempfile.TemporaryDirectory() as tmp:
            settings_path = Path(tmp) / "settings.json"
            settings_path.write_text(json.dumps({
                "ai": {
                    "chat": {
                        "provider": "openai",
                        "model": "gpt-4o-mini",
                        "baseUrl": "https://api.openai.com/v1",
                        "apiKey": "chat-key",
                        "temperature": 0.2,
                        "maxTokens": 2048,
                    },
                    "embedding": {
                        "provider": "qwen",
                        "model": "text-embedding-v4",
                        "baseUrl": "https://dashscope.aliyuncs.com/compatible-mode/v1",
                        "apiKey": "embed-key",
                        "dimension": 1536,
                    },
                },
            }), encoding="utf-8")
            previous = os.environ.get("LOOMA_SETTINGS_PATH")
            os.environ["LOOMA_SETTINGS_PATH"] = str(settings_path)
            try:
                ai_config = load_global_ai_config()
            finally:
                if previous is None:
                    os.environ.pop("LOOMA_SETTINGS_PATH", None)
                else:
                    os.environ["LOOMA_SETTINGS_PATH"] = previous

        self.assertEqual(ai_config.chat.provider, "openai")
        self.assertEqual(ai_config.chat.model, "gpt-4o-mini")
        self.assertEqual(ai_config.chat.base_url, "https://api.openai.com/v1")
        self.assertEqual(ai_config.chat.api_key, "chat-key")
        self.assertEqual(ai_config.chat.temperature, 0.2)
        self.assertEqual(ai_config.chat.max_tokens, 2048)
        self.assertEqual(ai_config.embedding.provider, "qwen")
        self.assertEqual(ai_config.embedding.model, "text-embedding-v4")
        self.assertEqual(ai_config.embedding.base_url, "https://dashscope.aliyuncs.com/compatible-mode/v1")
        self.assertEqual(ai_config.embedding.api_key, "embed-key")
        self.assertEqual(ai_config.embedding.dimension, 1536)

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
