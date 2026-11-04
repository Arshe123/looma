import { ensureSyntaxTree, syntaxTree, syntaxTreeAvailable } from '@codemirror/language'
import type { EditorState } from '@codemirror/state'
import { expect } from 'vitest'

/** Stand in for EditorView's background parser in syntax-dependent fixtures. */
export function parsedMarkdownState(state: EditorState): EditorState {
  // These fixtures have no EditorView to resume the initial 20ms parse. Finish
  // synchronously, without a wall-clock budget, sleeps, or command retries.
  const tree = ensureSyntaxTree(state, state.doc.length, Infinity)
  expect(tree).not.toBeNull()
  // ensureSyntaxTree advances the mutable parse context, not syntaxTree(state).
  // An empty transaction publishes that tree, as forceParsing does in a view.
  const parsed = state.update({}).state
  expect(syntaxTreeAvailable(parsed, parsed.doc.length)).toBe(true)
  expect(syntaxTree(parsed)).toBe(tree)
  return parsed
}