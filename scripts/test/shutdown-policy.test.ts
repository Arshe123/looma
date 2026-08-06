import { describe, expect, it } from 'vitest'
import { childSignalForParentSignal, isChildRunning } from '../shutdown-policy.mjs'

describe('childSignalForParentSignal', () => {
  it('does not resend terminal SIGINT to POSIX children', () => {
    expect(childSignalForParentSignal('SIGINT', 'darwin')).toBeNull()
  })

  it('forwards SIGINT on Windows where process-group delivery differs', () => {
    expect(childSignalForParentSignal('SIGINT', 'win32')).toBe('SIGINT')
  })

  it('forwards SIGTERM to children', () => {
    expect(childSignalForParentSignal('SIGTERM', 'darwin')).toBe('SIGTERM')
  })

  it('does not treat a sent kill signal as process exit', () => {
    expect(isChildRunning({ exitCode: null, signalCode: null, killed: true })).toBe(true)
    expect(isChildRunning({ exitCode: null, signalCode: 'SIGTERM', killed: true })).toBe(false)
  })
})
