// 导入页：粘贴或上传 → 服务端解析 → 预览里逐行改、删、勾 → 提交。预览全在页面内存里，提交才写库
const fileInput = $('file-input')
const drop = $('drop')
const FILE_MAX = Number(fileInput.dataset.max)
const DUP_TEXT = { open: '收件箱里已有', done: '已有，并且完成了', paste: '和上面一行重复' }
let rows = []
let titleMax = 200
let checkTimer

const el = (tag, cls, text) => {
  const n = document.createElement(tag)
  if (cls) n.className = cls
  if (text !== undefined) n.textContent = text
  return n
}

function showError(text) {
  $('import-error').textContent = text
  $('import-error').hidden = !text
}

function enterPreview(out) {
  rows = out.rows.map((r) => ({ ...r, touched: false }))
  titleMax = out.title_max
  showError('')
  $('stage-input').hidden = true
  $('stage-preview').hidden = false
  $('preview-notices').replaceChildren(...out.notices.map((n) => el('li', 'notice', n)))
  render()
  scrollTo(0, 0)
}

function sync() {
  const chosen = rows.filter((r) => r.checked).length
  const dup = rows.filter((r) => r.dup).length
  $('preview-sum').textContent = `共 ${rows.length} 条${dup ? `，重复 ${dup} 条默认不勾` : ''}，已勾 ${chosen} 条`
  $('commit-btn').textContent = chosen ? `导入 ${chosen} 条` : '先勾选要导入的事'
  $('commit-btn').disabled = !chosen
}

function statusLine(r) {
  const parts = []
  if (r.dup) parts.push(`${DUP_TEXT[r.dup]}${r.dup === 'paste' && r.dup_line ? `（第 ${r.dup_line} 条）` : ''}`)
  if (r.marked_done) parts.push('原文已勾完成')
  if (r.truncated) parts.push(`超过 ${titleMax} 字，已截断，完整原文进备注`)
  if (r.unmatched) parts.push(`「${r.owner_name}」没匹配到人，指派留空`)
  return parts.join('；')
}

function renderRow(r) {
  const li = el('li', `preview-row${r.dup ? ' dup' : ''}`)
  li.dataset.line = r.line

  const box = el('label', 'check preview-check')
  const check = el('input')
  check.type = 'checkbox'
  check.checked = r.checked
  check.setAttribute('aria-label', `导入第 ${r.line} 条`)
  check.addEventListener('change', () => { r.checked = check.checked; r.touched = true; sync() })
  box.append(check, el('span', 'box'))

  const title = el('input', 'yh-input preview-title-input')
  title.type = 'text'
  title.value = r.title
  title.maxLength = titleMax
  title.setAttribute('aria-label', `第 ${r.line} 条标题`)
  title.addEventListener('input', () => { r.title = title.value; recheck() })

  const remove = el('button', 'yh-btn yh-btn--text preview-remove', '×')
  remove.type = 'button'
  remove.setAttribute('aria-label', `删除第 ${r.line} 条`)
  remove.addEventListener('click', () => { rows = rows.filter((x) => x !== r); render(); recheck() })

  const due = el('input', 'yh-input preview-due')
  due.type = 'date'
  due.value = r.due_date || ''
  due.setAttribute('aria-label', `第 ${r.line} 条截止日期`)
  due.addEventListener('change', () => { r.due_date = due.value || null; recheck() })

  const who = el('button', 'pick preview-who')
  who.type = 'button'
  const whoText = el('span', 'pick-text', r.assignee_id ? r.assignee_name : (r.unmatched ? `${r.owner_name}（待确认）` : '不指派'))
  who.append(whoText, el('span', '', '›'))
  who.addEventListener('click', () => openPicker(r.assignee_id, (id, name) => {
    r.assignee_id = id
    r.assignee_name = name
    if (id) { r.unmatched = false; r.owner_name = null }
    render()
  }))

  li.append(box, title, remove, due, who)
  const status = statusLine(r)
  if (status) li.append(el('p', `preview-status${r.unmatched ? ' warn' : ''}`, status))
  if (r.candidates?.length && r.unmatched) {
    const cands = el('div', 'cands')
    for (const u of r.candidates) {
      const b = el('button', 'cand', u.dept ? `${u.name} · ${u.dept}` : u.name)
      b.type = 'button'
      b.addEventListener('click', () => {
        r.assignee_id = u.id
        r.assignee_name = u.name
        r.unmatched = false
        r.owner_name = null
        render()
      })
      cands.append(b)
    }
    li.append(cands)
  }
  return li
}

