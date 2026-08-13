import {
  formatEditorShortcut,
  matchesEditorShortcut,
  normalizeShortcutKey,
  shortcutFromKeyboardEvent,
  type EditorShortcutBinding,
  type EditorShortcutEvent,
} from './editor-shortcuts'
import { isMacShortcutPlatform } from './platform-shortcuts'

export type AppShortcutId =
  | 'openWorkspace'
  | 'newWorkspace'
  | 'commandPalette'
  | 'newFile'
  | 'saveFile'
  | 'undoFileOperation'
  | 'redoFileOperation'
  | 'copyFiles'
  | 'cutFiles'
  | 'pasteFiles'
  | 'renameFile'
  | 'deleteFiles'
  | 'openInlineMenu'

export type AppShortcutSettings = Record<AppShortcutId, EditorShortcutBinding>
export type AppShortcutCategory = 'workspace' | 'file' | 'menu'

export type AppShortcutDefinition = {
  id: string
  settingKey: AppShortcutId
  command: string
  description: string
  scope: string
  category: AppShortcutCategory
  binding: EditorShortcutBinding
  shortcut: string
}

const binding = (
  key: string,
  { ctrl = false, alt = false, shift = false, meta = false } = {},
): EditorShortcutBinding => ({ key, ctrl, alt, shift, meta, enabled: true })

export const createDefaultAppShortcutSettings = (): AppShortcutSettings => ({
  openWorkspace: binding('O', { ctrl: true }),
  newWorkspace: binding('N', { ctrl: true, shift: true }),
  commandPalette: binding('P', { ctrl: true, shift: true }),
  newFile: binding('N', { ctrl: true }),
  saveFile: binding('S', { ctrl: true }),
  undoFileOperation: binding('Z', { ctrl: true }),
  redoFileOperation: binding('Y', { ctrl: true }),
  copyFiles: binding('C', { ctrl: true }),
  cutFiles: binding('X', { ctrl: true }),
  pasteFiles: binding('V', { ctrl: true }),
  renameFile: binding('F2'),
  deleteFiles: binding('Delete'),
  openInlineMenu: binding('Enter', { ctrl: true, shift: true }),
})

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' ? value as Record<string, unknown> : {}

const isSafeBareKey = (key: string) => /^F\d{1,2}$/.test(key) || key === 'Delete' || key === 'Backspace'

const normalizeAlwaysEnabledBinding = (
  value: unknown,
  fallback: EditorShortcutBinding,
): EditorShortcutBinding => {
  const raw = asRecord(value)
  const rawKey = typeof raw.key === 'string' && raw.key.trim()
    ? normalizeShortcutKey(raw.key.trim())
    : fallback.key
  const ctrl = typeof raw.ctrl === 'boolean' ? raw.ctrl : fallback.ctrl
  const alt = typeof raw.alt === 'boolean' ? raw.alt : fallback.alt
  const shift = typeof raw.shift === 'boolean' ? raw.shift : fallback.shift
  const meta = typeof raw.meta === 'boolean' ? raw.meta : fallback.meta
  const valid = ctrl || alt || meta || isSafeBareKey(rawKey)
  return {
    key: valid ? rawKey : fallback.key,
    ctrl: valid ? ctrl : fallback.ctrl,
    alt: valid ? alt : fallback.alt,
    shift: valid ? shift : fallback.shift,
    meta: valid ? meta : fallback.meta,
    enabled: true,
  }
}

export const normalizeAppShortcutSettings = (value: unknown): AppShortcutSettings => {
  const defaults = createDefaultAppShortcutSettings()
  const raw = asRecord(value)
  return Object.fromEntries(
    (Object.keys(defaults) as AppShortcutId[]).map(key => [
      key,
      normalizeAlwaysEnabledBinding(raw[key], defaults[key]),
    ]),
  ) as AppShortcutSettings
}

