import json
import unittest
from unittest.mock import patch

from agent.tools.base import AgentToolContext
from agent.tools.registry import ToolRegistry
from agent.tools.user_profile import UserProfileReadTool, UserProfileUpdateTool
from agent.prompts import observation_prompt
from agent.models import ToolResult, AgentToolCall, AgentFinalAnswer
from agent.runtime import AgentRuntime
from agent.prompts import AGENT_SYSTEM_PROMPT
from schemas import DEFAULT_AGENT_TOOLS, AgentConfig
from test.test_agent_runtime import FakeProvider, collect


class UserProfileTest(unittest.IsolatedAsyncioTestCase):
    async def test_profile_read_is_never_reused_across_model_rounds(self):
        provider = FakeProvider([
            AgentToolCall(type='tool_call', thought_summary='读取', tool='user_profile_read', arguments={}),
            AgentToolCall(type='tool_call', thought_summary='刷新', tool='user_profile_read', arguments={}),
            AgentFinalAnswer(type='final', answer='完成'),
        ])
        runtime = AgentRuntime(provider=provider, registry=self.registry(), context=AgentToolContext(workspace_path='.'))
        with patch('agent.tools.user_profile.request_profile', side_effect=[{'content': 'old', 'revision': 'a' * 64}, {'content': 'new', 'revision': 'b' * 64}]) as read:
            events = await collect(runtime, input='中文', history=[], config=AgentConfig())
        self.assertEqual(read.call_count, 2)
        results = [e for e in events if e['type'] == 'tool_result']
        self.assertEqual(results[-1]['result']['modelContext']['structuredData']['content'], 'new')

    def test_prompt_authorizes_only_durable_user_profile_updates(self):
        self.assertIn('user_profile_read', AGENT_SYSTEM_PROMPT)
        self.assertIn('user_profile_update', AGENT_SYSTEM_PROMPT)
        for rule in ('不得自行修改 soul.md', '任务进度', '秘密', '明确提供', '工具结果'):
            self.assertIn(rule, AGENT_SYSTEM_PROMPT)

    def registry(self):
        registry = ToolRegistry(allowed_tools=DEFAULT_AGENT_TOOLS)
        registry.register(UserProfileReadTool())
        registry.register(UserProfileUpdateTool())
        return registry

    async def test_dedicated_tools_require_bridge_not_workspace_files(self):
        registry = self.registry()
        self.assertEqual({s['name'] for s in registry.tool_schemas(enabled_tools=DEFAULT_AGENT_TOOLS)},
                         {'user_profile_read', 'user_profile_update'})
        result = await registry.execute('user_profile_read', AgentToolContext(workspace_path='.'), {}, enabled_tools=DEFAULT_AGENT_TOOLS)
        self.assertFalse(result.success)
        self.assertEqual(result.error.code, 'user_profile_bridge_unavailable')
        invalid = await registry.execute('user_profile_update', AgentToolContext(workspace_path='.'),
                                         {'content': 'x', 'expectedRevision': 'a' * 64, 'path': 'soul.md'}, enabled_tools=DEFAULT_AGENT_TOOLS)
        self.assertFalse(invalid.success)
        self.assertEqual(invalid.error.code, 'tool_invalid_arguments')
        self.assertIn('用户画像参数', invalid.error.message)

    def test_full_profile_survives_model_observation_bounds(self):
        content = '偏好中文。\n' * 2400
        result = ToolResult(tool='user_profile_read', success=True, summary='已读取', data={'content': content, 'revision': 'a' * 64})
        rendered = json.loads(observation_prompt(result))
        self.assertEqual(rendered['modelContext']['structuredData']['content'], content)
        self.assertFalse(rendered['truncated'])

    async def test_transport_errors_are_not_storage_success(self):
        context = AgentToolContext(workspace_path='.', run_id='run_a', user_profile_bridge={'url': 'http://127.0.0.1:1/user-profile', 'token': 'a' * 64})
        result = await self.registry().execute('user_profile_read', context, {}, enabled_tools=DEFAULT_AGENT_TOOLS)
        self.assertFalse(result.success)
        self.assertEqual(result.error.code, 'user_profile_transport_failed')


if __name__ == '__main__':
    unittest.main()
