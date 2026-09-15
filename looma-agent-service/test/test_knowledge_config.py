import unittest
from unittest.mock import patch

from pydantic import ValidationError

from config import with_global_knowledge_config
from schemas import KnowledgeConfig


class KnowledgeConfigMergeTest(unittest.TestCase):
    def setUp(self):
        self.global_config = KnowledgeConfig(
            vector_store_path="global/index",
            top_k=12,
            include_sources=False,
            rerank=True,
            chunk_size=1024,
            chunk_overlap=128,
            chunking_strategy="markdown",
        )
        loader = patch("config.load_global_knowledge_config", return_value=self.global_config)
        self.loader = loader.start()
        self.addCleanup(loader.stop)

    def test_partial_request_overrides_only_explicit_field(self):
        request = KnowledgeConfig(top_k=7)

        result = with_global_knowledge_config(request)

        expected = self.global_config.model_dump()
        expected["top_k"] = 7
        self.assertEqual(result.model_dump(), expected)
        self.loader.assert_called_once_with()

    def test_none_request_returns_global_config(self):
        self.assertIs(with_global_knowledge_config(), self.global_config)
        self.loader.assert_called_once_with()

    def test_empty_request_inherits_all_global_fields_in_new_model(self):
        request = KnowledgeConfig()

        result = with_global_knowledge_config(request)

        self.assertEqual(result.model_dump(), self.global_config.model_dump())
        self.assertIsNot(result, request)
        self.assertIsNot(result, self.global_config)

    def test_each_explicit_schema_default_overrides_only_that_field(self):
        for field, value in KnowledgeConfig().model_dump().items():
            with self.subTest(field=field, value=value):
                request = KnowledgeConfig(**{field: value})
                expected = self.global_config.model_dump()
                expected[field] = value

                result = with_global_knowledge_config(request)

                self.assertEqual(result.model_dump(), expected)

    def test_explicit_false_and_zero_are_not_discarded(self):
        self.global_config.include_sources = True
        request = KnowledgeConfig(include_sources=False, rerank=False, chunk_overlap=0)
        expected = self.global_config.model_dump()
        expected.update(include_sources=False, rerank=False, chunk_overlap=0)

        self.assertEqual(with_global_knowledge_config(request).model_dump(), expected)

    def test_merge_does_not_mutate_inputs(self):
        request = KnowledgeConfig(top_k=7)
        request_before = request.model_dump()
        fields_before = request.model_fields_set.copy()
        global_before = self.global_config.model_dump()

        result = with_global_knowledge_config(request)

        self.assertIsNot(result, request)
        self.assertIsNot(result, self.global_config)
        result.chunk_size = 2048
        self.assertEqual(request.model_dump(), request_before)
        self.assertEqual(request.model_fields_set, fields_before)
        self.assertEqual(self.global_config.model_dump(), global_before)

    def test_merged_config_is_validated(self):
        # Assignment does not validate by default; merging must validate again.
        request = KnowledgeConfig(top_k=7)
        request.top_k = 0

        with self.assertRaises(ValidationError) as raised:
            with_global_knowledge_config(request)

        self.assertEqual(raised.exception.errors()[0]["loc"], ("top_k",))

    def test_global_loading_errors_propagate_for_every_request_shape(self):
        for request in (None, KnowledgeConfig(), KnowledgeConfig(top_k=7)):
            for error in (ValueError("invalid global settings"), OSError("settings unreadable")):
                with self.subTest(request=request, error=type(error).__name__):
                    self.loader.side_effect = error

                    with self.assertRaises(type(error)) as raised:
                        with_global_knowledge_config(request)

                    self.assertIs(raised.exception, error)


if __name__ == "__main__":
    unittest.main()
