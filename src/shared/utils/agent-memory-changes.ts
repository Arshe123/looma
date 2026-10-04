import type { MemoryUpdatedPayload } from '../types/agent-events'

/** Exact line diff, no context lines or preview truncation. Hirschberg keeps
 * memory linear even for a profile containing thousands of short lines. */
export function diffMemoryLines(before: string, after: string): MemoryUpdatedPayload['changes'] {
  if (before === after) return []
  const a = before ? before.split('\n') : []
  const b = after ? after.split('\n') : []
  const matches: Array<[number, number]> = []
  const row = (left: string[], right: string[]) => {
    const result = new Uint16Array(right.length + 1)
    for (const line of left) {
      let diagonal = 0
      for (let j = 1; j <= right.length; j++) {
        const previous = result[j]
        result[j] = line === right[j - 1] ? diagonal + 1 : Math.max(result[j], result[j - 1])
        diagonal = previous
      }
    }
    return result
  }
  const visit = (startA: number, endA: number, startB: number, endB: number) => {
    while (startA < endA && startB < endB && a[startA] === b[startB]) matches.push([startA++, startB++])
    let suffix = 0
    while (startA < endA && startB < endB && a[endA - 1] === b[endB - 1]) { endA--; endB--; suffix++ }
    if (startA < endA && startB < endB) {
      if (endA - startA === 1) {
        const index = b.indexOf(a[startA], startB)
        if (index >= startB && index < endB) matches.push([startA, index])
      } else {
        const middle = (startA + endA) >>> 1
        const forward = row(a.slice(startA, middle), b.slice(startB, endB))
        const backward = row(a.slice(middle, endA).reverse(), b.slice(startB, endB).reverse())
        let split = 0
        for (let j = 1; j <= endB - startB; j++) {
          if (forward[j] + backward[endB - startB - j] > forward[split] + backward[endB - startB - split]) split = j
        }
        visit(startA, middle, startB, startB + split)
        visit(middle, endA, startB + split, endB)
      }
    }
    for (let i = 0; i < suffix; i++) matches.push([endA + i, endB + i])
  }
  visit(0, a.length, 0, b.length)
  const changes: MemoryUpdatedPayload['changes'] = []
  let i = 0; let j = 0
  for (const [nextA, nextB] of [...matches, [a.length, b.length]]) {
    if (nextA > i) changes.push({ type: 'removed', text: a.slice(i, nextA).join('\n') })
    if (nextB > j) changes.push({ type: 'added', text: b.slice(j, nextB).join('\n') })
    i = nextA + 1; j = nextB + 1
  }
  return changes
}
