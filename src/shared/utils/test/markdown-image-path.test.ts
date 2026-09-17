import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { describe, expect, it, vi } from 'vitest'
import { resolveMarkdownImagePath } from '../markdown-image-path'

// Legacy characterization (executed before extraction): Chunked stripped query/hash
// AFTER decoding, losing a%23b.png; Tiptap sent a.png?v=1 to IPC and decoded twice.
// Chunked joined file: URLs to the note directory. Both rebased /absolute paths
// and collapsed the UNC prefix to one slash. The contract below fixes those differences.
describe('resolveMarkdownImagePath', () => {
  it.each([
    ['image.png', '/notes/sub/a.md', '/notes/sub/image.png'],
    ['../img/./a.PNG', '/notes/sub/a.md', '/notes/img/a.PNG'],
    ['../../../../a.png', '/notes/a.md', '/a.png'],
    ['image.png', '/a.md', '/image.png'],
    ['image.png', 'a.md', ''],
    ['image.png', '', ''],
    ['/tmp/a.png', '/notes/a.md', '/tmp/a.png'],
    ['/tmp/a.png', 'C:\\notes\\a.md', '/tmp/a.png'],
    ['C:\\img\\..\\a.png', '/notes/a.md', 'C:\\a.png'],
    ['C:/img/../a.png', '', 'C:/a.png'],
    ['..%5Cimg%5Ca.png', 'C:\\notes\\sub\\a.md', 'C:\\notes\\img\\a.png'],
    ['image.png', 'C:\\a.md', 'C:\\image.png'],
    ['\\\\server\\share\\dir\\..\\a.png', '/a.md', '\\\\server\\share\\a.png'],
    ['../../a.png', '\\\\server\\share\\dir\\a.md', '\\\\server\\share\\a.png'],
    ['file:///tmp/a%20b.png', '', '/tmp/a b.png'],
    ['file:///C:/img/a.png', '/notes/a.md', 'C:/img/a.png'],
    ['file://server/share/a.png', '', '\\\\server\\share\\a.png'],
    ['file://localhost/tmp/a.png', '', '/tmp/a.png'],
    ['a.png?v=1#preview', '/notes/a.md', '/notes/a.png'],
    ['a.png#preview?v=1', '/notes/a.md', '/notes/a.png'],
    ['a%23b%3Fc.png?v=1#preview', '/notes/a.md', '/notes/a#b?c.png'],
    ['file:///tmp/a%23b%3Fc.png?v=1#preview', '', '/tmp/a#b?c.png'],
    ['a%2523b.png', '/notes/a.md', '/notes/a%23b.png'],
    ['a%25.png', '/notes/a.md', '/notes/a%.png'],
    ['100%done.png', '/notes/a.md', '/notes/100%done.png'],
    ['a%20b%ZZ.png', '/notes/a.md', '/notes/a b%ZZ.png'],
    ['%E4%B8%AD%E6%96%87.png', '/notes/a.md', '/notes/中文.png'],
    ['a+b.png', '/notes/a.md', '/notes/a+b.png'],
    [' image.png ', '/notes/a.md', '/notes/image.png'],
  ])('%s relative to %s → %s', (source, note, expected) => {
    expect(resolveMarkdownImagePath(source, note)).toBe(expected)
  })

  it.each(['https://host/a.png', 'HTTP://host/a.png', 'data:image/png;base64,a', 'blob:https://host/a.png', '//host/a.png', 'ftp://host/a.png', 'custom:a.png', '', '#a.png', '?a.png', 'file://[invalid/a.png', 'image.txt', 'dir.png/file', 'C:relative.png'])('does not read non-local/unsupported source %s', (source) => {
    expect(resolveMarkdownImagePath(source, '/notes/a.md')).toBe('')
  })

  it.each(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'])('retains supported extension %s', extension => {
    expect(resolveMarkdownImagePath(`a.${extension}`, '/notes/a.md')).toBe(`/notes/a.${extension}`)
  })
})

describe('preview resolver wiring', () => {
  // Run the actual component image-loading functions without mounting unrelated
  // editor extensions. Only IPC and the nextTick/DOM boundaries are controlled.
  it.each(['ChunkedMarkdownPreview', 'TiptapPreview'])('%s reads the same decoded path once and leaves remote images alone', async component => {
    const source = readFileSync(new URL(`../../../renderer/components/preview/${component}.vue`, import.meta.url), 'utf8')
    const chunked = component === 'ChunkedMarkdownPreview'
    const start = chunked ? 'const imageCache =' : 'const isPassThroughImageSrc ='
    const end = chunked ? 'const requestMoreNearBoundary =' : 'const getScrollableBlocks ='
    const js = ts.transpileModule(source.slice(source.indexOf(start), source.indexOf(end)), {
      compilerOptions: { target: ts.ScriptTarget.ES2022 },
    }).outputText
    const readFileBase64 = vi.fn(async () => ({ success: true, data: 'data:image/png;base64,ok' }))
    const images = ['a%2523b%3Fc.png?cache=1#preview', 'a%2523b%3Fc.png?cache=2', 'https://host/a.png', 'data:image/png;base64,x', 'blob:https://host/a.png']
      .map(src => ({ src, getAttribute: () => src, isConnected: true }))
    const resolve = new Function('props', 'resolveMarkdownImagePath', 'window', 'nextTick', 'containerRef', 'resolvedImageCache',
      `${js}; return ${chunked ? 'resolveLocalImages' : 'resolveImageSrc'}`)(
      { filePath: '/notes/a.md' }, resolveMarkdownImagePath, { electronAPI: { file: { readFileBase64 } } },
      async () => {}, { value: { querySelectorAll: () => images } }, new Map(),
    )
    if (chunked) await resolve()
    else {
      for (const image of images) image.src = await resolve(image.src)
    }
    expect(readFileBase64.mock.calls).toEqual([['/notes/a%23b?c.png']])
    expect(images.map(image => image.src)).toEqual([
      'data:image/png;base64,ok', 'data:image/png;base64,ok',
      'https://host/a.png', 'data:image/png;base64,x', 'blob:https://host/a.png',
    ])
  })
  it.each(['ChunkedMarkdownPreview', 'TiptapPreview'])('%s passes the original source and note path to the shared resolver', component => {
    const source = readFileSync(new URL(`../../../renderer/components/preview/${component}.vue`, import.meta.url), 'utf8')
    expect(source).toContain("from '@/shared/utils/markdown-image-path'")
    expect(source).toContain('resolveMarkdownImagePath(')
    expect(source).not.toContain('decodeMarkdownImageSrc')
    expect(source).not.toContain('normalizeNativePath')
  })
})
