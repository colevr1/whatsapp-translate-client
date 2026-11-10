// WhatsApp connection via Baileys (WhatsApp Web multi-device protocol).
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import path from 'node:path'
import makeWASocket, {
  Browsers, DisconnectReason, downloadMediaMessage, fetchLatestBaileysVersion, fetchLatestWaWebVersion,
  makeCacheableSignalKeyStore, useMultiFileAuthState, isJidGroup, jidNormalizedUser, ALL_WA_PATCH_NAMES
} from 'baileys'
import pino from 'pino'
import QRCode from 'qrcode'
import { AUTH_DIR, MEDIA_DIR } from './paths.js'
import * as store from './store.js'
import { tx } from './db.js'

const logger = pino({ level: process.env.WA_LOG_LEVEL || 'warn' })
const AUTO_DOWNLOAD_MAX = 25 * 1024 * 1024 // auto-save media up to 25 MB

const EXT = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif',
  'video/mp4': 'mp4', 'video/3gpp': '3gp', 'audio/ogg': 'ogg', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a',
  'audio/aac': 'aac', 'application/pdf': 'pdf'
}

export class WhatsApp extends EventEmitter {
  constructor() {
    super()
    this.sock = null
    this.state = { connection: 'connecting', qr: null, me: null, syncing: false }
    this.mediaQueue = []
    this.mediaRunning = 0
    fs.mkdirSync(MEDIA_DIR, { recursive: true })
  }

  setState(patch) {
    Object.assign(this.state, patch)
    this.emit('state', this.state)
  }

  async start() {
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR)
    // after pairing, WhatsApp restarts the connection: claim the data before any sync arrives
    if (state.creds.me?.id) this.claimAccount(state.creds.me.id)
    // WhatsApp rejects outdated client versions, so prefer the live WA Web version.
    let version
    try { ({ version } = await fetchLatestWaWebVersion({})) } catch {}
    if (!version) try { ({ version } = await fetchLatestBaileysVersion()) } catch {}

