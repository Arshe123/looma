import { describe, expect, it, vi } from 'vitest'
import { EditorState } from '@codemirror/state'
import { markdown } from '@codemirror/lang-markdown'
import { getContinuousImageContext, resizeContinuousImageSource, createContinuousMediaController, type ContinuousMediaHost } from '../continuousMarkdownMedia'
import type { EditorView } from '@codemirror/view'
import { parsedMarkdownState } from './parsed-markdown-state'

function fixture() {
  let revision = 0, identity = {}, active = true
  const error = vi.fn()
  const view = { state: parsedMarkdownState(EditorState.create({ doc: '正文', extensions: [markdown()] })), focus: vi.fn(),
    dispatch(spec: Parameters<EditorState['update']>[0]) { this.state = parsedMarkdownState(this.state.update(spec).state); revision++ },
  }
  const api = { fs: { importImage: vi.fn(async () => ({ success: true, data: { relativePath: 'assets/a #.png', fileName: 'a #.png' } })), importClipboardImage: vi.fn(), clipboardReadFiles: vi.fn() } }
  const host: ContinuousMediaHost = {
    view: () => view as unknown as EditorView,
    session: () => ({ identity, revision, filePath: '/fixture/note.md', relativeFilePath: 'note.md', workspaceId: 'w', editable: active, sourceOnly: false }),
    api: api as unknown as ContinuousMediaHost['api'], reportError: error, setBusy: vi.fn(),
  }
  return { view, host, api, error, change: () => revision++, switch: () => { identity = {} }, disable: () => { active = false } }
}


describe('continuous source-backed media', () => {
  it('imports portable relative images in one transaction without rendered base64', async () => {
    const f = fixture(), media = createContinuousMediaController(f.host)
    await media.importPaths(['/a.png'], 2)
    expect(f.view.state.doc.toString()).toBe('正文\n\n![a #.png](assets/a%20%23.png)\n\n')
    expect(f.api.fs.importImage).toHaveBeenCalledWith('w', 'note.md', '/a.png')
    expect(f.error).not.toHaveBeenCalled()
  })
  it('rejects stale asynchronous imports after edits, switch, disable and destroy', async () => {
    for (const action of ['change', 'switch', 'disable', 'destroy'] as const) {
      const f = fixture(), media = createContinuousMediaController(f.host)
      let resolve!: (value: Awaited<ReturnType<typeof f.api.fs.importImage>>) => void
      f.api.fs.importImage.mockImplementation(() => new Promise(done => { resolve = done }))
      const pending = media.importPaths(['/a.png'], 2)
      if (action === 'destroy') media.destroy(); else f[action]()
      resolve({ success: true, data: { relativePath: 'assets/a.png', fileName: 'a.png' } })
      await pending
      expect(f.view.state.doc.toString()).toBe('正文')
    }
  })
  it('leaves non-image paste to downstream', () => {
    const f = fixture(), media = createContinuousMediaController(f.host)
    const preventDefault = vi.fn()
    expect(media.handlePaste({ clipboardData: { types: ['text/plain'], files: [] }, preventDefault } as unknown as ClipboardEvent)).toBe(false)
    expect(preventDefault).not.toHaveBeenCalled()
  })

  it('does not consume non-image files or unknown file transfers', () => {
    const f = fixture(), media = createContinuousMediaController(f.host)
    for (const files of [[{ path: '/a.pdf', name: 'a.pdf', type: 'application/pdf' }], [{ name: 'a.pdf', type: 'application/pdf' }], []]) {
      const preventDefault = vi.fn()
      expect(media.handlePaste({ clipboardData: { types: ['Files'], files }, preventDefault } as unknown as ClipboardEvent)).toBe(false)
      expect(preventDefault).not.toHaveBeenCalled()
    }
    expect(f.api.fs.importClipboardImage).not.toHaveBeenCalled()
  })
  it('invalidates a previous dialog bridge when closed or superseded', () => {
    const f = fixture(), media = createContinuousMediaController(f.host)
    const first = media.createDialogEditor()!
    media.createDialogEditor()
    expect(first.isDestroyed).toBe(true)
    expect(first.chain().focus().setImage({ src: 'assets/a.png', alt: 'a' }).run()).toBe(false)
    const second = media.createDialogEditor()!
    media.cancelDialog()
    expect(second.isDestroyed).toBe(true)
    expect(second.chain().focus().setImage({ src: 'assets/a.png', alt: 'a' }).run()).toBe(false)
    expect(f.view.state.doc.toString()).toBe('正文')
  })

  it('identifies image source ranges and preserves exact title on resize', () => {
    const source = '正文 ![图](assets/a.png \'原题\'){width=60%} 后文'
    const state = parsedMarkdownState(EditorState.create({ doc: source, extensions: [markdown()] }))
    const context = getContinuousImageContext(state, 12)!
    expect(context.source).toBe("![图](assets/a.png '原题'){width=60%}")
    expect(context.from).toBe(3)
    expect(source.slice(context.from, context.to)).toBe(context.source)
    expect(resizeContinuousImageSource(context, 35)).toBe("![图](assets/a.png '原题'){width=35%}")
    expect(getContinuousImageContext(parsedMarkdownState(EditorState.create({ doc: '`![图](x.png)`', extensions: [markdown()] })), 6)).toBeNull()
  })
})
