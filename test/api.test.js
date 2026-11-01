import test, { after, before, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { startHarness } from './support/harness.js'
import { createApp } from '../src/app.js'
import { Workspace } from '../src/yh-one.mjs'
import { addDays, endOfWeek, todayIn } from '../src/dates.js'
import { VERSION } from '../src/version.js'

const ALICE = 11
const BOB = 12
const CAROL = 13

let h, alice, bob, carol
const today = todayIn()

before(async () => {
  h = await startHarness()
  alice = await h.login(ALICE)
  bob = await h.login(BOB)
  carol = await h.login(CAROL)
})
after(() => h.close())
beforeEach(async () => {
  await h.pool.query('DELETE FROM inbox_event')
  await h.pool.query('DELETE FROM inbox_task')
  h.platform.state.notifications.length = 0
  h.platform.state.llm = () => JSON.stringify({ title: '默认任务', due_date: null, due_time: null, priority: 0 })
})

const create = async (who, body) => {
  const r = await who.post('/api/tasks', { title: '任务', ...body })
  assert.equal(r.status, 201, r.text)
  return r.json
}
const ids = async (who, view) => (await who.get(`/api/tasks?view=${view}`)).json.list.map((t) => t.id)

// ---------- 健康检查与页面 ----------
test('/health 免登录，返回规定格式', async () => {
  const r = await fetch(`${h.base}/health`)
  assert.equal(r.status, 200)
  assert.deepEqual(await r.json(), { status: 'ok', version: '0.2.2' })
})

test('版本号三处一致：清单、package.json、页面', async () => {
  const pkg = JSON.parse(await (await import('node:fs/promises')).readFile('package.json', 'utf8'))
  assert.equal(pkg.version, VERSION)
  const page = await alice.get('/')
  assert.match(page.text, new RegExp(`id="version">v${VERSION}<`))
})

test('页面带规定的 viewport，地址都是相对路径', async () => {
  const { text } = await alice.get('/')
  assert.ok(text.includes('<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">'))
  assert.ok(!/(?:href|src)="\/[^/]/.test(text.replace(/<base[^>]*>/, '')))
})

test('平台转发时 <base> 带上路径前缀', async () => {
  assert.match((await alice.get('/')).text, /<base href="\/">/)
  const r = await alice.get('/', { 'x-forwarded-prefix': '/apps/inbox' })
  assert.match(r.text, /<base href="\/apps\/inbox\/">/)
})

test('未登录：页面跳平台授权，接口 401', async () => {
  const page = await fetch(`${h.base}/`, { redirect: 'manual' })
  assert.equal(page.status, 302)
  assert.match(page.headers.get('location'), /\/sso\/authorize/)
  const api = await fetch(`${h.base}/api/tasks`)
  assert.equal(api.status, 401)
})

// ---------- 录入 ----------
test('解析接口：模型正常时返回结构化结果', async () => {
  h.platform.state.llm = () => JSON.stringify({ title: '把合同发给张三', due_date: addDays(today, 1), due_time: '15:00', priority: 3 })
  const r = await alice.post('/api/parse', { text: '明天下午三点前把合同发给张三，重要' })
  assert.equal(r.status, 200)
  assert.deepEqual(r.json, { title: '把合同发给张三', due_date: addDays(today, 1), priority: 3, note: '截止 15:00', assignee: null, parsed: true, match: null })
})

test('解析接口不落库：提交前可编辑，确认后才存', async () => {
  await alice.post('/api/parse', { text: '买牛奶' })
  assert.deepEqual(await ids(alice, 'open'), [])
  const t = await create(alice, { title: '买牛奶（改过）', due_date: today, priority: 1 })
  assert.equal(t.title, '买牛奶（改过）')
})

test('解析接口：平台模型 503 时整句进标题，HTTP 仍是 200', async () => {
  h.platform.state.llm = () => undefined
  const r = await alice.post('/api/parse', { text: '随便一句话' })
  assert.equal(r.status, 200)
  assert.deepEqual(r.json, { title: '随便一句话', due_date: null, priority: 0, note: null, assignee: null, parsed: false, match: null })
})

test('解析接口：模型超时不阻塞录入', async () => {
  h.platform.state.llm = () => new Promise((r) => setTimeout(() => r('{}'), 800))
  const started = Date.now()
  const r = await alice.post('/api/parse', { text: '慢模型' })
  assert.equal(r.json.title, '慢模型')
  assert.equal(r.json.parsed, false)
  assert.ok(Date.now() - started < 700)
})

test('解析接口：空内容 400', async () => {
  assert.equal((await alice.post('/api/parse', { text: '  ' })).status, 400)
})

test('创建校验：标题空、日期错、优先级越界都 400', async () => {
  assert.equal((await alice.post('/api/tasks', { title: '   ' })).status, 400)
  assert.equal((await alice.post('/api/tasks', { title: 'x', due_date: '2026-13-01' })).status, 400)
  assert.equal((await alice.post('/api/tasks', { title: 'x', priority: 4 })).status, 400)
  assert.equal((await alice.post('/api/tasks', { title: 'x'.repeat(501) })).status, 400)
})

test('SQL 参数化：标题和备注带引号、分号、注释都原样存取', async () => {
  const evil = `it's "x"; drop table inbox_task; -- '`
  const t = await create(alice, { title: evil, note: evil })
  assert.equal(t.title, evil)
  const back = await alice.get(`/api/tasks/${t.id}`)
  assert.equal(back.json.title, evil)
  assert.equal(back.json.note, evil)
  const [[row]] = await h.pool.query('SELECT COUNT(*) AS n FROM inbox_task')
  assert.equal(row.n, 1)
})

test('SQL 参数化：改标题、指派、查询参数带引号都不报错', async () => {
  const t = await create(alice, {})
  const evil = `' OR '1'='1`
  assert.equal((await alice.patch(`/api/tasks/${t.id}`, { title: evil })).status, 200)
  assert.equal((await alice.get(`/api/tasks?view=${encodeURIComponent(evil)}`)).status, 400)
  assert.equal((await alice.get(`/api/tasks/${encodeURIComponent(`${t.id}' OR '1'='1`)}`)).status, 404)
  assert.equal((await alice.put(`/api/tasks/${t.id}/assignee`, { assignee_id: evil })).status, 400)
})

test('页面转义标题，脚本不会执行', async () => {
  await create(alice, { title: '<script>alert(1)</script>', due_date: today })
  const { text } = await alice.get('/api/list.html?view=today')
  assert.ok(!text.includes('<script>alert'))
  assert.ok(text.includes('&lt;script&gt;'))
})

test('emoji 和长中文标题能存', async () => {
  const title = '🧾'.repeat(10) + '很长的中文标题'.repeat(60)
  const t = await create(alice, { title })
  assert.equal(t.title, title)
})

test('任务记下来源和空标签', async () => {
  const t = await create(alice, {})
  const [[row]] = await h.pool.query('SELECT source, tags, status FROM inbox_task WHERE id = ?', [t.id])
  assert.equal(row.source, 'self')
  assert.deepEqual(row.tags, [])
  assert.equal(row.status, 'open')
})

// ---------- 视图 ----------
test('今天视图：今天到期 + 已逾期，不含未来和无日期', async () => {
  const late = await create(alice, { due_date: addDays(today, -2) })
  const now = await create(alice, { due_date: today })
  await create(alice, { due_date: addDays(today, 1) })
  await create(alice, {})
  assert.deepEqual(await ids(alice, 'today'), [late.id, now.id])
})

test('逾期文案带红色标记', async () => {
  await create(alice, { due_date: addDays(today, -2) })
  const { text } = await alice.get('/api/list.html?view=today')
  assert.match(text, /class="late">逾期 2 天/)
})

test('本周视图截到本周日，全部视图含无日期，已完成单独一栏', async () => {
  const inWeek = await create(alice, { due_date: endOfWeek(today) })
  const next = await create(alice, { due_date: addDays(endOfWeek(today), 1) })
  const none = await create(alice, {})
  const gone = await create(alice, { due_date: today })
  await alice.put(`/api/tasks/${gone.id}/status`, { status: 'done' })
  assert.deepEqual(await ids(alice, 'week'), [inWeek.id])
  assert.deepEqual((await ids(alice, 'open')).sort(), [inWeek.id, next.id, none.id].sort())
  assert.deepEqual(await ids(alice, 'done'), [gone.id])
})

test('列表空态：一句说明 + 一个示例', async () => {
  const { text } = await alice.get('/api/list.html?view=today')
  assert.match(text, /今天没有要做的 —— 上面记一条，或导入会议待办/)
  assert.match(text, /<a class="more" href="import">导入<\/a>/)
  assert.ok(!text.includes('data-example'))
})

test('完成和重开：done_at 跟着变', async () => {
  const t = await create(alice, {})
  await alice.put(`/api/tasks/${t.id}/status`, { status: 'done' })
  let [[row]] = await h.pool.query('SELECT done_at FROM inbox_task WHERE id = ?', [t.id])
  assert.ok(Math.abs(row.done_at.getTime() - Date.now()) < 60_000, 'done_at 按 UTC 存取')
  await alice.put(`/api/tasks/${t.id}/status`, { status: 'open' })
  ;[[row]] = await h.pool.query('SELECT done_at FROM inbox_task WHERE id = ?', [t.id])
  assert.equal(row.done_at, null)
})

test('状态值非法 400', async () => {
  const t = await create(alice, {})
  assert.equal((await alice.put(`/api/tasks/${t.id}/status`, { status: 'closed' })).status, 400)
})

test('日期不被时区挪动：存什么取什么', async () => {
  const t = await create(alice, { due_date: '2026-11-03' })
  assert.equal((await alice.get(`/api/tasks/${t.id}`)).json.due_date, '2026-11-03')
})

// ---------- 权限 ----------
test('A 的任务 B 在所有视图都看不到', async () => {
  const t = await create(alice, { due_date: today })
  for (const v of ['today', 'week', 'open']) assert.ok(!(await ids(bob, v)).includes(t.id))
  assert.ok(!(await bob.get('/api/list.html?view=open')).text.includes('data-id'))
})

test('B 按 id 直接读、改、完成、指派 A 的任务：一律 404，数据没变', async () => {
  const t = await create(alice, { title: '原标题' })
  assert.equal((await bob.get(`/api/tasks/${t.id}`)).status, 404)
  assert.equal((await bob.patch(`/api/tasks/${t.id}`, { title: '被改了' })).status, 404)
  assert.equal((await bob.put(`/api/tasks/${t.id}/status`, { status: 'done' })).status, 404)
  assert.equal((await bob.put(`/api/tasks/${t.id}/assignee`, { assignee_id: BOB })).status, 404)
  const back = (await alice.get(`/api/tasks/${t.id}`)).json
  assert.equal(back.title, '原标题')
  assert.equal(back.status, 'open')
  assert.equal(back.assignee_id, null)
})

test('请求体里塞 owner_id 改不了归属', async () => {
  const t = await create(alice, { owner_id: BOB })
  assert.equal((await bob.get(`/api/tasks/${t.id}`)).status, 404)
  await alice.patch(`/api/tasks/${t.id}`, { owner_id: BOB, status: 'done' })
  assert.equal((await bob.get(`/api/tasks/${t.id}`)).status, 404)
  assert.equal((await alice.get(`/api/tasks/${t.id}`)).json.status, 'open')
})

test('不存在的 id 和非数字 id：404', async () => {
  assert.equal((await alice.get('/api/tasks/999999')).status, 404)
  assert.equal((await alice.get('/api/tasks/abc')).status, 404)
})

test('被指派人只能完成，改内容和改指派都 403', async () => {
  const t = await create(alice, { assignee_id: BOB })
  assert.equal((await bob.patch(`/api/tasks/${t.id}`, { title: '改' })).status, 403)
  assert.equal((await bob.put(`/api/tasks/${t.id}/assignee`, { assignee_id: CAROL })).status, 403)
})

test('改派后原被指派人立刻失去访问', async () => {
  const t = await create(alice, { assignee_id: BOB })
  assert.equal((await alice.put(`/api/tasks/${t.id}/assignee`, { assignee_id: CAROL })).status, 200)
  assert.equal((await bob.get(`/api/tasks/${t.id}`)).status, 404)
  assert.equal((await carol.get(`/api/tasks/${t.id}`)).status, 200)
})

// ---------- 指派 ----------
test('指派后出现在被指派人的列表，并收到通知', async () => {
  const t = await create(alice, { due_date: today })
  const r = await alice.put(`/api/tasks/${t.id}/assignee`, { assignee_id: BOB })
  assert.equal(r.status, 200)
  assert.equal(r.json.assignee, '李雷')
  assert.deepEqual(await ids(bob, 'today'), [t.id])
  const { text } = await bob.get('/api/list.html?view=today')
  assert.match(text, /来自 王小明/)
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.deepEqual(h.platform.state.notifications.map((n) => n.userIds), [[BOB]])
})

test('被指派人完成后双方状态一致', async () => {
  const t = await create(alice, { assignee_id: BOB, due_date: today })
  assert.equal((await bob.put(`/api/tasks/${t.id}/status`, { status: 'done' })).status, 200)
  assert.equal((await alice.get(`/api/tasks/${t.id}`)).json.status, 'done')
  assert.deepEqual(await ids(alice, 'done'), [t.id])
  assert.deepEqual(await ids(bob, 'done'), [t.id])
  assert.deepEqual(await ids(alice, 'today'), [])
})

test('取消指派：被指派人看不到，不发通知', async () => {
  const t = await create(alice, { assignee_id: BOB })
  await new Promise((resolve) => setTimeout(resolve, 50))
  h.platform.state.notifications.length = 0
  await alice.put(`/api/tasks/${t.id}/assignee`, { assignee_id: null })
  assert.equal((await bob.get(`/api/tasks/${t.id}`)).status, 404)
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.equal(h.platform.state.notifications.length, 0)
})

test('指派给平台上没有的人 400，指派给自己等于不指派', async () => {
  const t = await create(alice, {})
  assert.equal((await alice.put(`/api/tasks/${t.id}/assignee`, { assignee_id: 9999 })).status, 400)
  const self = await alice.put(`/api/tasks/${t.id}/assignee`, { assignee_id: ALICE })
  assert.equal(self.json.assignee_id, null)
})

test('用户列表：不含自己和离职的人，不带手机号，支持搜索', async () => {
  const r = await alice.get('/api/users')
  assert.deepEqual(r.json.list.map((u) => u.id), [BOB, CAROL])
  assert.deepEqual(Object.keys(r.json.list[0]).sort(), ['dept', 'id', 'name'])
  assert.deepEqual((await alice.get(`/api/users?q=${encodeURIComponent('法务')}`)).json.list.map((u) => u.name), ['李雷'])
})

test('变更轨迹：创建、指派、完成都有记录，谁做的写清楚', async () => {
  const t = await create(alice, {})
  await alice.put(`/api/tasks/${t.id}/assignee`, { assignee_id: BOB })
  await bob.put(`/api/tasks/${t.id}/status`, { status: 'done' })
  const [rows] = await h.pool.query('SELECT actor_id, action, detail FROM inbox_event WHERE task_id = ? ORDER BY id', [t.id])
  assert.deepEqual(rows.map((r) => [r.actor_id, r.action]), [[ALICE, 'create'], [ALICE, 'assign'], [BOB, 'done']])
  assert.deepEqual(rows[1].detail, { from: null, to: BOB })
})

test('使用数据里没有任务原文', async () => {
  const t = await create(alice, { title: '绝密标题' })
  await alice.put(`/api/tasks/${t.id}/status`, { status: 'done' })
  await h.ws.flush()
  const events = JSON.stringify(h.platform.state.events)
  assert.match(events, /task\.done/)
  assert.ok(!events.includes('绝密标题'))
})

// ---------- MCP ----------
test('MCP：没有 token 或 token 无效一律 401，包括 tools/list', async () => {
  assert.equal((await h.mcp('tools/list', {})).status, 401)
  assert.equal((await h.mcp('tools/call', { name: 'list_tasks', arguments: {} }, 'bad')).status, 401)
})

test('MCP：握手和工具清单；只读工具声明了 readOnlyHint', async () => {
  const init = await h.mcp('initialize', { protocolVersion: '2025-06-18' }, `token-${ALICE}`)
  assert.equal(init.json.result.serverInfo.version, VERSION)
  const { tools } = (await h.mcp('tools/list', {}, `token-${ALICE}`)).json.result
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]))
  assert.equal(byName.list_tasks.annotations.readOnlyHint, true)
  assert.equal(byName.create_task.annotations, undefined)
  assert.ok(!('run' in byName.create_task))
})

