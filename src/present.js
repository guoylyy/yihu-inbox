// 库里的行 → 页面要的样子
import { dueLabel, shortDate, todayIn } from './dates.js'
import { UNMATCHED_PREFIX } from './import.js'

const ACTIVITY = { create: '记下', edit: '改了', done: '完成了', reopen: '重开了', assign: '指派了', archive: '归档了', restore: '恢复了', undo: '撤销了对' }

export function decorate(t, me, today, names) {
  const due = dueLabel(t.due_date, today)
  const nameOf = (id) => names.get(id) || `用户 ${id}`
  return {
    id: t.id,
    title: t.title,
    due_date: t.due_date,
    due: t.status === 'done' ? '' : due.text,
    overdue: t.status === 'done' ? false : due.overdue,
    done_label: t.done_at ? shortDate(todayIn(undefined, t.done_at), today) : '',
    priority: t.priority,
    status: t.status,
    archived: !!t.archived_at,
    tags: t.tags ?? [],
    mine: t.owner_id === me.id,
    assignee_id: t.assignee_id,
    assignee: t.assignee_id && t.assignee_id !== me.id ? nameOf(t.assignee_id) : '',
    from: t.owner_id !== me.id ? nameOf(t.owner_id) : ''
  }
}

/** 列表行：「待确认」的人名单独拿出来和指派摆一起，不当标签 */
export function listRow(t, me, today, names) {
  const row = decorate(t, me, today, names)
  const pending = row.tags.filter((tag) => tag.startsWith(UNMATCHED_PREFIX))
  return { ...row, pending: pending.map((tag) => tag.slice(UNMATCHED_PREFIX.length)), tags: row.tags.filter((tag) => !pending.includes(tag)) }
}

export const toJson = (t, me, names = new Map()) => ({ ...decorate(t, me, todayIn(), names), note: t.note })

export function activityLine(e, me, names, today) {
  const who = e.actor_id === me.id ? '你' : names.get(e.actor_id) || `用户 ${e.actor_id}`
  const verb = ACTIVITY[e.action] ?? e.action
  return { id: e.id, text: `${who}${verb}${e.action === 'undo' ? '这条的批量操作' : ''}`, title: e.title, when: shortDate(todayIn(undefined, e.created_at), today) }
}
