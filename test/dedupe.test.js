import test, { after, before, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { startHarness } from './support/harness.js'
import { createTasks } from '../src/tasks.js'
import { addDays, todayIn } from '../src/dates.js'

const ALICE = 11
const BOB = 12

let h, alice, bob
const today = todayIn()

before(async () => {
  h = await startHarness()
  alice = await h.login(ALICE)
  bob = await h.login(BOB)
})
after(() => h.close())
beforeEach(async () => {
  await h.pool.query('DELETE FROM inbox_event')
  await h.pool.query('DELETE FROM inbox_task')
  h.platform.state.notifications.length = 0
})

const count = async () => {
  const [[row]] = await h.pool.query('SELECT COUNT(*) AS n FROM inbox_task')
  return row.n
}
const mcpCreate = (args, id = ALICE) => h.mcp('tools/call', { name: 'create_task', arguments: args }, `token-${id}`)

test('同标题 60 秒内两次：只有 1 行，第二次 200 + duplicate，返回已有记录', async () => {
  const first = await alice.post('/api/tasks', { title: '买牛奶' })
  assert.equal(first.status, 201)
  assert.equal(first.json.duplicate, undefined)
  const second = await alice.post('/api/tasks', { title: '买牛奶' })
  assert.equal(second.status, 200)
  assert.equal(second.json.duplicate, true)
  assert.equal(second.json.id, first.json.id)
  assert.equal(await count(), 1)
})

test('重复提交不留痕：事件只有一条 create，也不再通知被指派人', async () => {
  const body = { title: '派单', assignee_id: BOB }
  const first = await alice.post('/api/tasks', body)
  await alice.post('/api/tasks', body)
  await new Promise((resolve) => setTimeout(resolve, 50))
  const [rows] = await h.pool.query('SELECT action FROM inbox_event WHERE task_id = ?', [first.json.id])
  assert.deepEqual(rows.map((r) => r.action), ['create'])
  assert.equal(h.platform.state.notifications.length, 1)
})

test('标题前后空格 trim 后再比', async () => {
  await alice.post('/api/tasks', { title: '买牛奶' })
  assert.equal((await alice.post('/api/tasks', { title: '  买牛奶\n' })).json.duplicate, true)
  assert.equal(await count(), 1)
})

test('逐字比较：大小写、重音、包含关系都算不同', async () => {
  for (const title of ['Call Bob', 'call bob', 'café', 'cafe', '买牛奶', '买牛奶和面包']) {
    assert.equal((await alice.post('/api/tasks', { title })).status, 201, title)
  }
  assert.equal(await count(), 6)
})

test('截止日不同算不同；都没日期算相同', async () => {
  assert.equal((await alice.post('/api/tasks', { title: '周报', due_date: today })).status, 201)
  assert.equal((await alice.post('/api/tasks', { title: '周报', due_date: addDays(today, 1) })).status, 201)
  assert.equal((await alice.post('/api/tasks', { title: '周报' })).status, 201)
  assert.equal((await alice.post('/api/tasks', { title: '周报' })).status, 200)
  assert.equal((await alice.post('/api/tasks', { title: '周报', due_date: today })).status, 200)
  assert.equal(await count(), 3)
})

test('已完成的不算重复：做完马上再记一条是新任务', async () => {
  const first = await alice.post('/api/tasks', { title: '浇花' })
  await alice.put(`/api/tasks/${first.json.id}/status`, { status: 'done' })
  assert.equal((await alice.post('/api/tasks', { title: '浇花' })).status, 201)
  assert.equal(await count(), 2)
})

test('不同用户同标题：2 行', async () => {
  assert.equal((await alice.post('/api/tasks', { title: '买牛奶' })).status, 201)
  assert.equal((await bob.post('/api/tasks', { title: '买牛奶' })).status, 201)
  assert.equal(await count(), 2)
})

test('间隔超过 60 秒（注入时钟）：2 行；正好 60 秒还算重复', async () => {
  let clock = Date.UTC(2026, 9, 30, 8, 0, 0)
  const tasks = createTasks({ pool: h.pool, now: () => clock })
  const first = await tasks.create(ALICE, { title: '买牛奶' })
  assert.equal(first.duplicate, false)
  clock += 59_000
  assert.equal((await tasks.create(ALICE, { title: '买牛奶' })).duplicate, true)
  clock += 1_000
  assert.equal((await tasks.create(ALICE, { title: '买牛奶' })).duplicate, true)
  clock += 1_000
  const later = await tasks.create(ALICE, { title: '买牛奶' })
  assert.equal(later.duplicate, false)
  assert.notEqual(later.task.id, first.task.id)
  assert.equal(await count(), 2)
})

test('窗口从第一条算，重复提交不续期', async () => {
  let clock = Date.UTC(2026, 9, 30, 8, 0, 0)
  const tasks = createTasks({ pool: h.pool, now: () => clock })
  await tasks.create(ALICE, { title: '买牛奶' })
  clock += 40_000
  await tasks.create(ALICE, { title: '买牛奶' })
  clock += 40_000
  assert.equal((await tasks.create(ALICE, { title: '买牛奶' })).duplicate, false)
})

test('并发两次同标题：库里只有 1 行', async () => {
  for (let round = 0; round < 20; round++) {
    await h.pool.query('DELETE FROM inbox_event')
    await h.pool.query('DELETE FROM inbox_task')
    const rs = await Promise.all([alice.post('/api/tasks', { title: '并发' }), alice.post('/api/tasks', { title: '并发' })])
    assert.deepEqual(rs.map((r) => r.status).sort(), [200, 201], rs.map((r) => r.text).join(' | '))
    assert.equal(rs[0].json.id, rs[1].json.id)
    assert.equal(await count(), 1)
  }
})

test('网页和 MCP 一起并发十几次：还是 1 行，所有人拿到同一条', async () => {
  const rs = await Promise.all(Array.from({ length: 16 }, (_, i) => (i % 2 ? alice.post('/api/tasks', { title: '狂点' }) : mcpCreate({ title: '狂点' }))))
  const taskIds = new Set(rs.map((r) => (r.json.result ? r.json.result.structuredContent.id : r.json.id)))
  assert.equal(taskIds.size, 1, JSON.stringify(rs.map((r) => r.json)))
  assert.equal(await count(), 1)
})

test('并发不同标题互不影响：一条都不丢', async () => {
  const rs = await Promise.all(Array.from({ length: 12 }, (_, i) => alice.post('/api/tasks', { title: `第 ${i} 件` })))
  assert.deepEqual([...new Set(rs.map((r) => r.status))], [201], rs.map((r) => r.text).join(' | '))
  assert.equal(await count(), 12)
})

test('MCP：create_task 走同一条路径，第二次带 duplicate', async () => {
  const first = (await mcpCreate({ title: '买票', due: '明天' })).json.result.structuredContent
  assert.equal(first.duplicate, undefined)
  const second = (await mcpCreate({ title: ' 买票 ', due: '明天' })).json.result.structuredContent
  assert.equal(second.duplicate, true)
  assert.equal(second.id, first.id)
  assert.equal(await count(), 1)
})

test('网页记过的 MCP 再记也算重复', async () => {
  const first = await alice.post('/api/tasks', { title: '买票' })
  const second = (await mcpCreate({ title: '买票' })).json.result.structuredContent
  assert.equal(second.duplicate, true)
  assert.equal(second.id, first.json.id)
})
