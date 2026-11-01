// 真机式实测：独立实例 + 临时库，经 /apps/inbox 前缀访问（和平台拓扑一致）。截图和报告写到 artifacts/
//   npm run e2e
import { mkdirSync, writeFileSync } from 'node:fs'
import mysql from 'mysql2/promise'
import { chromium, webkit } from 'playwright-core'
import { PEOPLE, startFakePlatform } from '../test/support/fake-platform.mjs'
import { VERSION } from '../src/version.js'
import { SIZES, SMALL_TARGETS, startApp, startDatabase } from './support.mjs'

const APP_PORT = Number(process.env.E2E_APP_PORT) || 3050
const PLATFORM_PORT = APP_PORT + 1
const OUT = 'artifacts/e2e'
const LONG_TITLE = '把第三季度华东区所有经销商的返利对账单核对完并同步给财务部，顺便确认一下合同里关于年度框架协议续签条款的最新修订版本是否已经由法务部门审批通过了'
const SENTENCE = '明天下午三点前把合同发给张三，重要'

mkdirSync(OUT, { recursive: true })
const report = { ok: true, checks: [], under44: [] }
const check = (name, pass, detail = '') => {
  report.checks.push({ name, pass, detail })
  if (!pass) report.ok = false
  console.log(`${pass ? '✅' : '❌'} ${name}${detail ? `  ${detail}` : ''}`)
}

const db = await startDatabase()
const dbUrl = db.url

const STAFF = [
  ...PEOPLE,
  { id: 21, username: 'guodong', name: '郑国栋', active: true, depts: [{ name: '销售部', isPrimary: true }] },
  { id: 22, username: 'fang1', name: '王芳', active: true, depts: [{ name: '财务部', isPrimary: true }] },
  { id: 23, username: 'fang2', name: '王芳', active: true, depts: [{ name: '行政部', isPrimary: true }] }
]
const platform = await startFakePlatform({ port: PLATFORM_PORT, appTarget: { host: '127.0.0.1', port: APP_PORT }, people: STAFF })
const tomorrow = new Date(Date.now() + 8 * 3600_000 + 86400_000).toISOString().slice(0, 10)
platform.state.llm = () => JSON.stringify({ title: '把合同发给张三', due_date: tomorrow, due_time: '15:00', priority: 3 })

const appUrl = `${platform.url}/apps/inbox`
const server = await startApp({ port: APP_PORT, env: { DATABASE_URL: dbUrl, YH_CLIENT_ID: 'cid', YH_CLIENT_SECRET: 'secret', YH_API_URL: platform.url, YH_WEB_URL: platform.url, YH_APP_URL: appUrl, YH_BASE_PATH: '/apps/inbox' } })

async function noScroll(page, label) {
  const r = await page.evaluate(() => ({ sw: document.body.scrollWidth, iw: window.innerWidth, dw: document.documentElement.scrollWidth }))
  check(`${label} 无横向滚动`, r.sw <= r.iw && r.dw <= r.iw, `scrollWidth=${r.sw} innerWidth=${r.iw}`)
}

async function collect44(page, label) {
  await page.waitForTimeout(260) // 弹层动画停稳再量
  for (const item of await page.evaluate(SMALL_TARGETS)) report.under44.push(`${label}: ${item}`)
}

async function loginContext(browser, userId, viewport) {
  platform.state.loginAs = userId
  const ctx = await browser.newContext({ viewport, isMobile: false, deviceScaleFactor: 2, locale: 'zh-CN', timezoneId: 'Asia/Shanghai' })
  const page = await ctx.newPage()
  page.problems = []
  page.on('console', (m) => { if (m.type() === 'error') page.problems.push(m.text()) })
  page.on('pageerror', (e) => page.problems.push(e.message))
  await page.goto(`${appUrl}/`)
  await page.waitForSelector('#quick')
  return { ctx, page }
}

