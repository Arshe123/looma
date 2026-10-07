import { afterEach, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { AgentMemoryStore } from '../AgentMemoryStore'
import { AgentLedgerStore } from '../AgentLedgerStore'
import { createMemoryRunDelta } from '../../../../shared/utils/agent-memory-net'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))) })
async function setup() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'looma-receipts-')); roots.push(root)
  return { root, store: new AgentMemoryStore(root) }
}
async function write(store: AgentMemoryStore, text: string, identity = { id: randomUUID() as string, timestamp: Date.now() }) {
  const before = await store.read('user')
  const { createHash } = await import('node:crypto')
  const after = { content: text, revision: createHash('sha256').update(text).digest('hex') }
  const receipt = { ...identity, workspaceId: 'w', taskId: 't', runId: 'r', change: createMemoryRunDelta().record(before, after) }
  await store.save('user', text, before.revision, () => true, receipt)
  return receipt
}
it('replays in committed write order even when wall time ties or moves backwards', async () => {
  const { store } = await setup()
  const first = await write(store, 'first', { id: 'ffffffff-ffff-4fff-8fff-ffffffffffff', timestamp: 100 })
  const second = await write(store, 'second', { id: '00000000-0000-4000-8000-000000000000', timestamp: 100 })
  const third = await write(store, 'third', { id: '11111111-1111-4111-8111-111111111111', timestamp: 99 })
  const observed: string[] = []
  await store.replayReceipts(async receipt => { observed.push(receipt.id); return true })
  expect(observed).toEqual([first.id, second.id, third.id])
})
it('drains older unacknowledged run receipts before a later live success', async () => {
  const { store } = await setup()
  const first = await write(store, 'temporary')
  const second = await write(store, '')
  const observed: string[] = []
  await store.deliverReceipt(second.id, async receipt => { observed.push(receipt.id) })
  expect(observed).toEqual([first.id, second.id])
  await store.replayReceipts(async () => { throw new Error('older receipt must not replay after newer success') })
})
it('honors the live main sequence reservation while other stream events are queued', async () => {
  const { root, store } = await setup()
  const receipt = await write(store, 'one')
  const ledger = new AgentLedgerStore(path.join(root, 'ledger'))
  await ledger.commit({ kind: 'run_created', runs: [{ id: 'r', taskId: 't', conversationId: 'c', requestId: 'req', inputMessageId: 'in', assistantMessageId: 'out', createdAt: 1 }] })
  await Promise.all([
    ledger.commitMemoryReceipt(receipt, 2),
    ledger.commit({ kind: 'event_commit', events: [{ id: 'terminal', runId: 'r', taskId: 't', sequence: 3, timestamp: 2, family: 'execution', type: 'run_cancelled', payload: { reason: 'cancelled' } }] }),
  ])
  expect((await ledger.materialize()).events.map(event => event.sequence)).toEqual([2, 3])
  expect(await ledger.audit()).toEqual([])
})
it('does not deliver a saved receipt after confirmed cleanup has purged it', async () => {
  const { store } = await setup()
  const receipt = await write(store, 'private')
  const preview = await store.previewCleanup({ history: true, snapshots: true, user: true })
  await store.cleanup(preview.selection, preview.token)
  let delivered = false
  expect(await store.deliverReceipt(receipt.id, async () => { delivered = true })).toBe(false)
  expect(delivered).toBe(false)
})
it('replays to the original canonical run with an idempotent stable event after ledger commit / acknowledgement crash', async () => {
  const { root, store } = await setup()
  const receipt = await write(store, 'one')
  const ledger = new AgentLedgerStore(path.join(root, 'workspace', '.looma', 'agent-ledger'))
  await ledger.commit({ kind: 'run_created', runs: [{ id: 'r', taskId: 't', conversationId: 'c', requestId: 'req', inputMessageId: 'in', assistantMessageId: 'out', createdAt: 1 }] })
  await expect(store.replayReceipts(async item => { await ledger.commitMemoryReceipt(item); throw new Error('crash before ack') })).rejects.toThrow('crash before ack')
  await new AgentMemoryStore(root).replayReceipts(async item => { await ledger.commitMemoryReceipt(item); return true })
  const view = await ledger.materialize()
  expect(view.events).toHaveLength(1)
  expect(view.events[0]).toMatchObject({ id: `evt_memory_${receipt.id.replace(/-/g, '')}`, runId: 'r', taskId: 't', type: 'memory_updated', sequence: 1 })
  expect(await ledger.audit(view)).toEqual([])
  await expect(ledger.commitMemoryReceipt({ ...receipt, runId: 'unknown' })).rejects.toThrow()
})
it('keeps per-save committed evidence across later writes and restart until durable acknowledgement', async () => {
  const { root, store } = await setup()
  const first = await write(store, 'one')
  const second = await write(store, 'two')
  const restarted = new AgentMemoryStore(root)
  const observed: string[] = []
  await expect(restarted.replayReceipts(async receipt => { observed.push(receipt.id); throw new Error('ledger offline') })).rejects.toThrow('ledger offline')
  expect(observed).toHaveLength(1)
  observed.length = 0
  await restarted.replayReceipts(async receipt => { observed.push(receipt.id); return true })
  expect(observed.sort()).toEqual([first.id, second.id].sort())
  await restarted.replayReceipts(async () => { throw new Error('duplicate') })
  expect((await restarted.read('user')).content).toBe('two')
})
