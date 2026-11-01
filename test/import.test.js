import test, { after, before, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { startHarness } from './support/harness.js'
import { createTasks } from '../src/tasks.js'
import { addDays, parseImportDate, todayIn } from '../src/dates.js'
import { FILE_MAX, IMPORT_ROWS_MAX, IMPORT_TITLE_MAX, decodeText, markDuplicates, parseCsv, parseCsvItems, parseLine, parseText, readUpload, shape } from '../src/import.js'

const ALICE = 11
const BOB = 12
const DAY = '2026-10-31'
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
  h.platform.state.usersDown = false
  h.platform.state.notifications.length = 0
})

const preview = async (text) => (await alice.post('/api/import/preview', { text })).json
const line = (s) => parseLine(s, DAY)

test('粘贴：一行一条，空行和分隔线不算，\\r\\n 也认', () => {
  assert.deepEqual(parseText('买牛奶\r\n\r\n---\n写周报\r交房租', DAY).map((r) => r.title), ['买牛奶', '写周报', '交房租'])
})

test('粘贴：- * 1. 开头都认', () => {
  for (const s of ['- 买牛奶', '* 买牛奶', '-买牛奶', '• 买牛奶', '1. 买牛奶', '12.买牛奶', '3、买牛奶', '2) 买牛奶', '（4）买牛奶']) assert.equal(line(s).title, '买牛奶', s)
})

test('粘贴：1.5 倍、-5 度这种不是序号', () => {
  assert.equal(line('1.5 倍工资核算').title, '1.5 倍工资核算')
  assert.equal(line('-5度冷藏检查').title, '-5度冷藏检查')
})

test('粘贴：Markdown 标题不算待办', () => assert.equal(line('## 下周计划'), null))

test('会议待办：[ ] 标题 @负责人 日期', () => {
  assert.deepEqual(line('[ ] 整理客户名单 @郑国栋 11-02'), { title: '整理客户名单', due_date: '2026-11-02', owner_name: '郑国栋', marked_done: false })
})

test('会议待办：会议实际复制出来的格式没有 [ ]，也认', () => {
  assert.deepEqual(line('整理客户名单 @郑国栋 11-02'), { title: '整理客户名单', due_date: '2026-11-02', owner_name: '郑国栋', marked_done: false })
  assert.deepEqual(line('出一版排期 @王芳'), { title: '出一版排期', due_date: null, owner_name: '王芳', marked_done: false })
  assert.deepEqual(line('出一版排期 11-02'), { title: '出一版排期', due_date: '2026-11-02', owner_name: null, marked_done: false })
})

test('会议待办：带 - 的任务列表、[x] 已完成', () => {
  assert.equal(line('- [ ] 买牛奶 @李雷').owner_name, '李雷')
  assert.equal(line('- [x] 买牛奶').marked_done, true)
  assert.equal(line('[√] 买牛奶').marked_done, true)
})

test('会议待办：标题中间的 @ 和邮箱不是负责人', () => {
  assert.deepEqual(line('发邮件到 a@b.com 确认'), { title: '发邮件到 a@b.com 确认', due_date: null, owner_name: null, marked_done: false })
  assert.equal(line('跟 @李雷 对一下需求').owner_name, null)
})

test('行尾的日期：今天明天、2026/11/02、11月2日都认；认不出留在标题', () => {
  assert.equal(line('买牛奶 明天').due_date, addDays(DAY, 1))
  assert.equal(line('买牛奶 2026/11/02').due_date, '2026-11-02')
  assert.equal(line('买牛奶 11月2日').due_date, '2026-11-02')
  assert.equal(line('买牛奶 13-40').due_date, null)
  assert.equal(line('买牛奶 13-40').title, '买牛奶 13-40')
})

test('只有日期的一行不把标题吃掉', () => assert.equal(line('明天').title, '明天'))

test('只写月日取最近的一年：跨年、补记旧事', () => {
  assert.equal(parseImportDate('01-09', '2026-11-20'), '2027-01-09')
  assert.equal(parseImportDate('12-30', '2027-01-03'), '2026-12-30')
  assert.equal(parseImportDate('10-28', '2026-10-31'), '2026-10-28')
  assert.equal(parseImportDate('02-30', '2026-10-31'), null)
})

test('CSV：引号里的逗号和换行不切，"" 是引号', () => {
  assert.deepEqual(parseCsv('a,"b,c"\n"d""e","f\ng"\n'), [['a', 'b,c'], ['d"e', 'f\ng']])
})

test('CSV：没表头时一格一条', () => {
  assert.deepEqual(parseCsvItems('买牛奶,写周报\n交房租\n', DAY).map((r) => r.title), ['买牛奶', '写周报', '交房租'])
})

