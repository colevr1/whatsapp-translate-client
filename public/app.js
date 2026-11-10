const $ = sel => document.querySelector(sel)

const LANGS = [
  'English', 'Italian', 'Spanish', 'French', 'German', 'Portuguese', 'Portuguese (Brazil)', 'Dutch', 'Russian',
  'Ukrainian', 'Polish', 'Romanian', 'Greek', 'Turkish', 'Arabic', 'Hebrew', 'Persian', 'Hindi', 'Bengali', 'Urdu',
  'Chinese (Simplified)', 'Chinese (Traditional)', 'Japanese', 'Korean', 'Vietnamese', 'Thai', 'Indonesian', 'Malay',
  'Filipino', 'Swahili', 'Czech', 'Slovak', 'Hungarian', 'Swedish', 'Norwegian', 'Danish', 'Finnish', 'Albanian',
  'Serbian', 'Croatian', 'Bulgarian', 'Catalan'
]
const QUICK_REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🙏']

const S = {
  state: null,
  chats: [],
  models: [],
  defaultModel: null,
  currentId: null,
  settings: null,
  msgs: new Map(), // id -> message
  order: [], // ids, oldest first
  noMore: false,
  loadingOlder: false,
  trErrors: new Map(),
  reply: null,
  attach: null,
  busy: false
}

// ---------- utils ----------

