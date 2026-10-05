import { afterEach, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { AgentMemoryStore } from '../AgentMemoryStore'

const roots: string[] = []
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))) })
async function setup() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'looma-history-'))
  roots.push(root)
  await fs.writeFile(path.join(root, 'user.md'), '升级前画像')
  return { root, store: new AgentMemoryStore(root) }
}
it('backs up pre-feature content, survives restart, restores reversibly with current CAS', async () => {
  const { root, store } = await setup()
  const old = await store.read('user')
  const pinned = await store.snapshot('w', 'old')
  const saved = await store.save('user', '手动修改', old.revision)
  const restarted = new AgentMemoryStore(root)
  const history = await restarted.listUserHistory()
  expect(history.entries).toHaveLength(1)
  expect(history.entries[0]).toMatchObject({ revision: old.revision, source: 'manual' })
  expect(await restarted.readUserHistory(history.entries[0].id)).toMatchObject({ content: old.content })
  await expect(restarted.restoreUserHistory(history.entries[0].id, old.revision)).rejects.toThrow('更新')
  const restored = await restarted.restoreUserHistory(history.entries[0].id, saved.revision)
  expect(restored).toEqual(old)
  const next = await restarted.listUserHistory()
  expect(next.entries).toHaveLength(2)
  expect(next.entries[0].source).toBe('restore')
  expect(await restarted.restoreUserHistory(next.entries[0].id, restored.revision)).toEqual(saved)
  expect(await restarted.snapshot('w', 'old')).toEqual(pinned)
  expect((await restarted.snapshot('w', 'new')).user).toEqual(saved)
})

it('isolates corrupt history without leaking its content and still restores healthy versions', async () => {
  const { root, store } = await setup()
  const original = await store.read('user')
  await store.save('user', 'middle', original.revision)
  const current = await store.save('user', 'current', (await store.read('user')).revision)
  const before = await store.listUserHistory()
  const damaged = before.entries[0].id
  await fs.writeFile(path.join(root, 'user-history', `${damaged}.json`), '{SECRET broken')
  const page = await store.listUserHistory()
  expect(page.entries).toHaveLength(2)
  expect(page.entries[0]).toEqual({ id: damaged, createdAt: Number(damaged.slice(0, 13)), status: 'invalid', error: '历史版本缺失或已损坏，无法查看或恢复。' })
  expect(page.entries[1]).toMatchObject({ status: 'valid', revision: original.revision })
  expect(JSON.stringify(page)).not.toContain('SECRET')
  await expect(store.restoreUserHistory(damaged, current.revision)).rejects.toThrow('损坏')
  expect(await store.restoreUserHistory(page.entries[1].id, current.revision)).toEqual(original)
  expect(await fs.readFile(path.join(root, 'user-history', `${damaged}.json`), 'utf8')).toBe('{SECRET broken')
})

it('keeps fully damaged pages and cursors stable without pruning, including unsafe record files', async () => {
  const { root, store } = await setup()
  for (let i = 0; i < 23; i++) await store.save('user', `v${i}`, (await store.read('user')).revision)
  const first = await store.listUserHistory()
  const second = await store.listUserHistory(first.nextCursor)
  const ids = [...first.entries, ...second.entries].map(entry => entry.id)
  const directory = path.join(root, 'user-history')
  for (const id of ids) await fs.writeFile(path.join(directory, `${id}.json`), '{SECRET')
  await fs.writeFile(path.join(directory, `${ids[1]}.json`), 'x'.repeat(100000))
  await fs.rm(path.join(directory, `${ids[2]}.json`))
  await fs.symlink(path.join(root, 'user.md'), path.join(directory, `${ids[2]}.json`))
  await fs.writeFile(path.join(directory, 'unsafe-id.json'), 'SECRET')
  const damagedFirst = await store.listUserHistory()
  const damagedSecond = await store.listUserHistory(damagedFirst.nextCursor)
  expect(damagedFirst.entries).toHaveLength(20)
  expect(damagedFirst.nextCursor).toBe(first.nextCursor)
  expect(damagedSecond.nextCursor).toBeUndefined()
  const entries = [...damagedFirst.entries, ...damagedSecond.entries]
  expect(entries.map(entry => entry.id)).toEqual(ids)
  expect(entries.every(entry => entry.status === 'invalid')).toBe(true)
  expect(JSON.stringify(entries)).not.toContain('SECRET')
  const current = await store.read('user')
  for (const id of [...ids, 'unsafe-id']) await expect(store.restoreUserHistory(id, current.revision)).rejects.toThrow()
  expect(await store.read('user')).toEqual(current)
  expect(await fs.readdir(directory)).toHaveLength(24)
})

