export const SUPPORTED_FILE_EXTS = new Set(['md', 'txt', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'mp4', 'webm', 'ogg'])
export const EDITABLE_TEXT_EXTS = new Set(['md', 'txt'])

export const normalizeDir = (p: string) => {
  const x = (p || '').trim().split('\\').join('/').replace(/^\/+/, '').replace(/\/+$/, '')
  if (!x) return ''
  if (x === '.' || x === './') return ''
  return x
}

export const fileExt = (p: string) => p.split('.').pop()?.toLowerCase() || ''

export const isSupportedPath = (p: string) => {
  if (!p) return false
  return SUPPORTED_FILE_EXTS.has(fileExt(p))
}

export const isEditableTextPath = (p: string) => {
  if (!p) return false
  return EDITABLE_TEXT_EXTS.has(fileExt(p))
}

export const isSameOrChildPath = (target: string, candidate: string) => candidate === target || candidate.startsWith(`${target}/`)

export const remapByMoves = (relativePath: string, items: { from: string; to: string }[]) => {
  const match = items.find((i) => isSameOrChildPath(i.from, relativePath))
  if (!match) return relativePath
  return relativePath.replace(match.from, match.to)
}

export const removePathsAndDescendants = (source: string[], targets: string[]) =>
  source.filter((p) => !targets.some((t) => isSameOrChildPath(t, p)))

export const pathSep = (p: string) => (p.includes('\\') ? '\\' : '/')

export const pathDir = (p: string) => {
  const x = normalizeDir(p)
  const idx = x.lastIndexOf('/')
  return idx === -1 ? '' : x.slice(0, idx)
}

export const pathBase = (p: string) => {
  const x = normalizeDir(p)
  const idx = x.lastIndexOf('/')
  return idx === -1 ? x : x.slice(idx + 1)
}

export const resolveCurrentDir = (selectedPaths: string[], dirEntries: Record<string, unknown>) => {
  const selected = selectedPaths[0]
  if (!selected) return ''
  return dirEntries[normalizeDir(selected)] ? selected : pathDir(selected)
}
