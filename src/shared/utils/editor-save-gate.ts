export const createEditorSaveGate = () => {
  let pending = false

  return {
    markPending() {
      pending = true
    },
    clear() {
      pending = false
    },
    take(serialized: string | undefined, lastSerialized: string) {
      if (!pending) return undefined
      pending = false
      return serialized ?? lastSerialized
    },
  }
}
