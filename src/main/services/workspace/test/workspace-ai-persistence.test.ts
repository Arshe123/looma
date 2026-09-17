import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { workspaceAiService } from '../workspaceAiService'

const workspace = vi.hoisted(() => ({ path: '' }))
vi.mock('../workspaceService', () => ({ workspaceService: { getState: async () => ({ success: true, data: { workspaces: [{ id: 'ws', path: workspace.path }] } }) } }))
const dirs: string[] = []
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(dirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true }))) })
const fixture = async () => {
  workspace.path = await fs.mkdtemp(path.join(os.tmpdir(), 'looma-ai-service-'))
  dirs.push(workspace.path)
  const meta = path.join(workspace.path, '.looma')
  await fs.mkdir(meta)
  return { legacy: path.join(meta, 'workspace.json'), file: path.join(meta, 'ai-assistant', 'state.json') }
}
const state = (draft = '') => ({ schemaVersion: 2, conversations: [{ id: 'chat', title: 'Chat', createdAt: 1, updatedAt: 1, draft, messages: [] }], activeConversationId: 'chat' })

describe('workspace AI persistence transactions', () => {
  it('returns the healthy checkpoint without overwriting a damaged sidecar', async () => {
    const { file } = await fixture()
    await workspaceAiService.setState('ws', state('healthy'))
    const checkpoint = await fs.readFile(file, 'utf8')
    await fs.writeFile(`${file}.drafts`, '{broken')
    const result = await workspaceAiService.getState('ws')
    expect(result.success).toBe(true)
    expect(result.data?.conversations[0].draft).toBe('healthy')
    expect(await fs.readFile(file, 'utf8')).toBe(checkpoint)
    expect(await fs.readFile(`${file}.drafts`, 'utf8')).toBe('{broken')
  })
  it('reports checkpoint corruption without returning a default conversation', async () => {
    const { file } = await fixture()
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, '{broken')
    const result = await workspaceAiService.getState('ws')
    expect(result.success).toBe(false)
    expect(result.data).toBeUndefined()
    expect(result.error).toContain('读取 AI 助手状态失败')
    expect(await fs.readFile(file, 'utf8')).toBe('{broken')
  })
  it('flush waits for queued draft writes, including writes queued while draining', async () => {
    const { file } = await fixture()
    await workspaceAiService.setState('ws', state())
    let release!: () => void
    let entered!: () => void
    const blocked = new Promise<void>(resolve => { release = resolve })
    const started = new Promise<void>(resolve => { entered = resolve })
    const rename = fs.rename.bind(fs)
    vi.spyOn(fs, 'rename').mockImplementationOnce(async (...args) => {
      entered()
      await blocked
      await rename(...args)
    })
    const first = workspaceAiService.setDraft('ws', 'chat', 'first')
    await started
    let flushed = false
    const flushing = workspaceAiService.flush().then(() => { flushed = true })
    let lastFinished = false
    const last = workspaceAiService.setDraft('ws', 'chat', 'last').then(result => { lastFinished = true; return result })
    await Promise.resolve()
    expect(flushed).toBe(false)
    release()
    await flushing
    expect(lastFinished).toBe(true)
    expect((await first).success).toBe(true)
    expect((await last).success).toBe(true)
    expect(JSON.parse(await fs.readFile(`${file}.drafts`, 'utf8')).values.chat).toBe('last')
  })
  it('serializes the entire read/migration with later checkpoint writes', async () => {
    const { file } = await fixture()
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, JSON.stringify({ ...state('old'), schemaVersion: 1 }))
    let release!: () => void
    let entered!: () => void
    const blocked = new Promise<void>(resolve => { release = resolve })
    const started = new Promise<void>(resolve => { entered = resolve })
    const readFile = fs.readFile.bind(fs)
    vi.spyOn(fs, 'readFile').mockImplementationOnce(async (...args: Parameters<typeof fs.readFile>) => {
      const value = await readFile(...args)
      entered()
      await blocked
      return value
    })
    const reading = workspaceAiService.getState('ws')
    await started
    const writing = workspaceAiService.setState('ws', state('new'))
    // Give an incorrectly unqueued write a chance to overtake migration.
    await new Promise(resolve => setTimeout(resolve, 40))
    release()
    expect((await reading).success).toBe(true)
    expect((await writing).success).toBe(true)
    expect(JSON.parse(await fs.readFile(file, 'utf8')).conversations[0].draft).toBe('new')
  })
  it('keeps legacy data and reports failure if its checkpoint cannot be committed', async () => {
    const { legacy, file } = await fixture()
    const original = JSON.stringify({ other: 'keep', aiAssistant: state('legacy draft') })
    await fs.writeFile(legacy, original)
    vi.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('磁盘写入失败'))
    const result = await workspaceAiService.getState('ws')
    expect(result.success).toBe(false)
    expect(await fs.readFile(legacy, 'utf8')).toBe(original)
    await expect(fs.stat(file)).rejects.toMatchObject({ code: 'ENOENT' })
    const retry = await workspaceAiService.getState('ws')
    expect(retry.success).toBe(true)
    expect(retry.data?.conversations[0].draft).toBe('legacy draft')
    expect(JSON.parse(await fs.readFile(file, 'utf8')).conversations[0].draft).toBe('legacy draft')
  })
})
