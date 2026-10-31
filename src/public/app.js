// 页面交互。列表由服务端渲染（/api/list.html），这里只管请求和弹层。地址全用相对路径，配合 <base> 挂在 /apps/inbox/ 下
const $ = (id) => document.getElementById(id)
const listEl = $('list')
const sheet = $('sheet')
const picker = $('picker')
let view = document.querySelector('.tab.on')?.dataset.view || 'today'
let editing = null // 正在看的任务；null 表示新建
let assignee = { id: null, name: '' }
let toastTimer

async function api(method, url, body) {
  const r = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined
  }).catch(() => { throw new Error('网络不太好，稍后再试') })
  // 登录过期：刷新页面，由服务端重新走授权
  if (r.status === 401) { location.reload(); throw new Error('登录已过期') }
  const isJson = (r.headers.get('content-type') || '').includes('json')
  if (!r.ok) throw new Error((isJson && (await r.json()).error) || '网络不太好，稍后再试')
  return isJson ? r.json() : r.text()
}

function toast(text) {
  const el = $('toast')
  // 模态 dialog 在顶层，提示放在外面会被盖住，要挪进最上面那层
  const dialogs = document.querySelectorAll('dialog[open]')
  ;(dialogs[dialogs.length - 1] || document.body).append(el)
  el.textContent = text
  el.hidden = false
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => { el.hidden = true }, 2500)
}

let listSeq = 0
async function loadList() {
  const seq = ++listSeq
  const html = await api('GET', `api/list.html?view=${view}`)
  if (seq === listSeq) listEl.innerHTML = html // 连点切视图时，只认最后一次
}

function setView(next) {
  view = next
  for (const a of document.querySelectorAll('.tab')) {
    const on = a.dataset.view === view
    a.classList.toggle('on', on)
    if (on) a.setAttribute('aria-current', 'page')
    else a.removeAttribute('aria-current')
  }
  history.replaceState(null, '', `?view=${view}`)
  return loadList().catch((e) => toast(e.message))
}

document.querySelector('.tabs')?.addEventListener('click', (e) => {
  const a = e.target.closest('.tab')
  if (!a) return
  e.preventDefault()
  setView(a.dataset.view)
})

// ---------- 快速录入 ----------
$('quick')?.addEventListener('submit', async (e) => {
  e.preventDefault()
  const input = $('quick-input')
  const btn = $('quick-btn')
  const text = input.value.trim()
  if (!text) return input.focus()
  btn.disabled = true
  btn.textContent = '解析中'
  let draft
  try {
    draft = await api('POST', 'api/parse', { text })
  } catch {
    // 解析接口也挂了：一样按原文进确认，录入不能被卡住
    draft = { title: text, due_date: null, priority: 0, note: null, assignee: null, match: null, parsed: false }
  }
  btn.disabled = false
  btn.textContent = '记下'
  openNew(draft)
})

// ---------- 列表 ----------
listEl?.addEventListener('click', async (e) => {
  const example = e.target.closest('[data-example]')
  if (example) {
    $('quick-input').value = example.dataset.example
    return $('quick-input').focus()
  }
  if (!e.target.closest('[data-open]')) return
  const id = e.target.closest('.task').dataset.id
  try {
    openExisting(await api('GET', `api/tasks/${id}`))
  } catch (err) { toast(err.message) }
})

// 勾选即完成：先改界面，失败再改回来
listEl?.addEventListener('change', async (e) => {
  const box = e.target
  if (box.type !== 'checkbox') return
  const row = box.closest('.task')
  const done = box.checked
  row.classList.toggle('done', done)
  try {
    await api('PUT', `api/tasks/${row.dataset.id}/status`, { status: done ? 'done' : 'open' })
  } catch (err) {
    box.checked = !done
    row.classList.toggle('done', !done)
    toast(err.message)
  }
})

// ---------- 任务弹层：确认态和详情是同一张表单 ----------
function fill(t) {
  $('f-title').value = t.title || ''
  $('f-due').value = t.due_date || ''
  $('f-note').value = t.note || ''
  const p = document.querySelector(`input[name="priority"][value="${t.priority || 0}"]`)
  if (p) p.checked = true
}

function setAssignee(id, name) {
  assignee = { id, name }
  $('f-assign-name').textContent = id ? name : '不指派'
}

// 模型提到的人：认出来就预填（保存才写库），认不准列候选，认不出给一行灰字
function setMatch(name, match) {
  const hint = $('f-assign-hint')
  const cands = $('f-assign-cands')
  const people = match?.candidates || []
  hint.textContent = !name || match?.status === 'matched' ? ''
    : people.length ? `「${name}」可能是下面的人，点一下选` : `没认出来「${name}」，可手动选`
  hint.hidden = !hint.textContent
  cands.replaceChildren(...people.map((u) => {
    const b = document.createElement('button')
    b.type = 'button'
    b.className = 'cand'
    b.dataset.id = u.id
    const label = document.createElement('span')
    label.textContent = u.name
    const dept = document.createElement('span')
    dept.className = 'dept'
    dept.textContent = u.dept || ''
    b.append(label, dept)
    return b
  }))
  cands.hidden = !people.length
}

