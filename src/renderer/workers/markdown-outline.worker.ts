import { parseMarkdownOutline } from '@/shared/utils/markdown-outline'
import {
  buildOutlineTree,
  flattenOutlineTree,
  resolveOutlineExpandedIds,
  type OutlineFlatRow,
  type OutlineTreeNode,
} from '@/shared/utils/outline-tree'
import type { MarkdownOutlineItem } from '@/shared/types/MarkdownOutlineItem'

type MarkdownOutlineWorkerRequest = {
  requestId: number
  content?: string
  contentRevision: number
  expandedIds: string[]
  knownIds: string[]
  resetExpansion: boolean
  hasPersistedExpansion: boolean
}

type MarkdownOutlineWorkerSuccess = {
  requestId: number
  success: true
  items: MarkdownOutlineItem[]
  visibleRows: OutlineFlatRow[]
  expandedIds: string[]
  knownIds: string[]
}

type MarkdownOutlineWorkerFailure = {
  requestId: number
  success: false
  error: string
}

type MarkdownOutlineWorkerResponse = MarkdownOutlineWorkerSuccess | MarkdownOutlineWorkerFailure

const getErrorMessage = (error: unknown) => {
  if (error instanceof Error) return error.message
  return String(error || 'Failed to build markdown outline')
}

// One document per panel worker; expansion messages carry only the revision and IDs.
let cachedOutline: { revision: number; items: MarkdownOutlineItem[]; tree: OutlineTreeNode[] } | null = null

self.onmessage = (event: MessageEvent<MarkdownOutlineWorkerRequest>) => {
  const { requestId, content, contentRevision, expandedIds, knownIds, resetExpansion, hasPersistedExpansion } = event.data

  try {
    if (content !== undefined) {
      cachedOutline = null
      const items = parseMarkdownOutline(content)
      cachedOutline = { revision: contentRevision, items, tree: buildOutlineTree(items) }
    }
    if (!cachedOutline || cachedOutline.revision !== contentRevision) {
      throw new Error('Outline content revision is unavailable')
    }
    const { items, tree: outlineTree } = cachedOutline
    const ids = items.map((item) => item.id)
    const nextExpandedIds = resolveOutlineExpandedIds(
      items,
      expandedIds,
      knownIds,
      // Explicit expansion must not reapply defaults while a parse reply is pending.
      content === undefined ? true : resetExpansion,
      content === undefined ? true : hasPersistedExpansion,
      outlineTree,
    )
    const visibleRows = flattenOutlineTree(outlineTree, new Set(nextExpandedIds))
    const response: MarkdownOutlineWorkerResponse = {
      requestId,
      success: true,
      items,
      visibleRows,
      expandedIds: nextExpandedIds,
      knownIds: ids,
    }

    self.postMessage(response)
  } catch (error) {
    const response: MarkdownOutlineWorkerResponse = {
      requestId,
      success: false,
      error: getErrorMessage(error),
    }

    self.postMessage(response)
  }
}
