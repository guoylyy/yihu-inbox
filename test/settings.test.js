import test, { after, before, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { startHarness } from './support/harness.js'
import { createTasks } from '../src/tasks.js'
import { createSettings, DEDUPE_RULE, DEFAULTS, defaultDue } from '../src/settings.js'
import { pushTick } from '../src/digest.js'
import { addDays, todayIn } from '../src/dates.js'
import { VERSION } from '../src/version.js'

const ALICE = 11
const BOB = 12
const today = todayIn()
const RULE = '只有 AI / 快捷入口会去重（60 秒内同标题、同指派、同日期）；你在表单里手动添加的每一条都会保留'

let h, alice, bob, tasks, settings

before(async () => {
  h = await startHarness()
  alice = await h.login(ALICE)
  bob = await h.login(BOB)
  tasks = createTasks({ pool: h.pool })
  settings = createSettings({ pool: h.pool })
})
after(() => h.close())
beforeEach(async () => {
  for (const t of ['inbox_event', 'inbox_task', 'inbox_setting', 'inbox_push_log']) await h.pool.query(`DELETE FROM ${t}`)
  h.platform.state.notifications.length = 0
  h.platform.state.models = [{ id: 'gpt-x', name: '测试模型', default: true }]
  h.platform.state.llm = () => JSON.stringify({ title: '买牛奶', due_date: null, due_time: null, priority: 0, assignee: null })
})

test('设置：没存过时是默认值', async () => {
  assert.deepEqual((await alice.get('/api/settings')).json, DEFAULTS)
  assert.deepEqual(DEFAULTS, { default_assignee_id: null, digest_time: '08:00', notify_assignee: true, weekly_push: false, quick_due: 'none' })
})

test('设置持久化：五项一项项存，互不覆盖，重新读还在', async () => {
  await alice.put('/api/settings', { default_assignee_id: BOB })
  await alice.put('/api/settings', { digest_time: '18:00' })
  await alice.put('/api/settings', { notify_assignee: false })
  await alice.put('/api/settings', { weekly_push: true })
  await alice.put('/api/settings', { quick_due: 'tomorrow' })
  assert.deepEqual((await alice.get('/api/settings')).json, { default_assignee_id: BOB, digest_time: '18:00', notify_assignee: false, weekly_push: true, quick_due: 'tomorrow' })
  assert.deepEqual(await createSettings({ pool: h.pool }).get(ALICE), { default_assignee_id: BOB, digest_time: '18:00', notify_assignee: false, weekly_push: true, quick_due: 'tomorrow' })
})

test('设置：摘要时间可选 08:00、09:00、18:00、关闭', async () => {
  for (const v of ['08:00', '09:00', '18:00', 'off']) assert.equal((await alice.put('/api/settings', { digest_time: v })).json.digest_time, v)
})

test('设置：每人一份', async () => {
  await alice.put('/api/settings', { digest_time: 'off' })
  assert.equal((await bob.get('/api/settings')).json.digest_time, '08:00')
})

test('设置：不合法的值 400，原值不变', async () => {
  await alice.put('/api/settings', { digest_time: '09:00' })
  for (const body of [{ digest_time: '07:00' }, { quick_due: 'someday' }, { weekly_push: 'yes' }, { notify_assignee: 1 }, { default_assignee_id: 9999 }, { default_assignee_id: 'x' }]) {
    assert.equal((await alice.put('/api/settings', body)).status, 400, JSON.stringify(body))
  }
  assert.equal((await alice.get('/api/settings')).json.digest_time, '09:00')
})

test('设置：默认指派选自己等于不指派；可以清掉', async () => {
  assert.equal((await alice.put('/api/settings', { default_assignee_id: ALICE })).json.default_assignee_id, null)
  await alice.put('/api/settings', { default_assignee_id: BOB })
  assert.equal((await alice.put('/api/settings', { default_assignee_id: null })).json.default_assignee_id, null)
})

test('默认截止：今天、明天、无', () => {
  assert.equal(defaultDue('today', '2026-10-31'), '2026-10-31')
  assert.equal(defaultDue('tomorrow', '2026-10-31'), '2026-11-01')
  assert.equal(defaultDue('none', '2026-10-31'), null)
})

test('快捷录入：没提时间用默认截止，并标出来；提了时间不覆盖', async () => {
  await alice.put('/api/settings', { quick_due: 'tomorrow' })
  const r = await alice.post('/api/parse', { text: '买牛奶' })
  assert.equal(r.json.due_date, addDays(today, 1))
  assert.equal(r.json.due_defaulted, true)
  h.platform.state.llm = () => JSON.stringify({ title: '买牛奶', due_date: today, due_time: null, priority: 0, assignee: null })
  const s = await alice.post('/api/parse', { text: '今天买牛奶' })
  assert.equal(s.json.due_date, today)
  assert.equal(s.json.due_defaulted, undefined)
})

test('快捷录入：模型挂了也用默认截止', async () => {
  await alice.put('/api/settings', { quick_due: 'today' })
  h.platform.state.llm = () => undefined
  const r = await alice.post('/api/parse', { text: '买牛奶' })
  assert.equal(r.json.parsed, false)
  assert.equal(r.json.due_date, today)
})

test('快捷录入：只预填，不写库', async () => {
  await alice.put('/api/settings', { quick_due: 'today', default_assignee_id: BOB })
  await alice.post('/api/parse', { text: '买牛奶' })
  const [[{ n }]] = await h.pool.query('SELECT COUNT(*) AS n FROM inbox_task')
  assert.equal(n, 0)
})

test('默认指派：话里没提人时预填', async () => {
  await alice.put('/api/settings', { default_assignee_id: BOB })
  const r = await alice.post('/api/parse', { text: '买牛奶' })
  assert.deepEqual(r.json.default_assignee, { id: BOB, name: '李雷' })
})

test('默认指派：话里提了人但没认出来，不拿默认值顶替', async () => {
  await alice.put('/api/settings', { default_assignee_id: BOB })
  h.platform.state.llm = () => JSON.stringify({ title: '买牛奶', due_date: null, due_time: null, priority: 0, assignee: '赵六' })
  const r = await alice.post('/api/parse', { text: '让赵六买牛奶' })
  assert.equal(r.json.default_assignee, undefined)
})

test('默认指派的人离开平台后，设置页说明白，不再预填', async () => {
  await h.pool.query("INSERT INTO inbox_setting (user_id, default_assignee_id) VALUES (?, 14)", [ALICE])
  assert.match((await alice.get('/settings')).text, /已不在平台上/)
  assert.equal((await alice.post('/api/parse', { text: '买牛奶' })).json.default_assignee, undefined)
})

test('MCP 不受默认指派、默认截止影响，工具名和参数不变', async () => {
  await alice.put('/api/settings', { default_assignee_id: BOB, quick_due: 'today' })
  const r = await h.mcp('tools/call', { name: 'create_task', arguments: { title: 'AI 记的' } }, `token-${ALICE}`)
  assert.equal(r.json.result.structuredContent.due_date, null)
  const [[row]] = await h.pool.query("SELECT assignee_id FROM inbox_task WHERE title = 'AI 记的'")
  assert.equal(row.assignee_id, null)
  const list = await h.mcp('tools/list', {}, `token-${ALICE}`)
  assert.deepEqual(list.json.result.tools.map((t) => t.name), ['create_task', 'list_tasks'])
  assert.deepEqual(Object.keys(list.json.result.tools[0].inputSchema.properties), ['title', 'due', 'priority', 'note'])
  assert.deepEqual(Object.keys(list.json.result.tools[1].inputSchema.properties), ['view', 'limit'])
})

test('@ 到人：开着时单条指派发通知', async () => {
  await alice.post('/api/tasks', { title: '派单', assignee_id: BOB })
  await new Promise((r) => setTimeout(r, 30))
  assert.equal(h.platform.state.notifications.length, 1)
})

test('@ 到人：关掉后事情照派，不发通知', async () => {
  await alice.put('/api/settings', { notify_assignee: false })
  const r = await alice.post('/api/tasks', { title: '派单', assignee_id: BOB })
  assert.equal(r.json.assignee_id, BOB)
  await alice.post('/api/import/commit', { rows: [{ title: '导入派单', assignee_id: BOB }] })
  await new Promise((res) => setTimeout(res, 30))
  assert.equal(h.platform.state.notifications.length, 0)
})

const deps = (sent) => ({ tasks, settings, users: { names: async () => new Map() }, notify: async (m) => sent.push(m), url: 'http://x/' })
const at = (hour, day = '2026-10-29') => new Date(`${day}T${String(hour).padStart(2, '0')}:05:00+08:00`)

test('每日摘要：按每人选的时间发，真的是整点那一小时', async () => {
  const due = '2026-10-29'
  await tasks.create(ALICE, { title: 'Alice 的', due_date: due })
  await tasks.create(BOB, { title: 'Bob 的', due_date: due })
  await settings.save(BOB, { digest_time: '09:00' })
  const sent = []
  await pushTick({ ...deps(sent), now: at(8) })
  assert.deepEqual(sent.map((m) => m.userIds), [[ALICE]])
  await pushTick({ ...deps(sent), now: at(9) })
  assert.deepEqual(sent.map((m) => m.userIds), [[ALICE], [BOB]])
})

test('每日摘要：关闭的不发；不是摘要时段不发', async () => {
  await tasks.create(ALICE, { title: 'Alice 的', due_date: '2026-10-29' })
  await settings.save(ALICE, { digest_time: 'off' })
  const sent = []
  for (const hour of [7, 8, 9, 18, 19]) await pushTick({ ...deps(sent), now: at(hour) })
  assert.deepEqual(sent, [])
})

test('每日摘要：同一轮只发一次，每分钟醒、重启都不重发', async () => {
  await tasks.create(ALICE, { title: 'Alice 的', due_date: '2026-10-29' })
  const sent = []
  await pushTick({ ...deps(sent), now: at(8) })
  await pushTick({ ...deps(sent), now: new Date('2026-10-29T08:06:00+08:00') })
  await pushTick({ ...createNew(sent), now: new Date('2026-10-29T08:30:00+08:00') })
  assert.equal(sent.length, 1)
})

const createNew = (sent) => ({ ...deps(sent), tasks: createTasks({ pool: h.pool }) })

test('周报推送：周五 17 点发给打开的人，别的时间、没打开的人不发', async () => {
  await tasks.create(ALICE, { title: 'Alice 的' })
  await settings.save(ALICE, { weekly_push: true })
  await settings.save(BOB, { weekly_push: false, digest_time: 'off' })
  const sent = []
  await pushTick({ ...deps(sent), now: at(16, '2026-10-30') })
  await pushTick({ ...deps(sent), now: at(17, '2026-10-29') })
  assert.deepEqual(sent, [])
  await pushTick({ ...deps(sent), now: at(17, '2026-10-30') })
  await pushTick({ ...deps(sent), now: at(17, '2026-10-30') })
  assert.deepEqual(sent.map((m) => m.userIds), [[ALICE]])
  assert.match(sent[0].content, /本周周报/)
})

test('设置页：五项都在，去重规则一字不差', async () => {
  assert.equal(DEDUPE_RULE, RULE)
  const { status, text } = await alice.get('/settings')
  assert.equal(status, 200)
  for (const part of ['默认指派对象', '每日摘要时间', '周报周五推送', '指派时 @ 到人', '快捷录入默认截止', '去重规则']) assert.ok(text.includes(part), part)
  assert.ok(text.includes(`id="s-dedupe">${RULE}<`))
  for (const v of ['08:00', '09:00', '18:00', 'off']) assert.ok(text.includes(`value="${v}"`), v)
})

test('设置页：定时推送没开时明说，不假装', async () => {
  assert.match((await alice.get('/settings')).text, /定时推送现在没开/)
  process.env.INBOX_DIGEST = '1'
  try {
    assert.ok(!(await alice.get('/settings')).text.includes('定时推送现在没开'))
  } finally {
    delete process.env.INBOX_DIGEST
  }
})

test('使用说明写了去重规则、批量、导入格式', () => {
  const doc = readFileSync('docs/使用说明.md', 'utf8')
  for (const part of [RULE, '三步上手', '批量整理', '导入格式']) assert.ok(doc.includes(part), part)
})

test('关于：八项都有，不带账号密码', async () => {
  const { json } = await alice.get('/api/about')
  assert.equal(json.version, VERSION)
  assert.equal(json.mode, '平台')
  assert.equal(json.model, '测试模型')
  assert.equal(json.node, process.version)
  assert.equal(json.dependencies, 3)
  assert.match(json.database, /^MySQL /)
  for (const key of ['build_time', 'data_dir']) assert.ok(json[key], key)
  assert.ok(!JSON.stringify(json).includes('root:'))
})

test('关于页：渲染八项', async () => {
  const { status, text } = await alice.get('/about')
  assert.equal(status, 200)
  for (const id of ['a-version', 'a-build', 'a-mode', 'a-data', 'a-db', 'a-model', 'a-node', 'a-deps']) assert.ok(text.includes(`id="${id}"`), id)
})

test('每一页都有顶栏：应用名、版本、设置、关于、退出', async () => {
  for (const path of ['/', '/import', '/settings', '/about']) {
    const { text } = await alice.get(path)
    for (const part of ['class="yh-top"', '收件箱', 'class="yh-top-icon"', 'rel="icon" type="image/svg+xml" href="static/icon.svg', 'href="settings"', 'href="about"', 'href="logout"', 'yh-vi.css']) assert.ok(text.includes(part), `${path} ${part}`)
    assert.match(text, new RegExp(`id="version">v${VERSION}<`), path)
  }
})

test('首页：选择、导入是文字按钮，没有帮助按钮，全选收进下拉，批量四个动作', async () => {
  const { text } = await alice.get('/')
  for (const part of ['class="yh-btn yh-btn--text head-idle" id="select-btn"', 'class="yh-btn yh-btn--text head-idle" id="import-btn"', 'class="pop" id="select-all"', '全选本屏', '全部选中', 'data-batch="more"', 'data-batch="archive"', 'data-batch="delete"']) assert.ok(text.includes(part), part)
  for (const gone of ['help-btn', 'id="help"', '归档删除']) assert.ok(!text.includes(gone), gone)
  const bar = text.slice(text.indexOf('id="batch-actions"'), text.indexOf('id="batch-restore"'))
  assert.equal(bar.match(/data-batch=/g).length, 4)
})

test('设置：使用说明三句话，键盘写在折叠里', async () => {
  const { text } = await alice.get('/settings')
  for (const part of ['id="usage"', '怎么记', '怎么派', '去重规则', '<kbd>j</kbd>', '<kbd>k</kbd>', '<kbd>x</kbd>', '<kbd>Enter</kbd>', '<kbd>e</kbd>']) assert.ok(text.includes(part), part)
  assert.equal(text.match(/class="usage-line"/g).length, 3)
})

test('退出：清会话，转到平台退出页', async () => {
  const c = await h.login(ALICE)
  const r = await c.get('/logout')
  assert.equal(r.status, 302)
  assert.match(r.headers.get('location'), /\/logout/)
})

test('清单、VERSION、package 都是 0.2.2', () => {
  assert.equal(VERSION, '0.2.2')
  assert.equal(readFileSync('VERSION', 'utf8').trim(), '0.2.2')
})
