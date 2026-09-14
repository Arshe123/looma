import unittest
from typing import Any
from unittest import mock

import httpx

from providers.base import ProviderConnectionError
from providers.ollama_provider import OllamaEmbeddingProvider, translate_ollama_error
from schemas import EmbeddingModelConfig


def _fake_status_error(status_code: int, url: str = "http://127.0.0.1:11434/api/embed") -> httpx.HTTPStatusError:
    request = httpx.Request("POST", url)
    response = httpx.Response(status_code, request=request, json={"error": "boom"})
    return httpx.HTTPStatusError("Ollama request failed", request=request, response=response)


class TranslateOllamaErrorTest(unittest.TestCase):
    def test_connection_refused_has_friendly_message(self):
        exc = httpx.ConnectError("Connection refused", request=httpx.Request("POST", "http://127.0.0.1:11434/api/embed"))

        translated = translate_ollama_error(exc, base_url="http://127.0.0.1:11434", model="bge-m3")

        self.assertIsInstance(translated, ProviderConnectionError)
        self.assertEqual(translated.code, "ollama_connection_refused")
        self.assertIn("无法连接本地模型服务", translated.message)
        self.assertIn("127.0.0.1:11434", translated.technical_detail)

    def test_502_bad_gateway_is_translated(self):
        exc = _fake_status_error(502)

        translated = translate_ollama_error(exc, base_url="http://127.0.0.1:11434", model="bge-m3")

        self.assertEqual(translated.code, "ollama_bad_gateway")
        self.assertIn("暂时无法响应", translated.message)
        self.assertIn("502", translated.technical_detail)

    def test_404_model_missing_names_the_model(self):
        exc = _fake_status_error(404)

        translated = translate_ollama_error(exc, base_url="http://127.0.0.1:11434", model="bge-m3")

        self.assertEqual(translated.code, "ollama_model_not_found")
        self.assertIn("bge-m3", translated.message)

    def test_500_model_load_failed_is_translated(self):
        exc = _fake_status_error(500)

        translated = translate_ollama_error(exc, base_url="http://127.0.0.1:11434", model="bge-m3")

        self.assertEqual(translated.code, "ollama_model_load_failed")
        self.assertIn("加载模型失败", translated.message)

    def test_timeout_is_translated(self):
        exc = httpx.ReadTimeout("timed out", request=httpx.Request("POST", "http://127.0.0.1:11434/api/embed"))

        translated = translate_ollama_error(exc, base_url="http://127.0.0.1:11434", model="bge-m3")

        self.assertEqual(translated.code, "ollama_timeout")
        self.assertIn("超时", translated.message)

    def test_generic_exception_falls_back(self):
        translated = translate_ollama_error(
            RuntimeError("weird"), base_url="http://127.0.0.1:11434", model="bge-m3"
        )

        self.assertEqual(translated.code, "provider_unavailable")
        self.assertIn("调用失败", translated.message)


class _FakeStatusResponse:
    def __init__(self, status_code: int):
        self.status_code = status_code

    def raise_for_status(self):
        request = httpx.Request("POST", "http://127.0.0.1:11434/api/embed")
        raise httpx.HTTPStatusError(
            "Ollama request failed", request=request, response=httpx.Response(self.status_code, request=request)
        )

    def json(self):
        return {"error": "boom"}


class _FakeEmbeddingClient:
    def __init__(self, *args, **kwargs):
        self.response: Any = None

    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc, tb):
        return False

    async def post(self, url, json):
        return self.response


class OllamaEmbeddingErrorTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.provider = OllamaEmbeddingProvider(EmbeddingModelConfig(
            provider="ollama",
            model="bge-m3",
            base_url="http://127.0.0.1:11434",
        ))
        self.fake_client = _FakeEmbeddingClient()

    async def test_embed_documents_502_raises_friendly_provider_error(self):
        self.fake_client.response = _FakeStatusResponse(502)

        with mock.patch("providers.ollama_provider.httpx.AsyncClient", lambda *a, **kw: self.fake_client):
            with self.assertRaises(ProviderConnectionError) as ctx:
                await self.provider.embed_documents(["hello"])

        self.assertEqual(ctx.exception.code, "ollama_bad_gateway")
        self.assertIn("暂时无法响应", str(ctx.exception))

    async def test_embed_documents_connection_error_raises_friendly_provider_error(self):
        async def _raise_connect(url, json):
            raise httpx.ConnectError(
                "Connection refused", request=httpx.Request("POST", "http://127.0.0.1:11434/api/embed")
            )

        self.fake_client.post = _raise_connect

        with mock.patch("providers.ollama_provider.httpx.AsyncClient", lambda *a, **kw: self.fake_client):
            with self.assertRaises(ProviderConnectionError) as ctx:
                await self.provider.embed_documents(["hello"])

        self.assertEqual(ctx.exception.code, "ollama_connection_refused")
        self.assertIn("无法连接本地模型服务", str(ctx.exception))


if __name__ == "__main__":
    unittest.main()
