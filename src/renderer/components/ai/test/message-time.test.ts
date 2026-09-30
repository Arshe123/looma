import { describe, expect, it } from 'vitest'
import { formatMessageTime } from '../messageTime'

const localTime = (value: string) => new Date(value).getTime()
const now = localTime('2026-09-29T18:00:00')

describe('formatMessageTime', () => {
  it.each([
    ['2026-09-29T13:51:00', '13:51'],
    ['2026-09-29T03:05:00', '03:05'],
    ['2026-09-28T23:59:00', '昨天 23:59'],
    ['2026-09-27T13:51:00', '前天 13:51'],
    ['2026-09-26T13:51:00', '周六 13:51'],
    ['2026-09-23T13:51:00', '周三 13:51'],
    ['2026-09-22T13:51:00', '9月22日 周二 13:51'],
    ['2025-09-30T13:51:00', '9月30日 周二 13:51'],
    ['2025-09-29T13:51:00', '2025年9月29日 周一 13:51'],
    ['2024-09-29T13:51:00', '2024年9月29日 周日 13:51'],
  ])('将 %s 显示为 %s', (timestamp, expected) => {
    expect(formatMessageTime(localTime(timestamp), now)).toBe(expected)
  })

  it('跨午夜按日历日显示昨天，而不是按经过的 24 小时', () => {
    expect(formatMessageTime(localTime('2026-09-28T23:59:00'), localTime('2026-09-29T00:01:00'))).toBe('昨天 23:59')
  })

  it('跨年但不足一年不追加年份', () => {
    expect(formatMessageTime(localTime('2025-12-25T13:51:00'), localTime('2026-01-02T18:00:00'))).toBe('12月25日 周四 13:51')
  })

  it('闰年周年按日历日期判断', () => {
    expect(formatMessageTime(localTime('2023-03-01T13:51:00'), localTime('2024-02-29T18:00:00'))).toBe('3月1日 周三 13:51')
  })

  it('无效时间不显示 Invalid Date', () => {
    expect(formatMessageTime(Number.NaN, now)).toBe('')
  })
})
