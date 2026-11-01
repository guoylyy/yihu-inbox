import test, { after, before, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { setTimeout as sleep } from 'node:timers/promises'
import { startHarness } from './support/harness.js'
import { BATCH_MAX, createTasks } from '../src/tasks.js'
import { addDays, parseDueWord, todayIn } from '../src/dates.js'

const ALICE = 11
const BOB = 12
const CAROL = 13
const today = todayIn()
const tomorrow = addDays(today, 1)

let h, alice, bob, tasks

before(async () => {
  h = await startHarness()
  alice = await h.login(ALICE)
  bob = await h.login(BOB)
  tasks = createTasks({ pool: h.pool })
})
after(() => h.close())
beforeEach(async () => {
  for (const t of ['inbox_event', 'inbox_task', 'inbox_batch', 'inbox_setting']) await h.pool.query(`DELETE FROM ${t}`)
  h.platform.state.notifications.length = 0
})

const make = async (title, extra = {}, owner = ALICE) => (await tasks.create(owner, { title, ...extra })).task
const row = async (id) => (await h.pool.query('SELECT * FROM inbox_task WHERE id = ?', [id]))[0][0]
const batch = (client, action, ids, extra = {}) => client.post('/api/tasks/batch', { action, ids, ...extra })
const ago = (id, sql = 'DATE_SUB(UTC_TIMESTAMP(), INTERVAL 5 DAY)') => h.pool.query(`UPDATE inbox_task SET updated_at = ${sql} WHERE id = ?`, [id])

test('批量改期：预设按服务端的今天算', async () => {
  const [a, b] = [await make('一'), await make('二', { due_date: today })]
  const r = await batch(alice, 'reschedule', [a.id, b.id], { preset: 'tomorrow' })
  assert.equal(r.status, 200)
  assert.deepEqual(r.json.changed.sort(), [a.id, b.id].sort())
  assert.equal(r.json.undo_ms, 3000)
  assert.equal((await row(a.id)).due_date, tomorrow)
  assert.equal((await row(b.id)).due_date, tomorrow)
})

test('批量改期：今天、下周（下周一）、自定义、清空', async () => {
  const a = await make('一')
  await batch(alice, 'reschedule', [a.id], { preset: 'today' })
  assert.equal((await row(a.id)).due_date, today)
  await batch(alice, 'reschedule', [a.id], { preset: 'next_week' })
  assert.equal((await row(a.id)).due_date, parseDueWord('下周一', today))
  await batch(alice, 'reschedule', [a.id], { due_date: '2030-01-02' })
  assert.equal((await row(a.id)).due_date, '2030-01-02')
  await batch(alice, 'reschedule', [a.id], { due_date: null })
  assert.equal((await row(a.id)).due_date, null)
})

test('批量改期：选项不对、日期不对都是 400，什么都不改', async () => {
  const a = await make('一', { due_date: today })
  assert.equal((await batch(alice, 'reschedule', [a.id], { preset: 'someday' })).status, 400)
  assert.equal((await batch(alice, 'reschedule', [a.id], { due_date: '2026-13-40' })).status, 400)
  assert.equal((await batch(alice, 'reschedule', [a.id])).status, 400)
  assert.equal((await row(a.id)).due_date, today)
})

test('批量指派：写库、留事件、撤销窗口过后每人只收一条通知', async () => {
  const [a, b, c] = [await make('一'), await make('二'), await make('三')]
  const r = await batch(alice, 'assign', [a.id, b.id, c.id], { assignee_id: BOB })
  assert.equal(r.json.changed.length, 3)
  assert.equal((await row(a.id)).assignee_id, BOB)
  await sleep(120)
  const notes = h.platform.state.notifications
  assert.equal(notes.length, 1)
  assert.deepEqual(notes[0].userIds, [BOB])
  assert.match(notes[0].title, /指派给你 3 件事/)
  const [events] = await h.pool.query("SELECT detail FROM inbox_event WHERE task_id = ? AND action = 'assign'", [a.id])
  assert.equal(events[0].detail.to, BOB)
  assert.equal(events[0].detail.batch, r.json.batch_id)
})

test('批量指派：撤销了就不通知', async () => {
  const a = await make('一')
  const r = await batch(alice, 'assign', [a.id], { assignee_id: BOB })
  assert.equal((await alice.post(`/api/batches/${r.json.batch_id}/undo`)).status, 200)
  await sleep(120)
  assert.equal(h.platform.state.notifications.length, 0)
  assert.equal((await row(a.id)).assignee_id, null)
})

test('批量指派：平台上没有这个人是 400；取消指派可以', async () => {
  const a = await make('一', { assignee_id: BOB })
  assert.equal((await batch(alice, 'assign', [a.id], { assignee_id: 9999 })).status, 400)
  assert.equal((await row(a.id)).assignee_id, BOB)
  assert.equal((await batch(alice, 'assign', [a.id], { assignee_id: null })).status, 200)
  assert.equal((await row(a.id)).assignee_id, null)
})

test('批量指派给自己等于取消指派', async () => {
  const a = await make('一', { assignee_id: BOB })
  await batch(alice, 'assign', [a.id], { assignee_id: ALICE })
  assert.equal((await row(a.id)).assignee_id, null)
})

test('批量完成：写 done_at；已完成的不重复改，也不算跳过', async () => {
  const [a, b] = [await make('一'), await make('二')]
  await tasks.setStatus(ALICE, b.id, 'done')
  const doneAt = (await row(b.id)).done_at
  const r = await batch(alice, 'done', [a.id, b.id])
  assert.deepEqual(r.json.changed, [a.id])
  assert.equal(r.json.unchanged, 1)
  assert.deepEqual(r.json.skipped, { not_owner: 0, gone: 0 })
  assert.equal((await row(a.id)).status, 'done')
  assert.ok((await row(a.id)).done_at)
  assert.deepEqual((await row(b.id)).done_at, doneAt)
})

test('被指派人可以批量完成别人派的事', async () => {
  const a = await make('派给 Bob', { assignee_id: BOB })
  const r = await batch(bob, 'done', [a.id])
  assert.deepEqual(r.json.changed, [a.id])
})

test('部分失败：别人派来的跳过并报数，自己的照常改', async () => {
  const mine = await make('我的', {}, BOB)
  const fromAlice = await make('派给 Bob', { assignee_id: BOB, due_date: today })
  const r = await batch(bob, 'reschedule', [mine.id, fromAlice.id], { preset: 'tomorrow' })
  assert.deepEqual(r.json.changed, [mine.id])
  assert.equal(r.json.skipped.not_owner, 1)
  assert.equal((await row(mine.id)).due_date, tomorrow)
  assert.equal((await row(fromAlice.id)).due_date, today)
})

test('部分失败：看不到的、不存在的按 gone 跳过，不泄露存在与否', async () => {
  const mine = await make('我的')
  const others = await make('别人的', {}, CAROL)
  const r = await batch(alice, 'done', [mine.id, others.id, 99999999])
  assert.deepEqual(r.json.changed, [mine.id])
  assert.equal(r.json.skipped.gone, 2)
  assert.equal((await row(others.id)).status, 'open')
})

test('全部跳过时没有批次，也就没有撤销', async () => {
  const fromAlice = await make('派给 Bob', { assignee_id: BOB })
  const r = await batch(bob, 'archive', [fromAlice.id])
  assert.equal(r.json.batch_id, null)
  assert.deepEqual(r.json.changed, [])
})

test('事务：写事件失败时整批回滚，不会只改一半', async () => {
  const [a, b] = [await make('一'), await make('二')]
  await h.pool.query('DELETE FROM inbox_event')
  await h.pool.query('ALTER TABLE inbox_event MODIFY action VARCHAR(3) NOT NULL')
  try {
    await assert.rejects(tasks.batch(ALICE, 'archive', [a.id, b.id]))
  } finally {
    await h.pool.query('ALTER TABLE inbox_event MODIFY action VARCHAR(20) NOT NULL')
  }
  assert.equal((await row(a.id)).archived_at, null)
  assert.equal((await row(b.id)).archived_at, null)
  const [[{ n }]] = await h.pool.query('SELECT COUNT(*) AS n FROM inbox_batch')
  assert.equal(n, 0)
})

test('请求不对：空选、超量、id 乱写、没有这个动作', async () => {
  assert.equal((await batch(alice, 'done', [])).status, 400)
  assert.equal((await batch(alice, 'done', 'x')).status, 400)
  assert.equal((await batch(alice, 'done', ['1; DROP TABLE inbox_task'])).status, 400)
  assert.equal((await batch(alice, 'done', Array.from({ length: BATCH_MAX + 1 }, (_, i) => i + 1))).status, 400)
  assert.equal((await batch(alice, 'nuke', [1])).status, 400)
})

test('归档：所有视图、详情、MCP、摘要都看不到，已归档里有', async () => {
  const a = await make('要归档', { due_date: today })
  assert.equal((await batch(alice, 'archive', [a.id])).status, 200)
  for (const v of ['today', 'week', 'open']) assert.deepEqual((await alice.get(`/api/tasks?view=${v}`)).json.list, [], v)
  assert.equal((await alice.get(`/api/tasks/${a.id}`)).status, 404)
  assert.equal((await alice.patch(`/api/tasks/${a.id}`, { title: 'x' })).status, 404)
  assert.deepEqual(await tasks.dueForDigest(today), [])
  const mcp = await h.mcp('tools/call', { name: 'list_tasks', arguments: { view: 'open' } }, `token-${ALICE}`)
  assert.deepEqual(mcp.json.result.structuredContent.list, [])
  assert.deepEqual((await alice.get('/api/tasks?view=archived')).json.list.map((t) => t.id), [a.id])
})

test('归档：只有创建人能做，被指派人跳过', async () => {
  const a = await make('派给 Bob', { assignee_id: BOB })
  const r = await batch(bob, 'archive', [a.id])
  assert.equal(r.json.skipped.not_owner, 1)
  assert.equal((await row(a.id)).archived_at, null)
})

test('恢复：已归档的回到列表', async () => {
  const a = await make('要归档', { due_date: today })
  await batch(alice, 'archive', [a.id])
  const r = await batch(alice, 'restore', [a.id])
  assert.deepEqual(r.json.changed, [a.id])
  assert.equal((await alice.get('/api/tasks?view=today')).json.list.length, 1)
})

test('归档的事不再挡 AI 入口的去重', async () => {
  const first = await tasks.create(ALICE, { title: '买牛奶' }, { source: 'ai', dedupe: true })
  await batch(alice, 'archive', [first.task.id])
  const second = await tasks.create(ALICE, { title: '买牛奶' }, { source: 'ai', dedupe: true })
  assert.equal(second.duplicate, false)
  assert.notEqual(second.task.id, first.task.id)
})

test('撤销改期：日期和 updated_at 都回到原样', async () => {
  const a = await make('一', { due_date: today })
  await ago(a.id)
  const before = await row(a.id)
  const r = await batch(alice, 'reschedule', [a.id], { preset: 'tomorrow' })
  assert.notDeepEqual((await row(a.id)).updated_at, before.updated_at)
  const u = await alice.post(`/api/batches/${r.json.batch_id}/undo`)
  assert.deepEqual(u.json, { restored: 1, conflicted: 0 })
  const after = await row(a.id)
  assert.equal(after.due_date, today)
  assert.deepEqual(after.updated_at, before.updated_at)
})

test('撤销完成：回到未完成，done_at 清掉', async () => {
  const a = await make('一')
  const r = await batch(alice, 'done', [a.id])
  await alice.post(`/api/batches/${r.json.batch_id}/undo`)
  const after = await row(a.id)
  assert.equal(after.status, 'open')
  assert.equal(after.done_at, null)
})

test('撤销归档：回到列表', async () => {
  const a = await make('一', { due_date: today })
  const r = await batch(alice, 'archive', [a.id])
  await alice.post(`/api/batches/${r.json.batch_id}/undo`)
  assert.equal((await alice.get('/api/tasks?view=today')).json.list.length, 1)
})

test('撤销只还原这一批改到的，已经是目标值的那条不动', async () => {
  const a = await make('本来就是明天', { due_date: tomorrow })
  const b = await make('今天', { due_date: today })
  const r = await batch(alice, 'reschedule', [a.id, b.id], { preset: 'tomorrow' })
  assert.equal(r.json.unchanged, 1)
  await alice.post(`/api/batches/${r.json.batch_id}/undo`)
  assert.equal((await row(a.id)).due_date, tomorrow)
  assert.equal((await row(b.id)).due_date, today)
})

test('撤销时别人刚改过的那条不动，并报数', async () => {
  const [a, b] = [await make('一', { due_date: today }), await make('二', { due_date: today })]
  const r = await batch(alice, 'reschedule', [a.id, b.id], { preset: 'tomorrow' })
  await tasks.update(ALICE, b.id, { due_date: '2030-01-01' })
  const u = await alice.post(`/api/batches/${r.json.batch_id}/undo`)
  assert.deepEqual(u.json, { restored: 1, conflicted: 1 })
  assert.equal((await row(a.id)).due_date, today)
  assert.equal((await row(b.id)).due_date, '2030-01-01')
})

test('撤销只能一次', async () => {
  const a = await make('一')
  const r = await batch(alice, 'done', [a.id])
  assert.equal((await alice.post(`/api/batches/${r.json.batch_id}/undo`)).status, 200)
  assert.equal((await alice.post(`/api/batches/${r.json.batch_id}/undo`)).status, 409)
})

test('别人撤销不了我的批次', async () => {
  const a = await make('一')
  const r = await batch(alice, 'done', [a.id])
  assert.equal((await bob.post(`/api/batches/${r.json.batch_id}/undo`)).status, 404)
  assert.equal((await row(a.id)).status, 'done')
})

test('撤销有时限：过了窗口 410，页面 3 秒内点的请求留有余量', async () => {
  let clock = Date.now()
  const timed = createTasks({ pool: h.pool, now: () => clock })
  const a = await make('一')
  const first = await timed.batch(ALICE, 'done', [a.id])
  clock += 2900
  assert.deepEqual(await timed.undoBatch(ALICE, first.batch_id), { restored: 1, conflicted: 0 })
  const second = await timed.batch(ALICE, 'done', [a.id])
  clock += 6000
  await assert.rejects(timed.undoBatch(ALICE, second.batch_id), (e) => e.status === 410)
  assert.equal((await row(a.id)).status, 'done')
})

test('过期一小时的快照在下一次批量时清掉', async () => {
  const a = await make('一')
  await batch(alice, 'done', [a.id])
  await h.pool.query('UPDATE inbox_batch SET undo_until = DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 2 HOUR)')
  const b = await make('二')
  await batch(alice, 'done', [b.id])
  const [[{ n }]] = await h.pool.query('SELECT COUNT(*) AS n FROM inbox_batch')
  assert.equal(n, 1)
})

test('全部选中：拿到视图里全部 id，超过列表 200 条的上限也算', async () => {
  const values = Array.from({ length: 205 }, (_, i) => [ALICE, `第 ${i} 条`, '[]', 'self'])
  await h.pool.query('INSERT INTO inbox_task (owner_id, title, tags, source) VALUES ?', [values])
  const r = await alice.get('/api/tasks/ids?view=open')
  assert.equal(r.json.total, 205)
  assert.equal(r.json.ids.length, 205)
  assert.equal(r.json.max, BATCH_MAX)
  assert.equal((await alice.get('/api/tasks?view=open')).json.list.length, 200)
  assert.match((await alice.get('/api/list.html?view=open')).text, /只显示前 200 条，共 205 条/)
  const done = await batch(alice, 'done', r.json.ids)
  assert.equal(done.json.changed.length, 205)
})

test('全部选中不跨视图：今天视图不含没日期的', async () => {
  await make('今天的', { due_date: today })
  await make('没日期')
  assert.equal((await alice.get('/api/tasks/ids?view=today')).json.total, 1)
})

test('未登录不能批量', async () => {
  const r = await fetch(`${h.base}/api/tasks/batch`, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: '{}', redirect: 'manual' })
  assert.ok([302, 401].includes(r.status))
})

test('指派后「负责人待确认」的标记消失，撤销后回来', async () => {
  const [{ id }] = await tasks.createMany(ALICE, [{ title: '待确认', tags: ['负责人待确认：老周'] }])
  const r = await batch(alice, 'assign', [id], { assignee_id: BOB })
  assert.deepEqual((await row(id)).tags, [])
  await alice.post(`/api/batches/${r.json.batch_id}/undo`)
  assert.deepEqual((await row(id)).tags, ['负责人待确认：老周'])
})

test('单条指派也清掉待确认标记', async () => {
  const [{ id }] = await tasks.createMany(ALICE, [{ title: '待确认', tags: ['负责人待确认：老周'] }])
  await alice.put(`/api/tasks/${id}/assignee`, { assignee_id: BOB })
  assert.deepEqual((await row(id)).tags, [])
})
