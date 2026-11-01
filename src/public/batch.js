// 多选和批量：长按或「选择」进入，底部操作条，3 秒撤销；桌面键盘 j/k/x/Enter/e
const LONG_PRESS_MS = 500
const MOVE_TOLERANCE = 10
const UNDO_MS = 3000
const CONFIRM_FROM = 10 // 归档这么多条以上先确认
const bar = $('batch-bar')
const allMenu = $('select-all')
const chosen = new Set() // 选中的 id（字符串），「全部选中」时可能比屏幕上多
let selectMode = false
let cursor = null // 键盘当前行的 id
let rescheduleIds = [] // 打开改期弹层时定下处理哪些：选中的，或者 e 时的当前行
let lastBatch = null
let press = null
let suppressClick = false // 长按松手后浏览器还会补一次 click，别让它把刚选中的又取消

window.selecting = () => selectMode

const rows = () => [...listEl.querySelectorAll('.task')]

function paint() {
  for (const li of rows()) {
    const on = chosen.has(li.dataset.id)
    li.classList.toggle('selected', on)
    li.classList.toggle('cursor', li.dataset.id === cursor)
    if (selectMode) li.querySelector('.row').setAttribute('aria-pressed', String(on))
    else li.querySelector('.row').removeAttribute('aria-pressed')
  }
  $('batch-count').textContent = `已选 ${chosen.size} 条`
  for (const b of bar.querySelectorAll('[data-batch]')) b.disabled = !chosen.size
}

function setMode(on) {
  selectMode = on
  if (!on) chosen.clear()
  document.body.classList.toggle('selecting', on)
  bar.hidden = !on
  allMenu.open = false
  const archived = view === 'archived'
  $('batch-actions').hidden = archived
  $('batch-restore').hidden = !archived
  paint()
}

function toggle(id) {
  if (chosen.has(id)) chosen.delete(id)
  else chosen.add(id)
  paint()
}

$('select-btn')?.addEventListener('click', () => setMode(true))
$('batch-cancel')?.addEventListener('click', () => setMode(false))
window.onViewChanged = () => { cursor = null; setMode(false) }
window.onListRefreshed = () => {
  const alive = new Set(rows().map((li) => li.dataset.id))
  if (cursor && !alive.has(cursor)) cursor = null
  paint()
}

$('batch-screen')?.addEventListener('click', () => {
  allMenu.open = false
  for (const li of rows()) chosen.add(li.dataset.id)
  paint()
})

$('batch-all')?.addEventListener('click', async () => {
  allMenu.open = false
  try {
    const { ids, total, max } = await api('GET', `api/tasks/ids?view=${view}`)
    chosen.clear()
    for (const id of ids) chosen.add(String(id))
    paint()
    toast(total > max ? `一次最多处理 ${max} 条，已选前 ${max} 条（共 ${total} 条）` : `已选中这个视图的全部 ${total} 条`)
  } catch (err) { toast(err.message) }
})

// 用捕获：多选态下列表会拦掉行上的点击，冒泡等不到
document.addEventListener('click', (e) => { if (allMenu?.open && !allMenu.contains(e.target)) allMenu.open = false }, true)

// 多选态下点行、点框都是选中，不打开、不完成
listEl?.addEventListener('click', (e) => {
  if (suppressClick) {
    suppressClick = false
    e.preventDefault()
    e.stopImmediatePropagation()
    return
  }
  if (!selectMode) return
  const li = e.target.closest('.task')
  if (!li) return
  e.preventDefault() // 框不翻转，也就不会触发「勾选即完成」
  e.stopImmediatePropagation()
  toggle(li.dataset.id)
}, true)

// ---------- 长按进入多选（手指滑动不算） ----------
listEl?.addEventListener('pointerdown', (e) => {
  if (e.pointerType !== 'touch' || selectMode) return
  const li = e.target.closest('.task')
  if (!li) return
  const timer = setTimeout(() => {
    press = null
    suppressClick = true
    setMode(true)
    toggle(li.dataset.id)
  }, LONG_PRESS_MS)
  press = { timer, x: e.clientX, y: e.clientY }
})
const endPress = () => { if (press) clearTimeout(press.timer); press = null }
listEl?.addEventListener('pointermove', (e) => {
  if (press && Math.hypot(e.clientX - press.x, e.clientY - press.y) > MOVE_TOLERANCE) endPress()
})
for (const type of ['pointerup', 'pointercancel']) listEl?.addEventListener(type, endPress)
listEl?.addEventListener('contextmenu', (e) => { if (press || selectMode) e.preventDefault() })

