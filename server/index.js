import express from 'express'
import http from 'node:http'
import path from 'node:path'
import { WebSocketServer } from 'ws'
import { MEDIA_DIR, PUBLIC_DIR } from './paths.js'
import { getSetting, setSetting } from './db.js'
import * as store from './store.js'
import { WhatsApp } from './whatsapp.js'
import { listModels, translate } from './translate.js'

const PORT = Number(process.env.PORT || 3210)
const HOST = process.env.HOST || '127.0.0.1' // local only: this server has full access to your WhatsApp

const app = express()
app.use(express.json({ limit: '80mb' }))
app.use(express.static(PUBLIC_DIR))
app.use('/media', express.static(MEDIA_DIR, { maxAge: '7d' }))

const server = http.createServer(app)
const wss = new WebSocketServer({ server, path: '/ws' })
const wa = new WhatsApp()

function broadcast(msg) {
  const data = JSON.stringify(msg)
  for (const c of wss.clients) if (c.readyState === 1) c.send(data)
}

wss.on('connection', ws => ws.send(JSON.stringify({ type: 'state', state: wa.state })))

// ---------- translation settings ----------

function defaults() {
  return getSetting('defaults', { model: null, originLang: 'English', destLang: 'Spanish' })
}

function effectiveSettings(chatId) {
  const d = defaults()
  const s = store.getChatSettings(chatId)
  return s ? { ...d, ...Object.fromEntries(Object.entries(s).filter(([, v]) => v != null)) } : { ...d, enabled: false }
}

const inflight = new Set()

function ensureTranslations(chatId, limit = 60) {
  const s = effectiveSettings(chatId)
  if (!s.enabled || !s.model || !s.originLang) return
  for (const m of store.untranslated(chatId, s.originLang, limit)) {
    const key = `${chatId}|${m.id}|${s.originLang}`
    if (inflight.has(key)) continue
    inflight.add(key)
    translate(m.text, { model: s.model, lang: s.originLang })
      .then(text => {
        store.saveTranslation(chatId, m.id, s.originLang, text, s.model)
        broadcast({ type: 'translation', chatId, msgId: m.id, lang: s.originLang, text })
      })
      .catch(err => broadcast({ type: 'translation-error', chatId, msgId: m.id, error: err.message }))
      .finally(() => inflight.delete(key))
  }
}

// ---------- WhatsApp events -> clients ----------

let chatsTimer = null
function chatsChanged() {
  clearTimeout(chatsTimer)
  chatsTimer = setTimeout(() => broadcast({ type: 'chats-changed' }), 400)
}

function pushMessage(type, chatId, id) {
  const row = store.getMessage(chatId, id)
  if (!row) return
  const s = effectiveSettings(chatId)
  const { raw_json, key_json, ...rest } = row
  broadcast({ type, chatId, message: store.decorate(rest, s.enabled ? s.originLang : null) })
}

wa.on('state', state => broadcast({ type: 'state', state }))
wa.on('chats-changed', chatsChanged)
wa.on('sync', info => { broadcast({ type: 'sync', ...info }); chatsChanged() })
wa.on('message', (chatId, id) => {
  pushMessage('message', chatId, id)
  chatsChanged()
  ensureTranslations(chatId, 5)
})
wa.on('message-changed', (chatId, id, opts) => {
  pushMessage('message-changed', chatId, id)
  if (opts?.retranslate) ensureTranslations(chatId, 5)
})

// ---------- REST API ----------

const route = fn => async (req, res) => {
  try {
    res.json((await fn(req, res)) ?? { ok: true })
  } catch (err) {
    console.error('[api]', req.method, req.path, err.message)
    res.status(400).json({ error: err.message })
  }
}

app.get('/api/state', route(() => wa.state))
app.get('/api/models', route(() => listModels()))
app.get('/api/defaults', route(() => defaults()))
app.put('/api/defaults', route(req => {
  const { model, originLang, destLang } = req.body
  setSetting('defaults', { ...defaults(), model, originLang, destLang })
  return defaults()
}))

app.get('/api/chats', route(() => store.listChats()))

app.get('/api/chats/:id', route(req => {
  const chat = store.getChat(req.params.id)
  if (!chat) throw new Error('chat not found')
  return { ...chat, settings: effectiveSettings(req.params.id) }
}))

