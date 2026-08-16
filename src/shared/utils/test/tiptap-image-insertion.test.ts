import { Schema } from '@tiptap/pm/model'
import { EditorState, TextSelection } from '@tiptap/pm/state'
import type { Editor } from '@tiptap/vue-3'
import { describe, expect, it, vi } from 'vitest'
import {
  clampImageWidthPercent,
  computeResizedImageWidthPercent,
  MARKDOWN_IMAGE_CURSOR_OFFSET,
  MARKDOWN_IMAGE_TEMPLATE,
  formatMarkdownImage,
  insertImportedImagesAt,
  parseMarkdownImageBlock,
  renderCurrentMarkdownImage,
} from '../tiptap-image-insertion'

describe('tiptap image insertion helpers', () => {
  it('does not treat a failed focus command as a failed imported-image insertion', () => {
    const insertContentAt = vi.fn(() => true)
    const focus = vi.fn(() => false)
    const editor = {
      isDestroyed: false,
      state: { doc: { content: { size: 12 } } },
      commands: { insertContentAt, focus },
    } as unknown as Editor

    expect(insertImportedImagesAt(editor, [
      { relativePath: 'assets/screenshot.png', fileName: 'screenshot.png' },
    ], 6)).toBe(true)
    expect(insertContentAt).toHaveBeenCalledWith(6, [
      { type: 'image', attrs: { src: 'assets/screenshot.png', alt: 'screenshot.png' } },
      { type: 'paragraph' },
    ])
    expect(focus).toHaveBeenCalledOnce()
  })

  it('places the cursor inside the Markdown image path placeholder', () => {
    expect(MARKDOWN_IMAGE_TEMPLATE).toBe('![]()')
    expect(MARKDOWN_IMAGE_TEMPLATE.slice(0, MARKDOWN_IMAGE_CURSOR_OFFSET)).toBe('![](')
  })

  it('parses a complete Markdown image when Enter is pressed', () => {
    expect(parseMarkdownImageBlock('![架构图](assets/architecture.png)')).toEqual({
      alt: '架构图',
      src: 'assets/architecture.png',
    })
  })

  it('formats an image node as editable Markdown', () => {
    expect(formatMarkdownImage({
      alt: '产品封面',
      src: 'assets/product-cover.png',
    })).toBe('![产品封面](assets/product-cover.png)')
  })

  it('round-trips a persisted percentage width extension', () => {
    expect(parseMarkdownImageBlock('![架构图](assets/architecture.png){width=60%}')).toEqual({
      alt: '架构图',
      src: 'assets/architecture.png',
      widthPercent: 60,
    })
    expect(formatMarkdownImage({
      alt: '架构图',
      src: 'assets/architecture.png',
      widthPercent: 60,
    })).toBe('![架构图](assets/architecture.png){width=60%}')
  })

  it('clamps persisted widths and derives proportional resizing from the corner handle', () => {
    expect(clampImageWidthPercent(4)).toBe(10)
    expect(clampImageWidthPercent(120)).toBe(100)
    expect(computeResizedImageWidthPercent({
      startWidth: 400,
      startHeight: 200,
      containerWidth: 800,
      deltaX: 80,
      deltaY: 0,
    })).toBe(60)
    expect(computeResizedImageWidthPercent({
      startWidth: 400,
      startHeight: 200,
      containerWidth: 800,
      deltaX: 0,
      deltaY: 40,
    })).toBe(60)
  })

  it('accepts local absolute paths and rejects an empty source', () => {
    expect(parseMarkdownImageBlock('![](C:\\images\\cover.png)')).toEqual({
      alt: '',
      src: 'C:\\images\\cover.png',
    })
    expect(parseMarkdownImageBlock('![]()')).toBeNull()
    expect(parseMarkdownImageBlock('before ![](assets/a.png)')).toBeNull()
  })

  it('replaces the current Markdown image paragraph with an image and a trailing paragraph', () => {
    const schema = new Schema({
      nodes: {
        doc: { content: 'block+' },
        paragraph: { content: 'text*', group: 'block' },
        image: {
          group: 'block',
          attrs: { src: {}, alt: { default: null } },
        },
        text: { group: 'inline' },
      },
    })
    const paragraph = schema.nodes.paragraph.create(null, schema.text('![示例](assets/example.png)'))
    let state = EditorState.create({
      schema,
      doc: schema.nodes.doc.create(null, [paragraph]),
    })
    state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, paragraph.nodeSize - 1)))
    const focus = vi.fn()
    const editor = {
      isDestroyed: false,
      schema,
      get state() {
        return state
      },
      view: {
        dispatch(transaction: Parameters<typeof state.apply>[0]) {
          state = state.apply(transaction)
        },
        focus,
      },
    } as unknown as Editor

    expect(renderCurrentMarkdownImage(editor)).toBe(true)
    expect(state.doc.childCount).toBe(2)
    expect(state.doc.child(0).type.name).toBe('image')
    expect(state.doc.child(0).attrs).toMatchObject({ src: 'assets/example.png', alt: '示例' })
    expect(state.doc.child(1).type.name).toBe('paragraph')
    expect(state.selection.from).toBe(state.doc.child(0).nodeSize + 1)
    expect(focus).toHaveBeenCalledOnce()
  })
})
