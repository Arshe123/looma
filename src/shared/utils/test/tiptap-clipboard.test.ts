import { Schema } from '@tiptap/pm/model'
import { EditorState, NodeSelection, TextSelection } from '@tiptap/pm/state'
import { describe, expect, it } from 'vitest'
import {
  captureTiptapFileTransfer,
  formatMarkdownLink,
  getTiptapSelectionDocument,
  getTiptapClipboardCopyText,
  partitionClipboardImagePaths,
  selectionHasMarkdownSource,
  shouldReadClipboardImage,
  transferContainsClipboardImage,
} from '../tiptap-clipboard'

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { content: 'text*', group: 'block' },
    image: {
      group: 'block',
      selectable: true,
      attrs: { src: {}, alt: { default: null } },
    },
    text: { group: 'inline' },
  },
  marks: {
    strong: {},
    link: { attrs: { href: {} } },
  },
})

describe('tiptap clipboard helpers', () => {
  it('captures pasted files through the same transfer shape as dropped files', () => {
    const files = [
      { name: 'cover.png', path: '/tmp/cover.png' },
      { name: 'cover.png', path: '/tmp/cover.png' },
      { name: 'browser-only.png' },
    ]

    expect(captureTiptapFileTransfer({ types: ['Files'], files })).toEqual(['/tmp/cover.png'])
    expect(captureTiptapFileTransfer({ types: ['text/plain'], files: [] })).toBeNull()
  })

  it('recognizes image data copied by screenshot tools without a local file path', () => {
    expect(transferContainsClipboardImage({ types: ['image/png', 'text/html'] })).toBe(true)
    expect(transferContainsClipboardImage({ types: ['public.tiff'] })).toBe(true)
    expect(transferContainsClipboardImage({ types: ['text/plain'] })).toBe(false)
  })

  it('falls back to the system clipboard when Chromium exposes unreadable Files', () => {
    expect(shouldReadClipboardImage({ types: ['Files'], files: [{ name: '截图.png' }] })).toBe(true)
    expect(shouldReadClipboardImage({
      types: ['Files'],
      files: [{ name: 'cover.png', path: '/tmp/cover.png' }],
    })).toBe(false)
    expect(shouldReadClipboardImage({ types: ['image/png'], files: [] })).toBe(true)
    expect(shouldReadClipboardImage({ types: ['text/plain'], files: [] })).toBe(false)
  })

  it('copies selected rich-text content as plain text', () => {
    const paragraph = schema.nodes.paragraph.create(null, schema.text('复制这段文字'))
    let state = EditorState.create({ schema, doc: schema.nodes.doc.create(null, [paragraph]) })
    state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, 1, 7)))

    expect(getTiptapClipboardCopyText(state)).toBe('复制这段文字')
  })

  it('copies an image node as Markdown instead of image data', () => {
    const image = schema.nodes.image.create({ src: 'assets/架构图.png', alt: '架构图' })
    let state = EditorState.create({ schema, doc: schema.nodes.doc.create(null, [image]) })
    state = state.apply(state.tr.setSelection(NodeSelection.create(state.doc, 0)))

    expect(getTiptapClipboardCopyText(state)).toBe('![架构图](assets/架构图.png)')
  })

  it('formats a right-clicked note reference for quick copy', () => {
    expect(formatMarkdownLink('接口说明', '../docs/api.md#请求参数')).toBe(
      '[接口说明](../docs/api.md#请求参数)',
    )
    expect(formatMarkdownLink('包含 [括号]', 'notes/a.md')).toBe(
      '[包含 \\[括号\\]](notes/a.md)',
    )
  })

  it('does not copy anything when the selection is an empty text cursor', () => {
    const paragraph = schema.nodes.paragraph.create(null, schema.text('正文'))
    const state = EditorState.create({ schema, doc: schema.nodes.doc.create(null, [paragraph]) })

    expect(getTiptapClipboardCopyText(state)).toBeNull()
  })

  it('disables source copy for a plain-text-only selection', () => {
    const paragraph = schema.nodes.paragraph.create(null, schema.text('纯文本'))
    let state = EditorState.create({ schema, doc: schema.nodes.doc.create(null, [paragraph]) })
    state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, 1, 4)))

    expect(selectionHasMarkdownSource(state)).toBe(false)
    expect(getTiptapSelectionDocument(state)).toEqual({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: '纯文本' }] }],
    })
  })

  it('enables source copy when selected text contains Markdown formatting', () => {
    const boldText = schema.text('加粗', [schema.marks.strong.create()])
    const paragraph = schema.nodes.paragraph.create(null, boldText)
    let state = EditorState.create({ schema, doc: schema.nodes.doc.create(null, [paragraph]) })
    state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, 1, 3)))

    expect(selectionHasMarkdownSource(state)).toBe(true)
    expect(getTiptapSelectionDocument(state)?.content?.[0].content?.[0].marks).toEqual([
      { type: 'strong' },
    ])
  })

  it('accepts only supported image files from a clipboard file list', () => {
    expect(partitionClipboardImagePaths([
      '/tmp/cover.PNG',
      '/tmp/notes.txt',
      '/tmp/photo.webp',
      '/tmp/cover.PNG',
    ])).toEqual({
      supported: ['/tmp/cover.PNG', '/tmp/photo.webp'],
      unsupported: ['/tmp/notes.txt'],
    })
  })
})
