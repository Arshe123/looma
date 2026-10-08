import { afterEach, describe, expect, it, vi } from 'vitest'
import { aiService } from '../../services/ai/AIService'

const bridge = vi.hoisted(() => ({ api: null as any, invoke: vi.fn() }))
vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: (_name: string, api: unknown) => { bridge.api = api } },
  ipcRenderer: { invoke: bridge.invoke, on: vi.fn() },
}))

import '../../../preload/index'

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('conversation title transport', () => {
  it.each([null, {}, { title: '' }, { title: 42 }, { title: 'x\ny' }, { title: 'x'.repeat(25) }])('rejects invalid successful service payload %j', async payload => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(payload))))
    expect(await aiService.generateAgentConversationTitle('u', 'a')).toEqual({ success: false, error: expect.stringContaining('标题') })
  })

  it('returns Chinese failures for network, timeout and HTTP errors', async () => {
    for (const failure of [new Error('private network detail'), new DOMException('timed out', 'TimeoutError')]) {
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(failure))
      expect(await aiService.generateAgentConversationTitle('u', 'a')).toEqual({ success: false, error: expect.stringContaining('标题') })
    }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{"detail":"private"}', { status: 502 })))
    expect(await aiService.generateAgentConversationTitle('u', 'a')).toEqual({ success: false, error: expect.stringContaining('标题') })
  })
  it('exposes the exact two-text preload API', async () => {
    bridge.invoke.mockResolvedValue({ success: true, data: { title: '标题' } })
    expect(bridge.api.agent.generateConversationTitle).toBeTypeOf('function')
    expect(await bridge.api.agent.generateConversationTitle('问题', '回复')).toEqual({ success: true, data: { title: '标题' } })
    expect(bridge.invoke).toHaveBeenCalledWith('agent:generateConversationTitle', '问题', '回复')
  })

  it('posts bounded texts with a finite timeout and returns the title', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ title: '标题' })))
    vi.stubGlobal('fetch', fetchMock)
    const timeout = vi.spyOn(AbortSignal, 'timeout')
    expect(aiService.generateAgentConversationTitle).toBeTypeOf('function')
    expect(await aiService.generateAgentConversationTitle('😀'.repeat(2100), '回'.repeat(4100))).toEqual({ success: true, data: { title: '标题' } })
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('http://127.0.0.1:8765/agent/title')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body)).toEqual({ user_text: '😀'.repeat(2000), assistant_text: '回'.repeat(4000) })
    expect(timeout).toHaveBeenCalledWith(30_000)
    expect(init.signal).toBeInstanceOf(AbortSignal)
  })
})