test('CSV：有表头按列取，看不懂的日期报出来', () => {
  const items = parseCsvItems('事项,负责人,截止\n买牛奶,@李雷,11-02\n写周报,,下个月吧\n,,\n', DAY)
  assert.deepEqual(items.map((i) => [i.title, i.owner_name, i.due_date]), [['买牛奶', '李雷', '2026-11-02'], ['写周报', null, null]])
  const { rows, notices } = shape(items)
  assert.equal(rows[1].note, '原截止：下个月吧')
  assert.match(notices[0], /1 行的截止日期看不懂/)
})

test('超长：按字截断到 200，完整原文进备注，并提示', () => {
  const long = '字'.repeat(250)
  const { rows, notices } = shape([{ title: long }])
  assert.equal([...rows[0].title].length, IMPORT_TITLE_MAX)
  assert.equal(rows[0].truncated, true)
  assert.equal(rows[0].note, long)
  assert.match(notices[0], /1 行超过 200 字/)
})

test('超长：表情不会被切成半个', () => {
  const { rows } = shape([{ title: '😀'.repeat(201) }])
  assert.equal([...rows[0].title].length, 200)
  assert.ok(rows[0].title.isWellFormed())
})

test('超长：长行尾部的 @ 和日期先摘出来，再截断', () => {
  const r = line(`${'字'.repeat(250)} @李雷 11-02`)
  assert.equal(r.owner_name, '李雷')
  assert.equal(r.due_date, '2026-11-02')
})

test('恰好 200 字不算超长', () => assert.equal(shape([{ title: '字'.repeat(200) }]).rows[0].truncated, false))

test('一次最多 500 条，多的明说', () => {
  const { rows, notices } = shape(Array.from({ length: IMPORT_ROWS_MAX + 3 }, (_, i) => ({ title: `第 ${i} 条` })))
  assert.equal(rows.length, IMPORT_ROWS_MAX)
  assert.match(notices[0], /后面 3 条没读/)
})

test('重复：同标题同日期算，日期不同不算', () => {
  const rows = [{ line: 1, title: '买牛奶', due_date: null }, { line: 2, title: '买牛奶', due_date: null }, { line: 3, title: '买牛奶', due_date: '2026-11-02' }]
  const out = markDuplicates(rows, [])
  assert.deepEqual(out.map((r) => r.dup), [null, 'paste', null])
  assert.deepEqual(out.map((r) => r.checked), [true, false, true])
  assert.equal(out[1].dup_line, 1)
})

test('重复：和收件箱里已有的比，未完成优先于已完成', () => {
  const out = markDuplicates([{ line: 1, title: '买牛奶', due_date: null }], [{ title: '买牛奶', due_date: null, status: 'done' }, { title: '买牛奶', due_date: null, status: 'open' }])
  assert.equal(out[0].dup, 'open')
  assert.equal(out[0].checked, false)
})

test('原文已勾完成的默认不勾，但不算重复', () => {
  const out = markDuplicates([{ line: 1, title: '买牛奶', due_date: null, marked_done: true }], [])
  assert.equal(out[0].dup, null)
  assert.equal(out[0].checked, false)
})

test('文件：UTF-8 带 BOM、GBK、UTF-16 都读得出中文', () => {
  assert.equal(decodeText(Buffer.from('﻿买牛奶')), '买牛奶')
  assert.equal(decodeText(Buffer.from([0xc2, 0xf2, 0xc5, 0xa3, 0xc4, 0xcc])), '买牛奶')
  assert.equal(decodeText(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('买牛奶', 'utf16le')])), '买牛奶')
})

test('文件：图片和 PDF 明确说暂不支持，改了后缀也拦得住', () => {
  for (const name of ['白板.png', '合同.pdf', '照片.JPG']) assert.throws(() => readUpload(name, Buffer.from('x'), DAY), (e) => e.status === 415 && /暂不支持/.test(e.message), name)
  assert.throws(() => readUpload('伪装.txt', Buffer.from('%PDF-1.7\n'), DAY), /暂不支持/)
  assert.throws(() => readUpload('伪装.csv', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0]), DAY), /暂不支持/)
})

test('文件：别的后缀、二进制、空文件都给人话', () => {
  assert.throws(() => readUpload('表.xlsx', Buffer.from('x'), DAY), /只支持/)
  assert.throws(() => readUpload('乱码.txt', Buffer.from([1, 0, 2, 0]), DAY), /读不出文字/)
  assert.throws(() => readUpload('空.txt', Buffer.alloc(0), DAY), /空的/)
})

