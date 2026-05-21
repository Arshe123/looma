import { markRaw } from 'vue'
import type { Component } from 'vue'
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Bold,
  CheckSquare,
  Code,
  CodeXml,
  Columns3,
  Heading1,
  Heading2,
  Heading3,
  Heading4,
  Heading5,
  Heading6,
  Highlighter,
  Italic,
  List,
  ListOrdered,
  Minus,
  Pilcrow,
  Quote,
  Rows3,
  Strikethrough,
  Table,
  Trash2,
} from 'lucide-vue-next'
import {
  moveCurrentColumn,
  moveCurrentRow,
} from './tiptap-table-utils'
import type { MenuAction, MenuActionId, TableMenuActionId } from '../type/MenuAction'
import { DEFAULT_INLINE_MENU_ACTION_IDS } from '../constant/MenuConst'

export interface AppSettings {
  inlineMenu: {
    items: string[]
  }
}

const rawIcon = (icon: Component) => markRaw(icon)

export const MENU_ACTIONS: Record<MenuActionId, MenuAction> = {
  paragraph: { id: 'paragraph', label: '正文', icon: rawIcon(Pilcrow), run: (editor) => editor.chain().focus().setParagraph().run() },
  h1: { id: 'h1', label: '一级标题', icon: rawIcon(Heading1), run: (editor) => editor.chain().focus().toggleHeading({ level: 1 }).run() },
  h2: { id: 'h2', label: '二级标题', icon: rawIcon(Heading2), run: (editor) => editor.chain().focus().toggleHeading({ level: 2 }).run() },
  h3: { id: 'h3', label: '三级标题', icon: rawIcon(Heading3), run: (editor) => editor.chain().focus().toggleHeading({ level: 3 }).run() },
  h4: { id: 'h4', label: '四级标题', icon: rawIcon(Heading4), run: (editor) => editor.chain().focus().toggleHeading({ level: 4 }).run() },
  h5: { id: 'h5', label: '五级标题', icon: rawIcon(Heading5), run: (editor) => editor.chain().focus().toggleHeading({ level: 5 }).run() },
  h6: { id: 'h6', label: '六级标题', icon: rawIcon(Heading6), run: (editor) => editor.chain().focus().toggleHeading({ level: 6 }).run() },
  bulletList: { id: 'bulletList', label: '无序列表', icon: rawIcon(List), run: (editor) => editor.chain().focus().toggleBulletList().run() },
  orderedList: { id: 'orderedList', label: '有序列表', icon: rawIcon(ListOrdered), run: (editor) => editor.chain().focus().toggleOrderedList().run() },
  taskList: { id: 'taskList', label: '任务框', icon: rawIcon(CheckSquare), run: (editor) => editor.chain().focus().toggleTaskList().run() },
  blockquote: { id: 'blockquote', label: '引用', icon: rawIcon(Quote), run: (editor) => editor.chain().focus().toggleBlockquote().run() },
  codeBlock: { id: 'codeBlock', label: '代码块', icon: rawIcon(Code), run: (editor) => editor.chain().focus().toggleCodeBlock().run() },
  table: { id: 'table', kind: 'tablePicker', label: '表格', icon: rawIcon(Table) },
  horizontalRule: { id: 'horizontalRule', label: '水平分割线', icon: rawIcon(Minus), run: (editor) => editor.chain().focus().setHorizontalRule().run() },
  bold: { id: 'bold', label: '加粗', icon: rawIcon(Bold), run: (editor) => editor.chain().focus().toggleBold().run() },
  italic: { id: 'italic', label: '斜体', icon: rawIcon(Italic), run: (editor) => editor.chain().focus().toggleItalic().run() },
  strike: { id: 'strike', label: '删除线', icon: rawIcon(Strikethrough), run: (editor) => editor.chain().focus().toggleStrike().run() },
  inlineCode: { id: 'inlineCode', label: '行内代码', icon: rawIcon(CodeXml), run: (editor) => editor.chain().focus().toggleCode().run() },
  highlight: { id: 'highlight', label: '高亮', icon: rawIcon(Highlighter), run: (editor) => editor.chain().focus().toggleHighlight().run() },
}

