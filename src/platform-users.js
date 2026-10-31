// 平台用户目录，做法同知识库 src/platform-users.js：平台（实测）忽略 page / perPage，按 id 去重、没有新 id 就停；缓存 60s；失败给人话
const CACHE_MS = 60_000
const RETRY_MS = 30_000 // 平台连不上时隔这么久才再试，列表页不会每次卡在超时上
const PER_PAGE = 100
const MAX_PAGES = 20
const TIMEOUT_MS = 3000

export class PlatformUsersError extends Error {}

const primaryDept = (depts) => (Array.isArray(depts) ? depts.find((d) => d?.isPrimary) ?? depts[0] : null)?.name ?? null
const normalize = (raw) => ({ id: raw.id, name: raw.name || raw.username || `用户 ${raw.id}`, username: raw.username || null, dept: primaryDept(raw.depts), active: raw.active !== false })

export const matchesKeyword = (user, keyword) => {
  const q = String(keyword ?? '').trim().toLowerCase()
  return !q || [user.name, user.username, user.dept].some((v) => v && v.toLowerCase().includes(q))
}

/**
 * 模型给的人名对到平台用户：name 或 username 精确、且没有别的人沾边，才算认出来
 * 同名或姓名互相包含（张三 / 张三丰）都交给用户点；只沾到一个人但不精确（国栋 → 郑国栋）也一样，不替用户猜
 */
export function matchAssignee(users, rawName) {
  const q = String(rawName ?? '').trim()
  const exact = (u) => u.name === q || u.username === q
  const hits = q ? users.filter((u) => exact(u) || u.name.includes(q) || q.includes(u.name)) : []
  if (hits.length === 1 && exact(hits[0])) return { status: 'matched', user: hits[0], candidates: [] }
  return { status: hits.length ? 'ambiguous' : 'none', user: null, candidates: hits }
}

export function createPlatformUsers({ clientId, clientSecret, apiUrl }, { cacheMs = CACHE_MS, retryMs = RETRY_MS, timeoutMs = TIMEOUT_MS } = {}) {
  const available = !!(clientId && clientSecret && apiUrl)
  const basic = `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`
  let cache = null
  let loading = null
  let failure = null

  async function fetchPage(page) {
    let res
    let body
    try {
      res = await fetch(`${apiUrl}/api/open/users?page=${page}&perPage=${PER_PAGE}`, { headers: { Authorization: basic }, signal: AbortSignal.timeout(timeoutMs) })
      body = await res.json().catch(() => null)
    } catch {
      throw new PlatformUsersError('平台暂时连不上，稍后再试')
    }
    // client_id 错是 400 + code 1001，client_secret 错才是 401
    if ([400, 401, 403].includes(res.status)) throw new PlatformUsersError('读不到平台用户列表：应用凭证无效')
    if (res.status >= 500) throw new PlatformUsersError('平台暂时连不上，稍后再试')
    if (!res.ok || body?.code !== 0 || !Array.isArray(body.data?.list) || !Number.isFinite(body.data?.total)) throw new PlatformUsersError('读不到平台用户列表：平台返回了异常结果')
    return body.data
  }

  async function fetchAll() {
    const byId = new Map()
    for (let page = 1; page <= MAX_PAGES; page++) {
      const data = await fetchPage(page)
      const before = byId.size
      for (const raw of data.list) if (raw?.id !== null && raw?.id !== undefined) byId.set(raw.id, normalize(raw))
      if (byId.size >= data.total || byId.size === before) break
    }
    return [...byId.values()]
  }

  async function all() {
    if (!available) throw new PlatformUsersError('未接入平台，暂时不能指派')
    if (cache && Date.now() - cache.at < cacheMs) return cache.users
    if (failure && Date.now() - failure.at < retryMs) throw failure.error
    loading ??= fetchAll()
      .then((users) => { cache = { users, at: Date.now() }; failure = null; return users })
      .catch((error) => { failure = { error, at: Date.now() }; throw error })
      .finally(() => { loading = null })
    return loading
  }

  /** 按 id 取姓名：拉不到时用上一次的名单，再没有就返回空，页面退回「用户 36」，列表不能因此打不开 */
  async function names(ids) {
    const wanted = [...new Set(ids)]
    if (!wanted.length || !available) return new Map()
    const users = await all().catch(() => cache?.users ?? [])
    return new Map(users.filter((u) => wanted.includes(u.id)).map((u) => [u.id, u.name]))
  }

  return { available, all, names }
}
