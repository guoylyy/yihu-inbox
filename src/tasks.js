// 任务的全部读写。权限只在这一层：每条 SQL 都带当前用户 id，路由和 MCP 没有绕过它的路
//   看得到：自己创建的、指派给自己的。其余一律 404（不告诉对方这个 id 存在）
//   创建人：能改内容、改指派、完成
//   被指派人：只能完成 / 重开，改别的 403
//   归档（软删除）：只有创建人能做。归档后所有视图、统计、推送都看不到，只有「已归档」能恢复
import { addDays, endOfWeek, isValidDate, parseDueWord, startOfDayUtc, weekRange } from './dates.js'

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status }
}

export const TITLE_MAX = 500
export const NOTE_MAX = 5000
export const VIEWS = ['today', 'week', 'open', 'done', 'archived']
export const LIST_LIMIT = 200
export const BATCH_MAX = 1000
export const UNDO_MS = 3000
const UNDO_GRACE_MS = 2000 // 页面上 3 秒内点的撤销，请求在路上多走一会儿也算数
const BATCH_KEEP_MS = 3600_000
const REPORT_LIST_MAX = 50
const STALE_MS = 3 * 86400_000
const RECENT_MAX = 6
const DEDUPE_MS = 60_000
const ER_LOCK_DEADLOCK = 1213
const CREATE_TRIES = 12
const RETRY_STEP_MS = 15

const COLUMNS = 'id, owner_id, assignee_id, title, note, due_date, priority, tags, status, done_at, archived_at, source, created_at, updated_at'
const MINE = '(owner_id = ? OR assignee_id = ?)'
const ALIVE = 'archived_at IS NULL'
const ORDER_OPEN = 'ORDER BY due_date IS NULL, due_date, priority DESC, id DESC'
// 算重复的条件。title 列不分大小写和重音，这里按字节比才是逐字相同；assignee_id、due_date 用 <=>，两边都空也算相同
const SAME_TASK = "owner_id = ? AND assignee_id <=> ? AND status = 'open' AND archived_at IS NULL AND due_date <=> ? AND title COLLATE utf8mb4_0900_bin = ? AND created_at >= ?"

// 视图是固定的几条语句，view 参数只用来选语句，不进 SQL
const VIEW_WHERE = {
  today: { where: `status = 'open' AND ${ALIVE} AND due_date <= ?`, order: ORDER_OPEN, args: (t) => [t] },
  week: { where: `status = 'open' AND ${ALIVE} AND due_date <= ?`, order: ORDER_OPEN, args: (t) => [endOfWeek(t)] },
  open: { where: `status = 'open' AND ${ALIVE}`, order: ORDER_OPEN, args: () => [] },
  done: { where: `status = 'done' AND ${ALIVE}`, order: 'ORDER BY done_at DESC, id DESC', args: () => [] },
  archived: { where: 'archived_at IS NOT NULL', order: 'ORDER BY archived_at DESC, id DESC', args: () => [] }
}

// 批量动作。owner：只有创建人能做；fields：撤销时写回的列；same：已经是这个状态，不算改动；after：撤销前核对没被别人改过
const BATCH = {
  reschedule: {
    owner: true, fields: ['due_date'], alive: true, event: 'edit',
    same: (t, v) => t.due_date === v,
    after: (t, v) => t.due_date === v,
    set: (v) => ['due_date = ?', [v]],
    detail: () => ({ fields: ['due_date'] })
  },
  // 待确认负责人的标记在指派后就没用了；目前 tags 里只有这一种，直接清空
  assign: {
    owner: true, fields: ['assignee_id', 'tags'], alive: true, event: 'assign',
    same: (t, v) => t.assignee_id === v,
    after: (t, v) => t.assignee_id === v,
    set: (v) => (v === null ? ['assignee_id = ?', [v]] : ["assignee_id = ?, tags = '[]'", [v]]),
    detail: (t, v) => ({ from: t.assignee_id, to: v })
  },
  done: {
    owner: false, fields: ['status', 'done_at'], alive: true, event: 'done',
    same: (t) => t.status === 'done',
    after: (t) => t.status === 'done',
    set: (v, at) => ["status = 'done', done_at = ?", [at]],
    detail: () => null
  },
  archive: {
    owner: true, fields: ['archived_at'], alive: true, event: 'archive',
    same: () => false,
    after: (t) => t.archived_at !== null,
    set: (v, at) => ['archived_at = ?', [at]],
    detail: () => null
  },
  restore: {
    owner: true, fields: ['archived_at'], alive: false, event: 'restore',
    same: () => false,
    after: (t) => t.archived_at === null,
    set: () => ['archived_at = NULL', []],
    detail: () => null
  }
}
export const BATCH_ACTIONS = Object.keys(BATCH)

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

