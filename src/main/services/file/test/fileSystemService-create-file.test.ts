import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { fileSystemService } from '../fileSystemService'

const tempDirectories: string[] = []

afterEach(async () => {
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
