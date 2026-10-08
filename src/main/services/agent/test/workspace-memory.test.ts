import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { AgentMemoryStore, type MemoryReceipt } from '../AgentMemoryStore'
import { openUserProfileBridge } from '../UserProfileBridge'
const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))) })
async function setup() { const root = await fs.mkdtemp(path.join(os.tmpdir(), 'workspace-memory-')); roots.push(root); return root }
describe('workspace memory boundary', () => {
  it('keeps pre-feature conversation snapshots empty in the third layer without rewriting them', async () => {
    const root = await setup()
    const global = new AgentMemoryStore(root)
    const a = AgentMemoryStore.workspace(root, 'a')
    const legacy = { soul: await global.read('soul'), user: await global.read('user') }
    const directory = path.join(root, 'memory-snapshots')
    await fs.mkdir(directory, { recursive: true })
    const file = path.join(directory, `${createHash('sha256').update(JSON.stringify(['a', 'old'])).digest('hex')}.json`)
    const bytes = JSON.stringify(legacy)
    await fs.writeFile(file, bytes)
    await a.save('user', 'new project convention', (await a.read('user')).revision)
    expect((await global.snapshot('a', 'old', true)).workspace?.content).toBe('')
    expect(await fs.readFile(file, 'utf8')).toBe(bytes)
    expect((await global.snapshot('a', 'new')).workspace?.content).toBe('new project convention')
  })
  it('replays workspace receipts only from their own scope after restart', async () => {
    const root = await setup()
    const a = AgentMemoryStore.workspace(root, 'a')
    const before = await a.read('user')
    const content = 'project decision'
    const receipt = {
      id: randomUUID(), workspaceId: 'a', taskId: 'task', runId: 'run', timestamp: Date.now(),
      change: { kind: 'workspace' as const, workspaceId: 'a', beforeRevision: before.revision,
        afterRevision: createHash('sha256').update(content).digest('hex'), changes: [{ type: 'added' as const, text: content }] },
    }
    await a.save('user', content, before.revision, () => true, receipt)
    const seen: string[] = []
    const deliver = async (item: MemoryReceipt) => { seen.push(item.workspaceId); return true }
    await new AgentMemoryStore(root).replayReceipts(deliver)
    await AgentMemoryStore.workspace(root, 'b').replayReceipts(deliver)
    expect(seen).toEqual([])
    await AgentMemoryStore.workspace(root, 'a').replayReceipts(deliver)
    await AgentMemoryStore.workspace(root, 'a').replayReceipts(deliver)
    expect(seen).toEqual(['a'])
  })
  it('persists independent default-on live workspace authorization without affecting manual writes', async () => {
    const root = await setup()
    const a = AgentMemoryStore.workspace(root, 'a'), b = AgentMemoryStore.workspace(root, 'b')
    expect(a.canAutoMaintain()).toBe(false)
    expect(await a.readMaintenance()).toBe(true)
    expect(await b.readMaintenance()).toBe(true)
    await a.setMaintenance(false)
    expect(a.canAutoMaintain()).toBe(false)
    expect(b.canAutoMaintain()).toBe(true)
    expect(await AgentMemoryStore.workspace(root, 'a').readMaintenance()).toBe(false)
    await a.save('user', 'manual', (await a.read('user')).revision)
    expect((await a.read('user')).content).toBe('manual')
  })
  it('binds tools and durable receipts to one scope and rejects forged scope', async () => {
    const root = await setup()
    const store = AgentMemoryStore.workspace(root, 'a')
    let enabled = true
    const changes: unknown[] = []
    const bridge = await openUserProfileBridge(store, 'run', undefined, ['workspace_memory_read', 'workspace_memory_update', 'user_profile_read'], async change => { changes.push(change) }, () => enabled, { workspaceId: 'a', taskId: 'task', runId: 'run' })
    const call = async (tool: string, args = {}) => (await fetch(bridge.config.url, { method: 'POST', headers: { Authorization: `Bearer ${bridge.config.token}` }, body: JSON.stringify({ runId: 'run', tool, arguments: args }) })).json()
    try {
      expect((await call('user_profile_read')).success).toBe(false)
      expect((await call('workspace_memory_read', { workspaceId: 'b' })).success).toBe(false)
      const read = await call('workspace_memory_read')
      expect(read.success).toBe(true)
      expect((await call('workspace_memory_update', { content: 'A only', expectedRevision: read.data.revision })).success).toBe(true)
      expect(changes).toMatchObject([{ kind: 'workspace', workspaceId: 'a' }])
      const latest = await call('workspace_memory_read')
      enabled = false
      expect((await call('workspace_memory_update', { content: 'denied', expectedRevision: latest.data.revision })).success).toBe(false)
      expect((await store.read('user')).content).toBe('A only')
      expect((await new AgentMemoryStore(root).read('user')).content).toBe('')
    } finally { await bridge.close() }
  })
  it('isolates workspace content, history, cleanup and immutable snapshots from global memory', async () => {
    const root = await setup()
    const global = new AgentMemoryStore(root)
    const a = AgentMemoryStore.workspace(root, 'workspace-a')
    const b = AgentMemoryStore.workspace(root, 'workspace-b')
    await global.save('user', 'private user', (await global.read('user')).revision)
    await global.save('soul', 'manual soul', (await global.read('soul')).revision)
    await a.save('user', 'project A', (await a.read('user')).revision)
    expect((await b.read('user')).content).toBe('')
    const old = await global.snapshot('workspace-a', 'chat')
    expect(old.workspace?.content).toBe('project A')
    await a.save('user', 'project A corrected', (await a.read('user')).revision)
    expect((await global.snapshot('workspace-a', 'chat', true)).workspace?.content).toBe('project A')
    expect((await global.snapshot('workspace-a', 'new')).workspace?.content).toBe('project A corrected')
    expect((await global.snapshot('workspace-b', 'chat')).workspace?.content).toBe('')
    expect((await a.listUserHistory()).entries).toHaveLength(2)
    expect((await b.listUserHistory()).entries).toHaveLength(0)
    const selection = { user: true, history: true, snapshots: true }
    const preview = await a.previewCleanup(selection)
    await expect(b.cleanup(selection, preview.token)).rejects.toThrow()
    await a.cleanup(selection, preview.token)
    expect((await a.read('user')).content).toBe('')
    expect((await global.read('user')).content).toBe('private user')
    expect((await global.read('soul')).content).toBe('manual soul')
    await expect(a.read('soul')).rejects.toThrow()
    expect(() => AgentMemoryStore.workspace(root, '../escape')).toThrow()
  })
})
