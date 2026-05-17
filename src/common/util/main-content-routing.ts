import { fileExt, normalizeDir, pathSep } from '@/store/workspace-utils'

const MEDIA_FILE_EXTS = new Set(['ico', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'mp4', 'webm', 'ogg'])

type MediaPreviewTab = {
  relativePath: string
  filePath: string
}

export const isMediaPath = (path: string) => {
  if (!path) return false
  return MEDIA_FILE_EXTS.has(fileExt(path))
}

export const resolveWorkspaceFilePath = (workspacePath: string, relativePath: string) => {
  const rel = normalizeDir(relativePath)
  if (!workspacePath || !rel) return ''

  const sep = pathSep(workspacePath)
  const root = workspacePath.endsWith(sep) ? workspacePath.slice(0, -1) : workspacePath
  return root + sep + rel.split('/').join(sep)
}

export const getMediaPreviewTabs = (openedFiles: string[], workspacePath: string): MediaPreviewTab[] => {
  if (!workspacePath) return []

  return openedFiles
    .filter(isMediaPath)
    .map((relativePath) => ({
      relativePath,
      filePath: resolveWorkspaceFilePath(workspacePath, relativePath),
    }))
}
