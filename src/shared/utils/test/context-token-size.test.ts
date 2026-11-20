import { describe, expect, it } from 'vitest'
import { formatContextTokens, parseContextTokens } from '../context-token-size'

describe('context token sizes', () => {
  it('uses binary K and M with no raw digits for exact multiples', () => {
    expect([0, 505, 2500, 262144, 1048576].map(n => formatContextTokens(n))).toEqual(['0', '505', '2.44K', '256K', '1M'])
  })

  it('accepts suffixed values and raw positive integers without changing precise limits', () => {
    expect(['256kb', '1M', '1.5K', '128001'].map(parseContextTokens)).toEqual([262144, 1048576, 1536, 128001])
    expect(parseContextTokens(formatContextTokens(128001, true))).toBe(128001)
    for (const input of ['0', '-1K', '1.1K', '2K extra', '1e5']) expect(parseContextTokens(input)).toBeUndefined()
  })
})