async function api(path, opts = {}) {
  const res = await fetch(path, {
    method: opts.method || 'GET',
    headers: opts.body ? { 'Content-Type': 'application/json' } : undefined,
    body: opts.body ? JSON.stringify(opts.body) : undefined
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || res.statusText)
  return data
}
const enc = encodeURIComponent

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}
function linkify(s) {
  return esc(s).replace(/\bhttps?:\/\/[^\s<]+/g, u => `<a href="${u}" target="_blank" rel="noopener noreferrer">${u}</a>`)
}
function toast(msg) {
  const t = $('#toast')
  t.textContent = msg
  t.classList.remove('hidden')
  clearTimeout(toast.timer)
  toast.timer = setTimeout(() => t.classList.add('hidden'), 4000)
}
function hue(str) {
  let h = 0
  for (const c of str || '') h = (h * 31 + c.charCodeAt(0)) >>> 0
  return h % 360
}
function avatar(el, name, id) {
  const clean = (name || '').replace(/[^\p{L}\p{N} ]/gu, '').trim()
  el.textContent = clean ? clean.split(/\s+/).slice(0, 2).map(w => w[0]).join('') : '#'
  el.style.background = `hsl(${hue(id)} 45% 52%)`
}
function fmtTime(ts) {
  return new Date(ts * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}
function fmtListTime(ts) {
  if (!ts) return ''
  const d = new Date(ts * 1000)
  const now = new Date()
  const days = Math.floor((new Date(now.toDateString()) - new Date(d.toDateString())) / 86400000)
  if (days === 0) return fmtTime(ts)
  if (days === 1) return 'Yesterday'
  if (days < 7) return d.toLocaleDateString([], { weekday: 'long' })
  return d.toLocaleDateString()
}
function fmtDay(ts) {
  const d = new Date(ts * 1000)
  const days = Math.floor((new Date(new Date().toDateString()) - new Date(d.toDateString())) / 86400000)
  if (days === 0) return 'Today'
  if (days === 1) return 'Yesterday'
  return d.toLocaleDateString([], { weekday: days < 7 ? 'long' : undefined, day: 'numeric', month: 'long', year: 'numeric' })
}
function chatName(c) {
  if (c.display_name) return c.display_name
  const [user, server] = (c.id || '').split('@')
  if (server === 's.whatsapp.net') return '+' + user
  if (server === 'lid') return 'Unknown contact'
  return user
}
function normalize(s) {
  return String(s || '').trim().toLowerCase().replace(/\s+/g, ' ')
}
const TYPE_LABEL = {
  image: '📷 Photo', video: '🎥 Video', audio: '🎤 Audio', document: '📄 Document', sticker: '🏷️ Sticker',
  revoked: '🚫 This message was deleted'
}
function autoGrow(el) {
  el.style.height = 'auto'
  const h = el.scrollHeight + (el.offsetHeight - el.clientHeight) // include borders
  el.style.height = Math.min(h, 140) + 'px'
  el.style.overflowY = h > 140 ? 'auto' : 'hidden'
}

// ---------- connection state ----------

function applyState(state) {
  S.state = state
  const showLogin = state.connection === 'qr' || (!state.me && !S.chats.length)
  $('#login').classList.toggle('hidden', !showLogin)
  $('#app').classList.toggle('hidden', showLogin)
  if (showLogin) {
    $('#qr').classList.toggle('hidden', !state.qr)
    $('#qr-wait').classList.toggle('hidden', !!state.qr)
    if (state.qr) $('#qr').src = state.qr
    $('#login-status').textContent = state.qr ? 'Waiting for scan… (the code refreshes automatically)' : 'Connecting to WhatsApp…'
  }
  if (state.me) {
    const name = state.me.name || state.me.id?.split(':')[0].split('@')[0]
    $('#me-name').textContent = name
    avatar($('#me-avatar'), name, state.me.id)
  }
  renderSyncStatus()
}

function renderSyncStatus(extra) {
  const st = S.state
  let text = ''
  if (!st) text = ''
  else if (st.connection === 'open') text = st.syncing ? `Syncing history…${extra ? ' ' + extra : ''}` : 'Connected'
  else if (st.connection === 'connecting') text = 'Reconnecting…'
  $('#sync-status').textContent = text
}

// ---------- chat list ----------

async function loadChats() {
  S.chats = await api('/api/chats')
  renderChats()
  if (S.state) applyState(S.state)
}
let chatsTimer
function loadChatsSoon() {
  clearTimeout(chatsTimer)
  chatsTimer = setTimeout(() => loadChats().catch(() => {}), 200)
}

function renderChats() {
  const q = normalize($('#search').value)
  const list = $('#chat-list')
  list.innerHTML = ''
  const frag = document.createDocumentFragment()
  for (const c of S.chats) {
    const name = chatName(c)
    if (q && !normalize(name).includes(q) && !c.id.includes(q)) continue
    const li = document.createElement('li')
    li.className = 'chat-item' + (c.id === S.currentId ? ' active' : '')
    li.dataset.id = c.id
    const av = document.createElement('div')
    av.className = 'avatar'
    avatar(av, name, c.id)
    const last = c.last_type && c.last_type !== 'text' ? (TYPE_LABEL[c.last_type] || '') + (c.last_text ? ' ' + c.last_text : '') : (c.last_text || '')
    const unread = c.unread > 0 && c.id !== S.currentId
    li.innerHTML = `<div class="meta">
      <div class="row"><span class="name">${esc(name)}${c.tr_enabled ? '<span class="globe" title="Translation on">🌐</span>' : ''}</span>
        <span class="time ${unread ? 'unread' : ''}">${fmtListTime(c.last_ts)}</span></div>
      <div class="row"><span class="last">${c.last_from_me ? 'You: ' : ''}${esc(last)}</span>
        ${unread ? `<span class="badge">${c.unread}</span>` : ''}</div>
    </div>`
    li.prepend(av)
    li.onclick = () => openChat(c.id)
    frag.append(li)
  }
  list.append(frag)
}

// ---------- open chat ----------

async function openChat(id) {
  S.currentId = id
  S.msgs.clear()
  S.order = []
  S.noMore = false
  S.trErrors.clear()
  cancelReply()
  cancelAttach()
  closePreview()
  $('#app').classList.add('in-chat')
  $('#empty').classList.add('hidden')
  $('#chat').classList.remove('hidden')
  $('#messages').innerHTML = ''
  renderChats()

  const chat = await api(`/api/chats/${enc(id)}`)
  if (S.currentId !== id) return
  S.settings = chat.settings
  $('#chat-name').textContent = chatName(chat)
  $('#chat-sub').textContent = chat.is_group ? 'Group' : '+' + id.split('@')[0]
  avatar($('#chat-avatar'), chatName(chat), id)
  renderSettings()

  const msgs = await api(`/api/chats/${enc(id)}/messages?limit=60`)
  if (S.currentId !== id) return
  addMessages(msgs)
  if (msgs.length < 60) S.noMore = true
  renderMessages()
  scrollToBottom()
  $('#input').focus()
  api(`/api/chats/${enc(id)}/read`, { method: 'POST' }).catch(() => {})
}

async function reloadMessages() {
  const id = S.currentId
  const count = Math.max(S.order.length, 60)
  const msgs = await api(`/api/chats/${enc(id)}/messages?limit=${Math.min(count, 200)}`)
  if (S.currentId !== id) return
  S.msgs.clear()
  S.order = []
  addMessages(msgs)
  const box = $('#messages')
  const fromBottom = box.scrollHeight - box.scrollTop
  renderMessages()
  box.scrollTop = box.scrollHeight - fromBottom
}

function addMessages(list) {
  let added = 0
  for (const m of list) {
    if (!S.msgs.has(m.id)) { S.order.push(m.id); added++ }
    S.msgs.set(m.id, m)
  }
  S.order.sort((a, b) => S.msgs.get(a).ts - S.msgs.get(b).ts)
  return added
}

async function loadOlder() {
  if (S.noMore || S.loadingOlder || !S.order.length) return
  S.loadingOlder = true
  const id = S.currentId
  try {
    const oldest = S.msgs.get(S.order[0]).ts
    const msgs = await api(`/api/chats/${enc(id)}/messages?before=${oldest}&limit=60`)
    if (S.currentId !== id) return
    const added = addMessages(msgs)
    if (!added || msgs.length < 60) S.noMore = true
    if (added) {
      const box = $('#messages')
      const fromBottom = box.scrollHeight - box.scrollTop
      renderMessages()
      box.scrollTop = box.scrollHeight - fromBottom
    }
  } finally {
    S.loadingOlder = false
  }
}

// ---------- translation settings ----------

function fillSelect(sel, values, current) {
  sel.innerHTML = ''
  const vals = [...values]
  if (current && !vals.some(v => (v.id ?? v) === current)) vals.unshift(current)
  for (const v of vals) {
    const o = document.createElement('option')
    o.value = v.id ?? v
    o.textContent = v.name ?? v
    if (v.description) o.title = v.description
    sel.append(o)
  }
  if (current) sel.value = current
}

function renderSettings() {
  const s = S.settings
  $('#tr-enabled').checked = !!s.enabled
  fillSelect($('#tr-model'), S.models, s.model || S.defaultModel)
  fillSelect($('#tr-origin'), LANGS, s.originLang || 'Italian')
  fillSelect($('#tr-dest'), LANGS, s.destLang || 'French')
  $('.tr-bar').classList.toggle('off', !s.enabled)
  $('#input').placeholder = s.enabled ? `Message (${s.originLang} → ${s.destLang})` : 'Type a message'
}

async function saveSettings() {
  const body = {
    enabled: $('#tr-enabled').checked,
    model: $('#tr-model').value,
    originLang: $('#tr-origin').value,
    destLang: $('#tr-dest').value
  }
  if (body.enabled && !body.model) {
    toast('No Codex model available — is the Codex CLI installed and logged in?')
    $('#tr-enabled').checked = false
    return
  }
  const id = S.currentId
  const langChanged = body.originLang !== S.settings.originLang || body.enabled !== S.settings.enabled
  S.settings = await api(`/api/chats/${enc(id)}/settings`, { method: 'PUT', body })
  renderSettings()
  S.trErrors.clear()
  if (langChanged) await reloadMessages()
  else renderMessages()
}

// ---------- messages rendering ----------

function statusTicks(m) {
  if (!m.from_me) return ''
  const st = m.status
  if (st === 0) return '<span class="ticks" title="Failed" style="color:var(--danger)">!</span>'
  if (st === 1) return '<span class="ticks" title="Sending">🕓</span>'
  if (st >= 4) return '<span class="ticks read" title="Read">✓✓</span>'
  if (st === 3) return '<span class="ticks" title="Delivered">✓✓</span>'
  return '<span class="ticks" title="Sent">✓</span>'
}

function mediaHtml(m) {
  if (!['image', 'video', 'audio', 'document', 'sticker'].includes(m.type)) return ''
  if (m.media_state !== 'ok' || !m.media_path) {
    const label = TYPE_LABEL[m.type]
    if (m.media_state === 'pending') return `<div class="media-missing">${label} · downloading…</div>`
    if (m.media_state === 'gone') return `<div class="media-missing">${label} · no longer available on your phone</div>`
    return `<div class="media-missing">${label} · <button class="btn ghost" data-act="download">Download</button></div>`
  }
  const url = '/media/' + enc(m.media_path)
  switch (m.type) {
    case 'image': return `<div class="media"><img src="${url}" loading="lazy" data-act="zoom" alt=""></div>`
    case 'sticker': return `<div class="media sticker"><img src="${url}" loading="lazy" alt="sticker"></div>`
    case 'video': return `<div class="media"><video src="${url}" controls preload="metadata"></video></div>`
    case 'audio': return `<div class="media"><audio src="${url}" controls preload="none"></audio></div>`
    case 'document': return `<a class="doc" href="${url}" download="${esc(m.media_name || m.media_path)}" target="_blank">📄 <span>${esc(m.media_name || 'Document')}</span></a>`
  }
  return ''
}

function translationHtml(m) {
  const s = S.settings
  if (!s?.enabled || !m.text || m.type === 'revoked') return ''
  if (m.from_me) {
    if (!m.translation || normalize(m.translation) === normalize(m.text)) return ''
    return `<div class="translation out"><div class="tr-label">Original · ${esc(s.originLang)}</div><div class="tr-text">${linkify(m.translation)}</div></div>`
  }
  if (m.translation != null) {
    if (normalize(m.translation) === normalize(m.text)) return ''
    return `<div class="translation"><div class="tr-label">${esc(s.originLang)}</div><div class="tr-text">${linkify(m.translation)}</div></div>`
  }
  const err = S.trErrors.get(m.id)
  if (err) return `<div class="translation error"><div class="tr-text">Translation failed: ${esc(err)} <button class="btn ghost" data-act="retranslate">Retry</button></div></div>`
  return '<div class="translation pending"><div class="tr-text">Translating…</div></div>'
}

function messageEl(m, prev) {
  const el = document.createElement('div')
  el.className = 'msg ' + (m.from_me ? 'out' : 'in')
  el.dataset.id = m.id
  if (!prev || prev.from_me !== m.from_me || prev.sender !== m.sender) el.classList.add('gap')
  if (m.reactions?.length) el.classList.add('has-reactions')
  const isGroup = S.currentId?.endsWith('@g.us')
  const showSender = isGroup && !m.from_me && (!prev || prev.sender !== m.sender || prev.from_me)
  const body = m.type === 'revoked'
    ? '<div class="text revoked">🚫 This message was deleted</div>'
    : (m.text ? `<div class="text">${linkify(m.text)}</div>` : (!['image', 'video', 'audio', 'document', 'sticker', 'text'].includes(m.type) ? `<div class="text revoked">Unsupported message (${esc(m.type)})</div>` : ''))
  el.innerHTML = `
    <div class="bubble">
      ${showSender ? `<div class="sender" style="color:hsl(${hue(m.sender)} 55% 45%)">${esc(m.sender_name)}</div>` : ''}
      ${m.quoted_text ? `<div class="quote">${esc(m.quoted_text)}</div>` : ''}
      ${mediaHtml(m)}
      ${body}
      ${translationHtml(m)}
      <span class="foot">${fmtTime(m.ts)}${statusTicks(m)}</span>
      ${m.reactions?.length ? `<div class="reactions">${m.reactions.map(r => `<span>${esc(r.emoji)}${r.n > 1 ? r.n : ''}</span>`).join('')}</div>` : ''}
    </div>
    <div class="actions">
      <button data-act="reply" title="Reply">↩</button>
      <button data-act="react" title="React">☺</button>
      ${S.settings?.enabled && m.text && !m.from_me ? '<button data-act="retranslate" title="Translate again">🌐</button>' : ''}
    </div>`
  return el
}

function renderMessages() {
  const box = $('#messages')
  box.innerHTML = ''
  const frag = document.createDocumentFragment()
  if (!S.noMore && S.order.length) {
    const b = document.createElement('button')
    b.className = 'btn ghost load-more'
    b.textContent = 'Load older messages'
    b.onclick = loadOlder
    frag.append(b)
  }
  let prev = null
  for (const id of S.order) {
    const m = S.msgs.get(id)
    if (!prev || fmtDay(prev.ts) !== fmtDay(m.ts)) {
      const d = document.createElement('div')
      d.className = 'day'
      d.textContent = fmtDay(m.ts)
      frag.append(d)
    }
    frag.append(messageEl(m, prev))
    prev = m
  }
  box.append(frag)
}

function rerenderMessage(id) {
  const old = $(`#messages .msg[data-id="${CSS.escape(id)}"]`)
  if (!old) return
  const idx = S.order.indexOf(id)
  const prev = idx > 0 ? S.msgs.get(S.order[idx - 1]) : null
  old.replaceWith(messageEl(S.msgs.get(id), prev))
}

function appendMessage(m) {
  const box = $('#messages')
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 150
  const prev = S.order.length ? S.msgs.get(S.order[S.order.length - 1]) : null
  if (prev && m.ts < prev.ts) { // out of order: full render
    addMessages([m])
    renderMessages()
    return
  }
  addMessages([m])
  if (!prev || fmtDay(prev.ts) !== fmtDay(m.ts)) {
    const d = document.createElement('div')
    d.className = 'day'
    d.textContent = fmtDay(m.ts)
    box.append(d)
  }
  box.append(messageEl(m, prev))
  if (nearBottom || m.from_me) scrollToBottom()
}

function scrollToBottom() {
  const box = $('#messages')
  box.scrollTop = box.scrollHeight
  // images load later and change height
  setTimeout(() => { box.scrollTop = box.scrollHeight }, 150)
}

// message actions (delegated)
$('#messages').addEventListener('click', async e => {
  const btn = e.target.closest('[data-act]')
  if (!btn) return
  const msgEl = btn.closest('.msg')
  const id = msgEl?.dataset.id
  const m = S.msgs.get(id)
  const act = btn.dataset.act
  try {
    if (act === 'zoom') {
      $('#lightbox img').src = btn.src
      $('#lightbox').classList.remove('hidden')
    } else if (act === 'download') {
      btn.disabled = true
      btn.textContent = 'Downloading…'
      await api(`/api/chats/${enc(S.currentId)}/messages/${enc(id)}/download`, { method: 'POST' })
    } else if (act === 'reply') {
      S.reply = m
      $('#reply-text').textContent = m.text || TYPE_LABEL[m.type] || ''
      $('#reply-box').classList.remove('hidden')
      $('#input').focus()
    } else if (act === 'react') {
      showReactPicker(msgEl, m)
    } else if (act === 'pick-reaction') {
      const emoji = btn.dataset.emoji
      msgEl.querySelector('.react-pop')?.remove()
      await api(`/api/chats/${enc(S.currentId)}/messages/${enc(id)}/react`, { method: 'POST', body: { emoji } })
    } else if (act === 'retranslate') {
      S.trErrors.delete(id)
      m.translation = null
      rerenderMessage(id)
      await api(`/api/chats/${enc(S.currentId)}/messages/${enc(id)}/translate`, { method: 'POST' })
    }
  } catch (err) {
    if (act === 'retranslate') { S.trErrors.set(id, err.message); rerenderMessage(id) }
    toast(err.message)
  }
})

function showReactPicker(msgEl, m) {
  document.querySelectorAll('.react-pop').forEach(p => p.remove())
  const pop = document.createElement('div')
  pop.className = 'react-pop'
  pop.innerHTML = QUICK_REACTIONS.map(e => `<button data-act="pick-reaction" data-emoji="${e}">${e}</button>`).join('')
  msgEl.append(pop)
  setTimeout(() => document.addEventListener('click', function close(ev) {
    if (!pop.contains(ev.target)) { pop.remove(); document.removeEventListener('click', close) }
  }), 0)
}

$('#messages').addEventListener('scroll', e => { if (e.target.scrollTop < 80) loadOlder() })
$('#lightbox').onclick = () => $('#lightbox').classList.add('hidden')

// ---------- composer ----------

function cancelReply() {
  S.reply = null
  $('#reply-box').classList.add('hidden')
}
function cancelAttach() {
  S.attach = null
  $('#file').value = ''
  $('#attach-box').classList.add('hidden')
}
function closePreview() {
  $('#preview').classList.add('hidden')
  $('#preview-text').value = ''
  S.previewOriginal = null
}

$('#reply-cancel').onclick = cancelReply
$('#attach-cancel').onclick = cancelAttach
$('#attach-btn').onclick = () => $('#file').click()
$('#file').onchange = () => {
  const f = $('#file').files[0]
  if (!f) return
  if (f.size > 60 * 1024 * 1024) { toast('File too large (max 60 MB)'); return cancelAttach() }
  S.attach = f
  $('#attach-name').textContent = `${f.name} · ${(f.size / 1024).toFixed(0)} KB`
  const thumb = $('#attach-thumb')
  if (f.type.startsWith('image/')) {
    thumb.src = URL.createObjectURL(f)
    thumb.classList.remove('hidden')
  } else thumb.classList.add('hidden')
  $('#attach-box').classList.remove('hidden')
  $('#input').placeholder = 'Add a caption'
  $('#input').focus()
}

$('#input').addEventListener('input', e => autoGrow(e.target))
$('#input').addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); onSend() }
  if (e.key === 'Escape') { cancelReply(); closePreview() }
})
$('#send').onclick = onSend

