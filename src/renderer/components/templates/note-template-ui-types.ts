import type {
  NoteTemplate,
  NoteTemplateInput,
  NoteTemplateStore,
  NoteTemplateVariable,
} from '@/shared/utils/note-template'

export type UiNoteTemplateVariable = NoteTemplateVariable
export type UiNoteTemplate = NoteTemplate
export type UiNoteTemplateInput = NoteTemplateInput
export type UiNoteTemplateStore = NoteTemplateStore

export const getNoteTemplatesApi = () => window.electronAPI.noteTemplates
