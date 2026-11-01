// e2e 公用：数据库、应用进程、尺寸审计。run.mjs 和 gates.mjs 共用
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import mysql from 'mysql2/promise'

export const SIZES = [['375', 375, 667], ['768', 768, 1024], ['1440', 1440, 900]]
export const MINUTE = 60_000
const DOCKER_NAME = 'inbox-e2e-mysql'
const DOCKER_PORT = 3351

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 给了 E2E_DATABASE_URL 就用它（清空重来），否则用 Docker 起一个临时 MySQL。返回 { url, stop } */
export async function startDatabase() {
  const given = process.env.E2E_DATABASE_URL
  if (given) {
    const conn = await mysql.createConnection(given)
    for (const t of ['inbox_event', 'inbox_task', 'inbox_setting', 'inbox_batch', 'inbox_push_log']) await conn.query(`DROP TABLE IF EXISTS ${t}`)
    await conn.end()
    return { url: given, stop: () => {} }
  }
  const docker = (...a) => execFileSync('docker', a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }).trim()
  spawnSync('docker', ['rm', '-f', DOCKER_NAME], { stdio: 'ignore' })
  docker('run', '-d', '--rm', '--name', DOCKER_NAME, '-e', 'MYSQL_ROOT_PASSWORD=e2e', '-e', 'MYSQL_DATABASE=inbox_e2e', '-p', `127.0.0.1:${DOCKER_PORT}:3306`, 'mysql:8.0', '--skip-log-bin')
  const url = `mysql://root:e2e@127.0.0.1:${DOCKER_PORT}/inbox_e2e`
  for (let i = 0; i < 120; i++) {
    try { await (await mysql.createConnection(url)).end(); break } catch { await sleep(1000) }
  }
  return { url, stop: () => spawnSync('docker', ['rm', '-f', DOCKER_NAME], { stdio: 'ignore' }) }
}

export async function startApp({ port, env }) {
  const proc = spawn(process.execPath, ['src/server.js'], { stdio: 'inherit', env: { ...process.env, NODE_ENV: 'staging', PORT: String(port), ...env } })
  for (let i = 0; i < 50; i++) {
    const r = await fetch(`http://127.0.0.1:${port}/health`).catch(() => null)
    if (r?.ok) break
    await sleep(200)
  }
  return proc
}

/** 在页面里跑：当前最上层可见范围内，小于 44×44 的可点元素 */
export const SMALL_TARGETS = () => {
  const out = []
  const isVisible = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden' }
  for (const el of document.querySelectorAll('a, button, input:not(.file-input), textarea, select, summary, [role="button"], label:has(input)')) {
    if (!isVisible(el)) continue
    const dialogs = [...document.querySelectorAll('dialog[open]')]
    if (dialogs.length && !dialogs[dialogs.length - 1].contains(el)) continue
    const r = el.getBoundingClientRect()
    if (r.width < 44 || r.height < 44) out.push(`${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}${el.className ? `.${String(el.className).replace(/\s+/g, '.')}` : ''} ${Math.round(r.width)}×${Math.round(r.height)} ${(el.textContent || el.getAttribute('aria-label') || '').trim().slice(0, 16)}`)
  }
  return out
}
