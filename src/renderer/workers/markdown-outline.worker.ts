import { parseMarkdownOutline } from '@/shared/utils/markdown-outline'
import {
  buildOutlineTree,
  flattenOutlineTree,
  resolveOutlineExpandedIds,
  type OutlineFlatRow,
} from '@/shared/utils/outline-tree'
import type { MarkdownOutlineItem } from '@/shared/types/MarkdownOutlineItem'

type MarkdownOutlineWorkerRequest = {
  requestId: number
  content: string
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

self.onmessage = (event: MessageEvent<MarkdownOutlineWorkerRequest>) => {
  const { requestId, content, expandedIds, knownIds, resetExpansion, hasPersistedExpansion } = event.data

  try {
    const items = parseMarkdownOutline(content)
    const ids = items.map((item) => item.id)
    const nextExpandedIds = resolveOutlineExpandedIds(
      items,
      expandedIds,
      knownIds,
      resetExpansion,
      hasPersistedExpansion,
    )
    const outlineTree = buildOutlineTree(items)
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
