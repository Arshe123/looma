import { afterEach, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { AgentMemoryStore } from '../AgentMemoryStore'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))) })
async function setup() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'looma-cleanup-')); roots.push(root)
  const store = new AgentMemoryStore(root)
  await store.save('soul', 'keep personality', (await store.read('soul')).revision)
  await store.save('user', 'private fact', (await store.read('user')).revision)
  await store.snapshot('w', 'c')
  return { root, store }
}
it('resumes an interrupted tombstone before accepting another write, with no forgotten backup', async () => {
  const { root, store } = await setup()
  const preview = await store.previewCleanup({ history: true, snapshots: true, user: true })
  let armed = false
  const failing = new AgentMemoryStore(root, { syncDirectory: async directory => {
    if (armed && directory.endsWith('user-history')) throw new Error('interrupted deletion')
  }, rename: async (from, to) => { await fs.rename(from, to); if (String(to).endsWith('memory-cleanup.json')) armed = true } })
  await expect(failing.cleanup(preview.selection, preview.token)).rejects.toThrow('interrupted deletion')
  const restarted = new AgentMemoryStore(root)
  await restarted.recover()
  expect((await restarted.read('user')).content).toBe('')
  expect((await restarted.listUserHistory()).entries).toEqual([])
  await expect(fs.stat(path.join(root, 'memory-cleanup.json'))).rejects.toMatchObject({ code: 'ENOENT' })
})
it('binds cleanup confirmation to exact bytes even for corrupted UTF-8 records', async () => {
  const { root, store } = await setup()
  const directory = path.join(root, 'user-history')
  const [name] = await fs.readdir(directory)
  await fs.writeFile(path.join(directory, name), Buffer.from([0xff]))
  const selection = { history: true, snapshots: false, user: false }
  const preview = await store.previewCleanup(selection)
  await fs.writeFile(path.join(directory, name), Buffer.from([0xfe]))
  await expect(store.cleanup(selection, preview.token)).rejects.toThrow('重新预览')
})
it('rejects stale previews, foreign scope arguments, and symlink records or roots', async () => {
  const { root, store } = await setup()
  const selection = { history: true, snapshots: false, user: false }
  const preview = await store.previewCleanup(selection)
  await store.save('user', 'new fact', (await store.read('user')).revision)
  await expect(store.cleanup(selection, preview.token)).rejects.toThrow('重新预览')
  await expect(store.previewCleanup({ ...selection, path: '../' } as typeof selection)).rejects.toThrow('范围无效')
  const [record] = await fs.readdir(path.join(root, 'user-history'))
  await fs.unlink(path.join(root, 'user-history', record))
  await fs.symlink(path.join(root, 'soul.md'), path.join(root, 'user-history', record))
  await expect(store.previewCleanup(selection)).rejects.toThrow('链接')
  const linked = `${root}-link`; roots.push(linked); await fs.symlink(root, linked)
  await expect(new AgentMemoryStore(linked).previewCleanup(selection)).rejects.toThrow('链接')
})
it('previews exact managed records then clears user/history/snapshots without backing up forgotten data', async () => {
  const { root, store } = await setup()
  await fs.writeFile(path.join(root, 'user-history', 'foreign.txt'), 'unrelated')
  const preview = await store.previewCleanup({ history: true, snapshots: true, user: true })
  expect(preview.counts).toEqual({ history: 1, snapshots: 1, user: 1, receipts: 0 })
  expect(preview.skipped).toEqual(['user-history/foreign.txt'])
  await store.cleanup(preview.selection, preview.token)
  expect((await store.read('user')).content).toBe('')
  expect((await store.read('soul')).content).toBe('keep personality')
  expect((await store.listUserHistory()).entries).toEqual([])
  expect(await fs.readdir(path.join(root, 'memory-snapshots'))).toEqual([])
  expect(await fs.readFile(path.join(root, 'user-history', 'foreign.txt'), 'utf8')).toBe('unrelated')
})