it('surfaces directory enumeration permission errors instead of a healthy empty page', async () => {
  const { store } = await setup()
  await store.save('user', 'current', (await store.read('user')).revision)
  const error = Object.assign(new Error('directory permission failure'), { code: 'EACCES' })
  vi.spyOn(fs, 'readdir').mockRejectedValueOnce(error)
  await expect(store.listUserHistory()).rejects.toBe(error)
})

it('syncs the backup directory and its parent before committing current content', async () => {
  const { root, store } = await setup()
  const calls: string[] = []
  const instrumented = new AgentMemoryStore(root, {
    syncDirectory: async directory => { calls.push(`sync:${directory}`) },
    rename: async (from, to) => { calls.push(`rename:${to}`); await fs.rename(from, to) },
  })
  await instrumented.save('user', 'new', (await store.read('user')).revision)
  const commit = calls.indexOf(`rename:${path.join(root, 'user.md')}`)
  expect(calls.slice(0, commit)).toContain(`sync:${path.join(root, 'user-history')}`)
  expect(calls.slice(0, commit)).toContain(`sync:${root}`)
})

it('does not create history for no-op saves/restores or soul edits; tags agent backups in main', async () => {
  const { store } = await setup()
  const old = await store.read('user')
  await store.save('user', old.content, old.revision)
  await store.save('soul', '人格', (await store.read('soul')).revision)
  expect((await store.listUserHistory()).entries).toEqual([])
  const changed = await store.save('user', 'Agent 修改', old.revision, () => true)
  const first = (await store.listUserHistory()).entries[0]
  expect(first.source).toBe('agent')
  await store.restoreUserHistory(first.id, changed.revision)
  await store.restoreUserHistory(first.id, old.revision)
  expect((await store.listUserHistory()).entries).toHaveLength(2)
})

it.each(['backup-rename', 'backup-sync', 'parent-sync', 'current-rename', 'current-sync'])('preserves original content on %s failure without recording attempted content', async fault => {
  const { root, store } = await setup()
  const old = await store.read('user')
  let currentRenamed = false
  const failing = new AgentMemoryStore(root, {
    rename: async (from, to) => {
      const current = to === path.join(root, 'user.md')
      if (fault === (current ? 'current-rename' : 'backup-rename')) throw new Error('injected')
      await fs.rename(from, to)
      if (current) currentRenamed = true
    },
    syncDirectory: async directory => {
      if (fault === (directory.endsWith('user-history') ? 'backup-sync' : currentRenamed ? 'current-sync' : 'parent-sync')) throw new Error('injected')
    },
  })
  await expect(failing.save('user', 'attempt', old.revision)).rejects.toThrow('injected')
  const history = await new AgentMemoryStore(root).listUserHistory()
  for (const entry of history.entries) expect((await store.readUserHistory(entry.id)).content).toBe(old.content)
  if (fault === 'current-sync') {
    expect((await store.read('user')).content).toBe('attempt')
    await store.restoreUserHistory(history.entries[0].id, (await store.read('user')).revision)
  }
  expect(await store.read('user')).toEqual(old)
})

it('rechecks live authorization after a durable backup before writing current', async () => {
  const { root, store } = await setup()
  let allowed = true
  const guarded = new AgentMemoryStore(root, { syncDirectory: async () => { allowed = false } })
  const old = await store.read('user')
  await expect(guarded.save('user', 'denied', old.revision, () => allowed)).rejects.toThrow('授权')
  expect(await store.read('user')).toEqual(old)
  expect((await store.listUserHistory()).entries[0].source).toBe('agent')
})

