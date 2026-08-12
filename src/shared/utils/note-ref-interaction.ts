export type NoteRefClickIntent = 'navigate' | 'edit-source'

export const getNoteRefClickIntent = (event: Pick<MouseEvent, 'altKey'>): NoteRefClickIntent =>
  event.altKey ? 'edit-source' : 'navigate'

export const shouldSuppressNoteRefPreview = (event: Pick<MouseEvent, 'altKey'>) => event.altKey
