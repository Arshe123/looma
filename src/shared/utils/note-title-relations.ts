export type NoteRelationSummary = { outgoing: number; incoming: number }
// undefined: not a workspace note; null: relationship data is not available yet.
export type NoteTitleRelations = NoteRelationSummary | null | undefined

export const noteRelationsKey = (relations: NoteTitleRelations) => relations === undefined ? 'hidden'
  : relations === null ? 'pending' : `${relations.outgoing}:${relations.incoming}`

export function appendNoteTitleRelations(element: HTMLElement, relations: NoteTitleRelations) {
  if (relations === undefined) return
  const separator = document.createElement('span')
  separator.className = 'looma-note-meta-separator'
  separator.textContent = ' · '
  separator.setAttribute('aria-hidden', 'true')
  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'looma-note-relations'
  button.contentEditable = 'false'
  button.title = '打开关系图谱，查看当前笔记的引用关系'
  button.textContent = relations === null ? '引用关系 · 查看图谱'
    : `引用了 ${relations.outgoing} 篇 · 被引用 ${relations.incoming} 篇`
  element.append(separator, button)
}
