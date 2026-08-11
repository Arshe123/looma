import { isTextEditingTarget } from './editing-target'
import { isPrimaryModifierPressed } from './platform-shortcuts'

type FileTreeKeyEvent = Pick<KeyboardEvent, 'key' | 'target' | 'preventDefault' | 'ctrlKey' | 'metaKey'>

type FileTreeShortcutHandlers = {
  event: FileTreeKeyEvent
  platform: string
  selectedPaths: string[]
  hasInlineEdit: boolean
  activeElement: EventTarget | null
  closeMenu: () => void
  startRename: (relativePath: string) => void | Promise<void>
  deleteEntries: (relativePaths: string[]) => void | Promise<void>
  copyEntries: () => void | Promise<void>
  cutEntries: () => void | Promise<void>
  pasteEntries: () => void | Promise<void>
  onError?: (error: unknown) => void
}

const isClipboardShortcut = (event: FileTreeKeyEvent, key: string, platform: string) =>
  event.key.toLowerCase() === key && isPrimaryModifierPressed(event, platform)

export const handleFileTreeGlobalKeyDown = ({
  event,
  platform,
  selectedPaths,
  hasInlineEdit,
  activeElement,
  closeMenu,
  startRename,
  deleteEntries,
  copyEntries,
  cutEntries,
  pasteEntries,
  onError = console.error,
}: FileTreeShortcutHandlers) => {
  if (isTextEditingTarget(event.target) || isTextEditingTarget(activeElement)) return false

  if (event.key === 'Escape') {
    closeMenu()
    return true
  }

  if (isClipboardShortcut(event, 'c', platform) && selectedPaths.length > 0) {
    event.preventDefault()
    Promise.resolve(copyEntries()).catch(onError)
    return true
  }

  if (isClipboardShortcut(event, 'x', platform) && selectedPaths.length > 0) {
    event.preventDefault()
    Promise.resolve(cutEntries()).catch(onError)
    return true
  }

  if (isClipboardShortcut(event, 'v', platform)) {
    event.preventDefault()
    Promise.resolve(pasteEntries()).catch(onError)
    return true
  }

  if (event.key === 'F2' && selectedPaths.length === 1 && !hasInlineEdit) {
    event.preventDefault()
    Promise.resolve(startRename(selectedPaths[0])).catch(onError)
    return true
  }

  if (event.key === 'Delete' && selectedPaths.length > 0) {
    Promise.resolve(deleteEntries(selectedPaths)).catch(onError)
    return true
  }

  return false
}
