import type { FsEntry } from './workspace-types'
import { isSameOrChildPath, normalizeDir, remapByMoves } from './workspace-utils'

export type FileCreationTimes = Record<string, number>
export interface TrashedFileCreationTimeRecord {
  restoreTo: string
  entries: FileCreationTimes
}
export type TrashedFileCreationTimes = Record<string, TrashedFileCreationTimeRecord>

const isValidTime = (value: unknown): value is number => (
  typeof value === 'number' && Number.isFinite(value) && value > 0
)

export const normalizeFileCreationTimes = (value: unknown): FileCreationTimes => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return Object.fromEntries(
    Object.entries(value)
      .map(([path, createdAt]) => [normalizeDir(path), createdAt] as const)
      .filter(([path, createdAt]) => path.length > 0 && isValidTime(createdAt)),
  )
}

export const normalizeTrashedFileCreationTimes = (value: unknown): TrashedFileCreationTimes => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const result: TrashedFileCreationTimes = {}
  for (const [trashRelativePath, rawRecord] of Object.entries(value)) {
    if (!trashRelativePath || !rawRecord || typeof rawRecord !== 'object' || Array.isArray(rawRecord)) continue
    const record = rawRecord as Partial<TrashedFileCreationTimeRecord>
    const restoreTo = typeof record.restoreTo === 'string' ? normalizeDir(record.restoreTo) : ''
    if (!restoreTo) continue
    const entries: FileCreationTimes = {}
    if (record.entries && typeof record.entries === 'object' && !Array.isArray(record.entries)) {
      for (const [suffix, createdAt] of Object.entries(record.entries)) {
        const normalizedSuffix = suffix ? normalizeDir(suffix) : ''
        if ((suffix === '' || normalizedSuffix) && isValidTime(createdAt)) entries[normalizedSuffix] = createdAt
      }
    }
    result[trashRelativePath] = {
      restoreTo,
      entries,
    }
  }
  return result
}

export const applyPersistentCreationTimes = (
  entries: FsEntry[],
  current: FileCreationTimes,
): { entries: FsEntry[]; creationTimes: FileCreationTimes; changed: boolean } => {
  let changed = false
  const creationTimes = { ...current }
  const nextEntries = entries.map((entry) => {
    const relativePath = normalizeDir(entry.relativePath)
    let createdAtMs = creationTimes[relativePath]
    if (!isValidTime(createdAtMs)) {
      createdAtMs = isValidTime(entry.birthtimeMs)
        ? entry.birthtimeMs
        : isValidTime(entry.mtimeMs) ? entry.mtimeMs : Date.now()
      creationTimes[relativePath] = createdAtMs
      changed = true
    }
    return { ...entry, createdAtMs }
  })
  return { entries: nextEntries, creationTimes, changed }
}

export const removeFileCreationTimes = (
  current: FileCreationTimes,
  removedPaths: string[],
): { creationTimes: FileCreationTimes; changed: boolean } => {
  const normalizedPaths = removedPaths.map(normalizeDir).filter(Boolean)
  if (normalizedPaths.length === 0) return { creationTimes: current, changed: false }
  const creationTimes = Object.fromEntries(
    Object.entries(current).filter(([path]) => (
      !normalizedPaths.some((removedPath) => isSameOrChildPath(removedPath, normalizeDir(path)))
    )),
  )
  return { creationTimes, changed: Object.keys(creationTimes).length !== Object.keys(current).length }
}

export const stashFileCreationTimes = (
  current: FileCreationTimes,
  trashed: TrashedFileCreationTimes,
  items: { trashRelativePath: string; restoreTo: string }[],
): { creationTimes: FileCreationTimes; trashedCreationTimes: TrashedFileCreationTimes; changed: boolean } => {
  let creationTimes = current
  let changed = false
  const trashedCreationTimes = { ...trashed }
  for (const item of items) {
    const restoreTo = normalizeDir(item.restoreTo)
    const entries: FileCreationTimes = {}
    for (const [path, createdAt] of Object.entries(creationTimes)) {
      const normalizedPath = normalizeDir(path)
      if (!isSameOrChildPath(restoreTo, normalizedPath)) continue
      const suffix = normalizedPath === restoreTo ? '' : normalizedPath.slice(restoreTo.length + 1)
      entries[suffix] = createdAt
    }
    if (Object.keys(entries).length > 0) {
      trashedCreationTimes[item.trashRelativePath] = { restoreTo, entries }
      changed = true
    }
    const removed = removeFileCreationTimes(creationTimes, [restoreTo])
    creationTimes = removed.creationTimes
    changed = changed || removed.changed
  }
  return { creationTimes, trashedCreationTimes, changed }
}

export const restoreFileCreationTimes = (
  current: FileCreationTimes,
  trashed: TrashedFileCreationTimes,
  items: { trashRelativePath: string; restoreTo: string }[],
): { creationTimes: FileCreationTimes; trashedCreationTimes: TrashedFileCreationTimes; changed: boolean } => {
  const creationTimes = { ...current }
  const trashedCreationTimes = { ...trashed }
  let changed = false
  for (const item of items) {
    const record = trashedCreationTimes[item.trashRelativePath]
    if (!record) continue
    const restoreTo = normalizeDir(item.restoreTo)
    for (const [suffix, createdAt] of Object.entries(record.entries)) {
      creationTimes[suffix ? `${restoreTo}/${suffix}` : restoreTo] = createdAt
    }
    delete trashedCreationTimes[item.trashRelativePath]
    changed = true
  }
  return { creationTimes, trashedCreationTimes, changed }
}

export const reconcileTrashedFileCreationTimes = (
  current: TrashedFileCreationTimes,
  existingTrashPaths: string[],
): { trashedCreationTimes: TrashedFileCreationTimes; changed: boolean } => {
  const existing = new Set(existingTrashPaths)
  const trashedCreationTimes = Object.fromEntries(
    Object.entries(current).filter(([trashRelativePath]) => existing.has(trashRelativePath)),
  )
  return {
    trashedCreationTimes,
    changed: Object.keys(trashedCreationTimes).length !== Object.keys(current).length,
  }
}

export const remapFileCreationTimes = (
  current: FileCreationTimes,
  movedItems: { from: string; to: string }[],
): { creationTimes: FileCreationTimes; changed: boolean } => {
  let changed = false
  const creationTimes: FileCreationTimes = {}
  const remappedEntries: [string, number][] = []
  for (const [path, createdAt] of Object.entries(current)) {
    const nextPath = remapByMoves(normalizeDir(path), movedItems)
    if (nextPath !== path) {
      remappedEntries.push([nextPath, createdAt])
      changed = true
    } else {
      creationTimes[nextPath] = createdAt
    }
  }
  // A moved item owns the destination path, even if stale metadata was left there.
  for (const [path, createdAt] of remappedEntries) creationTimes[path] = createdAt
  return { creationTimes, changed }
}
