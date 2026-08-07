import { isTextEditingTarget } from './editing-target'

type FileTreeKeyEvent = Pick<KeyboardEvent, 'key' | 'target' | 'preventDefault'>

type FileTreeShortcutHandlers = {
  event: FileTreeKeyEvent
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

const isClipboardShortcut = (event: FileTreeKeyEvent, key: string) => {
  if (event.key.toLowerCase() !== key) return false
  const e = event as KeyboardEvent
  return e.ctrlKey || e.metaKey
}

export const handleFileTreeGlobalKeyDown = ({
  event,
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

  if (isClipboardShortcut(event, 'c') && selectedPaths.length > 0) {
    event.preventDefault()
    Promise.resolve(copyEntries()).catch(onError)
    return true
  }

  if (isClipboardShortcut(event, 'x') && selectedPaths.length > 0) {
    event.preventDefault()
    Promise.resolve(cutEntries()).catch(onError)
    return true
  }

  if (isClipboardShortcut(event, 'v')) {
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
