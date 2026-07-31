export type DroppedFileLike = {
  name?: string
  path?: string
}

export const SUPPORTED_DROPPED_IMAGE_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.svg',
])

export const getDroppedFilePaths = (files: ArrayLike<DroppedFileLike> | null | undefined) => {
  if (!files) return []
  const paths = Array.from(files)
    .map(file => typeof file.path === 'string' ? file.path.trim() : '')
    .filter(Boolean)
  return [...new Set(paths)]
}

export type CapturedFileTreeDrop =
  | { kind: 'external'; sourcePaths: string[] }
  | { kind: 'internal'; text: string }

export const captureFileTreeDrop = (
  dataTransfer: Pick<DataTransfer, 'types' | 'files' | 'getData'> | null | undefined,
): CapturedFileTreeDrop => {
  const types = dataTransfer ? Array.from(dataTransfer.types) : []
  if (types.includes('Files')) {
    return {
      kind: 'external',
      sourcePaths: getDroppedFilePaths(dataTransfer?.files),
    }
  }
  return {
    kind: 'internal',
    text: dataTransfer?.getData('text/plain') || '',
  }
}

export const isSupportedDroppedImagePath = (filePath: string) => {
  const cleanPath = filePath.split(/[?#]/, 1)[0]
  const fileName = cleanPath.split(/[\\/]/).pop() || ''
  const extensionIndex = fileName.lastIndexOf('.')
  const extension = extensionIndex >= 0 ? fileName.slice(extensionIndex).toLowerCase() : ''
  return SUPPORTED_DROPPED_IMAGE_EXTENSIONS.has(extension)
}
