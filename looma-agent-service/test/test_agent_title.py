import json
import unittest
from unittest.mock import patch

from fastapi.testclient import TestClient

import main
from schemas import AIConfig, ChatMessage, ChatModelConfig


class ScriptedProvider:
    def __init__(self, answer):
        self.answer = answer
        self.messages: list[ChatMessage] = []

    async def chat(self, messages):
        self.messages = messages
        if isinstance(self.answer, Exception):
            raise self.answer
        return self.answer


class AgentTitleTest(unittest.TestCase):
    def request(self, answer, payload):
        provider = ScriptedProvider(answer)
        config = AIConfig(chat=ChatModelConfig(provider="ollama", model="title-test"))
        with patch.object(main, "with_global_ai_config", return_value=config) as global_config, \
             patch.object(main, "create_chat_provider", return_value=provider) as factory:
            response = TestClient(main.app).post("/agent/title", json=payload)
        return response, provider, global_config, factory, config

    def test_title_uses_global_provider_with_independent_no_tools_prompt(self):
        response, provider, global_config, factory, config = self.request(
            "工作空间搜索", {"user_text": "怎么搜索文件？", "assistant_text": "可以使用搜索面板。"})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"title": "工作空间搜索"})
        global_config.assert_called_once_with(None)
        factory.assert_called_once_with(config.chat)
        self.assertEqual([m.role for m in provider.messages], ["system", "user"])
        self.assertIn("标题", provider.messages[0].content or '')
        self.assertIn("怎么搜索文件？", provider.messages[1].content or '')
        self.assertIn("可以使用搜索面板。", provider.messages[1].content or '')
        self.assertTrue(all(not m.tool_calls for m in provider.messages))

    def test_inputs_are_bounded_by_unicode_characters(self):
        response, provider, *_ = self.request("标题", {
            "user_text": "  " + "😀" * 2100,
            "assistant_text": "回" * 4100,
        })
        self.assertEqual(response.status_code, 200)
        content = json.loads(provider.messages[1].content or '')
        self.assertEqual(content, {"user_text": "😀" * 2000, "assistant_text": "回" * 4000})

    def test_malformed_or_empty_inputs_are_rejected_before_provider(self):
        for payload in [{}, {"user_text": 5, "assistant_text": "a"},
                        {"user_text": "u", "assistant_text": None},
                        {"user_text": " ", "assistant_text": "a"},
                        {"user_text": "u", "assistant_text": "\n"},
                        {"user_text": "u", "assistant_text": "a", "history": []}]:
            with self.subTest(payload=payload):
                response, _, _, factory, _ = self.request("标题", payload)
                self.assertEqual(response.status_code, 422)
                factory.assert_not_called()

    def test_cleans_markdown_quotes_and_limits_single_line_unicode_title(self):
        for raw, expected in [
            ('  ## **“搜索文件”**\n额外解释', '搜索文件'),
            ('```markdown\n# 「工作空间」\n```', '工作空间'),
            ('[搜索](https://example.test) 与 `笔记`', '搜索 与 笔记'),
            ('😀' * 30, '😀' * 24),
        ]:
            with self.subTest(raw=raw):
                response, *_ = self.request(raw, {"user_text": "u", "assistant_text": "a"})
                self.assertEqual(response.status_code, 200)
                self.assertEqual(response.json(), {"title": expected})

    def test_invalid_titles_and_provider_failures_do_not_fall_back(self):
        for raw in ['', ' \n ', '## **“”**', None, {}, '...', RuntimeError('secret provider failure')]:
            with self.subTest(raw=raw):
                response, *_ = self.request(raw, {"user_text": "u", "assistant_text": "a"})
                self.assertEqual(response.status_code, 502)
                self.assertIn('标题', response.json()['detail'])
                self.assertNotIn('secret', response.text)
