import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { fileService } from '../fileService'

const tempDirectories: string[] = []

const createTempDirectory = async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'looma-image-import-'))
  tempDirectories.push(directory)
  return directory
}

afterEach(async () => {
  await Promise.all(tempDirectories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })))
})

describe('fileService.copyImageToNoteAssets', () => {
  it('creates the note assets directory and returns a portable relative path', async () => {
    const directory = await createTempDirectory()
    const noteDirectory = path.join(directory, 'notes')
    const sourceDirectory = path.join(directory, 'source')
    await fs.mkdir(noteDirectory, { recursive: true })
    await fs.mkdir(sourceDirectory, { recursive: true })
    const notePath = path.join(noteDirectory, 'note.md')
    const sourcePath = path.join(sourceDirectory, 'cover.png')
    await fs.writeFile(notePath, '# note', 'utf8')
    await fs.writeFile(sourcePath, 'image-content', 'utf8')

    const result = await fileService.copyImageToNoteAssets(notePath, sourcePath)

    expect(result).toEqual({
      success: true,
      data: { relativePath: 'assets/cover.png', fileName: 'cover.png' },
    })
    expect(await fs.readFile(path.join(noteDirectory, 'assets', 'cover.png'), 'utf8')).toBe('image-content')
  })

  it('does not overwrite an existing asset with the same name', async () => {
    const directory = await createTempDirectory()
    const notePath = path.join(directory, 'note.md')
    const sourcePath = path.join(directory, 'cover.png')
    const assetsDirectory = path.join(directory, 'assets')
    await fs.mkdir(assetsDirectory, { recursive: true })
    await fs.writeFile(notePath, '# note', 'utf8')
    await fs.writeFile(sourcePath, 'new-image', 'utf8')
    await fs.writeFile(path.join(assetsDirectory, 'cover.png'), 'existing-image', 'utf8')

    const result = await fileService.copyImageToNoteAssets(notePath, sourcePath)

    expect(result.data).toEqual({ relativePath: 'assets/cover-1.png', fileName: 'cover-1.png' })
    expect(await fs.readFile(path.join(assetsDirectory, 'cover.png'), 'utf8')).toBe('existing-image')
    expect(await fs.readFile(path.join(assetsDirectory, 'cover-1.png'), 'utf8')).toBe('new-image')
  })

  it('rejects unsupported file types', async () => {
    const directory = await createTempDirectory()
    const sourcePath = path.join(directory, 'notes.txt')
    await fs.writeFile(sourcePath, 'not an image', 'utf8')

    const result = await fileService.copyImageToNoteAssets(path.join(directory, 'note.md'), sourcePath)

    expect(result.success).toBe(false)
    expect(result.error).toContain('Unsupported image type')
  })
})