export const TABLE_ACTIONS: Record<TableMenuActionId, MenuAction> = {
  rowBefore: { id: 'rowBefore', label: '上方插入行', icon: rawIcon(Rows3), run: (editor) => editor.chain().focus().addRowBefore().run() },
  rowAfter: { id: 'rowAfter', label: '下方插入行', icon: rawIcon(Rows3), run: (editor) => editor.chain().focus().addRowAfter().run() },
  columnBefore: { id: 'columnBefore', label: '左侧插入列', icon: rawIcon(Columns3), run: (editor) => editor.chain().focus().addColumnBefore().run() },
  columnAfter: { id: 'columnAfter', label: '右侧插入列', icon: rawIcon(Columns3), run: (editor) => editor.chain().focus().addColumnAfter().run() },
  rowUp: { id: 'rowUp', label: '上移该行', icon: rawIcon(ArrowUp), run: (editor) => moveCurrentRow(editor, -1) },
  rowDown: { id: 'rowDown', label: '下移该行', icon: rawIcon(ArrowDown), run: (editor) => moveCurrentRow(editor, 1) },
  columnLeft: { id: 'columnLeft', label: '左移该列', icon: rawIcon(ArrowLeft), run: (editor) => moveCurrentColumn(editor, -1) },
  columnRight: { id: 'columnRight', label: '右移该列', icon: rawIcon(ArrowRight), run: (editor) => moveCurrentColumn(editor, 1) },
  deleteRow: { id: 'deleteRow', label: '删除行', icon: rawIcon(Trash2), run: (editor) => editor.chain().focus().deleteRow().run() },
  deleteColumn: { id: 'deleteColumn', label: '删除列', icon: rawIcon(Trash2), run: (editor) => editor.chain().focus().deleteColumn().run() },
}

export const defaultAppSettings: AppSettings = {
  inlineMenu: {
    items: [...DEFAULT_INLINE_MENU_ACTION_IDS],
  },
}

// 文档菜单操作
export const getMenuAction = (id: string): MenuAction | undefined =>
  MENU_ACTIONS[id as MenuActionId]

export const getMenuActions = (): MenuAction[] =>
  Object.values(MENU_ACTIONS)

// 表格菜单操作
export const getTableMenuActions = (): MenuAction[] =>
  Object.values(TABLE_ACTIONS)

export const resolveMenuActions = (ids: readonly string[]): MenuAction[] =>
  ids.map((id) => getMenuAction(id)).filter((action): action is MenuAction => Boolean(action))

// 行内菜单操作
export const defaultInlineMenuItems = (): string[] =>
  [...DEFAULT_INLINE_MENU_ACTION_IDS]

export const resolveInlineMenuItems = (items: readonly string[]) =>
  normalizeInlineMenuItems(items).map((item) => ({
    ...MENU_ACTIONS[item as MenuActionId],
  }))

export const inlineMenuActionLabel = (id: string) => getMenuAction(id)?.label ?? id

export const normalizeInlineMenuItems = (
  items: unknown,
): string[] => {
  const seen = new Set<string>()
  const normalized: string[] = []

  if (!Array.isArray(items)) return defaultInlineMenuItems()

  for (const item of items) {
    const id = typeof item === 'string'
      ? item
      : item && typeof item === 'object'
        ? (item as { id?: unknown }).id
        : undefined
    const isVisible = !item || typeof item !== 'object'
      ? true
      : (item as { visible?: unknown }).visible !== false

    if (typeof id !== 'string' || seen.has(id) || !isVisible) {
      continue
    }
    seen.add(id)
    normalized.push(id)
  }

  return normalized
}

export const normalizeAppSettings = (value: unknown): AppSettings => {
  if (!value || typeof value !== 'object') return defaultAppSettings
  const inlineMenu = (value as { inlineMenu?: unknown }).inlineMenu
  const items = inlineMenu && typeof inlineMenu === 'object'
    ? (inlineMenu as { items?: unknown }).items
    : undefined

  return {
    inlineMenu: {
      items: normalizeInlineMenuItems(items),
    },
  }
}
