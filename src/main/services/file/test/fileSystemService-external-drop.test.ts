import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { fileSystemService } from '../fileSystemService'

const tempDirectories: string[] = []

const createTempDirectory = async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'looma-external-drop-'))
  tempDirectories.push(directory)
  return directory
}

afterEach(async () => {
  await Promise.all(tempDirectories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })))
})

describe('fileSystemService.copyExternalEntries', () => {
  it('copies external files and folders into a workspace directory while preserving sources', async () => {
    const directory = await createTempDirectory()
    const workspace = path.join(directory, 'workspace')
    const desktop = path.join(directory, 'desktop')
    await fs.mkdir(path.join(workspace, 'inbox'), { recursive: true })
    await fs.mkdir(path.join(desktop, 'materials'), { recursive: true })
    const sourceFile = path.join(desktop, 'brief.md')
    const sourceFolder = path.join(desktop, 'materials')
    await fs.writeFile(sourceFile, '# brief', 'utf8')
    await fs.writeFile(path.join(sourceFolder, 'notes.txt'), 'notes', 'utf8')

    const result = await fileSystemService.copyExternalEntries(
      workspace,
      [sourceFile, sourceFolder],
      'inbox',
    )

    expect(result).toEqual({
      success: true,
      data: {
        copied: [
          { name: 'brief.md', relativePath: 'inbox/brief.md', isDirectory: false },
          { name: 'materials', relativePath: 'inbox/materials', isDirectory: true },
        ],
      },
    })
    await expect(fs.readFile(path.join(workspace, 'inbox', 'brief.md'), 'utf8')).resolves.toBe('# brief')
    await expect(fs.readFile(path.join(workspace, 'inbox', 'materials', 'notes.txt'), 'utf8')).resolves.toBe('notes')
    await expect(fs.readFile(sourceFile, 'utf8')).resolves.toBe('# brief')
    await expect(fs.readFile(path.join(sourceFolder, 'notes.txt'), 'utf8')).resolves.toBe('notes')
  })

  it('prevents overwriting an existing destination before copying anything', async () => {
    const directory = await createTempDirectory()
    const workspace = path.join(directory, 'workspace')
    const desktop = path.join(directory, 'desktop')
    await fs.mkdir(workspace, { recursive: true })
    await fs.mkdir(desktop, { recursive: true })
    const sourceFile = path.join(desktop, 'brief.md')
    await fs.writeFile(sourceFile, 'new', 'utf8')
    await fs.writeFile(path.join(workspace, 'brief.md'), 'existing', 'utf8')

    const result = await fileSystemService.copyExternalEntries(workspace, [sourceFile], '')

    expect(result.success).toBe(false)
    expect(result.error).toContain('目标路径已存在')
    await expect(fs.readFile(sourceFile, 'utf8')).resolves.toBe('new')
    await expect(fs.readFile(path.join(workspace, 'brief.md'), 'utf8')).resolves.toBe('existing')
  })

  it('rejects copying a workspace parent directory into the workspace', async () => {
    const directory = await createTempDirectory()
    const workspace = path.join(directory, 'parent', 'workspace')
    await fs.mkdir(workspace, { recursive: true })

    const result = await fileSystemService.copyExternalEntries(workspace, [path.dirname(workspace)], '')

    expect(result.success).toBe(false)
    expect(result.error).toContain('不能复制包含当前工作空间的目录')
  })
})

describe('fileSystemService.importImageToNoteAssets', () => {
  it('copies a dropped image into the note assets directory', async () => {
    const directory = await createTempDirectory()
    const workspace = path.join(directory, 'workspace')
    const desktop = path.join(directory, 'desktop')
    await fs.mkdir(path.join(workspace, 'notes'), { recursive: true })
    await fs.mkdir(desktop, { recursive: true })
    await fs.writeFile(path.join(workspace, 'notes', 'note.md'), '# note', 'utf8')
    const sourceImage = path.join(desktop, 'cover.png')
    await fs.writeFile(sourceImage, 'image', 'utf8')

    const result = await fileSystemService.importImageToNoteAssets(workspace, 'notes/note.md', sourceImage)

    expect(result).toEqual({
      success: true,
      data: { relativePath: 'assets/cover.png', fileName: 'cover.png' },
    })
    await expect(fs.readFile(path.join(workspace, 'notes', 'assets', 'cover.png'), 'utf8')).resolves.toBe('image')
  })

  it('rejects a note path outside the workspace', async () => {
    const directory = await createTempDirectory()
    const workspace = path.join(directory, 'workspace')
    const sourceImage = path.join(directory, 'cover.png')
    await fs.mkdir(workspace, { recursive: true })
    await fs.writeFile(path.join(directory, 'outside.md'), '# outside', 'utf8')
    await fs.writeFile(sourceImage, 'image', 'utf8')

    const result = await fileSystemService.importImageToNoteAssets(workspace, '../outside.md', sourceImage)

    expect(result.success).toBe(false)
    expect(result.error).toContain('工作空间内')
  })
})
