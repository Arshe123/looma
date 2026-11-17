import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { fileSystemService } from '../fileSystemService'

const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })))
})

it('enumerates every visible note and reports empty nested directories for graph watching', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'looma-note-inventory-'))
  directories.push(root)
  await fs.mkdir(path.join(root, 'notes', 'empty', 'deep'), { recursive: true })
  await fs.mkdir(path.join(root, '.looma'), { recursive: true })
  await fs.writeFile(path.join(root, 'notes', 'note.md'), '# Note')
  await fs.writeFile(path.join(root, 'root.TXT'), 'plain')
  await fs.writeFile(path.join(root, '.looma', 'private.md'), '# Internal')
  await fs.writeFile(path.join(root, 'image.png'), '')
  const visited: string[] = []
  const result = await fileSystemService.listNotes(root, dir => visited.push(dir))
  expect(result.success).toBe(true)
  expect(result.data?.sort()).toEqual(['notes/note.md', 'root.TXT'])
  expect(visited.sort()).toEqual(['.', 'notes', 'notes/empty', 'notes/empty/deep'])
  expect(await fileSystemService.listNotes(root)).toEqual(result)
  const inventory = await fileSystemService.listNotes(root, undefined, true)
  expect(inventory.data).toHaveLength(2)
  for (const entry of inventory.data || []) {
    expect(typeof entry).toBe('object')
    if (typeof entry !== 'string') expect(entry.createdAt).toBe((await fs.stat(path.join(root, entry.path))).birthtimeMs)
  }
})
