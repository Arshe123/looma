import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock

from agent.decision_parser import AgentEmptyDecisionError
from agent.models import AgentFinalAnswer, AgentInvalidToolCall, AgentToolBatch, AgentToolCall
from providers.deepseek_provider import DeepSeekChatProvider
from providers.factory import create_chat_provider
from providers.openai_compatible_provider import OpenAICompatibleChatProvider
from schemas import ChatMessage, ChatModelConfig, ChatToolCall, ChatToolFunction


def _tool_call(
    name: str = "workspace_list",
    arguments='{"path":".","depth":2}',
    call_id: str = "call_deepseek_1",
):
    return SimpleNamespace(
        id=call_id,
        type="function",
        function=SimpleNamespace(name=name, arguments=arguments),
    )


def _response(
    content: str | None = None,
    *,
    reasoning_content: str | None = None,
    tool_calls=None,
    finish_reason: str = "stop",
    model_extra=None,
):
    message = SimpleNamespace(
        content=content,
        reasoning_content=reasoning_content,
        tool_calls=tool_calls,
        model_extra=model_extra,
    )
    return SimpleNamespace(choices=[SimpleNamespace(
        message=message,
        finish_reason=finish_reason,
    )])


TOOLS = [{
    "name": "workspace_list",
    "description": "列出目录",
    "parameters": {
        "type": "object",
        "properties": {
            "path": {"type": "string"},
            "depth": {"type": "integer"},
        },
        "required": ["path"],
    },
}]


