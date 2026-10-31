import test from 'node:test'
import assert from 'node:assert/strict'
import { buildPrompt, fallback, normalizeParsed, parseQuickInput } from '../src/parse.js'

const today = '2026-10-30'
const SENTENCE = '明天下午三点前把合同发给张三，重要'
const reply = (content) => async () => ({ choices: [{ message: { content } }] })
const parse = (llm, opts = {}) => parseQuickInput(SENTENCE, { llm, today, tz: 'Asia/Shanghai', ...opts })

test('正常 JSON：标题、日期、优先级都解析出来，时刻进备注', async () => {
  const out = await parse(reply('{"title":"把合同发给张三","due_date":"2026-10-31","due_time":"15:00","priority":3}'))
  assert.deepEqual(out, { title: '把合同发给张三', due_date: '2026-10-31', priority: 3, note: '截止 15:00', assignee: null, parsed: true })
})

test('模型把 JSON 包在代码块里也能取出来', async () => {
  const out = await parse(reply('好的：\n```json\n{"title":"买牛奶","due_date":null,"due_time":null,"priority":0}\n```'))
  assert.equal(out.title, '买牛奶')
  assert.equal(out.parsed, true)
})

test('模型返回垃圾：整句进标题，不报错', async () => {
  for (const junk of ['我不太明白您的意思', '', '{坏 json}', '[1,2,3]', 'null', '{"title":""}', '{"title":123}']) {
    assert.deepEqual(await parse(reply(junk)), fallback(SENTENCE), junk)
  }
})

test('回复结构不对（没有 choices）也降级', async () => {
  assert.deepEqual(await parse(async () => ({})), fallback(SENTENCE))
})

test('模型超时：按时返回原文，晚到的结果不影响', async () => {
  const started = Date.now()
  const slow = () => new Promise((resolve) => setTimeout(() => resolve({ choices: [] }), 400))
  const out = await parse(slow, { timeoutMs: 30 })
  assert.deepEqual(out, fallback(SENTENCE))
  assert.ok(Date.now() - started < 300)
})

test('模型一直不回：也不会挂住', async () => {
  assert.deepEqual(await parse(() => new Promise(() => {}), { timeoutMs: 20 }), fallback(SENTENCE))
})

test('模型抛错：降级', async () => {
  assert.deepEqual(await parse(async () => { throw new Error('429') }), fallback(SENTENCE))
})

test('没有 LLM：整句进标题', async () => {
  assert.deepEqual(await parse(null), { title: SENTENCE, due_date: null, priority: 0, note: null, assignee: null, parsed: false })
})

test('字段不合格只丢该字段，标题保留', () => {
  const out = normalizeParsed({ title: '写周报', due_date: '2026-02-30', priority: 9, due_time: '25:00' }, SENTENCE, today)
  assert.deepEqual(out, { title: '写周报', due_date: null, priority: 0, note: null, assignee: null, parsed: true })
})

test('字符串优先级、离谱年份不接受', () => {
  const out = normalizeParsed({ title: '写周报', due_date: '1999-01-01', priority: '3' }, SENTENCE, today)
  assert.equal(out.due_date, null)
  assert.equal(out.priority, 0)
})

test('超长标题作废，退回原文', () => {
  assert.deepEqual(normalizeParsed({ title: '长'.repeat(501) }, SENTENCE, today), fallback(SENTENCE))
})

test('提示词里有今天的日期和星期', () => {
  const p = buildPrompt(today, 'Asia/Shanghai')
  assert.match(p, /今天是 2026-10-30 星期五/)
  assert.match(p, /Asia\/Shanghai/)
})
