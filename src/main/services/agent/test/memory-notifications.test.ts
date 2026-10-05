import { afterEach, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { AgentMemoryStore } from '../AgentMemoryStore'

const cleanup: Array<() => unknown> = []
it('reports uncertainty only after current-file rename, never false success on failed writes', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'memory-notify-fault-'))
  cleanup.push(() => fs.rm(root, { recursive: true, force: true }))
  const listener = vi.fn()
  cleanup.push(AgentMemoryStore.subscribe(root, listener))
  const store = new AgentMemoryStore(root)
  const doc = await store.read('soul')
  await expect(new AgentMemoryStore(root, { rename: async () => { throw Error('rename') } }).save('soul', 'new', doc.revision)).rejects.toThrow()
  expect(listener).not.toHaveBeenCalled()
  await expect(new AgentMemoryStore(root, { syncDirectory: async () => { throw Error('sync') } }).save('soul', 'new', doc.revision)).rejects.toThrow()
  expect(listener.mock.calls).toEqual([[{ kind: 'soul' }]])
  expect((await store.read('soul')).content).toBe('new')
})
afterEach(async () => { for (const fn of cleanup.reverse()) await fn(); cleanup.length = 0 })
it('invalidates subscribers across instances for manual, agent, and restore writes only', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'memory-notify-'))
  cleanup.push(() => fs.rm(root, { recursive: true, force: true }))
  const listener = vi.fn()
  const unsubscribe = AgentMemoryStore.subscribe(root, listener)
  cleanup.push(unsubscribe)
  const store = new AgentMemoryStore(root)
  let doc = await store.read('user')
  await store.save('user', '', doc.revision)
  expect(listener).not.toHaveBeenCalled()
  doc = await store.save('user', 'manual', doc.revision)
  expect(listener).toHaveBeenLastCalledWith({ kind: 'user', revision: doc.revision })
  doc = await new AgentMemoryStore(root).save('user', 'agent', doc.revision, () => true)
  expect(listener).toHaveBeenCalledTimes(2)
  await expect(store.save('user', 'bad', 'stale')).rejects.toThrow()
  expect(listener).toHaveBeenCalledTimes(2)
  const history = await store.listUserHistory()
  doc = await store.restoreUserHistory(history.entries[0].id, doc.revision)
  expect(listener).toHaveBeenLastCalledWith({ kind: 'user', revision: doc.revision })
  const soul = await store.read('soul')
  await store.save('soul', '', soul.revision)
  expect(listener).toHaveBeenCalledTimes(3)
  unsubscribe()
  await store.save('soul', 'quiet', soul.revision)
  expect(listener).toHaveBeenCalledTimes(3)
})
