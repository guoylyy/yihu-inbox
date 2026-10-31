import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import { startHarness } from './support/harness.js'
import { PEOPLE } from './support/fake-platform.mjs'
import { matchAssignee } from '../src/platform-users.js'
import { buildPrompt, normalizeParsed } from '../src/parse.js'

const person = (id, username, name, dept = '研发部') => ({ id, username, name, active: true, depts: [{ name: dept, isPrimary: true }], mobile: '13900000000' })
const STAFF = [
  ...PEOPLE,
  person(21, 'guodong', '郑国栋'),
  person(22, 'fang1', '王芳', '财务部'),
  person(23, 'fang2', '王芳', '行政部'),
  person(24, 'zhang', '张三'),
  person(25, 'zhangsf', '张三丰')
]
const ALICE = 11

let h, alice
before(async () => {
  h = await startHarness({ people: STAFF })
  alice = await h.login(ALICE)
})
after(() => h.close())

const parseWith = async (assignee) => {
  h.platform.state.llm = () => JSON.stringify({ title: '整理客户名单', due_date: null, due_time: null, priority: 0, assignee })
  const r = await alice.post('/api/parse', { text: `让${assignee}整理客户名单` })
  assert.equal(r.status, 200, r.text)
  return r.json
}

// ---------- 匹配规则 ----------
const list = STAFF.map((u) => ({ id: u.id, name: u.name, username: u.username, dept: null, active: true }))
const ids = (r) => r.candidates.map((u) => u.id)

test('匹配：name 精确唯一 → matched', () => {
  const r = matchAssignee(list, '郑国栋')
  assert.equal(r.status, 'matched')
  assert.equal(r.user.id, 21)
})

test('匹配：username 精确唯一 → matched', () => {
  assert.equal(matchAssignee(list, 'guodong').user.id, 21)
})

test('匹配：同名两人 → 不给 user，列候选', () => {
  const r = matchAssignee(list, '王芳')
  assert.equal(r.status, 'ambiguous')
  assert.equal(r.user, null)
  assert.deepEqual(ids(r), [22, 23])
})

test('匹配：精确命中但另有人姓名包含它 → 不预填', () => {
  const r = matchAssignee(list, '张三')
  assert.equal(r.status, 'ambiguous')
  assert.deepEqual(ids(r), [24, 25])
})

test('匹配：只沾到一个人但不精确 → 列候选，不替用户猜', () => {
  const r = matchAssignee(list, '国栋')
  assert.equal(r.status, 'ambiguous')
  assert.equal(r.user, null)
  assert.deepEqual(ids(r), [21])
})

test('匹配：模型多带了字，姓名被它包含 → 列候选', () => {
  assert.deepEqual(ids(matchAssignee(list, '郑国栋总')), [21])
})

test('匹配：没有这个人 → none', () => {
  assert.deepEqual(matchAssignee(list, '赵六'), { status: 'none', user: null, candidates: [] })
})

test('匹配：空名字不命中所有人', () => {
  for (const name of ['', '  ', null, undefined]) assert.equal(matchAssignee(list, name).status, 'none')
})

test('匹配：username 大小写不同不算精确', () => {
  assert.equal(matchAssignee(list, 'GuoDong').status, 'none')
})

// ---------- 解析 ----------
test('提示词带 assignee 字段说明', () => {
  assert.ok(buildPrompt('2026-10-30', 'Asia/Shanghai').includes('- assignee：如果这句话里出现了「给某某」「让某某」「某某负责」，原样输出那个人名（不要猜全名，不要改字）；没有就是 null'))
})

test('assignee：原话里有的才要，模型补全或编的丢掉', () => {
  const text = '给国栋：整理名单'
  const of = (assignee) => normalizeParsed({ title: '整理名单', assignee }, text, '2026-10-30').assignee
  assert.equal(of('国栋'), '国栋')
  assert.equal(of(' 国栋 '), '国栋')
  assert.equal(of('郑国栋'), null)
  assert.equal(of(null), null)
  assert.equal(of(123), null)
  assert.equal(of(''), null)
})

// ---------- 接口 ----------
test('人名唯一命中 → 预填，只给 id、姓名、部门', async () => {
  const r = await parseWith('郑国栋')
  assert.equal(r.assignee, '郑国栋')
  assert.deepEqual(r.match, { status: 'matched', user: { id: 21, name: '郑国栋', dept: '研发部' }, candidates: [] })
})

test('同名两人 → 不预填并给候选', async () => {
  const { match } = await parseWith('王芳')
  assert.equal(match.status, 'ambiguous')
  assert.equal(match.user, null)
  assert.deepEqual(match.candidates, [{ id: 22, name: '王芳', dept: '财务部' }, { id: 23, name: '王芳', dept: '行政部' }])
})

test('无命中 → 不预填', async () => {
  const r = await parseWith('赵六')
  assert.equal(r.assignee, '赵六')
  assert.deepEqual(r.match, { status: 'none', user: null, candidates: [] })
})

test('说的是自己 → 不预填（自己不进候选，和选人一致）', async () => {
  assert.deepEqual((await parseWith('王小明')).match, { status: 'none', user: null, candidates: [] })
})

test('没提到人：match 是 null', async () => {
  h.platform.state.llm = () => JSON.stringify({ title: '买牛奶', due_date: null, due_time: null, priority: 0, assignee: null })
  const r = await alice.post('/api/parse', { text: '买牛奶' })
  assert.equal(r.json.assignee, null)
  assert.equal(r.json.match, null)
})

test('不静默指派：解析命中后库里没东西、不发通知；保存时才按提交的人写', async () => {
  await h.pool.query('DELETE FROM inbox_event')
  await h.pool.query('DELETE FROM inbox_task')
  const n = h.platform.state.notifications.length
  await parseWith('郑国栋')
  const [[{ c }]] = await h.pool.query('SELECT COUNT(*) AS c FROM inbox_task')
  assert.equal(c, 0)
  assert.equal(h.platform.state.notifications.length, n)
  const changed = await alice.post('/api/tasks', { title: '整理客户名单', assignee_id: 12 })
  assert.equal(changed.json.assignee_id, 12)
})

test('平台用户接口挂了：解析照常，按没认出来处理', async () => {
  const other = await startHarness({ keepData: true })
  const a = await other.login(ALICE)
  other.platform.state.usersDown = true
  other.platform.state.llm = () => JSON.stringify({ title: '整理名单', assignee: '郑国栋' })
  const r = await a.post('/api/parse', { text: '给郑国栋：整理名单' })
  assert.equal(r.status, 200)
  assert.equal(r.json.title, '整理名单')
  assert.deepEqual(r.json.match, { status: 'none', user: null, candidates: [] })
  await other.close()
})
