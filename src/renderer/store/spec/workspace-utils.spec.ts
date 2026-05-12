import { describe, expect, it } from 'vitest'
import { isEditableTextPath, isSupportedPath } from '../workspace-utils'

describe('workspace utils', () => {
  it('treats ico files as supported non-editable media', () => {
    expect(isSupportedPath('icons/app.ico')).toBe(true)
    expect(isEditableTextPath('icons/app.ico')).toBe(false)
  })
})