test('MCP：create_task 按 token 的用户建，来源 ai，日期宽容', async () => {
  const r = await h.mcp('tools/call', { name: 'create_task', arguments: { title: '买票', due: '明天', priority: '高', note: '要靠窗' } }, `token-${ALICE}`)
  const out = r.json.result.structuredContent
  assert.equal(out.due_date, addDays(today, 1))
  assert.equal(out.priority, 3)
  const [[row]] = await h.pool.query('SELECT owner_id, source, note FROM inbox_task WHERE id = ?', [out.id])
  assert.deepEqual({ ...row }, { owner_id: ALICE, source: 'ai', note: '要靠窗' })
})

test('MCP：list_tasks 只看到自己的，不串到别人', async () => {
  await create(alice, { due_date: today, title: 'A 的' })
  await create(bob, { due_date: today, title: 'B 的' })
  const r = await h.mcp('tools/call', { name: 'list_tasks', arguments: { view: 'today' } }, `token-${BOB}`)
  assert.deepEqual(r.json.result.structuredContent.list.map((t) => t.title), ['B 的'])
})

test('MCP：参数不对返回 isError 和人话', async () => {
  const bad = await h.mcp('tools/call', { name: 'create_task', arguments: { title: '买票', due: '猴年马月' } }, `token-${ALICE}`)
  assert.equal(bad.json.result.isError, true)
  assert.match(bad.json.result.content[0].text, /看不懂截止日期/)
  const none = await h.mcp('tools/call', { name: 'create_task', arguments: {} }, `token-${ALICE}`)
  assert.match(none.json.result.content[0].text, /标题不能为空/)
})

