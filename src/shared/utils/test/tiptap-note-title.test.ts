import { describe, expect, it, vi } from 'vitest'
import { Schema } from '@tiptap/pm/model'
import { EditorState, TextSelection } from '@tiptap/pm/state'
import { history, undo, redo, undoDepth } from '@tiptap/pm/history'
import { createNoteTitlePlugin, NOTE_TITLE_KEY } from '../tiptap-note-title'

const schema = new Schema({ nodes: {
  doc: { content: 'block+' }, text: { group: 'inline' },
  paragraph: { group: 'block', content: 'inline*' },
  heading: { group: 'block', content: 'inline*', attrs: { level: { default: 1 } } },
} })
const doc = () => schema.node('doc', null, [schema.node('heading', null, schema.text('Title')), schema.node('paragraph', null, schema.text('body'))])
const decorations = (state: EditorState) => NOTE_TITLE_KEY.getState(state)!.decorations.find()

describe('non-document note title decoration', () => {
  it('decorates the top-level boundary, immediately removes on downgrade and follows undo/redo without changing document data', () => {
    let state = EditorState.create({ doc: doc(), plugins: [history(), createNoteTitlePlugin()] })
    const original = state.doc.toJSON()
    expect(decorations(state).map(d => [d.from, d.to])).toEqual([[0, 7], [7, 7]])
    expect(state.doc.toJSON()).toEqual(original)
    state = state.apply(state.tr.setNodeMarkup(0, schema.nodes.paragraph))
    expect(decorations(state)).toHaveLength(0)
    undo(state, tr => { state = state.apply(tr) })
    expect(decorations(state)).toHaveLength(2)
    redo(state, tr => { state = state.apply(tr) })
    expect(decorations(state)).toHaveLength(0)
    state = state.apply(state.tr.replaceWith(0, state.doc.content.size, doc().content))
    expect(decorations(state)).toHaveLength(2)
    state = state.apply(state.tr.delete(0, 7))
    expect(decorations(state)).toHaveLength(0)
  })
  it('debounces document statistics only, keeps selection cheap and metadata out of history, cancels on destroy', () => {
    vi.useFakeTimers()
    const count = vi.fn(() => 3).mockReturnValueOnce(2)
    const plugin = createNoteTitlePlugin(count)
    let state = EditorState.create({ doc: doc(), plugins: [history(), plugin] })
    const view = { get state() { return state }, dispatch: vi.fn(tr => { state = state.apply(tr) }) }
    const lifecycle = plugin.spec.view!(view as never)
    const apply = (tr: typeof state.tr) => { const previous = state; state = state.apply(tr); lifecycle.update!(view as never, previous) }
    expect(count).toHaveBeenCalledTimes(1)
    const cached = NOTE_TITLE_KEY.getState(state)
    apply(state.tr.setSelection(TextSelection.create(state.doc, 2)))
    expect(NOTE_TITLE_KEY.getState(state)).toBe(cached)
    vi.advanceTimersByTime(400)
    expect(count).toHaveBeenCalledTimes(1)
    apply(state.tr.insertText('a', 2)); apply(state.tr.insertText('b', 3))
    expect(count).toHaveBeenCalledTimes(1)
    const depth = undoDepth(state)
    vi.advanceTimersByTime(300)
    expect(count).toHaveBeenCalledTimes(2)
    expect(view.dispatch).toHaveBeenCalledTimes(1)
    expect(view.dispatch.mock.calls[0][0].docChanged).toBe(false)
    expect(view.dispatch.mock.calls[0][0].getMeta('addToHistory')).toBe(false)
    expect(undoDepth(state)).toBe(depth)
    apply(state.tr.insertText('c', 4))
    lifecycle.destroy!()
    vi.advanceTimersByTime(400)
    expect(count).toHaveBeenCalledTimes(2)
    vi.useRealTimers()
  })
})
