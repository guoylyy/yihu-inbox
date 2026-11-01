// 收件箱：个人待办 + 团队派单。入口只做接线，先监听再连库，/health 才能如实反映启动状态
import { Workspace } from './yh-one.mjs'
import { createApp } from './app.js'
import { createPool, ensureSchema } from './db.js'
import { createTasks } from './tasks.js'
import { createSettings } from './settings.js'
import { createPlatformUsers } from './platform-users.js'
import { startDigest } from './digest.js'
import { VERSION } from './version.js'

const RETRY_MS = 3000

const ws = new Workspace()
const url = process.env.DATABASE_URL
const pool = url ? createPool(url) : null
let ready = false

const app = createApp({
  ws,
  pool,
  getReady: () => ready,
  parseTimeoutMs: Number(process.env.INBOX_PARSE_TIMEOUT_MS) || undefined
})

async function prepare() {
  try {
    await ensureSchema(pool)
    ready = true
    console.log('[inbox] 数据库已就绪')
    startDigest({
      tasks: createTasks({ pool }),
      settings: createSettings({ pool }),
      users: createPlatformUsers({ clientId: ws.clientId, clientSecret: ws.clientSecret, apiUrl: ws.apiUrl }),
      notify: (body) => ws.call('POST', '/api/open/notify', { body, headers: { Authorization: ws.basic() } }),
      url: ws.appUrl ? `${ws.appUrl}/` : ''
    })
  } catch (e) {
    console.error(`[inbox] 连不上数据库，${RETRY_MS / 1000} 秒后重试：${e.message}`)
    setTimeout(prepare, RETRY_MS)
  }
}

const port = Number(process.env.PORT) || 3000
app.listen(port, () => {
  console.log(`[inbox] v${VERSION} listening on :${port}`)
  if (pool) prepare()
  else console.warn('[inbox] 没有 DATABASE_URL，只提供 /health')
})
