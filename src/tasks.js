// 任务的全部读写。权限只在这一层：每条 SQL 都带当前用户 id，路由和 MCP 没有绕过它的路
//   看得到：自己创建的、指派给自己的。其余一律 404（不告诉对方这个 id 存在）
//   创建人：能改内容、改指派、完成
//   被指派人：只能完成 / 重开，改别的 403
import { endOfWeek, isValidDate, parseDueWord } from './dates.js'

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status }
}

export const TITLE_MAX = 500
export const NOTE_MAX = 5000
export const VIEWS = ['today', 'week', 'open', 'done']
const LIST_LIMIT = 200
const DEDUPE_MS = 60_000
const ER_LOCK_DEADLOCK = 1213
const CREATE_TRIES = 12
const RETRY_STEP_MS = 15

const COLUMNS = 'id, owner_id, assignee_id, title, note, due_date, priority, status, done_at, source, created_at, updated_at'
const MINE = '(owner_id = ? OR assignee_id = ?)'
const ORDER_OPEN = 'ORDER BY due_date IS NULL, due_date, priority DESC, id DESC'
// 算重复的条件。title 列不分大小写和重音，这里按字节比才是逐字相同；due_date 用 <=>，两边都没日期也算相同
const SAME_TASK = "owner_id = ? AND status = 'open' AND due_date <=> ? AND title COLLATE utf8mb4_0900_bin = ? AND created_at >= ?"

// 视图是固定的几条语句，view 参数只用来选语句，不进 SQL
const VIEW_SQL = {
  today: { sql: `SELECT ${COLUMNS} FROM inbox_task WHERE ${MINE} AND status = 'open' AND due_date <= ? ${ORDER_OPEN} LIMIT ?`, args: (t) => [t] },
  week: { sql: `SELECT ${COLUMNS} FROM inbox_task WHERE ${MINE} AND status = 'open' AND due_date <= ? ${ORDER_OPEN} LIMIT ?`, args: (t) => [endOfWeek(t)] },
  open: { sql: `SELECT ${COLUMNS} FROM inbox_task WHERE ${MINE} AND status = 'open' ${ORDER_OPEN} LIMIT ?`, args: () => [] },
  done: { sql: `SELECT ${COLUMNS} FROM inbox_task WHERE ${MINE} AND status = 'done' ORDER BY done_at DESC, id DESC LIMIT ?`, args: () => [] }
}

const parseTitle = (v) => {
  const title = String(v ?? '').trim()
  if (!title) throw new HttpError(400, '标题不能为空')
  if ([...title].length > TITLE_MAX) throw new HttpError(400, `标题不能超过 ${TITLE_MAX} 字`)
  return title
}
const parseNote = (v) => {
  const note = String(v ?? '').trim()
  if ([...note].length > NOTE_MAX) throw new HttpError(400, `备注不能超过 ${NOTE_MAX} 字`)
  return note || null
}
const parsePriority = (v) => {
  const p = Number(v ?? 0)
  if (!Number.isInteger(p) || p < 0 || p > 3) throw new HttpError(400, '优先级只能是 0 到 3')
  return p
}
const parseDue = (v) => {
  if (v === null || v === undefined || v === '') return null
  if (!isValidDate(v)) throw new HttpError(400, '截止日期格式不对')
  return v
}
const parseUserId = (v) => {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, '指派对象不对')
  return n
}
const parseTaskId = (v) => {
  if (!/^[1-9]\d{0,18}$/.test(String(v))) throw new HttpError(404, '任务不存在')
  return String(v)
}