test('文件：.md 走行解析，.csv 走逗号', () => {
  assert.deepEqual(readUpload('a.md', Buffer.from('# 计划\n- 买牛奶, 再买面包\n'), DAY).map((r) => r.title), ['买牛奶, 再买面包'])
  assert.deepEqual(readUpload('a.csv', Buffer.from('买牛奶,写周报'), DAY).map((r) => r.title), ['买牛奶', '写周报'])
})

test('上传：文件名编码不对是 400，不是 500', async () => {
  const r = await alice.rawUpload('%E4%', 'x')
  assert.equal(r.status, 400)
  assert.equal(r.json.error, '文件名不对')
})

test('预览不写库', async () => {
  await preview('买牛奶\n写周报')
  const [[{ n }]] = await h.pool.query('SELECT COUNT(*) AS n FROM inbox_task')
  assert.equal(n, 0)
})

test('预览：会议待办 @ 匹配到人，指派填上', async () => {
  const { rows } = await preview('整理名单 @李雷 11-02')
  assert.equal(rows[0].assignee_id, BOB)
  assert.equal(rows[0].assignee_name, '李雷')
  assert.equal(rows[0].unmatched, false)
  assert.equal(rows[0].owner_name, null)
})

test('预览：@ 匹配失败时保留名字、指派留空并标记，不拿默认指派顶替', async () => {
  await alice.put('/api/settings', { default_assignee_id: BOB })
  const { rows } = await preview('整理名单 @老周 11-02\n没写负责人')
  assert.equal(rows[0].assignee_id, null)
  assert.equal(rows[0].owner_name, '老周')
  assert.equal(rows[0].unmatched, true)
  assert.equal(rows[1].assignee_id, BOB)
})

test('预览：@ 到自己等于没指派，不标记', async () => {
  const { rows } = await preview('整理名单 @王小明')
  assert.equal(rows[0].assignee_id, null)
  assert.equal(rows[0].unmatched, false)
})

test('预览：名字去掉空格也能对上（会议复制时去掉了）', async () => {
  const h2 = await startHarness({ keepData: true, people: [{ id: 11, username: 'a', name: '王小明', active: true, depts: [] }, { id: 31, username: 'li', name: 'Li Lei', active: true, depts: [] }] })
  try {
    const c = await h2.login(ALICE)
    const { rows } = (await c.post('/api/import/preview', { text: '写方案 @LiLei' })).json
    assert.equal(rows[0].assignee_id, 31)
    assert.equal(rows[0].assignee_name, 'Li Lei')
  } finally {
    await h2.close()
  }
})

test('预览：平台名单拉不到时不卡住，按待确认处理并提示', async () => {
  const h2 = await startHarness({ keepData: true })
  try {
    h2.platform.state.usersDown = true
    const c = await h2.login(ALICE)
    const r = await c.post('/api/import/preview', { text: '整理名单 @李雷' })
    assert.equal(r.status, 200)
    assert.equal(r.json.rows[0].unmatched, true)
    assert.match(r.json.notices.join(), /名单暂时拉不到/)
  } finally {
    await h2.close()
  }
})

test('预览勾选：重复项灰显数据、默认不勾；已完成的也算', async () => {
  await tasks.create(ALICE, { title: '已有的事', due_date: '2030-01-02' })
  const done = (await tasks.create(ALICE, { title: '做完的事' })).task
  await tasks.setStatus(ALICE, done.id, 'done')
  const out = await preview('已有的事 2030-01-02\n已有的事\n做完的事\n新的事\n新的事')
  assert.deepEqual(out.rows.map((r) => r.dup), ['open', null, 'done', null, 'paste'])
  assert.deepEqual(out.rows.map((r) => r.checked), [false, true, false, true, false])
  assert.equal(out.duplicates, 3)
})

test('预览：归档的不算重复；标题比较逐字，大小写不同不算', async () => {
  const a = (await tasks.create(ALICE, { title: '归档的' })).task
  await tasks.batch(ALICE, 'archive', [a.id])
  await tasks.create(ALICE, { title: 'abc' })
  assert.deepEqual((await preview('归档的\nABC')).rows.map((r) => r.dup), [null, null])
})

test('预览：改了标题后重新判重', async () => {
  await tasks.create(ALICE, { title: '已有的事' })
  const r = await alice.post('/api/import/check', { rows: [{ line: 1, title: '已有的事', due_date: null }, { line: 2, title: '改过了', due_date: null }, { line: 3, title: '改过了', due_date: null }] })
  assert.deepEqual(r.json.rows, [{ line: 1, dup: 'open', dup_line: null }, { line: 2, dup: null, dup_line: null }, { line: 3, dup: 'paste', dup_line: 2 }])
})

