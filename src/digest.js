// 每日摘要（INBOX_DIGEST=1 才开）：每小时的 30 分醒一次看当地时间，8 点那次发。没有外部定时服务，进程没活着的那天就跳过
import { clockIn, dueLabel, todayIn, tzName } from './dates.js'

const HOUR_MS = 3600_000
const MAX_ITEMS = 20

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

/** 发一轮。单人失败不影响别人 */
export async function sendDigest({ tasks, notify, url, today }) {
  const messages = buildDigest(await tasks.dueForDigest(today), today, url)
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

export function startDigest({ tasks, notify, url }) {
  if (process.env.INBOX_DIGEST !== '1') return null
  const tick = async () => {
    const { hour } = clockIn()
    if (hour !== 8) return
    const r = await sendDigest({ tasks, notify, url, today: todayIn() })
    console.log(`[inbox] 每日摘要：${r.sent}/${r.total} 人`)
  }
  const { minute } = clockIn()
  const wait = (((30 - minute + 60) % 60) || 60) * 60_000
  const run = () => tick().catch((e) => console.warn(`[inbox] 每日摘要失败：${e.message}`))
  const first = setTimeout(() => { run(); setInterval(run, HOUR_MS).unref() }, wait)
  first.unref()
  console.log(`[inbox] 每日摘要已开启（${tzName()} 08:30）`)
  return first
}
