import type { FsEntry } from '../../store/workspace'
import { normalizeDir, pathDir } from '../../store/workspace-utils'

export const FILE_TREE_CREATE_FILE_EVENT = 'file-tree:create-file'

export const getCreateTargetDir = (
  entry: Pick<FsEntry, 'relativePath' | 'isDirectory'> | null | undefined,
) => {
  if (!entry || !entry.relativePath) return ''
  return entry.isDirectory ? normalizeDir(entry.relativePath) : pathDir(entry.relativePath)
}
