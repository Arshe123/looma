export type TreeGuideRow = {
  depth: number
}

export type TreeGuidedRow<T extends TreeGuideRow> = T & {
  guides: boolean[]
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
    const guides = Array.from({ length: row.depth }, (_, guideDepth) =>
      hasFollowingSiblingAtDepth(rows, rowIndex, guideDepth),
    )

    return { ...row, guides }
  })
