import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DIVIDER, HEADER, readTokens, render } from '../scripts/sync-vi.mjs'
import { VERSION } from '../src/version.js'

const PLATFORM_CSS = '../yihu-one/console/frontend/src/styles/main.css'
const MEETING = '../yihu-meeting'
const SOURCE = `/* 不相关 */
:root {
  /* 注释里的 --yh-fake: 1; 不算 */
  --yh-primary: #123456;
  --yh-radius: 12px;
  --yh-font: 'A B', serif;
  --el-color-primary: #123456;
  --el-color-primary-light-3: #777777;
  --el-text-color-primary: #000000;
}
.other { --yh-not-root: 1; }
`
const css = () => readdirSync('src/public').filter((f) => f.endsWith('.css')).map((f) => [f, readFileSync(`src/public/${f}`, 'utf8')])
/** 去掉令牌段，只看手写的部分 */
const handWritten = (f, s) => (f === 'yh-vi.css' ? s.slice(s.indexOf(DIVIDER)) : s)

test('令牌：--yh-* 全要，--el-* 只留三个，值原样，注释不算', () => {
  assert.deepEqual(readTokens(SOURCE), [['--yh-primary', '#123456'], ['--yh-radius', '12px'], ['--yh-font', "'A B', serif"], ['--el-color-primary', '#123456']])
})

test('令牌：来源里没有 :root 时报错，不写空文件', () => {
  assert.throws(() => readTokens('body { color: red }'), /没有 :root/)
  assert.throws(() => readTokens(':root { --other: 1; }'), /没有 --yh-/)
})

test('同步：只动令牌段，组件段一个字节不变', () => {
  const current = `${HEADER}\n:root {\n  --yh-primary: #000000;\n}\n\n${DIVIDER}\n.yh-btn { color: var(--yh-primary); }\n`
  const next = render(readTokens(SOURCE), current)
  assert.match(next, /--yh-primary: #123456;/)
  assert.ok(!next.includes('#000000'))
  assert.equal(next.slice(next.indexOf(DIVIDER)), current.slice(current.indexOf(DIVIDER)))
  assert.equal(render(readTokens(SOURCE), next), next)
})

test('同步：目标没有分隔线时报错，不把组件段冲掉', () => {
  assert.throws(() => render(readTokens(SOURCE), '.yh-btn {}'), /分隔线/)
})

test('同步脚本：命令行跑一遍，打印令牌数，--check 能发现手改', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sync-vi-'))
  try {
    const from = join(dir, 'main.css')
    const to = join(dir, 'vi.css')
    writeFileSync(from, SOURCE)
    writeFileSync(to, `${DIVIDER}\n.x {}\n`)
    const run = (...args) => execFileSync(process.execPath, ['scripts/sync-vi.mjs', '--from', from, '--to', to, ...args], { encoding: 'utf8', stdio: 'pipe' })
    assert.match(run(), /已同步 4 个令牌/)
    assert.match(run('--check'), /令牌一致/)
    writeFileSync(from, SOURCE.replaceAll('#123456', '#654321'))
    assert.throws(() => run('--check'))
    run()
    assert.match(readFileSync(to, 'utf8'), /--yh-primary: #654321;/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('yh-vi.css 的令牌和平台 main.css 完全一致', { skip: !existsSync(PLATFORM_CSS) && '没有平台仓库' }, () => {
  const platform = readTokens(readFileSync(PLATFORM_CSS, 'utf8'))
  const mine = readFileSync('src/public/yh-vi.css', 'utf8')
  assert.deepEqual(readTokens(mine), platform)
  assert.ok(platform.filter(([k]) => k.startsWith('--yh-')).length >= 50)
})

test('除令牌段外没有十六进制颜色', () => {
  for (const [f, s] of css()) assert.deepEqual(handWritten(f, s).match(/#[0-9a-fA-F]{3,6}/g), null, f)
})

test('除令牌段外没有写死的颜色、渐变、投影', () => {
  for (const [f, s] of css()) {
    const body = handWritten(f, s).replace(/\/\*[\s\S]*?\*\//g, '')
    assert.ok(!/gradient\(/.test(body), `${f} 渐变`)
    assert.ok(!/box-shadow/.test(body), `${f} 投影`)
    assert.ok(!/rgba?\(\s*\d/.test(body), `${f} 写死的 rgb`)
  }
})

test('强调色全应用只用一处', () => {
  const uses = css().flatMap(([f, s]) => handWritten(f, s).replace(/\/\*[\s\S]*?\*\//g, '').match(/var\(--yh-highlight/g) ?? [])
  assert.equal(uses.length, 1)
})

test('圆角只用令牌和胶囊两种', () => {
  for (const [f, s] of css()) {
    for (const [, value] of handWritten(f, s).matchAll(/border-radius:\s*([^;]+);/g)) {
      assert.match(value, /^(var\(--yh-radius(-sm)?\)( var\(--yh-radius\) 0 0)?|999px)$/, `${f}: ${value}`)
    }
  }
})

test('每个组件都定义了', () => {
  const vi = readFileSync('src/public/yh-vi.css', 'utf8')
  for (const c of ['.yh-app', '.yh-app--wide', '.yh-top', '.yh-page-head', '.yh-sub', '.yh-card', '.yh-plain', '.yh-row', '.yh-empty', '.yh-skeleton', '.yh-error', '.yh-toast', '.yh-field', '.yh-btn', '.yh-btn--ghost', '.yh-btn--text', '.yh-tag', '.yh-sheet', '.yh-stat']) {
    assert.ok(vi.includes(c), c)
  }
  assert.match(vi, /@media \(pointer: coarse\)/)
  assert.match(vi, /@media \(max-width: 640px\)/)
})

test('版本号五处一致：VERSION、清单、package.json、lock、version.js', () => {
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
  const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'))
  assert.equal(readFileSync('VERSION', 'utf8').trim(), VERSION)
  assert.equal(JSON.parse(readFileSync('yh-app.json', 'utf8')).version, VERSION)
  assert.equal(pkg.version, VERSION)
  assert.equal(lock.version, VERSION)
  assert.equal(lock.packages[''].version, VERSION)
})

test('没有新增运行依赖', () => {
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
  assert.deepEqual(Object.keys(pkg.dependencies).sort(), ['ejs', 'express', 'mysql2'])
  assert.deepEqual(Object.keys(pkg.devDependencies), ['playwright-core'])
})

test('平台 VI 底座和会议完全一致', { skip: !existsSync(MEETING) && '没有会议仓库' }, () => {
  for (const f of ['src/public/yh-vi.css', 'scripts/sync-vi.mjs']) assert.equal(readFileSync(f, 'utf8'), readFileSync(`${MEETING}/${f}`, 'utf8'), f)
})
