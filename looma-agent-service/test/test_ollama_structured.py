import unittest
from unittest.mock import patch

import httpx

from agent.models import AgentFinalAnswer, AgentInvalidToolCall, AgentToolBatch, AgentToolCall
from agent.decision_parser import AgentContextExhaustedError
from providers.ollama_provider import OllamaChatProvider, _ollama_chat_messages
from schemas import (
    ChatMessage,
    ChatModelConfig,
    ChatToolCall,
    ChatToolFunction,
)


class _FakeResponse:
    def __init__(self, data, status_code=200):
        self.data = data
        self.status_code = status_code

    def raise_for_status(self):
        if self.status_code >= 400:
            request = httpx.Request("POST", "http://127.0.0.1:11434/api/chat")
            response = httpx.Response(
                self.status_code,
                request=request,
                json=self.data,
            )
            raise httpx.HTTPStatusError(
                "Ollama request failed",
                request=request,
                response=response,
            )
        return None

    def json(self):
        return self.data


class _FakeAsyncClient:
    payloads = []
    responses = []

    def __init__(self, *args, **kwargs):
        pass

    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc, tb):
        return False

    async def post(self, url, json):
        self.payloads.append(json)
        if self.responses:
            value = self.responses.pop(0)
            if isinstance(value, tuple):
                status_code, data = value
                return _FakeResponse(data, status_code=status_code)
            return _FakeResponse(value)
        return _FakeResponse({
            "message": {"content": "ok"},
            "done_reason": "stop",
        })


class OllamaStructuredCompletionTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        _FakeAsyncClient.payloads = []
        _FakeAsyncClient.responses = []
        self.provider = OllamaChatProvider(ChatModelConfig(
            provider="ollama",
            model="qwen3.5:latest",
            base_url="http://127.0.0.1:11434",
            temperature=0.7,
            max_tokens=4096,
        ))

    async def test_structured_completion_uses_native_tools(self):
        _FakeAsyncClient.responses = [{
            "message": {
                "content": "",
                "tool_calls": [{
                    "id": "call_native_1",
                    "function": {
                        "name": "file_read",
                        "arguments": {"path": "notes/a.md"},
                    },
                }],
            },
            "done_reason": "stop",
        }]
        schemas = [{
            "name": "file_read",
            "description": "Read a file",
            "parameters": {
                "type": "object",
                "properties": {"path": {"type": "string"}},
                "required": ["path"],
                "additionalProperties": False,
            },
        }]

        with patch("providers.ollama_provider.httpx.AsyncClient", _FakeAsyncClient):
            decision = await self.provider.complete_structured(
                [ChatMessage(role="user", content="read notes")],
                schemas,
            )

        self.assertIsInstance(decision, AgentToolCall)
        self.assertEqual(decision.tool, "file_read")
        self.assertEqual(decision.arguments, {"path": "notes/a.md"})
        self.assertEqual(decision._provider_state["tool_call_id"], "call_native_1")
        payload = _FakeAsyncClient.payloads[0]
        self.assertNotIn("format", payload)
        self.assertIs(payload.get("think"), False)
        self.assertEqual(payload["options"]["temperature"], 0.2)
        self.assertEqual(payload["options"]["num_ctx"], 16_384)
        self.assertEqual(payload["options"]["num_predict"], 8_192)
        self.assertEqual(payload["tools"][0]["type"], "function")
        self.assertEqual(payload["tools"][0]["function"]["name"], "file_read")

    async def test_structured_completion_without_tools_returns_plain_final(self):
        _FakeAsyncClient.responses = [{
            "message": {"content": "任务已完成。"},
            "done_reason": "stop",
        }]

        with patch("providers.ollama_provider.httpx.AsyncClient", _FakeAsyncClient):
            decision = await self.provider.complete_structured(
                [ChatMessage(role="user", content="finish")],
                [],
            )

        self.assertIsInstance(decision, AgentFinalAnswer)
        self.assertEqual(decision.answer, "任务已完成。")
        self.assertNotIn("tools", _FakeAsyncClient.payloads[0])
        self.assertNotIn("format", _FakeAsyncClient.payloads[0])

    async def test_ollama_http_500_retries_as_repairable_agent_response(self):
        _FakeAsyncClient.responses = [
            (500, {"error": "qwen3.5 tool call parsing failed"}),
            {
                "message": {
                    "content": "",
                    "tool_calls": [{
                        "id": "call_after_500",
                        "function": {
                            "name": "workspace_list",
                            "arguments": {"path": "."},
                        },
                    }],
                },
                "done_reason": "stop",
            },
        ]
        schemas = [{
            "name": "workspace_list",
            "parameters": {"type": "object", "properties": {}},
        }]

        with patch("providers.ollama_provider.httpx.AsyncClient", _FakeAsyncClient):
            decision = await self.provider.complete_structured(
                [ChatMessage(role="user", content="list")],
                schemas,
            )

        self.assertIsInstance(decision, AgentToolCall)
        self.assertEqual(decision.tool, "workspace_list")
        self.assertEqual(len(_FakeAsyncClient.payloads), 2)
        self.assertIn(
            "原生工具调用被模型服务拒绝",
            _FakeAsyncClient.payloads[1]["messages"][-1]["content"],
        )

    async def test_persistent_ollama_http_500_is_still_reported_as_provider_error(self):
        _FakeAsyncClient.responses = [
            (500, {"error": "first"}),
            (500, {"error": "second"}),
            (500, {"error": "third"}),
        ]

        with patch("providers.ollama_provider.httpx.AsyncClient", _FakeAsyncClient):
            with self.assertRaises(httpx.HTTPStatusError):
                await self.provider.complete_structured(
                    [ChatMessage(role="user", content="finish")],
                    [],
                )

        self.assertEqual(len(_FakeAsyncClient.payloads), 3)

    async def test_two_context_limit_responses_recover_on_third_native_attempt(self):
        _FakeAsyncClient.responses = [
            {
                "message": {"content": "TRUNCATED_PATCH_ONE"},
                "done_reason": "length",
                "prompt_eval_count": 15_507,
                "eval_count": 877,
            },
            {
                "message": {"content": "TRUNCATED_PATCH_TWO"},
                "done_reason": "length",
                "prompt_eval_count": 32_000,
                "eval_count": 768,
            },
            {
                "message": {
                    "content": "",
                    "tool_calls": [{
                        "id": "call_recovered",
                        "function": {
                            "name": "file_patch",
                            "arguments": {
                                "path": "notes/a.md",
                                "old_text": "old",
                                "new_text": "new",
                            },
                        },
                    }],
                },
                "done_reason": "stop",
            },
        ]
        schemas = [{
            "name": "file_patch",
            "parameters": {"type": "object", "properties": {}},
        }]

        with patch("providers.ollama_provider.httpx.AsyncClient", _FakeAsyncClient):
            decision = await self.provider.complete_structured(
                [ChatMessage(role="user", content="update note")],
                schemas,
            )

        self.assertIsInstance(decision, AgentToolCall)
        self.assertEqual(decision.tool, "file_patch")
        self.assertEqual(len(_FakeAsyncClient.payloads), 3)
        self.assertEqual(
            [payload["options"]["num_ctx"] for payload in _FakeAsyncClient.payloads],
            [16_384, 32_768, 65_536],
        )
        self.assertNotIn(
            "TRUNCATED_PATCH_ONE",
            str(_FakeAsyncClient.payloads[1]["messages"]),
        )
        self.assertNotIn(
            "TRUNCATED_PATCH_TWO",
            str(_FakeAsyncClient.payloads[2]["messages"]),
        )

    async def test_large_transcript_reserves_output_context_before_request(self):
        _FakeAsyncClient.responses = [{
            "message": {"content": "任务已完成。"},
            "done_reason": "stop",
        }]

        with patch("providers.ollama_provider.httpx.AsyncClient", _FakeAsyncClient):
            decision = await self.provider.complete_structured(
                [ChatMessage(role="user", content="中" * 12_000)],
                [],
            )

        self.assertIsInstance(decision, AgentFinalAnswer)
        self.assertEqual(
            _FakeAsyncClient.payloads[0]["options"]["num_ctx"], 32_768
        )

    async def test_context_exhaustion_at_maximum_has_specific_error(self):
        _FakeAsyncClient.responses = [{
            "message": {"content": "TRUNCATED_AT_MAX"},
            "done_reason": "length",
            "prompt_eval_count": 65_000,
            "eval_count": 536,
        }]

        with patch("providers.ollama_provider.httpx.AsyncClient", _FakeAsyncClient):
            with self.assertRaises(AgentContextExhaustedError):
                await self.provider.complete_structured(
                    [ChatMessage(role="user", content="中" * 40_000)],
                    [],
                )

        self.assertEqual(len(_FakeAsyncClient.payloads), 1)
        self.assertEqual(
            _FakeAsyncClient.payloads[0]["options"]["num_ctx"], 65_536
        )

    async def test_unknown_native_tool_is_correlated_but_never_executable(self):
        _FakeAsyncClient.responses = [{
            "message": {
                "content": "",
                "tool_calls": [{
                    "id": "call_unknown",
                    "function": {"name": "delete_everything", "arguments": {}},
                }],
            },
            "done_reason": "stop",
        }]
        schemas = [{
            "name": "file_read",
            "parameters": {"type": "object", "properties": {}},
        }]

        with patch("providers.ollama_provider.httpx.AsyncClient", _FakeAsyncClient):
            decision = await self.provider.complete_structured(
                [ChatMessage(role="user", content="read")],
                schemas,
            )

        self.assertIsInstance(decision, AgentToolBatch)
        self.assertEqual(len(decision.calls), 1)
        invalid_call = decision.calls[0]
        self.assertIsInstance(invalid_call, AgentInvalidToolCall)
        self.assertEqual(invalid_call.error_code, "unknown_tool")
        self.assertEqual(invalid_call._provider_state["tool_call_id"], "call_unknown")

    async def test_ordinary_chat_keeps_thinking_setting_unspecified(self):
        with patch("providers.ollama_provider.httpx.AsyncClient", _FakeAsyncClient):
            await self.provider.chat([ChatMessage(role="user", content="hello")])

        payload = _FakeAsyncClient.payloads[0]
        self.assertNotIn("format", payload)
        self.assertNotIn("think", payload)
        self.assertNotIn("tools", payload)
        self.assertEqual(payload["options"]["temperature"], 0.7)

    def test_history_uses_ollama_tool_name_and_native_tool_calls(self):
        messages = [
            ChatMessage(
                role="assistant",
                content=None,
                tool_calls=[ChatToolCall(
                    id="call_ignored_on_replay",
                    function=ChatToolFunction(
                        name="file_read",
                        arguments={"path": "notes/a.md"},
                    ),
                )],
            ),
            ChatMessage(
                role="tool",
                name="file_read",
                tool_call_id="call_ignored_on_replay",
                content='{"status":"ok"}',
            ),
        ]

        payloads = _ollama_chat_messages(messages)

        self.assertEqual(payloads[0]["tool_calls"], [{
            "function": {"name": "file_read", "arguments": {"path": "notes/a.md"}},
        }])
        self.assertEqual(payloads[1]["role"], "tool")
        self.assertEqual(payloads[1]["tool_name"], "file_read")
        self.assertNotIn("tool_call_id", payloads[1])


if __name__ == "__main__":
    unittest.main()
