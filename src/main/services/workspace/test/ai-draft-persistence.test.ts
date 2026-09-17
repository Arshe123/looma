import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { AiDraftPersistence } from '../ai-draft-persistence'

const dirs: string[] = []
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(dirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true }))) })
const fixture = async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'looma-ai-drafts-')); dirs.push(dir)
  return { file: path.join(dir, 'state.json'), persistence: new AiDraftPersistence() }
}
const state = (draft = '') => ({ schemaVersion: 2, conversations: [{ id: 'chat', draft, messages: [{ text: 'large history' }] }], activeConversationId: 'chat' })
describe('durable AI draft sidecar', () => {
  it.each(['{broken', 'null', '{"revision":null,"values":[]}'])('preserves a bad sidecar and returns the healthy checkpoint: %s', async bad => {
    const { file, persistence } = await fixture()
    await persistence.set(file, state('healthy'))
    await fs.writeFile(`${file}.drafts`, bad)
    expect((await persistence.get(file)).conversations[0].draft).toBe('healthy')
    expect(await fs.readFile(`${file}.drafts`, 'utf8')).toBe(bad)
  })
  it('rejects unknown and deleted conversations without changing recovery data', async () => {
    const { file, persistence } = await fixture()
    await persistence.set(file, state())
    await persistence.setDraft(file, 'chat', 'safe')
    const before = await fs.readFile(`${file}.drafts`, 'utf8')
    await expect(persistence.setDraft(file, 'missing', 'lost')).rejects.toThrow('对话不存在')
    expect(await fs.readFile(`${file}.drafts`, 'utf8')).toBe(before)
    await persistence.set(file, { conversations: [] })
    await expect(persistence.setDraft(file, 'chat', 'lost')).rejects.toThrow('对话不存在')
  })
  it('orders drafts, checkpoints and clears without reviving stale sidecars', async () => {
    const { file, persistence } = await fixture()
    await persistence.set(file, state())
    await Promise.all([
      persistence.setDraft(file, 'chat', 'old'),
      persistence.set(file, state('')),
      persistence.setDraft(file, 'chat', 'latest'),
    ])
    expect((await new AiDraftPersistence().get(file)).conversations[0].draft).toBe('latest')
    const stale = await fs.readFile(`${file}.drafts`, 'utf8')
    await persistence.set(file, state('sent'))
    await expect(fs.stat(`${file}.drafts`)).rejects.toMatchObject({ code: 'ENOENT' })
    // Simulate a crash after checkpoint rename, before sidecar cleanup.
    await fs.writeFile(`${file}.drafts`, stale)
    expect((await new AiDraftPersistence().get(file)).conversations[0].draft).toBe('sent')
    await persistence.setDraft(file, 'chat', '')
    expect((await new AiDraftPersistence().get(file)).conversations[0].draft).toBe('')
  })
  it('retains recovery after failed checkpoint and continues processing', async () => {
    const { file, persistence } = await fixture()
    await persistence.set(file, state())
    await persistence.setDraft(file, 'chat', 'recoverable')
    vi.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('disk full'))
    await expect(persistence.set(file, state('lost'))).rejects.toThrow('disk full')
    expect((await new AiDraftPersistence().get(file)).conversations[0].draft).toBe('recoverable')
    await persistence.setDraft(file, 'chat', 'next')
    expect((await new AiDraftPersistence().get(file)).conversations[0].draft).toBe('next')
  })
  it('retains the prior draft on failed draft writes and isolates workspaces', async () => {
    const { file, persistence } = await fixture()
    const other = path.join(path.dirname(file), 'other.json')
    await persistence.set(file, state())
    await persistence.set(other, state('other'))
    await persistence.setDraft(file, 'chat', 'safe')
    vi.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('disk full'))
    await expect(persistence.setDraft(file, 'chat', 'failed')).rejects.toThrow('disk full')
    expect((await new AiDraftPersistence().get(file)).conversations[0].draft).toBe('safe')
    expect((await new AiDraftPersistence().get(other)).conversations[0].draft).toBe('other')
    await persistence.setDraft(file, 'chat', 'retry')
    expect((await new AiDraftPersistence().get(file)).conversations[0].draft).toBe('retry')
  })
  it('syncs the temporary file before rename and the directory afterwards', async () => {
    const { file, persistence } = await fixture()
    const events: string[] = []
    const open = fs.open.bind(fs)
    const rename = fs.rename.bind(fs)
    vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      const handle = await open(...args)
      const sync = handle.sync.bind(handle)
      vi.spyOn(handle, 'sync').mockImplementation(async () => { events.push(String(args[0]) === path.dirname(file) ? 'directory' : 'file'); await sync() })
      return handle
    })
    vi.spyOn(fs, 'rename').mockImplementation(async (...args) => { events.push('rename'); await rename(...args) })
    await persistence.set(file, state())
    expect(events).toEqual(process.platform === 'win32' ? ['file', 'rename'] : ['file', 'rename', 'directory'])
  })
  it('does not replace a healthy checkpoint if syncing the temporary file fails', async () => {
    const { file, persistence } = await fixture()
    await persistence.set(file, state('safe'))
    const open = fs.open.bind(fs)
    vi.spyOn(fs, 'open').mockImplementationOnce(async (...args) => {
      const handle = await open(...args)
      vi.spyOn(handle, 'sync').mockRejectedValueOnce(new Error('sync failed'))
      return handle
    })
    await expect(persistence.set(file, state('lost'))).rejects.toThrow('sync failed')
    expect((await new AiDraftPersistence().get(file)).conversations[0].draft).toBe('safe')
    expect((await fs.readdir(path.dirname(file))).filter(name => name.endsWith('.tmp'))).toEqual([])
  })
  it('reloads the committed revision if directory sync fails after rename', async () => {
    if (process.platform === 'win32') return
    const { file, persistence } = await fixture()
    await persistence.set(file, state('old'))
    const open = fs.open.bind(fs)
    let failed = false
    vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      const handle = await open(...args)
      if (String(args[0]) === path.dirname(file) && !failed) {
        failed = true
        vi.spyOn(handle, 'sync').mockRejectedValueOnce(new Error('directory sync failed'))
      }
      return handle
    })
    await expect(persistence.set(file, state('new'))).rejects.toThrow('directory sync failed')
    await persistence.setDraft(file, 'chat', 'next')
    expect((await new AiDraftPersistence().get(file)).conversations[0].draft).toBe('next')
  })
  it('writes drafts without rewriting history and restores after restart', async () => {
    const { file, persistence } = await fixture()
    await persistence.set(file, state())
    const original = await fs.readFile(file, 'utf8')
    await persistence.setDraft(file, 'chat', 'one')
    await persistence.setDraft(file, 'chat', 'two')
    expect(await fs.readFile(file, 'utf8')).toBe(original)
    expect((await new AiDraftPersistence().get(file)).conversations[0].draft).toBe('two')
    expect(await fs.readFile(`${file}.drafts`, 'utf8')).not.toContain('large history')
  })
})
