// MCP：无状态 Streamable HTTP，只回 JSON。平台调用时每个请求都带 Bearer access_token（代表当前用户）
import { VERSION } from './version.js'
import { dueLabel, todayIn } from './dates.js'
import { toolInput } from './tasks.js'

const LIST_DEFAULT = 20
const LIST_MAX = 50

const brief = (t, today, user) => ({
  id: t.id,
  title: t.title,
  due_date: t.due_date,
  due: dueLabel(t.due_date, today).text,
  priority: t.priority,
  status: t.status,
  assigned_to_me: t.assignee_id === user.id
})

export function buildTools({ tasks, onCreated }) {
  return [
    {
      name: 'create_task',
      title: '新建待办',
      description: '在用户的收件箱里记一条待办。用户说「帮我记一下」「提醒我」「加个待办」「任务」时用。返回新建的待办；60 秒内重复提交同一条不会新建，返回已有那条并带 duplicate: true。',
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string', description: '要做的事，一句话，不含时间词' },
          due: { type: 'string', description: '截止日期：YYYY-MM-DD，或今天、明天、后天、周三、下周一。可不填' },
          priority: { type: 'string', enum: ['高', '中', '低', '无'], description: '优先级，不填为无' },
          note: { type: 'string', description: '备注，可不填' }
        },
        required: ['title']
      },
      run: async (user, args) => {
        const today = todayIn()
        const { task, duplicate } = await tasks.create(user.id, toolInput(args, today), { source: 'ai', dedupe: true })
        if (duplicate) return { ...brief(task, today, user), duplicate: true }
        onCreated?.(user, task)
        return brief(task, today, user)
      }
    },
    {
      name: 'list_tasks',
      title: '查看待办',
      description: '查用户收件箱里的待办，包括自己创建的和别人指派给自己的。用户问「今天有什么事」「这周要做什么」「我的待办」时用。view：today 今天到期和已逾期，week 本周内，open 全部未完成。',
      inputSchema: {
        type: 'object',
        properties: {
          view: { type: 'string', enum: ['today', 'week', 'open'], description: '视图，默认 today' },
          limit: { type: 'integer', description: `最多返回几条，默认 ${LIST_DEFAULT}，上限 ${LIST_MAX}` }
        }
      },
      annotations: { readOnlyHint: true },
      run: async (user, args) => {
        const today = todayIn()
        const view = args.view ?? 'today'
        if (!['today', 'week', 'open'].includes(view)) throw new Error('view 只能是 today、week、open')
        const limit = Math.min(Math.max(Number.parseInt(args.limit, 10) || LIST_DEFAULT, 1), LIST_MAX)
        const list = await tasks.list(user.id, view, today, limit)
        return { total: list.length, list: list.map((t) => brief(t, today, user)) }
      }
    }
  ]
}

export function mcpHandler({ ws, tools, devUser }) {
  return async (req, res) => {
    const { id, method, params } = req.body || {}
    const reply = (result) => res.json({ jsonrpc: '2.0', id, result })
    const fail = (code, message, status = 200) => res.status(status).json({ jsonrpc: '2.0', id: id ?? null, error: { code, message } })

    // 不允许匿名：initialize / tools/list 也一样，平台每个请求都带 token
    const user = ws.enabled ? await ws.userFromToken(req.headers.authorization) : devUser
    if (!user) return fail(-32001, '未授权：需要平台签发的 access_token', 401)

    if (id === undefined) return res.status(202).end() // 通知（如 notifications/initialized）不用回
    if (method === 'initialize') {
      return reply({ protocolVersion: params?.protocolVersion || '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'inbox', version: VERSION } })
    }
    if (method === 'ping') return reply({})
    if (method === 'tools/list') return reply({ tools: tools.map(({ run, ...t }) => t) })
    if (method === 'tools/call') {
      const tool = tools.find((t) => t.name === params?.name)
      if (!tool) return fail(-32602, `没有工具 ${params?.name}`)
      try {
        const out = await tool.run(user, params.arguments || {})
        ws.track(user, `mcp.${tool.name}`, { via: 'ai' })
        return reply({ content: [{ type: 'text', text: JSON.stringify(out) }], structuredContent: out })
      } catch (e) {
        return reply({ content: [{ type: 'text', text: e.status ? e.message : '操作失败，请稍后再试' }], isError: true })
      }
    }
    return fail(-32601, `不支持 ${method}`)
  }
}
