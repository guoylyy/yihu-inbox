// 导入接口：预览不写库，提交才写。预览的「重复」只是默认不勾，提交的就是人勾上的那些
import express from 'express'
import { todayIn } from '../dates.js'
import { HttpError } from '../tasks.js'
import { FILE_MAX, IMPORT_ROWS_MAX, IMPORT_TITLE_MAX, UNMATCHED_PREFIX, markDuplicates, parseText, readUpload, shape } from '../import.js'
import { matchAssignee } from '../platform-users.js'

const CANDIDATES_MAX = 5
const squeeze = (s) => String(s).replace(/\s+/g, '')
const brief = ({ id, name, dept }) => ({ id, name, dept })

function fileName(req) {
  try {
    return decodeURIComponent(String(req.headers['x-file-name'] ?? ''))
  } catch {
    throw new HttpError(400, '文件名不对')
  }
}

export function importRouter({ ws, tasks, settings, users, requireReady, requireUser, wrap, checkAssignee, notifyMany }) {
  const r = express.Router()
  const data = [requireReady, requireUser]

  const tooLarge = (message) => (e, req, res, next) => next(e?.type === 'entity.too.large' ? new HttpError(413, message) : e?.type === 'entity.parse.failed' ? new HttpError(400, '请求内容不对') : e)
  const rawBody = express.raw({ type: () => true, limit: FILE_MAX })
  const jsonBody = express.json({ limit: FILE_MAX * 2 }) // 中文转义后比原文长，上限放到两倍，字数在下面按 2MB 算

  // 名字对人：会议复制时去掉了名字里的空格（Li Lei → @LiLei），这里两边都去掉再比
  async function resolvePeople(rows, me) {
    const named = rows.filter((row) => row.owner_name)
    let people = null
    if (named.length) people = await users.all().catch(() => null)
    const active = (people ?? []).filter((u) => u.active).map((u) => ({ ...u, name: squeeze(u.name), real: u.name }))
    const others = active.filter((u) => u.id !== me.id)
    const myName = squeeze(me.name ?? '')
    const cfg = await settings.get(me.id)
    const fallback = await defaultPerson(cfg.default_assignee_id)
    const out = rows.map((row) => {
      const base = { ...row, assignee_id: null, assignee_name: null, unmatched: false, candidates: [] }
      if (!row.owner_name) return fallback ? { ...base, assignee_id: fallback.id, assignee_name: fallback.name } : base
      if (squeeze(row.owner_name) === myName) return { ...base, owner_name: null } // @我自己 等于没指派
      const { user, candidates } = matchAssignee(others, squeeze(row.owner_name))
      if (user) return { ...base, assignee_id: user.id, assignee_name: user.real, owner_name: null }
      return { ...base, unmatched: true, candidates: candidates.slice(0, CANDIDATES_MAX).map((u) => brief({ ...u, name: u.real })) }
    })
    return { rows: out, peopleDown: named.length > 0 && !people }
  }

  async function defaultPerson(id) {
    if (!id) return null
    const people = await users.all().catch(() => [])
    const found = people.find((u) => u.id === id && u.active)
    return found ? { id: found.id, name: found.name } : null
  }

  async function preview(items, me) {
    const { rows, notices } = shape(items)
    if (!rows.length) throw new HttpError(400, '没有读到可以导入的内容')
    const existing = await tasks.findSame(me.id, rows.map((row) => row.title))
    const { rows: resolved, peopleDown } = await resolvePeople(markDuplicates(rows, existing), me)
    if (peopleDown) notices.push('平台名单暂时拉不到，@ 的人先按待确认处理')
    const dup = resolved.filter((row) => row.dup).length
    return { rows: resolved, notices, total: resolved.length, duplicates: dup, max: IMPORT_ROWS_MAX, title_max: IMPORT_TITLE_MAX }
  }

  r.post('/preview', data, jsonBody, tooLarge('粘贴的内容不能超过 2MB'), wrap(async (req, res) => {
    const text = String(req.body?.text ?? '')
    if (Buffer.byteLength(text) > FILE_MAX) throw new HttpError(413, '粘贴的内容不能超过 2MB')
    if (!text.trim()) throw new HttpError(400, '先粘贴要导入的内容')
    ws.track(req.me, 'import.preview', { kind: 'paste' })
    res.json(await preview(parseText(text, todayIn()), req.me))
  }))

  r.post('/file', data, rawBody, tooLarge('文件不能超过 2MB'), wrap(async (req, res) => {
    const items = readUpload(fileName(req), Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0), todayIn())
    ws.track(req.me, 'import.preview', { kind: 'file' })
    res.json(await preview(items, req.me))
  }))

  // 预览里改了标题或日期，重新判一次重复。勾选由页面保留
  r.post('/check', data, jsonBody, tooLarge('内容太多'), wrap(async (req, res) => {
    const rows = Array.isArray(req.body?.rows) ? req.body.rows.slice(0, IMPORT_ROWS_MAX) : []
    const clean = rows.map((row, i) => ({ line: row.line ?? i + 1, title: String(row.title ?? '').trim(), due_date: row.due_date || null }))
    const existing = await tasks.findSame(req.me.id, clean.map((row) => row.title).filter(Boolean))
    res.json({ rows: markDuplicates(clean, existing).map(({ line, dup, dup_line }) => ({ line, dup, dup_line })) })
  }))

  r.post('/commit', data, jsonBody, tooLarge('内容太多'), wrap(async (req, res) => {
    const rows = req.body?.rows
    if (!Array.isArray(rows) || !rows.length) throw new HttpError(400, '先勾选要导入的事')
    if (rows.length > IMPORT_ROWS_MAX) throw new HttpError(400, `一次最多导入 ${IMPORT_ROWS_MAX} 条`)
    const clean = rows.map((row, i) => {
      const title = String(row.title ?? '').trim()
      if ([...title].length > IMPORT_TITLE_MAX) throw new HttpError(400, `第 ${i + 1} 条：标题不能超过 ${IMPORT_TITLE_MAX} 字`)
      const owner = !row.assignee_id && row.owner_name ? String(row.owner_name).trim() : ''
      return { title, note: row.note, due_date: row.due_date, assignee_id: row.assignee_id, tags: owner ? [`${UNMATCHED_PREFIX}${[...owner].slice(0, 50).join('')}`] : [] }
    })
    for (const id of new Set(clean.map((row) => row.assignee_id).filter(Boolean))) await checkAssignee(id, req.me)
    const created = await tasks.createMany(req.me.id, clean)
    ws.track(req.me, 'task.import', { count: created.length })
    notifyMany(created, req.me).catch(() => {})
    res.status(201).json({ created: created.length, ids: created.map((t) => t.id) })
  }))

  return r
}
