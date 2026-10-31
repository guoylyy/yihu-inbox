// 日期一律用 'YYYY-MM-DD' 字符串，只在这里做计算：容器时区是 UTC，用户的「今天」要按 INBOX_TZ 算
const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
const CN_WEEKDAY = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 0, 天: 0 }
const DAY_MS = 86400_000

export const tzName = () => process.env.INBOX_TZ || 'Asia/Shanghai'

const utc = (d) => { const [y, m, day] = d.split('-').map(Number); return Date.UTC(y, m - 1, day) }
const fmt = (ms) => new Date(ms).toISOString().slice(0, 10)

export const addDays = (d, n) => fmt(utc(d) + n * DAY_MS)
export const daysBetween = (from, to) => Math.round((utc(to) - utc(from)) / DAY_MS)
export const weekdayOf = (d) => new Date(utc(d)).getUTCDay()

/** 周一到周日算一周，返回 d 所在周的周日 */
export const endOfWeek = (d) => addDays(d, (7 - weekdayOf(d)) % 7)

function localParts(now, tz) {
  const parts = {}
  for (const p of new Intl.DateTimeFormat('en-CA', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(now)) parts[p.type] = p.value
  return parts
}

export function todayIn(tz = tzName(), now = new Date()) {
  const p = localParts(now, tz)
  return `${p.year}-${p.month}-${p.day}`
}

/** 当地的 { hour, minute }，每日摘要用 */
export function clockIn(tz = tzName(), now = new Date()) {
  const p = localParts(now, tz)
  return { hour: Number(p.hour), minute: Number(p.minute) }
}

export function isValidDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false
  return fmt(utc(s)) === s
}

/** 列表上的相对文案。overdue 给页面标红用 */
export function dueLabel(due, today) {
  if (!due) return { text: '', overdue: false }
  const diff = daysBetween(today, due)
  if (diff < 0) return { text: `逾期 ${-diff} 天`, overdue: true }
  if (diff === 0) return { text: '今天', overdue: false }
  if (diff === 1) return { text: '明天', overdue: false }
  if (due <= endOfWeek(today)) return { text: WEEKDAYS[weekdayOf(due)], overdue: false }
  return { text: shortDate(due, today), overdue: false }
}

export function shortDate(d, today) {
  const [y, m, day] = d.split('-').map(Number)
  return (y === Number(today.slice(0, 4)) ? '' : `${y}年`) + `${m}月${day}日`
}

/**
 * 把随口说的日期解析成 YYYY-MM-DD：MCP 的 due 参数用（平台规范要求参数宽容）。
 * 支持 2026-11-03、今天、明天、后天、周三、星期三、下周三、3天后。认不出返回 null
 */
export function parseDueWord(input, today) {
  const s = String(input ?? '').trim().replace(/\s+/g, '')
  if (!s) return null
  if (isValidDate(s)) return s
  if (s === '今天' || s === '今日') return today
  if (s === '明天' || s === '明日') return addDays(today, 1)
  if (s === '后天') return addDays(today, 2)
  const later = /^(\d{1,3})天(后|之后)$/.exec(s)
  if (later) return addDays(today, Number(later[1]))
  const week = /^(下下|下|本|这)?(?:个)?(?:周|星期|礼拜)([一二三四五六日天])$/.exec(s)
  if (!week) return null
  const monday = addDays(today, -((weekdayOf(today) + 6) % 7))
  const offset = (CN_WEEKDAY[week[2]] + 6) % 7
  const inWeek = addDays(monday, offset)
  if (week[1] === '下') return addDays(inWeek, 7)
  if (week[1] === '下下') return addDays(inWeek, 14)
  if (week[1]) return inWeek
  // 没说「下」：这周已过就是下一周的这天
  return inWeek < today ? addDays(inWeek, 7) : inWeek
}
