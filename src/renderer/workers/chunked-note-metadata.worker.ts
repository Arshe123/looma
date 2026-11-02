import { getMarkdownNoteTitleMetadata } from '@/shared/utils/markdown-renderer'
import { buildMarkdownReferenceIndex } from '@/shared/utils/markdown-reference-index'

// Whole-document statistics must not block the editing/virtualization thread.
self.onmessage = (event: MessageEvent<{ requestId: number; revision: number; content: string; isPartial: boolean }>) => {
  const { requestId, revision, content, isPartial } = event.data
  try {
    self.postMessage({ requestId, revision, metadata: getMarkdownNoteTitleMetadata(content, isPartial), references: buildMarkdownReferenceIndex(content) })
  } catch {
    self.postMessage({ requestId, revision, metadata: null, references: new Map() })
  }
}
