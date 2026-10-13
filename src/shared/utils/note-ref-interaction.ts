export type NoteRefClickIntent = 'navigate' | 'edit-source'

type LinkModifiers = Partial<Pick<MouseEvent, 'altKey' | 'ctrlKey' | 'metaKey'>>

export const getNoteRefClickIntent = (event: LinkModifiers): NoteRefClickIntent =>
  event.ctrlKey || event.metaKey ? 'navigate' : 'edit-source'

export const shouldSuppressNoteRefPreview = (event: LinkModifiers) => getNoteRefClickIntent(event) === 'edit-source'