$('#preview-text').addEventListener('input', e => autoGrow(e.target))
$('#preview-text').addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); $('#preview-send').click() }
  if (e.key === 'Escape') { closePreview(); $('#input').focus() }
})
$('#preview-cancel').onclick = () => { closePreview(); $('#input').focus() }
$('#preview-send').onclick = () => {
  const translated = $('#preview-text').value.trim()
  if (!translated) return
  doSend(translated, S.previewOriginal)
}
$('#preview-send-original').onclick = () => doSend(S.previewOriginal, null)

async function onSend() {
  if (S.busy) return
  const text = $('#input').value.trim()
  if (!text && !S.attach) return
  if (S.settings?.enabled && text) {
    // translate my message into their language and show it for review first
    S.busy = true
    S.previewOriginal = text
    $('#preview-original').textContent = text
    $('#preview-lang').textContent = `${S.settings.destLang} · translating…`
    $('#preview-text').value = ''
    $('#preview-text').placeholder = 'Translating…'
    $('#preview-send').disabled = true
    $('#preview').classList.remove('hidden')
    try {
      const r = await api(`/api/chats/${enc(S.currentId)}/translate`, { method: 'POST', body: { text } })
      if (S.previewOriginal !== text) return
      $('#preview-lang').textContent = `${r.lang} · will be sent`
      $('#preview-text').value = r.text
      $('#preview-send').disabled = false
      autoGrow($('#preview-text'))
      $('#preview-text').focus()
    } catch (err) {
      $('#preview-lang').textContent = 'Translation failed'
      $('#preview-text').placeholder = err.message
    } finally {
      S.busy = false
    }
    return
  }
  doSend(text, null)
}

