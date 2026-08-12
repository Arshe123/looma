import { describe, expect, it } from 'vitest'
import {
  getNoteRefClickIntent,
  shouldSuppressNoteRefPreview,
} from '../note-ref-interaction'

describe('note reference click intent', () => {
  it('uses a normal click for navigation', () => {
    expect(getNoteRefClickIntent({ altKey: false })).toBe('navigate')
  })

  it('uses Alt or Option click for source editing', () => {
    expect(getNoteRefClickIntent({ altKey: true })).toBe('edit-source')
  })

  it('suppresses hover preview while Alt or Option click starts source editing', () => {
    expect(shouldSuppressNoteRefPreview({ altKey: true })).toBe(true)
    expect(shouldSuppressNoteRefPreview({ altKey: false })).toBe(false)
  })
})