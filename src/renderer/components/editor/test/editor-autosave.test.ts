import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const source = readFileSync(new URL('../Editor.vue', import.meta.url), 'utf8')

// Execute the component's real event callbacks without mounting CodeMirror's DOM.
function createSaveHarness() {
  const start = source.indexOf('  const updateListener = EditorView.updateListener.of(')
  const end = source.indexOf('  const state = EditorState.create(', start)
  if (start < 0 || end < 0) throw new Error('Editor event callback setup not found')
  const code = ts.transpile(source.slice(start, end), { target: ts.ScriptTarget.ES2022 })
  const emit = vi.fn()
  const doc = { toString: () => 'initial' }
  const callbacks = new Function('EditorView', 'emit', 'editor', `
    let saveTimeout = null;
    const applyingExternalUpdate = false;
    ${code}
    return { updateListener, domEventHandlers, pendingTimer: () => saveTimeout };
  `)({
    updateListener: { of: (callback: unknown) => callback },
    domEventHandlers: (handlers: unknown) => handlers,
  }, emit, { state: { doc } })
  return {
    emit,
    blur: callbacks.domEventHandlers.blur,
    pendingTimer: callbacks.pendingTimer,
    change(content: string) {
      doc.toString = () => content
      callbacks.updateListener({ docChanged: true, view: { hasFocus: false }, state: { doc } })
    },
  }
}

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

describe('source editor autosave', () => {
  it('saves immediately on blur and cancels the pending autosave', () => {
    const editor = createSaveHarness()
    editor.change('edited')
    vi.advanceTimersByTime(500)
    editor.blur()
    expect(editor.emit.mock.calls.filter(([event]) => event === 'save')).toEqual([['save', 'edited']])
    vi.advanceTimersByTime(1000)
    expect(editor.emit.mock.calls.filter(([event]) => event === 'save')).toEqual([['save', 'edited']])
    expect(editor.pendingTimer()).toBeNull()
  })

  it('clears the timer handle before emitting the debounced save', () => {
    const editor = createSaveHarness()
    editor.emit.mockImplementation((event: string) => {
      if (event === 'save') expect(editor.pendingTimer()).toBeNull()
    })
    editor.change('first')
    vi.advanceTimersByTime(500)
    editor.change('latest')
    vi.advanceTimersByTime(999)
    expect(editor.emit.mock.calls.filter(([event]) => event === 'save')).toEqual([])
    vi.advanceTimersByTime(1)
    expect(editor.emit.mock.calls.filter(([event]) => event === 'save')).toEqual([['save', 'latest']])
  })

  it('still saves on blur without a pending timer and autosaves later edits', () => {
    const editor = createSaveHarness()
    editor.blur()
    editor.change('cancelled timer')
    editor.blur()
    editor.change('later edit')
    vi.advanceTimersByTime(1000)
    expect(editor.emit.mock.calls.filter(([event]) => event === 'save')).toEqual([
      ['save', 'initial'], ['save', 'cancelled timer'], ['save', 'later edit'],
    ])
  })
})