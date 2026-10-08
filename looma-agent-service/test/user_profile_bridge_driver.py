"""Cross-language integration driver: real service/tools/HTTP, scripted model transport.

Invoked by Vitest with a run-scoped Electron bridge on stdin. Never reads user settings.
"""
import asyncio
import json
import sys
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import main
from providers.factory import create_chat_provider
from schemas import AgentRunRequest, AIConfig, ChatModelConfig


async def run():
    payload = json.loads(sys.stdin.read())
    protocol = payload.pop('_protocol')
    prefix = 'workspace_memory' if payload.pop('_scope', 'user') == 'workspace' else 'user_profile'
    read_tool, update_tool = prefix + '_read', prefix + '_update'
    request = AgentRunRequest.model_validate(payload)
    request.ai_config = AIConfig(chat=ChatModelConfig(provider=protocol, model='test-model', api_key='test-only'))
    provider = create_chat_provider(request.ai_config.chat)
    rounds = 0
    can_update = update_tool in request.agent.enabled_tools
    bridge = getattr(request, prefix + '_bridge')

    async def completion(*args, **kwargs):
        nonlocal rounds
        messages = args[0] if protocol == 'ollama' else kwargs['messages']
        serialized = json.dumps(messages, ensure_ascii=False)
        assert bridge.token not in serialized
        assert bridge.url not in serialized
        assert update_tool in serialized or protocol == 'ollama'
        if protocol == 'ollama':
            names = {tool['function']['name'] for tool in args[1]}
            assert read_tool in names
            assert (update_tool in names) == can_update
        else:
            schemas = json.loads(messages[0]['content'].split('运行时可用工具 JSON：\n')[-1])
            assert (update_tool in {s['name'] for s in schemas}) == can_update
        if rounds == 1 and not can_update:
            result = json.loads([m for m in messages if m['role'] == 'tool'][-1]['content'])
            assert result['success']
            assert len(result['modelContext']['structuredData']['content']) > 4000
            if protocol == 'ollama':
                return {'message': {'content': '仅读取'}, 'done_reason': 'stop'}
            return SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content=json.dumps({'type': 'final', 'answer': '仅读取'})), finish_reason='stop')])
        if rounds == 0:
            name, arguments = read_tool, {}
        elif rounds == 1:
            result = json.loads([m for m in messages if m['role'] == 'tool'][-1]['content'])
            assert result['success']
            data = result['modelContext']['structuredData']
            assert len(data['content']) > 4000, 'must not replace a truncated profile'
            name, arguments = update_tool, {'content': data['content'].replace('偏好英文', '偏好中文').replace('过时习惯\n', '') + '\n喜欢简洁回答', 'expectedRevision': data['revision']}
        else:
            result = json.loads([m for m in messages if m['role'] == 'tool'][-1]['content'])
            assert result['success']
            assert '喜欢简洁回答' in result['modelContext']['structuredData']['content']
            assert '偏好英文' not in result['modelContext']['structuredData']['content']
            assert '过时习惯' not in result['modelContext']['structuredData']['content']
            if protocol == 'ollama':
                return {'message': {'content': '已保存'}, 'done_reason': 'stop'}
            return SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content=json.dumps({'type': 'final', 'answer': '已保存'})), finish_reason='stop')])
        rounds += 1
        if protocol == 'ollama':
            return {'message': {'content': '维护画像', 'tool_calls': [{'function': {'name': name, 'arguments': arguments}}]}, 'done_reason': 'stop'}
        return SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content=json.dumps({'type': 'tool_call', 'thought_summary': '维护画像', 'tool': name, 'arguments': arguments})), finish_reason='stop')])

    target, method = (provider, '_create_agent_completion') if protocol == 'ollama' else (provider.client.chat.completions, 'create')
    with patch.object(main, 'resolve_request_config', side_effect=lambda r: r), patch.object(main, 'create_chat_provider', return_value=provider), patch.object(target, method, new=AsyncMock(side_effect=completion)):
        lines = [line async for line in main.agent_run_events(request)]
    events = [json.loads(line) for line in lines]
    assert events[-1]['type'] == 'done', events[-1]
    assert events[-1]['answer'] == ('已保存' if can_update else '仅读取'), events[-1]
    assert sum(e['type'] == 'tool_result' for e in events) == (2 if can_update else 1)
    assert not any(e['type'] == 'approval_required' for e in events)
    sys.stdout.write(''.join(lines))


if __name__ == '__main__':
    asyncio.run(run())
