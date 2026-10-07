import { afterEach, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { AgentMemoryStore } from '../AgentMemoryStore'
import { openUserProfileBridge } from '../UserProfileBridge'
import { AgentLedgerStore } from '../AgentLedgerStore'
import { projectMemoryUpdates } from '../../../../shared/utils/agent-memory-net'
import type { AgentEvent } from '../../../../shared/types/agent-events'

const cleanup: Array<() => Promise<unknown>> = []
it('journals a real bridge update before reporting tool success and invalidates old capabilities after cleanup', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'profile-outbox-'))
  cleanup.push(() => fs.rm(root, { recursive: true, force: true }))
  const store = new AgentMemoryStore(root)
  const updated = vi.fn(async () => { throw new Error('ledger unavailable') })
  const bridge = await openUserProfileBridge(store, 'r', undefined, undefined, updated, () => true, { workspaceId: 'w', taskId: 't', runId: 'r' })
  cleanup.push(bridge.close)
  const call = async (tool: string, args = {}) => (await fetch(bridge.config.url, {
    method: 'POST', headers: { Authorization: `Bearer ${bridge.config.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ runId: 'r', tool, arguments: args }),
  })).json()
  const before = (await call('user_profile_read')).data
  expect((await call('user_profile_update', { content: 'private', expectedRevision: before.revision })).success).toBe(false)
  expect((await store.read('user')).content).toBe('private')
  const preview = await store.previewCleanup({ user: true, history: true, snapshots: true })
  expect(preview.counts.receipts).toBe(1)
  await store.cleanup(preview.selection, preview.token)
  const read = (await call('user_profile_read')).data
  expect((await call('user_profile_update', { content: 'resurrected', expectedRevision: read.revision })).success).toBe(false)
  await store.replayReceipts(async () => { throw new Error('must not replay forgotten text') })
  expect((await store.read('user')).content).toBe('')
})
it('does not split successful net history when an intervening profile rename fails', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'profile-failed-delta-'))
  cleanup.push(() => fs.rm(root, { recursive: true, force: true }))
  let fail = false
  const store = new AgentMemoryStore(root, { rename: async (from, to) => {
    if (fail && String(to).endsWith('user.md')) throw new Error('injected rename failure')
    await fs.rename(from, to)
  } })
  const updated = vi.fn()
  const bridge = await openUserProfileBridge(store, 'r', undefined, undefined, updated, () => true, { workspaceId: 'w', taskId: 't', runId: 'r' })
  cleanup.push(bridge.close)
  const call = async (tool: string, args = {}) => (await fetch(bridge.config.url, {
    method: 'POST', headers: { Authorization: `Bearer ${bridge.config.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ runId: 'r', tool, arguments: args }),
  })).json()
  const update = async (content: string) => call('user_profile_update', { content, expectedRevision: (await call('user_profile_read')).data.revision })
  expect((await update('one')).success).toBe(true)
  fail = true
  expect((await update('failed')).success).toBe(false)
  fail = false
  expect((await update('one\ntwo')).success).toBe(true)
  expect(updated.mock.calls.at(-1)?.[0].net).toEqual({ segment: 1, changes: [{ type: 'added', text: 'one\ntwo' }] })
})
it('persists exact multi-save net receipts and replays after store/ledger restart across competing writes', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'profile-net-ledger-'))
  cleanup.push(() => fs.rm(root, { recursive: true, force: true }))
  const store = new AgentMemoryStore(root)
  const ledger = new AgentLedgerStore(path.join(root, 'ledger'))
  const events: AgentEvent[] = []
  const bridge = await openUserProfileBridge(store, 'run_net', undefined, undefined, async payload => {
    const sequence = events.length + 1
    const event: AgentEvent = { id: `e${sequence}`, sequence, taskId: 'task', runId: 'run_net', timestamp: sequence, family: 'artifact', type: 'memory_updated', payload }
    await ledger.commit({ kind: 'event_commit', events: [event] })
    events.push(event)
  }, () => true)
  cleanup.push(bridge.close)
  const call = async (tool: string, args = {}) => (await fetch(bridge.config.url, {
    method: 'POST', headers: { Authorization: `Bearer ${bridge.config.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ runId: 'run_net', tool, arguments: args }),
  })).json()
  const update = async (content: string) => {
    const read = await call('user_profile_read')
    expect((await call('user_profile_update', { content, expectedRevision: read.data.revision })).success).toBe(true)
  }
  await update('临时\n重复\n重复')
  await update('最后🙂\n重复')
  const projected = [{ id: 'e2', changes: [{ type: 'added', text: '最后🙂\n重复' }] }]
  expect(projectMemoryUpdates(events)).toEqual(projected)
  expect(projectMemoryUpdates((await new AgentLedgerStore(path.join(root, 'ledger')).materialize()).events)).toEqual(projected)
  await update('')
  expect(projectMemoryUpdates(events)).toEqual([])
  const current = await store.read('user')
  await new AgentMemoryStore(root).save('user', 'manual private', current.revision)
  await update('manual private\nour final')
  expect(projectMemoryUpdates(events)).toEqual([{ id: 'e4', changes: [{ type: 'added', text: 'our final' }] }])
  expect(projectMemoryUpdates((await new AgentLedgerStore(path.join(root, 'ledger')).materialize()).events)).toEqual(projectMemoryUpdates(events))
})
afterEach(async () => { for (const close of cleanup.reverse()) await close(); cleanup.length = 0 })
it('persists through the main store and requires a fresh read before a versioned update', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'profile-bridge-'))
  cleanup.push(() => fs.rm(root, { recursive: true, force: true }))
  const store = new AgentMemoryStore(root)
  const snapshot = await store.snapshot('w', 'old')
  const updated = vi.fn()
  const bridge = await openUserProfileBridge(store, 'run_a', undefined, undefined, updated, () => true)
  cleanup.push(bridge.close)
  const call = async (tool: string, args = {}, token = bridge.config.token, runId = 'run_a') => {
    const response = await fetch(bridge.config.url, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ runId, tool, arguments: args }) })
    return { status: response.status, body: await response.json() }
  }
  expect((await call('user_profile_read', {}, 'wrong')).status).toBe(403)
  expect((await call('user_profile_read', {}, bridge.config.token, 'other')).status).toBe(403)
  expect((await call('user_profile_update', { content: '中文', expectedRevision: snapshot.user.revision })).body.success).toBe(false)
  const read = (await call('user_profile_read')).body.data
  expect(read).toEqual(snapshot.user)
  expect(updated).not.toHaveBeenCalled()
  const update = await call('user_profile_update', { content: '中文', expectedRevision: read.revision })
  expect(update.body.success).toBe(true)
  expect(updated).toHaveBeenCalledWith({ kind: 'user', beforeRevision: read.revision, afterRevision: update.body.data.revision, changes: [{ type: 'added', text: '中文' }], net: { segment: 1, changes: [{ type: 'added', text: '中文' }] } })
  await call('user_profile_read')
  expect((await call('user_profile_update', { content: '中文', expectedRevision: update.body.data.revision })).body.success).toBe(true)
  expect(updated).toHaveBeenCalledTimes(1)
  expect(await new AgentMemoryStore(root).read('user')).toEqual(update.body.data)
  expect(await store.snapshot('w', 'old')).toEqual(snapshot)
  expect((await store.snapshot('w', 'new')).user.content).toBe('中文')
  await call('user_profile_read')
  await store.save('user', '设置中的新版本', update.body.data.revision)
  expect((await call('user_profile_update', { content: 'stale', expectedRevision: update.body.data.revision })).body.code).toBe('user_profile_conflict')
  expect((await store.read('user')).content).toBe('设置中的新版本')
  expect((await call('user_profile_update', { kind: 'soul', content: 'bad', expectedRevision: read.revision })).body.success).toBe(false)
  expect((await call('file_patch', { path: '../soul.md' })).body.success).toBe(false)
  expect(await store.read('soul')).toEqual(snapshot.soul)
  expect(updated).toHaveBeenCalledTimes(1)
})

it('allows only one competing run to commit the same revision', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'profile-race-'))
  cleanup.push(() => fs.rm(root, { recursive: true, force: true }))
  const bridges = await Promise.all(['run_a', 'run_b'].map(runId => openUserProfileBridge(new AgentMemoryStore(root), runId, undefined, undefined, undefined, () => true)))
  cleanup.push(...bridges.map(bridge => bridge.close))
  const call = async (index: number, tool: string, args = {}) => (await fetch(bridges[index].config.url, {
    method: 'POST', headers: { Authorization: `Bearer ${bridges[index].config.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ runId: ['run_a', 'run_b'][index], tool, arguments: args }),
  })).json()
  const reads = await Promise.all([call(0, 'user_profile_read'), call(1, 'user_profile_read')])
  const results = await Promise.all(reads.map((read, index) => call(index, 'user_profile_update', { content: `winner ${index}`, expectedRevision: read.data.revision })))
  const winners = results.filter(result => result.success)
  expect(winners).toHaveLength(1)
  expect(results.find(result => !result.success)?.code).toBe('user_profile_conflict')
  expect(await new AgentMemoryStore(root).read('user')).toEqual(winners[0].data)
  const loserIndex = results.findIndex(result => !result.success)
  const latest = await call(loserIndex, 'user_profile_read')
  const merged = await call(loserIndex, 'user_profile_update', { content: latest.data.content + '\nmerged', expectedRevision: latest.data.revision })
  expect(merged.success).toBe(true)
  expect(await new AgentMemoryStore(root).read('user')).toEqual(merged.data)
})

