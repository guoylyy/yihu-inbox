// 路由保持薄：取当前用户 → 调 tasks.js。权限都在 tasks.js
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import express from 'express'
import { basePathOf } from './yh-one.mjs'
import { VERSION } from './version.js'
import { dueLabel, shortDate, todayIn, tzName } from './dates.js'
import { HttpError, VIEWS, createTasks } from './tasks.js'
import { INPUT_MAX, parseQuickInput } from './parse.js'
import { PlatformUsersError, createPlatformUsers, matchAssignee, matchesKeyword } from './platform-users.js'
import { buildTools, mcpHandler } from './mcp.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const VIEW_TABS = [['today', '今天'], ['week', '本周'], ['open', '全部'], ['done', '已完成']]
const PICKER_LIMIT = 50
const DEV_USER = { id: 1, name: '本地用户' }

const wrap = (fn) => (req, res, next) => fn(req, res).catch(next)
const CSP = "default-src 'self'; img-src 'self' data:; base-uri 'self'; form-action 'self'; object-src 'none'"

export function createApp({ ws, pool, getReady = () => !!pool, parseTimeoutMs }) {
  const app = express()
  app.disable('x-powered-by')
  app.set('views', path.join(here, 'views'))
  app.set('view engine', 'ejs')

  const tasks = pool ? createTasks({ pool }) : null
  const users = createPlatformUsers({ clientId: ws.clientId, clientSecret: ws.clientSecret, apiUrl: ws.apiUrl })
  const llm = ws.clientId && ws.clientSecret ? (opts) => ws.llm(opts) : null
  // 没配平台凭证时只有本地开发能进（单一用户）；生产环境绝不能退回匿名，否则所有人共用一个收件箱
  const devMode = !ws.enabled && process.env.NODE_ENV !== 'production'

  // 健康检查必须免登录。配了数据库但表还没建好时不算正常，平台据此自动回滚
  app.get('/health', (req, res) => {
    if (process.env.DATABASE_URL && !getReady()) return res.status(503).json({ status: 'starting', version: VERSION })
    res.json({ status: 'ok', version: VERSION })
  })

  app.use(ws.middleware({ publicPaths: ['/health', '/mcp', '/static/'] }))
  app.use(express.json({ limit: '64kb' }))
  app.use('/static', express.static(path.join(here, 'public'), { maxAge: '1h' }))
  app.use((req, res, next) => { res.setHeader('Content-Security-Policy', CSP); next() })

  const userOf = (req) => req.yhUser || (devMode ? DEV_USER : null)
  const requireReady = (req, res, next) => {
    if (!tasks || !getReady()) return next(new HttpError(503, '数据库还没准备好，稍后再试'))
    next()
  }
  const requireUser = (req, res, next) => {
    req.me = userOf(req)
    if (!req.me) return next(new HttpError(503, '应用未接入平台，请联系管理员'))
    next()
  }

  async function renderList(me, view) {
    const today = todayIn()
    const list = await tasks.list(me.id, view, today)
    const others = list.flatMap((t) => [t.owner_id, t.assignee_id]).filter((id) => id && id !== me.id)
    const names = await users.names(others)
    return { today, view, tasks: list.map((t) => decorate(t, me, today, names)) }
  }

  const toJson = (t, me, names = new Map()) => ({ ...decorate(t, me, todayIn(), names), note: t.note })

  // 列表 HTML 片段：切视图、录入后局部刷新。放在 /api 下，未登录时回 401 而不是跳转
  app.get('/api/list.html', requireReady, requireUser, wrap(async (req, res) => {
    const view = VIEWS.includes(req.query.view) ? req.query.view : 'today'
    res.render('partials/list', await renderList(req.me, view))
  }))

  app.post('/api/parse', requireUser, wrap(async (req, res) => {
    const text = String(req.body?.text ?? '').trim()
    if (!text) throw new HttpError(400, '先写点什么')
    if ([...text].length > INPUT_MAX) throw new HttpError(400, `一句话不能超过 ${INPUT_MAX} 字`)
    const out = await parseQuickInput(text, { llm, today: todayIn(), tz: tzName(), timeoutMs: parseTimeoutMs })
    ws.track(req.me, 'task.parse', { parsed: out.parsed })
    res.json({ ...out, match: out.assignee ? await assigneeMatch(out.assignee, req.me) : null })
  }))

  // 只给确认弹层预填，这里不写库。名单拉不到时按没认出来处理，不能卡住录入
  async function assigneeMatch(name, me) {
    const people = await users.all().catch(() => [])
    const { user, candidates, status } = matchAssignee(people.filter((u) => u.active && u.id !== me.id), name)
    const brief = ({ id, name, dept }) => ({ id, name, dept })
    return { status, user: user ? brief(user) : null, candidates: candidates.slice(0, PICKER_LIMIT).map(brief) }
  }

  async function checkAssignee(assigneeId, me) {
    if (assigneeId === null || assigneeId === undefined || assigneeId === '' || Number(assigneeId) === me.id) return
    const found = (await users.all()).find((u) => u.id === Number(assigneeId))
    if (!found) throw new HttpError(400, '平台上找不到这个人')
  }

  async function notifyAssigned(task, me) {
    if (!task.assignee_id || !ws.enabled) return
    ws.call('POST', '/api/open/notify', {
      body: { userIds: [task.assignee_id], title: `${me.name} 指派给你一件事`, content: [...task.title].slice(0, 200).join(''), url: `${ws.appUrl}/` },
      headers: { Authorization: ws.basic() }
    }).catch((e) => console.warn(`[inbox] 指派通知发送失败：${e.message}`))
  }

  app.post('/api/tasks', requireReady, requireUser, wrap(async (req, res) => {
    await checkAssignee(req.body?.assignee_id, req.me)
    const { task } = await tasks.create(req.me.id, req.body || {}, { source: 'self' })
    ws.track(req.me, 'task.create', { source: 'self', assigned: !!task.assignee_id })
    notifyAssigned(task, req.me)
    res.status(201).json(toJson(task, req.me))
  }))

  app.get('/api/tasks', requireReady, requireUser, wrap(async (req, res) => {
    const view = String(req.query.view ?? 'today')
    const list = await tasks.list(req.me.id, view, todayIn())
    res.json({ list: list.map((t) => toJson(t, req.me)) })
  }))

  app.get('/api/tasks/:id', requireReady, requireUser, wrap(async (req, res) => {
    const task = await tasks.get(req.me.id, req.params.id)
    const names = await users.names([task.owner_id, task.assignee_id].filter((id) => id && id !== req.me.id))
    res.json(toJson(task, req.me, names))
  }))

  app.patch('/api/tasks/:id', requireReady, requireUser, wrap(async (req, res) => {
    const task = await tasks.update(req.me.id, req.params.id, req.body || {})
    ws.track(req.me, 'task.update')
    res.json(toJson(task, req.me))
  }))

  app.put('/api/tasks/:id/status', requireReady, requireUser, wrap(async (req, res) => {
    const task = await tasks.setStatus(req.me.id, req.params.id, req.body?.status)
    ws.track(req.me, task.status === 'done' ? 'task.done' : 'task.reopen')
    res.json(toJson(task, req.me))
  }))

  app.put('/api/tasks/:id/assignee', requireReady, requireUser, wrap(async (req, res) => {
    // 先确认任务归自己，别让人靠报错探测平台用户
    const cur = await tasks.get(req.me.id, req.params.id)
    if (cur.owner_id !== req.me.id) throw new HttpError(403, '只有创建人能改指派')
    await checkAssignee(req.body?.assignee_id, req.me)
    const { task, changed } = await tasks.assign(req.me.id, req.params.id, req.body?.assignee_id)
    if (changed) {
      ws.track(req.me, 'task.assign', { taskId: task.id, assigneeId: task.assignee_id })
      notifyAssigned(task, req.me)
    }
    const names = await users.names(task.assignee_id ? [task.assignee_id] : [])
    res.json(toJson(task, req.me, names))
  }))

  // 只给选人用，字段收到最少，不把手机号之类带给前端
  app.get('/api/users', requireUser, wrap(async (req, res) => {
    const hits = (await users.all()).filter((u) => u.active && u.id !== req.me.id && matchesKeyword(u, req.query.q))
    res.json({ total: hits.length, list: hits.slice(0, PICKER_LIMIT).map(({ id, name, dept }) => ({ id, name, dept })) })
  }))

  if (tasks) {
    const tools = buildTools({ tasks, onCreated: (user) => ws.track(user, 'task.create', { source: 'ai', via: 'ai' }) })
    app.post('/mcp', requireReady, mcpHandler({ ws, tools, devUser: devMode ? DEV_USER : null }))
  } else {
    app.post('/mcp', requireReady)
  }
  // 无状态模式不开 SSE
  app.get('/mcp', (req, res) => res.status(405).set('Allow', 'POST').json({ error: '只支持 POST' }))

  app.get('/', wrap(async (req, res) => {
    const me = userOf(req)
    const base = `${basePathOf(req)}/`
    const page = { base, version: VERSION, tabs: VIEW_TABS, inputMax: INPUT_MAX }
    if (!me || !tasks || !getReady()) {
      return res.status(503).render('index', { ...page, me: null, view: 'today', tasks: [], today: todayIn(), problem: !me ? '应用未接入平台，请联系管理员' : '数据库还没准备好，稍后刷新' })
    }
    const view = VIEWS.includes(req.query.view) ? req.query.view : 'today'
    ws.track(me, 'home.view', { view })
    res.render('index', { ...page, me, problem: null, ...await renderList(me, view) })
  }))

  app.use((req, res) => res.status(404).json({ error: '没有这个地址' }))

  app.use((err, req, res, next) => {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message })
    if (err instanceof PlatformUsersError) return res.status(503).json({ error: err.message })
    if (err.type === 'entity.parse.failed' || err.type === 'entity.too.large') return res.status(400).json({ error: '请求内容不对' })
    console.error('[inbox]', req.method, req.path, err.message)
    res.status(500).json({ error: '出错了，稍后再试' })
  })

  return app
}

function decorate(t, me, today, names) {
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
    mine: t.owner_id === me.id,
    assignee_id: t.assignee_id,
    assignee: t.assignee_id && t.assignee_id !== me.id ? nameOf(t.assignee_id) : '',
    from: t.owner_id !== me.id ? nameOf(t.owner_id) : ''
  }
}
