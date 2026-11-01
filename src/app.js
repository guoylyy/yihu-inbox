// 只做接线：中间件 → 导入 → 接口 → MCP → 页面。权限都在 tasks.js
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import express from 'express'
import { VERSION } from './version.js'
import { HttpError, UNDO_MS, createTasks } from './tasks.js'
import { createPlatformUsers, PlatformUsersError } from './platform-users.js'
import { createSettings } from './settings.js'
import { createModelInfo } from './about.js'
import { buildTools, mcpHandler } from './mcp.js'
import { apiRouter } from './routes/api.js'
import { importRouter } from './routes/import.js'
import { pageRouter } from './routes/pages.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const DEV_USER = { id: 1, name: '本地用户' }
const NOTIFY_MARGIN_MS = 3000 // 撤销窗口过后再等一会儿，请求还在路上时不发

const wrap = (fn) => (req, res, next) => fn(req, res).catch(next)
const CSP = "default-src 'self'; img-src 'self' data:; base-uri 'self'; form-action 'self'; object-src 'none'"

export function createApp({ ws, pool, getReady = () => !!pool, parseTimeoutMs, batchNotifyMs = UNDO_MS + NOTIFY_MARGIN_MS }) {
  const app = express()
  app.disable('x-powered-by')
  app.set('views', path.join(here, 'views'))
  app.set('view engine', 'ejs')

  const tasks = pool ? createTasks({ pool }) : null
  const settings = pool ? createSettings({ pool }) : null
  const users = createPlatformUsers({ clientId: ws.clientId, clientSecret: ws.clientSecret, apiUrl: ws.apiUrl })
  const modelInfo = createModelInfo({ clientId: ws.clientId, clientSecret: ws.clientSecret, apiUrl: ws.apiUrl })
  const llm = ws.clientId && ws.clientSecret ? (opts) => ws.llm(opts) : null
  // 没配平台凭证时只有本地开发能进（单一用户）；生产环境绝不能退回匿名，否则所有人共用一个收件箱
  const devMode = !ws.enabled && process.env.NODE_ENV !== 'production'

  // 健康检查必须免登录。配了数据库但表还没建好时不算正常，平台据此自动回滚
  app.get('/health', (req, res) => {
    if (process.env.DATABASE_URL && !getReady()) return res.status(503).json({ status: 'starting', version: VERSION })
    res.json({ status: 'ok', version: VERSION })
  })

  app.use(ws.middleware({ publicPaths: ['/health', '/mcp', '/static/'] }))
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

  async function checkAssignee(assigneeId, me) {
    if (assigneeId === null || assigneeId === undefined || assigneeId === '' || Number(assigneeId) === me.id) return
    const found = (await users.all()).find((u) => u.id === Number(assigneeId))
    if (!found) throw new HttpError(400, '平台上找不到这个人')
  }

  // 「是否 @ 到人」是指派人自己的设置，读不到就按默认（通知）
  async function notifyPeople(userIds, title, content, me) {
    if (!ws.enabled) return
    const cfg = settings ? await settings.get(me.id).catch(() => null) : null
    if (cfg && !cfg.notify_assignee) return
    ws.call('POST', '/api/open/notify', {
      body: { userIds, title, content: [...content].slice(0, 200).join(''), url: `${ws.appUrl}/` },
      headers: { Authorization: ws.basic() }
    }).catch((e) => console.warn(`[inbox] 指派通知发送失败：${e.message}`))
  }

  async function notifyAssigned(task, me) {
    if (!task.assignee_id) return
    await notifyPeople([task.assignee_id], `${me.name} 指派给你一件事`, task.title, me)
  }

  /** 导入、批量指派：每个被指派人只收一条，写明几件事 */
  async function notifyMany(list, me) {
    const byPerson = new Map()
    for (const t of list) {
      if (!t.assignee_id) continue
      if (!byPerson.has(t.assignee_id)) byPerson.set(t.assignee_id, [])
      byPerson.get(t.assignee_id).push(t.title)
    }
    for (const [id, titles] of byPerson) {
      await notifyPeople([id], titles.length === 1 ? `${me.name} 指派给你一件事` : `${me.name} 指派给你 ${titles.length} 件事`, titles.slice(0, 3).join('；'), me)
    }
  }

  const ctx = { ws, tasks, settings, users, llm, parseTimeoutMs, modelInfo, pool, getReady, userOf, requireReady, requireUser, wrap, checkAssignee, notifyAssigned, notifyMany, batchNotifyMs }

  // 导入自己解析请求体（上限比普通接口大），要排在全局 json 前面
  app.use('/api/import', importRouter(ctx))
  app.use(express.json({ limit: '64kb' }))
  app.use('/api', apiRouter(ctx))

  if (tasks) {
    const tools = buildTools({ tasks, onCreated: (user) => ws.track(user, 'task.create', { source: 'ai', via: 'ai' }) })
    app.post('/mcp', requireReady, mcpHandler({ ws, tools, devUser: devMode ? DEV_USER : null }))
  } else {
    app.post('/mcp', requireReady)
  }
  // 无状态模式不开 SSE
  app.get('/mcp', (req, res) => res.status(405).set('Allow', 'POST').json({ error: '只支持 POST' }))

  app.use(pageRouter(ctx))

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