function render() {
  $('preview-rows').replaceChildren(...rows.map(renderRow))
  sync()
}

/** 改了标题或日期，重复状态要跟着变。人动过勾选的不改他的选择 */
function recheck() {
  clearTimeout(checkTimer)
  checkTimer = setTimeout(async () => {
    const asked = rows.map((r) => ({ line: r.line, title: r.title, due_date: r.due_date }))
    if (!asked.length) return sync()
    try {
      const { rows: marks } = await api('POST', 'api/import/check', { rows: asked })
      const byLine = new Map(marks.map((m) => [m.line, m]))
      for (const r of rows) {
        const m = byLine.get(r.line)
        if (!m) continue
        r.dup = m.dup
        r.dup_line = m.dup_line
        if (!r.touched) r.checked = !m.dup && !r.marked_done
      }
      for (const li of $('preview-rows').children) {
        const r = rows.find((x) => String(x.line) === li.dataset.line)
        if (!r) continue
        li.classList.toggle('dup', !!r.dup)
        li.querySelector('.preview-check input').checked = r.checked
        let line = li.querySelector('.preview-status')
        const text = statusLine(r)
        if (!line && text) {
          line = el('p', 'preview-status')
          li.insertBefore(line, li.children[5] ?? null)
        }
        if (line) { line.textContent = text; line.hidden = !text }
      }
      sync()
    } catch (e) { toast(e.message) }
  }, 300)
}

async function fromPaste() {
  const btn = $('paste-btn')
  btn.disabled = true
  try {
    enterPreview(await api('POST', 'api/import/preview', { text: $('paste').value }))
  } catch (e) { showError(e.message) } finally { btn.disabled = false }
}

async function fromFile(file) {
  if (!file) return
  if (file.size > FILE_MAX) return showError(`${file.name}：文件不能超过 2MB`)
  try {
    enterPreview(await api('POST', 'api/import/file', undefined, {
      headers: { 'Content-Type': 'application/octet-stream', 'X-File-Name': encodeURIComponent(file.name) },
      body: file
    }))
  } catch (e) { showError(`${file.name}：${e.message}`) } finally { fileInput.value = '' }
}

$('paste-btn').addEventListener('click', fromPaste)
fileInput.addEventListener('change', () => fromFile(fileInput.files[0]))
for (const type of ['dragenter', 'dragover']) drop.addEventListener(type, (e) => { e.preventDefault(); drop.classList.add('over') })
for (const type of ['dragleave', 'drop']) drop.addEventListener(type, (e) => { e.preventDefault(); drop.classList.remove('over') })
drop.addEventListener('drop', (e) => fromFile(e.dataTransfer.files[0]))

$('preview-back').addEventListener('click', () => {
  $('stage-preview').hidden = true
  $('stage-input').hidden = false
})

$('commit-btn').addEventListener('click', async () => {
  const btn = $('commit-btn')
  const picked = rows.filter((r) => r.checked)
  if (picked.some((r) => !r.title.trim())) return toast('有一条标题是空的，先填上或取消勾选')
  btn.disabled = true
  btn.textContent = '导入中'
  try {
    const out = await api('POST', 'api/import/commit', {
      rows: picked.map(({ title, due_date, assignee_id, owner_name, note }) => ({ title, due_date, assignee_id, owner_name: assignee_id ? null : owner_name, note }))
    })
    location.href = `./?view=open&imported=${out.created}`
  } catch (e) {
    toast(e.message)
    sync()
  }
})
