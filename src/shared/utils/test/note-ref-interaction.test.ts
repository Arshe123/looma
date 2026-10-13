import { describe, expect, it } from 'vitest'
import {
  getNoteRefClickIntent,
  shouldSuppressNoteRefPreview,
} from '../note-ref-interaction'

describe('note reference click intent', () => {
  it('uses a normal click for inline source editing', () => {
    expect(getNoteRefClickIntent({ altKey: false })).toBe('edit-source')
  })

  it('uses Alt or Option click for source editing', () => {
    expect(getNoteRefClickIntent({ altKey: true })).toBe('edit-source')
  })

  it('uses Ctrl or Command click for navigation', () => {
    expect(getNoteRefClickIntent({ ctrlKey: true })).toBe('navigate')
    expect(getNoteRefClickIntent({ metaKey: true })).toBe('navigate')
  })

  it('suppresses hover preview when a click starts source editing', () => {
    expect(shouldSuppressNoteRefPreview({ altKey: true })).toBe(true)
    expect(shouldSuppressNoteRefPreview({ altKey: false })).toBe(true)
    expect(shouldSuppressNoteRefPreview({ metaKey: true })).toBe(false)
  })
})