import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import { ADDED_COLUMNS, createPool, ensureColumn, ensureSchema } from '../src/db.js'
import { createTasks } from '../src/tasks.js'
import { buildDigest, sendDigest } from '../src/digest.js'
import { addDays, todayIn } from '../src/dates.js'

let pool
before(async () => {
  pool = createPool(process.env.TEST_DATABASE_URL)
  await ensureSchema(pool)
  await pool.query('DELETE FROM inbox_event')
  await pool.query('DELETE FROM inbox_task')
})
after(() => pool.end())

const indexes = async (table) => {
  const [rows] = await pool.query(`SHOW INDEX FROM ${table}`)
  const out = {}
  for (const r of rows) (out[r.Key_name] ??= []).push(r.Column_name)
  return out
}

test('建表幂等：重复执行不报错', async () => {
  await ensureSchema(pool)
  await ensureSchema(pool)
})

test('索引和约定一致', async () => {
  const idx = await indexes('inbox_task')
  assert.deepEqual(idx.idx_owner_status_due, ['owner_id', 'status', 'due_date'])
  assert.deepEqual(idx.idx_assignee_status, ['assignee_id', 'status'])
})

test('ensureColumn：缺列才加，再跑一次不动', async () => {
  await pool.query('DROP TABLE IF EXISTS inbox_col_test')
  await pool.query('CREATE TABLE inbox_col_test (id INT PRIMARY KEY)')
  const col = { table: 'inbox_col_test', column: 'extra', ddl: 'VARCHAR(20) NULL' }
  assert.equal(await ensureColumn(pool, col), true)
  assert.equal(await ensureColumn(pool, col), false)
  await pool.query('DROP TABLE inbox_col_test')
})

test('新增列清单当前为空（v0.1 是初始结构）', () => assert.deepEqual(ADDED_COLUMNS, []))

test('每日摘要：按负责人分组，汇总今天到期和逾期', async () => {
  const today = todayIn()
  const tasks = createTasks({ pool })
  await tasks.create(21, { title: '自己的', due_date: today })
  await tasks.create(21, { title: '派出去的', due_date: addDays(today, -1), assignee_id: 22 })
  await tasks.create(21, { title: '还早', due_date: addDays(today, 3) })
  await tasks.create(21, { title: '没日期' })
  const sent = []
  const r = await sendDigest({ tasks, notify: async (m) => sent.push(m), url: 'http://x/', today })
  assert.deepEqual(r, { total: 2, sent: 2 })
  const byUser = Object.fromEntries(sent.map((m) => [m.userIds[0], m]))
  assert.match(byUser[21].content, /今天：自己的/)
  assert.ok(!byUser[21].content.includes('派出去的'))
  assert.match(byUser[22].content, /逾期 1 天：派出去的/)
  assert.ok(sent.every((m) => m.url === 'http://x/'))
})

test('每日摘要：一个人发送失败不影响其他人', async () => {
  const today = todayIn()
  const tasks = { dueForDigest: async () => [{ user_id: 1, title: 'a', due_date: today }, { user_id: 2, title: 'b', due_date: today }] }
  let calls = 0
  const r = await sendDigest({ tasks, notify: async () => { if (++calls === 1) throw new Error('403') }, today })
  assert.deepEqual(r, { total: 2, sent: 1 })
})

test('每日摘要：内容不超平台长度限制', () => {
  const today = todayIn()
  const rows = Array.from({ length: 200 }, (_, i) => ({ user_id: 1, title: '长'.repeat(500) + i, due_date: today }))
  const [m] = buildDigest(rows, today, '')
  assert.ok(m.content.length <= 2000)
  assert.ok(m.title.length <= 80)
  assert.match(m.content, /还有 180 条/)
})
