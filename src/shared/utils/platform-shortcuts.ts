export type ShortcutModifierEvent = Pick<KeyboardEvent, 'ctrlKey' | 'metaKey'>

export const isMacShortcutPlatform = (platform: string) => platform === 'darwin'

export const isPrimaryModifierPressed = (
  event: ShortcutModifierEvent,
  platform: string,
) => isMacShortcutPlatform(platform)
  ? event.metaKey && !event.ctrlKey
  : event.ctrlKey && !event.metaKey

export const formatPrimaryShortcut = (keys: string, platform: string) => {
  if (!isMacShortcutPlatform(platform)) return `Ctrl+${keys}`
  return `⌘${keys.split('+').map(key => key === 'Shift' ? '⇧' : key).join('')}`
}
