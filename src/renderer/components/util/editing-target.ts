const EDITING_SELECTORS = ['.cm-editor', '.ProseMirror', '[contenteditable]']
const NATIVE_TEXT_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT'])

type MaybeElement = {
  tagName?: string
  isContentEditable?: boolean
  parentElement?: Element | null
  closest?: (selector: string) => Element | null
}

const toClosestCapableTarget = (target: EventTarget | null): MaybeElement | null => {
  if (!target || typeof target !== 'object') return null
  const candidate = target as MaybeElement
  if (typeof candidate.closest === 'function' || candidate.tagName || candidate.isContentEditable) return candidate
  return candidate.parentElement ?? null
}

export const isTextEditingTarget = (target: EventTarget | null) => {
  const element = toClosestCapableTarget(target)
  if (!element) return false

  const tagName = element.tagName?.toUpperCase()
  if (tagName && NATIVE_TEXT_TAGS.has(tagName)) return true
  if (element.isContentEditable) return true

  if (typeof element.closest !== 'function') return false
  return EDITING_SELECTORS.some((selector) => Boolean(element.closest?.(selector)))
}
