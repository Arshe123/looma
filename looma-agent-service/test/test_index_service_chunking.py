import unittest

from schemas import KnowledgeConfig

try:
    from llama_index.core import Settings
    from llama_index.core.node_parser import MarkdownNodeParser, SentenceSplitter
except Exception:  # pragma: no cover - lightweight CI env may not install llama-index
    Settings = None
    MarkdownNodeParser = None
    SentenceSplitter = None

from rag.index_service import make_node_transformations, split_sentences


class BuiltinSentenceSplitterTest(unittest.TestCase):
    def test_preserves_chinese_english_and_newline_boundaries(self):
        text = "第一句。第二句！\nThird sentence. Fourth line"

        sentences = split_sentences(text)

        self.assertEqual("".join(sentences), text)
        self.assertEqual(sentences, ["第一句。", "第二句！", "\n", "Third sentence. ", "Fourth line"])


@unittest.skipIf(Settings is None, "llama-index is not installed in this Python environment")
class LlamaIndexChunkingStrategyTest(unittest.TestCase):
    def test_markdown_strategy_configures_markdown_then_sentence_transformations(self):
        knowledge = KnowledgeConfig(chunking_strategy="markdown", chunk_size=512, chunk_overlap=64)

        transformations = make_node_transformations(knowledge)

        assert MarkdownNodeParser is not None and SentenceSplitter is not None
        self.assertIsInstance(transformations[0], MarkdownNodeParser)
        splitter = transformations[1]
        assert isinstance(splitter, SentenceSplitter)
        self.assertEqual(splitter.chunk_size, 512)
        self.assertEqual(splitter.chunk_overlap, 64)

    def test_fixed_strategy_uses_single_sentence_splitter(self):
        knowledge = KnowledgeConfig(chunking_strategy="fixed", chunk_size=256, chunk_overlap=32)

        transformations = make_node_transformations(knowledge)

        self.assertEqual(len(transformations), 1)
        assert SentenceSplitter is not None
        splitter = transformations[0]
        assert isinstance(splitter, SentenceSplitter)
        self.assertEqual(splitter.chunk_size, 256)
        self.assertEqual(splitter.chunk_overlap, 32)
        self.assertIs(splitter._chunking_tokenizer_fn, split_sentences)


if __name__ == "__main__":
    unittest.main()
