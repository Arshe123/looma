import { describe, expect, it } from 'vitest'
import {
  applyPersistentCreationTimes,
  normalizeFileCreationTimes,
  normalizeTrashedFileCreationTimes,
  reconcileTrashedFileCreationTimes,
  remapFileCreationTimes,
  removeFileCreationTimes,
  restoreFileCreationTimes,
  stashFileCreationTimes,
} from '../file-creation-times'
import type { FsEntry } from '../workspace-types'

const entry = (relativePath: string, birthtimeMs: number): FsEntry => ({
  name: relativePath.split('/').pop() || relativePath,
  relativePath,
  isDirectory: false,
  size: 1,
  mtimeMs: birthtimeMs,
  birthtimeMs,
})

describe('persistent file creation times', () => {
  it('keeps the first recorded time after an atomic save changes birthtime', () => {
    const initial = applyPersistentCreationTimes([entry('note.md', 100)], {})
    const afterSave = applyPersistentCreationTimes([entry('note.md', 200)], initial.creationTimes)

    expect(initial.changed).toBe(true)
    expect(afterSave.changed).toBe(false)
    expect(afterSave.entries[0].createdAtMs).toBe(100)
    expect(afterSave.creationTimes).toEqual({ 'note.md': 100 })
  })

  it('moves directory records with their descendants and removes deleted paths', () => {
    const moved = remapFileCreationTimes(
      { docs: 10, 'docs/a.md': 20, 'archive/docs/a.md': 999, 'keep.md': 30 },
      [{ from: 'docs', to: 'archive/docs' }],
    )

    expect(moved.creationTimes).toEqual({
      'archive/docs': 10,
      'archive/docs/a.md': 20,
      'keep.md': 30,
    })
    expect(removeFileCreationTimes(moved.creationTimes, ['archive/docs']).creationTimes)
      .toEqual({ 'keep.md': 30 })
  })

  it('drops malformed persisted values', () => {
    expect(normalizeFileCreationTimes({
      'valid.md': 10,
      'zero.md': 0,
      'text.md': '12',
      'nan.md': Number.NaN,
    })).toEqual({ 'valid.md': 10 })
  })

  it('keeps repeated deletions of the same path separate by trash id', () => {
    const firstDelete = stashFileCreationTimes(
      { 'note.md': 100 },
      {},
      [{ trashRelativePath: 'trash-1', restoreTo: 'note.md' }],
    )
    const secondDelete = stashFileCreationTimes(
      { ...firstDelete.creationTimes, 'note.md': 200 },
      firstDelete.trashedCreationTimes,
      [{ trashRelativePath: 'trash-2', restoreTo: 'note.md' }],
    )

    expect(secondDelete.trashedCreationTimes).toEqual({
      'trash-1': { restoreTo: 'note.md', entries: { '': 100 } },
      'trash-2': { restoreTo: 'note.md', entries: { '': 200 } },
    })

    const restored = restoreFileCreationTimes(
      secondDelete.creationTimes,
      secondDelete.trashedCreationTimes,
      [{ trashRelativePath: 'trash-1', restoreTo: 'note.md' }],
    )
    expect(restored.creationTimes['note.md']).toBe(100)
    expect(restored.trashedCreationTimes['trash-1']).toBeUndefined()
    expect(restored.trashedCreationTimes['trash-2'].entries['']).toBe(200)
  })

  it('restores directory descendants relative to the restored root', () => {
    const deleted = stashFileCreationTimes(
      { docs: 10, 'docs/a.md': 20, 'docs/images/logo.png': 30, 'keep.md': 40 },
      {},
      [{ trashRelativePath: 'trash-dir', restoreTo: 'docs' }],
    )
    const restored = restoreFileCreationTimes(
      deleted.creationTimes,
      deleted.trashedCreationTimes,
      [{ trashRelativePath: 'trash-dir', restoreTo: 'archive/docs' }],
    )

    expect(restored.creationTimes).toEqual({
      'keep.md': 40,
      'archive/docs': 10,
      'archive/docs/a.md': 20,
      'archive/docs/images/logo.png': 30,
    })
  })

  it('removes snapshots whose physical trash entries no longer exist', () => {
    const reconciled = reconcileTrashedFileCreationTimes({
      existing: { restoreTo: 'a.md', entries: { '': 10 } },
      stale: { restoreTo: 'b.md', entries: { '': 20 } },
    }, ['existing'])

    expect(reconciled.changed).toBe(true)
    expect(reconciled.trashedCreationTimes).toEqual({
      existing: { restoreTo: 'a.md', entries: { '': 10 } },
    })
  })

  it('keeps a trashed root entry when loading persisted metadata', () => {
    expect(normalizeTrashedFileCreationTimes({
      trash: { restoreTo: 'note.md', entries: { '': 100, 'nested.md': 110 } },
    })).toEqual({
      trash: { restoreTo: 'note.md', entries: { '': 100, 'nested.md': 110 } },
    })
  })
})
