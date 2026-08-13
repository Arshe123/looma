import { isTextEditingTarget } from './editing-target'
import { matchesAppShortcut, type AppShortcutSettings } from './app-shortcuts'

type FileTreeKeyEvent = Pick<KeyboardEvent, 'key' | 'target' | 'preventDefault' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey'>

type FileTreeShortcutHandlers = {
  event: FileTreeKeyEvent
  platform: string
  shortcuts: AppShortcutSettings
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

export const handleFileTreeGlobalKeyDown = ({
  event,
  platform,
  shortcuts,
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

  if (matchesAppShortcut(event, shortcuts.copyFiles, platform) && selectedPaths.length > 0) {
    event.preventDefault()
    Promise.resolve(copyEntries()).catch(onError)
    return true
  }

  if (matchesAppShortcut(event, shortcuts.cutFiles, platform) && selectedPaths.length > 0) {
    event.preventDefault()
    Promise.resolve(cutEntries()).catch(onError)
    return true
  }

  if (matchesAppShortcut(event, shortcuts.pasteFiles, platform)) {
    event.preventDefault()
    Promise.resolve(pasteEntries()).catch(onError)
    return true
  }

  if (matchesAppShortcut(event, shortcuts.renameFile, platform) && selectedPaths.length === 1 && !hasInlineEdit) {
    event.preventDefault()
    Promise.resolve(startRename(selectedPaths[0])).catch(onError)
    return true
  }

  if (matchesAppShortcut(event, shortcuts.deleteFiles, platform) && selectedPaths.length > 0) {
    event.preventDefault()
    Promise.resolve(deleteEntries(selectedPaths)).catch(onError)
    return true
  }

  return false
}