export function createTasks({ pool, now = () => Date.now() }) {
  async function tx(fn) {
    const conn = await pool.getConnection()
    try {
      await conn.beginTransaction()
      const out = await fn(conn)
      await conn.commit()
      return out
    } catch (e) {
      await conn.rollback().catch(() => {})
      throw e
    } finally {
      conn.release()
    }
  }

  const logEvent = (conn, taskId, actorId, action, detail) => conn.execute(
    'INSERT INTO inbox_event (task_id, actor_id, action, detail) VALUES (?, ?, ?, ?)',
    [taskId, actorId, action, detail ? JSON.stringify(detail) : null]
  )

  async function getVisible(conn, userId, id) {
    const [rows] = await conn.execute(`SELECT ${COLUMNS} FROM inbox_task WHERE id = ? AND ${MINE} FOR UPDATE`, [id, userId, userId])
    if (!rows.length) throw new HttpError(404, '任务不存在')
    return rows[0]
  }

  async function list(userId, view, today, limit = LIST_LIMIT) {
    const v = VIEW_SQL[view]
    if (!v) throw new HttpError(400, '没有这个视图')
    const [rows] = await pool.query(v.sql, [userId, userId, ...v.args(today), limit])
    return rows
  }

  async function get(userId, rawId) {
    const id = parseTaskId(rawId)
    const [rows] = await pool.execute(`SELECT ${COLUMNS} FROM inbox_task WHERE id = ? AND ${MINE}`, [id, userId, userId])
    if (!rows.length) throw new HttpError(404, '任务不存在')
    return rows[0]
  }

  async function create(userId, input, { source = 'self' } = {}) {
    const title = parseTitle(input.title)
    const note = parseNote(input.note)
    const due = parseDue(input.due_date)
    const priority = parsePriority(input.priority)
    const assigneeId = normalizeAssignee(userId, parseUserId(input.assignee_id))
    const attempt = () => tx(async (conn) => {
      // created_at 由这里写，和窗口用同一个时钟；列精确到秒，先取整，免得被数据库四舍五入
      const at = new Date(Math.floor(now() / 1000) * 1000)
      const same = [userId, due, title, new Date(at.getTime() - DEDUPE_MS)]
      // 查和插是一条语句：扫描时持有共享锁，并发的同一条要么等对方提交后看到它，要么死锁被回滚（下面重试）
      // 共享的是索引间隙，同一人并发建不同标题也会死锁，所以重试要错开，否则一起重来又撞一次
      const [r] = await conn.execute(
        `INSERT INTO inbox_task (owner_id, assignee_id, title, note, due_date, priority, tags, source, created_at)
         SELECT ?, ?, ?, ?, ?, ?, '[]', ?, ? FROM DUAL
         WHERE NOT EXISTS (SELECT 1 FROM inbox_task WHERE ${SAME_TASK})`,
        [userId, assigneeId, title, note, due, priority, source, at, ...same]
      )
      if (!r.affectedRows) {
        // 上面的锁还在，这条不会被改掉；FOR SHARE 读最新已提交的，不受事务快照影响
        const [rows] = await conn.execute(`SELECT ${COLUMNS} FROM inbox_task WHERE ${SAME_TASK} ORDER BY id LIMIT 1 FOR SHARE`, same)
        return { task: rows[0], duplicate: true }
      }
      await logEvent(conn, r.insertId, userId, 'create', { source, assignee_id: assigneeId })
      const [rows] = await conn.execute(`SELECT ${COLUMNS} FROM inbox_task WHERE id = ?`, [r.insertId])
      return { task: rows[0], duplicate: false }
    })
    for (let i = 1; ; i++) {
      try {
        return await attempt()
      } catch (e) {
        if (e.errno !== ER_LOCK_DEADLOCK || i >= CREATE_TRIES) throw e
        await new Promise((resolve) => setTimeout(resolve, Math.random() * RETRY_STEP_MS * i))
      }
    }
  }

  async function update(userId, rawId, input) {
    const id = parseTaskId(rawId)
    return tx(async (conn) => {
      const cur = await getVisible(conn, userId, id)
      if (cur.owner_id !== userId) throw new HttpError(403, '只有创建人能修改内容')
      const next = {
        title: 'title' in input ? parseTitle(input.title) : cur.title,
        note: 'note' in input ? parseNote(input.note) : cur.note,
        due_date: 'due_date' in input ? parseDue(input.due_date) : cur.due_date,
        priority: 'priority' in input ? parsePriority(input.priority) : cur.priority
      }
      await conn.execute(
        'UPDATE inbox_task SET title = ?, note = ?, due_date = ?, priority = ? WHERE id = ? AND owner_id = ?',
        [next.title, next.note, next.due_date, next.priority, id, userId]
      )
      const changed = Object.keys(next).filter((k) => next[k] !== cur[k])
      if (changed.length) await logEvent(conn, id, userId, 'edit', { fields: changed })
      return { ...cur, ...next }
    })
  }

  async function setStatus(userId, rawId, status) {
    if (status !== 'open' && status !== 'done') throw new HttpError(400, '状态只能是 open 或 done')
    const id = parseTaskId(rawId)
    return tx(async (conn) => {
      const cur = await getVisible(conn, userId, id)
      if (cur.status === status) return cur
      const doneAt = status === 'done' ? new Date() : null
      await conn.execute(`UPDATE inbox_task SET status = ?, done_at = ? WHERE id = ? AND ${MINE}`, [status, doneAt, id, userId, userId])
      await logEvent(conn, id, userId, status === 'done' ? 'done' : 'reopen', null)
      return { ...cur, status, done_at: doneAt }
    })
  }

  async function assign(userId, rawId, rawAssignee) {
    const id = parseTaskId(rawId)
    const assigneeId = normalizeAssignee(userId, parseUserId(rawAssignee))
    return tx(async (conn) => {
      const cur = await getVisible(conn, userId, id)
      if (cur.owner_id !== userId) throw new HttpError(403, '只有创建人能改指派')
      if (cur.assignee_id === assigneeId) return { task: cur, changed: false }
      await conn.execute('UPDATE inbox_task SET assignee_id = ? WHERE id = ? AND owner_id = ?', [assigneeId, id, userId])
      await logEvent(conn, id, userId, 'assign', { from: cur.assignee_id, to: assigneeId })
      return { task: { ...cur, assignee_id: assigneeId }, changed: true }
    })
  }

  async function events(userId, rawId) {
    const task = await get(userId, rawId)
    const [rows] = await pool.execute('SELECT actor_id, action, detail, created_at FROM inbox_event WHERE task_id = ? ORDER BY id', [task.id])
    return rows
  }

  /** 每日摘要：到今天为止没完成的，归给正在负责的人（有指派归被指派人，没有归创建人） */
  async function dueForDigest(today) {
    const [rows] = await pool.execute(
      `SELECT COALESCE(assignee_id, owner_id) AS user_id, id, title, due_date FROM inbox_task
       WHERE status = 'open' AND due_date <= ? ORDER BY user_id, due_date, priority DESC`,
      [today]
    )
    return rows
  }

  return { list, get, create, update, setStatus, assign, events, dueForDigest }
}

// 指派给自己等于没指派
const normalizeAssignee = (userId, assigneeId) => (assigneeId === userId ? null : assigneeId)

/** 给 MCP 用：due 接受随口说的日期，priority 接受「高 / 中 / 低」 */
export function toolInput(args, today) {
  const out = { title: args.title, note: args.note, priority: 0, due_date: null }
  if (args.due !== undefined && args.due !== null && args.due !== '') {
    out.due_date = parseDueWord(args.due, today)
    if (!out.due_date) throw new HttpError(400, `看不懂截止日期「${args.due}」，请用 YYYY-MM-DD、明天、周三 这样的写法`)
  }
  if (args.priority !== undefined && args.priority !== null) {
    const word = { 高: 3, 中: 2, 低: 1, 无: 0 }[String(args.priority)]
    out.priority = word ?? args.priority
  }
  return out
}
