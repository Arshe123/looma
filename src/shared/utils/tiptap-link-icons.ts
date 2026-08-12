import { Extension } from '@tiptap/core'
import type { EditorState } from '@tiptap/pm/state'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import { isInternalNoteHref } from './note-link-ref'

const linkIconsKey = new PluginKey<DecorationSet>('loomaLinkIcons')

const buildLinkDecorations = (state: EditorState) => {
  const decorations: Decoration[] = []
  state.doc.descendants((node, pos) => {
    if (!node.isText) return
    const link = node.marks.find(mark => mark.type.name === 'link')
    const href = String(link?.attrs.href || '')
    if (!href) return
    const internal = isInternalNoteHref(href)
    const external = /^https?:/i.test(href)
    if (!internal && !external) return
    decorations.push(Decoration.inline(pos, pos + node.nodeSize, {
      class: internal ? 'looma-note-ref' : 'looma-external-link',
      ...(internal ? { 'data-looma-note-ref': href } : {}),
    }))
  })
  return DecorationSet.create(state.doc, decorations)
}

export const createLinkIconsPlugin = () => new Plugin<DecorationSet>({
  key: linkIconsKey,
  state: {
    init: (_, state) => buildLinkDecorations(state),
    apply: (transaction, oldSet, _oldState, newState) =>
      transaction.docChanged
        ? buildLinkDecorations(newState)
        : oldSet.map(transaction.mapping, transaction.doc),
  },
  props: {
    decorations: state => linkIconsKey.getState(state) || null,
  },
})

export const LinkIcons = Extension.create({
  name: 'loomaLinkIcons',
  addProseMirrorPlugins() {
    return [createLinkIconsPlugin()]
  },
})
