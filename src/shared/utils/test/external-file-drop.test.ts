import { describe, expect, it } from 'vitest'
import { captureFileTreeDrop, getDroppedFilePaths, isSupportedDroppedImagePath } from '../external-file-drop'

describe('external file drop utilities', () => {
  it('extracts unique native paths and ignores browser-only files', () => {
    expect(getDroppedFilePaths([
      { name: 'cover.png', path: 'C:\\Desktop\\cover.png' },
      { name: 'cover.png', path: 'C:\\Desktop\\cover.png' },
      { name: 'browser.png' },
      { name: 'blank.png', path: '   ' },
    ])).toEqual(['C:\\Desktop\\cover.png'])
  })

  it('recognizes supported image extensions case-insensitively', () => {
    expect(isSupportedDroppedImagePath('C:\\Desktop\\Cover.PNG')).toBe(true)
    expect(isSupportedDroppedImagePath('/tmp/photo.jpeg?raw=1')).toBe(true)
    expect(isSupportedDroppedImagePath('/tmp/notes.txt')).toBe(false)
  })

  it('captures native file paths synchronously from an external drop', () => {
    let filesReadable = true
    const dataTransfer = {
      types: ['Files'],
      get files() {
        return filesReadable
          ? [{ name: 'brief.md', path: 'C:\\Desktop\\brief.md' }]
          : []
      },
      getData: () => '',
    }

    const captured = captureFileTreeDrop(dataTransfer as unknown as DataTransfer)
    filesReadable = false

    expect(captured).toEqual({
      kind: 'external',
      sourcePaths: ['C:\\Desktop\\brief.md'],
    })
  })

  it('captures the internal tree payload without treating it as an OS drop', () => {
    const captured = captureFileTreeDrop({
      types: ['text/plain'],
      files: [] as unknown as FileList,
      getData: type => type === 'text/plain' ? '["notes/a.md"]' : '',
    })

    expect(captured).toEqual({ kind: 'internal', text: '["notes/a.md"]' })
  })
})
