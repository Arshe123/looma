const SIZE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const
type SizeUnit = typeof SIZE_UNITS[number]

/**
 * Scale bytes without rounding or changing the caller's empty/invalid policy.
 * Non-comparable values (NaN) fall through to maxUnit, like upper-bound checks.
 * Callers that show a placeholder or raw bytes for these values must guard them.
 */
export const scaleFileSize = (bytes: number, maxUnit: SizeUnit, minUnit: SizeUnit = 'B') => {
  const minIndex = SIZE_UNITS.indexOf(minUnit)
  const maxIndex = SIZE_UNITS.indexOf(maxUnit)
  let value = bytes
  let unitIndex = 0
  while (unitIndex < maxIndex && (unitIndex < minIndex || !(value < 1024))) {
    value /= 1024
    unitIndex += 1
  }
  return { value, unit: SIZE_UNITS[unitIndex] }
}
