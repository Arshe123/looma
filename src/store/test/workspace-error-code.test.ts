import { describe, expect, it } from 'vitest'
import { isMissingDirectoryResult } from '../workspace-utils'

const missingDirResult = {
  success: false,
  errorCode: 'ENOENT',
  error: '目录不存在: 学习笔记/Java/JVM/New Folder',
}

describe('workspace directory error handling', () => {
  it('detects missing directories from structured errorCode instead of localized text', () => {
    expect(isMissingDirectoryResult(missingDirResult)).toBe(true)
  })

  it('does not classify localized text without an errorCode as a missing directory result', () => {
    expect(isMissingDirectoryResult({
      success: false,
      error: '目录不存在: 学习笔记/Java/JVM/New Folder',
    })).toBe(false)
  })
})
