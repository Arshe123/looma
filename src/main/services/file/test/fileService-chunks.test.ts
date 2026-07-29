import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { fileService } from '../fileService'

const tempDirectories: string[] = []

afterEach(async () => {
  await Promise.all(tempDirectories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })))
})

describe('fileService.readTextChunk', () => {
  it('returns UTF-8-safe byte offsets that reconstruct the complete file', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'looma-note-chunks-'))
    tempDirectories.push(directory)
    const filePath = path.join(directory, 'large.md')
    const expected = '# 标题\n🙂 emoji\n结尾'
    await fs.writeFile(filePath, expected, 'utf8')

    const contents: string[] = []
    let offset = 0
    let done = false
    while (!done) {
      const result = await fileService.readTextChunk(filePath, offset, 4)
      expect(result.success).toBe(true)
      expect(result.data).toBeDefined()
      expect(result.data!.offset).toBe(offset)
      expect(result.data!.nextOffset).toBeGreaterThan(offset)
      contents.push(result.data!.content)
      offset = result.data!.nextOffset
      done = result.data!.done
    }

    expect(contents.join('')).toBe(expected)
    expect(offset).toBe(Buffer.byteLength(expected, 'utf8'))
  })

  it('clamps offsets beyond the end of the file', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'looma-note-chunks-'))
    tempDirectories.push(directory)
    const filePath = path.join(directory, 'note.md')
    await fs.writeFile(filePath, 'note', 'utf8')

    const result = await fileService.readTextChunk(filePath, 99, 8)

    expect(result).toEqual({
      success: true,
      data: { content: '', offset: 4, nextOffset: 4, totalBytes: 4, done: true },
    })
  })

  it('makes progress even when the requested length is shorter than one UTF-8 character', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'looma-note-chunks-'))
    tempDirectories.push(directory)
    const filePath = path.join(directory, 'unicode.md')
    await fs.writeFile(filePath, '你a', 'utf8')

    const first = await fileService.readTextChunk(filePath, 0, 1)
    const second = await fileService.readTextChunk(filePath, first.data!.nextOffset, 1)

    expect(first.data).toMatchObject({ content: '你', offset: 0, nextOffset: 3, done: false })
    expect(second.data).toMatchObject({ content: 'a', offset: 3, nextOffset: 4, done: true })
  })
})
