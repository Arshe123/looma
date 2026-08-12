import type { MarkdownOutlineItem } from '@/shared/types/MarkdownOutlineItem'
import { appendTreeGuides } from './tree-row-guides'
import type { TreeGuide } from '@/shared/types/TreeGuide'

export type OutlineTreeNode = {
  item: MarkdownOutlineItem
  children: OutlineTreeNode[]
  depth: number
}

export type OutlineFlatRow = {
  item: MarkdownOutlineItem
  children: OutlineTreeNode[]
  depth: number
  guides: TreeGuide[]
}

export const resolveOutlineExpandedIds = (
  items: MarkdownOutlineItem[],
  expandedIds: string[],
  knownIds: string[],
  resetExpansion: boolean,
  hasPersistedExpansion: boolean,
) => {
  const idSet = new Set(items.map((item) => item.id))
  const roots = buildOutlineTree(items)
  const defaultExpandedIds = roots.length === 1
    ? [roots[0].item.id, ...roots[0].children.map((child) => child.item.id)]
    : roots.map((root) => root.item.id)

  if (resetExpansion) {
    return hasPersistedExpansion
      ? expandedIds.filter((id) => idSet.has(id))
      : defaultExpandedIds
  }

  const knownIdSet = new Set(knownIds)
  return [
    ...expandedIds.filter((id) => idSet.has(id)),
    ...defaultExpandedIds.filter((id) => !knownIdSet.has(id)),
  ]
}

const updateDepth = (node: OutlineTreeNode, depth: number) => {
  node.depth = depth
  node.children.forEach((child) => updateDepth(child, depth + 1))
}

export const buildOutlineTree = (items: MarkdownOutlineItem[]): OutlineTreeNode[] => {
  const roots: OutlineTreeNode[] = []
  const stack: OutlineTreeNode[] = []

  for (const item of items) {
    while (stack.length > 0 && stack[stack.length - 1].item.level >= item.level) {
      stack.pop()
    }

    const parent = stack[stack.length - 1]
    const node: OutlineTreeNode = {
      item,
      children: [],
      depth: parent ? parent.depth + 1 : 0,
    }

    if (parent) {
      parent.children.push(node)
    } else {
      roots.push(node)
    }

    stack.push(node)
  }

  roots.forEach((root) => updateDepth(root, 0))
  return roots
}

export const flattenOutlineTree = (
  nodes: OutlineTreeNode[],
  expandedIds: ReadonlySet<string>,
): OutlineFlatRow[] => {
  const rows: Array<Omit<OutlineFlatRow, 'guides'>> = []

  const walk = (nodeList: OutlineTreeNode[]) => {
    for (const node of nodeList) {
      rows.push({
        item: node.item,
        children: node.children,
        depth: node.depth,
      })

      if (node.children.length > 0 && expandedIds.has(node.item.id)) {
        walk(node.children)
      }
    }
  }

  walk(nodes)
  return appendTreeGuides(rows)
}
