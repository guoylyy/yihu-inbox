// v0.2.1 验收：21 张截图（三档 × 七页）+ 更多菜单、删除确认各一张 + 视觉断言 + 导入到周报的全流程。产物都在 artifacts/v0.2.1/，不进 git
//   E2E=1 npm test                       在 npm test 的临时库上跑
//   E2E_DATABASE_URL=mysql://… node e2e/gates.mjs     用现成的库，表会被清空
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import mysql from 'mysql2/promise'
import { chromium } from 'playwright-core'
import { PEOPLE, startFakePlatform } from '../test/support/fake-platform.mjs'
import { addDays, endOfWeek, todayIn } from '../src/dates.js'
import { SIZES, SMALL_TARGETS, startApp, startDatabase } from './support.mjs'

const APP_PORT = Number(process.env.E2E_APP_PORT) || 3072
const PLATFORM_PORT = APP_PORT + 1
const OUT = 'artifacts/v0.2.1'
const LONG_TITLE = '把第三季度华东区所有经销商的返利对账单核对完并同步给财务部，顺便确认一下合同里关于年度框架协议续签条款的最新修订版本是否已经由法务部门审批通过了'
const ME = 11
const today = todayIn()

mkdirSync(OUT, { recursive: true })
let failed = 0
const check = (name, pass, detail = '') => {
  if (!pass) failed++
  console.log(`${pass ? '✅' : '❌'} ${name}${detail ? `  ${detail}` : ''}`)
}
const section = (name) => console.log(`\n=== ${name} ===`)

const db = await startDatabase()
const platform = await startFakePlatform({ port: PLATFORM_PORT, appTarget: { host: '127.0.0.1', port: APP_PORT } })
const appUrl = `${platform.url}/apps/inbox`
const server = await startApp({ port: APP_PORT, env: { DATABASE_URL: db.url, YH_CLIENT_ID: 'cid', YH_CLIENT_SECRET: 'secret', YH_API_URL: platform.url, YH_WEB_URL: platform.url, YH_APP_URL: appUrl, YH_BASE_PATH: '/apps/inbox' } })
platform.state.models = [{ id: 'gpt-x', name: '平台默认模型', default: true }]
const pool = mysql.createPool({ uri: db.url, timezone: 'Z', dateStrings: ['DATE'] })
const browser = await chromium.launch()
const work = mkdtempSync(join(tmpdir(), 'inbox-gates-'))

async function open(width, height, userId = ME) {
  platform.state.loginAs = userId
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 2, locale: 'zh-CN', timezoneId: 'Asia/Shanghai', permissions: ['clipboard-read', 'clipboard-write'] })
  const page = await ctx.newPage()
  page.problems = []
  page.on('console', (m) => { if (m.type() === 'error') page.problems.push(m.text()) })
  page.on('pageerror', (e) => page.problems.push(e.message))
  await page.goto(`${appUrl}/`)
  await page.waitForSelector('.yh-top')
  return { ctx, page }
}

async function audit(page, label) {
  await page.waitForTimeout(260) // 弹层动画停稳再量
  const r = await page.evaluate(() => ({ sw: document.body.scrollWidth, dw: document.documentElement.scrollWidth, iw: window.innerWidth }))
  check(`${label} 无横向滚动`, r.sw <= r.iw && r.dw <= r.iw, `scrollWidth=${Math.max(r.sw, r.dw)} innerWidth=${r.iw}`)
  const small = await page.evaluate(SMALL_TARGETS)
  check(`${label} 可点元素 ≥44px`, small.length === 0, small.slice(0, 6).join(' | '))
}

async function insert(fields) {
  const [r] = await pool.query(
    `INSERT INTO inbox_task (owner_id, assignee_id, title, due_date, priority, tags, status, done_at, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'self')`,
    [fields.owner ?? ME, fields.assignee ?? null, fields.title, fields.due ?? null, fields.priority ?? 0, JSON.stringify(fields.tags ?? []), fields.done ? 'done' : 'open', fields.done ? new Date() : null]
  )
  await pool.query('INSERT INTO inbox_event (task_id, actor_id, action) VALUES (?, ?, ?)', [r.insertId, fields.owner ?? ME, fields.done ? 'done' : 'create'])
}

