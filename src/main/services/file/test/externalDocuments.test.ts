import { afterEach, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { ExternalDocuments } from '../externalDocuments'

const roots: string[] = []
it('transfers ownership without deleting drafts or overwriting conflicting disk content', async () => {
  const { file, service } = await fixture()
  const doc = await service.open(file, 1)
  await service.draft(doc.id, 1, '# Latest', doc.baseContent)
  await fs.writeFile(file, '# Conflict')
  service.transferOwner(doc.id, 1, 2)
  expect(service.ownerFor(doc.filePath)).toBe(2)
  await expect(service.save(doc.id, 1, 'bad', '# Conflict')).rejects.toThrow('授权')
  expect((await service.open(file, 2)).content).toBe('# Latest')
  expect(await fs.readFile(file, 'utf8')).toBe('# Conflict')
})
afterEach(async () => { await Promise.all(roots.map(root => fs.rm(root, { recursive: true, force: true }))) })
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'looma-external-test-'))
  roots.push(root)
  const file = path.join(root, '中文 note.md')
  await fs.writeFile(file, '# Original')
  return { root, file, service: new ExternalDocuments(path.join(root, 'userData')) }
}
it('recovers dirty drafts independently, protects disk conflicts, and forgets normally closed documents', async () => {
  const { root, file, service } = await fixture()
  const doc = await service.open(file, 1)
  await service.draft(doc.id, 1, '# Draft', doc.baseContent)
  const restarted = new ExternalDocuments(path.join(root, 'userData'))
  expect(await restarted.recoveryPaths()).toEqual([await fs.realpath(file)])
  const recovered = await restarted.open(file, 3)
  expect(recovered.content).toBe('# Draft')
  await fs.writeFile(file, '# Changed elsewhere')
  await expect(restarted.save(doc.id, 3, '# Draft', recovered.baseContent)).rejects.toThrow('修改')
  expect(await fs.readFile(file, 'utf8')).toBe('# Changed elsewhere')
  await restarted.close(doc.id, 3)
  expect(await restarted.recoveryPaths()).toEqual([])
  await expect(restarted.save(doc.id, 3, 'x', '# Changed elsewhere')).rejects.toThrow('授权')
})
it('requires a baseline for every save and refuses a replaced symlink target', async () => {
  const { root, file, service } = await fixture()
  const doc = await service.open(file, 1)
  await expect(service.save(doc.id, 1, 'bad', undefined as unknown as string)).rejects.toThrow('基线')
  const other = path.join(root, 'other.md')
  await fs.writeFile(other, '# Original')
  await fs.rm(file)
  await fs.symlink(other, file)
  await expect(service.save(doc.id, 1, 'bad', '# Original')).rejects.toThrow('路径')
  expect(await fs.readFile(other, 'utf8')).toBe('# Original')
})
it('opens canonical identities once and only permits the owning renderer to save the original', async () => {
  const { root, file, service } = await fixture()
  const alias = path.join(root, 'alias.md')
  await fs.symlink(file, alias)
  const first = await service.open(file, 1)
  expect((await service.open(alias, 1)).id).toBe(first.id)
  await expect(service.save(first.id, 2, '# denied', '# Original')).rejects.toThrow('授权')
  await service.save(first.id, 1, '# Edited', '# Original')
  expect(await fs.readFile(file, 'utf8')).toBe('# Edited')
  expect(await fs.readdir(root)).not.toContain('.looma')
})
