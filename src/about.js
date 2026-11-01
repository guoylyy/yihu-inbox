// 「关于」和「设置」要显示的应用信息。平台模型名走开放接口，拿不到就写未配置，不让页面失败
import { readFileSync } from 'node:fs'
import { VERSION } from './version.js'

const MODEL_CACHE_MS = 60_000
const MODEL_TIMEOUT_MS = 3000
const UNCONFIGURED = '未配置'

const read = (rel) => { try { return readFileSync(new URL(rel, import.meta.url), 'utf8').trim() } catch { return '' } }
const DEPENDENCIES = Object.keys(JSON.parse(read('../package.json')).dependencies ?? {}).length

/** 镜像构建时写入的 BUILD_TIME，本地直接跑没有这个文件 */
export const buildTime = () => read('../BUILD_TIME') || '本地运行，没有构建'

/** 平台模型列表里排第一的是默认模型（/api/open/llm/models，OpenAI 兼容格式） */
export function createModelInfo({ clientId, clientSecret, apiUrl }, { cacheMs = MODEL_CACHE_MS, timeoutMs = MODEL_TIMEOUT_MS } = {}) {
  const available = !!(clientId && clientSecret && apiUrl)
  let cache = null

  async function fetchName() {
    try {
      const auth = `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`
      const r = await fetch(`${apiUrl}/api/open/llm/models`, { headers: { Authorization: auth }, signal: AbortSignal.timeout(timeoutMs) })
      if (!r.ok) return null
      const list = (await r.json())?.data
      const m = Array.isArray(list) ? list.find((x) => x?.default) ?? list[0] : null
      return m?.name || m?.id || null
    } catch {
      return null
    }
  }

  async function name() {
    if (!available) return null
    if (cache && Date.now() - cache.at < cacheMs) return cache.name
    cache = { name: await fetchName(), at: Date.now() }
    return cache.name
  }

  return { available, name }
}

/** 库名取自 DATABASE_URL，绝不带账号密码 */
function dataLocation() {
  try {
    const db = new URL(process.env.DATABASE_URL).pathname.slice(1)
    return db ? `MySQL 库 ${db}（应用不写本地文件）` : 'MySQL（应用不写本地文件）'
  } catch {
    return '未配置数据库'
  }
}

async function databaseVersion(pool) {
  if (!pool) return '未连接'
  try {
    const [[row]] = await pool.query('SELECT VERSION() AS v')
    return `MySQL ${row.v}`
  } catch {
    return '未连接'
  }
}

export async function aboutInfo({ pool, modelInfo, hosted }) {
  return {
    version: VERSION,
    build_time: buildTime(),
    mode: hosted ? '平台' : '本地单人',
    data_dir: dataLocation(),
    database: await databaseVersion(pool),
    model: (await modelInfo.name()) ?? UNCONFIGURED,
    node: process.version,
    dependencies: DEPENDENCIES
  }
}
