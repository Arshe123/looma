export type EditorShortcutBinding = {
  key: string
  ctrl: boolean
  alt: boolean
  shift: boolean
  meta: boolean
  enabled: boolean
}

export type EditorShortcutSettings = {
  headingLevelUp: EditorShortcutBinding
  headingLevelDown: EditorShortcutBinding
  inlineMenuSlots: EditorShortcutBinding[]
}

export type EditorShortcutEvent = Pick<
  KeyboardEvent,
  'key' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey'
>

export type HeadingLevel = 1 | 2 | 3 | 4 | 5 | 6
export type HeadingDirection = 'up' | 'down'

const binding = (key: string): EditorShortcutBinding => ({
  key,
  ctrl: true,
  alt: false,
  shift: false,
  meta: false,
  enabled: true,
})

export const createDefaultEditorShortcutSettings = (): EditorShortcutSettings => ({
  headingLevelUp: binding('='),
  headingLevelDown: binding('-'),
  inlineMenuSlots: Array.from({ length: 9 }, (_, index) => binding(String(index + 1))),
})

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' ? value as Record<string, unknown> : {}

export const normalizeShortcutKey = (key: string) => {
  if (key === ' ') return 'Space'
  if (key === 'Esc') return 'Escape'
  if (key.length === 1 && /[a-z]/i.test(key)) return key.toUpperCase()
  return key
}

const isValidShortcutKey = (key: unknown): key is string =>
  typeof key === 'string'
  && Boolean(key.trim())
  && !['Control', 'Alt', 'Shift', 'Meta'].includes(key)

export const normalizeEditorShortcutBinding = (
  value: unknown,
  fallback: EditorShortcutBinding,
): EditorShortcutBinding => {
  const raw = asRecord(value)
  const key = isValidShortcutKey(raw.key) ? normalizeShortcutKey(raw.key.trim()) : fallback.key
  const ctrl = typeof raw.ctrl === 'boolean' ? raw.ctrl : fallback.ctrl
  const alt = typeof raw.alt === 'boolean' ? raw.alt : fallback.alt
  const shift = typeof raw.shift === 'boolean' ? raw.shift : fallback.shift
  const meta = typeof raw.meta === 'boolean' ? raw.meta : fallback.meta
  const hasSafeModifier = ctrl || alt || meta
  return {
    key: hasSafeModifier ? key : fallback.key,
    ctrl: hasSafeModifier ? ctrl : fallback.ctrl,
    alt: hasSafeModifier ? alt : fallback.alt,
    shift: hasSafeModifier ? shift : fallback.shift,
    meta: hasSafeModifier ? meta : fallback.meta,
    enabled: typeof raw.enabled === 'boolean' ? raw.enabled : fallback.enabled,
  }
}

export const normalizeEditorShortcutSettings = (value: unknown): EditorShortcutSettings => {
  const defaults = createDefaultEditorShortcutSettings()
  const raw = asRecord(value)
  const rawSlots = Array.isArray(raw.inlineMenuSlots) ? raw.inlineMenuSlots : []
  return {
    headingLevelUp: normalizeEditorShortcutBinding(raw.headingLevelUp, defaults.headingLevelUp),
    headingLevelDown: normalizeEditorShortcutBinding(raw.headingLevelDown, defaults.headingLevelDown),
    inlineMenuSlots: defaults.inlineMenuSlots.map((fallback, index) =>
      normalizeEditorShortcutBinding(rawSlots[index], fallback)),
  }
}

const shiftIsImpliedByKey = (key: string) =>
  key.length === 1 && !/[a-z0-9]/i.test(key)

export const shortcutFromKeyboardEvent = (
  event: EditorShortcutEvent,
): EditorShortcutBinding | null => {
  const key = normalizeShortcutKey(event.key)
  if (!isValidShortcutKey(key)) return null
  if (!event.ctrlKey && !event.altKey && !event.metaKey) return null
  return {
    key,
    ctrl: event.ctrlKey,
    alt: event.altKey,
    shift: event.shiftKey && !shiftIsImpliedByKey(key),
    meta: event.metaKey,
    enabled: true,
  }
}

export const matchesEditorShortcut = (
  event: EditorShortcutEvent,
  shortcut: EditorShortcutBinding,
) => {
  if (!shortcut.enabled) return false
  const key = normalizeShortcutKey(event.key)
  const eventShift = event.shiftKey && !shiftIsImpliedByKey(key)
  return key === shortcut.key
    && event.ctrlKey === shortcut.ctrl
    && event.altKey === shortcut.alt
    && eventShift === shortcut.shift
    && event.metaKey === shortcut.meta
}

export const formatEditorShortcut = (shortcut: EditorShortcutBinding) => {
  const parts: string[] = []
  if (shortcut.ctrl) parts.push('Ctrl')
  if (shortcut.alt) parts.push('Alt')
  if (shortcut.shift) parts.push('Shift')
  if (shortcut.meta) parts.push('Meta')
  parts.push(shortcut.key)
  return parts.join(' + ')
}

export const editorShortcutSignature = (shortcut: EditorShortcutBinding) =>
  `${shortcut.ctrl ? 1 : 0}:${shortcut.alt ? 1 : 0}:${shortcut.shift ? 1 : 0}:${shortcut.meta ? 1 : 0}:${shortcut.key}`

export const getAdjustedHeadingLevel = (
  level: HeadingLevel,
  direction: HeadingDirection,
): HeadingLevel | 'paragraph' => {
  if (direction === 'up') return Math.max(1, level - 1) as HeadingLevel
  if (level === 6) return 'paragraph'
  return (level + 1) as HeadingLevel
}
