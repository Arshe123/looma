import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fileSystemService } from '../fileSystemService'

const tempDirectories: string[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(tempDirectories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })))
})

describe('fileSystemService.createFile', () => {
  it('creates a new file with supplied UTF-8 template content', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'looma-create-file-'))
    tempDirectories.push(directory)
    await fs.mkdir(path.join(directory, 'notes'))

    const result = await fileSystemService.createFile(directory, 'notes', 'daily.md', '# 每日笔记\n')

    expect(result).toEqual({ success: true, data: 'notes/daily.md' })
    await expect(fs.readFile(path.join(directory, 'notes', 'daily.md'), 'utf8')).resolves.toBe('# 每日笔记\n')
  })

  it('never overwrites an existing file when initial content is supplied', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'looma-create-file-'))
    tempDirectories.push(directory)
    await fs.writeFile(path.join(directory, 'daily.md'), 'keep', 'utf8')

    const result = await fileSystemService.createFile(directory, '', 'daily.md', 'replace')

    expect(result).toMatchObject({ success: false, errorCode: 'TARGET_EXISTS' })
    expect(await fs.readFile(path.join(directory, 'daily.md'), 'utf8')).toBe('keep')
  })

  it('removes its own new file when writing fails, using handle-based identity for rollback', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'looma-create-file-'))
    tempDirectories.push(directory)
    const open = fs.open.bind(fs)
    vi.spyOn(fs, 'open').mockImplementationOnce(async (...args) => {
      const handle = await open(...args)
      vi.spyOn(handle, 'writeFile').mockRejectedValueOnce(new Error('disk full'))
      return handle
    })

    const result = await fileSystemService.createFile(directory, '', 'daily.md', 'content')

    expect(result).toMatchObject({ success: false, error: '创建文件失败: disk full' })
    await expect(fs.lstat(path.join(directory, 'daily.md'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('keeps a substituted path intact when creation verification fails', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'looma-create-file-'))
    tempDirectories.push(directory)
    const file = path.join(directory, 'daily.md')
    const moved = path.join(directory, 'created.md')
    const open = fs.open.bind(fs)
    vi.spyOn(fs, 'open').mockImplementationOnce(async (...args) => {
      const handle = await open(...args)
      await fs.rename(file, moved)
      await fs.writeFile(file, 'unrelated')
      return handle
    })

    const result = await fileSystemService.createFile(directory, '', 'daily.md', 'template')

    expect(result).toMatchObject({ success: false, errorCode: 'PATH_TRAVERSAL' })
    expect(await fs.readFile(file, 'utf8')).toBe('unrelated')
    expect(await fs.readFile(moved, 'utf8')).toBe('')
  })

  it('rejects a parent directory symlink that escapes the workspace', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'looma-create-file-'))
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'looma-create-file-outside-'))
    tempDirectories.push(directory, outside)
    await fs.symlink(outside, path.join(directory, 'escape'), process.platform === 'win32' ? 'junction' : 'dir')

    const result = await fileSystemService.createFile(directory, 'escape', 'escaped.md', 'outside')

    expect(result).toMatchObject({ success: false, errorCode: 'PATH_TRAVERSAL' })
    await expect(fs.stat(path.join(outside, 'escaped.md'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('returns a readable localized error when the target directory is missing', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'looma-create-file-'))
    tempDirectories.push(directory)

    const result = await fileSystemService.createFile(directory, 'missing', 'note.md')

    expect(result).toMatchObject({ success: false })
    expect(result.error).toContain('创建文件失败')
  })
})