// ---------- 执行 ----------
const REASONS = { not_owner: '别人派给你的不能改', gone: '已不在列表里' }

function summary(out) {
  const n = out.changed.length + out.unchanged
  const skipped = Object.entries(out.skipped).filter(([, c]) => c).map(([k, c]) => `${c} 条${REASONS[k]}`)
  return `已处理 ${n} 条${skipped.length ? `，跳过 ${skipped.join('、')}` : ''}`
}

async function undo() {
  const id = lastBatch
  if (!id) return
  lastBatch = null
  try {
    const out = await api('POST', `api/batches/${id}/undo`)
    await refresh()
    toast(out.conflicted ? `已撤销 ${out.restored} 条，${out.conflicted} 条刚被改过，没动` : `已撤销 ${out.restored} 条`)
  } catch (err) { toast(err.message) }
}

async function run(action, body, ids = [...chosen]) {
  if (!ids.length) return
  try {
    const out = await api('POST', 'api/tasks/batch', { action, ids, ...body })
    setMode(false)
    await refresh()
    lastBatch = out.batch_id
    if (out.batch_id) {
      toast(summary(out), { action: '撤销', onAction: undo, ms: UNDO_MS })
      setTimeout(() => { if (lastBatch === out.batch_id) lastBatch = null }, UNDO_MS)
    } else toast(summary(out))
  } catch (err) { toast(err.message) }
}

function openReschedule(ids) {
  rescheduleIds = ids
  $('custom-due').value = ''
  $('reschedule').showModal()
}

async function act(action) {
  if (action === 'more') return $('more-sheet').showModal()
  if (action === 'reschedule') return openReschedule([...chosen])
  if (action === 'assign') return openPicker(null, (id) => run('assign', { assignee_id: id }))
  if (action === 'archive' && chosen.size >= CONFIRM_FROM) {
    const yes = await ask({ title: `归档 ${chosen.size} 条？`, text: '归档后不在列表和统计里出现，可以到「已完成」底部的「已归档」里恢复。', yes: '归档' })
    if (!yes) return
  }
  if (action === 'delete') {
    const yes = await ask({ title: `删除 ${chosen.size} 条待办？`, text: '删除后无法恢复', yes: '删除', danger: true })
    if (!yes) return
  }
  run(action)
}

bar?.addEventListener('click', (e) => {
  const b = e.target.closest('[data-batch]')
  if (b) act(b.dataset.batch)
})

$('more-sheet')?.addEventListener('click', (e) => {
  const b = e.target.closest('[data-batch]')
  if (!b) return
  $('more-sheet').close()
  act(b.dataset.batch)
})

$('reschedule')?.addEventListener('click', (e) => {
  const b = e.target.closest('[data-preset]')
  if (!b) return
  $('reschedule').close()
  run('reschedule', { preset: b.dataset.preset }, rescheduleIds)
})

$('custom-due-ok')?.addEventListener('click', () => {
  const due = $('custom-due').value
  if (!due) return toast('先选一个日期')
  $('reschedule').close()
  run('reschedule', { due_date: due }, rescheduleIds)
})

// ---------- 键盘 ----------
function moveCursor(step) {
  const list = rows()
  if (!list.length) return
  const at = list.findIndex((li) => li.dataset.id === cursor)
  const next = list[at < 0 ? (step > 0 ? 0 : list.length - 1) : Math.min(list.length - 1, Math.max(0, at + step))]
  cursor = next.dataset.id
  paint()
  next.scrollIntoView({ block: 'nearest' })
}

const typing = (el) => el.closest?.('input, textarea, select, [contenteditable]')

document.addEventListener('keydown', (e) => {
  if (!listEl || e.metaKey || e.ctrlKey || e.altKey || typing(e.target)) return
  if (document.querySelector('dialog[open]')) return
  if (e.key === '?') { location.href = 'settings#usage'; return }
  if (e.key === 'Escape' && allMenu.open) { allMenu.open = false; return }
  if (e.key === 'Escape' && selectMode) return setMode(false)
  if (e.key === 'j') return moveCursor(1)
  if (e.key === 'k') return moveCursor(-1)
  if (e.key === 'z') return undo()
  if (e.key === 'e') {
    if (chosen.size) return openReschedule([...chosen])
    return cursor ? openReschedule([cursor]) : undefined
  }
  if (!cursor) return
  if (e.key === 'x') {
    if (!selectMode) setMode(true)
    return toggle(cursor)
  }
  if (e.key === 'Enter' && !e.target.closest('a, button, summary')) openTask(cursor)
})
