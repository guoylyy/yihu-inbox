import test, { after, before, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { startHarness } from './support/harness.js'
import { createTasks } from '../src/tasks.js'
import { addDays, endOfWeek, startOfDayUtc, startOfWeek, todayIn, weekRange } from '../src/dates.js'
import { buildReport, completionRate, toMarkdown, weeklyMessage } from '../src/report.js'

const ALICE = 11
const BOB = 12
const CAROL = 13
const today = todayIn()

let h, alice, tasks

before(async () => {
  h = await startHarness()
  alice = await h.login(ALICE)
  tasks = createTasks({ pool: h.pool })
})
after(() => h.close())
beforeEach(async () => {
  for (const t of ['inbox_event', 'inbox_task', 'inbox_setting']) await h.pool.query(`DELETE FROM ${t}`)
})

const make = async (title, extra = {}, owner = ALICE) => (await tasks.create(owner, { title, ...extra })).task
const report = async () => (await alice.get('/api/report/week')).json
const setTime = (id, column, date) => h.pool.query(`UPDATE inbox_task SET ${column} = ?, updated_at = updated_at WHERE id = ?`, [date, id])
const lastWeek = () => new Date(weekRange(today).from.getTime() - 1000)

test('周的边界：周一 0 点到下周一 0 点（当地），上海比 UTC 早 8 小时', () => {
  const r = weekRange('2026-10-31', 'Asia/Shanghai')
  assert.equal(r.start, '2026-10-26')
  assert.equal(r.end, '2026-11-01')
  assert.equal(r.from.toISOString(), '2026-10-25T16:00:00.000Z')
  assert.equal(r.to.toISOString(), '2026-11-01T16:00:00.000Z')
})

test('周的边界：周一、周日都算在同一周', () => {
  assert.equal(startOfWeek('2026-10-26'), '2026-10-26')
  assert.equal(startOfWeek('2026-11-01'), '2026-10-26')
  assert.equal(endOfWeek('2026-10-26'), '2026-11-01')
})

test('当地 0 点：有夏令时的时区也对', () => {
  assert.equal(startOfDayUtc('2026-07-01', 'America/New_York').toISOString(), '2026-07-01T04:00:00.000Z')
  assert.equal(startOfDayUtc('2026-12-01', 'America/New_York').toISOString(), '2026-12-01T05:00:00.000Z')
})

test('新增：本周创建的才算，上周最后一秒不算', async () => {
  await make('本周')
  const old = await make('上周')
  await setTime(old.id, 'created_at', lastWeek())
  const done = await make('本周建本周完')
  await tasks.setStatus(ALICE, done.id, 'done')
  assert.equal((await report()).added, 2)
})

test('完成：按 done_at 算，上周建的本周完成也算；上周完成的不算', async () => {
  const old = await make('清旧账')
  await setTime(old.id, 'created_at', lastWeek())
  await tasks.setStatus(ALICE, old.id, 'done')
  const before = await make('上周做完的')
  await tasks.setStatus(ALICE, before.id, 'done')
  await setTime(before.id, 'done_at', lastWeek())
  assert.equal((await report()).done, 1)
})

test('完成：重新打开的不算', async () => {
  const a = await make('一')
  await tasks.setStatus(ALICE, a.id, 'done')
  await tasks.setStatus(ALICE, a.id, 'open')
  assert.equal((await report()).done, 0)
})

test('完成率：完成 ÷（完成 + 截止在本周内还没做完的），不超过 100%', () => {
  assert.equal(completionRate(3, 1), 75)
  assert.equal(completionRate(10, 0), 100)
  assert.equal(completionRate(0, 4), 0)
  assert.equal(completionRate(0, 0), null)
})

test('完成率：没截止日的不进分母，下周才到期的也不进', async () => {
  const a = await make('做完了', { due_date: today })
  await tasks.setStatus(ALICE, a.id, 'done')
  await make('本周到期', { due_date: endOfWeek(today) })
  await make('没日期')
  await make('下周到期', { due_date: addDays(endOfWeek(today), 1) })
  const r = await report()
  assert.equal(r.open_due, 1)
  assert.equal(r.rate, 50)
})

test('完成率：清旧账也不会超过 100%', async () => {
  for (const i of [1, 2, 3]) {
    const t = await make(`旧账 ${i}`)
    await setTime(t.id, 'created_at', lastWeek())
    await tasks.setStatus(ALICE, t.id, 'done')
  }
  const r = await report()
  assert.equal(r.added, 0)
  assert.equal(r.done, 3)
  assert.equal(r.rate, 100)
})

test('完成率：什么都没有时是 null，页面显示 —', async () => {
  assert.equal((await report()).rate, null)
  assert.match((await alice.get('/api/list.html?view=week')).text, /id="r-rate">—</)
})

test('逾期：截止早于今天且没完成；今天到期的不算；已完成的不算', async () => {
  await make('昨天的', { due_date: addDays(today, -1) })
  await make('今天的', { due_date: today })
  const done = await make('昨天但做完了', { due_date: addDays(today, -1) })
  await tasks.setStatus(ALICE, done.id, 'done')
  const r = await report()
  assert.equal(r.overdue_total, 1)
  assert.deepEqual(r.overdue.map((t) => [t.title, t.due]), [['昨天的', '逾期 1 天']])
})

test('逾期：不限于本周，上个月的也在清单里，最久的排前面', async () => {
  await make('昨天', { due_date: addDays(today, -1) })
  await make('一个月前', { due_date: addDays(today, -30) })
  assert.deepEqual((await report()).overdue.map((t) => t.title), ['一个月前', '昨天'])
})

test('逾期：清单封顶 50 条，总数照实报', async () => {
  const due = addDays(today, -1)
  await h.pool.query('INSERT INTO inbox_task (owner_id, title, due_date, tags, source) VALUES ?', [Array.from({ length: 53 }, (_, i) => [ALICE, `第 ${i} 条`, due, '[]', 'self'])])
  const r = await report()
  assert.equal(r.overdue_total, 53)
  assert.equal(r.overdue.length, 50)
  assert.match(r.markdown, /还有 33 条/)
})

test('按人分布：归到负责人，多的排前面；只算未完成', async () => {
  await make('自己的')
  await make('派 Bob 一', { assignee_id: BOB })
  await make('派 Bob 二', { assignee_id: BOB })
  const done = await make('派 Carol', { assignee_id: CAROL })
  await tasks.setStatus(ALICE, done.id, 'done')
  assert.deepEqual((await report()).people.map((p) => [p.name, p.count]), [['李雷', 2], ['王小明', 1]])
})

test('按人分布：看不到的事不进来', async () => {
  await make('别人的', {}, CAROL)
  await make('别人派给别人的', { assignee_id: BOB }, CAROL)
  assert.deepEqual((await report()).people, [])
})

test('连续 3 天没动：满 72 小时才算，改一下就出来', async () => {
  const a = await make('三天多')
  const b = await make('两天')
  await h.pool.query('UPDATE inbox_task SET updated_at = DATE_SUB(UTC_TIMESTAMP(), INTERVAL 73 HOUR) WHERE id = ?', [a.id])
  await h.pool.query('UPDATE inbox_task SET updated_at = DATE_SUB(UTC_TIMESTAMP(), INTERVAL 47 HOUR) WHERE id = ?', [b.id])
  assert.deepEqual((await report()).stale.map((t) => t.title), ['三天多'])
  await tasks.update(ALICE, a.id, { title: '三天多（改过）' })
  assert.equal((await report()).stale_total, 0)
})

test('连续 3 天没动：已完成的不算；批量改期算动过，撤销后又算没动', async () => {
  const a = await make('老事')
  const done = await make('做完的老事')
  await tasks.setStatus(ALICE, done.id, 'done')
  await h.pool.query('UPDATE inbox_task SET updated_at = DATE_SUB(UTC_TIMESTAMP(), INTERVAL 5 DAY)')
  assert.equal((await report()).stale_total, 1)
  const b = await tasks.batch(ALICE, 'reschedule', [a.id], today)
  assert.equal((await report()).stale_total, 0)
  await tasks.undoBatch(ALICE, b.batch_id)
  assert.equal((await report()).stale_total, 1)
})

test('归档的不进任何统计', async () => {
  const a = await make('要归档', { due_date: addDays(today, -1) })
  await tasks.batch(ALICE, 'archive', [a.id])
  const r = await report()
  assert.deepEqual([r.added, r.overdue_total, r.people.length, r.open_due], [0, 0, 0, 0])
})

test('周报随批量和撤销变化', async () => {
  const a = await make('一')
  const inWeek = addDays(today, 0)
  assert.equal((await report()).open_due, 0)
  const b = await tasks.batch(ALICE, 'reschedule', [a.id], inWeek)
  assert.equal((await report()).open_due, 1)
  await tasks.undoBatch(ALICE, b.batch_id)
  assert.equal((await report()).open_due, 0)
})

test('复制为文本：Markdown 含数字、清单，标题压成一行', async () => {
  await make('第一行\n第二行', { due_date: addDays(today, -2), assignee_id: BOB })
  const r = await report()
  assert.ok(r.markdown.startsWith(`## 本周周报（${r.label}）`))
  assert.match(r.markdown, /新增 1 条，完成 0 条，完成率 0%/)
  assert.match(r.markdown, /- 逾期 2 天：第一行 第二行（李雷）/)
  assert.match(r.markdown, /### 按人分布（1）\n- 李雷：1 条/)
})

test('复制为文本：标题完整，不跟界面截断', async () => {
  const long = '把第三季度华东区所有经销商的返利对账单核对完'.repeat(5)
  await make(long, { due_date: addDays(today, -1) })
  assert.ok((await report()).markdown.includes(`逾期 1 天：${long}`))
  const { text } = await alice.get('/api/list.html?view=week')
  assert.match(text, /data-copy="[^"]*把第三季度华东区所有经销商的返利对账单核对完把第三季度/)
})

test('复制为文本：没有的小节不写', () => {
  const md = toMarkdown({ label: 'x', added: 0, done: 0, rate: null, overdue: [], overdue_total: 0, people: [], stale: [], stale_total: 0 })
  assert.equal(md, '## 本周周报（x）\n\n- 新增 0 条，完成 0 条，完成率 暂无')
})

test('周报在「本周」视图里，下面还是本周到期的列表', async () => {
  await make('本周要做', { due_date: today })
  const { text } = await alice.get('/api/list.html?view=week')
  assert.ok(text.indexOf('id="report"') < text.indexOf('本周要做'))
  assert.match(text, /复制为文本/)
  assert.match(text, /data-copy="## 本周周报/)
  assert.ok(!(await alice.get('/api/list.html?view=today')).text.includes('id="report"'))
})

test('周报卡片：逾期只留三条短标题，多的报数，下面的列表和公式不重复', async () => {
  for (const [i, n] of [1, 2, 3, 4, 5].entries()) await make(`第 ${n} 条逾期的事情写得比十二个字还要长`, { due_date: addDays(today, -(i + 1)), assignee_id: BOB })
  const { text } = await alice.get('/api/list.html?view=week')
  const card = text.slice(text.indexOf('id="r-overdue-list"'), text.indexOf('id="r-people"'))
  assert.equal(card.match(/<li>/g).length, 3)
  assert.match(card, /<span class="late">逾期 5 天<\/span> · 第 5 条逾期的事情写得…</)
  assert.match(card, /还有 2 条/)
  assert.ok(!card.includes('李雷</span></li>'), '清单不再带负责人')
})

test('周报卡片：不到三条时不提示还有；公式只在问号的 title 里', async () => {
  await make('两字', { due_date: addDays(today, -1) })
  const { text } = await alice.get('/api/list.html?view=week')
  assert.match(text, /<span class="late">逾期 1 天<\/span> · 两字</)
  assert.ok(!text.includes('还有'))
  assert.match(text, /class="tip"[^>]*title="完成率 = 本周完成 ÷（本周完成 \+ 截止在本周内还没做完的 1 条）"/)
  assert.ok(!text.includes('<p class="yh-hint">完成率'))
})

test('周报不把 HTML 带进页面', async () => {
  await make('<script>alert(1)</script>', { due_date: addDays(today, -1) })
  const { text } = await alice.get('/api/list.html?view=week')
  assert.ok(!text.includes('<script>alert'))
})

test('周五推送的正文不超平台上限', async () => {
  const due = addDays(today, -1)
  await h.pool.query('INSERT INTO inbox_task (owner_id, title, due_date, tags, source) VALUES ?', [Array.from({ length: 60 }, (_, i) => [ALICE, `${'长'.repeat(400)}${i}`, due, '[]', 'self'])])
  const m = weeklyMessage(await buildReport({ tasks, users: { names: async () => new Map() }, me: { id: ALICE, name: '王小明' }, today }), 'http://x/')
  assert.ok([...m.content].length <= 2000)
  assert.ok(m.title.length <= 80)
  assert.equal(m.url, 'http://x/')
})

test('右侧栏：今日进度、按人分布、最近活动', async () => {
  const a = await make('做完了', { due_date: today })
  await tasks.setStatus(ALICE, a.id, 'done')
  await make('还没做', { due_date: today })
  await make('派 Bob', { assignee_id: BOB })
  const { text } = await alice.get('/api/rail.html')
  assert.match(text, /id="rail-done">1</)
  assert.match(text, /id="rail-left">1</)
  assert.match(text, /<progress/)
  assert.match(text, /李雷/)
  assert.match(text, /你完成了/)
})
