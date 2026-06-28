import type { TreeGuide } from '@/shared/types/TreeGuide'

type TreeGuideRow = {
  depth: number
}
export type TreeGuidedRow<T extends TreeGuideRow> = T & {
  guides: TreeGuide[]
}

const hasFollowingSiblingAtDepth = <T extends TreeGuideRow>(
  rows: T[],
  rowIndex: number,
  guideDepth: number,
) => {
  for (let index = rowIndex + 1; index < rows.length; index += 1) {
    const nextDepth = rows[index].depth
    if (nextDepth <= guideDepth) return false
    if (nextDepth === guideDepth + 1) return true
  }

  return false
}

export const appendTreeGuides = <T extends TreeGuideRow>(rows: T[]): TreeGuidedRow<T>[] =>
  rows.map((row, rowIndex) => {
    const guides = Array.from({ length: row.depth }, (_, guideDepth): TreeGuide => {
      if (hasFollowingSiblingAtDepth(rows, rowIndex, guideDepth)) return 'continue'
      if (row.depth === guideDepth + 1) return 'end'
      return 'none'
    })

    return { ...row, guides }
  })
