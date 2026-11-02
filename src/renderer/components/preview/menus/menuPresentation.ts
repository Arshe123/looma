import type { Component } from 'vue'
import { ClipboardPaste, CodeXml, Copy } from 'lucide-vue-next'

/** Display data only: engine commands and selections stay in the adapters. */
export interface MenuPresentationItem {
  id: string
  label: string
  icon?: Component
  disabled?: boolean
  shortcut?: string
  children?: readonly MenuPresentationItem[]
}
export interface MenuPoint { top: number; left: number }

/** One public menu contract; adapters supply capability, never extra actions. */
export function contextClipboardItems(options: { isMac: boolean; reference: boolean; sourceCopy: boolean; readOnly?: boolean }): MenuPresentationItem[] {
  return [
    { id: 'copy', label: options.reference ? '复制引用' : '复制', icon: Copy, shortcut: options.isMac ? '⌘C' : 'Ctrl+C' },
    { id: 'copy-source', label: '复制源码', icon: CodeXml, disabled: !options.sourceCopy },
    { id: 'paste', label: '粘贴', icon: ClipboardPaste, shortcut: options.isMac ? '⌘V' : 'Ctrl+V', disabled: options.readOnly || undefined },
  ]
}

/** Keyboard movement over bounded display items; disabled actions are never selected. */
export function nextMenuIndex(items: readonly { disabled?: boolean }[], current: number, key: string, columns = 1): number {
  if (!items.some(item => !item.disabled)) return -1
  const step = key === 'ArrowDown' ? columns : key === 'ArrowUp' ? -columns : key === 'ArrowLeft' ? -1 : 1
  let next = key === 'Home' ? 0 : key === 'End' ? items.length - 1 : Math.max(0, Math.min(items.length - 1, current + step))
  const direction = key === 'Home' ? 1 : key === 'End' ? -1 : Math.sign(step)
  while (next >= 0 && next < items.length) {
    if (!items[next].disabled) return next
    next += direction
  }
  return current
}