export const matchesAppShortcut = (
  event: EditorShortcutEvent,
  shortcut: EditorShortcutBinding,
  platform = '',
) => {
  if (isMacShortcutPlatform(platform)
    && shortcut.key === 'Delete'
    && event.key === 'Backspace'
    && !event.ctrlKey && !event.altKey && !event.shiftKey && !event.metaKey) {
    return true
  }
  return matchesEditorShortcut(event, { ...shortcut, enabled: true }, platform)
}

export const appShortcutFromKeyboardEvent = (
  event: EditorShortcutEvent,
  platform = '',
): EditorShortcutBinding | null => {
  const shortcut = shortcutFromKeyboardEvent(event, platform)
  if (shortcut) return { ...shortcut, enabled: true }
  const key = normalizeShortcutKey(event.key)
  if (!isSafeBareKey(key)) return null
  return binding(key, { shift: event.shiftKey })
}

export const formatAppShortcut = (shortcut: EditorShortcutBinding, platform = '') => {
  if (!shortcut.ctrl && !shortcut.alt && !shortcut.shift && !shortcut.meta) {
    if (isMacShortcutPlatform(platform) && (shortcut.key === 'Delete' || shortcut.key === 'Backspace')) return '⌫'
    return shortcut.key
  }
  return formatEditorShortcut(shortcut, platform)
}

const metadata: Array<Omit<AppShortcutDefinition, 'binding' | 'shortcut'>> = [
  { id: 'open-workspace', settingKey: 'openWorkspace', command: '打开工作空间', description: '在新窗口中选择并打开一个本地工作空间', scope: '应用', category: 'workspace' },
  { id: 'new-workspace', settingKey: 'newWorkspace', command: '新建工作空间', description: '在新窗口中创建工作空间', scope: '应用', category: 'workspace' },
  { id: 'command-palette', settingKey: 'commandPalette', command: '打开命令面板', description: '搜索并执行应用命令', scope: '应用', category: 'workspace' },
  { id: 'new-file', settingKey: 'newFile', command: '新建文件', description: '在当前文件夹中创建 Markdown 文件', scope: '工作空间', category: 'file' },
  { id: 'save-file', settingKey: 'saveFile', command: '保存当前文件', description: '立即保存当前文本文件', scope: '当前文件', category: 'file' },
  { id: 'undo-file-operation', settingKey: 'undoFileOperation', command: '撤销文件操作', description: '焦点不在文本编辑区时撤销最近的文件操作', scope: '工作空间', category: 'file' },
  { id: 'redo-file-operation', settingKey: 'redoFileOperation', command: '重做文件操作', description: '焦点不在文本编辑区时重做最近撤销的文件操作', scope: '工作空间', category: 'file' },
  { id: 'copy-files', settingKey: 'copyFiles', command: '复制选中文件', description: '复制文件树中选中的文件或文件夹', scope: '文件树', category: 'file' },
  { id: 'cut-files', settingKey: 'cutFiles', command: '剪切选中文件', description: '剪切文件树中选中的文件或文件夹', scope: '文件树', category: 'file' },
  { id: 'paste-files', settingKey: 'pasteFiles', command: '粘贴文件', description: '将剪贴板中的文件或图片粘贴到当前目录', scope: '文件树', category: 'file' },
  { id: 'rename-file', settingKey: 'renameFile', command: '重命名选中文件', description: '重命名文件树中唯一选中的项目', scope: '文件树', category: 'file' },
  { id: 'delete-files', settingKey: 'deleteFiles', command: '删除选中文件', description: '将文件树中选中的项目移入回收站', scope: '文件树', category: 'file' },
  { id: 'open-inline-menu', settingKey: 'openInlineMenu', command: '打开快速插入菜单', description: '打开当前行的快速插入菜单', scope: '富文本编辑器', category: 'menu' },
]

export const getAppShortcutDefinitions = (
  settings: AppShortcutSettings,
  platform: string,
): AppShortcutDefinition[] => metadata.map(item => ({
  ...item,
  binding: settings[item.settingKey],
  shortcut: formatAppShortcut(settings[item.settingKey], platform),
}))
