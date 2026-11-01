// 列表和右侧栏的数据：页面首屏和局部刷新共用
import { todayIn } from '../dates.js'
import { LIST_LIMIT } from '../tasks.js'
import { activityLine, listRow } from '../present.js'
import { buildReport, overdueBrief } from '../report.js'

export async function listData({ tasks, users }, me, view) {
  const today = todayIn()
  const list = await tasks.list(me.id, view, today)
  const others = list.flatMap((t) => [t.owner_id, t.assignee_id]).filter((id) => id && id !== me.id)
  const names = await users.names(others)
  const total = list.length < LIST_LIMIT ? list.length : (await tasks.viewIds(me.id, view, today)).total
  const report = view === 'week' ? await buildReport({ tasks, users, me, today }) : null
  return { today, view, total, report, overdueBrief: report && overdueBrief(report), tasks: list.map((t) => listRow(t, me, today, names)) }
}

export async function railData({ tasks, users }, me) {
  const today = todayIn()
  const [progress, load, recent] = await Promise.all([tasks.todayProgress(me.id, today), tasks.loadByPerson(me.id), tasks.recentActivity(me.id)])
  const names = await users.names([...load.map((p) => p.user_id), ...recent.map((e) => e.actor_id)].filter((id) => id !== me.id))
  const nameOf = (id) => (id === me.id ? '我' : names.get(id) || `用户 ${id}`)
  return {
    progress,
    people: load.slice(0, 6).map((p) => ({ name: nameOf(p.user_id), count: p.count })),
    recent: recent.map((e) => activityLine(e, me, names, today))
  }
}
