// 周报。口径都写在这里，页面、复制的 Markdown、周五推送用同一份数据
//   本周：INBOX_TZ 下周一 0 点到下周一 0 点，范围是「我创建的 + 指派给我的」，归档的不算
//   新增：本周创建的（含已完成的）。完成：done_at 在本周的，不管哪周建的；重新打开的不算
//   完成率：完成 ÷（完成 + 截止在本周日及以前、现在还没做完的）。不用 完成 ÷ 新增，清旧账时会超过 100%
//   逾期：没完成、截止日早于今天。今天到期的不算逾期，和列表标红一致
//   按人分布：未完成的事归到负责人（有指派归被指派人，否则归创建人）
//   没动：未完成、updated_at 距今满 72 小时。撤销会还原 updated_at，所以不算动过
import { dueLabel, shortDate, weekRange } from './dates.js'

const OVERDUE_SHOWN = 3
const OVERDUE_CLIP = 12
const MD_LIST_MAX = 20
const CONTENT_MAX = 1900

const oneLine = (title) => title.replace(/\s+/g, ' ').trim()

const clip = (title) => {
  const chars = [...title]
  return chars.length > OVERDUE_CLIP ? `${chars.slice(0, OVERDUE_CLIP).join('')}…` : title
}

/** 周报卡片里的逾期清单：只放几条短标题，完整的在 Markdown 里 */
export function overdueBrief(r) {
  const lines = r.overdue.slice(0, OVERDUE_SHOWN).map(({ due, title }) => ({ due, title: clip(title) }))
  return { lines, more: r.overdue_total - lines.length }
}

export const completionRate = (done, openDue) => {
  const all = done + openDue
  return all ? Math.round((done / all) * 100) : null
}

function section(heading, items, total) {
  if (!total) return []
  const lines = items.slice(0, MD_LIST_MAX).map((l) => `- ${l}`)
  if (total > lines.length) lines.push(`- 还有 ${total - lines.length} 条`)
  return ['', `### ${heading}（${total}）`, ...lines]
}

/** 发群用，只放事实，不写评语 */
export function toMarkdown(r) {
  const rate = r.rate === null ? '暂无' : `${r.rate}%`
  const who = (t) => (t.owner_label ? `（${t.owner_label}）` : '')
  return [
    `## 本周周报（${r.label}）`,
    '',
    `- 新增 ${r.added} 条，完成 ${r.done} 条，完成率 ${rate}`,
    ...section('逾期', r.overdue.map((t) => `${t.due}：${t.title}${who(t)}`), r.overdue_total),
    ...section('按人分布', r.people.map((p) => `${p.name}：${p.count} 条`), r.people.length),
    ...section('连续 3 天没动', r.stale.map((t) => `${t.title}${who(t)}`), r.stale_total)
  ].join('\n')
}

export async function buildReport({ tasks, users, me, today }) {
  const stats = await tasks.weekStats(me.id, today)
  const load = await tasks.loadByPerson(me.id)
  const ids = [...stats.overdue, ...stats.stale].flatMap((t) => [t.owner_id, t.assignee_id]).concat(load.map((p) => p.user_id))
  const names = await users.names(ids.filter((id) => id && id !== me.id))
  const nameOf = (id) => (id === me.id ? (me.name || '我') : names.get(id) || `用户 ${id}`)
  const brief = (t) => {
    const owner = t.assignee_id ?? t.owner_id
    return { id: t.id, title: oneLine(t.title), due: dueLabel(t.due_date, today).text, owner_label: owner === me.id ? '' : nameOf(owner) }
  }
  const { start, end } = weekRange(today)
  const report = {
    start,
    end,
    label: `${shortDate(start, today)}–${shortDate(end, today)}`,
    added: stats.added,
    done: stats.done,
    rate: completionRate(stats.done, stats.openDue),
    open_due: stats.openDue,
    overdue_total: stats.overdueTotal,
    overdue: stats.overdue.map(brief),
    stale_total: stats.staleTotal,
    stale: stats.stale.map(brief),
    people: load.map((p) => ({ id: p.user_id, name: nameOf(p.user_id), count: p.count }))
  }
  return { ...report, markdown: toMarkdown(report) }
}

/** 周五推送的正文，平台通知有长度上限 */
export function weeklyMessage(r, url) {
  const content = [...r.markdown].slice(0, CONTENT_MAX).join('')
  return { title: `本周新增 ${r.added} 条，完成 ${r.done} 条`, content, ...(url ? { url } : {}) }
}