test('预览：空内容、超限给人话', async () => {
  assert.equal((await alice.post('/api/import/preview', { text: '  ' })).status, 400)
  assert.equal((await alice.post('/api/import/preview', { text: '---\n\n' })).status, 400)
  assert.equal((await alice.post('/api/import/preview', { text: 'x'.repeat(FILE_MAX + 1) })).status, 413)
})

test('上传：图片 415，超过 2MB 413，正常文件返回预览', async () => {
  const png = await alice.upload('白板照片.png', 'x')
  assert.equal(png.status, 415)
  assert.match(png.json.error, /图片和 PDF 暂不支持/)
  const big = await alice.upload('大.txt', Buffer.alloc(FILE_MAX + 1, 'a'))
  assert.equal(big.status, 413)
  assert.equal(big.json.error, '文件不能超过 2MB')
  const ok = await alice.upload('待办.txt', '- 买牛奶\n- 写周报\n')
  assert.deepEqual(ok.json.rows.map((r) => r.title), ['买牛奶', '写周报'])
})

test('提交：只写勾上的，默认没日期，来源记成 app，事件留痕', async () => {
  const r = await alice.post('/api/import/commit', { rows: [{ title: '买牛奶', due_date: '2030-01-02' }, { title: '写周报' }] })
  assert.equal(r.status, 201)
  assert.equal(r.json.created, 2)
  const [rows] = await h.pool.query('SELECT title, due_date, source, owner_id FROM inbox_task ORDER BY id')
  assert.deepEqual(rows.map((x) => ({ ...x })), [{ title: '买牛奶', due_date: '2030-01-02', source: 'app', owner_id: ALICE }, { title: '写周报', due_date: null, source: 'app', owner_id: ALICE }])
  const [events] = await h.pool.query('SELECT action, detail FROM inbox_event WHERE task_id = ?', [r.json.ids[0]])
  assert.equal(events[0].action, 'create')
  assert.equal(events[0].detail.via, 'import')
})

test('提交：人勾上重复项就是要它，导入不去重', async () => {
  await tasks.create(ALICE, { title: '买牛奶' })
  await alice.post('/api/import/commit', { rows: [{ title: '买牛奶' }, { title: '买牛奶' }] })
  const [[{ n }]] = await h.pool.query("SELECT COUNT(*) AS n FROM inbox_task WHERE title = '买牛奶'")
  assert.equal(n, 3)
})

test('提交：没匹配到的负责人存成标记，列表能看到', async () => {
  const r = await alice.post('/api/import/commit', { rows: [{ title: '整理名单', owner_name: '老周' }] })
  const [[row]] = await h.pool.query('SELECT assignee_id, tags FROM inbox_task WHERE id = ?', [r.json.ids[0]])
  assert.equal(row.assignee_id, null)
  assert.deepEqual(row.tags, ['负责人待确认：老周'])
  const { text } = await alice.get('/api/list.html?view=open')
  assert.match(text, /<span>指派 老周（待确认）<\/span>/)
  assert.ok(!text.includes('yh-tag'), '待确认不用药丸')
})

test('提交：一条不合法整批不进', async () => {
  const r = await alice.post('/api/import/commit', { rows: [{ title: '好的' }, { title: '  ' }] })
  assert.equal(r.status, 400)
  assert.match(r.json.error, /第 2 条/)
  const [[{ n }]] = await h.pool.query('SELECT COUNT(*) AS n FROM inbox_task')
  assert.equal(n, 0)
})

test('提交：标题超 200、超量、指派给不存在的人都拒绝', async () => {
  assert.equal((await alice.post('/api/import/commit', { rows: [{ title: '字'.repeat(201) }] })).status, 400)
  assert.equal((await alice.post('/api/import/commit', { rows: Array.from({ length: IMPORT_ROWS_MAX + 1 }, (_, i) => ({ title: `${i}` })) })).status, 400)
  assert.equal((await alice.post('/api/import/commit', { rows: [{ title: 'x', assignee_id: 9999 }] })).status, 400)
  assert.equal((await alice.post('/api/import/commit', { rows: [] })).status, 400)
})

test('提交：一次导给同一个人只通知一条', async () => {
  await alice.post('/api/import/commit', { rows: [{ title: '一', assignee_id: BOB }, { title: '二', assignee_id: BOB }] })
  await new Promise((r) => setTimeout(r, 30))
  const notes = h.platform.state.notifications
  assert.equal(notes.length, 1)
  assert.match(notes[0].title, /指派给你 2 件事/)
})

test('导入页：入口和暂不支持都写明', async () => {
  const { status, text } = await alice.get('/import')
  assert.equal(status, 200)
  assert.ok(text.includes('图片和 PDF 暂不支持导入'))
  assert.ok(text.includes('accept=".txt,.md,.csv"'))
  assert.ok(text.includes(`一次最多 ${IMPORT_ROWS_MAX} 条`))
})
