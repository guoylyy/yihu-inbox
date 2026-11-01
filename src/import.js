// 导入：把粘贴的文字或上传的文件变成预览行。这里只解析不写库，人看过、勾过才入库
//   图片、PDF 明确拒绝，不假装能读
import path from 'node:path'
import { parseImportDate } from './dates.js'
import { HttpError, NOTE_MAX } from './tasks.js'

export const IMPORT_TITLE_MAX = 200
export const IMPORT_ROWS_MAX = 500
export const FILE_MAX = 2 * 1024 * 1024
export const ACCEPT = ['.txt', '.md', '.csv']
export const UNSUPPORTED = '图片和 PDF 暂不支持导入，请把文字复制出来粘贴'
export const UNMATCHED_PREFIX = '负责人待确认：'
const NAME_MAX = 50
const PICTURE_EXT = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.heic', '.bmp', '.pdf']

const clip = (s, max) => [...s].slice(0, max).join('')
const lengthOf = (s) => [...s].length

const HEADING = /^#{1,6}\s/
const RULE = /^[-*_=]{3,}$/
const BULLET = /^(?:[-*+•·▪]\s+|[-*•·▪](?=[^\s\d*-]))/
// 1.5 倍这种不是序号：序号后面紧跟数字就不剥
const NUMBERED = /^(?:\d{1,3}[.、)）]\s*(?!\d)|[（(]\d{1,3}[）)]\s*)/
const CHECKBOX = /^\[([ xX√✓]?)\]\s*/

const lastToken = (s) => /(?:^|\s)(\S+)\s*$/.exec(s)

/** 从行尾依次摘掉日期和 @负责人，标题里的 a@b.com 不受影响 */
function splitTail(text, today) {
  let title = text
  let due = null
  let owner = null
  for (let i = 0; i < 2; i++) {
    const m = lastToken(title)
    if (!m || m.index === 0) break
    const at = /^[@＠](.+)$/.exec(m[1])
    const date = at ? null : parseImportDate(m[1], today)
    if (at && !owner) owner = at[1]
    else if (date && !due) due = date
    else break
    title = title.slice(0, m.index).trim()
  }
  return { title, due, owner }
}

/** 一行 → 一条。不是待办的行（空行、分隔线、Markdown 标题）返回 null */
export function parseLine(raw, today) {
  let s = String(raw ?? '').trim()
  if (!s || RULE.test(s) || HEADING.test(s)) return null
  s = s.replace(BULLET, '').replace(NUMBERED, '').trim()
  const box = CHECKBOX.exec(s)
  if (box) s = s.slice(box[0].length).trim()
  const { title, due, owner } = splitTail(s, today)
  if (!title) return null
  return { title, due_date: due, owner_name: owner, marked_done: !!box && box[1].trim() !== '' }
}

/** 按行切：\r\n、\r、\n 都算 */
export const parseText = (text, today) => String(text ?? '').split(/\r\n?|\n/).map((l) => parseLine(l, today)).filter(Boolean)

/** RFC 4180：引号里的逗号和换行不切，"" 是一个引号 */
export function parseCsv(text) {
  const rows = []
  let row = []
  let cell = ''
  let quoted = false
  const s = String(text ?? '')
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (quoted) {
      if (c === '"' && s[i + 1] === '"') { cell += '"'; i++ } else if (c === '"') quoted = false
      else cell += c
    } else if (c === '"' && !cell) quoted = true
    else if (c === ',') { row.push(cell); cell = '' }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++
      row.push(cell)
      rows.push(row)
      row = []
      cell = ''
    } else cell += c
  }
  if (cell || row.length) { row.push(cell); rows.push(row) }
  return rows.filter((r) => r.some((c) => c.trim()))
}

const HEADS = {
  title: /^(标题|事项|任务|待办|内容|title|task|todo)$/i,
  owner: /^(负责人|指派|指派给|责任人|owner|assignee)$/i,
  due: /^(截止|截止日|截止日期|截止时间|日期|due|due[ _]?date|deadline)$/i
}

/** 有表头按列取；没有表头就是一串用逗号、换行分开的事，一格一条 */
export function parseCsvItems(text, today) {
  const rows = parseCsv(text)
  if (!rows.length) return []
  const find = (re) => rows[0].findIndex((c) => re.test(c.trim()))
  const col = { title: find(HEADS.title), owner: find(HEADS.owner), due: find(HEADS.due) }
  if (col.title < 0) return rows.flat().map((c) => parseLine(c, today)).filter(Boolean)
  return rows.slice(1).flatMap((r) => {
    const title = (r[col.title] ?? '').trim()
    if (!title) return []
    const dueText = col.due < 0 ? '' : (r[col.due] ?? '').trim()
    const due = dueText ? parseImportDate(dueText, today) : null
    const owner = col.owner < 0 ? '' : (r[col.owner] ?? '').trim().replace(/^[@＠]/, '')
    return [{ title, due_date: due, owner_name: owner || null, marked_done: false, bad_due: dueText && !due ? dueText : null }]
  })
}

