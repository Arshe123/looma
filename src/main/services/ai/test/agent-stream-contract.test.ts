import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  aiService,
  isAgentStreamEvent,
  normalizeAgentRunOptions,
  type AgentStreamEvent,
} from '../AIService'

const encoder = new TextEncoder()

const ndjsonResponse = (lines: unknown[], init: ResponseInit = {}) => new Response(
  new ReadableStream({
    start(controller) {
      for (const line of lines) {
        controller.enqueue(encoder.encode(typeof line === 'string' ? `${line}\n` : `${JSON.stringify(line)}\n`))
      }
      controller.close()
    },
  }),
  { status: 200, ...init },
)

const validEvents: AgentStreamEvent[] = [
  { type: 'run_started', runId: 'run_1', startedAt: '2026-07-14T10:00:00Z' },
  { type: 'timeline', runId: 'run_1', step: 1, stepId: 'step_1', status: 'running', summary: '检索文档' },
  { type: 'tool_call', runId: 'run_1', step: 1, stepId: 'step_1', callId: 'call_1', tool: 'rag_search', arguments: { query: '发布' }, thought_summary: '检索文档' },
  { type: 'tool_result', runId: 'run_1', step: 1, stepId: 'step_1', callId: 'call_1', result: { tool: 'rag_search', success: true, summary: '找到结果', data: [], error: null, truncated: false } },
  { type: 'sources', runId: 'run_1', sources: [{ path: 'docs/release.md', score: 0.9, text: '发布' }] },
  { type: 'delta', runId: 'run_1', text: '完成', content: '完成' },
  { type: 'done', runId: 'run_1', status: 'completed', answer: '完成' },
  { type: 'error', runId: 'run_1', error: { code: 'agent_failed', message: '失败', technical_detail: 'Error', retryable: true } },
]

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('Agent stream contract', () => {
  it('posts the exact approval-capable default body and forwards valid events', async () => {
    const fetchMock = vi.fn().mockResolvedValue(ndjsonResponse(validEvents))
    vi.stubGlobal('fetch', fetchMock)
    const received: AgentStreamEvent[] = []

    const result = await aiService.streamAgent('D:/work/demo', { input: '  总结发布流程  ' }, event => received.push(event))

    expect(result).toEqual({ success: true })
    expect(received).toEqual(validEvents)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('http://127.0.0.1:8765/agent/run/stream')
    expect(init).toEqual(expect.objectContaining({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    }))
    expect(JSON.parse(init.body)).toEqual({
      input: '总结发布流程',
      workspace: { workspace_path: 'D:/work/demo' },
      history: [],
      agent: {
        enabled_tools: ['rag_search', 'workspace_list', 'workspace_search', 'file_read', 'file_patch'],
        max_steps: 8,
        tool_timeout_seconds: 30,
        run_timeout_seconds: 300,
        allow_write: true,
      },
    })
    expect(init.body).not.toContain('apiKey')
    expect(init.body).not.toContain('api_key')
  })

  it('normalizes supported options and clamps numeric limits', () => {
    expect(normalizeAgentRunOptions({
      input: '  task  ',
      history: [{ role: 'user', content: '  hello  ' }, { role: 'assistant', content: '   ' }],
      enabledTools: ['file_read', 'rag_search', 'file_read'],
      maxSteps: 999,
      toolTimeoutSeconds: -5,
      runTimeoutSeconds: 4.6,
    })).toEqual({
      input: 'task',
      history: [{ role: 'user', content: 'hello' }],
      enabledTools: ['file_read', 'rag_search'],
      maxSteps: 50,
      toolTimeoutSeconds: 1,
      runTimeoutSeconds: 5,
    })
  })

  it('rejects empty input and unsupported tools', () => {
    expect(() => normalizeAgentRunOptions({ input: ' ' })).toThrow('Agent input is required')
    expect(() => normalizeAgentRunOptions({ input: 'task', enabledTools: ['terminal' as never] })).toThrow('Unsupported Agent tool')
  })

  it('enforces request text budgets before starting a stream', () => {
    expect(() => normalizeAgentRunOptions({ input: 'x'.repeat(32_001) })).toThrow('Agent input is too large')
    expect(() => normalizeAgentRunOptions({
      input: 'task',
      history: Array.from({ length: 51 }, () => ({ role: 'user' as const, content: 'x' })),
    })).toThrow('Agent history has too many messages')
  })

  it('drops unknown and malformed events with non-sensitive warnings', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(ndjsonResponse([
      { type: 'future_event', runId: 'run_secret', token: 'do-not-log' },
      { type: 'done', runId: '' },
      { type: 'tool_call', runId: 'run_1', tool: 'rag_search' },
      validEvents[0],
    ])))
    const received: AgentStreamEvent[] = []

    const result = await aiService.streamAgent('D:/work/demo', { input: 'task' }, event => received.push(event))

    expect(result).toEqual({ success: true })
    expect(received).toEqual([validEvents[0]])
    expect(warn).toHaveBeenCalledTimes(3)
    const warningText = warn.mock.calls.flat().join(' ')
    expect(warningText).not.toContain('do-not-log')
    expect(warningText).not.toContain('run_secret')
  })

  it('drops delta events whose text and content differ', () => {
    expect(isAgentStreamEvent({ type: 'delta', runId: 'run_1', text: 'a', content: 'b' })).toBe(false)
    expect(isAgentStreamEvent({ type: 'delta', runId: 'run_1', text: 'a', content: 'a' })).toBe(true)
  })

  it('rejects inconsistent or incomplete tool results', () => {
    const base = { type: 'tool_result', runId: 'run_1', step: 1, stepId: 'step_1', callId: 'call_1' }
    expect(isAgentStreamEvent({ ...base, result: { tool: 'rag_search', success: true, summary: 'ok', error: null, truncated: false } })).toBe(false)
    expect(isAgentStreamEvent({ ...base, result: { tool: 'rag_search', success: true, summary: 'ok', data: [], error: { code: 'x', message: 'x', retryable: false }, truncated: false } })).toBe(false)
    expect(isAgentStreamEvent({ ...base, result: { tool: 'rag_search', success: false, summary: 'bad', data: null, error: null, truncated: false } })).toBe(false)
    expect(isAgentStreamEvent({ ...base, result: { tool: 'terminal', success: true, summary: 'ok', data: null, error: null, truncated: false } })).toBe(false)
    expect(isAgentStreamEvent({ ...base, result: { tool: 'rag_search', success: false, summary: 'bad', data: null, error: { code: 'x', message: 'x', retryable: false, technicalDetails: 'alias' }, truncated: false } })).toBe(false)
  })

  it('treats AbortError as a successful cancellation', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(Object.assign(new Error('cancelled'), { name: 'AbortError' })))
    await expect(aiService.streamAgent('D:/work/demo', { input: 'task' }, () => {})).resolves.toEqual({ success: true })
  })

  it('returns failure for HTTP and malformed NDJSON', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ detail: 'bad request' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    })).mockResolvedValueOnce(ndjsonResponse(['not-json'])))

    await expect(aiService.streamAgent('D:/work/demo', { input: 'task' }, () => {})).resolves.toEqual({ success: false, error: 'bad request' })
    const parseResult = await aiService.streamAgent('D:/work/demo', { input: 'task' }, () => {})
    expect(parseResult.success).toBe(false)
    expect(parseResult.success ? '' : parseResult.error).toContain('RAG 流数据解析失败')
  })

  it('rejects oversized NDJSON events before parsing', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(ndjsonResponse(['x'.repeat(1_000_001)])))
    const result = await aiService.streamAgent('D:/work/demo', { input: 'task' }, () => {})
    expect(result.success).toBe(false)
    expect(result.success ? '' : result.error).toContain('超过大小限制')
  })

  it('cancels an unfinished response stream after an early parse failure', async () => {
    let cancelled = false
    const response = new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('not-json\n'))
      },
      cancel() {
        cancelled = true
      },
    }))
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response))

    const result = await aiService.streamAgent('D:/work/demo', { input: 'task' }, () => {})

    expect(result.success).toBe(false)
    expect(cancelled).toBe(true)
  })
})
