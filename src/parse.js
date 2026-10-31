// 一句话解析：平台模型把一句话变成结构化任务。这里永远不抛错——模型坏了就整句当标题，录入不能被 AI 卡住
import { daysBetween, isValidDate, weekdayOf } from './dates.js'
import { TITLE_MAX } from './tasks.js'

const WEEKDAYS = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六']
const TIMEOUT_MS = 8000
const ASSIGNEE_MAX = 50

export const INPUT_MAX = 500

export function buildPrompt(today, tz) {
  return `你是待办解析器。把用户的一句话解析成一条待办，只输出一个 JSON 对象，不要解释，不要代码块。

今天是 ${today} ${WEEKDAYS[weekdayOf(today)]}（时区 ${tz}）。

字段：
- title：要做的事。去掉已经提取走的时间词、优先级词和指派对象，其余保留原话，不改写人名和事项
- due_date：截止日期 YYYY-MM-DD；没提到时间就是 null
- due_time：具体时刻 HH:mm（24 小时制）；没提到时刻就是 null
- priority：3 高（重要、紧急、尽快、务必、马上）；2 中（比较重要、尽量）；1 低（不急、有空再说）；0 没提到
- assignee：如果这句话里出现了「给某某」「让某某」「某某负责」，原样输出那个人名（不要猜全名，不要改字）；没有就是 null。这里的「给」是把事交给这个人做；「发给张三」「交给张三审」里的张三只是事情的对象，不算

日期规则：「周三」指本周三，本周三已过就是下周三；「下周三」指下一周的周三（周一算一周开始）；「月底」指当月最后一天；只说了时刻没说哪天就是今天。

示例（假设今天是 2026-03-02 星期一）：
输入：明天下午三点前把合同发给张三，重要
输出：{"title":"把合同发给张三","due_date":"2026-03-03","due_time":"15:00","priority":3,"assignee":null}
输入：买牛奶
输出：{"title":"买牛奶","due_date":null,"due_time":null,"priority":0,"assignee":null}
输入：周五前不急的话把周报整理一下
输出：{"title":"把周报整理一下","due_date":"2026-03-06","due_time":null,"priority":1,"assignee":null}
输入：给老周：下周一前整理报价单
输出：{"title":"整理报价单","due_date":"2026-03-09","due_time":null,"priority":0,"assignee":"老周"}
输入：让李雷明天把合同发给张三
输出：{"title":"把合同发给张三","due_date":"2026-03-03","due_time":null,"priority":0,"assignee":"李雷"}`
}

export const fallback = (text) => ({ title: text, due_date: null, priority: 0, note: null, assignee: null, parsed: false })

/** 从模型回复里取 JSON：模型可能包代码块、带思考过程，取最外层一对花括号 */
function extractJson(content) {
  const s = String(content ?? '')
  const start = s.indexOf('{')
  const end = s.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try { return JSON.parse(s.slice(start, end + 1)) } catch { return null }
}

/** 逐字段收敛模型输出：标题不合格整条作废，其余字段不合格就留空，让用户在确认时自己填 */
export function normalizeParsed(raw, text, today) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fallback(text)
  const title = typeof raw.title === 'string' ? raw.title.trim() : ''
  if (!title || [...title].length > TITLE_MAX) return fallback(text)
  const due = isValidDate(raw.due_date) && Math.abs(daysBetween(today, raw.due_date)) <= 3660 ? raw.due_date : null
  const priority = Number.isInteger(raw.priority) && raw.priority >= 0 && raw.priority <= 3 ? raw.priority : 0
  const time = typeof raw.due_time === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(raw.due_time) ? raw.due_time : null
  // 人名必须是原话里的字，模型补全或编出来的不要
  const name = typeof raw.assignee === 'string' ? raw.assignee.trim() : ''
  const assignee = name && [...name].length <= ASSIGNEE_MAX && text.includes(name) ? name : null
  // 数据只存日期，时刻落到备注里，确认时能看到，不悄悄丢掉
  return { title, due_date: due, priority, note: due && time ? `截止 ${time}` : null, assignee, parsed: true }
}

function withTimeout(promise, ms) {
  let timer
  const limit = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`超过 ${ms}ms`)), ms) })
  return Promise.race([promise, limit]).finally(() => clearTimeout(timer))
}

/**
 * llm 是 ws.llm（或测试里的假模型）；没有 llm 时直接降级
 * 只把失败原因打到日志，不打用户原文
 */
export async function parseQuickInput(rawText, { llm, today, tz, timeoutMs = TIMEOUT_MS }) {
  const text = String(rawText ?? '').trim()
  if (!llm) return fallback(text)
  try {
    const r = await withTimeout(llm({
      temperature: 0,
      max_tokens: 200,
      messages: [{ role: 'system', content: buildPrompt(today, tz) }, { role: 'user', content: text }]
    }), timeoutMs)
    const out = normalizeParsed(extractJson(r?.choices?.[0]?.message?.content), text, today)
    if (!out.parsed) console.warn('[inbox] 模型回复解析不出任务，按原文录入')
    return out
  } catch (e) {
    console.warn(`[inbox] 模型不可用，按原文录入：${e.message}`)
    return fallback(text)
  }
}
