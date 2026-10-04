import { afterEach, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { AgentMemoryStore } from '../AgentMemoryStore'
import { openUserProfileBridge } from '../UserProfileBridge'
import { createAppSettingsService } from '../../app/appSettingsService'
import { normalizeAppSettings } from '../../../../shared/utils/app-settings'

const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => { for (const close of cleanup.reverse()) await close(); cleanup.length = 0 })
const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>(r => { resolve = r })
  return { promise, resolve }
}
async function setup() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'profile-toggle-'))
  cleanup.push(() => fs.rm(root, { recursive: true, force: true }))
  const settings = createAppSettingsService(path.join(root, 'settings.json'))
  await settings.getSettings()
  const toggle = (enabled: boolean) => settings.setSettings(normalizeAppSettings({ memory: { autoMaintainUserProfile: enabled } }))
  const store = new AgentMemoryStore(root)
  const updated = vi.fn()
  const bridge = await openUserProfileBridge(store, 'run_a', undefined, undefined, updated, settings.canAutoMaintainUserProfile)
  cleanup.push(bridge.close)
  const call = async (tool: string, args = {}, extra = {}) => {
    const response = await fetch(bridge.config.url, { method: 'POST', headers: { Authorization: `Bearer ${bridge.config.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ runId: 'run_a', tool, arguments: args, ...extra }) })
    return { status: response.status, body: await response.json() }
  }
  return { store, settings, toggle, updated, call, root }
}
it('revokes existing runs live, keeps reads/manual edits/snapshots, and allows reenable for an already capable run', async () => {
  const { store, toggle, updated, call } = await setup()
  const snapshot = await store.snapshot('w', 'old')
  const read = (await call('user_profile_read')).body.data
  await toggle(false)
  expect((await call('user_profile_update', { content: 'denied', expectedRevision: read.revision })).status).toBe(403)
  expect((await call('user_profile_update', { content: 'forged', expectedRevision: read.revision }, { autoMaintainUserProfile: true })).body.success).toBe(false)
  expect((await call('user_profile_read')).body.data).toEqual(read)
  expect(updated).not.toHaveBeenCalled()
  const manual = await store.save('user', 'manual', read.revision)
  await store.save('soul', 'manual personality', snapshot.soul.revision)
  expect(await store.snapshot('w', 'old')).toEqual(snapshot)
  expect((await store.snapshot('w', 'new')).user).toEqual(manual)
  await toggle(true)
  await call('user_profile_read')
  expect((await call('user_profile_update', { content: 'auto again', expectedRevision: manual.revision })).body.success).toBe(true)
  expect(updated).toHaveBeenCalledTimes(1)
})
it.each(['preflight', 'store-read', 'store-queue'])('rechecks OFF after async %s before beginning the atomic save', async boundary => {
  const { store, toggle, call, updated, root } = await setup()
  const initial = (await call('user_profile_read')).body.data
  const entered = deferred(); const release = deferred()
  let pending: Promise<unknown> | undefined
  let blocker: Promise<unknown> | undefined
  if (boundary === 'store-queue') {
    // Hold the shared store queue with a different manual write, without changing user revision.
    const blockingStore = new AgentMemoryStore(root, { rename: async (a, b) => { entered.resolve(); await release.promise; await fs.rename(a, b) } })
    blocker = blockingStore.save('soul', 'personality', (await store.read('soul')).revision)
    await entered.promise
    const saving = deferred()
    const save = store.save.bind(store)
    vi.spyOn(store, 'save').mockImplementation((...args) => { saving.resolve(); return save(...args) })
    pending = call('user_profile_update', { content: 'denied', expectedRevision: initial.revision })
    await saving.promise
  } else {
    const read = store.read.bind(store)
    let reads = 0
    vi.spyOn(store, 'read').mockImplementation(async kind => {
      const value = await read(kind)
      if (++reads === (boundary === 'preflight' ? 1 : 2)) { entered.resolve(); await release.promise }
      return value
    })
    pending = call('user_profile_update', { content: 'denied', expectedRevision: initial.revision })
    await entered.promise
  }
  await toggle(false)
  release.resolve()
  await blocker
  expect((await pending as { status: number }).status).toBe(403)
  expect((await new AgentMemoryStore(root).read('user')).content).toBe('')
  expect(updated).not.toHaveBeenCalled()
})

it('does not claim to undo a save already committing when OFF takes effect', async () => {
  const { store, toggle, call, updated } = await setup()
  const initial = (await call('user_profile_read')).body.data
  const entered = deferred(); const release = deferred()
  // atomicWrite has begun and created its temporary file before this rename.
  const rename = fs.rename.bind(fs)
  const spy = vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
    if (String(to).endsWith('user.md')) { entered.resolve(); await release.promise }
    return rename(from, to)
  })
  try {
    const pending = call('user_profile_update', { content: 'already saving', expectedRevision: initial.revision })
    await entered.promise
    await toggle(false)
    release.resolve()
    expect((await pending).body.success).toBe(true)
    expect((await store.read('user')).content).toBe('already saving')
    expect(updated).toHaveBeenCalledTimes(1)
    const next = (await call('user_profile_read')).body.data
    expect((await call('user_profile_update', { content: 'later denied', expectedRevision: next.revision })).status).toBe(403)
  } finally { release.resolve(); spy.mockRestore() }
})