const parseBatchIds = (raw) => {
  if (!Array.isArray(raw) || !raw.length) throw new HttpError(400, '先选中要处理的事')
  const ids = [...new Set(raw.map(String))]
  if (ids.length > BATCH_MAX) throw new HttpError(400, `一次最多处理 ${BATCH_MAX} 条`)
  if (ids.some((id) => !/^[1-9]\d{0,18}$/.test(id))) throw new HttpError(400, '选中的内容不对')
  return ids
}

async function retrying(attempt) {
  for (let i = 1; ; i++) {
    try {
      return await attempt()
    } catch (e) {
      if (e.errno !== ER_LOCK_DEADLOCK || i >= CREATE_TRIES) throw e
      await new Promise((resolve) => setTimeout(resolve, Math.random() * RETRY_STEP_MS * i))
    }
  }
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

  const nowSeconds = () => new Date(Math.floor(now() / 1000) * 1000)

  const logEvent = (conn, taskId, actorId, action, detail) => conn.execute(
    'INSERT INTO inbox_event (task_id, actor_id, action, detail) VALUES (?, ?, ?, ?)',
    [taskId, actorId, action, detail ? JSON.stringify(detail) : null]
  )

  async function getVisible(conn, userId, id) {
    const [rows] = await conn.execute(`SELECT ${COLUMNS} FROM inbox_task WHERE id = ? AND ${MINE} AND ${ALIVE} FOR UPDATE`, [id, userId, userId])
    if (!rows.length) throw new HttpError(404, '任务不存在')
    return rows[0]
  }

  async function list(userId, view, today, limit = LIST_LIMIT) {
    const v = VIEW_WHERE[view]
    if (!v) throw new HttpError(400, '没有这个视图')
    const [rows] = await pool.query(`SELECT ${COLUMNS} FROM inbox_task WHERE ${MINE} AND ${v.where} ${v.order} LIMIT ?`, [userId, userId, ...v.args(today), limit])
    return rows
  }

  /** 「全部选中」：当前视图里所有的 id，不受列表 200 条的限制 */
  async function viewIds(userId, view, today) {
    const v = VIEW_WHERE[view]
    if (!v) throw new HttpError(400, '没有这个视图')
    const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total FROM inbox_task WHERE ${MINE} AND ${v.where}`, [userId, userId, ...v.args(today)])
    const [rows] = await pool.query(`SELECT id FROM inbox_task WHERE ${MINE} AND ${v.where} ${v.order} LIMIT ?`, [userId, userId, ...v.args(today), BATCH_MAX])
    return { total, ids: rows.map((r) => r.id) }
  }

  async function get(userId, rawId) {
    const id = parseTaskId(rawId)
    const [rows] = await pool.execute(`SELECT ${COLUMNS} FROM inbox_task WHERE id = ? AND ${MINE} AND ${ALIVE}`, [id, userId, userId])
    if (!rows.length) throw new HttpError(404, '任务不存在')
    return rows[0]
  }

  // dedupe 只给会重复提交的调用方（agent、快捷记一条）；人在表单里点的每一次都是真的，默认不去重
  async function create(userId, input, { source = 'self', dedupe = false } = {}) {
    const title = parseTitle(input.title)
    const note = parseNote(input.note)
    const due = parseDue(input.due_date)
    const priority = parsePriority(input.priority)
    const assigneeId = normalizeAssignee(userId, parseUserId(input.assignee_id))
    const attempt = () => tx(async (conn) => {
      // created_at 由这里写，和窗口用同一个时钟；列精确到秒，先取整，免得被数据库四舍五入
      const at = new Date(Math.floor(now() / 1000) * 1000)
      const row = [userId, assigneeId, title, note, due, priority, source, at]
      const same = [userId, assigneeId, due, title, new Date(at.getTime() - DEDUPE_MS)]
      // 查和插是一条语句：扫描时持有共享锁，并发的同一条要么等对方提交后看到它，要么死锁被回滚（下面重试）
      // 共享的是索引间隙，同一人并发建不同标题也会死锁，所以重试要错开，否则一起重来又撞一次
      const [r] = await conn.execute(
        `INSERT INTO inbox_task (owner_id, assignee_id, title, note, due_date, priority, tags, source, created_at)
         SELECT ?, ?, ?, ?, ?, ?, '[]', ?, ? FROM DUAL
         ${dedupe ? `WHERE NOT EXISTS (SELECT 1 FROM inbox_task WHERE ${SAME_TASK})` : ''}`,
        dedupe ? [...row, ...same] : row
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
    return retrying(attempt)
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
      const tags = assigneeId ? [] : cur.tags // 指派给人后，「负责人待确认」的标记就没用了
      await conn.execute('UPDATE inbox_task SET assignee_id = ?, tags = ? WHERE id = ? AND owner_id = ?', [assigneeId, JSON.stringify(tags), id, userId])
      await logEvent(conn, id, userId, 'assign', { from: cur.assignee_id, to: assigneeId })
      return { task: { ...cur, assignee_id: assigneeId, tags }, changed: true }
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
       WHERE status = 'open' AND ${ALIVE} AND due_date <= ? ORDER BY user_id, due_date, priority DESC`,
      [today]
    )
    return rows
  }

  /**
   * 批量动作在一个事务里做完：先按 id 顺序锁住选中的行，逐条分类，能做的一条 UPDATE 改掉。
   * 权限和状态不符的不算失败，跳过并报数；数据库出错整批回滚，不会只改一半
   */
  async function batch(userId, action, rawIds, value = null) {
    const def = BATCH[action]
    if (!def) throw new HttpError(400, '没有这个批量操作')
    const ids = parseBatchIds(rawIds)
    return retrying(() => tx(async (conn) => {
      const scope = def.alive ? ALIVE : 'archived_at IS NOT NULL'
      const [rows] = await conn.query(`SELECT ${COLUMNS} FROM inbox_task WHERE id IN (?) AND ${MINE} AND ${scope} ORDER BY id FOR UPDATE`, [ids, userId, userId])
      const notOwner = def.owner ? rows.filter((t) => t.owner_id !== userId) : []
      const allowed = def.owner ? rows.filter((t) => t.owner_id === userId) : rows
      const changing = allowed.filter((t) => !def.same(t, value))
      const out = {
        batch_id: null, action, changed: changing.map((t) => t.id), unchanged: allowed.length - changing.length,
        skipped: { not_owner: notOwner.length, gone: ids.length - rows.length }, undo_ms: UNDO_MS
      }
      if (!changing.length) return out

      const at = nowSeconds()
      const [sets, args] = def.set(value, at)
      await conn.query(`UPDATE inbox_task SET ${sets} WHERE id IN (?)`, [...args, out.changed])
      const snapshot = changing.map((t) => ({ id: t.id, updated_at: t.updated_at, ...Object.fromEntries(def.fields.map((f) => [f, t[f]])) }))
      const undoUntil = new Date(now() + UNDO_MS + UNDO_GRACE_MS)
      await conn.execute('DELETE FROM inbox_batch WHERE actor_id = ? AND undo_until < ?', [userId, new Date(now() - BATCH_KEEP_MS)])
      const [r] = await conn.execute(
        'INSERT INTO inbox_batch (actor_id, action, after_value, snapshot, undo_until) VALUES (?, ?, ?, ?, ?)',
        [userId, action, JSON.stringify(value), JSON.stringify(snapshot), undoUntil]
      )
      out.batch_id = r.insertId
      await conn.query('INSERT INTO inbox_event (task_id, actor_id, action, detail) VALUES ?', [changing.map((t) => {
        const detail = { ...def.detail(t, value), batch: r.insertId }
        return [t.id, userId, def.event, JSON.stringify(detail)]
      })])
      return out
    }))
  }

  /** 撤销：只还原这批改过、之后没被别人再动的行，连 updated_at 一起还原，撤销等于没发生过 */
  async function undoBatch(userId, rawId) {
    if (!/^[1-9]\d{0,18}$/.test(String(rawId))) throw new HttpError(404, '这次操作不存在')
    return retrying(() => tx(async (conn) => {
      const [[b]] = await conn.execute('SELECT id, action, after_value, snapshot, undo_until, undone_at FROM inbox_batch WHERE id = ? AND actor_id = ? FOR UPDATE', [String(rawId), userId])
      if (!b) throw new HttpError(404, '这次操作不存在')
      if (b.undone_at) throw new HttpError(409, '已经撤销过了')
      if (now() > b.undo_until.getTime()) throw new HttpError(410, '已超过撤销时间')
      const def = BATCH[b.action]
      const ids = b.snapshot.map((s) => s.id)
      const [rows] = await conn.query(`SELECT ${COLUMNS} FROM inbox_task WHERE id IN (?) AND ${MINE} ORDER BY id FOR UPDATE`, [ids, userId, userId])
      const current = new Map(rows.map((t) => [t.id, t]))
      const restorable = b.snapshot.filter((s) => current.has(s.id) && def.after(current.get(s.id), b.after_value))
      for (const s of restorable) {
        const values = def.fields.map((f) => {
          if (f === 'tags') return JSON.stringify(s[f])
          return f.endsWith('_at') && s[f] ? new Date(s[f]) : s[f]
        })
        await conn.execute(`UPDATE inbox_task SET ${def.fields.map((f) => `${f} = ?`).join(', ')}, updated_at = ? WHERE id = ?`, [...values, new Date(s.updated_at), s.id])
        await logEvent(conn, s.id, userId, 'undo', { batch: b.id })
      }
      await conn.execute('UPDATE inbox_batch SET undone_at = ? WHERE id = ?', [nowSeconds(), b.id])
      return { restored: restorable.length, conflicted: b.snapshot.length - restorable.length }
    }))
  }

  async function batchUndone(id) {
    const [rows] = await pool.execute('SELECT undone_at FROM inbox_batch WHERE id = ?', [id])
    return !!rows[0]?.undone_at
  }

  /** 导入：要么全进，要么全不进。rows 已经由路由校验过人 */
  async function createMany(userId, rows, { source = 'app', via = 'import' } = {}) {
    const clean = rows.map((row, i) => {
      try {
        const tags = Array.isArray(row.tags) ? row.tags : []
        return { title: parseTitle(row.title), note: parseNote(row.note), due: parseDue(row.due_date), assignee: normalizeAssignee(userId, parseUserId(row.assignee_id)), tags }
      } catch (e) {
        throw e instanceof HttpError ? new HttpError(e.status, `第 ${i + 1} 条：${e.message}`) : e
      }
    })
    return retrying(() => tx(async (conn) => {
      const at = nowSeconds()
      const ids = []
      for (const t of clean) {
        const [r] = await conn.execute(
          'INSERT INTO inbox_task (owner_id, assignee_id, title, note, due_date, priority, tags, source, created_at) VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?)',
          [userId, t.assignee, t.title, t.note, t.due, JSON.stringify(t.tags), source, at]
        )
        await logEvent(conn, r.insertId, userId, 'create', { source, via, assignee_id: t.assignee })
        ids.push(r.insertId)
      }
      return ids.map((id, i) => ({ id, title: clean[i].title, assignee_id: clean[i].assignee }))
    }))
  }

  /** 导入预览用：我看得到、没归档的事里，标题和日期都相同的。逐字比较，不走列的宽松排序规则 */
  async function findSame(userId, titles) {
    const wanted = [...new Set(titles)]
    if (!wanted.length) return []
    const [rows] = await pool.query(
      `SELECT title, due_date, status FROM inbox_task WHERE ${MINE} AND ${ALIVE} AND title COLLATE utf8mb4_0900_bin IN (?)`,
      [userId, userId, wanted]
    )
    return rows
  }

  /** 周报的原始数据。口径见 report.js */
  async function weekStats(userId, today) {
    const { from, to, end } = weekRange(today)
    const staleBefore = new Date(now() - STALE_MS)
    const visible = `${MINE} AND ${ALIVE}`
    const me = [userId, userId]
    const count = async (where, args) => (await pool.query(`SELECT COUNT(*) AS n FROM inbox_task WHERE ${visible} AND ${where}`, [...me, ...args]))[0][0].n
    const pick = async (where, args, order) => (await pool.query(`SELECT ${COLUMNS} FROM inbox_task WHERE ${visible} AND ${where} ORDER BY ${order} LIMIT ?`, [...me, ...args, REPORT_LIST_MAX]))[0]
    const [added, done, openDue, overdueTotal, overdue, staleTotal, stale] = await Promise.all([
      count('created_at >= ? AND created_at < ?', [from, to]),
      count("status = 'done' AND done_at >= ? AND done_at < ?", [from, to]),
      count("status = 'open' AND due_date <= ?", [end]),
      count("status = 'open' AND due_date < ?", [today]),
      pick("status = 'open' AND due_date < ?", [today], 'due_date, id'),
      count("status = 'open' AND updated_at < ?", [staleBefore]),
      pick("status = 'open' AND updated_at < ?", [staleBefore], 'updated_at, id')
    ])
    return { added, done, openDue, overdueTotal, overdue, staleTotal, stale }
  }

  /** 我看得到的未完成，归到正在负责的人头上（和每日摘要同一个口径） */
  async function loadByPerson(userId) {
    const [rows] = await pool.query(
      `SELECT COALESCE(assignee_id, owner_id) AS user_id, COUNT(*) AS count FROM inbox_task
       WHERE ${MINE} AND ${ALIVE} AND status = 'open' GROUP BY user_id ORDER BY count DESC, user_id`,
      [userId, userId]
    )
    return rows
  }

  /** 今日进度：今天完成的 / 今天完成的 + 到今天为止还没做完的 */
  async function todayProgress(userId, today) {
    const [[row]] = await pool.query(
      `SELECT COALESCE(SUM(status = 'done' AND done_at >= ? AND done_at < ?), 0) AS done,
              COALESCE(SUM(status = 'open' AND due_date <= ?), 0) AS left_count
       FROM inbox_task WHERE ${MINE} AND ${ALIVE}`,
      [startOfDayUtc(today), startOfDayUtc(addDays(today, 1)), today, userId, userId]
    )
    return { done: Number(row.done), left: Number(row.left_count) }
  }

  async function recentActivity(userId) {
    const [rows] = await pool.query(
      `SELECT e.id, e.actor_id, e.action, e.created_at, t.title, t.id AS task_id FROM inbox_event e
       JOIN inbox_task t ON t.id = e.task_id
       WHERE (t.owner_id = ? OR t.assignee_id = ?) AND t.archived_at IS NULL
       ORDER BY e.id DESC LIMIT ?`,
      [userId, userId, RECENT_MAX]
    )
    return rows
  }

  /** 这一轮推送的占位，抢到才发 */
  async function claimPush(slot) {
    const [r] = await pool.execute('INSERT IGNORE INTO inbox_push_log (slot) VALUES (?)', [slot])
    return r.affectedRows === 1
  }

  return { list, viewIds, get, create, update, setStatus, assign, events, dueForDigest, batch, undoBatch, batchUndone, createMany, findSame, weekStats, loadByPerson, todayProgress, recentActivity, claimPush }
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
