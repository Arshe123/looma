import unittest
from unittest.mock import patch

from providers.ollama_provider import OllamaChatProvider
from schemas import ChatMessage, ChatModelConfig


class _FakeResponse:
    def raise_for_status(self):
        return None

    def json(self):
        return {"message": {"content": '{"type":"final","answer":"ok"}'}}


class _FakeAsyncClient:
    payloads = []

    def __init__(self, *args, **kwargs):
        pass

    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc, tb):
        return False

    async def post(self, url, json):
        self.payloads.append(json)
        return _FakeResponse()


class OllamaStructuredCompletionTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        _FakeAsyncClient.payloads = []

    async def test_structured_completion_requests_native_json_mode(self):
        provider = OllamaChatProvider(ChatModelConfig(
            provider="ollama",
            model="qwen2.5:7b",
            base_url="http://127.0.0.1:11434",
        ))

        with patch("providers.ollama_provider.httpx.AsyncClient", _FakeAsyncClient):
            decision = await provider.complete_structured(
                [ChatMessage(role="user", content="list files")],
                [],
            )

        self.assertEqual(decision.answer, "ok")
        self.assertEqual(len(_FakeAsyncClient.payloads), 1)
        self.assertEqual(_FakeAsyncClient.payloads[0].get("format"), "json")


if __name__ == "__main__":
    unittest.main()