async function seed() {
  await insert({ title: LONG_TITLE, due: addDays(today, -2), priority: 2 })
  await insert({ title: '整理周会决议', due: today, priority: 3 })
  await insert({ title: '审核销售部报价单', due: today, owner: 13, assignee: ME, priority: 1 })
  await insert({ title: '跟进苏州客户名单', due: today, assignee: 12 })
  await insert({ title: '确认合同模板', due: addDays(today, -1), assignee: 13 })
  await insert({ title: '催法务回复', due: today, tags: ['负责人待确认：老周'] })
  await insert({ title: '已经做完的事', done: true })
  const [r] = await pool.query("INSERT INTO inbox_task (owner_id, title, tags, source) VALUES (?, '三天没动的方案', '[]', 'self')", [ME])
  await pool.query('UPDATE inbox_task SET updated_at = DATE_SUB(UTC_TIMESTAMP(), INTERVAL 4 DAY) WHERE id = ?', [r.insertId])
}

const PASTE = (dupTitle, longTitle) => [
  '- 整理客户名单 @李雷 11-02',
  '* 准备下周路演材料',
  dupTitle,
  dupTitle,
  longTitle
].join('\n')

async function pastePreview(page, text) {
  await page.goto(`${appUrl}/import`)
  await page.fill('#paste', text)
  await page.click('#paste-btn')
  await page.waitForSelector('.preview-row')
}

const sql = async (label) => {
  const [rows] = await pool.query('select id, title, due_date, assignee_id from inbox_task order by id desc limit 6')
  console.log(`\n[${label}] select id, title, due_date, assignee_id from inbox_task order by id desc limit 6;`)
  console.table(rows.map((r) => ({ ...r, title: [...r.title].slice(0, 24).join('') })))
  return rows
}
const numbers = async (page) => ({
  added: await page.textContent('#r-added'), done: await page.textContent('#r-done'), rate: await page.textContent('#r-rate'),
  overdue: await page.textContent('#r-overdue'), open_due: String(await page.evaluate(() => fetch('api/report/week').then((r) => r.json()).then((r) => r.open_due)))
})
const selectAll = async (page, id) => {
  await page.click('#select-all summary')
  await page.click(`#${id}`)
}
const gotoReport = async (page) => {
  await page.goto(`${appUrl}/?view=week`)
  await page.waitForSelector('#report')
}