const pool = mysql.createPool(dbUrl)
const browser = await chromium.launch()
try {
  const today = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10)
  const twoDaysAgo = new Date(Date.now() + 8 * 3600_000 - 2 * 86400_000).toISOString().slice(0, 10)

  // 空态
  {
    const { ctx, page } = await loginContext(browser, 11, { width: 375, height: 667 })
    await page.screenshot({ path: `${OUT}/375-empty.png` })
    check('空态一句话', (await page.textContent('.empty p')) === '今天没有要做的 —— 上面记一条，或导入会议待办')
    check('空态一个导入文字链', (await page.locator('.empty a, .empty button').allTextContents()).join() === '导入' && (await page.getAttribute('.empty a', 'href')) === 'import')
    await collect44(page, '375 空态')
    await noScroll(page, '375 空态')
    await ctx.close()
  }

  // 造数据：逾期长标题、今天高优、别人派来的
  await pool.execute("INSERT INTO inbox_task (owner_id, title, due_date, priority, tags, source) VALUES (11, ?, ?, 2, '[]', 'self')", [LONG_TITLE, twoDaysAgo])
  await pool.execute("INSERT INTO inbox_task (owner_id, title, due_date, priority, tags, source) VALUES (11, '整理周会决议', ?, 3, '[]', 'self')", [today])
  await pool.execute("INSERT INTO inbox_task (owner_id, assignee_id, title, due_date, priority, tags, source) VALUES (13, 11, '审核销售部报价单', ?, 1, '[]', 'self')", [today])
  await pool.execute("INSERT INTO inbox_task (owner_id, title, tags, source) VALUES (11, '没有日期的事', '[]', 'self')")

  for (const [tag, width, height] of SIZES) {
    const { ctx, page } = await loginContext(browser, 11, { width, height })
    const label = `${tag}`

    if (tag === '375') {
      // 窄屏顶栏放不下，版本号收进头像菜单（平台 VI 的规定）
      await page.click('#user-menu summary')
      check(`${label} 版本号在头像菜单里`, (await page.textContent('.yh-menu-ver')) === `版本 v${VERSION}`)
      await page.keyboard.press('Escape')
    } else {
      check(`${label} 版本号在右上角可见`, await page.locator('#version').isVisible() && (await page.locator('#version').textContent()) === `v${VERSION}`)
      const box = await page.locator('#version').boundingBox()
      check(`${label} 版本号靠右上`, box.x + box.width > width / 2 && box.y < 60, `x=${Math.round(box.x)} y=${Math.round(box.y)}`)
    }
    await page.waitForSelector('.task')
    await page.screenshot({ path: `${OUT}/${tag}-list.png` })
    check(`${label} 逾期标红`, await page.locator('.late', { hasText: '逾期 2 天' }).count() === 1)
    for (const v of ['week', 'open', 'done', 'today']) {
      await page.click(`.tab[data-view="${v}"]`)
      await page.waitForFunction((x) => location.search === `?view=${x}`, v)
      await page.waitForTimeout(80)
      await noScroll(page, `${label} 视图 ${v}`)
      if (tag === '375') await collect44(page, `375 视图 ${v}`)
    }

    // 快速录入 → 确认态
    await page.fill('#quick-input', SENTENCE)
    await page.click('#quick-btn')
    await page.waitForSelector('#sheet[open]')
    check(`${label} 确认态：标题`, (await page.inputValue('#f-title')) === '把合同发给张三')
    check(`${label} 确认态：日期`, (await page.inputValue('#f-due')) === tomorrow)
    check(`${label} 确认态：优先级高`, await page.locator('input[name="priority"][value="3"]').isChecked())
    check(`${label} 确认态：时刻进备注`, (await page.inputValue('#f-note')) === '截止 15:00')
    await page.screenshot({ path: `${OUT}/${tag}-confirm.png` })
    await noScroll(page, `${label} 确认态`)
    if (tag === '375') await collect44(page, '375 确认态')
    await page.waitForTimeout(260) // 手机上弹层有 0.2 秒上滑动画，等它停稳再量
    const save = await page.locator('#sheet-save').boundingBox()
    check(`${label} 主按钮在可见区`, save.y + save.height <= height, `bottom=${Math.round(save.y + save.height)}/${height}`)

    // 保存失败的提示不能被弹层盖住
    await page.fill('#f-title', '   ')
    await page.click('#sheet-save')
    await page.waitForSelector('#toast:not([hidden])')
    check(`${label} 弹层里能看到报错`, await page.evaluate(() => {
      const r = document.getElementById('toast').getBoundingClientRect()
      return document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)?.id === 'toast'
    }), await page.textContent('#toast'))
    await page.evaluate(() => { document.getElementById('toast').hidden = true })
    page.problems = page.problems.filter((p) => !p.includes('400')) // 上面故意提交的空标题

    // 可编辑
    await page.fill('#f-title', `把合同发给张三（${tag}）`)

    // 指派弹层
    await page.click('#f-assign')
    await page.waitForSelector('#picker[open] #picker-list button')
    await page.screenshot({ path: `${OUT}/${tag}-assign.png` })
    await noScroll(page, `${label} 指派弹层`)
    if (tag === '375') await collect44(page, '375 指派弹层')
    await page.fill('#picker-q', '法务')
    await page.waitForFunction(() => document.querySelectorAll('#picker-list button').length === 1)
    await page.click('#picker-list button')
    check(`${label} 选人回填`, (await page.textContent('#f-assign-name')) === '李雷')

    await page.click('#sheet-save')
    await page.waitForSelector('#sheet:not([open])', { state: 'attached' })
    await page.click('.tab[data-view="open"]')
    await page.waitForSelector(`.task:has-text("把合同发给张三（${tag}）")`)
    check(`${label} 列表显示指派给谁`, await page.locator(`.task:has-text("把合同发给张三（${tag}）") .meta`, { hasText: '指派 李雷' }).count() === 1)

    // 长标题：列表截断，点开看全
    await page.click('.tab[data-view="today"]')
    await page.waitForSelector('.task:has-text("华东区")')
    const clamp = await page.locator('.task:has-text("华东区") .title').evaluate((el) => el.scrollHeight > el.clientHeight + 2 || getComputedStyle(el).webkitLineClamp)
    check(`${label} 长标题截断`, !!clamp)
    await page.locator('.task:has-text("华东区") [data-open]').click()
    await page.waitForSelector('#sheet[open]')
    check(`${label} 点开看全标题`, (await page.inputValue('#f-title')) === LONG_TITLE)
    await page.click('#sheet [data-close]')

    // 勾选乐观更新 + 失败回滚
    const row = page.locator('.task:has-text("整理周会决议")')
    await page.evaluate(() => { document.getElementById('toast').hidden = true })
    await page.route('**/api/tasks/*/status', (r) => r.abort())
    await row.locator('input[type="checkbox"]').click()
    await page.waitForSelector('#toast:not([hidden])')
    check(`${label} 失败提示是人话`, (await page.textContent('#toast')) === '网络不太好，稍后再试')
    check(`${label} 完成失败回滚`, !(await row.locator('input[type="checkbox"]').isChecked()) && !(await row.evaluate((el) => el.classList.contains('done'))))
    await page.unroute('**/api/tasks/*/status')
    page.problems = page.problems.filter((p) => !p.includes('ERR_FAILED')) // 上面故意断的那次
    await page.evaluate(() => { document.getElementById('toast').hidden = true })

    // 模型挂了：整句进标题
    const keep = platform.state.llm
    platform.state.llm = () => undefined
    await page.fill('#quick-input', '模型挂了也要能记')
    await page.click('#quick-btn')
    await page.waitForSelector('#sheet[open]')
    check(`${label} 模型不可用降级`, (await page.inputValue('#f-title')) === '模型挂了也要能记' && await page.locator('#sheet-hint').isVisible())
    await page.click('#sheet [data-close]')
    platform.state.llm = keep

    // 键盘弹起：可视区变矮，主按钮还在
    if (tag === '375') {
      await page.fill('#quick-input', SENTENCE)
      await page.click('#quick-btn')
      await page.waitForSelector('#sheet[open]')
      await page.setViewportSize({ width: 375, height: 380 })
      await page.waitForTimeout(300)
      const b = await page.locator('#sheet-save').boundingBox()
      check('375 键盘弹起时主按钮仍在可视区', b.y + b.height <= 380, `bottom=${Math.round(b.y + b.height)}/380`)
      await page.setViewportSize({ width: 375, height: 667 })
      await page.click('#sheet [data-close]')
    }

    check(`${label} 控制台无报错`, page.problems.length === 0, page.problems.join(' | ').slice(0, 300))
    await ctx.close()
  }

  // 手工连记不去重（v0.1.2），人名预填
  {
    const { ctx, page } = await loginContext(browser, 11, { width: 375, height: 667 })
    const keep = platform.state.llm
    const sayAssignee = (assignee) => { platform.state.llm = () => JSON.stringify({ title: '整理客户名单', due_date: null, due_time: null, priority: 0, assignee }) }
    const openConfirm = async (text) => {
      await page.fill('#quick-input', text)
      await page.click('#quick-btn')
      await page.waitForSelector('#sheet[open]')
    }
    const rowsOf = async (title) => (await pool.query('SELECT assignee_id FROM inbox_task WHERE title = ?', [title]))[0]

    platform.state.llm = () => JSON.stringify({ title: '买牛奶', due_date: null, due_time: null, priority: 0, assignee: null })
    await page.click('.tab[data-view="open"]')
    await openConfirm('买牛奶')
    await page.click('#sheet-save')
    await page.waitForSelector('.task:has-text("买牛奶")')
    await openConfirm('买牛奶')
    await page.click('#sheet-save')
    await page.waitForFunction(() => [...document.querySelectorAll('.task')].filter((t) => t.textContent.includes('买牛奶')).length === 2)
    check('375 手工连记同名：弹层关闭、列表两条、没有提示', !(await page.locator('#sheet[open]').count()) && await page.locator('#toast').isHidden())
    check('375 手工连记同名：库里两行', (await rowsOf('买牛奶')).length === 2)
    await noScroll(page, '375 手工连记同名')

    sayAssignee('郑国栋')
    await openConfirm('给郑国栋：整理客户名单')
    check('375 人名唯一命中：预填', (await page.textContent('#f-assign-name')) === '郑国栋')
    check('375 人名唯一命中：没有灰字和候选', await page.locator('#f-assign-hint').isHidden() && await page.locator('#f-assign-cands').isHidden())
    check('375 预填时还没写库', (await rowsOf('整理客户名单')).length === 0)
    await page.screenshot({ path: `${OUT}/375-assignee-matched.png` })
    await noScroll(page, '375 人名预填')
    await page.click('#f-assign')
    await page.fill('#picker-q', '法务')
    await page.waitForFunction(() => document.querySelectorAll('#picker-list button').length === 1)
    await page.click('#picker-list button')
    check('375 预填的人保存前可改', (await page.textContent('#f-assign-name')) === '李雷')
    await page.click('#sheet-save')
    await page.waitForSelector('.task:has-text("整理客户名单")')
    check('375 保存时写的是改过的人', (await rowsOf('整理客户名单'))[0]?.assignee_id === 12)

    sayAssignee('王芳')
    await openConfirm('让王芳整理客户名单')
    check('375 同名：不预填', (await page.textContent('#f-assign-name')) === '不指派')
    check('375 同名：列出候选', await page.locator('.cand').count() === 2)
    await page.screenshot({ path: `${OUT}/375-assignee-candidates.png` })
    await noScroll(page, '375 同名候选')
    await collect44(page, '375 同名候选')
    await page.locator('.cand', { hasText: '行政部' }).click()
    check('375 点候选填入', (await page.textContent('#f-assign-name')) === '王芳' && await page.locator('#f-assign-cands').isHidden() && await page.locator('#f-assign-hint').isHidden())
    await page.click('#sheet [data-close]')

    sayAssignee('赵六')
    await openConfirm('给赵六：整理客户名单')
    check('375 没认出来：不预填', (await page.textContent('#f-assign-name')) === '不指派')
    check('375 没认出来：灰字提示', (await page.textContent('#f-assign-hint')) === '没认出来「赵六」，可手动选' && await page.locator('#f-assign-hint').isVisible())
    await page.screenshot({ path: `${OUT}/375-assignee-unknown.png` })
    await noScroll(page, '375 没认出来')
    await page.click('#sheet [data-close]')

    // 上一次的提示不能留到下一条
    platform.state.llm = () => JSON.stringify({ title: '买面包', due_date: null, due_time: null, priority: 0, assignee: null })
    await openConfirm('买面包')
    check('375 下一条不残留提示', await page.locator('#f-assign-hint').isHidden() && (await page.textContent('#f-assign-name')) === '不指派')
    await page.click('#sheet [data-close]')

    platform.state.llm = keep
    check('375 手工连记和预填流程控制台无报错', page.problems.length === 0, page.problems.join(' | ').slice(0, 300))
    await ctx.close()
  }

  // 被指派人视角
  {
    const { ctx, page } = await loginContext(browser, 12, { width: 375, height: 667 })
    await page.click('.tab[data-view="open"]')
    await page.waitForSelector('.task')
    check('被指派人看到派来的任务', await page.locator('.task:has-text("把合同发给张三（375）") .meta', { hasText: '来自 王小明' }).count() === 1)
    const others = await page.locator('.task:has-text("华东区")').count()
    check('被指派人看不到别人的任务', others === 0)
    await page.locator('.task:has-text("把合同发给张三（375）") [data-open]').click()
    await page.waitForSelector('#sheet[open]')
    check('被指派人详情只读', await page.locator('#f-title').isDisabled() && (await page.textContent('#sheet-save')) === '标记完成')
    await page.screenshot({ path: `${OUT}/375-assignee-detail.png` })
    await collect44(page, '375 被指派人详情')
    await page.click('#sheet-save')
    await page.waitForSelector('#sheet:not([open])', { state: 'attached' })
    await ctx.close()

    const a = await loginContext(browser, 11, { width: 375, height: 667 })
    await a.page.click('.tab[data-view="done"]')
    await a.page.waitForSelector('.task:has-text("把合同发给张三（375）")')
    check('完成后创建人的已完成里也有', true)
    await a.page.screenshot({ path: `${OUT}/375-done.png` })
    await a.ctx.close()
  }

  // iOS 内核走一遍窄屏
  try {
    const wk = await webkit.launch()
    const { ctx, page } = await loginContext(wk, 11, { width: 375, height: 667 })
    await page.waitForSelector('.task')
    await noScroll(page, 'WebKit 375 列表')
    await page.fill('#quick-input', SENTENCE)
    await page.click('#quick-btn')
    await page.waitForSelector('#sheet[open]')
    await page.waitForTimeout(260)
    const b = await page.locator('#sheet-save').boundingBox()
    check('WebKit 375 主按钮在可见区', b.y + b.height <= 667, `bottom=${Math.round(b.y + b.height)}`)
    await page.screenshot({ path: `${OUT}/375-webkit-confirm.png` })
    await ctx.close()
    await wk.close()
  } catch (e) {
    check('WebKit 走查', false, e.message.slice(0, 200))
  }
} catch (e) {
  check('流程走完', false, e.stack?.slice(0, 600))
} finally {
  await browser.close()
  await pool.end()
  server.kill()
  await platform.close()
  db.stop()
}

report.under44 = [...new Set(report.under44)]
writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 2))
console.log(`\n375 下 <44px 的可点元素（${report.under44.length} 个）：`)
for (const line of report.under44) console.log(`  ${line}`)
console.log(`\n检查 ${report.checks.length} 项，失败 ${report.checks.filter((c) => !c.pass).length} 项`)
process.exit(report.ok && !report.under44.length ? 0 : 1)
