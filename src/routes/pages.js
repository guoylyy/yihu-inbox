// 页面：列表、导入、设置、关于都由服务端渲染
import express from 'express'
import { basePathOf } from '../yh-one.mjs'
import { VERSION } from '../version.js'
import { VIEWS } from '../tasks.js'
import { INPUT_MAX } from '../parse.js'
import { ACCEPT, FILE_MAX, IMPORT_ROWS_MAX, IMPORT_TITLE_MAX, UNSUPPORTED } from '../import.js'
import { DEDUPE_RULE, DIGEST_TIMES, QUICK_DUES } from '../settings.js'
import { pushEnabled } from '../digest.js'
import { aboutInfo } from '../about.js'
import { listData, railData } from './list.js'

const VIEW_TABS = [['today', '今天'], ['week', '本周'], ['open', '全部'], ['done', '已完成']]

export function pageRouter(ctx) {
  const { ws, tasks, settings, users, modelInfo, pool, getReady, userOf, wrap } = ctx
  const r = express.Router()
  const page = (req, scripts = []) => {
    const me = userOf(req)
    return { base: `${basePathOf(req)}/`, version: VERSION, scripts, me, initial: [...(me?.name ?? '')][0] ?? '我', hosted: ws.enabled }
  }

  const problemOf = (req) => {
    if (!userOf(req)) return '应用未接入平台，请联系管理员'
    return tasks && getReady() ? null : '数据库还没准备好，稍后刷新'
  }

  /** 默认指派的人还在不在。名单拉不到时按 id 显示，不算不在 */
  async function defaultPerson(id) {
    if (!id) return { id: null, name: '', gone: false }
    const people = await users.all().catch(() => null)
    if (!people) return { id, name: `用户 ${id}`, gone: false }
    const found = people.find((u) => u.id === id && u.active)
    return found ? { id, name: found.name, gone: false } : { id: null, name: '', gone: true }
  }

  r.get('/', wrap(async (req, res) => {
    const me = userOf(req)
    const problem = problemOf(req)
    const shell = { ...page(req, ['home', 'batch']), tabs: VIEW_TABS, inputMax: INPUT_MAX, view: 'today', tasks: [], total: 0, report: null, rail: null, problem }
    if (problem) return res.status(503).render('index', shell)
    const view = VIEWS.includes(req.query.view) ? req.query.view : 'today'
    ws.track(me, 'home.view', { view })
    res.render('index', { ...shell, ...await listData(ctx, me, view), rail: await railData(ctx, me) })
  }))

  r.get('/import', wrap(async (req, res) => {
    const problem = problemOf(req)
    if (problem) return res.status(503).render('missing', { ...page(req), message: problem })
    ws.track(userOf(req), 'import.view', {})
    res.render('import', { ...page(req, ['import']), accept: ACCEPT.join(','), acceptLabel: ACCEPT.join('、'), fileMax: FILE_MAX, rowsMax: IMPORT_ROWS_MAX, titleMax: IMPORT_TITLE_MAX, unsupported: UNSUPPORTED })
  }))

  r.get('/settings', wrap(async (req, res) => {
    const me = userOf(req)
    const problem = problemOf(req)
    if (problem) return res.status(503).render('missing', { ...page(req), message: problem })
    const cfg = await settings.get(me.id)
    res.render('settings', {
      ...page(req, ['settings']),
      cfg,
      person: await defaultPerson(cfg.default_assignee_id),
      digestTimes: DIGEST_TIMES,
      quickDues: QUICK_DUES,
      dedupeRule: DEDUPE_RULE,
      pushOn: ws.enabled && pushEnabled(),
      canPick: users.available
    })
  }))

  r.get('/about', wrap(async (req, res) => {
    const problem = userOf(req) ? null : '应用未接入平台，请联系管理员'
    if (problem) return res.status(503).render('missing', { ...page(req), message: problem })
    res.render('about', { ...page(req), info: await aboutInfo({ pool, modelInfo, hosted: ws.enabled }) })
  }))

  // 退出：清本应用会话，再让平台也退出。本地单人模式没有平台，回首页
  r.get('/logout', (req, res) => {
    if (!ws.enabled) return res.redirect(302, `${basePathOf(req)}/`)
    ws.logout(req)
    res.redirect(302, ws.logoutUrl(req))
  })

  return r
}
