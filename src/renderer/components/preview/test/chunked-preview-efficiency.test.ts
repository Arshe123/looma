import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as vue from 'vue'
import * as scrollSync from '@/shared/utils/editor-scroll-sync'
import * as imagePath from '@/shared/utils/markdown-image-path'

// Execute the real setup script with controlled lifecycle/DOM boundaries in Node.
const setup = (sync = false) => {
  const source = readFileSync(new URL('../ChunkedMarkdownPreview.vue', import.meta.url), 'utf8').split('<script setup lang="ts">')[1].split('</script>')[0]
  const mounted: Array<() => void> = []
  const unmount: Array<() => void> = []
  const frames: Array<() => void> = []
  vi.stubGlobal('requestAnimationFrame', (fn: () => void) => { frames.push(fn); return frames.length })
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
  const props = { content: '', filePath: '/notes/a.md', isPartial: true, isLoadingMore: false, totalBytes: 100, scrollSyncEnabled: sync }
  const emit = vi.fn()
  const require = (id: string) => id === 'vue'
    ? { ...vue, onMounted: (fn: () => void) => mounted.push(fn), onBeforeUnmount: (fn: () => void) => unmount.push(fn), onActivated: vi.fn(), onDeactivated: vi.fn(), watch: vi.fn() }
    : id.includes('editor-scroll-sync') ? scrollSync : id.includes('markdown-image-path') ? imagePath : {}
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  const api = new Function('require', 'defineProps', 'defineEmits', 'defineExpose', `const exports = {};\n${code}\nreturn { containerRef, handleScroll, getScrollState, resolveLocalImages };`)(require, () => props, () => emit, () => {})
  const query = vi.fn(() => [])
  api.containerRef.value = { scrollHeight: 2000, scrollTop: 1000, clientHeight: 800, removeEventListener: vi.fn(), querySelectorAll: query, getBoundingClientRect: () => ({ top: 0 }) }
  return { api, props, emit, query, unmount, frames, flush: () => { frames.splice(0).forEach(fn => fn()) } }
}
const deferred = <T,>() => {
  let resolve!: (value: T) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const image = () => ({ getAttribute: () => 'image.png', src: 'image.png', isConnected: true })

describe('chunked preview image reads', () => {
  it('shares in-flight reads across images and generations but only updates the current generation', async () => {
    const h = setup()
    const read = deferred<{ success: boolean; data: string }>()
    const readFileBase64 = vi.fn(() => read.promise)
    vi.stubGlobal('window', { electronAPI: { file: { readFileBase64 } } })
    const old = image()
    h.query.mockReturnValue([old] as never)
    const first = h.api.resolveLocalImages()
    await vue.nextTick()
    const current = [image(), image()]
    h.query.mockReturnValue(current as never)
    const second = h.api.resolveLocalImages()
    await vue.nextTick()
    expect(readFileBase64).toHaveBeenCalledTimes(1)
    read.resolve({ success: true, data: 'data:image/png;base64,a' })
    await Promise.all([first, second])
    expect(old.src).toBe('image.png')
    expect(current.map(img => img.src)).toEqual(['data:image/png;base64,a', 'data:image/png;base64,a'])
  })
  it('does not mutate images after unmount and retries rejected reads', async () => {
    const h = setup()
    const read = deferred<{ success: boolean; data: string }>()
    const readFileBase64 = vi.fn().mockRejectedValueOnce(new Error('read failed')).mockReturnValue(read.promise)
    vi.stubGlobal('window', { electronAPI: { file: { readFileBase64 } } })
    const img = image()
    h.query.mockReturnValue([img] as never)
    await expect(h.api.resolveLocalImages()).rejects.toThrow('read failed')
    const retry = h.api.resolveLocalImages()
    await vue.nextTick()
    h.unmount.forEach(fn => fn())
    read.resolve({ success: true, data: 'data:image/png;base64,a' })
    await retry
    expect(readFileBase64).toHaveBeenCalledTimes(2)
    expect(img.src).toBe('image.png')
  })
})
afterEach(() => { vi.unstubAllGlobals() })

describe('chunked preview scroll work', () => {
  it('skips unused anchors in pure preview while preserving loading and explicit snapshots', () => {
    const h = setup()
    h.api.handleScroll()
    h.flush()
    expect(h.emit).toHaveBeenCalledWith('load-more')
    expect(h.query).not.toHaveBeenCalled()
    expect(h.emit).not.toHaveBeenCalledWith('scroll-sync', expect.anything())
    h.api.getScrollState()
    expect(h.query).toHaveBeenCalledWith('[data-line]')
  })
  it('coalesces split scroll events and rechecks mode before the frame', () => {
    const h = setup(true)
    h.api.handleScroll()
    h.api.handleScroll()
    h.flush()
    expect(h.query).toHaveBeenCalledTimes(1)
    expect(h.emit).toHaveBeenCalledWith('scroll-sync', expect.objectContaining({ ratio: expect.any(Number) }))
    h.api.handleScroll()
    h.props.scrollSyncEnabled = false
    h.flush()
    expect(h.query).toHaveBeenCalledTimes(1)
  })
})
