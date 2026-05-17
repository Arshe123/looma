import type { MarkdownOutlineItem } from '@/common/interface/MarkdownOutlineItem'
import { appendTreeGuides } from './tree-row-guides'
import type { TreeGuide } from '@/common/type/TreeGuide'

type OutlineTreeNode = {
  item: MarkdownOutlineItem
  children: OutlineTreeNode[]
  depth: number
}

type OutlineFlatRow = {
  item: MarkdownOutlineItem
  children: OutlineTreeNode[]
  depth: number
  guides: TreeGuide[]
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
