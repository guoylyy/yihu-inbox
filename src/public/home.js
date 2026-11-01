// 列表页：切视图、快速录入、任务弹层。列表由服务端渲染（/api/list.html），这里只管请求和弹层
const listEl = $('list')
const sheet = $('sheet')
let view = listEl?.dataset.view || 'today'
let editing = null // 正在看的任务；null 表示新建
let assignee = { id: null, name: '' }

let listSeq = 0
async function loadList() {
  const seq = ++listSeq
  const html = await api('GET', `api/list.html?view=${view}`)
  if (seq === listSeq) listEl.innerHTML = html // 连点切视图时，只认最后一次
}

async function loadRail() {
  $('rail').innerHTML = await api('GET', 'api/rail.html')
}

/** 改完东西后：列表和右侧栏一起刷新。右侧栏失败不影响列表 */
async function refresh() {
  await loadList()
  loadRail().catch(() => {})
  window.onListRefreshed?.()
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
  window.onViewChanged?.()
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
  // 手机浏览器长按不一定弹 title，点一下用提示再说一遍
  const tip = e.target.closest('[data-tip]')
  if (tip) return toast(tip.title)
  const copy = e.target.closest('[data-copy]')
  if (copy) return toast((await copyText(copy.dataset.copy)) ? '已复制，可以粘到群里' : '复制失败，请手动选中文字复制')
  const link = e.target.closest('a[data-view]')
  if (link) {
    e.preventDefault()
    return setView(link.dataset.view)
  }
  if (window.selecting?.()) return
  if (!e.target.closest('[data-open]')) return
  openTask(e.target.closest('.task').dataset.id)
})

async function openTask(id) {
  try {
    openExisting(await api('GET', `api/tasks/${id}`))
  } catch (err) { toast(err.message) }
}

// 勾选即完成：先改界面，失败再改回来
listEl?.addEventListener('change', async (e) => {
  const box = e.target
  if (box.type !== 'checkbox') return
  const row = box.closest('.task')
  const done = box.checked
  row.classList.toggle('done', done)
  try {
    await api('PUT', `api/tasks/${row.dataset.id}/status`, { status: done ? 'done' : 'open' })
    if (view === 'week') await loadList()
    loadRail().catch(() => {})
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

$('f-assign-cands')?.addEventListener('click', (e) => {
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
  const person = draft.match?.user ?? draft.default_assignee ?? null
  setAssignee(person?.id ?? null, person?.name ?? '')
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

$('task-form')?.addEventListener('submit', async (e) => {
  e.preventDefault()
  const btn = $('sheet-save')
  btn.disabled = true
  try {
    if (editing && !editing.mine) {
      await api('PUT', `api/tasks/${editing.id}/status`, { status: editing.status === 'done' ? 'open' : 'done' })
      sheet.close()
      await refresh()
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
      await refresh()
    } else {
      const created = await api('POST', 'api/tasks', { ...fields, assignee_id: assignee.id })
      $('quick-input').value = ''
      sheet.close()
      await refresh()
      if (!listEl.querySelector(`[data-id="${created.id}"]`)) toast('已记下，这条不在当前视图，到「全部」里看')
    }
  } catch (err) {
    toast(err.message)
  } finally {
    btn.disabled = false
  }
})

$('f-assign')?.addEventListener('click', () => {
  openPicker(assignee.id, (id, name) => {
    setAssignee(id, name)
    setMatch(null)
  })
})

// 导入完回到这里，提示一句
const imported = new URLSearchParams(location.search).get('imported')
if (imported) {
  toast(`已导入 ${imported} 条`)
  history.replaceState(null, '', `?view=${view}`)
}
