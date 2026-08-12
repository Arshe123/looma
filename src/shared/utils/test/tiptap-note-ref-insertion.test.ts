import { Mark, Schema } from '@tiptap/pm/model'
import { EditorState, TextSelection } from '@tiptap/pm/state'
import type { Editor } from '@tiptap/vue-3'
import { describe, expect, it, vi } from 'vitest'
import {
  applyMarkdownNoteRefSource,
  createMarkdownNoteRefTemplate,
  findNearbyNoteRef,
  handleMarkdownNoteRefEnter,
  insertMarkdownNoteRefTemplate,
  parseMarkdownNoteRefSource,
} from '../tiptap-note-ref-insertion'

const createEditor = (paragraphText = '') => {
  const schema = new Schema({
    nodes: {
      doc: { content: 'block+' },
      paragraph: { content: 'inline*', group: 'block' },
      text: { group: 'inline' },
    },
    marks: {
      link: {
        attrs: { href: {}, target: { default: null }, rel: { default: null }, class: { default: null } },
        inclusive: false,
        parseDOM: [{ tag: 'a[href]' }],
        toDOM: mark => ['a', mark.attrs, 0],
      },
    },
  })
  const paragraph = schema.nodes.paragraph.create(null, paragraphText ? schema.text(paragraphText) : undefined)
  let state = EditorState.create({ schema, doc: schema.nodes.doc.create(null, [paragraph]) })
  const focus = vi.fn()
  const editor = {
    isDestroyed: false,
    schema,
    get state() {
      return state
    },
    commands: {
      insertContent: (text: string) => {
        const transaction = state.tr.insertText(text, state.selection.from, state.selection.to)
        state = state.apply(transaction)
        return true
      },
      setTextSelection: (position: number) => {
        state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, position)))
        return true
      },
    },
    chain: () => {
      const actions: Array<() => void> = []
      return {
        focus() { actions.push(focus); return this },
        insertContent(text: string) { actions.push(() => { editor.commands.insertContent(text) }); return this },
        setTextSelection(position: number) { actions.push(() => { editor.commands.setTextSelection(position) }); return this },
        run() { actions.forEach(action => action()); return true },
      }
    },
    view: {
      dispatch(transaction: Parameters<typeof state.apply>[0]) {
        state = state.apply(transaction)
      },
      focus,
    },
  } as unknown as Editor
  return { editor, getState: () => state, focus }
}

