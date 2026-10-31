// 假平台：测试和 e2e 共用。实现应用真正会调的那几个平台接口，走真实 SDK 的登录流程，应用代码里没有任何测试后门
// e2e 时还充当 Caddy：把 /apps/inbox/* 剥掉前缀转给应用，带 X-Forwarded-Prefix，和线上拓扑一致
import http from 'node:http'

export const PEOPLE = [
  { id: 11, username: 'alice', name: '王小明', active: true, depts: [{ name: '销售部', isPrimary: true }], mobile: '13800000000' },
  { id: 12, username: 'bob', name: '李雷', active: true, depts: [{ name: '法务部', isPrimary: true }] },
  { id: 13, username: 'carol', name: '韩梅梅', active: true, depts: [{ name: '销售部', isPrimary: true }] },
  { id: 14, username: 'gone', name: '已离职', active: false, depts: [] }
]

export function startFakePlatform({ port = 0, appTarget = null, prefix = '/apps/inbox', people = PEOPLE } = {}) {
  const state = {
    llm: () => JSON.stringify({ title: '默认任务', due_date: null, due_time: null, priority: 0 }),
    usersDown: false,
    notifications: [],
    events: [],
    loginAs: 11
  }

  const json = (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)) }
  const readBody = (req) => new Promise((resolve) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks)))
  })

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x')

    if (appTarget && (url.pathname === prefix || url.pathname.startsWith(`${prefix}/`))) {
      const path = (url.pathname.slice(prefix.length) || '/') + url.search
      const body = await readBody(req)
      const headers = { ...req.headers, 'x-forwarded-prefix': prefix }
      const upstream = http.request({ ...appTarget, path, method: req.method, headers }, (r) => {
        res.writeHead(r.statusCode, r.headers)
        r.pipe(res)
      })
      upstream.on('error', () => json(res, 502, { error: 'bad gateway' }))
      return upstream.end(body)
    }

    if (url.pathname === '/sso/authorize') {
      const to = new URL(url.searchParams.get('redirect_uri'))
      to.searchParams.set('code', `user-${state.loginAs}`)
      to.searchParams.set('state', url.searchParams.get('state'))
      res.writeHead(302, { Location: to.toString() })
      return res.end()
    }
    if (url.pathname === '/api/sso/token') {
      const { code } = JSON.parse(await readBody(req))
      const u = people.find((p) => `user-${p.id}` === code)
      return json(res, 200, u ? { code: 0, data: { user: { id: u.id, name: u.name, depts: u.depts } } } : { code: 1, message: 'bad code' })
    }
    if (url.pathname === '/api/sso/userinfo') {
      const m = /^Bearer token-(\d+)$/.exec(req.headers.authorization || '')
      const u = m && people.find((p) => p.id === Number(m[1]))
      return json(res, 200, u ? { code: 0, data: { id: u.id, name: u.name } } : { code: 1001, message: 'token 无效' })
    }
    if (url.pathname === '/api/open/users') {
      if (state.usersDown) return json(res, 500, {})
      const list = people.filter((p) => p.active)
      return json(res, 200, { code: 0, data: { total: list.length, list } })
    }
    if (url.pathname === '/api/open/llm/chat/completions') {
      const content = await state.llm(JSON.parse(await readBody(req)))
      if (content === undefined) return json(res, 503, { error: { message: '模型不可用' } })
      return json(res, 200, { choices: [{ message: { role: 'assistant', content } }] })
    }
    if (url.pathname === '/api/open/notify') {
      state.notifications.push(JSON.parse(await readBody(req)))
      return json(res, 200, { code: 0, data: { sent: [], skipped: [] } })
    }
    if (url.pathname === '/api/open/events') {
      state.events.push(...JSON.parse(await readBody(req)).events)
      return json(res, 200, { code: 0, data: {} })
    }
    json(res, 404, { code: 404, message: 'not found' })
  })

  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      resolve({ state, url: `http://127.0.0.1:${server.address().port}`, port: server.address().port, close: () => new Promise((r) => { server.closeAllConnections(); server.close(r) }) })
    })
  })
}