async function doSend(text, original) {
  if (S.busy) return
  S.busy = true
  const chatId = S.currentId
  try {
    if (S.attach) {
      const f = S.attach
      const data = await fileToBase64(f)
      await api(`/api/chats/${enc(chatId)}/send-media`, {
        method: 'POST',
        body: { data, mimetype: f.type || 'application/octet-stream', fileName: f.name, caption: text || undefined, captionOriginal: original || undefined, replyTo: S.reply?.id }
      })
      cancelAttach()
    } else {
      await api(`/api/chats/${enc(chatId)}/send`, { method: 'POST', body: { text, original, replyTo: S.reply?.id } })
    }
    $('#input').value = ''
    autoGrow($('#input'))
    cancelReply()
    closePreview()
    renderSettings()
    $('#input').focus()
  } catch (err) {
    toast('Send failed: ' + err.message)
  } finally {
    S.busy = false
  }
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result).split(',')[1])
    r.onerror = reject
    r.readAsDataURL(file)
  })
}

// ---------- misc UI ----------

$('#search').addEventListener('input', renderChats)
$('#back').onclick = () => {
  $('#app').classList.remove('in-chat')
  S.currentId = null
  renderChats()
}
for (const id of ['#tr-enabled', '#tr-model', '#tr-origin', '#tr-dest']) {
  $(id).addEventListener('change', () => saveSettings().catch(err => toast(err.message)))
}
$('#logout').onclick = async () => {
  if (!confirm('Log out of WhatsApp on this client? Locally stored chats are kept.')) return
  await api('/api/logout', { method: 'POST' }).catch(err => toast(err.message))
}
window.addEventListener('focus', () => {
  if (S.currentId) api(`/api/chats/${enc(S.currentId)}/read`, { method: 'POST' }).catch(() => {})
})

