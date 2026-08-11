export const NOTE_INITIAL_CHUNK_BYTES = 256 * 1024
export const NOTE_NEXT_CHUNK_BYTES = 256 * 1024
export const LARGE_NOTE_BYTES = 256 * 1024
export const MARKDOWN_RENDER_CHUNK_CHARS = 64 * 1024

const FENCE_PATTERN = /^\s{0,3}(`{3,}|~{3,})/

export const splitMarkdownIntoRenderChunks = (
  content: string,
  targetChars = MARKDOWN_RENDER_CHUNK_CHARS,
) => splitMarkdownIntoRenderChunksWithLines(content, targetChars).map(chunk => chunk.content)

export type MarkdownRenderChunk = {
  content: string
  startLine: number
}

export const splitMarkdownIntoRenderChunksWithLines = (
  content: string,
  targetChars = MARKDOWN_RENDER_CHUNK_CHARS,
) => {
  if (!content) return []

  const chunks: MarkdownRenderChunk[] = []
  const lines = content.match(/.*(?:\r?\n|$)/g)?.filter(Boolean) ?? [content]
  let current = ''
  let currentStartLine = 0
  let nextLine = 0
  let fenceMarker = ''

  for (const line of lines) {
    const fence = line.match(FENCE_PATTERN)?.[1] || ''
    if (fence) {
      if (!fenceMarker) fenceMarker = fence[0]
      else if (fence[0] === fenceMarker) fenceMarker = ''
    }

    current += line
    nextLine += (line.match(/\n/g) || []).length
    const isBlockBoundary = !fenceMarker && /^\s*$/.test(line)
    if (current.length >= targetChars && isBlockBoundary) {
      chunks.push({ content: current, startLine: currentStartLine })
      current = ''
      currentStartLine = nextLine
    }
  }

  if (current) chunks.push({ content: current, startLine: currentStartLine })
  return chunks
}
