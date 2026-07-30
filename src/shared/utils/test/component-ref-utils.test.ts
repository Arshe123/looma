import { describe, expect, it, vi } from 'vitest'
import { createKeyedTemplateRefSetters } from '../component-ref-utils'

describe('keyed template ref setters', () => {
  it('keeps the original key when Vue later unmounts the component with null', () => {
    const setRef = vi.fn()
    const setters = createKeyedTemplateRefSetters<object>(setRef)
    const markdownRef = setters.get('notes/readme.md')
    const editor = {}

    markdownRef(editor)
    setters.get('assets/cover.png')
    markdownRef(null)

    expect(setRef.mock.calls).toEqual([
      ['notes/readme.md', editor],
      ['notes/readme.md', null],
    ])
  })

  it('returns a stable callback per key and can release closed-tab cache entries', () => {
    const setRef = vi.fn()
    const setters = createKeyedTemplateRefSetters<object>(setRef)
    const original = setters.get('notes/readme.md')

    expect(setters.get('notes/readme.md')).toBe(original)
    setters.retain([])
    expect(setters.get('notes/readme.md')).not.toBe(original)

    original(null)
    expect(setRef).toHaveBeenLastCalledWith('notes/readme.md', null)
  })
})
