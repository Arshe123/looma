import type { Component } from 'vue'
import type { Editor } from '@tiptap/vue-3'

export type MenuActionId =
  | 'paragraph'
  | 'h1'
  | 'h2'
  | 'h3'
  | 'h4'
  | 'h5'
  | 'h6'
  | 'bulletList'
  | 'orderedList'
  | 'taskList'
  | 'blockquote'
  | 'codeBlock'
  | 'table'
  | 'horizontalRule'
  | 'bold'
  | 'italic'
  | 'strike'
  | 'inlineCode'
  | 'highlight'

export type TableMenuActionId = 
  | 'rowBefore'
  | 'rowAfter'
  | 'columnBefore'
  | 'columnAfter'
  | 'rowUp'
  | 'rowDown'
  | 'columnLeft'
  | 'columnRight'
  | 'deleteRow'
  | 'deleteColumn'

type RunnableMenuAction = {
  id: MenuActionId | TableMenuActionId
  kind?: 'action'
  label: string
  icon: Component
  run: (editor: Editor) => void
}

type TablePickerMenuAction = {
  id: MenuActionId
  kind: 'tablePicker'
  label: string
  icon: Component
}

export type MenuAction = RunnableMenuAction | TablePickerMenuAction