// ---------- live updates ----------

function connectWs() {
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`)
  ws.onmessage = e => {
    const msg = JSON.parse(e.data)
    switch (msg.type) {
      case 'state': {
        const wasOpen = S.state?.connection === 'open'
        applyState(msg.state)
        if (!wasOpen && msg.state.connection === 'open') loadChatsSoon()
        break
      }
      case 'chats-changed':
        loadChatsSoon()
        break
      case 'sync':
        renderSyncStatus(msg.progress != null ? `${msg.progress}%` : '')
        break
      case 'message':
        if (msg.chatId === S.currentId && !S.msgs.has(msg.message.id)) {
          appendMessage(msg.message)
          if (!msg.message.from_me && document.hasFocus()) api(`/api/chats/${enc(S.currentId)}/read`, { method: 'POST' }).catch(() => {})
        }
        break
      case 'message-changed':
        if (msg.chatId === S.currentId) {
          const had = S.msgs.has(msg.message.id)
          // keep a translation we already have if the server copy has none yet
          if (had && msg.message.translation == null) msg.message.translation = S.msgs.get(msg.message.id).translation
          if (had) { S.msgs.set(msg.message.id, msg.message); rerenderMessage(msg.message.id) } else appendMessage(msg.message)
        }
        break
      case 'translation':
        if (msg.chatId === S.currentId && S.msgs.has(msg.msgId) && msg.lang === S.settings?.originLang) {
          S.msgs.get(msg.msgId).translation = msg.text
          S.trErrors.delete(msg.msgId)
          rerenderMessage(msg.msgId)
        }
        break
      case 'translation-error':
        if (msg.chatId === S.currentId && S.msgs.has(msg.msgId)) {
          S.trErrors.set(msg.msgId, msg.error)
          rerenderMessage(msg.msgId)
        }
        break
    }
  }
  ws.onclose = () => setTimeout(connectWs, 1500)
}

async function init() {
  const [models, state] = await Promise.all([api('/api/models'), api('/api/state')])
  S.models = models.models
  S.defaultModel = models.default
  if (models.error) toast(models.error)
  await loadChats()
  applyState(state)
  connectWs()
}
init().catch(err => toast(err.message))