test('MCP：通知类消息回 202，GET 回 405', async () => {
  const r = await fetch(`${h.base}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer token-${ALICE}` },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })
  })
  assert.equal(r.status, 202)
  assert.equal((await fetch(`${h.base}/mcp`)).status, 405)
})

// ---------- 平台故障 ----------
test('生产环境没配平台凭证：绝不退回匿名共用收件箱', async () => {
  const keep = process.env.NODE_ENV
  process.env.NODE_ENV = 'production'
  const app = createApp({ ws: new Workspace({ clientId: '', clientSecret: '', appUrl: '' }), pool: h.pool })
  process.env.NODE_ENV = keep
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)) })
  const base = `http://127.0.0.1:${server.address().port}`
  assert.equal((await fetch(`${base}/api/tasks`)).status, 503)
  assert.equal((await fetch(`${base}/`)).status, 503)
  const mcp = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' })
  assert.equal(mcp.status, 401)
  server.closeAllConnections()
  await new Promise((r) => server.close(r))
})

test('平台用户接口挂了：选人给人话，指派 503，列表仍能打开', async () => {
  const t = await create(alice, { assignee_id: BOB, due_date: today })
  const platform = await startDown()
  const users = await platform.alice.get('/api/users')
  assert.equal(users.status, 503)
  assert.match(users.json.error, /平台暂时连不上/)
  assert.equal((await platform.alice.put(`/api/tasks/${t.id}/assignee`, { assignee_id: CAROL })).status, 503)
  const list = await platform.alice.get('/api/list.html?view=today')
  assert.equal(list.status, 200)
  assert.match(list.text, /指派 用户 12/)
  await platform.h.close()
})

test('列表第二行：高优先级在末尾写「· 急」，普通的不写，没有圆点', async () => {
  await create(alice, { title: '高优有日期', due_date: today, priority: 3 })
  await create(alice, { title: '普通', due_date: today, priority: 2 })
  await create(alice, { title: '高优没别的', priority: 3 })
  const { text } = await alice.get('/api/list.html?view=open')
  const row = (title) => text.slice(text.lastIndexOf('<li', text.indexOf(`>${title}<`)), text.indexOf('</li>', text.indexOf(`>${title}<`)))
  assert.match(row('高优有日期'), /<span class="urgent">· 急<\/span>\s*<\/span>/)
  assert.ok(!row('普通').includes('urgent'))
  assert.match(row('高优没别的'), /<span class="urgent">急<\/span>/)
  assert.ok(!text.includes('class="dot'))
})

async function startDown() {
  const other = await startHarness({ keepData: true })
  const a = await other.login(ALICE)
  other.platform.state.usersDown = true
  return { h: other, alice: a }
}
