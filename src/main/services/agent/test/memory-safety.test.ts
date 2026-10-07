import { afterEach, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { AgentMemoryStore } from '../AgentMemoryStore'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))) })
async function setup() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'memory-safety-')); roots.push(root)
  return { root, store: new AgentMemoryStore(root) }
}
const hash = (text: string) => createHash('sha256').update(text).digest('hex')
it('rejects malformed receipt net metadata before replay reaches the ledger', async () => {
  const { root, store } = await setup()
  const id = randomUUID()
  await fs.mkdir(path.join(root, 'memory-receipts'))
  await fs.writeFile(path.join(root, 'memory-receipts', `${id}.json`), JSON.stringify({
    id, workspaceId: 'w', taskId: 't', runId: 'r', timestamp: 1, status: 'committed',
    change: { kind: 'user', beforeRevision: hash(''), afterRevision: hash('x'), changes: [{ type: 'added', text: 'x' }], net: { segment: 1, changes: 'invalid' } },
  }))
  let delivered = false
  await expect(store.replayReceipts(async () => { delivered = true; return true })).rejects.toThrow()
  expect(delivered).toBe(false)
})
it.each(['memory-snapshots', 'user-history'])('rejects a symlinked %s directory before writing outside memory', async directory => {
  const { root, store } = await setup()
  const foreign = await fs.mkdtemp(path.join(os.tmpdir(), 'foreign-memory-')); roots.push(foreign)
  await fs.symlink(foreign, path.join(root, directory))
  if (directory === 'memory-snapshots') await expect(store.snapshot('w', 'c')).rejects.toThrow()
  else await expect(store.save('user', 'private', hash(''))).rejects.toThrow()
  expect(await fs.readdir(foreign)).toEqual([])
})
it('does not accept a symlinked user file as commit proof for a pending receipt', async () => {
  const { root, store } = await setup()
  const foreign = path.join(root, 'foreign.txt')
  await fs.writeFile(foreign, 'x')
  await fs.symlink(foreign, path.join(root, 'user.md'))
  const id = randomUUID()
  await fs.mkdir(path.join(root, 'memory-receipts'))
  await fs.writeFile(path.join(root, 'memory-receipts', `${id}.json`), JSON.stringify({
    id, workspaceId: 'w', taskId: 't', runId: 'r', timestamp: 1, status: 'pending',
    change: { kind: 'user', beforeRevision: hash(''), afterRevision: hash('x'), changes: [{ type: 'added', text: 'x' }] },
  }))
  await expect(store.replayReceipts(async () => true)).rejects.toThrow()
  expect(await fs.readFile(foreign, 'utf8')).toBe('x')
})
it('notifies other windows when commit-marker persistence fails after profile rename', async () => {
  const { root } = await setup()
  const store = new AgentMemoryStore(root, { rename: async (from, to) => {
    if (String(to).includes('memory-receipts') && JSON.parse(await fs.readFile(from, 'utf8')).status === 'committed') throw new Error('marker failure')
    await fs.rename(from, to)
  } })
  const notifications: unknown[] = []
  const stop = AgentMemoryStore.subscribe(root, event => notifications.push(event))
  try {
    await expect(store.save('user', 'saved', hash(''), () => true, {
      id: randomUUID(), workspaceId: 'w', taskId: 't', runId: 'r', timestamp: 1,
      change: { kind: 'user', beforeRevision: hash(''), afterRevision: hash('saved'), changes: [{ type: 'added', text: 'saved' }] },
    })).rejects.toThrow('marker failure')
    expect((await store.read('user')).content).toBe('saved')
    expect(notifications).toEqual([{ kind: 'user' }])
  } finally { stop() }
})
it('retries profile-directory durability before promoting pending commit evidence', async () => {
  const { root } = await setup()
  const id = randomUUID()
  await fs.writeFile(path.join(root, 'user.md'), 'saved')
  await fs.mkdir(path.join(root, 'memory-receipts'))
  const file = path.join(root, 'memory-receipts', `${id}.json`)
  await fs.writeFile(file, JSON.stringify({ id, workspaceId: 'w', taskId: 't', runId: 'r', timestamp: 1, status: 'pending',
    change: { kind: 'user', beforeRevision: hash(''), afterRevision: hash('saved'), changes: [{ type: 'added', text: 'saved' }] } }))
  const store = new AgentMemoryStore(root, { syncDirectory: async directory => { if (directory === root) throw new Error('profile directory unavailable') } })
  let delivered = false
  await expect(store.replayReceipts(async () => { delivered = true; return true })).rejects.toThrow('profile directory unavailable')
  expect(delivered).toBe(false)
  expect(JSON.parse(await fs.readFile(file, 'utf8')).status).toBe('pending')
})
it('does not create a notification/read retry loop when cleanup stays blocked', async () => {
  const { root } = await setup()
  await fs.writeFile(path.join(root, 'user.md'), 'private')
  await fs.writeFile(path.join(root, 'memory-cleanup.json'), JSON.stringify({ version: 1, records: ['user.md'] }))
  const store = new AgentMemoryStore(root, { syncDirectory: async () => { throw new Error('persistent sync failure') } })
  const notifications: unknown[] = []
  const stop = AgentMemoryStore.subscribe(root, event => notifications.push(event))
  try {
    await expect(store.recover()).rejects.toThrow('persistent sync failure')
    await expect(store.recover()).rejects.toThrow('persistent sync failure')
    expect(notifications).toEqual([{ kind: 'user' }])
  } finally { stop() }
})
it('invalidates open windows when an interrupted cleanup is recovered', async () => {
  const { root, store } = await setup()
  await fs.writeFile(path.join(root, 'user.md'), 'private')
  await fs.writeFile(path.join(root, 'memory-cleanup.json'), JSON.stringify({ version: 1, records: ['user.md'] }))
  const notifications: unknown[] = []
  const stop = AgentMemoryStore.subscribe(root, event => notifications.push(event))
  try {
    await store.recover()
    expect((await store.read('user')).content).toBe('')
    expect(notifications).toEqual([{ kind: 'user' }])
  } finally { stop() }
})
it.each(['../foreign.txt', 'soul.md', 'memory-snapshots/../../foreign.txt'])('refuses unsafe cleanup journal record %s without deleting anything', async record => {
  const { root, store } = await setup()
  await fs.writeFile(path.join(root, 'soul.md'), 'keep')
  await fs.writeFile(path.join(root, 'memory-cleanup.json'), JSON.stringify({ version: 1, records: [record] }))
  await expect(store.recover()).rejects.toThrow('日志损坏')
  expect(await fs.readFile(path.join(root, 'soul.md'), 'utf8')).toBe('keep')
})