try {
  await seed()

  section('门槛 2：21 张截图 + 更多菜单、删除确认')
  for (const [tag, width, height] of SIZES) {
    const { ctx, page } = await open(width, height)

    await page.waitForSelector('.task')
    await page.screenshot({ path: `${OUT}/${tag}-list.png`, fullPage: true })
    await audit(page, `${tag} 列表`)
    check(`${tag} 顶栏固定高度`, await page.evaluate(() => getComputedStyle(document.querySelector('.yh-top')).position === 'sticky'))
    const rail = await page.locator('#rail').isVisible()
    check(`${tag} 右侧栏：≥1024 才有`, rail === (width >= 1024))
    if (rail) check(`${tag} 右侧栏三块`, (await page.locator('#rail h2').allTextContents()).join() === '今日进度,按人分布,最近活动')

    await page.click('#user-menu summary')
    check(`${tag} 头像菜单：设置、关于、退出`, (await page.locator('.yh-menu-list a').allTextContents()).join() === '设置,关于,退出')
    await audit(page, `${tag} 头像菜单`)
    await page.keyboard.press('Escape')

    check(`${tag} 页头只有选择、导入两个文字按钮`, (await page.locator('.head-actions > :visible').allTextContents()).join() === '选择,导入' && await page.locator('#help-btn').count() === 0)
    const titleBox = await page.locator('h1').boundingBox()
    const selectBox = await page.locator('#select-btn').boundingBox()
    check(`${tag} 选择、导入和标题同一行`, selectBox.y < titleBox.y + titleBox.height && selectBox.y + selectBox.height > titleBox.y, `标题 y=${Math.round(titleBox.y)} 按钮 y=${Math.round(selectBox.y)}`)
    if (tag === '375') {
      const firstTask = Math.round((await page.locator('.task').first().boundingBox()).y)
      check('375 首屏：顶部到第一条 ≤420px', firstTask <= 420, `实测 ${firstTask}px`)
    }

    await page.click('#select-btn')
    await page.waitForSelector('#batch-bar:not([hidden])')
    check(`${tag} 多选时隐藏导入`, await page.locator('#import-btn').isHidden())
    await page.locator('.task').nth(0).click()
    await page.locator('.task').nth(1).click()
    check(`${tag} 多选态：点行是选中，不打开`, await page.locator('#sheet[open]').count() === 0 && (await page.textContent('#batch-count')) === '已选 2 条')
    await page.screenshot({ path: `${OUT}/${tag}-select.png` })
    await audit(page, `${tag} 多选态`)
    const barBox = await page.locator('#batch-bar').boundingBox()
    check(`${tag} 操作条在底部`, Math.round(barBox.y + barBox.height) === height, `bottom=${Math.round(barBox.y + barBox.height)}`)
    check(`${tag} 操作条只有取消和四个动作`, (await page.locator('#batch-bar button:visible').allTextContents()).map((t) => t.replace(/\s*›/, '')).join() === '取消,改期,指派,完成,更多')
    if (tag === '375') {
      check('375 操作条高度 ≤96px', barBox.height <= 96, `实测 ${barBox.height}px`)
      const wide = await page.locator('#batch-actions .yh-btn').evaluateAll((els) => els.map((el) => Math.round(el.getBoundingClientRect().width)))
      check('375 四个动作等宽', new Set(wide).size === 1, wide.join('/'))
    }
    await page.click('#select-all summary')
    check(`${tag} 全选下拉两项`, (await page.locator('#select-all .pop-list button').allTextContents()).join() === '全选本屏,全部选中')
    await audit(page, `${tag} 全选下拉`)
    await page.click('#batch-count')
    check(`${tag} 点别处收起全选下拉`, await page.locator('#select-all .pop-list').isHidden())
    await page.click('[data-batch="more"]')
    await page.waitForSelector('#more-sheet[open]')
    await page.waitForTimeout(260)
    await page.screenshot({ path: `${OUT}/${tag}-more.png` })
    if (tag === '375') await page.screenshot({ path: `${OUT}/375-more-sheet.png` })
    await audit(page, `${tag} 更多菜单`)
    check(`${tag} 更多菜单：归档、删除`, (await page.locator('#more-sheet [data-batch] > span:first-child').allTextContents()).join() === '归档,删除')
    check(`${tag} 删除是红字`, await page.evaluate(() => {
      const probe = document.createElement('i')
      probe.style.color = 'var(--yh-danger)'
      document.body.append(probe)
      const same = getComputedStyle(probe).color === getComputedStyle(document.querySelector('[data-batch="delete"]')).color
      probe.remove()
      return same
    }))
    await page.click('#more-sheet [data-batch="delete"]')
    await page.waitForSelector('#confirm[open]')
    await page.waitForTimeout(260)
    check(`${tag} 删除二次确认文案`, `${await page.textContent('#confirm-title')}${await page.textContent('#confirm-text')}` === '删除 2 条待办？删除后无法恢复')
    if (tag === '375') await page.screenshot({ path: `${OUT}/375-delete-confirm.png` })
    await audit(page, `${tag} 删除确认`)
    await page.click('#confirm-no')
    check(`${tag} 取消删除还在多选态`, (await page.textContent('#batch-count')) === '已选 2 条')
    await page.click('[data-batch="reschedule"]')
    await page.waitForSelector('#reschedule[open]')
    await audit(page, `${tag} 改期弹层`)
    await page.click('#reschedule [data-close]')
    await page.click('#batch-cancel')

    await pastePreview(page, PASTE('写季度复盘', LONG_TITLE.repeat(2)))
    await page.screenshot({ path: `${OUT}/${tag}-import-preview.png`, fullPage: true })
    await audit(page, `${tag} 导入预览`)

    await gotoReport(page)
    await page.screenshot({ path: `${OUT}/${tag}-report.png`, fullPage: true })
    await audit(page, `${tag} 周报`)

    await page.goto(`${appUrl}/settings`)
    await page.waitForSelector('#s-dedupe')
    await page.screenshot({ path: `${OUT}/${tag}-settings.png`, fullPage: true })
    await audit(page, `${tag} 设置`)

    await page.goto(`${appUrl}/about`)
    await page.waitForSelector('#about-info')
    await page.screenshot({ path: `${OUT}/${tag}-about.png`, fullPage: true })
    await audit(page, `${tag} 关于`)

    check(`${tag} 控制台无报错`, page.problems.length === 0, page.problems.join(' | ').slice(0, 300))
    await ctx.close()
  }

  section('门槛 4：粘贴 → 预览 → 导入 → 多选改期 → 撤销 → 周报')
  {
    const { ctx, page } = await open(1440, 900)
    const OVER = `超长的一行：${'把返利对账单核对完并同步给财务部'.repeat(16)}`
    const text = ['- 整理客户名单 @李雷 11-02', '* 准备下周路演材料', '写季度复盘', '写季度复盘', OVER].join('\n')
    await gotoReport(page)
    const start = await numbers(page)
    console.log('起点周报：', start)
    await page.screenshot({ path: `${OUT}/flow-0-report-start.png`, fullPage: true })

    await pastePreview(page, text)
    await page.screenshot({ path: `${OUT}/flow-1-preview.png`, fullPage: true })
    const dupRows = await page.locator('.preview-row.dup').count()
    check('预览：5 行', await page.locator('.preview-row').count() === 5)
    check('预览灰显 1 条', dupRows === 1, `灰显 ${dupRows} 条`)
    check('灰显那条默认不勾', !(await page.locator('.preview-row.dup input[type="checkbox"]').isChecked()))
    check('超长提示', (await page.textContent('#preview-notices')).includes('1 行超过 200 字'), await page.textContent('#preview-notices'))
    check('按钮写着导入 4 条', (await page.textContent('#commit-btn')) === '导入 4 条')

    await page.click('#commit-btn')
    await page.waitForFunction(() => location.search.includes('view=open') && document.querySelector('.task'))
    await page.screenshot({ path: `${OUT}/flow-2-imported.png`, fullPage: true })
    const afterImport = await sql('导入 4 条后')
    const titles = afterImport.map((r) => r.title)
    check('导入 4 条', titles.filter((t) => t === '写季度复盘').length === 1 && titles.includes('整理客户名单'))
    const over = afterImport.find((r) => r.title.startsWith('超长的一行'))
    check('超长的截到 200 字', [...over.title].length === 200, `${[...over.title].length} 字`)
    const [[{ note }]] = await pool.query('SELECT note FROM inbox_task WHERE id = ?', [over.id])
    check('完整原文在备注里', note === OVER)
    check('@ 匹配到李雷', afterImport.find((r) => r.title === '整理客户名单').assignee_id === 12)
    await gotoReport(page)
    const imported = await numbers(page)
    console.log('导入后周报：', imported)
    check('周报：新增 +4', Number(imported.added) === Number(start.added) + 4)

    const picks = ['准备下周路演材料', '写季度复盘', '超长的一行']
    await page.goto(`${appUrl}/?view=open`)
    await page.waitForSelector('.task')
    await page.click('#select-btn')
    for (const t of picks) await page.locator(`.task:has-text("${t}")`).click()
    check('已选 3 条', (await page.textContent('#batch-count')) === '已选 3 条')
    await page.screenshot({ path: `${OUT}/flow-3-selected.png`, fullPage: true })
    await page.click('[data-batch="reschedule"]')
    await page.click('[data-preset="tomorrow"]')
    await page.waitForSelector('#toast-action')
    check('toast 报已处理 3 条', (await page.textContent('#toast')).startsWith('已处理 3 条'), await page.textContent('#toast'))
    await page.screenshot({ path: `${OUT}/flow-4-rescheduled.png`, fullPage: true })
    const moved = await sql('改到明天后')
    const tomorrow = addDays(today, 1)
    const isPicked = (r) => picks.some((t) => r.title.startsWith(t))
    check('3 条改到明天', moved.filter(isPicked).length === 3 && moved.filter(isPicked).every((r) => r.due_date === tomorrow), `明天是 ${tomorrow}`)
    const reportNow = () => page.evaluate(() => fetch('api/report/week').then((r) => r.json()))
    const brief = (r) => ({ added: r.added, done: r.done, rate: r.rate, open_due: r.open_due })
    const moved1 = await reportNow()
    console.log('改到明天后周报：', brief(moved1))
    // 周日的明天属于下周，不进本周的分母，这时数字不该动
    const crossesWeek = tomorrow > endOfWeek(today)
    check(crossesWeek ? '周报：今天周日，明天算下周，本周到期不变' : '周报：本周到期 +3', moved1.open_due === Number(imported.open_due) + (crossesWeek ? 0 : 3), `本周到期 ${imported.open_due} → ${moved1.open_due}`)

    await page.click('#toast-action')
    await page.waitForFunction(() => document.getElementById('toast').textContent.startsWith('已撤销 3 条'))
    await page.screenshot({ path: `${OUT}/flow-5-undone.png`, fullPage: true })
    const undone = await sql('撤销后')
    check('撤销后日期回到空', undone.filter(isPicked).every((r) => r.due_date === null))
    await gotoReport(page)
    const finalNumbers = await numbers(page)
    console.log('撤销后周报：', finalNumbers)
    check('周报：撤销后回到改期前', finalNumbers.open_due === imported.open_due && finalNumbers.rate === imported.rate)
    await page.screenshot({ path: `${OUT}/flow-6-report.png`, fullPage: true })

    // 不管哪天跑，都看一次周报数字跟着批量和撤销走：同样三条改到今天
    await page.goto(`${appUrl}/?view=open`)
    await page.waitForSelector('.task')
    await page.click('#select-btn')
    for (const t of picks) await page.locator(`.task:has-text("${t}")`).click()
    await page.click('[data-batch="reschedule"]')
    await page.click('[data-preset="today"]')
    await page.waitForSelector('#toast-action')
    const movedToday = await reportNow()
    console.log('改到今天后周报：', brief(movedToday))
    check('周报：改到今天，本周到期 +3、完成率下降', movedToday.open_due === Number(imported.open_due) + 3 && movedToday.rate < parseInt(imported.rate, 10), `本周到期 ${imported.open_due} → ${movedToday.open_due}，完成率 ${imported.rate} → ${movedToday.rate}%`)
    await page.click('#toast-action')
    await page.waitForFunction(() => document.getElementById('toast').textContent.startsWith('已撤销 3 条'))
    const backAgain = await reportNow()
    console.log('再撤销后周报：', brief(backAgain))
    check('周报：撤销后数字回去', backAgain.open_due === Number(imported.open_due) && `${backAgain.rate}%` === imported.rate)
    check('流程控制台无报错', page.problems.length === 0, page.problems.join(' | ').slice(0, 300))
    await ctx.close()
  }

  section('交互细节')
  {
    const { ctx, page } = await open(1440, 900)
    await page.goto(`${appUrl}/?view=open`)
    await page.waitForSelector('.task')

    // 键盘
    await page.keyboard.press('j')
    await page.keyboard.press('j')
    check('j 移到第二行', await page.locator('.task').nth(1).evaluate((el) => el.classList.contains('cursor')))
    await page.keyboard.press('k')
    check('k 回第一行', await page.locator('.task').nth(0).evaluate((el) => el.classList.contains('cursor')))
    await page.keyboard.press('Enter')
    await page.waitForSelector('#sheet[open]')
    check('Enter 打开', true)
    await page.keyboard.press('Escape')
    await page.keyboard.press('x')
    check('x 选中并进入多选', (await page.textContent('#batch-count')) === '已选 1 条' && await page.locator('#batch-bar').isVisible())
    await page.keyboard.press('e')
    await page.waitForSelector('#reschedule[open]')
    check('e 打开改期', true)
    await page.keyboard.press('Escape')
    await page.keyboard.press('Escape')
    check('Esc 退出多选', await page.locator('#batch-bar').isHidden())
    await page.keyboard.press('?')
    await page.waitForFunction(() => location.pathname.endsWith('/settings') && location.hash === '#usage')
    check('? 跳到使用说明', (await page.textContent('#usage')).includes('怎么派'))
    await page.goto(`${appUrl}/?view=open`)
    await page.waitForSelector('.task')
    await page.focus('#quick-input')
    await page.keyboard.type('jkx')
    check('输入框里打字不触发快捷键', (await page.inputValue('#quick-input')) === 'jkx' && await page.locator('#batch-bar').isHidden())
    await page.fill('#quick-input', '')

    // e 改期后取消，不能把当前行留到下一次批量
    await page.locator('#quick-input').blur()
    await page.keyboard.press('j')
    await page.keyboard.press('e')
    await page.waitForSelector('#reschedule[open]')
    await page.keyboard.press('Escape')
    await page.click('#select-btn')
    await selectAll(page, 'batch-screen')
    const all = await page.locator('.task').count()
    await page.click('[data-batch="reschedule"]')
    await page.click('[data-preset="today"]')
    await page.waitForSelector('#toast-action')
    check('取消过的 e 不影响下一次批量', (await page.textContent('#toast')).startsWith(`已处理 ${all - 1} 条，跳过 1 条`), await page.textContent('#toast'))
    await page.click('#toast-action')
    await page.waitForFunction(() => document.getElementById('toast').textContent.startsWith('已撤销'))

    // 全选与撤销超时
    await page.click('#select-btn')
    await selectAll(page, 'batch-screen')
    const screen = await page.locator('.task').count()
    check('全选本屏', (await page.textContent('#batch-count')) === `已选 ${screen} 条`)
    await page.click('#batch-cancel')
    await page.click('#select-btn')
    await selectAll(page, 'batch-all')
    await page.waitForFunction(() => document.getElementById('toast').textContent.includes('全部'))
    check('全部选中', (await page.textContent('#batch-count')).startsWith('已选'), await page.textContent('#toast'))
    await page.click('#batch-cancel')
    await page.click('#select-btn')
    await page.locator('.task').first().click()
    await page.click('[data-batch="done"]')
    await page.waitForSelector('#toast-action')
    await page.waitForTimeout(3300)
    check('3 秒后撤销入口消失', await page.locator('#toast').isHidden())

    // 更多：归档走原来的批量和撤销
    await page.goto(`${appUrl}/?view=open`)
    await page.waitForSelector('.task')
    const beforeArchive = await page.locator('.task').count()
    await page.click('#select-btn')
    await page.locator('.task:has-text("确认合同模板")').click()
    await page.click('[data-batch="more"]')
    await page.click('#more-sheet [data-batch="archive"]')
    await page.waitForSelector('#toast-action')
    check('更多里归档：这条走了', await page.locator('.task').count() === beforeArchive - 1, await page.textContent('#toast'))
    const [[archived]] = await pool.query("SELECT archived_at FROM inbox_task WHERE title = '确认合同模板'")
    check('归档是软删除，行还在', !!archived?.archived_at)
    await page.click('#toast-action')
    await page.waitForSelector('.task:has-text("确认合同模板")')

    // 后端没有真删除：确认后如实报错，库里不动
    const [[{ n: rowsBefore }]] = await pool.query('SELECT COUNT(*) AS n FROM inbox_task')
    await page.click('#select-btn')
    await page.locator('.task:has-text("确认合同模板")').click()
    await page.click('[data-batch="more"]')
    await page.click('#more-sheet [data-batch="delete"]')
    await page.click('#confirm-yes')
    await page.waitForFunction(() => document.getElementById('toast').textContent === '没有这个批量操作')
    const [[{ n: rowsAfter }]] = await pool.query('SELECT COUNT(*) AS n FROM inbox_task WHERE archived_at IS NULL OR archived_at IS NOT NULL')
    check('删除：后端未开放，报错且数据没动', rowsAfter === rowsBefore, await page.textContent('#toast'))
    page.problems = page.problems.filter((p) => !p.includes('400'))
    await page.click('#batch-cancel')

    // 周报。前面的流程把种子里的长标题做完了，这里补一条逾期的
    await insert({ title: LONG_TITLE, due: addDays(today, -3) })
    await gotoReport(page)
    const lines = await page.locator('#r-overdue-list li').allTextContents()
    check('逾期清单：截到 12 字 + 省略号，最多 3 条', lines.length <= 3 && lines.some((l) => /^逾期 3 天 · .{12}…$/u.test(l)), lines.join(' | '))
    check('逾期清单不再和下面重复全文', !(await page.textContent('#r-overdue-list')).includes(LONG_TITLE))
    check('完成率公式收进问号', (await page.getAttribute('[data-tip]', 'title')).startsWith('完成率 = ') && (await page.locator('#report p', { hasText: '完成率 =' }).count()) === 0)
    await page.click('[data-tip]')
    check('点问号也看得到公式', (await page.textContent('#toast')).startsWith('完成率 = '))
    await page.click('#report-copy')
    await page.waitForFunction(() => document.getElementById('toast').textContent.startsWith('已复制'))
    const copied = await page.evaluate(() => navigator.clipboard.readText())
    check('复制为文本是 Markdown', copied.startsWith('## 本周周报') && copied.includes('完成率'), copied.split('\n')[2])
    check('复制的是完整标题', copied.includes(LONG_TITLE))

    // 预览改标题重新判重
    await pastePreview(page, '新事情甲\n新事情甲')
    check('改之前第二行灰', await page.locator('.preview-row').nth(1).evaluate((el) => el.classList.contains('dup')))
    await page.locator('.preview-title-input').nth(1).fill('新事情乙')
    await page.waitForFunction(() => !document.querySelectorAll('.preview-row')[1].classList.contains('dup'))
    check('改成不重复后恢复勾选', await page.locator('.preview-row input[type="checkbox"]').nth(1).isChecked())
    await page.click('.preview-remove >> nth=0')
    check('可删一行', await page.locator('.preview-row').count() === 1)

    // 图片明确拒绝
    await page.goto(`${appUrl}/import`)
    const png = join(work, '白板照片.png')
    writeFileSync(png, 'x')
    await page.setInputFiles('#file-input', png)
    await page.waitForFunction(() => !document.getElementById('import-error').hidden)
    check('图片明确说暂不支持', (await page.textContent('#import-error')).includes('图片和 PDF 暂不支持导入'), await page.textContent('#import-error'))
    page.problems = page.problems.filter((p) => !p.includes('415'))
    const txt = join(work, '待办.md')
    writeFileSync(txt, '# 计划\n- 从文件来的事\n')
    await page.setInputFiles('#file-input', txt)
    await page.waitForSelector('.preview-row')
    check('上传 .md 进预览', (await page.inputValue('.preview-title-input')) === '从文件来的事')

    // @ 匹配失败：标记 + 手动指派
    await pastePreview(page, '整理名单 @老周 11-02')
    check('匹配失败有标记', (await page.textContent('.preview-status')).includes('「老周」没匹配到人'))
    await page.click('#commit-btn')
    await page.waitForSelector('.task:has-text("整理名单")')
    check('列表上看得到待确认，纯文本', await page.locator('.task:has-text("整理名单") .meta', { hasText: '指派 老周（待确认）' }).count() === 1 && await page.locator('.task:has-text("整理名单") .yh-tag').count() === 0)

    // 设置
    await page.goto(`${appUrl}/settings`)
    await page.selectOption('#s-quick-due', 'tomorrow')
    await page.waitForSelector('#toast:not([hidden])')
    await page.goto(`${appUrl}/settings`)
    check('设置刷新后还在', (await page.inputValue('#s-quick-due')) === 'tomorrow')
    await page.click('#s-assignee')
    await page.waitForSelector('#picker[open] #picker-list button')
    await audit(page, '设置 选人弹层')
    await page.click('#picker-list button >> nth=0')
    await page.waitForFunction(() => document.getElementById('toast').textContent === '已保存')
    platform.state.llm = () => JSON.stringify({ title: '设置生效', due_date: null, due_time: null, priority: 0, assignee: null })
    await page.goto(`${appUrl}/`)
    await page.fill('#quick-input', '设置生效')
    await page.click('#quick-btn')
    await page.waitForSelector('#sheet[open]')
    check('不重启：默认截止预填', (await page.inputValue('#f-due')) === addDays(today, 1))
    check('不重启：默认指派预填', (await page.textContent('#f-assign-name')) !== '不指派', await page.textContent('#f-assign-name'))
    await page.click('#sheet [data-close]')
    await pool.query('DELETE FROM inbox_setting')

    check('控制台无报错', page.problems.length === 0, page.problems.join(' | ').slice(0, 300))
    await ctx.close()
  }

  section('手机长按')
  {
    const { ctx, page } = await open(375, 667)
    await page.waitForSelector('.task')
    const touch = (type, x = 100, y = 300) => page.dispatchEvent('.task >> nth=0', type, { pointerType: 'touch', clientX: x, clientY: y, bubbles: true })
    await touch('pointerdown')
    await touch('pointermove', 100, 340)
    await page.waitForTimeout(600)
    check('手指滑动不算长按', await page.locator('#batch-bar').isHidden())
    await touch('pointerup')
    await touch('pointerdown')
    await page.waitForTimeout(600)
    check('长按进入多选并选中这条', (await page.textContent('#batch-count')) === '已选 1 条')
    await touch('pointerup')
    await page.locator('.task').nth(0).locator('.row').dispatchEvent('click')
    check('松手补的 click 不把它取消', (await page.textContent('#batch-count')) === '已选 1 条')
    await audit(page, '375 长按后多选')
    await ctx.close()
  }

  section('被指派人部分跳过')
  {
    const { ctx, page } = await open(375, 667, 12)
    await page.goto(`${appUrl}/?view=open`)
    await page.waitForSelector('.task')
    await page.click('#select-btn')
    await selectAll(page, 'batch-screen')
    await page.click('[data-batch="reschedule"]')
    await page.click('[data-preset="tomorrow"]')
    await page.waitForSelector('#toast:not([hidden])')
    check('别人派的跳过并说明', (await page.textContent('#toast')).includes('别人派给你的不能改'), await page.textContent('#toast'))
    await ctx.close()
  }
} catch (e) {
  check('流程走完', false, e.stack?.slice(0, 800))
} finally {
  await browser.close()
  await pool.end()
  server.kill()
  await platform.close()
  db.stop()
  rmSync(work, { recursive: true, force: true })
}

console.log(`\n门槛脚本结束，失败 ${failed} 项`)
process.exit(failed ? 1 : 0)