$('f-assign-cands').addEventListener('click', (e) => {
  const b = e.target.closest('button')
  if (!b) return
  setAssignee(Number(b.dataset.id), b.firstChild.textContent)
  setMatch(null)
})

function setReadOnly(readOnly) {
  for (const el of sheet.querySelectorAll('textarea, input')) el.disabled = readOnly
  $('f-assign').disabled = readOnly
}

function setHint(text) {
  $('sheet-hint').textContent = text
  $('sheet-hint').hidden = !text
}

function openNew(draft) {
  editing = null
  $('sheet-title').textContent = '确认待办'
  $('sheet-save').textContent = '保存'
  setReadOnly(false)
  setHint(draft.parsed ? '' : '没能自动解析，已按原文填入')
  fill(draft)
  setAssignee(draft.match?.user?.id ?? null, draft.match?.user?.name ?? '')
  setMatch(draft.assignee, draft.match)
  sheet.showModal()
  $('f-title').blur()
}

function openExisting(t) {
  editing = t
  $('sheet-title').textContent = '待办详情'
  setReadOnly(!t.mine)
  setHint(t.mine ? '' : `来自 ${t.from}，只有创建人能改内容`)
  $('sheet-save').textContent = t.mine ? '保存' : (t.status === 'done' ? '重新打开' : '标记完成')
  fill(t)
  setAssignee(t.assignee_id, t.assignee)
  setMatch(null)
  sheet.showModal()
}

$('task-form').addEventListener('submit', async (e) => {
  e.preventDefault()
  const btn = $('sheet-save')
  btn.disabled = true
  try {
    if (editing && !editing.mine) {
      await api('PUT', `api/tasks/${editing.id}/status`, { status: editing.status === 'done' ? 'open' : 'done' })
      sheet.close()
      await loadList()
      return
    }
    const fields = {
      title: $('f-title').value,
      due_date: $('f-due').value || null,
      priority: Number(sheet.querySelector('input[name="priority"]:checked')?.value || 0),
      note: $('f-note').value
    }
    if (editing) {
      await api('PATCH', `api/tasks/${editing.id}`, fields)
      if ((editing.assignee_id || null) !== assignee.id) await api('PUT', `api/tasks/${editing.id}/assignee`, { assignee_id: assignee.id })
      sheet.close()
      await loadList()
    } else {
      const created = await api('POST', 'api/tasks', { ...fields, assignee_id: assignee.id })
      $('quick-input').value = ''
      sheet.close()
      await loadList()
      if (created.duplicate) toast('刚记过了')
      else if (!listEl.querySelector(`[data-id="${created.id}"]`)) toast('已记下，这条不在当前视图，到「全部」里看')
    }
  } catch (err) {
    toast(err.message)
  } finally {
    btn.disabled = false
  }
})

for (const d of [sheet, picker]) {
  d.querySelector('[data-close]').addEventListener('click', () => d.close())
  // 点遮罩关闭（桌面）
  d.addEventListener('click', (e) => { if (e.target === d) d.close() })
}

// ---------- 选人 ----------
let searchTimer
async function loadPeople(q) {
  const msg = $('picker-msg')
  const ul = $('picker-list')
  try {
    const { list, total } = await api('GET', `api/users?q=${encodeURIComponent(q)}`)
    ul.replaceChildren(...list.map((u) => {
      const li = document.createElement('li')
      const b = document.createElement('button')
      b.type = 'button'
      b.dataset.id = u.id
      if (u.id === assignee.id) b.setAttribute('aria-current', 'true')
      const name = document.createElement('span')
      name.textContent = u.name
      const dept = document.createElement('span')
      dept.className = 'dept'
      dept.textContent = u.dept || ''
      b.append(name, dept)
      li.append(b)
      return li
    }))
    msg.hidden = list.length > 0 && total <= list.length
    msg.textContent = list.length ? `共 ${total} 人，搜一下更快` : '没有找到这个人'
  } catch (e) {
    ul.replaceChildren()
    msg.textContent = e.message
    msg.hidden = false
  }
}

$('f-assign').addEventListener('click', () => {
  $('picker-q').value = ''
  $('picker-list').replaceChildren()
  $('picker-msg').hidden = true
  picker.showModal()
  loadPeople('')
})

$('picker-q').addEventListener('input', (e) => {
  clearTimeout(searchTimer)
  searchTimer = setTimeout(() => loadPeople(e.target.value), 200)
})

$('picker-list').addEventListener('click', (e) => {
  const b = e.target.closest('button')
  if (!b) return
  setAssignee(Number(b.dataset.id), b.firstChild.textContent)
  setMatch(null)
  picker.close()
})

$('picker-none').addEventListener('click', () => {
  setAssignee(null, '')
  setMatch(null)
  picker.close()
})

// 键盘弹起时可视区变矮，弹层跟着变矮，底部主按钮留在键盘上方
if (window.visualViewport) {
  const sync = () => document.documentElement.style.setProperty('--vvh', `${window.visualViewport.height}px`)
  window.visualViewport.addEventListener('resize', sync)
  sync()
}
