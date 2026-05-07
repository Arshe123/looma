import type { UndoAction } from './workspace-types'

interface HistoryRuntime {
  workspaceId: string
  api: any
  setBusy: (isBusy: boolean, text?: string) => void
  createMarkdown: (title?: string) => Promise<void>
  pathBase: (p: string) => string
}

const reverseMoveItems = async (runtime: HistoryRuntime, items: { from: string; to: string }[]) => {
  const reversedItems: { from: string; to: string }[] = []
  for (const item of items) {
    const r = await runtime.api.fs.move(runtime.workspaceId, item.to, item.from)
    if (r.success) reversedItems.push({ from: item.to, to: item.from })
  }
  return reversedItems
}

export const executeUndoAction = async (action: UndoAction, runtime: HistoryRuntime): Promise<UndoAction | null> => {
  if (action.type === 'create') {
    runtime.setBusy(true, '删除中...')
    const r = await runtime.api.fs.delete(runtime.workspaceId, action.relativePath)
    runtime.setBusy(false)
    if (r.success && r.data) {
      return { type: 'delete', items: [{ trashRelativePath: r.data.trashRelativePath, restoreTo: action.relativePath }] }
    }
    return null
  }

  if (action.type === 'move') {
    const reversedItems = await reverseMoveItems(runtime, action.items)
    if (reversedItems.length > 0) return { type: 'move', items: reversedItems }
    return null
  }

  runtime.setBusy(true, '恢复中...')
  const restoredItems: { trashRelativePath: string; restoreTo: string }[] = []
  for (const item of action.items) {
    const r = await runtime.api.fs.restore(runtime.workspaceId, item.trashRelativePath, item.restoreTo)
    if (r.success) restoredItems.push(item)
  }
  runtime.setBusy(false)
  if (restoredItems.length > 0) return { ...action, items: restoredItems }
  return null
}

export const executeRedoAction = async (action: UndoAction, runtime: HistoryRuntime): Promise<UndoAction | null> => {
  if (action.type === 'delete') {
    runtime.setBusy(true, '删除中...')
    const newItems: { trashRelativePath: string; restoreTo: string }[] = []
    for (const item of action.items) {
      const r = await runtime.api.fs.delete(runtime.workspaceId, item.restoreTo)
      if (r.success && r.data) newItems.push({ trashRelativePath: r.data.trashRelativePath, restoreTo: item.restoreTo })
    }
    runtime.setBusy(false)
    if (newItems.length > 0) return { type: 'delete', items: newItems }
    return null
  }

  if (action.type === 'move') {
    const reversedItems = await reverseMoveItems(runtime, action.items)
    if (reversedItems.length > 0) return { type: 'move', items: reversedItems }
    return null
  }

  await runtime.createMarkdown(runtime.pathBase(action.relativePath))
  return null
}
