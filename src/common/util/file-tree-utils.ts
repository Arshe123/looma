import type { FsEntry } from '@/store/workspace'
import { normalizeDir, pathDir } from '@/store/workspace-utils'

type NameEntry = Pick<FsEntry, 'name' | 'isDirectory'>

const splitFileName = (entry: NameEntry) => {
  if (entry.isDirectory) return { name: entry.name, ext: '' }

  const name = entry.name || ''
  const dotIndex = name.lastIndexOf('.')
  if (dotIndex <= 0 || dotIndex === name.length - 1) return { name, ext: '' }

  return {
    name: name.slice(0, dotIndex),
    ext: name.slice(dotIndex),
  }
}

export const getCreateTargetDir = (
  entry: Pick<FsEntry, 'relativePath' | 'isDirectory'> | null | undefined,
) => {
  if (!entry || !entry.relativePath) return ''
  return entry.isDirectory ? normalizeDir(entry.relativePath) : pathDir(entry.relativePath)
}

export const getEntryDisplayExt = (entry: NameEntry) => splitFileName(entry).ext

export const getEntryDisplayName = (entry: NameEntry) => splitFileName(entry).name

export const getRenameInputName = (entry: NameEntry) => getEntryDisplayName(entry)

export const buildCreateMarkdownName = (name: string) => `${name.trim()}.md`

export const buildRenameName = (entry: NameEntry, name: string) => {
  const trimmedName = name.trim()
  if (entry.isDirectory) return trimmedName
  return `${trimmedName}${getEntryDisplayExt(entry)}`
}
