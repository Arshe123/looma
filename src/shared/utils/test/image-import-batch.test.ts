import { describe, expect, it, vi } from 'vitest'
import { importImageBatch } from '../image-import-batch'

const image = { relativePath: 'assets/cover.png', fileName: 'cover.png' }

describe('importImageBatch', () => {
  it('includes an editor insertion rejection in batch failures', async () => {
    const reportError = vi.fn()
    await importImageBatch({
      sourcePaths: ['ok.png'],
      importImage: async () => ({ success: true, data: image }),
      insertImages: () => 'Editor rejected insertion',
      reportError, setBusy: vi.fn(),
    })
    expect(reportError).toHaveBeenCalledWith('部分图片未能导入，其余图片已插入。', 'Editor rejected insertion')
  })

  it('reports all failures without attempting insertion', async () => {
    const insertImages = vi.fn()
    const reportError = vi.fn()
    await importImageBatch({
      sourcePaths: ['missing.png'],
      importImage: async () => ({ success: false }),
      insertImages, reportError, setBusy: vi.fn(),
    })
    expect(insertImages).not.toHaveBeenCalled()
    expect(reportError).toHaveBeenCalledWith('图片导入失败，请确认图片仍然存在且当前笔记目录可写。', 'missing.png')
  })

  it('releases busy if the editor insertion throws', async () => {
    const reportError = vi.fn()
    const setBusy = vi.fn()
    await importImageBatch({
      sourcePaths: ['ok.png'],
      importImage: async () => ({ success: true, data: image }),
      insertImages: () => { throw new Error('Transaction failed') },
      reportError, setBusy,
    })
    expect(reportError).toHaveBeenCalledWith('图片导入失败，请稍后重试。', 'Transaction failed')
    expect(setBusy).toHaveBeenLastCalledWith(false)
  })

  it.each([new Error('IPC rejected'), 'IPC rejected'])('releases busy and aborts without inserting on rejection: %s', async error => {
    const insertImages = vi.fn()
    const reportError = vi.fn()
    const setBusy = vi.fn()
    const importImage = vi.fn(async (path: string) => {
      if (path === 'bad.png') throw error
      return { success: true, data: image }
    })
    await expect(importImageBatch({
      sourcePaths: ['ok.png', 'bad.png', 'unreached.png'],
      importImage, insertImages, reportError, setBusy,
    })).resolves.toBeUndefined()
    expect(importImage.mock.calls.map(([path]) => path)).toEqual(['ok.png', 'bad.png'])
    expect(insertImages).not.toHaveBeenCalled()
    expect(reportError).toHaveBeenCalledWith('图片导入失败，请稍后重试。', 'IPC rejected')
    expect(setBusy).toHaveBeenLastCalledWith(false)
  })

  it('keeps successful imports and reports failed results in order', async () => {
    const insertImages = vi.fn()
    const reportError = vi.fn()
    const setBusy = vi.fn()
    await importImageBatch({
      sourcePaths: ['missing.png', 'ok.png', 'empty.png'],
      importImage: async path => path === 'ok.png'
        ? { success: true, data: image }
        : { success: path === 'empty.png', error: path === 'missing.png' ? 'Not found' : undefined },
      insertImages, reportError, setBusy,
    })
    expect(insertImages).toHaveBeenCalledWith([image])
    expect(reportError).toHaveBeenCalledWith('部分图片未能导入，其余图片已插入。', 'Not found\nempty.png')
    expect(setBusy).toHaveBeenLastCalledWith(false)
  })

  it('imports serially and inserts the completed batch while busy', async () => {
    const events: string[] = []
    let finishFirst!: (result: { success: boolean; data: typeof image }) => void
    const importImage = vi.fn((path: string) => {
      events.push(path)
      return path === 'first.png'
        ? new Promise<{ success: boolean; data: typeof image }>(resolve => { finishFirst = resolve })
        : Promise.resolve({ success: true, data: image })
    })
    const reportError = vi.fn()
    const pending = importImageBatch({
      sourcePaths: ['first.png', 'second.png'],
      importImage,
      setBusy: (busy, message) => events.push(`${busy}:${message || ''}`),
      insertImages: images => { expect(images).toEqual([image, image]); events.push('insert') },
      reportError,
    })
    expect(events).toEqual(['true:正在导入 2 张图片...', 'first.png'])
    finishFirst({ success: true, data: image })
    await pending
    expect(events).toEqual(['true:正在导入 2 张图片...', 'first.png', 'second.png', 'insert', 'false:'])
    expect(reportError).not.toHaveBeenCalled()
  })
})
