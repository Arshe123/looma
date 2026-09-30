const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

// 用本地日期计算天数，避免夏令时切换造成一天不是 24 小时的偏差。
const calendarDay = (date: Date) => Date.UTC(date.getFullYear(), date.getMonth(), date.getDate())

export const formatMessageTime = (timestamp: number, now = Date.now()): string => {
  const date = new Date(timestamp)
  const today = new Date(now)
  if (!Number.isFinite(date.getTime()) || !Number.isFinite(today.getTime())) return ''

  const time = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
  const days = (calendarDay(today) - calendarDay(date)) / 86_400_000
  if (days <= 0) return time
  if (days === 1) return `昨天 ${time}`
  if (days === 2) return `前天 ${time}`

  const weekdayTime = `${WEEKDAYS[date.getDay()]} ${time}`
  if (days < 7) return weekdayTime

  const anniversary = new Date(date.getFullYear() + 1, date.getMonth(), date.getDate())
  const year = calendarDay(today) >= calendarDay(anniversary) ? `${date.getFullYear()}年` : ''
  return `${year}${date.getMonth() + 1}月${date.getDate()}日 ${weekdayTime}`
}
