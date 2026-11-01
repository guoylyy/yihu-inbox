// 接口保持薄：取当前用户 → 调 tasks.js。列表片段放在 /api 下，未登录时回 401 而不是跳转
import express from 'express'
import { addDays, parseDueWord, todayIn, tzName } from '../dates.js'
import { BATCH_MAX, HttpError, VIEWS } from '../tasks.js'
import { INPUT_MAX, parseQuickInput } from '../parse.js'
import { matchAssignee, matchesKeyword } from '../platform-users.js'
import { defaultDue } from '../settings.js'
import { aboutInfo } from '../about.js'
import { buildReport } from '../report.js'
import { toJson } from '../present.js'
import { listData, railData } from './list.js'

const PICKER_LIMIT = 50
const DUE_PRESETS = {
  today: (t) => t,
  tomorrow: (t) => addDays(t, 1),
  next_week: (t) => parseDueWord('下周一', t)
}

export function apiRouter(ctx) {
  const { ws, tasks, settings, users, llm, parseTimeoutMs, modelInfo, pool, requireReady, requireUser, wrap, checkAssignee, notifyAssigned, notifyMany, batchNotifyMs } = ctx
  const r = express.Router()
  const data = [requireReady, requireUser]

  const viewOf = (req) => (VIEWS.includes(req.query.view) ? req.query.view : 'today')

  r.get('/list.html', data, wrap(async (req, res) => {
    res.render('partials/list', await listData(ctx, req.me, viewOf(req)))
  }))

  r.get('/rail.html', data, wrap(async (req, res) => {
    res.render('partials/rail', { rail: await railData(ctx, req.me) })
  }))

  // 只给确认弹层预填，这里不写库。名单拉不到时按没认出来处理，不能卡住录入
  async function assigneeMatch(name, me) {
    const people = await users.all().catch(() => [])
    const { user, candidates, status } = matchAssignee(people.filter((u) => u.active && u.id !== me.id), name)
    const brief = ({ id, name, dept }) => ({ id, name, dept })
    return { status, user: user ? brief(user) : null, candidates: candidates.slice(0, PICKER_LIMIT).map(brief) }
  }

  /** 设置里的默认值补到确认弹层。库没好时跳过，解析照常 */
  async function parseDefaults(me, out, today) {
    if (!settings || !ctx.getReady()) return {}
    const cfg = await settings.get(me.id).catch(() => null)
    if (!cfg) return {}
    const extra = {}
    if (!out.due_date && cfg.quick_due !== 'none') {
      extra.due_date = defaultDue(cfg.quick_due, today)
      extra.due_defaulted = true
    }
    // 话里提到了人但没认出来：留空让人选，不拿默认值顶替
    if (!out.assignee && cfg.default_assignee_id) {
      const people = await users.all().catch(() => [])
      const person = people.find((u) => u.id === cfg.default_assignee_id && u.active)
      if (person) extra.default_assignee = { id: person.id, name: person.name }
    }
    return extra
  }

  r.post('/parse', requireUser, wrap(async (req, res) => {
    const text = String(req.body?.text ?? '').trim()
    if (!text) throw new HttpError(400, '先写点什么')
    if ([...text].length > INPUT_MAX) throw new HttpError(400, `一句话不能超过 ${INPUT_MAX} 字`)
    const today = todayIn()
    const out = await parseQuickInput(text, { llm, today, tz: tzName(), timeoutMs: parseTimeoutMs })
    ws.track(req.me, 'task.parse', { parsed: out.parsed })
    res.json({ ...out, match: out.assignee ? await assigneeMatch(out.assignee, req.me) : null, ...await parseDefaults(req.me, out, today) })
  }))

  r.post('/tasks', data, wrap(async (req, res) => {
    await checkAssignee(req.body?.assignee_id, req.me)
    const { task } = await tasks.create(req.me.id, req.body || {}, { source: 'self' })
    ws.track(req.me, 'task.create', { source: 'self', assigned: !!task.assignee_id })
    notifyAssigned(task, req.me).catch(() => {})
    res.status(201).json(toJson(task, req.me))
  }))

  r.get('/tasks', data, wrap(async (req, res) => {
    const view = String(req.query.view ?? 'today')
    const list = await tasks.list(req.me.id, view, todayIn())
    res.json({ list: list.map((t) => toJson(t, req.me)) })
  }))

  // 「全部选中」用：拿当时的 id 清单，之后新进来的事不会被顺带处理
  r.get('/tasks/ids', data, wrap(async (req, res) => {
    res.json({ ...await tasks.viewIds(req.me.id, viewOf(req), todayIn()), max: BATCH_MAX })
  }))

  async function batchValue(body, me) {
    if (body.action === 'reschedule') {
      const preset = DUE_PRESETS[body.preset]
      if (body.preset !== undefined && !preset) throw new HttpError(400, '改期选项不对')
      if (preset) return preset(todayIn())
      if (body.due_date === null) return null
      if (typeof body.due_date !== 'string' || !parseDueWord(body.due_date, todayIn())) throw new HttpError(400, '截止日期格式不对')
      return parseDueWord(body.due_date, todayIn())
    }
    if (body.action === 'assign') {
      await checkAssignee(body.assignee_id, me)
      const n = body.assignee_id === null || body.assignee_id === undefined || body.assignee_id === '' ? null : Number(body.assignee_id)
      if (n !== null && (!Number.isInteger(n) || n <= 0)) throw new HttpError(400, '指派对象不对')
      return n === me.id ? null : n
    }
    return null
  }

  /** 撤销窗口过了才通知：撤销掉的指派不打扰人 */
  function notifyAfterWindow(result, me, value) {
    if (result.action !== 'assign' || !value || !result.changed.length) return
    const timer = setTimeout(async () => {
      try {
        if (await tasks.batchUndone(result.batch_id)) return
        const titles = await Promise.all(result.changed.slice(0, 3).map((id) => tasks.get(me.id, id).then((t) => t.title).catch(() => null)))
        const shown = titles.filter(Boolean)
        const rest = Array.from({ length: result.changed.length - shown.length }, () => '')
        await notifyMany([...shown, ...rest].map((title) => ({ assignee_id: value, title })), me)
      } catch (e) {
        console.warn(`[inbox] 批量指派通知失败：${e.message}`)
      }
    }, batchNotifyMs)
    timer.unref()
  }

  r.post('/tasks/batch', data, wrap(async (req, res) => {
    const body = req.body || {}
    const value = await batchValue(body, req.me)
    const out = await tasks.batch(req.me.id, body.action, body.ids, value)
    ws.track(req.me, 'task.batch', { action: body.action, count: out.changed.length })
    notifyAfterWindow(out, req.me, value)
    res.json(out)
  }))

  r.post('/batches/:id/undo', data, wrap(async (req, res) => {
    const out = await tasks.undoBatch(req.me.id, req.params.id)
    ws.track(req.me, 'task.batch_undo', { count: out.restored })
    res.json(out)
  }))

  r.get('/tasks/:id', data, wrap(async (req, res) => {
    const task = await tasks.get(req.me.id, req.params.id)
    const names = await users.names([task.owner_id, task.assignee_id].filter((id) => id && id !== req.me.id))
    res.json(toJson(task, req.me, names))
  }))

  r.patch('/tasks/:id', data, wrap(async (req, res) => {
    const task = await tasks.update(req.me.id, req.params.id, req.body || {})
    ws.track(req.me, 'task.update')
    res.json(toJson(task, req.me))
  }))

  r.put('/tasks/:id/status', data, wrap(async (req, res) => {
    const task = await tasks.setStatus(req.me.id, req.params.id, req.body?.status)
    ws.track(req.me, task.status === 'done' ? 'task.done' : 'task.reopen')
    res.json(toJson(task, req.me))
  }))

  r.put('/tasks/:id/assignee', data, wrap(async (req, res) => {
    // 先确认任务归自己，别让人靠报错探测平台用户
    const cur = await tasks.get(req.me.id, req.params.id)
    if (cur.owner_id !== req.me.id) throw new HttpError(403, '只有创建人能改指派')
    await checkAssignee(req.body?.assignee_id, req.me)
    const { task, changed } = await tasks.assign(req.me.id, req.params.id, req.body?.assignee_id)
    if (changed) {
      ws.track(req.me, 'task.assign', { taskId: task.id, assigneeId: task.assignee_id })
      notifyAssigned(task, req.me).catch(() => {})
    }
    const names = await users.names(task.assignee_id ? [task.assignee_id] : [])
    res.json(toJson(task, req.me, names))
  }))

  // 只给选人用，字段收到最少，不把手机号之类带给前端
  r.get('/users', requireUser, wrap(async (req, res) => {
    const hits = (await users.all()).filter((u) => u.active && u.id !== req.me.id && matchesKeyword(u, req.query.q))
    res.json({ total: hits.length, list: hits.slice(0, PICKER_LIMIT).map(({ id, name, dept }) => ({ id, name, dept })) })
  }))

  r.get('/report/week', data, wrap(async (req, res) => {
    res.json(await buildReport({ tasks, users, me: req.me, today: todayIn() }))
  }))

  r.get('/settings', data, wrap(async (req, res) => res.json(await settings.get(req.me.id))))

  r.put('/settings', data, wrap(async (req, res) => {
    const body = req.body || {}
    if ('default_assignee_id' in body) await checkAssignee(body.default_assignee_id, req.me)
    res.json(await settings.save(req.me.id, body))
  }))

  r.get('/about', requireUser, wrap(async (req, res) => {
    res.json(await aboutInfo({ pool, modelInfo, hosted: ws.enabled }))
  }))

  return r
}
