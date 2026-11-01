// 公用交互：请求、提示、确认、选人、顶栏菜单。列表在 home.js、多选在 batch.js。地址全用相对路径，配合 <base> 挂在 /apps/inbox/ 下
const $ = (id) => document.getElementById(id)
let toastTimer

async function api(method, url, body, extra = {}) {
  const r = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    ...extra // 上传文件时 extra 带自己的 body 和 headers
  }).catch(() => { throw new Error('网络不太好，稍后再试') })
  // 登录过期：刷新页面，由服务端重新走授权
  if (r.status === 401) { location.reload(); throw new Error('登录已过期') }
  const isJson = (r.headers.get('content-type') || '').includes('json')
  if (!r.ok) throw new Error((isJson && (await r.json()).error) || '网络不太好，稍后再试')
  if (r.status === 204) return null
  return isJson ? r.json() : r.text()
}

/** action 给「撤销」这种跟在提示后面的按钮用 */
function toast(text, { action, onAction, ms = 2400 } = {}) {
  const el = $('toast')
  // 模态 dialog 在顶层，提示放在外面会被盖住，要挪进最上面那层
  const dialogs = document.querySelectorAll('dialog[open]')
  ;(dialogs[dialogs.length - 1] || document.body).append(el)
  el.textContent = text
  if (action) {
    const b = document.createElement('button')
    b.type = 'button'
    b.className = 'toast-action'
    b.id = 'toast-action'
    b.textContent = action
    b.addEventListener('click', () => { el.hidden = true; clearTimeout(toastTimer); onAction() })
    el.append(b)
  }
  el.hidden = false
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => { el.hidden = true }, ms)
}

/** 二次确认。原生 confirm 在钉钉、微信内置浏览器里不一定弹，用自己的弹层 */
function ask({ title, text, yes, danger = false }) {
  const d = $('confirm')
  $('confirm-title').textContent = title
  $('confirm-text').textContent = text
  $('confirm-yes').textContent = yes
  $('confirm-yes').classList.toggle('yh-btn--danger', danger)
  return new Promise((resolve) => {
    d.addEventListener('close', () => resolve(d.returnValue === 'yes'), { once: true })
    d.returnValue = ''
    d.showModal()
  })
}
$('confirm-no').addEventListener('click', () => $('confirm').close('no'))
$('confirm-yes').addEventListener('click', () => $('confirm').close('yes'))

// ---------- 顶栏菜单、重试、弹层关闭 ----------
const menu = $('user-menu')
document.addEventListener('click', (e) => {
  if (menu.open && !menu.contains(e.target)) menu.open = false
  if (e.target.closest('[data-reload]')) location.reload()
  const close = e.target.closest('[data-close]')
  if (close) close.closest('dialog').close()
  // 点遮罩关闭（桌面）
  if (e.target.tagName === 'DIALOG' && e.target.id !== 'confirm') e.target.close()
})
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') menu.open = false })

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    // 内置浏览器和 http 下没有 clipboard 接口，退回老办法
    const t = document.createElement('textarea')
    t.value = text
    t.setAttribute('readonly', '')
    t.className = 'copy-buffer'
    document.body.append(t)
    t.select()
    const ok = document.execCommand('copy')
    t.remove()
    return ok
  }
}

// ---------- 选人 ----------
let pickerDone = null
let pickerCurrent = null
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
      if (u.id === pickerCurrent) b.setAttribute('aria-current', 'true')
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

/** 选人弹层：选好后回调 onPick(id, name)，「不指派」时 id 是 null */
function openPicker(currentId, onPick) {
  pickerCurrent = currentId
  pickerDone = onPick
  $('picker-q').value = ''
  $('picker-list').replaceChildren()
  $('picker-msg').hidden = true
  $('picker').showModal()
  loadPeople('')
}

if ($('picker')) {
  $('picker-q').addEventListener('input', (e) => {
    clearTimeout(searchTimer)
    searchTimer = setTimeout(() => loadPeople(e.target.value), 200)
  })
  $('picker-list').addEventListener('click', (e) => {
    const b = e.target.closest('button')
    if (!b) return
    $('picker').close()
    pickerDone(Number(b.dataset.id), b.firstChild.textContent)
  })
  $('picker-none').addEventListener('click', () => {
    $('picker').close()
    pickerDone(null, '')
  })
}

// 键盘弹起时可视区变矮，弹层跟着变矮，底部主按钮留在键盘上方
if (window.visualViewport) {
  const sync = () => document.documentElement.style.setProperty('--vvh', `${window.visualViewport.height}px`)
  window.visualViewport.addEventListener('resize', sync)
  sync()
}
