// 起一个完整实例：真实 MySQL + 真实 SDK + 假平台。login(id) 走真实的 SSO 跳转
import { Workspace } from '../../src/yh-one.mjs'
import { createApp } from '../../src/app.js'
import { createPool, ensureSchema } from '../../src/db.js'
import { startFakePlatform } from './fake-platform.mjs'

export async function startHarness({ parseTimeoutMs = 300, keepData = false, people } = {}) {
  const pool = createPool(process.env.TEST_DATABASE_URL)
  await ensureSchema(pool)
  if (!keepData) {
    await pool.query('DELETE FROM inbox_event')
    await pool.query('DELETE FROM inbox_task')
  }
  const platform = await startFakePlatform({ people })
  const ws = new Workspace({ clientId: 'cid', clientSecret: 'secret', apiUrl: platform.url, webUrl: platform.url, appUrl: 'http://placeholder', basePath: '' })
  const app = createApp({ ws, pool, parseTimeoutMs })
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)) })
  const base = `http://127.0.0.1:${server.address().port}`
  ws.appUrl = base

  async function login(userId) {
    platform.state.loginAs = userId
    const first = await fetch(`${base}/`, { redirect: 'manual' })
    const cookie = first.headers.get('set-cookie').split(';')[0]
    const auth = await fetch(first.headers.get('location'), { redirect: 'manual' })
    const back = await fetch(auth.headers.get('location'), { redirect: 'manual', headers: { cookie } })
    if (back.status !== 302) throw new Error(`登录失败 ${back.status}`)
    return client(cookie)
  }

  function client(cookie) {
    const call = async (method, path, body, extra = {}) => {
      const r = await fetch(base + path, {
        method,
        headers: { cookie, ...extra, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        redirect: 'manual'
      })
      const text = await r.text()
      let json = null
      try { json = JSON.parse(text) } catch { /* HTML */ }
      return { status: r.status, json, text, headers: r.headers }
    }
    return {
      get: (p, headers) => call('GET', p, undefined, headers),
      post: (p, b = {}) => call('POST', p, b),
      put: (p, b = {}) => call('PUT', p, b),
      patch: (p, b = {}) => call('PATCH', p, b)
    }
  }

  const mcp = async (method, params, token) => {
    const r = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
    })
    return { status: r.status, json: await r.json().catch(() => null) }
  }

  const close = async () => {
    server.closeAllConnections()
    await new Promise((r) => server.close(r))
    await platform.close()
    await pool.end()
  }

  return { base, ws, pool, platform, login, client, mcp, close }
}