describe('Tiptap note reference insertion', () => {
  it('inserts an editable Markdown template with the cursor inside the label', () => {
    const { editor, getState } = createEditor()

    expect(createMarkdownNoteRefTemplate('../notes/说明.md')).toEqual({
      text: '[](../notes/说明.md)',
      labelCursorOffset: 1,
      hrefCursorOffset: 17,
    })
    expect(insertMarkdownNoteRefTemplate(editor, '../notes/说明.md')).toBe(true)
    expect(getState().doc.textContent).toBe('[](../notes/说明.md)')
    expect(getState().selection.from).toBe(2)
  })

  it('moves the cursor to the end of the href on the first Enter', () => {
    const { editor, getState } = createEditor('[安装说明](../notes/说明.md)')
    editor.commands.setTextSelection(5)

    expect(handleMarkdownNoteRefEnter(editor)).toBe(true)
    expect(getState().doc.textContent).toBe('[安装说明](../notes/说明.md)')
    expect(getState().selection.from).toBe(22)
  })

  it('keeps the cursor in an empty label and reports that the label is required', () => {
    const { editor, getState } = createEditor('[](../notes/说明.md)')
    const onEmptyLabel = vi.fn()
    editor.commands.setTextSelection(2)

    expect(handleMarkdownNoteRefEnter(editor, { onEmptyLabel })).toBe(true)
    expect(getState().doc.textContent).toBe('[](../notes/说明.md)')
    expect(getState().selection.from).toBe(2)
    expect(onEmptyLabel).toHaveBeenCalledOnce()
  })

  it('returns the cursor to the label when Enter is pressed in the href while empty', () => {
    const { editor, getState } = createEditor('[](../notes/说明.md)')
    const onEmptyLabel = vi.fn()
    editor.commands.setTextSelection(18)

    expect(handleMarkdownNoteRefEnter(editor, { onEmptyLabel })).toBe(true)
    expect(getState().doc.childCount).toBe(1)
    expect(getState().selection.from).toBe(2)
    expect(onEmptyLabel).toHaveBeenCalledOnce()
  })

  it('converts the edited template to a link and creates a trailing paragraph on the next Enter', () => {
    const { editor, getState, focus } = createEditor('[安装说明](../notes/说明.md#环境配置)')
    editor.commands.setTextSelection(27)

    expect(handleMarkdownNoteRefEnter(editor)).toBe(true)
    expect(getState().doc.childCount).toBe(2)
    expect(getState().doc.child(0).textContent).toBe('安装说明')
    expect(getState().doc.child(1).type.name).toBe('paragraph')
    const marks: readonly Mark[] = getState().doc.child(0).child(0).marks
    expect(marks[0]?.type.name).toBe('link')
    expect(marks[0]?.attrs.href).toBe('../notes/说明.md#环境配置')
    expect(getState().selection.$from.parent).toBe(getState().doc.child(1))
    expect(focus).toHaveBeenCalledOnce()
  })

  it('parses editable note reference source and rejects an empty label', () => {
    expect(parseMarkdownNoteRefSource('[安装说明](../notes/说明.md#环境配置)')).toEqual({
      label: '安装说明',
      href: '../notes/说明.md#环境配置',
    })
    expect(parseMarkdownNoteRefSource('[](../notes/说明.md)')).toEqual({
      error: '引用文字不能为空',
    })
  })

  it('finds a note reference when the cursor is inside or directly beside it', () => {
    const { editor, getState } = createEditor()
    const link = editor.schema.marks.link.create({ href: '../notes/说明.md' })
    const paragraph = editor.schema.nodes.paragraph.create(null, [
      editor.schema.text('前'),
      editor.schema.text('说明', [link]),
      editor.schema.text('后'),
    ])
    editor.view.dispatch(editor.state.tr.replaceWith(0, editor.state.doc.content.size, paragraph))

    editor.commands.setTextSelection(2)
    expect(findNearbyNoteRef(getState())).toMatchObject({ from: 2, to: 4, label: '说明', href: '../notes/说明.md' })
    editor.commands.setTextSelection(5)
    expect(findNearbyNoteRef(getState())).toMatchObject({ from: 2, to: 4 })
  })

  it('applies edited source back to the existing link mark', () => {
    const { editor, getState } = createEditor()
    const link = editor.schema.marks.link.create({ href: 'old.md' })
    const paragraph = editor.schema.nodes.paragraph.create(null, editor.schema.text('旧名称', [link]))
    editor.view.dispatch(editor.state.tr.replaceWith(0, editor.state.doc.content.size, paragraph))
    const target = { from: 1, to: 4, label: '旧名称', href: 'old.md' }

    expect(applyMarkdownNoteRefSource(editor, target, '[新名称](new.md#L12)')).toEqual({ ok: true })
    expect(getState().doc.textContent).toBe('新名称')
    expect(getState().doc.child(0).child(0).marks[0]?.attrs.href).toBe('new.md#L12')
  })

  it('does not duplicate the edited suffix when Enter and blur submit the same edit', () => {
    const { editor, getState } = createEditor()
    const link = editor.schema.marks.link.create({ href: 'old.md' })
    const paragraph = editor.schema.nodes.paragraph.create(
      null,
      editor.schema.text('爬虫自动平台', [link]),
    )
    editor.view.dispatch(editor.state.tr.replaceWith(0, editor.state.doc.content.size, paragraph))
    const staleTarget = { from: 1, to: 7, label: '爬虫自动平台', href: 'old.md' }
    const source = '[爬虫12自动平台](old.md)'

    expect(applyMarkdownNoteRefSource(editor, staleTarget, source)).toEqual({ ok: true })
    expect(applyMarkdownNoteRefSource(editor, staleTarget, source)).toEqual({ ok: true })
    expect(getState().doc.textContent).toBe('爬虫12自动平台')
  })
})
