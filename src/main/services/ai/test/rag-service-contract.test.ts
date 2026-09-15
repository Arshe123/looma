import { afterEach, describe, expect, it, vi } from 'vitest'
import { aiService } from '../AIService'

afterEach(() => { vi.unstubAllGlobals() })

describe('RAG service contract', () => {
  it('does not expose unused legacy wrappers', () => {
    expect(aiService).not.toHaveProperty('getDetailedIndexStatus')
    expect(aiService).not.toHaveProperty('streamBuildVectorIndex')
  })

  it('requests status using only the workspace path', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ exists: true })))
    vi.stubGlobal('fetch', fetchMock)
    const result = await aiService.getIndexStatus('/workspace')
    expect(result).toEqual({ success: true, data: { exists: true } })
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('http://127.0.0.1:8765/rag/index/status')
    expect(JSON.parse(init.body)).toEqual({ workspace_path: '/workspace' })
  })

  it.each(['incremental', 'full', 'retry_failed'] as const)('uses the managed stream for %s', async mode => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{"type":"done","status":"ok"}\n'))
    vi.stubGlobal('fetch', fetchMock)
    const onEvent = vi.fn()
    expect(await aiService.streamBuildManagedIndex('/workspace', mode, onEvent)).toEqual({ success: true })
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('http://127.0.0.1:8765/rag/index/build/stream')
    expect(JSON.parse(init.body)).toEqual(expect.objectContaining({ mode, workspace: { workspace_path: '/workspace' } }))
    expect(onEvent).toHaveBeenCalledWith({ type: 'done', status: 'ok' })
  })
})
