// 每人一份的应用设置，存在本应用的库里（换设备也在），每次请求现读，改完下一次操作就生效，不用重启
import { addDays } from './dates.js'
import { HttpError } from './tasks.js'

export const DIGEST_TIMES = [['08:00', '08:00'], ['09:00', '09:00'], ['18:00', '18:00'], ['off', '关闭']]
export const QUICK_DUES = [['today', '今天'], ['tomorrow', '明天'], ['none', '无']]
export const DEDUPE_RULE = '只有 AI / 快捷入口会去重（60 秒内同标题、同指派、同日期）；你在表单里手动添加的每一条都会保留'
export const DEFAULTS = { default_assignee_id: null, digest_time: '08:00', notify_assignee: true, weekly_push: false, quick_due: 'none' }

const oneOf = (list, v, message) => {
  if (!list.some(([code]) => code === v)) throw new HttpError(400, message)
  return v
}
const parseBool = (v, message) => {
  if (typeof v !== 'boolean') throw new HttpError(400, message)
  return v
}
const parseUser = (v, me) => {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, '默认指派对象不对')
  return n === me ? null : n // 指派给自己等于没指派
}

/** 快捷录入没说时间时补的默认截止。无 → null */
export function defaultDue(quickDue, today) {
  if (quickDue === 'today') return today
  if (quickDue === 'tomorrow') return addDays(today, 1)
  return null
}

const fromRow = (r) => ({
  default_assignee_id: r.default_assignee_id,
  digest_time: r.digest_time,
  notify_assignee: !!r.notify_assignee,
  weekly_push: !!r.weekly_push,
  quick_due: r.quick_due
})

export function createSettings({ pool }) {
  const COLUMNS = 'default_assignee_id, digest_time, notify_assignee, weekly_push, quick_due'

  async function get(userId) {
    const [rows] = await pool.execute(`SELECT ${COLUMNS} FROM inbox_setting WHERE user_id = ?`, [userId])
    return rows.length ? fromRow(rows[0]) : { ...DEFAULTS }
  }

  /** 部分更新：页面改一项存一项 */
  async function save(userId, input) {
    const cur = await get(userId)
    const next = {
      default_assignee_id: 'default_assignee_id' in input ? parseUser(input.default_assignee_id, userId) : cur.default_assignee_id,
      digest_time: 'digest_time' in input ? oneOf(DIGEST_TIMES, input.digest_time, '每日摘要时间不对') : cur.digest_time,
      notify_assignee: 'notify_assignee' in input ? parseBool(input.notify_assignee, '是否 @ 到人的值不对') : cur.notify_assignee,
      weekly_push: 'weekly_push' in input ? parseBool(input.weekly_push, '周报推送的值不对') : cur.weekly_push,
      quick_due: 'quick_due' in input ? oneOf(QUICK_DUES, input.quick_due, '默认截止不对') : cur.quick_due
    }
    await pool.execute(
      `INSERT INTO inbox_setting (user_id, ${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE default_assignee_id = VALUES(default_assignee_id), digest_time = VALUES(digest_time),
         notify_assignee = VALUES(notify_assignee), weekly_push = VALUES(weekly_push), quick_due = VALUES(quick_due)`,
      [userId, next.default_assignee_id, next.digest_time, next.notify_assignee, next.weekly_push, next.quick_due]
    )
    return next
  }

  /** 设置过的人的摘要时间。没出现在这里的人按默认值 */
  async function digestTimes() {
    const [rows] = await pool.query('SELECT user_id, digest_time FROM inbox_setting')
    return new Map(rows.map((r) => [r.user_id, r.digest_time]))
  }

  async function weeklyUsers() {
    const [rows] = await pool.query('SELECT user_id FROM inbox_setting WHERE weekly_push = 1')
    return rows.map((r) => r.user_id)
  }

  return { get, save, digestTimes, weeklyUsers }
}