    const sock = makeWASocket({
      version,
      logger,
      auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) },
      // A "Desktop" browser gets the larger history sync. WhatsApp currently rejects
      // the macOS/Windows Desktop profiles (428) but accepts Ubuntu's.
      browser: Browsers.ubuntu('Desktop'),
      syncFullHistory: true,
      markOnlineOnConnect: false,
      getMessage: async key => {
        const row = store.findMessageById(key.id)
        return store.rawMessage(row)?.message || undefined
      }
    })
    this.sock = sock

    sock.ev.on('creds.update', saveCreds)

    // One odd event from WhatsApp must never take the app down: log it and move on.
    const on = (event, handler) => sock.ev.on(event, (...args) => {
      try {
        const r = handler(...args)
        if (r?.catch) r.catch(err => console.error(`[wa] ${event} handler failed:`, err))
      } catch (err) {
        console.error(`[wa] ${event} handler failed:`, err)
      }
    })

    on('connection.update', async ({ connection, lastDisconnect, qr }) => {
      if (qr) this.setState({ connection: 'qr', qr: await QRCode.toDataURL(qr, { margin: 1, width: 320 }) })
      if (connection === 'open') {
        this.claimAccount(sock.user.id)
        this.setState({ connection: 'open', qr: null, me: sock.user })
        this.refreshGroups().catch(err => logger.warn({ err }, 'group fetch failed'))
        for (const r of store.recentFailedMedia()) this.queueMedia(r.chat_id, r.id, true)
        // Contact names live in app-state collections that sometimes stay unsynced after
        // pairing (blocked while the sync key arrives). Pull them once per session.
        setTimeout(() => {
          if (this.sock !== sock || this.state.connection !== 'open') return
          sock.resyncAppState(ALL_WA_PATCH_NAMES, false)
            .then(() => this.emit('chats-changed'))
            .catch(err => console.warn('[wa] app-state resync failed:', err.message))
        }, 8000)
      }
      if (connection === 'close') {
        const code = lastDisconnect?.error?.output?.statusCode
        if (this.sock !== sock) return // replaced by logout/restart
        if (code === DisconnectReason.loggedOut) {
          fs.rmSync(AUTH_DIR, { recursive: true, force: true })
          this.setState({ connection: 'connecting', qr: null, me: null })
        } else {
          this.setState({ connection: 'connecting' })
        }
        setTimeout(() => this.start().catch(e => console.error('[wa] restart failed', e)), code === DisconnectReason.loggedOut ? 500 : 2000)
      }
    })

    on('messaging-history.set', ({ chats, contacts, messages, lidPnMappings, progress, isLatest }) => {
      tx(() => {
        for (const m of lidPnMappings || []) store.addLidMapping(m.lid, m.pn)
        for (const c of contacts || []) store.upsertContact(c)
        for (const c of chats || []) this.applyChat(c)
      })
      tx(() => { for (const m of messages || []) this.safeIngest(m, { history: true }) })
      this.setState({ syncing: !(progress >= 100 || isLatest) })
      this.emit('chats-changed')
      this.emit('sync', { progress: progress ?? null, chats: chats?.length || 0, messages: messages?.length || 0 })
    })

    on('lid-mapping.update', upd => {
      for (const m of [].concat(upd || [])) store.addLidMapping(m.lid, m.pn)
    })

    on('chats.upsert', chats => { for (const c of chats) this.applyChat(c); this.emit('chats-changed') })
    on('chats.update', chats => { for (const c of chats) this.applyChat(c); this.emit('chats-changed') })
    on('contacts.upsert', cs => { for (const c of cs) store.upsertContact(c); this.emit('chats-changed') })
    on('contacts.update', cs => { for (const c of cs) store.upsertContact(c); this.emit('chats-changed') })
    on('groups.update', gs => {
      for (const g of gs) if (g.id && g.subject) store.upsertChat({ id: g.id, name: g.subject })
      this.emit('chats-changed')
    })
    on('groups.upsert', gs => {
      for (const g of gs) store.upsertChat({ id: g.id, name: g.subject })
      this.emit('chats-changed')
    })

    on('messages.upsert', ({ messages, type }) => {
      for (const m of messages) this.safeIngest(m, { live: type === 'notify' })
    })

    on('messages.update', updates => {
      for (const { key, update } of updates) {
        if (update?.status == null || !key?.id) continue
        // some receipts carry only the message id, not the chat
        const chatId = this.chatIdFor(key)
        if (!chatId) continue
        store.updateStatus(chatId, key.id, update.status)
        this.emit('message-changed', chatId, key.id)
      }
    })

    on('messages.reaction', reactions => {
      for (const { key, reaction } of reactions) {
        const chatId = key?.id && this.chatIdFor(key)
        if (!chatId) continue
        const sender = reaction.key?.fromMe ? 'me' : (store.canonical(reaction.key?.participant || reaction.key?.remoteJid) || 'unknown')
        store.saveReaction({ chatId, msgId: key.id, sender, emoji: reaction.text })
        this.emit('message-changed', chatId, key.id)
      }
    })
  }

  /** Wipe local chats and media if a different WhatsApp account than before has linked. */
  claimAccount(meId) {
    if (!store.claimAccount(jidNormalizedUser(meId))) return
    this.mediaQueue = []
    fs.rmSync(MEDIA_DIR, { recursive: true, force: true })
    fs.mkdirSync(MEDIA_DIR, { recursive: true })
    console.log('[wa] a different WhatsApp account linked: removed the previous account\'s local data')
    this.emit('chats-changed')
  }

  /** Chat a message key belongs to: from the key, or by looking the message up. */
  chatIdFor(key) {
    return (key.remoteJid && store.canonical(key.remoteJid)) || store.findMessageById(key.id)?.chat_id || null
  }

  applyChat(c) {
    if (!c?.id) return
    const ts = Number(c.conversationTimestamp || c.lastMessageRecvTimestamp || 0)
    store.upsertChat({
      id: c.id,
      name: c.name || (isJidGroup(c.id) ? c.subject : null) || null,
      lastTs: ts,
      unread: c.unreadCount == null ? undefined : Math.max(0, c.unreadCount),
      archived: c.archived ?? undefined,
      pinned: c.pinned == null ? undefined : !!c.pinned
    })
  }

  /** ingest() that skips a message it can't store instead of aborting the batch. */
  safeIngest(m, opts) {
    try {
      this.ingest(m, opts)
    } catch (err) {
      console.error('[wa] could not store message', m?.key?.id, err)
    }
  }

  ingest(m, { live = false, history = false } = {}) {
    let parsed
    try { parsed = store.parseMessage(m) } catch (err) { logger.warn({ err }, 'parse failed'); return }
    if (!parsed) return
    if (parsed.kind === 'reaction') {
      store.saveReaction(parsed)
      if (!history) this.emit('message-changed', parsed.chatId, parsed.msgId)
      return
    }
    if (parsed.kind === 'edit') {
      store.applyEdit(parsed.chatId, parsed.msgId, parsed.text)
      if (!history) this.emit('message-changed', parsed.chatId, parsed.msgId, { retranslate: true })
      return
    }
    if (parsed.kind === 'revoke') {
      store.applyRevoke(parsed.chatId, parsed.msgId)
      if (!history) this.emit('message-changed', parsed.chatId, parsed.msgId)
      return
    }
    const r = parsed.row
    const isNew = !store.getMessage(r.chat_id, r.id)
    store.saveMessageRow(r)
    if (isNew) {
      store.upsertChat({ id: r.chat_id, lastTs: r.ts })
      if (live && !r.from_me) {
        // bump unread count for brand-new incoming messages
        const chat = store.getChat(r.chat_id)
        store.upsertChat({ id: r.chat_id, unread: (chat?.unread || 0) + 1 })
      }
    }
    if (r.media_state === 'pending' && isNew) {
      const autoDownload = r.type === 'image' || r.type === 'sticker' || r.type === 'audio' || (parsed.row.media_size || 0) <= AUTO_DOWNLOAD_MAX
      if (autoDownload) this.queueMedia(r.chat_id, r.id, history)
      else store.setMediaState(r.chat_id, r.id, 'remote')
    }
    if (!history && isNew) this.emit('message', r.chat_id, r.id, { live })
  }

  // ---------- media ----------

  queueMedia(chatId, id, low = false) {
    if (low) this.mediaQueue.push([chatId, id])
    else this.mediaQueue.unshift([chatId, id])
    this.pumpMedia()
  }

  pumpMedia() {
    while (this.mediaRunning < 3 && this.mediaQueue.length) {
      const [chatId, id] = this.mediaQueue.shift()
      this.mediaRunning++
      this.downloadMedia(chatId, id)
        .catch(() => {})
        .finally(() => { this.mediaRunning--; this.pumpMedia() })
    }
  }

  async downloadMedia(chatId, id) {
    const row = store.getMessage(chatId, id)
    if (!row) throw new Error('message not found')
    if (row.media_path && fs.existsSync(path.join(MEDIA_DIR, row.media_path))) return row.media_path
    let msg = store.rawMessage(row)
    try {
      let buffer
      try {
        buffer = await downloadMediaMessage(msg, 'buffer', {}, { logger })
      } catch (err) {
        // Expired media (403 expired link, 404/410 removed from server): ask the phone to
        // re-upload it, then retry. Baileys' own retry never fires: it checks `error.status`,
        // but its Boom errors carry `output.statusCode`.
        const code = err?.output?.statusCode ?? err?.status
        if (![403, 404, 410].includes(code) || !this.sock || this.state.connection !== 'open') throw err
        msg = await this.sock.updateMediaMessage(msg)
        store.saveRawMessage(chatId, id, msg)
        buffer = await downloadMediaMessage(msg, 'buffer', {}, { logger })
      }
      const base = (row.media_mime || '').split(';')[0].trim()
      const ext = EXT[base] || (row.media_name && path.extname(row.media_name).slice(1)) || base.split('/')[1] || 'bin'
      const file = `${chatId.replace(/[^a-zA-Z0-9]/g, '_')}_${id.replace(/[^a-zA-Z0-9]/g, '_')}.${ext}`
      fs.writeFileSync(path.join(MEDIA_DIR, file), buffer)
      store.setMediaState(chatId, id, 'ok', file)
      this.emit('message-changed', chatId, id)
      return file
    } catch (err) {
      // the phone answered the re-upload request but no longer has the file
      const gone = /Failed to re-upload media/.test(err?.message || '')
      store.setMediaState(chatId, id, gone ? 'gone' : 'failed')
      this.emit('message-changed', chatId, id)
      throw err
    }
  }

  // ---------- actions ----------

  requireOpen() {
    if (!this.sock || this.state.connection !== 'open') throw new Error('WhatsApp is not connected')
  }

  async refreshGroups() {
    const groups = await this.sock.groupFetchAllParticipating()
    tx(() => { for (const g of Object.values(groups)) store.upsertChat({ id: g.id, name: g.subject }) })
    this.emit('chats-changed')
  }

  async quotedFor(chatId, replyToId) {
    if (!replyToId) return undefined
    return store.rawMessage(store.getMessage(chatId, replyToId)) || undefined
  }

  async sendText(chatId, text, { replyTo } = {}) {
    this.requireOpen()
    const sent = await this.sock.sendMessage(chatId, { text }, { quoted: await this.quotedFor(chatId, replyTo) })
    this.ingest(sent)
    return { chatId: store.canonical(sent.key.remoteJid), id: sent.key.id }
  }

  async sendMedia(chatId, { buffer, mimetype, fileName, caption, replyTo }) {
    this.requireOpen()
    let content
    if (mimetype.startsWith('image/') && mimetype !== 'image/svg+xml') content = { image: buffer, caption, mimetype }
    else if (mimetype.startsWith('video/')) content = { video: buffer, caption, mimetype }
    else if (mimetype.startsWith('audio/')) content = { audio: buffer, mimetype }
    else content = { document: buffer, mimetype, fileName, caption }
    const sent = await this.sock.sendMessage(chatId, content, { quoted: await this.quotedFor(chatId, replyTo) })
    // keep our own copy of what we sent
    const cid = store.canonical(sent.key.remoteJid)
    this.ingest(sent)
    const ext = (fileName && path.extname(fileName).slice(1)) || EXT[mimetype] || 'bin'
    const file = `${cid.replace(/[^a-zA-Z0-9]/g, '_')}_${sent.key.id}.${ext}`
    fs.writeFileSync(path.join(MEDIA_DIR, file), buffer)
    store.setMediaState(cid, sent.key.id, 'ok', file)
    return { chatId: cid, id: sent.key.id }
  }

  async react(chatId, msgId, emoji) {
    this.requireOpen()
    const row = store.getMessage(chatId, msgId)
    if (!row) throw new Error('message not found')
    await this.sock.sendMessage(chatId, { react: { text: emoji, key: JSON.parse(row.key_json) } })
    store.saveReaction({ chatId, msgId, sender: 'me', emoji })
  }

  async markRead(chatId) {
    store.upsertChat({ id: chatId, unread: 0 })
    if (!this.sock || this.state.connection !== 'open') return
    const rows = store.listMessages(chatId, { limit: 50 }).filter(r => !r.from_me)
    const keys = rows.map(r => JSON.parse(store.getMessage(chatId, r.id).key_json))
    if (keys.length) await this.sock.readMessages(keys).catch(() => {})
  }

  async logout() {
    const sock = this.sock
    this.sock = null
    try { await sock?.logout() } catch {}
    fs.rmSync(AUTH_DIR, { recursive: true, force: true })
    this.setState({ connection: 'connecting', qr: null, me: null })
    await this.start()
  }
}
