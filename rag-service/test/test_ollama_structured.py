import unittest
from unittest.mock import patch

from providers.ollama_provider import OllamaChatProvider
from schemas import ChatMessage, ChatModelConfig


class _FakeResponse:
    def raise_for_status(self):
        return None

    def json(self):
        return {
            "message": {"content": '{"type":"final","answer":"ok"}'},
            "done_reason": "stop",
        }


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
            temperature=0.7,
            max_tokens=4096,
        ))

        with patch("providers.ollama_provider.httpx.AsyncClient", _FakeAsyncClient):
            decision = await provider.complete_structured(
                [ChatMessage(role="user", content="list files")],
                [],
            )

        self.assertEqual(decision.answer, "ok")
        self.assertEqual(len(_FakeAsyncClient.payloads), 1)
        payload = _FakeAsyncClient.payloads[0]
        self.assertEqual(payload.get("format"), "json")
        self.assertIs(payload.get("think"), False)
        self.assertEqual(payload["options"]["temperature"], 0.2)
        self.assertEqual(payload["options"]["num_predict"], 4096)
        self.assertEqual(decision._provider_state["finish_reason"], "stop")

    async def test_ordinary_chat_keeps_thinking_setting_unspecified(self):
        provider = OllamaChatProvider(ChatModelConfig(
            provider="ollama",
            model="qwen3.5:9b",
            base_url="http://127.0.0.1:11434",
            temperature=0.7,
        ))

        with patch("providers.ollama_provider.httpx.AsyncClient", _FakeAsyncClient):
            await provider.chat([ChatMessage(role="user", content="hello")])

        payload = _FakeAsyncClient.payloads[0]
        self.assertNotIn("format", payload)
        self.assertNotIn("think", payload)
        self.assertEqual(payload["options"]["temperature"], 0.7)


if __name__ == "__main__":
    unittest.main()
