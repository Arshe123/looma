import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readRegularFileIdentity, sameFileIdentity } from '../fileIdentity'

const directories: string[] = []
const fixture = async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'file-identity-'))
  directories.push(directory)
  const file = path.join(directory, 'note.md')
  await fs.writeFile(file, 'original')
  return { directory, file }
}

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(directories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })))
})

describe('regular file identity', () => {
  it('compares device IDs from handles even when Windows path stat reports zero', async () => {
    const { file } = await fixture()
    const lstat = fs.lstat.bind(fs)
    vi.spyOn(fs, 'lstat').mockImplementation((async (...args: Parameters<typeof fs.lstat>) => {
      const result = await lstat(...args)
      return Object.assign(result, { dev: 0n })
    }) as typeof fs.lstat)
    const handle = await fs.open(file, 'r')
    try {
      const expected = await handle.stat({ bigint: true })
      const actual = await readRegularFileIdentity(file)
      expect(sameFileIdentity(actual, expected)).toBe(true)
      expect(actual.ino).toBeTypeOf('bigint')
      expect(actual.dev).toBe(expected.dev)
    } finally {
      await handle.close()
    }
  })

  it('still rejects different devices and distinct file IDs above the safe integer limit', () => {
    const identity = { dev: 1n, ino: 9007199254740992n, birthtimeMs: 1n }
    expect(sameFileIdentity(identity, { ...identity, dev: 2n })).toBe(false)
    expect(sameFileIdentity(identity, { ...identity, ino: 9007199254740993n })).toBe(false)
    expect(sameFileIdentity(identity, { ...identity, birthtimeMs: 2n })).toBe(false)
  })

  it('rejects a file replaced between lstat and opening the read-only handle', async () => {
    const { file } = await fixture()
    const open = fs.open.bind(fs)
    vi.spyOn(fs, 'open').mockImplementationOnce(async (...args) => {
      await fs.rename(file, file + '.original')
      await fs.writeFile(file, 'unrelated')
      return open(...args)
    })
    await expect(readRegularFileIdentity(file)).rejects.toMatchObject({ code: 'PATH_TRAVERSAL' })
    expect(await fs.readFile(file, 'utf8')).toBe('unrelated')
    expect(await fs.readFile(file + '.original', 'utf8')).toBe('original')
  })

  it('rejects directories, including a real Windows directory junction', async () => {
    const { directory } = await fixture()
    await expect(readRegularFileIdentity(directory)).rejects.toMatchObject({ code: 'PATH_TRAVERSAL' })
    const link = path.join(directory, 'linked')
    await fs.symlink(directory, link, process.platform === 'win32' ? 'junction' : 'dir')
    await expect(readRegularFileIdentity(link)).rejects.toMatchObject({ code: 'PATH_TRAVERSAL' })
    await fs.unlink(link)
  })
})
