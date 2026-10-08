import unittest
from agent.tools.base import AgentToolContext
from agent.tools.registry import ToolRegistry
from agent.tools import user_profile
from schemas import DEFAULT_AGENT_TOOLS

class WorkspaceMemoryTest(unittest.IsolatedAsyncioTestCase):
    async def test_workspace_tools_are_path_free_and_separate_from_profile(self):
        self.assertIn('workspace_memory_read', DEFAULT_AGENT_TOOLS)
        registry = ToolRegistry()
        registry.register(user_profile.WorkspaceMemoryReadTool())
        registry.register(user_profile.WorkspaceMemoryUpdateTool())
        schemas = registry.tool_schemas(enabled_tools=DEFAULT_AGENT_TOOLS)
        self.assertEqual({s['name'] for s in schemas}, {'workspace_memory_read', 'workspace_memory_update'})
        context = AgentToolContext(workspace_path='.', run_id='run', user_profile_bridge={'url': 'http://127.0.0.1:1/user-profile', 'token': 'a' * 64})
        result = await registry.execute('workspace_memory_read', context, {}, enabled_tools=DEFAULT_AGENT_TOOLS)
        self.assertFalse(result.success)
        self.assertEqual(result.error.code, 'workspace_memory_bridge_unavailable')
        result = await registry.execute('workspace_memory_update', context, {'content': 'x', 'expectedRevision': 'a' * 64, 'workspaceId': 'other'}, enabled_tools=DEFAULT_AGENT_TOOLS)
        self.assertEqual(result.error.code, 'tool_invalid_arguments')