it('rejects traversal, corrupt content/revisions, oversized files and symlinks without changing current', async () => {
  const { root, store } = await setup()
  const saved = await store.save('user', 'current', (await store.read('user')).revision)
  const id = (await store.listUserHistory()).entries[0].id
  const file = path.join(root, 'user-history', `${id}.json`)
  const entry = await store.readUserHistory(id)
  for (const bad of ['../user.md', `${id}/..`, '', `${id}.json`]) {
    await expect(store.restoreUserHistory(bad, saved.revision)).rejects.toThrow('标识')
    await expect(store.listUserHistory(bad)).rejects.toThrow('标识')
  }
  for (const body of [{ ...entry, content: 'tampered' }, { ...entry, id: 'other' }, { ...entry, source: 'renderer' }, { ...entry, createdAt: 0 }, { ...entry, content: '\0' }, { ...entry, content: 'x'.repeat(16001) }]) {
    await fs.writeFile(file, JSON.stringify(body))
    await expect(store.restoreUserHistory(id, saved.revision)).rejects.toThrow('损坏')
  }
  await fs.writeFile(file, 'x'.repeat(100000))
  await expect(store.readUserHistory(id)).rejects.toThrow('损坏')
  await fs.rm(file)
  await fs.symlink(path.join(root, 'user.md'), file)
  await expect(store.restoreUserHistory(id, saved.revision)).rejects.toThrow('损坏')
  expect(await store.read('user')).toEqual(saved)
})

it('paginates metadata without pruning and serializes competing restore/save CAS', async () => {
  const { root, store } = await setup()
  for (let i = 0; i < 23; i++) await store.save('user', `v${i}`, (await store.read('user')).revision)
  const first = await store.listUserHistory()
  const second = await store.listUserHistory(first.nextCursor)
  expect(first.entries).toHaveLength(20)
  expect(second.entries).toHaveLength(3)
  expect(second.nextCursor).toBeUndefined()
  expect(first.entries[0]).not.toHaveProperty('content')
  expect(new Set([...first.entries, ...second.entries].map(entry => entry.id)).size).toBe(23)
  const current = await store.read('user')
  const results = await Promise.allSettled([
    store.restoreUserHistory(first.entries[0].id, current.revision),
    new AgentMemoryStore(root).save('user', 'competitor', current.revision),
  ])
  expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
})

it('rejects a symlinked history directory before saving or restoring', async () => {
  const { root, store } = await setup()
  const saved = await store.save('user', 'current', (await store.read('user')).revision)
  const id = (await store.listUserHistory()).entries[0].id
  await fs.rename(path.join(root, 'user-history'), path.join(root, 'other'))
  await fs.symlink(path.join(root, 'other'), path.join(root, 'user-history'))
  await expect(store.listUserHistory()).rejects.toThrow('历史')
  await expect(store.restoreUserHistory(id, saved.revision)).rejects.toThrow('历史')
  await expect(store.save('user', 'unsafe', saved.revision)).rejects.toThrow('历史')
  expect(await store.read('user')).toEqual(saved)
})

it('keeps both the selected backup and current original when restore commit fails', async () => {
  const { root, store } = await setup()
  const current = await store.save('user', 'current', (await store.read('user')).revision)
  const id = (await store.listUserHistory()).entries[0].id
  const selected = await store.readUserHistory(id)
  const failing = new AgentMemoryStore(root, { rename: async (from, to) => {
    if (to === path.join(root, 'user.md')) throw new Error('restore rename failed')
    await fs.rename(from, to)
  } })
  await expect(failing.restoreUserHistory(id, current.revision)).rejects.toThrow('restore rename failed')
  expect(await store.read('user')).toEqual(current)
  expect(await store.readUserHistory(id)).toEqual(selected)
  const backup = (await store.listUserHistory()).entries[0]
  expect(backup.source).toBe('restore')
  expect((await store.readUserHistory(backup.id)).content).toBe(current.content)
})
