// 设置页：改一项存一项，没有保存按钮，下一次操作就用新值
async function saveSetting(body, revert) {
  try {
    await api('PUT', 'api/settings', body)
    toast('已保存')
  } catch (err) {
    revert?.()
    toast(err.message)
  }
}

const bindSelect = (id, key) => $(id).addEventListener('change', (e) => saveSetting({ [key]: e.target.value }))
bindSelect('s-quick-due', 'quick_due')
bindSelect('s-digest', 'digest_time')

const bindToggle = (id, key) => $(id).addEventListener('change', (e) => {
  const box = e.target
  saveSetting({ [key]: box.checked }, () => { box.checked = !box.checked })
})
bindToggle('s-weekly', 'weekly_push')
bindToggle('s-notify', 'notify_assignee')

$('s-assignee').addEventListener('click', () => {
  const btn = $('s-assignee')
  openPicker(Number(btn.dataset.id) || null, (id, name) => {
    btn.dataset.id = id ?? ''
    $('s-assignee-name').textContent = id ? name : '不指派'
    saveSetting({ default_assignee_id: id })
  })
})
