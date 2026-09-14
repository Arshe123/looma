import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from agent.models import AgentFinalAnswer, AgentToolCall
from agent.prompts import (
    AGENT_SYSTEM_PROMPT,
    final_only_prompt,
    native_tool_protocol_prompt,
    with_agent_protocol,
)
from providers.factory import create_chat_provider
from schemas import AgentConfig, ChatMessage, ChatModelConfig
from test.test_agent_runtime import FakeProvider, FakeTool, build_runtime, collect


class AgentPromptIntegrationTest(unittest.IsolatedAsyncioTestCase):
    async def test_rules_do_not_accumulate_across_tool_rounds_or_forced_final(self):
        history = [ChatMessage(role="system", content="对话摘要：查找资料")]
        provider = FakeProvider([
            AgentToolCall(type="tool_call", thought_summary="查找", tool="workspace_search", arguments={"value": "a"}),
            AgentToolCall(type="tool_call", thought_summary="继续查找", tool="workspace_search", arguments={"value": "b"}),
            AgentFinalAnswer(type="final", answer="完成"),
        ])
        events = await collect(
            build_runtime(provider, FakeTool()), input="开始", history=history,
            config=AgentConfig(enabled_tools=["workspace_search"], max_iterations=2),
        )
        self.assertEqual(events[-1]["type"], "done")
        self.assertEqual(len(provider.calls), 3)
        for messages, schemas in provider.calls:
            self.assertEqual(messages[0].content, AGENT_SYSTEM_PROMPT)
            self.assertEqual(sum(m.content == AGENT_SYSTEM_PROMPT for m in messages), 1)
            formatted = with_agent_protocol(messages, native_tool_protocol_prompt(bool(schemas)))
            self.assertEqual(formatted[1], history[0])
            self.assertEqual(messages[0].content, AGENT_SYSTEM_PROMPT)
        final_messages, final_schemas = provider.calls[-1]
        self.assertEqual(final_schemas, [])
        self.assertEqual(final_messages[-1], ChatMessage(role="system", content=final_only_prompt(2)))
        self.assertEqual(history, [ChatMessage(role="system", content="对话摘要：查找资料")])

    def test_direct_provider_protocol_preserves_summary_without_merging_it(self):
        for messages in ([], [ChatMessage(role="system", content="对话摘要")]):
            original = [message.model_copy(deep=True) for message in messages]
            formatted = with_agent_protocol(messages, "协议")
            self.assertEqual(formatted, [ChatMessage(role="system", content="协议"), *original])
            self.assertEqual(messages, original)

    async def test_all_providers_combine_shared_rules_with_their_protocol(self):
        for provider_name in ("deepseek", "ollama", "openai", "qwen", "openai-compatible", "custom"):
            for tools_available in (False, True):
                with self.subTest(provider=provider_name, tools=tools_available):
                    provider = create_chat_provider(ChatModelConfig(
                        provider=provider_name, model="test-model", api_key="test-only",
                    ))
                    native = provider_name in ("deepseek", "ollama")
                    content = "完成" if native else '{"type":"final","answer":"完成"}'
                    response = SimpleNamespace(choices=[SimpleNamespace(
                        message=SimpleNamespace(content=content, tool_calls=[], reasoning_content=None),
                        finish_reason="stop",
                    )])
                    if provider_name == "ollama":
                        target, method = provider, "_create_agent_completion"
                        response = {"message": {"content": content}, "done_reason": "stop"}
                    else:
                        target, method = provider.client.chat.completions, "create"
                    history = [ChatMessage(role="system", content="对话摘要：保留这个摘要")]
                    with patch.object(target, method, new=AsyncMock(return_value=response)) as send:
                        events = await collect(
                            build_runtime(provider, FakeTool()), input="开始", history=history,
                            config=AgentConfig(enabled_tools=["workspace_search"] if tools_available else []),
                        )
                    self.assertEqual(events[-1]["type"], "done")
                    self.assertEqual(events[-1]["answer"], "完成")
                    messages = send.call_args.args[0] if provider_name == "ollama" else send.call_args.kwargs["messages"]
                    system = messages[0]
                    self.assertEqual(system["role"], "system")
                    self.assertIn(AGENT_SYSTEM_PROMPT, system["content"])
                    self.assertEqual(sum(m.get("content", "").count(AGENT_SYSTEM_PROMPT) for m in messages), 1)
                    self.assertEqual(messages[1], {"role": "system", "content": history[0].content})
                    self.assertEqual(messages[-1], {"role": "user", "content": "开始"})
                    if native:
                        self.assertNotIn("仅输出一个 JSON", system["content"])
                        self.assertIn("原生 function tools" if tools_available else "本轮没有可用工具", system["content"])
                    else:
                        self.assertIn("仅输出一个 JSON", system["content"])
                        if tools_available:
                            self.assertIn('"name":"workspace_search"', system["content"])
                    self.assertEqual(history, [ChatMessage(role="system", content="对话摘要：保留这个摘要")])
