export const createMarkdownSerializationGate = () => {
  let dirty = false

  return {
    markDirty() {
      dirty = true
    },
    clear() {
      dirty = false
    },
    flush(serialize: () => string) {
      if (!dirty) return undefined
      const markdown = serialize()
      dirty = false
      return markdown
    },
  }
}
