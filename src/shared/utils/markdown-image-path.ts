const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'])
const isDrivePath = (path: string) => /^[a-zA-Z]:[\\/]/.test(path)
const separatorFor = (path: string) => path.includes('\\') ? '\\' : '/'

// Decode exactly once. A literal/malformed percent escape must not prevent valid
// escapes elsewhere in an ordinary filename from being decoded.
const decodePath = (path: string) => path.replace(/(?:%[\da-f]{2})+/gi, encoded => {
  try { return decodeURIComponent(encoded) } catch { return encoded }
})

const normalizePath = (path: string, separator: string) => {
  const unc = path.startsWith('\\\\')
  const drive = isDrivePath(path)
  const rooted = drive || unc || /^[\\/]/.test(path)
  const prefix = drive ? path.slice(0, 2) + separator : unc ? separator + separator : rooted ? separator : ''
  const rest = drive ? path.slice(3) : path
  const parts: string[] = []
  // A UNC server/share is a root, not a directory that .. can pop off.
  const rootDepth = unc ? 2 : 0
  for (const part of rest.split(/[\\/]+/)) {
    if (!part || part === '.') continue
    if (part === '..') {
      if (parts.length > rootDepth && parts.at(-1) !== '..') parts.pop()
      else if (!rooted) parts.push(part)
    } else parts.push(part)
  }
  return prefix + parts.join(separator)
}

/**
 * Resolve a Markdown image destination to an IPC filesystem path, or '' when
 * unsupported. Relative destinations use the note directory; Unix/drive/UNC
 * roots remain absolute regardless of the host OS. Forward // is a network URL;
 * use backslash UNC or file://server/share for local network files.
 * Raw ?/# delimit URL suffixes; percent-encoded ?/# belong to the filename.
 * file: URLs use canonical forward-slash drive paths or backslash UNC paths.
 */
export function resolveMarkdownImagePath(source: string, notePath: string): string {
  const raw = source.trim()
  if (!raw || raw.startsWith('//')) return ''
  let path: string
  if (/^file:/i.test(raw)) {
    try {
      const url = new URL(raw)
      path = decodePath(url.pathname)
      if (url.hostname) path = `\\\\${url.hostname}${path.replace(/\//g, '\\')}`
      else if (/^\/[a-zA-Z]:\//.test(path)) path = path.slice(1)
    } catch { return '' }
  } else {
    if (!isDrivePath(raw) && /^[a-zA-Z][\w+.-]*:/.test(raw)) return ''
    path = decodePath(raw.split(/[?#]/, 1)[0])
  }
  const filename = path.split(/[\\/]/).pop() || ''
  const extension = filename.includes('.') ? filename.slice(filename.lastIndexOf('.') + 1).toLowerCase() : ''
  if (!IMAGE_EXTENSIONS.has(extension)) return ''
  if (isDrivePath(path) || /^[\\/]/.test(path)) return normalizePath(path, separatorFor(path))
  const separator = separatorFor(notePath)
  const normalizedNote = normalizePath(notePath, separator)
  const index = normalizedNote.lastIndexOf(separator)
  if (index < 0) return ''
  return normalizePath(normalizedNote.slice(0, index + 1) + path, separator)
}
