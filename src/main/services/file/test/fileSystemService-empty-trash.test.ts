import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'

const mocks = vi.hoisted(() => ({ appData: '', trashItem: vi.fn() }))
vi.mock('electron', () => ({
  app: { getPath: () => mocks.appData },
  shell: { trashItem: mocks.trashItem },
  clipboard: {},
}))

import { fileSystemService } from '../fileSystemService'

describe('fileSystemService.emptyTrash', () => {
  let workspace: string
  let trashDir: string

  beforeEach(async () => {
    mocks.appData = await fs.mkdtemp(path.join(os.tmpdir(), 'looma-empty-trash-'))
    workspace = path.join(mocks.appData, 'workspace')
    trashDir = path.join(mocks.appData, 'workspace-meta', 'looma', 'trash', 'test')
    await fs.mkdir(workspace)
    mocks.trashItem.mockReset()
    mocks.trashItem.mockImplementation(async (target: string) => {
      await fs.rm(target, { recursive: true })
    })
  })

  afterEach(async () => {
    await fs.rm(mocks.appData, { recursive: true, force: true })
  })

  it('sends a deleted note to the system trash with its original Chinese name', async () => {
    await fs.mkdir(path.join(workspace, 'notes'))
    await fs.writeFile(path.join(workspace, 'notes', '中文笔记.md'), 'content')
    expect((await fileSystemService.softDelete('test', workspace, 'notes/中文笔记.md')).success).toBe(true)
    mocks.trashItem.mockImplementation(async (target: string) => {
      expect(path.basename(target)).toBe('中文笔记.md')
      expect(await fs.readFile(target, 'utf8')).toBe('content')
      await fs.unlink(target)
    })

    expect(await fileSystemService.emptyTrash('test')).toEqual({ success: true })
    expect(mocks.trashItem).toHaveBeenCalledOnce()
    expect(await fs.readdir(trashDir)).toEqual([])
  })

  it('restores the original recoverable trash entry when the system transfer fails', async () => {
    await fs.writeFile(path.join(workspace, '笔记.md'), 'keep')
    const deleted = await fileSystemService.softDelete('test', workspace, '笔记.md')
    mocks.trashItem.mockRejectedValue(new Error('转移失败'))

    expect((await fileSystemService.emptyTrash('test')).success).toBe(false)
    expect(await fs.readdir(trashDir)).toEqual([deleted.data!.trashRelativePath])
    expect(await fs.readFile(path.join(trashDir, deleted.data!.trashRelativePath), 'utf8')).toBe('keep')
    expect((await fileSystemService.restoreFromTrash('test', workspace, deleted.data!.trashRelativePath, '笔记.md')).success).toBe(true)
  })

  it('keeps identical original names separate and preserves deleted folders', async () => {
    for (const dir of ['a', 'b']) {
      await fs.mkdir(path.join(workspace, dir, '同名文件夹'), { recursive: true })
      await fs.writeFile(path.join(workspace, dir, '同名文件夹', '笔记.md'), dir)
      expect((await fileSystemService.softDelete('test', workspace, `${dir}/同名文件夹`)).success).toBe(true)
    }
    const contents: string[] = []
    mocks.trashItem.mockImplementation(async (target: string) => {
      expect(path.basename(target)).toBe('同名文件夹')
      contents.push(await fs.readFile(path.join(target, '笔记.md'), 'utf8'))
      await fs.rm(target, { recursive: true })
    })

    expect(await fileSystemService.emptyTrash('test')).toEqual({ success: true })
    expect(contents.sort()).toEqual(['a', 'b'])
    expect(await fs.readdir(trashDir)).toEqual([])
  })
})
