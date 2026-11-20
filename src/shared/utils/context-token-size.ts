import { scaleFileSize } from './format-size'

export const formatContextTokens = (count: number, exact = false): string => {
  const { value, unit } = scaleFileSize(count, 'MB')
  if (unit === 'B') return String(count)
  return `${exact ? value : Number(value.toFixed(2))}${unit[0]}`
}

export const parseContextTokens = (input: string): number | undefined => {
  const match = /^(\d+(?:\.\d+)?)\s*([km]b?)?$/i.exec(input.trim())
  if (!match || (!match[2] && match[1].includes('.'))) return undefined
  const unit = match[2]?.[0].toLowerCase()
  const count = Number(match[1]) * (unit === 'm' ? 1024 ** 2 : unit === 'k' ? 1024 : 1)
  return Number.isSafeInteger(count) && count > 0 ? count : undefined
}
