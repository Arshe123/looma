import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { AgentMemoryStore } from '../AgentMemoryStore'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))) })
async function setup() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'looma-memory-'))
  roots.push(root)
  return { root, store: new AgentMemoryStore(root) }
}
describe('Agent memory', () => {
  it('does not silently replace a missing snapshot on resume', async () => {
    const { store } = await setup()
    await expect(store.snapshot('w', 'missing', true)).rejects.toThrow()
  })
  it('reports sync failure and allows recovery by reading disk again', async () => {
    const { root, store } = await setup()
    const old = await store.read('soul')
    const failing = new AgentMemoryStore(root, { syncDirectory: async () => { throw new Error('sync failed') } })
    await expect(failing.save('soul', 'committed', old.revision)).rejects.toThrow('sync failed')
    const actual = await store.read('soul')
    expect(actual.content).toBe('committed')
    await expect(store.save('soul', 'stale', old.revision)).rejects.toThrow()
    expect((await store.save('soul', 'recovered', actual.revision)).content).toBe('recovered')
  })
  it('rejects malformed documents and snapshots without overwriting them', async () => {
    const { root, store } = await setup()
    await fs.writeFile(path.join(root, 'soul.md'), Buffer.from([0xff]))
    await expect(store.read('soul')).rejects.toThrow()
    await fs.rm(path.join(root, 'soul.md'))
    await store.snapshot('w', 'c')
    const [file] = await fs.readdir(path.join(root, 'memory-snapshots'))
    await fs.writeFile(path.join(root, 'memory-snapshots', file), '{}')
    await expect(store.snapshot('w', 'c')).rejects.toThrow()
  })
  it('surfaces read and rename failures and preserves committed content', async () => {
    const { root, store } = await setup()
    const initial = await store.read('user')
    await fs.mkdir(path.join(root, 'soul.md'))
    await expect(store.read('soul')).rejects.toThrow()
    const failing = new AgentMemoryStore(root, { rename: async () => { throw new Error('rename failed') } })
    await expect(failing.save('user', 'new', initial.revision)).rejects.toThrow('rename failed')
    expect(await store.read('user')).toEqual(initial)
    expect((await fs.readdir(root)).filter(name => name.endsWith('.tmp'))).toEqual([])
  })
  it('pins snapshots across edits and restart but loads current memory for a new conversation', async () => {
    const { root, store } = await setup()
    const first = await store.snapshot('workspace', 'conversation')
    await store.save('user', '新画像', first.user.revision)
    expect(await new AgentMemoryStore(root).snapshot('workspace', 'conversation')).toEqual(first)
    expect((await store.snapshot('workspace', 'next')).user.content).toBe('新画像')
    expect((await store.snapshot('other-workspace', 'conversation')).user.content).toBe('新画像')
  })
  it('rejects competing stale writes, even across store instances', async () => {
    const { root, store } = await setup()
    const initial = await store.read('user')
    const results = await Promise.allSettled([store.save('user', 'one', initial.revision), new AgentMemoryStore(root).save('user', 'two', initial.revision)])
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
  })
  it('persists editable markdown across restart', async () => {
    const { root, store } = await setup()
    const initial = await store.read('soul')
    const saved = await store.save('soul', '回答简洁', initial.revision)
    expect(saved.content).toBe('回答简洁')
    expect(await fs.readFile(path.join(root, 'soul.md'), 'utf8')).toBe('回答简洁')
    expect(await new AgentMemoryStore(root).read('soul')).toEqual(saved)
  })
})