class DeepSeekProviderTest(unittest.IsolatedAsyncioTestCase):
    def create_provider(self, model: str = "deepseek-v4-flash") -> DeepSeekChatProvider:
        provider = DeepSeekChatProvider(ChatModelConfig(
            provider="deepseek",
            model=model,
            base_url="https://api.deepseek.com",
            api_key="test-key",
            temperature=0.2,
            max_tokens=4096,
        ))
        provider.client = SimpleNamespace(
            chat=SimpleNamespace(completions=SimpleNamespace(create=AsyncMock()))
        )
        return provider

    def test_factory_routes_only_deepseek_to_native_tool_provider(self):
        deepseek = create_chat_provider(ChatModelConfig(
            provider="deepseek", model="deepseek-v4-flash", api_key="test-key"
        ))
        qwen = create_chat_provider(ChatModelConfig(
            provider="qwen", model="qwen-test", api_key="test-key"
        ))
        self.assertIsInstance(deepseek, DeepSeekChatProvider)
        self.assertIsInstance(qwen, OpenAICompatibleChatProvider)

    async def test_native_request_uses_tools_plain_final_and_thinking_without_json_mode(self):
        provider = self.create_provider()
        provider.client.chat.completions.create.return_value = _response("完成")

        decision = await provider.complete_structured(
            [ChatMessage(role="user", content="总结工作区")], TOOLS
        )

        self.assertIsInstance(decision, AgentFinalAnswer)
        self.assertEqual(decision.answer, "完成")
        kwargs = provider.client.chat.completions.create.await_args.kwargs
        self.assertNotIn("response_format", kwargs)
        self.assertEqual(kwargs["extra_body"], {"thinking": {"type": "enabled"}})
        self.assertEqual(kwargs["max_tokens"], 8192)
        self.assertEqual(kwargs["tools"][0]["type"], "function")
        self.assertEqual(kwargs["tools"][0]["function"]["name"], "workspace_list")
        self.assertEqual(kwargs["tools"][0]["function"]["parameters"]["type"], "object")
        self.assertIn("原生 function tools", kwargs["messages"][0]["content"])

    async def test_final_only_omits_tools(self):
        provider = self.create_provider()
        provider.client.chat.completions.create.return_value = _response("直接回答")
        decision = await provider.complete_structured(
            [ChatMessage(role="user", content="回答")], []
        )
        self.assertEqual(decision.answer, "直接回答")
        kwargs = provider.client.chat.completions.create.await_args.kwargs
        self.assertNotIn("tools", kwargs)
        self.assertNotIn("response_format", kwargs)

    async def test_followup_replays_explicit_null_content_with_tool_call(self):
        provider = self.create_provider()
        provider.client.chat.completions.create.return_value = _response("完成")
        history = [
            ChatMessage(
                role="assistant",
                content=None,
                reasoning_content="PRIVATE_REASONING",
                tool_calls=[ChatToolCall(
                    id="call_previous",
                    function=ChatToolFunction(
                        name="workspace_list", arguments={"path": "."}
                    ),
                )],
            ),
            ChatMessage(
                role="tool",
                name="workspace_list",
                tool_call_id="call_previous",
                content='{"success":true}',
            ),
        ]

        await provider.complete_structured(history, TOOLS)

        messages = provider.client.chat.completions.create.await_args.kwargs["messages"]
        assistant = next(item for item in messages if item.get("tool_calls"))
        self.assertIn("content", assistant)
        self.assertIsNone(assistant["content"])
        self.assertEqual(assistant["reasoning_content"], "PRIVATE_REASONING")

    async def test_v3_and_chat_models_do_not_force_thinking(self):
        for model in ("deepseek-chat", "deepseek-v3.2"):
            with self.subTest(model=model):
                provider = self.create_provider(model)
                provider.client.chat.completions.create.return_value = _response("完成")
                await provider.complete_structured([ChatMessage(role="user", content="回答")], [])
                self.assertNotIn(
                    "extra_body", provider.client.chat.completions.create.await_args.kwargs
                )

    async def test_reasoner_enables_thinking(self):
        provider = self.create_provider("deepseek-reasoner")
        provider.client.chat.completions.create.return_value = _response("完成")
        await provider.complete_structured([ChatMessage(role="user", content="回答")], [])
        self.assertEqual(
            provider.client.chat.completions.create.await_args.kwargs["extra_body"],
            {"thinking": {"type": "enabled"}},
        )

    async def test_native_tool_call_maps_to_decision_and_private_provider_state(self):
        provider = self.create_provider()
        provider.client.chat.completions.create.return_value = _response(
            None,
            reasoning_content="PRIVATE_REASONING",
            tool_calls=[_tool_call()],
            finish_reason="tool_calls",
        )

        decision = await provider.complete_structured(
            [ChatMessage(role="user", content="列目录")], TOOLS
        )

        self.assertIsInstance(decision, AgentToolCall)
        self.assertEqual(decision.tool, "workspace_list")
        self.assertEqual(decision.arguments, {"path": ".", "depth": 2})
        self.assertEqual(decision.thought_summary, "调用工具：workspace_list")
        self.assertEqual(decision._provider_state["tool_call_id"], "call_deepseek_1")
        self.assertEqual(decision._provider_state["reasoning_content"], "PRIVATE_REASONING")
        self.assertTrue(decision._provider_state["requires_reasoning_echo"])
        self.assertNotIn("PRIVATE_REASONING", decision.model_dump_json())

    async def test_reasoning_content_falls_back_to_model_extra(self):
        provider = self.create_provider()
        provider.client.chat.completions.create.return_value = _response(
            None,
            tool_calls=[_tool_call()],
            model_extra={"reasoning_content": "EXTRA_REASONING"},
        )
        decision = await provider.complete_structured(
            [ChatMessage(role="user", content="列目录")], TOOLS
        )
        self.assertEqual(decision._provider_state["reasoning_content"], "EXTRA_REASONING")

    async def test_common_argument_damage_is_repaired_without_second_model_call(self):
        provider = self.create_provider()
        provider.client.chat.completions.create.return_value = _response(
            tool_calls=[_tool_call(arguments='{"path":".","depth":2,')]
        )
        decision = await provider.complete_structured(
            [ChatMessage(role="user", content="列目录")], TOOLS
        )
        self.assertEqual(decision.arguments, {"path": ".", "depth": 2})
        self.assertEqual(provider.client.chat.completions.create.await_count, 1)

    async def test_tool_name_is_repaired_only_inside_allowlist(self):
        provider = self.create_provider()
        provider.client.chat.completions.create.return_value = _response(
            tool_calls=[_tool_call(name="WorkspaceListTool")]
        )
        decision = await provider.complete_structured(
            [ChatMessage(role="user", content="列目录")], TOOLS
        )
        self.assertEqual(decision.tool, "workspace_list")

    async def test_invalid_arguments_become_correlated_call_level_error(self):
        provider = self.create_provider()
        provider.client.chat.completions.create.return_value = _response(
            tool_calls=[_tool_call(arguments='{"path": [}')],
            reasoning_content="PRIVATE_FIRST",
        )

        decision = await provider.complete_structured(
            [ChatMessage(role="user", content="列目录")], TOOLS
        )

        self.assertIsInstance(decision, AgentToolBatch)
        self.assertEqual(len(decision.calls), 1)
        self.assertIsInstance(decision.calls[0], AgentInvalidToolCall)
        self.assertEqual(decision.calls[0].error_code, "invalid_arguments")
        self.assertEqual(decision.calls[0]._provider_state["tool_call_id"], "call_deepseek_1")
        self.assertEqual(decision._provider_state["reasoning_content"], "PRIVATE_FIRST")
        self.assertEqual(provider.client.chat.completions.create.await_count, 1)

    async def test_unknown_tool_becomes_call_level_error_without_execution(self):
        provider = self.create_provider()
        provider.client.chat.completions.create.return_value = _response(
            tool_calls=[_tool_call(name="shell_exec")]
        )
        decision = await provider.complete_structured(
            [ChatMessage(role="user", content="列目录")], TOOLS
        )
        self.assertIsInstance(decision, AgentToolBatch)
        self.assertEqual(decision.calls[0].error_code, "unknown_tool")
        self.assertEqual(decision.calls[0].tool, "shell_exec")
        self.assertEqual(provider.client.chat.completions.create.await_count, 1)

    async def test_textual_tool_call_is_not_executed_and_can_repair_to_final(self):
        provider = self.create_provider()
        provider.client.chat.completions.create.side_effect = [
            _response('<tool_call>{"name":"workspace_list"}</tool_call>'),
            _response("不再伪造工具调用"),
        ]
        decision = await provider.complete_structured(
            [ChatMessage(role="user", content="回答")], TOOLS
        )
        self.assertIsInstance(decision, AgentFinalAnswer)
        self.assertEqual(provider.client.chat.completions.create.await_count, 2)

    async def test_multiple_tool_calls_are_preserved_in_original_order(self):
        provider = self.create_provider()
        provider.client.chat.completions.create.return_value = _response(
            tool_calls=[
                _tool_call(arguments='{"path":"a"}'),
                _tool_call(call_id="call_2", arguments='{"path":"b"}'),
            ],
            reasoning_content="PRIVATE_BATCH",
        )
        decision = await provider.complete_structured(
            [ChatMessage(role="user", content="回答")], TOOLS
        )
        self.assertIsInstance(decision, AgentToolBatch)
        self.assertEqual([call.arguments["path"] for call in decision.calls], ["a", "b"])
        self.assertEqual(
            [call._provider_state["tool_call_id"] for call in decision.calls],
            ["call_deepseek_1", "call_2"],
        )
        self.assertEqual(decision._provider_state["reasoning_content"], "PRIVATE_BATCH")
        self.assertEqual(provider.client.chat.completions.create.await_count, 1)

    async def test_truncated_final_is_repaired_instead_of_returned(self):
        provider = self.create_provider()
        provider.client.chat.completions.create.side_effect = [
            _response("未完成的答", finish_reason="length"),
            _response("完整答案"),
        ]
        decision = await provider.complete_structured(
            [ChatMessage(role="user", content="回答")], []
        )
        self.assertEqual(decision.answer, "完整答案")
        self.assertEqual(provider.client.chat.completions.create.await_count, 2)

    async def test_empty_content_after_one_repair_is_friendly_empty_error(self):
        provider = self.create_provider()
        provider.client.chat.completions.create.side_effect = [
            _response("", reasoning_content="PRIVATE_ONE"),
            _response(" ", reasoning_content="PRIVATE_TWO"),
        ]
        with self.assertRaises(AgentEmptyDecisionError):
            await provider.complete_structured(
                [ChatMessage(role="user", content="回答")], []
            )
        rendered = str(provider.client.chat.completions.create.await_args_list)
        self.assertNotIn("PRIVATE_ONE", rendered)
        self.assertNotIn("PRIVATE_TWO", rendered)

    async def test_ordinary_chat_does_not_force_json_or_thinking(self):
        provider = self.create_provider()
        provider.client.chat.completions.create.return_value = _response("普通回答")
        answer = await provider.chat([ChatMessage(role="user", content="你好")])
        self.assertEqual(answer, "普通回答")
        kwargs = provider.client.chat.completions.create.await_args.kwargs
        self.assertNotIn("response_format", kwargs)
        self.assertNotIn("extra_body", kwargs)


if __name__ == "__main__":
    unittest.main()
