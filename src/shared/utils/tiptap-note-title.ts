import { Extension } from '@tiptap/core'
import type { Node } from '@tiptap/pm/model'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import { findDocumentNoteTitle, readDocumentReadingMinutes, readingTimeLabel } from './note-reading-time'

type TitleState = { minutes: number; decorations: DecorationSet }
export const NOTE_TITLE_KEY = new PluginKey<TitleState>('loomaNoteTitle')

const decorate = (doc: Node, minutes: number): TitleState => {
  const title = findDocumentNoteTitle(doc)
  return { minutes, decorations: title ? DecorationSet.create(doc, [
    Decoration.node(title.from, title.to, { class: 'looma-note-title' }),
    Decoration.widget(title.to, () => {
      const meta = document.createElement('div')
      meta.className = 'looma-note-reading-time'
      meta.contentEditable = 'false'
      meta.textContent = readingTimeLabel(minutes)
      return meta
    }, { key: `note-reading-time:${minutes}`, side: -1, ignoreSelection: true, stopEvent: () => true }),
  ]) : DecorationSet.empty }
}

export const createNoteTitlePlugin = (count = readDocumentReadingMinutes) => new Plugin<TitleState>({
  key: NOTE_TITLE_KEY,
  state: {
    init: (_, state) => decorate(state.doc, count(state.doc)),
    apply: (tr, value) => {
      const minutes = tr.getMeta(NOTE_TITLE_KEY) as number | undefined
      if (!tr.docChanged && minutes === undefined) return value
      return decorate(tr.doc, minutes ?? value.minutes)
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
          const minutes = count(view.state.doc)
          if (minutes !== NOTE_TITLE_KEY.getState(view.state)?.minutes) {
            view.dispatch(view.state.tr.setMeta(NOTE_TITLE_KEY, minutes).setMeta('addToHistory', false))
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
