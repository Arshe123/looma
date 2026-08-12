import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'

const { readImageMock, availableFormatsMock } = vi.hoisted(() => ({
  readImageMock: vi.fn(),
  availableFormatsMock: vi.fn(),
}))

vi.mock('electron', () => ({
  app: { getPath: () => os.tmpdir() },
  shell: { showItemInFolder: vi.fn() },
  clipboard: {
    readImage: readImageMock,
    availableFormats: availableFormatsMock,
  },
}))

import { fileSystemService } from '../fileSystemService'

const createImage = (isEmpty: boolean, png = Buffer.from('fake-png'), jpeg = Buffer.from('fake-jpeg')) => ({
  isEmpty: () => isEmpty,
  toPNG: () => png,
  toJPEG: (quality: number) => {
    expect(quality).toBe(95)
    return jpeg
  },
})

describe('fileSystemService.pasteClipboardImage', () => {
  let workspace = ''

  beforeEach(async () => {
    workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'looma-paste-image-'))
  })

  afterEach(async () => {
    await fs.rm(workspace, { recursive: true, force: true })
    vi.clearAllMocks()
  })

  it('saves the clipboard image as a PNG file in the target directory', async () => {
    readImageMock.mockReturnValue(createImage(false))
    availableFormatsMock.mockReturnValue(['public.png', 'public.tiff'])

    const result = await fileSystemService.pasteClipboardImage(workspace, '')

    expect(result.success).toBe(true)
    expect(result.data?.name).toMatch(/^截图-\d{8}-\d{6}\.png$/)
    expect(result.data?.relativePath).toBe(result.data?.name)
    const saved = await fs.readFile(path.join(workspace, result.data!.name))
    expect(saved.toString()).toBe('fake-png')
  })

  it('imports a clipboard screenshot into the current note assets directory', async () => {
    readImageMock.mockReturnValue(createImage(false))
    availableFormatsMock.mockReturnValue(['public.png', 'public.tiff'])
    await fs.mkdir(path.join(workspace, 'notes'), { recursive: true })
    await fs.writeFile(path.join(workspace, 'notes', 'note.md'), '# note', 'utf8')

    const result = await fileSystemService.importClipboardImageToNoteAssets(workspace, 'notes/note.md')

    expect(result.success).toBe(true)
    expect(result.data?.relativePath).toMatch(/^assets\/截图-\d{8}-\d{6}\.png$/)
    expect(result.data?.fileName).toMatch(/^截图-\d{8}-\d{6}\.png$/)
    const saved = await fs.readFile(path.join(workspace, 'notes', result.data!.relativePath))
    expect(saved.toString()).toBe('fake-png')
  })

  it('writes JPEG when the clipboard carried a JPEG format', async () => {
    readImageMock.mockReturnValue(createImage(false))
    availableFormatsMock.mockReturnValue(['public.jpeg'])
    await fs.mkdir(path.join(workspace, 'sub'))

    const result = await fileSystemService.pasteClipboardImage(workspace, 'sub')

    expect(result.success).toBe(true)
    expect(result.data?.name).toMatch(/^截图-\d{8}-\d{6}\.jpg$/)
    expect(result.data?.relativePath).toBe(`sub/${result.data?.name}`)
    const saved = await fs.readFile(path.join(workspace, 'sub', result.data!.name))
    expect(saved.toString()).toBe('fake-jpeg')
  })

  it('auto-renames with an incrementing suffix when the file already exists', async () => {
    readImageMock.mockReturnValue(createImage(false))
    availableFormatsMock.mockReturnValue(['public.png'])

    const first = await fileSystemService.pasteClipboardImage(workspace, '')
    expect(first.success).toBe(true)
    // 同名文件立刻再粘一次，应得到 "截图-xxx (2).png"
    const second = await fileSystemService.pasteClipboardImage(workspace, '')

    expect(second.success).toBe(true)
    expect(second.data?.name).toBe(`${first.data!.name.replace(/\.png$/, '')} (2).png`)
    const entries = await fs.readdir(workspace)
    expect(entries).toHaveLength(2)
  })

  it('fails cleanly when the clipboard holds no image', async () => {
    readImageMock.mockReturnValue(createImage(true))
    availableFormatsMock.mockReturnValue(['public.png'])

    const result = await fileSystemService.pasteClipboardImage(workspace, '')

    expect(result.success).toBe(false)
    expect(result.error).toContain('剪贴板中没有图片')
    expect(await fs.readdir(workspace)).toEqual([])
  })

  it('rejects a target directory outside the workspace', async () => {
    readImageMock.mockReturnValue(createImage(false))

    const result = await fileSystemService.pasteClipboardImage(workspace, '../outside')

    expect(result.success).toBe(false)
    expect(result.error).toContain('工作空间内')
  })
})