/** 截断、限量都在这里，提示一起给出去。截掉的字进备注，不丢 */
export function shape(items) {
  const notices = []
  const over = items.length - IMPORT_ROWS_MAX
  const kept = over > 0 ? items.slice(0, IMPORT_ROWS_MAX) : items
  if (over > 0) notices.push(`一次最多导入 ${IMPORT_ROWS_MAX} 条，后面 ${over} 条没读`)
  const rows = kept.map((item, i) => {
    const owner = item.owner_name ? clip(item.owner_name, NAME_MAX) : null
    const truncated = lengthOf(item.title) > IMPORT_TITLE_MAX
    const notes = []
    if (truncated) notes.push(clip(item.title, NOTE_MAX))
    if (item.bad_due) notes.push(`原截止：${item.bad_due}`)
    return {
      line: i + 1,
      title: truncated ? clip(item.title, IMPORT_TITLE_MAX) : item.title,
      due_date: item.due_date,
      owner_name: owner,
      marked_done: item.marked_done,
      truncated,
      note: notes.join('\n') || null
    }
  })
  const cut = rows.filter((r) => r.truncated).length
  if (cut) notices.push(`${cut} 行超过 ${IMPORT_TITLE_MAX} 字，标题已截断，完整原文放进备注`)
  const badDue = kept.filter((i) => i.bad_due).length
  if (badDue) notices.push(`${badDue} 行的截止日期看不懂，原文放进备注，日期留空`)
  return { rows, notices }
}

export const keyOf = (title, due) => `${title}\u0000${due ?? ''}`

/**
 * 标重复：同标题同日期算重复。和收件箱里已有的比，也和这次粘贴里前面的行比。
 * 只是灰显、默认不勾，人勾上还是会导入
 */
export function markDuplicates(rows, existing) {
  const known = new Map()
  for (const t of existing) {
    const key = keyOf(t.title, t.due_date)
    if (known.get(key) !== 'open') known.set(key, t.status)
  }
  const seen = new Map()
  return rows.map((r) => {
    const key = keyOf(r.title, r.due_date)
    const dup = known.has(key) ? (known.get(key) === 'open' ? 'open' : 'done') : seen.has(key) ? 'paste' : null
    const out = { ...r, dup, dup_line: dup === 'paste' ? seen.get(key) : null, checked: !dup && !r.marked_done }
    if (!seen.has(key)) seen.set(key, r.line)
    return out
  })
}

const hasBinary = (buf) => {
  const head = buf.subarray(0, 8000)
  return head.includes(0)
}
const looksLikePicture = (buf) => {
  const sig = buf.subarray(0, 4).toString('latin1')
  return sig === '%PDF' || sig === '\u0089PNG' || sig.startsWith('ÿØÿ') || sig === 'GIF8'
}

/** Excel 存的 csv 多半是 GBK 或 UTF-16，都要认 */
export function decodeText(buf) {
  if (buf[0] === 0xff && buf[1] === 0xfe) return new TextDecoder('utf-16le').decode(buf.subarray(2))
  if (buf[0] === 0xfe && buf[1] === 0xff) return new TextDecoder('utf-16be').decode(buf.subarray(2))
  if (looksLikePicture(buf)) throw new HttpError(415, UNSUPPORTED)
  if (hasBinary(buf)) throw new HttpError(415, `读不出文字，只支持 ${ACCEPT.join('、')}`)
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf).replace(/^﻿/, '')
  } catch {
    return new TextDecoder('gb18030').decode(buf)
  }
}

/** 上传的文件 → 条目。扩展名和内容都查：改了后缀的 PDF 也拦得住 */
export function readUpload(rawName, buf, today) {
  const ext = path.extname(String(rawName ?? '').replace(/\\/g, '/')).toLowerCase()
  if (PICTURE_EXT.includes(ext)) throw new HttpError(415, UNSUPPORTED)
  if (!ACCEPT.includes(ext)) throw new HttpError(415, `只支持 ${ACCEPT.join('、')}`)
  if (!buf?.length) throw new HttpError(400, '文件是空的')
  const text = decodeText(buf)
  return ext === '.csv' ? parseCsvItems(text, today) : parseText(text, today)
}
