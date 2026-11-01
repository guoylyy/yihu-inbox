// 门槛 5：用真实平台模型解析验收句并落库，打印解析 JSON、平台用户匹配结果和最终记录。凭证只从环境变量读，不打印
//   YH_CLIENT_ID=… YH_CLIENT_SECRET=… YH_API_URL=<平台地址> DATABASE_URL=mysql://…/临时库 node scripts/real-model.mjs
import { Workspace } from '../src/yh-one.mjs'
import { createPool, ensureSchema } from '../src/db.js'
import { createTasks } from '../src/tasks.js'
import { parseQuickInput } from '../src/parse.js'
import { createPlatformUsers, matchAssignee } from '../src/platform-users.js'
import { todayIn, tzName } from '../src/dates.js'

const SENTENCE = process.argv[2] || '明天下午三点前把合同发给张三，重要'
const missing = ['YH_CLIENT_ID', 'YH_CLIENT_SECRET', 'YH_API_URL', 'DATABASE_URL'].filter((k) => !process.env[k])
if (missing.length) {
  console.error(`缺少环境变量：${missing.join('、')}`)
  process.exit(2)
}

const ws = new Workspace()
let raw = null
const llm = async (opts) => {
  const r = await ws.llm(opts)
  raw = r?.choices?.[0]?.message?.content ?? null
  return r
}
const pool = createPool(process.env.DATABASE_URL)
await ensureSchema(pool)
const parsed = await parseQuickInput(SENTENCE, { llm, today: todayIn(), tz: tzName(), timeoutMs: 30_000 })
console.log('模型原始回复：', raw)
console.log('解析结果：', JSON.stringify(parsed))
if (parsed.assignee) {
  const users = await createPlatformUsers({ clientId: ws.clientId, clientSecret: ws.clientSecret, apiUrl: ws.apiUrl }).all()
  const { status, user, candidates } = matchAssignee(users.filter((u) => u.active), parsed.assignee)
  const brief = (u) => u && { id: u.id, name: u.name, dept: u.dept }
  console.log('平台用户匹配：', JSON.stringify({ status, user: brief(user), candidates: candidates.map(brief) }))
}
const { task, duplicate } = await createTasks({ pool }).create(1, parsed, { source: 'self', dedupe: true })
console.log('最终记录：', JSON.stringify({ ...task, duplicate }))
await pool.end()
process.exit(parsed.parsed ? 0 : 1)
