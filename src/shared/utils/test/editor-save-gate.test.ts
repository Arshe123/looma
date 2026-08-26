import { describe, expect, it } from 'vitest'
import { createEditorSaveGate } from '../editor-save-gate'

describe('editor save gate', () => {
  it('never turns a clean editor unmount into an empty save', () => {
    const gate = createEditorSaveGate()
    expect(gate.take(undefined, '')).toBeUndefined()
  })

  it('uses the last serialized content only after a real editor update', () => {
    const gate = createEditorSaveGate()
    gate.markPending()
    expect(gate.take(undefined, '# retained note')).toBe('# retained note')
    expect(gate.take(undefined, '')).toBeUndefined()
  })

  it('forgets pending local saves after an accepted external refresh', () => {
    const gate = createEditorSaveGate()
    gate.markPending()
    gate.clear()
    expect(gate.take(undefined, '')).toBeUndefined()
  })
})
