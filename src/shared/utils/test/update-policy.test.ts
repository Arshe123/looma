import { describe, expect, it } from 'vitest'
import { shouldAutoCheckUpdates, shouldUseManualUpdate } from '../update-policy'

describe('application update policy', () => {
  it('uses the manual GitHub download flow on macOS', () => {
    expect(shouldUseManualUpdate('darwin')).toBe(true)
    expect(shouldAutoCheckUpdates('darwin', true)).toBe(false)
  })

  it('keeps automatic updates for packaged Windows builds', () => {
    expect(shouldUseManualUpdate('win32')).toBe(false)
    expect(shouldAutoCheckUpdates('win32', true)).toBe(true)
    expect(shouldAutoCheckUpdates('win32', false)).toBe(false)
    expect(shouldAutoCheckUpdates('linux', true)).toBe(false)
  })
})
