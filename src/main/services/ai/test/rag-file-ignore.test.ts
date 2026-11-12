import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { aiService } from '../AIService'

const mocks = vi.hoisted(() => ({ handle: vi.fn(), workspace: vi.fn() }))
vi.mock('electron', () => ({ ipcMain: { handle: mocks.handle } }))
vi.mock('../../../ipc/workspaceIpc', () => ({ getWorkspacePathById: mocks.workspace }))
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks() })

const preloadSource = readFileSync(new URL('../../../../preload/index.ts', import.meta.url), 'utf8')
const preloadMethods = preloadSource.match(/indexFile: (\{[\s\S]*?\n {4}})/)![1]
const preload = new Function('ipcRenderer', ts.transpileModule(`return (${preloadMethods})`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText)

describe('manual file ignore desktop contract', () => {
  it.each(['ignore', 'unignore'] as const)('wires %s from preload through workspace IPC to the managed POST body', async (action) => {
    vi.resetModules()
    await import('../../../ipc/ragIpc')
    const handler = mocks.handle.mock.calls.find(([channel]) => channel === `rag:indexFile:${action}`)?.[1]
    expect(handler).toBeTypeOf('function')
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ success: true })))
    vi.stubGlobal('fetch', fetchMock)
    mocks.workspace.mockResolvedValue('/workspace')
    const invoke = vi.fn((channel, ...args) => {
      expect(channel).toBe(`rag:indexFile:${action}`)
      return handler({}, ...args)
    })
    expect(await preload({ invoke })[action]('ws', 'docs/a.md')).toEqual({ success: true, data: { success: true } })
    expect(mocks.workspace).toHaveBeenCalledWith('ws')
    expect(fetchMock).toHaveBeenCalledWith(`http://127.0.0.1:8765/rag/index/file/${action}`, expect.objectContaining({
      method: 'POST', body: JSON.stringify({ workspace: { workspace_path: '/workspace' }, mode: 'incremental', path: 'docs/a.md' }),
    }))
    expect(aiService[action === 'ignore' ? 'ignoreFile' : 'unignoreFile']).toBeTypeOf('function')
    expect(await handler({}, 'ws', ' ')).toEqual({ success: false, error: '必须提供文件路径。' })
    mocks.workspace.mockResolvedValue(null)
    expect(await handler({}, 'missing', 'docs/a.md')).toEqual({ success: false, error: '工作空间不存在。' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