it('rejects browser origins, alternate routes and arbitrary file arguments', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'profile-security-'))
  cleanup.push(() => fs.rm(root, { recursive: true, force: true }))
  const store = new AgentMemoryStore(root)
  const bridge = await openUserProfileBridge(store, 'run_a')
  cleanup.push(bridge.close)
  const init = { method: 'POST', headers: { Authorization: `Bearer ${bridge.config.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ runId: 'run_a', tool: 'user_profile_read', arguments: {} }) }
  expect((await fetch(bridge.config.url, { ...init, headers: { ...init.headers, Origin: 'https://untrusted.example' } })).status).toBe(403)
  expect((await fetch(bridge.config.url + '/soul.md', init)).status).toBe(403)
  expect((await fetch(bridge.config.url, { ...init, body: JSON.stringify({ runId: 'run_a', tool: 'user_profile_read', arguments: { path: '../soul.md' } }) })).status).toBe(400)
  expect((await fetch(bridge.config.url, { ...init, body: 'x'.repeat(120001) })).status).toBe(400)
  expect((await store.read('soul')).content).toBe('')
  expect((await store.read('user')).content).toBe('')
})

it('blocks disabled tools and revoked run capabilities', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'profile-policy-'))
  cleanup.push(() => fs.rm(root, { recursive: true, force: true }))
  const store = new AgentMemoryStore(root)
  const controller = new AbortController()
  const bridge = await openUserProfileBridge(store, 'run_a', controller.signal, ['user_profile_read'])
  cleanup.push(bridge.close)
  const call = async (tool: string, args = {}) => fetch(bridge.config.url, { method: 'POST', headers: { Authorization: `Bearer ${bridge.config.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ runId: 'run_a', tool, arguments: args }) })
  const read = await (await call('user_profile_read')).json()
  const blocked = await call('user_profile_update', { content: 'bad', expectedRevision: read.data.revision })
  expect(blocked.status).toBe(403)
  expect((await store.read('user')).content).toBe('')
  controller.abort()
  await expect(call('user_profile_read')).rejects.toThrow()
})

