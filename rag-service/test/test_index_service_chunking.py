import unittest

from schemas import EmbeddingModelConfig, KnowledgeConfig

try:
    from llama_index.core import Settings
    from llama_index.core.node_parser import MarkdownNodeParser, SentenceSplitter
except Exception:  # pragma: no cover - lightweight CI env may not install llama-index
    Settings = None
    MarkdownNodeParser = None
    SentenceSplitter = None

from rag.index_service import configure_llama_index


@unittest.skipIf(Settings is None, "llama-index is not installed in this Python environment")
class LlamaIndexChunkingStrategyTest(unittest.TestCase):
    def test_markdown_strategy_configures_markdown_then_sentence_transformations(self):
        embedding = EmbeddingModelConfig(provider="ollama", model="bge-m3:latest")
        knowledge = KnowledgeConfig(chunking_strategy="markdown", chunk_size=512, chunk_overlap=64)

        transformations = configure_llama_index(embedding, knowledge)

        self.assertIs(transformations[0], Settings.transformations[0])
        self.assertIsInstance(Settings.transformations[0], MarkdownNodeParser)
        self.assertIsInstance(Settings.transformations[1], SentenceSplitter)
        self.assertEqual(Settings.transformations[1].chunk_size, 512)
        self.assertEqual(Settings.transformations[1].chunk_overlap, 64)

    def test_fixed_strategy_uses_single_sentence_splitter(self):
        embedding = EmbeddingModelConfig(provider="ollama", model="bge-m3:latest")
        knowledge = KnowledgeConfig(chunking_strategy="fixed", chunk_size=256, chunk_overlap=32)

        transformations = configure_llama_index(embedding, knowledge)

        self.assertEqual(len(transformations), 1)
        self.assertIsInstance(Settings.transformations[0], SentenceSplitter)
        self.assertEqual(Settings.transformations[0].chunk_size, 256)
        self.assertEqual(Settings.transformations[0].chunk_overlap, 32)


if __name__ == "__main__":
    unittest.main()
