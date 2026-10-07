import { afterEach, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { spawnSync } from 'node:child_process'
import { build } from 'esbuild'
import { AgentMemoryStore } from '../AgentMemoryStore'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))) })
it.each(['before-intent', 'before-profile', 'after-profile', 'after-commit'])('recovers actual child-process termination at %s without treating a prewrite backup as a save', async phase => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'looma-memory-crash-')); roots.push(root)
  const bundle = path.join(root, 'store.cjs')
  await build({ entryPoints: ['src/main/services/agent/AgentMemoryStore.ts'], outfile: bundle, platform: 'node', format: 'cjs', bundle: true })
  const program = `
    const fs = require('node:fs/promises'), { createHash, randomUUID } = require('node:crypto');
    const { AgentMemoryStore } = require(${JSON.stringify(bundle)});
    const phase = ${JSON.stringify(phase)}, root = ${JSON.stringify(root)};
    const store = new AgentMemoryStore(root, { rename: async (from, to) => {
      const receipt = String(to).includes('memory-receipts');
      const status = receipt ? JSON.parse(await fs.readFile(from, 'utf8')).status : '';
      if (phase === 'before-intent' && status === 'pending') process.exit(71);
      if (phase === 'before-profile' && String(to).endsWith('user.md')) process.exit(71);
      await fs.rename(from, to);
      if (phase === 'after-profile' && String(to).endsWith('user.md')) process.exit(71);
      if (phase === 'after-commit' && status === 'committed') process.exit(71);
    }});
    (async () => {
      const before = await store.read('user');
      await store.save('user', 'private crash fact', before.revision, () => true, {
        id: randomUUID(), workspaceId: 'w', taskId: 't', runId: 'r', timestamp: Date.now(),
        change: { kind: 'user', beforeRevision: before.revision, afterRevision: createHash('sha256').update('private crash fact').digest('hex'), changes: [{ type: 'added', text: 'private crash fact' }] }
      });
    })().catch(error => { console.error(error); process.exit(2) });
  `
  const child = spawnSync(process.execPath, ['-e', program], { encoding: 'utf8' })
  expect(child.status, child.stderr).toBe(71)
  const restarted = new AgentMemoryStore(root)
  const committed = phase.startsWith('after-')
  expect((await restarted.read('user')).content).toBe(committed ? 'private crash fact' : '')
  // Subsequent managed writes settle pending evidence before replacing the head.
  await restarted.save('user', 'later', (await restarted.read('user')).revision)
  const receipts: string[] = []
  await restarted.replayReceipts(async receipt => { receipts.push(receipt.change.afterRevision); return true })
  expect(receipts).toHaveLength(committed ? 1 : 0)
  const preview = await restarted.previewCleanup({ user: true, history: true, snapshots: true })
  await restarted.cleanup(preview.selection, preview.token)
  const residue = (await fs.readdir(root)).filter(name => name.startsWith('user.md.'))
  expect(residue).toEqual([])
  const receiptFiles = await fs.readdir(path.join(root, 'memory-receipts')).catch(() => [])
  expect(receiptFiles).toEqual([])
})