it('does not begin saving when authorization is revoked during the preflight read', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'profile-cancel-'))
  cleanup.push(() => fs.rm(root, { recursive: true, force: true }))
  const store = new AgentMemoryStore(root)
  const initial = await store.read('user')
  const controller = new AbortController()
  const bridge = await openUserProfileBridge(store, 'run_a', controller.signal, undefined, undefined, () => true)
  cleanup.push(bridge.close)
  const call = async (tool: string, args = {}) => fetch(bridge.config.url, { method: 'POST', headers: { Authorization: `Bearer ${bridge.config.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ runId: 'run_a', tool, arguments: args }) })
  await call('user_profile_read')
  let release!: () => void
  let entered!: () => void
  const waiting = new Promise<void>(resolve => { entered = resolve })
  const gate = new Promise<void>(resolve => { release = resolve })
  vi.spyOn(store, 'read').mockImplementationOnce(async () => { entered(); await gate; return initial })
  const save = vi.spyOn(store, 'save')
  const pending = call('user_profile_update', { content: 'must not save', expectedRevision: initial.revision }).catch(() => undefined)
  await waiting
  controller.abort()
  release()
  await pending
  await bridge.close()
  expect(save).not.toHaveBeenCalled()
  expect(await new AgentMemoryStore(root).read('user')).toEqual(initial)
})

it('records a save that finishes after cancellation and records later clearing as a deletion', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'profile-receipt-cancel-'))
  cleanup.push(() => fs.rm(root, { recursive: true, force: true }))
  const store = new AgentMemoryStore(root)
  const controller = new AbortController()
  const updated = vi.fn()
  const bridge = await openUserProfileBridge(store, 'run_a', controller.signal, undefined, updated, () => true)
  cleanup.push(bridge.close)
  const call = async (tool: string, args = {}) => (await fetch(bridge.config.url, { method: 'POST', headers: { Authorization: `Bearer ${bridge.config.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ runId: 'run_a', tool, arguments: args }) })).json()
  const read = await call('user_profile_read')
  const save = store.save.bind(store)
  let release!: () => void
  let entered!: () => void
  const waiting = new Promise<void>(resolve => { entered = resolve })
  const gate = new Promise<void>(resolve => { release = resolve })
  vi.spyOn(store, 'save').mockImplementationOnce(async (...args) => {
    const saved = await save(...args)
    entered(); await gate
    return saved
  })
  const pending = call('user_profile_update', { content: '中文\n🙂', expectedRevision: read.data.revision }).catch(() => undefined)
  await waiting
  controller.abort()
  release()
  await pending
  await bridge.close()
  expect(updated).toHaveBeenCalledTimes(1)
  expect(updated.mock.calls[0][0].changes).toEqual([{ type: 'added', text: '中文\n🙂' }])
  expect((await new AgentMemoryStore(root).read('user')).content).toBe('中文\n🙂')
  const next = await openUserProfileBridge(store, 'run_b', undefined, undefined, updated, () => true)
  cleanup.push(next.close)
  const nextCall = async (tool: string, args = {}) => (await fetch(next.config.url, { method: 'POST', headers: { Authorization: `Bearer ${next.config.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ runId: 'run_b', tool, arguments: args }) })).json()
  const latest = await nextCall('user_profile_read')
  expect((await nextCall('user_profile_update', { content: '', expectedRevision: latest.data.revision })).success).toBe(true)
  expect(updated).toHaveBeenCalledTimes(2)
  expect(updated.mock.calls[1][0].changes).toEqual([{ type: 'removed', text: '中文\n🙂' }])
})

it('reports failed persistence without replacing the committed profile or leaking paths', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'profile-failure-'))
  cleanup.push(() => fs.rm(root, { recursive: true, force: true }))
  const store = new AgentMemoryStore(root)
  const initial = await store.read('user')
  const saved = await store.save('user', '保留', initial.revision)
  const failing = new AgentMemoryStore(root, { rename: async () => { throw new Error(`secret path ${root}`) } })
  const updated = vi.fn()
  const bridge = await openUserProfileBridge(failing, 'run_a', undefined, undefined, updated, () => true)
  cleanup.push(bridge.close)
  const call = async (tool: string, args = {}) => (await fetch(bridge.config.url, { method: 'POST', headers: { Authorization: `Bearer ${bridge.config.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ runId: 'run_a', tool, arguments: args }) })).json()
  await call('user_profile_read')
  const failure = await call('user_profile_update', { content: 'new', expectedRevision: saved.revision })
  expect(failure.success).toBe(false)
  expect(updated).not.toHaveBeenCalled()
  expect(failure.code).toBe('user_profile_storage_failed')
  expect(JSON.stringify(failure)).not.toContain(root)
  expect(await store.read('user')).toEqual(saved)
  await call('user_profile_read')
  for (const content of ['x'.repeat(16001), '\0']) {
    const invalid = await call('user_profile_update', { content, expectedRevision: saved.revision })
    expect(invalid.code).toBe('user_profile_invalid')
    expect(await store.read('user')).toEqual(saved)
  }
  await fs.writeFile(path.join(root, 'user.md'), 'x'.repeat(16001))
  expect((await call('user_profile_read')).code).toBe('user_profile_storage_failed')
})
