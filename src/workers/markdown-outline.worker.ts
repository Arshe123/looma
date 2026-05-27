import { parseMarkdownOutline } from '@/common/util/markdown-outline'
import { buildOutlineTree, flattenOutlineTree, type OutlineFlatRow } from '@/common/util/outline-tree'
import type { MarkdownOutlineItem } from '@/common/interface/MarkdownOutlineItem'

type MarkdownOutlineWorkerRequest = {
  requestId: number
  content: string
  expandedIds: string[]
  knownIds: string[]
  resetExpansion: boolean
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
  const { requestId, content, expandedIds, knownIds, resetExpansion } = event.data

  try {
    const items = parseMarkdownOutline(content)
    const ids = items.map((item) => item.id)
    const idSet = new Set(ids)
    const knownIdSet = new Set(knownIds)
    const nextExpandedIds = resetExpansion
      ? ids
      : [
          ...expandedIds.filter((id) => idSet.has(id)),
          ...ids.filter((id) => !knownIdSet.has(id)),
        ]
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
