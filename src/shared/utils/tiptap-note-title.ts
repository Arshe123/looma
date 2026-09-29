import { Extension } from '@tiptap/core'
import type { Node } from '@tiptap/pm/model'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import { findDocumentNoteTitle, readDocumentNoteStats, noteStatsLabel } from './note-reading-time'

type NoteStats = ReturnType<typeof readDocumentNoteStats>
type TitleState = NoteStats & { decorations: DecorationSet }
export const NOTE_TITLE_KEY = new PluginKey<TitleState>('loomaNoteTitle')

const decorate = (doc: Node, stats: NoteStats): TitleState => {
  const title = findDocumentNoteTitle(doc)
  return { ...stats, decorations: title ? DecorationSet.create(doc, [
    Decoration.node(title.from, title.to, { class: 'looma-note-title' }),
    Decoration.widget(title.to, () => {
      const meta = document.createElement('div')
      meta.className = 'looma-note-reading-time'
      meta.contentEditable = 'false'
      meta.textContent = noteStatsLabel(stats.minutes, stats.words)
      return meta
    }, { key: `note-reading-time:${stats.minutes}:${stats.words}`, side: -1, ignoreSelection: true, stopEvent: () => true }),
  ]) : DecorationSet.empty }
}

export const createNoteTitlePlugin = (count = readDocumentNoteStats) => new Plugin<TitleState>({
  key: NOTE_TITLE_KEY,
  state: {
    init: (_, state) => decorate(state.doc, count(state.doc)),
    apply: (tr, value) => {
      const stats = tr.getMeta(NOTE_TITLE_KEY) as NoteStats | undefined
      if (!tr.docChanged && stats === undefined) return value
      return decorate(tr.doc, stats ?? { minutes: value.minutes, words: value.words })
    },
  },
  props: { decorations: state => NOTE_TITLE_KEY.getState(state)!.decorations },
  view: view => {
    let timer: ReturnType<typeof setTimeout> | undefined
    return {
      update: (current, previous) => {
        if (current.state.doc === previous.doc) return
        clearTimeout(timer)
        timer = setTimeout(() => {
          const stats = count(view.state.doc)
          const previous = NOTE_TITLE_KEY.getState(view.state)
          if (stats.minutes !== previous?.minutes || stats.words !== previous?.words) {
            view.dispatch(view.state.tr.setMeta(NOTE_TITLE_KEY, stats).setMeta('addToHistory', false))
          }
        }, 300)
      },
      destroy: () => clearTimeout(timer),
    }
  },
})

export const NoteTitle = Extension.create({
  name: 'noteTitle',
  addProseMirrorPlugins: () => [createNoteTitlePlugin()],
})
