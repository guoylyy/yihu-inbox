// 定时推送（INBOX_DIGEST=1 才开）：每分钟醒一次看当地时间。每日摘要在每个人选的整点发，周报周五 17 点发给打开了的人
// 每一轮先在库里占位，重启、发版重叠都不会发两次；进程那一整个小时都没活着才会跳过
import { clockIn, dueLabel, todayIn, tzName, weekdayOf } from './dates.js'
import { DEFAULTS, DIGEST_TIMES } from './settings.js'
import { buildReport, weeklyMessage } from './report.js'

const TICK_MS = 60_000
const MAX_ITEMS = 20
const FRIDAY = 5
const WEEKLY_HOUR = 17

export const pushEnabled = () => process.env.INBOX_DIGEST === '1'

export function buildDigest(rows, today, url) {
  const byUser = new Map()
  for (const r of rows) {
    if (!byUser.has(r.user_id)) byUser.set(r.user_id, [])
    byUser.get(r.user_id).push(r)
  }
  return [...byUser].map(([userId, items]) => {
    const lines = items.slice(0, MAX_ITEMS).map((t) => `- ${dueLabel(t.due_date, today).text}：${[...t.title].slice(0, 60).join('')}`)
    if (items.length > MAX_ITEMS) lines.push(`- 还有 ${items.length - MAX_ITEMS} 条`)
    return { userIds: [userId], title: `今天有 ${items.length} 件待办到期或逾期`, content: lines.join('\n'), ...(url ? { url } : {}) }
  })
}

/** 发一轮。单人失败不影响别人。only 用来按人筛选 */
export async function sendDigest({ tasks, notify, url, today, only = () => true }) {
  const rows = (await tasks.dueForDigest(today)).filter((r) => only(r.user_id))
  const messages = buildDigest(rows, today, url)
  let sent = 0
  for (const m of messages) {
    try {
      await notify(m)
      sent++
    } catch (e) {
      console.warn(`[inbox] 每日摘要发送失败：${e.message}`)
    }
  }
  return { total: messages.length, sent }
}

export async function sendWeekly({ tasks, settings, users, notify, url, today }) {
  const people = await settings.weeklyUsers()
  const known = await users.names(people)
  let sent = 0
  for (const id of people) {
    try {
      const me = { id, name: known.get(id) || `用户 ${id}` }
      await notify({ userIds: [id], ...weeklyMessage(await buildReport({ tasks, users, me, today }), url) })
      sent++
    } catch (e) {
      console.warn(`[inbox] 周报发送失败：${e.message}`)
    }
  }
  return { total: people.length, sent }
}

/** 醒一次：到点且抢到占位才发 */
export async function pushTick({ tasks, settings, users, notify, url, now = new Date() }) {
  const today = todayIn(undefined, now)
  const { hour } = clockIn(undefined, now)
  const label = `${String(hour).padStart(2, '0')}:00`
  const out = {}
  if (DIGEST_TIMES.some(([code]) => code === label) && await tasks.claimPush(`digest:${today}:${label}`)) {
    const times = await settings.digestTimes()
    out.digest = await sendDigest({ tasks, notify, url, today, only: (id) => (times.get(id) ?? DEFAULTS.digest_time) === label })
    console.log(`[inbox] 每日摘要 ${label}：${out.digest.sent}/${out.digest.total} 人`)
  }
  if (weekdayOf(today) === FRIDAY && hour === WEEKLY_HOUR && await tasks.claimPush(`weekly:${today}`)) {
    out.weekly = await sendWeekly({ tasks, settings, users, notify, url, today })
    console.log(`[inbox] 周报：${out.weekly.sent}/${out.weekly.total} 人`)
  }
  return out
}

export function startDigest(deps) {
  if (!pushEnabled()) return null
  const run = () => pushTick(deps).catch((e) => console.warn(`[inbox] 定时推送失败：${e.message}`))
  const timer = setInterval(run, TICK_MS)
  timer.unref()
  console.log(`[inbox] 定时推送已开启（${tzName()}）`)
  return timer
}
