import { describe, expect, it, vi } from 'vitest'
import { createMarkdownSerializationGate } from '../markdown-serialization-gate'

describe('createMarkdownSerializationGate', () => {
  it('does not serialize when the rich-text preview has not changed', () => {
    const gate = createMarkdownSerializationGate()
    const serialize = vi.fn(() => 'rewritten markdown')

    expect(gate.flush(serialize)).toBeUndefined()
    expect(serialize).not.toHaveBeenCalled()
  })

  it('serializes a rich-text change once', () => {
    const gate = createMarkdownSerializationGate()
    const serialize = vi.fn(() => 'edited markdown')

    gate.markDirty()

    expect(gate.flush(serialize)).toBe('edited markdown')
    expect(gate.flush(serialize)).toBeUndefined()
    expect(serialize).toHaveBeenCalledTimes(1)
  })

  it('discards a pending rich-text change after an external source update', () => {
    const gate = createMarkdownSerializationGate()
    const serialize = vi.fn(() => 'stale markdown')

    gate.markDirty()
    gate.clear()

    expect(gate.flush(serialize)).toBeUndefined()
    expect(serialize).not.toHaveBeenCalled()
  })

  it('keeps a rich-text change pending when serialization fails', () => {
    const gate = createMarkdownSerializationGate()
    const failedSerialize = vi.fn(() => { throw new Error('mapping failed') })
    const retrySerialize = vi.fn(() => 'safe markdown')

    gate.markDirty()

    expect(() => gate.flush(failedSerialize)).toThrow('mapping failed')
    expect(gate.flush(retrySerialize)).toBe('safe markdown')
  })
})
