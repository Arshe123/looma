type DestroyableTiptapEditor = {
  isDestroyed?: boolean
  view?: {
    dom?: {
      parentNode?: {
        cloneNode?: (deep?: boolean) => unknown
        parentNode?: {
          replaceChild?: (newChild: unknown, oldChild: unknown) => unknown
        } | null
      } | null
    }
  }
  destroy: () => void
}

export const destroyTiptapEditorSafely = (editor: DestroyableTiptapEditor | null | undefined) => {
  if (!editor || editor.isDestroyed) return

  const wrapper = editor.view?.dom?.parentNode
  const wrapperParent = wrapper?.parentNode
  const clonedWrapper = wrapper?.cloneNode?.(true)

  if (wrapper && clonedWrapper && wrapperParent?.replaceChild) {
    wrapperParent.replaceChild(clonedWrapper, wrapper)
  }

  editor.destroy()
}