app.get('/api/chats/:id/messages', route(req => {
  const chatId = req.params.id
  const s = effectiveSettings(chatId)
  const messages = store.listMessages(chatId, {
    before: Number(req.query.before) || undefined,
    limit: Math.min(Number(req.query.limit) || 60, 200),
    lang: s.enabled ? s.originLang : null
  })
  if (s.enabled) ensureTranslations(chatId, req.query.before ? 0 : 60)
  return messages
}))

app.put('/api/chats/:id/settings', route(req => {
  const chatId = req.params.id
  const { enabled, model, originLang, destLang } = req.body
  store.setChatSettings(chatId, { enabled, model, originLang, destLang })
  setSetting('defaults', { model, originLang, destLang }) // remember last choice for new chats
  if (enabled) ensureTranslations(chatId)
  chatsChanged()
  return effectiveSettings(chatId)
}))

app.post('/api/chats/:id/read', route(req => wa.markRead(req.params.id).then(() => { chatsChanged() })))

// Translate my draft into the contact's language (destination language).
app.post('/api/chats/:id/translate', route(async req => {
  const s = effectiveSettings(req.params.id)
  if (!s.model || !s.destLang) throw new Error('Pick a model and destination language first')
  const text = String(req.body.text || '').trim()
  if (!text) throw new Error('Nothing to translate')
  return { text: await translate(text, { model: s.model, lang: s.destLang, urgent: true }), lang: s.destLang }
}))

// Send text. If `original` is given, it is stored locally as the in-my-language version.
app.post('/api/chats/:id/send', route(async req => {
  const { text, original, replyTo } = req.body
  if (!text?.trim()) throw new Error('Empty message')
  const sent = await wa.sendText(req.params.id, text, { replyTo })
  const s = effectiveSettings(req.params.id)
  if (original && original !== text && s.originLang) {
    store.saveTranslation(sent.chatId, sent.id, s.originLang, original, s.model)
  }
  pushMessage('message-changed', sent.chatId, sent.id)
  chatsChanged()
  return sent
}))

app.post('/api/chats/:id/send-media', route(async req => {
  const { data, mimetype, fileName, caption, captionOriginal, replyTo } = req.body
  if (!data) throw new Error('No file')
  const buffer = Buffer.from(data, 'base64')
  const sent = await wa.sendMedia(req.params.id, { buffer, mimetype: mimetype || 'application/octet-stream', fileName, caption, replyTo })
  const s = effectiveSettings(req.params.id)
  if (captionOriginal && captionOriginal !== caption && s.originLang) {
    store.saveTranslation(sent.chatId, sent.id, s.originLang, captionOriginal, s.model)
  }
  pushMessage('message-changed', sent.chatId, sent.id)
  chatsChanged()
  return sent
}))

app.post('/api/chats/:id/messages/:msgId/download', route(async req => {
  const file = await wa.downloadMedia(req.params.id, req.params.msgId)
  return { file }
}))

app.post('/api/chats/:id/messages/:msgId/react', route(async req => {
  await wa.react(req.params.id, req.params.msgId, req.body.emoji || '')
  pushMessage('message-changed', req.params.id, req.params.msgId)
}))

app.post('/api/chats/:id/messages/:msgId/translate', route(async req => {
  const { id: chatId, msgId } = req.params
  const s = effectiveSettings(chatId)
  const row = store.getMessage(chatId, msgId)
  if (!row?.text) throw new Error('No text to translate')
  if (!s.model || !s.originLang) throw new Error('Pick a model and language first')
  const text = await translate(row.text, { model: s.model, lang: s.originLang, urgent: true })
  store.saveTranslation(chatId, msgId, s.originLang, text, s.model)
  broadcast({ type: 'translation', chatId, msgId, lang: s.originLang, text })
  return { text }
}))

app.post('/api/logout', route(() => wa.logout()))

app.get(/^(?!\/api|\/media|\/ws).*/, (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')))

server.listen(PORT, HOST, () => {
  console.log(`WhatsApp Translate client running at http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`)
})
store.reparseUnknown()
listModels().then(m => console.log(`[translate] ${m.models.length} Codex models available (default: ${m.default})`))
wa.start().catch(err => console.error('[wa] failed to start', err))
