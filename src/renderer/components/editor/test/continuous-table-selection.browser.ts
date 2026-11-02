import { Compartment, EditorState, Prec, StateEffect } from '@codemirror/state'
export * from '../continuousMarkdownTableSelection'
const readonly = new Compartment()
export function install(view: import('@codemirror/view').EditorView) {
  view.dispatch({ effects: StateEffect.appendConfig.of(readonly.of([])) })
}
export function setReadOnly(view: import('@codemirror/view').EditorView, value: boolean) {
  view.dispatch({ effects: readonly.reconfigure(Prec.highest(EditorState.readOnly.of(value))) })
}
