import test, { after, before, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { startHarness } from './support/harness.js'
import { createTasks } from '../src/tasks.js'
import { addDays, todayIn } from '../src/dates.js'

const ALICE = 11
const BOB = 12
const CAROL = 13
const DEDUPE = { source: 'ai', dedupe: true } // 和 create_task 传的一样

let h, alice, bob, tasks
const today = todayIn()

before(async () => {
  h = await startHarness()
  alice = await h.login(ALICE)
  bob = await h.login(BOB)
  tasks = createTasks({ pool: h.pool })
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
const mcpOut = (r) => r.json.result.structuredContent
const duplicateOf = async (input, id = ALICE) => (await tasks.create(id, input, DEDUPE)).duplicate

test('同标题 60 秒内两次：只有 1 行，第二次 duplicate，返回已有那条的完整对象', async () => {
  const first = await tasks.create(ALICE, { title: '买牛奶' }, DEDUPE)
  assert.equal(first.duplicate, false)
  const second = await tasks.create(ALICE, { title: '买牛奶' }, DEDUPE)
  assert.equal(second.duplicate, true)
  assert.deepEqual(second.task, first.task)
  assert.equal(await count(), 1)
})

test('重复提交不留痕：事件只有一条 create', async () => {
  const body = { title: '派单', assignee_id: BOB }
  const first = await tasks.create(ALICE, body, DEDUPE)
  await tasks.create(ALICE, body, DEDUPE)
  const [rows] = await h.pool.query('SELECT action FROM inbox_event WHERE task_id = ?', [first.task.id])
  assert.deepEqual(rows.map((r) => r.action), ['create'])
})

test('标题前后空格 trim 后再比', async () => {
  await tasks.create(ALICE, { title: '买牛奶' }, DEDUPE)
  assert.equal(await duplicateOf({ title: '  买牛奶\n' }), true)
  assert.equal(await count(), 1)
})

test('逐字比较：大小写、重音、包含关系都算不同', async () => {
  for (const title of ['Call Bob', 'call bob', 'café', 'cafe', '买牛奶', '买牛奶和面包']) {
    assert.equal(await duplicateOf({ title }), false, title)
  }
  assert.equal(await count(), 6)
})

test('截止日不同算不同；都没日期算相同', async () => {
  assert.equal(await duplicateOf({ title: '周报', due_date: today }), false)
  assert.equal(await duplicateOf({ title: '周报', due_date: addDays(today, 1) }), false)
  assert.equal(await duplicateOf({ title: '周报' }), false)
  assert.equal(await duplicateOf({ title: '周报' }), true)
  assert.equal(await duplicateOf({ title: '周报', due_date: today }), true)
  assert.equal(await count(), 3)
})

test('已完成的不算重复：做完马上再记一条是新任务', async () => {
  const first = await tasks.create(ALICE, { title: '浇花' }, DEDUPE)
  await alice.put(`/api/tasks/${first.task.id}/status`, { status: 'done' })
  assert.equal(await duplicateOf({ title: '浇花' }), false)
  assert.equal(await count(), 2)
})

test('不同用户同标题：2 行', async () => {
  assert.equal(await duplicateOf({ title: '买牛奶' }, ALICE), false)
  assert.equal(await duplicateOf({ title: '买牛奶' }, BOB), false)
  assert.equal(await count(), 2)
})

test('间隔超过 60 秒（注入时钟）：2 行；正好 60 秒还算重复', async () => {
  let clock = Date.UTC(2026, 9, 30, 8, 0, 0)
  const tasks = createTasks({ pool: h.pool, now: () => clock })
  const first = await tasks.create(ALICE, { title: '买牛奶' }, DEDUPE)
  assert.equal(first.duplicate, false)
  clock += 59_000
  assert.equal((await tasks.create(ALICE, { title: '买牛奶' }, DEDUPE)).duplicate, true)
  clock += 1_000
  assert.equal((await tasks.create(ALICE, { title: '买牛奶' }, DEDUPE)).duplicate, true)
  clock += 1_000
  const later = await tasks.create(ALICE, { title: '买牛奶' }, DEDUPE)
  assert.equal(later.duplicate, false)
  assert.notEqual(later.task.id, first.task.id)
  assert.equal(await count(), 2)
})

test('窗口从第一条算，重复提交不续期', async () => {
  let clock = Date.UTC(2026, 9, 30, 8, 0, 0)
  const tasks = createTasks({ pool: h.pool, now: () => clock })
  await tasks.create(ALICE, { title: '买牛奶' }, DEDUPE)
  clock += 40_000
  await tasks.create(ALICE, { title: '买牛奶' }, DEDUPE)
  clock += 40_000
  assert.equal((await tasks.create(ALICE, { title: '买牛奶' }, DEDUPE)).duplicate, false)
})

test('并发两次同标题：库里只有 1 行', async () => {
  for (let round = 0; round < 20; round++) {
    await h.pool.query('DELETE FROM inbox_event')
    await h.pool.query('DELETE FROM inbox_task')
    const rs = await Promise.all([mcpCreate({ title: '并发' }), mcpCreate({ title: '并发' })])
    const outs = rs.map(mcpOut)
    assert.deepEqual(outs.map((o) => !!o.duplicate).sort(), [false, true], JSON.stringify(outs))
    assert.equal(outs[0].id, outs[1].id)
    assert.equal(await count(), 1)
  }
})

test('MCP 并发十几次：还是 1 行，所有人拿到同一条', async () => {
  const rs = await Promise.all(Array.from({ length: 16 }, () => mcpCreate({ title: '狂点' })))
  const taskIds = new Set(rs.map((r) => mcpOut(r).id))
  assert.equal(taskIds.size, 1, JSON.stringify(rs.map((r) => r.json)))
  assert.equal(await count(), 1)
})

test('网页和 MCP 一起并发十几次：网页的全部落库，MCP 不多建，没有报错', async () => {
  const rs = await Promise.all(Array.from({ length: 16 }, (_, i) => (i % 2 ? alice.post('/api/tasks', { title: '狂点' }) : mcpCreate({ title: '狂点' }))))
  const web = rs.filter((_, i) => i % 2)
  const agent = rs.filter((_, i) => !(i % 2))
  assert.deepEqual([...new Set(web.map((r) => r.status))], [201], web.map((r) => r.text).join(' | '))
  assert.ok(agent.every((r) => mcpOut(r)?.id), JSON.stringify(agent.map((r) => r.json)))
  // MCP 抢在所有网页请求之前才会多一行，之后的 MCP 都算重复
  assert.ok([8, 9].includes(await count()))
})

test('并发不同标题互不影响：一条都不丢', async () => {
  const rs = await Promise.all(Array.from({ length: 12 }, (_, i) => alice.post('/api/tasks', { title: `第 ${i} 件` })))
  assert.deepEqual([...new Set(rs.map((r) => r.status))], [201], rs.map((r) => r.text).join(' | '))
  assert.equal(await count(), 12)
})

test('MCP 并发不同标题互不影响：一条都不丢', async () => {
  const rs = await Promise.all(Array.from({ length: 12 }, (_, i) => mcpCreate({ title: `第 ${i} 件` })))
  assert.ok(rs.every((r) => mcpOut(r)?.id && !mcpOut(r).duplicate), JSON.stringify(rs.map((r) => r.json)))
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

// ---------- v0.1.2：手工表单永不去重，去重键带上指派对象 ----------
test('手工表单：同一 payload 连发两次，两条都建，事件和通知各两份', async () => {
  const body = { title: '打电话', assignee_id: BOB }
  const first = await alice.post('/api/tasks', body)
  const second = await alice.post('/api/tasks', body)
  assert.deepEqual([first.status, second.status], [201, 201])
  assert.equal(second.json.duplicate, undefined)
  assert.notEqual(second.json.id, first.json.id)
  assert.equal(await count(), 2)
  await new Promise((resolve) => setTimeout(resolve, 50))
  const [rows] = await h.pool.query("SELECT COUNT(*) AS n FROM inbox_event WHERE action = 'create'")
  assert.equal(rows[0].n, 2)
  assert.equal(h.platform.state.notifications.length, 2)
})

test('手工表单：同标题不同指派人，两条都建', async () => {
  const toBob = await alice.post('/api/tasks', { title: '打电话', assignee_id: BOB })
  const toCarol = await alice.post('/api/tasks', { title: '打电话', assignee_id: CAROL })
  assert.deepEqual([toBob.status, toCarol.status], [201, 201])
  assert.equal(await count(), 2)
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.deepEqual(h.platform.state.notifications.map((n) => n.userIds).sort(), [[BOB], [CAROL]])
})

test('手工表单：同标题不同日期，两条都建', async () => {
  const a = await alice.post('/api/tasks', { title: '周报', due_date: today })
  const b = await alice.post('/api/tasks', { title: '周报', due_date: addDays(today, 1) })
  assert.deepEqual([a.status, b.status], [201, 201])
  assert.equal(await count(), 2)
})

test('手工表单不看 MCP 刚记过的：照样新建', async () => {
  const agent = mcpOut(await mcpCreate({ title: '买票' }))
  const form = await alice.post('/api/tasks', { title: '买票' })
  assert.equal(form.status, 201)
  assert.notEqual(form.json.id, agent.id)
  assert.equal(await count(), 2)
})

test('MCP 连续两次相同调用：第一次新建，第二次 duplicate 且是同一条', async () => {
  const first = await mcpCreate({ title: '买票' })
  const second = await mcpCreate({ title: '买票' })
  // JSON-RPC 走 HTTP 恒为 200，新建和重复只看 duplicate 字段
  assert.deepEqual([first.status, second.status], [200, 200])
  assert.equal(mcpOut(first).duplicate, undefined)
  assert.equal(mcpOut(second).duplicate, true)
  assert.equal(mcpOut(second).id, mcpOut(first).id)
  assert.equal(JSON.parse(second.json.result.content[0].text).duplicate, true)
  assert.equal(await count(), 1)
})

test('MCP：同名待办已派给别人，再记一条自己的不算重复', async () => {
  const toBob = await alice.post('/api/tasks', { title: '打电话', assignee_id: BOB })
  const out = mcpOut(await mcpCreate({ title: '打电话' }))
  assert.equal(out.duplicate, undefined)
  assert.notEqual(out.id, toBob.json.id)
  assert.equal(await count(), 2)
})

// create_task 没有指派入参，这里按它传给 create 的选项直接调
test('去重键含指派对象：不同人各一条，都没指派算相同，指派给自己等于没指派', async () => {
  assert.equal(await duplicateOf({ title: '打电话', assignee_id: BOB }), false)
  assert.equal(await duplicateOf({ title: '打电话', assignee_id: CAROL }), false)
  assert.equal(await duplicateOf({ title: '打电话' }), false)
  assert.equal(await duplicateOf({ title: '打电话', assignee_id: BOB }), true)
  assert.equal(await duplicateOf({ title: '打电话' }), true)
  assert.equal(await duplicateOf({ title: '打电话', assignee_id: ALICE }), true)
  assert.equal(await count(), 3)
})

test('并发同标题不同指派人：每人一行，互不吞', async () => {
  for (let round = 0; round < 10; round++) {
    await h.pool.query('DELETE FROM inbox_event')
    await h.pool.query('DELETE FROM inbox_task')
    await Promise.all([BOB, CAROL, null, BOB, CAROL, null].map((assignee_id) => tasks.create(ALICE, { title: '打电话', assignee_id }, DEDUPE)))
    assert.equal(await count(), 3)
  }
})
