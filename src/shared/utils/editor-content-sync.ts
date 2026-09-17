/** Keep unchanged positions intact when the other split pane edits the document. */
export const getExternalTextChange = (current: string, next: string) => {
  if (current === next) return null
  let from = 0
  while (from < current.length && from < next.length && current[from] === next[from]) from += 1
  let to = current.length
  let nextTo = next.length
  while (to > from && nextTo > from && current[to - 1] === next[nextTo - 1]) {
    to -= 1
    nextTo -= 1
  }
  return { from, to, insert: next.slice(from, nextTo) }
}
