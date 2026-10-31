import test from 'node:test'
import assert from 'node:assert/strict'
import { addDays, clockIn, dueLabel, endOfWeek, isValidDate, parseDueWord, todayIn } from '../src/dates.js'

const FRI = '2026-10-30' // 星期五
const MON = '2026-10-26'

test('相对文案：今天', () => assert.equal(dueLabel(FRI, FRI).text, '今天'))
test('相对文案：明天', () => assert.equal(dueLabel('2026-10-31', FRI).text, '明天'))
test('相对文案：本周内显示周几', () => assert.equal(dueLabel('2026-10-28', MON).text, '周三'))
test('相对文案：周日也算本周', () => assert.equal(dueLabel('2026-11-01', MON).text, '周日'))
test('相对文案：逾期天数并标红', () => {
  assert.deepEqual(dueLabel('2026-10-28', FRI), { text: '逾期 2 天', overdue: true })
  assert.deepEqual(dueLabel('2026-10-29', FRI), { text: '逾期 1 天', overdue: true })
})
test('相对文案：跨月逾期天数正确', () => assert.equal(dueLabel('2026-09-30', FRI).text, '逾期 30 天'))
test('相对文案：下周之后显示日期，跨年带年份', () => {
  assert.equal(dueLabel('2026-11-05', FRI).text, '11月5日')
  assert.equal(dueLabel('2027-01-05', FRI).text, '2027年1月5日')
})
test('相对文案：没有日期为空', () => assert.deepEqual(dueLabel(null, FRI), { text: '', overdue: false }))

test('周日是一周最后一天', () => {
  assert.equal(endOfWeek(MON), '2026-11-01')
  assert.equal(endOfWeek('2026-11-01'), '2026-11-01')
})

test('今天按配置的时区算，不按服务器 UTC', () => {
  const now = new Date('2026-10-30T17:00:00Z') // 上海已是 31 号凌晨 1 点
  assert.equal(todayIn('Asia/Shanghai', now), '2026-10-31')
  assert.equal(todayIn('UTC', now), '2026-10-30')
  assert.deepEqual(clockIn('Asia/Shanghai', new Date('2026-10-30T00:30:00Z')), { hour: 8, minute: 30 })
})

test('isValidDate 拒绝不存在的日期和垃圾', () => {
  assert.ok(isValidDate('2028-02-29'))
  assert.ok(!isValidDate('2026-02-30'))
  assert.ok(!isValidDate('明天'))
  assert.ok(!isValidDate(20261030))
})

test('parseDueWord 认随口说的日期', () => {
  assert.equal(parseDueWord('2026-11-03', FRI), '2026-11-03')
  assert.equal(parseDueWord('今天', FRI), FRI)
  assert.equal(parseDueWord('明天', FRI), '2026-10-31')
  assert.equal(parseDueWord('后天', FRI), '2026-11-01')
  assert.equal(parseDueWord('3天后', FRI), '2026-11-02')
  assert.equal(parseDueWord('下周一', FRI), '2026-11-02')
  assert.equal(parseDueWord('星期六', FRI), '2026-10-31')
  assert.equal(parseDueWord('周三', FRI), '2026-11-04') // 本周三已过
  assert.equal(parseDueWord('本周三', FRI), '2026-10-28')
  assert.equal(parseDueWord('随便哪天', FRI), null)
})

test('addDays 跨年', () => assert.equal(addDays('2026-12-31', 1), '2027-01-01'))
