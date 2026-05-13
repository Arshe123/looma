import type { UndoAction } from './workspace-types'
import { pathDir } from './workspace-utils'

interface HistoryRuntime {
  workspaceId: string
  api: any
  setBusy: (isBusy: boolean, text?: string) => void
}

export interface HistoryEffects {
  removedPaths?: string[]
  restoredPaths?: string[]
  movedItems?: { from: string; to: string }[]
  affectedDirs?: string[]
}

export interface HistoryResult {
  action: UndoAction
  effects: HistoryEffects
}

const unique = (items: string[]) => Array.from(new Set(items))

const affectedDirsForPaths = (paths: string[]) => unique(paths.map(pathDir))

const affectedDirsForMoves = (items: { from: string; to: string }[]) =>
  unique(items.flatMap((item) => [pathDir(item.from), pathDir(item.to)]))

const result = (action: UndoAction, effects: HistoryEffects = {}): HistoryResult => ({
  action,
  effects: {
    ...effects,
    affectedDirs: effects.affectedDirs ? unique(effects.affectedDirs) : undefined,
  },
})

const reverseMoveItems = async (runtime: HistoryRuntime, items: { from: string; to: string }[]) => {
  const reversedItems: { from: string; to: string }[] = []
  for (const item of items) {
    const r = await runtime.api.fs.move(runtime.workspaceId, item.to, item.from)
    if (r.success) reversedItems.push({ from: item.to, to: item.from })
  }
  return reversedItems
}

export const executeUndoAction = async (action: UndoAction, runtime: HistoryRuntime): Promise<HistoryResult | null> => {
  if (action.type === 'create') {
    runtime.setBusy(true, '删除中...')
    const r = await runtime.api.fs.delete(runtime.workspaceId, action.relativePath)
    runtime.setBusy(false)
    if (r.success && r.data) {
      return result(
        { type: 'restore', trashRelativePath: r.data.trashRelativePath, restoreTo: action.relativePath },
        {
          removedPaths: [action.relativePath],
          affectedDirs: affectedDirsForPaths([action.relativePath]),
        },
      )
    }
    return null
  }

  if (action.type === 'move') {
    const reversedItems = await reverseMoveItems(runtime, action.items)
    if (reversedItems.length > 0) {
      return result(
        { type: 'move', items: reversedItems },
        {
          movedItems: reversedItems,
          affectedDirs: affectedDirsForMoves(reversedItems),
        },
      )
    }
    return null
  }

  if (action.type === 'restore') return null

  runtime.setBusy(true, '恢复中...')
  const restoredItems: { trashRelativePath: string; restoreTo: string }[] = []
  for (const item of action.items) {
    const r = await runtime.api.fs.restore(runtime.workspaceId, item.trashRelativePath, item.restoreTo)
    if (r.success) restoredItems.push(item)
  }
  runtime.setBusy(false)
  if (restoredItems.length > 0) {
    const restoredPaths = restoredItems.map((item) => item.restoreTo)
    return result(
      { ...action, items: restoredItems },
      {
        restoredPaths,
        affectedDirs: affectedDirsForPaths(restoredPaths),
      },
    )
  }
  return null
}

export const executeRedoAction = async (action: UndoAction, runtime: HistoryRuntime): Promise<HistoryResult | null> => {
  if (action.type === 'delete') {
    runtime.setBusy(true, '删除中...')
    const newItems: { trashRelativePath: string; restoreTo: string }[] = []
    for (const item of action.items) {
      const r = await runtime.api.fs.delete(runtime.workspaceId, item.restoreTo)
      if (r.success && r.data) newItems.push({ trashRelativePath: r.data.trashRelativePath, restoreTo: item.restoreTo })
    }
    runtime.setBusy(false)
    if (newItems.length > 0) {
      const removedPaths = newItems.map((item) => item.restoreTo)
      return result(
        { type: 'delete', items: newItems },
        {
          removedPaths,
          affectedDirs: affectedDirsForPaths(removedPaths),
        },
      )
    }
    return null
  }

  if (action.type === 'move') {
    const reversedItems = await reverseMoveItems(runtime, action.items)
    if (reversedItems.length > 0) {
      return result(
        { type: 'move', items: reversedItems },
        {
          movedItems: reversedItems,
          affectedDirs: affectedDirsForMoves(reversedItems),
        },
      )
    }
    return null
  }

  if (action.type === 'restore') {
    runtime.setBusy(true, '恢复中...')
    const r = await runtime.api.fs.restore(runtime.workspaceId, action.trashRelativePath, action.restoreTo)
    runtime.setBusy(false)
    if (!r.success) return null
    return result(
      { type: 'create', relativePath: action.restoreTo },
      {
        restoredPaths: [action.restoreTo],
        affectedDirs: affectedDirsForPaths([action.restoreTo]),
      },
    )
  }

  return null
}
