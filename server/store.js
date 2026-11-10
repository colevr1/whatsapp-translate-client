// Local persistence of chats, contacts and messages, plus helpers to turn
// Baileys message objects into flat rows.
import { BufferJSON, normalizeMessageContent, getContentType, jidNormalizedUser, isJidGroup } from 'baileys'
import { db, tx, getSetting, setSetting } from './db.js'

// ---------- JIDs ----------
// WhatsApp now addresses many users by an opaque LID (xxx@lid) instead of their
// phone number. We keep one chat per person by mapping LIDs to phone JIDs when known.

const lidCache = new Map()

export function lidToPn(lid) {
  if (lidCache.has(lid)) return lidCache.get(lid)
  const row = db.prepare('SELECT pn FROM lid_map WHERE lid = ?').get(lid)
  lidCache.set(lid, row?.pn || null)
  return row?.pn || null
}

export function canonical(jid) {
  if (!jid) return jid
  if (isJidGroup(jid)) return jid
  const n = jidNormalizedUser(jid)
  if (n.endsWith('@lid')) return lidToPn(n) || n
  return n
}

/** Record a lid <-> phone mapping and merge any data stored under the lid. Returns true if new. */
export function addLidMapping(lid, pn) {
  if (!lid || !pn) return false
  lid = jidNormalizedUser(lid)
  pn = jidNormalizedUser(pn)
  if (!lid.endsWith('@lid') || !pn.endsWith('@s.whatsapp.net')) return false
  if (lidToPn(lid) === pn) return false
  db.prepare('INSERT INTO lid_map (lid, pn) VALUES (?, ?) ON CONFLICT(lid) DO UPDATE SET pn = excluded.pn').run(lid, pn)
  lidCache.set(lid, pn)
  mergeChat(lid, pn)
  return true
}

function mergeChat(from, to) {
  const exists = db.prepare('SELECT 1 FROM chats WHERE id = ?').get(from)
  const hasContact = db.prepare('SELECT 1 FROM contacts WHERE id = ?').get(from)
  if (!exists && !hasContact) {
    db.prepare('UPDATE messages SET sender = ? WHERE sender = ?').run(to, from)
    return
  }
  tx(() => {
    if (exists) {
      const a = db.prepare('SELECT * FROM chats WHERE id = ?').get(from)
      db.prepare(`INSERT INTO chats (id, name, is_group, last_ts, unread, archived, pinned) VALUES (?, ?, 0, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET name = COALESCE(chats.name, excluded.name), last_ts = MAX(chats.last_ts, excluded.last_ts),
        unread = chats.unread + excluded.unread`).run(to, a.name, a.last_ts, a.unread, a.archived, a.pinned)
      db.prepare('DELETE FROM chats WHERE id = ?').run(from)
    }
    for (const table of ['messages', 'translations', 'reactions', 'chat_settings']) {
      db.prepare(`UPDATE OR IGNORE ${table} SET chat_id = ? WHERE chat_id = ?`).run(to, from)
      db.prepare(`DELETE FROM ${table} WHERE chat_id = ?`).run(from)
    }
    db.prepare('UPDATE messages SET sender = ? WHERE sender = ?').run(to, from)
    if (hasContact) {
      const c = db.prepare('SELECT * FROM contacts WHERE id = ?').get(from)
      upsertContact({ id: to, name: c.name, notify: c.notify, verifiedName: c.verified_name })
      db.prepare('DELETE FROM contacts WHERE id = ?').run(from)
    }
  })
}

// ---------- account ----------

const ACCOUNT_TABLES = ['chats', 'contacts', 'lid_map', 'messages', 'reactions', 'translations', 'chat_settings']

/**
 * The local data belongs to one WhatsApp account. When a different account links,
 * delete the previous account's chats so the two never mix. Returns true if data was wiped.
 */
export function claimAccount(accountJid) {
  const owner = getSetting('account', null)
  if (owner === accountJid) return false
  const hadData = !!db.prepare('SELECT 1 FROM chats LIMIT 1').get()
  const wipe = !!owner && hadData
  if (wipe) {
    tx(() => { for (const t of ACCOUNT_TABLES) db.exec(`DELETE FROM ${t}`) })
    lidCache.clear()
  }
  setSetting('account', accountJid)
  return wipe
}

// ---------- contacts & chats ----------

export function upsertContact(c) {
  if (!c?.id) return
  if (c.lid && c.phoneNumber) addLidMapping(c.lid, c.phoneNumber)
  if (c.id.endsWith('@lid') && c.phoneNumber) addLidMapping(c.id, c.phoneNumber)
  const id = canonical(c.id)
  db.prepare(`INSERT INTO contacts (id, name, notify, verified_name) VALUES (?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET name = COALESCE(excluded.name, contacts.name),
      notify = COALESCE(excluded.notify, contacts.notify),
      verified_name = COALESCE(excluded.verified_name, contacts.verified_name)`)
    .run(id, c.name || null, c.notify || null, c.verifiedName || null)
}

export function upsertChat({ id, name, lastTs, unread, archived, pinned }) {
  if (!id || ignoredJid(id)) return
  id = canonical(id)
  db.prepare(`INSERT INTO chats (id, name, is_group, last_ts, unread, archived, pinned) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name = COALESCE(excluded.name, chats.name),
      last_ts = MAX(chats.last_ts, excluded.last_ts),
      unread = COALESCE(?, chats.unread),
      archived = COALESCE(?, chats.archived),
      pinned = COALESCE(?, chats.pinned)`)
    .run(id, name || null, isJidGroup(id) ? 1 : 0, lastTs || 0, unread ?? 0, archived ? 1 : 0, pinned ? 1 : 0,
      unread ?? null, archived == null ? null : (archived ? 1 : 0), pinned == null ? null : (pinned ? 1 : 0))
}

export function ignoredJid(jid) {
  return !jid || jid === 'status@broadcast' || jid.endsWith('@newsletter') || jid.endsWith('@broadcast')
}

export function listChats() {
  return db.prepare(`
    SELECT c.*, COALESCE(c.name, ct.name, ct.notify, ct.verified_name) AS display_name,
      m.text AS last_text, m.type AS last_type, m.from_me AS last_from_me, m.status AS last_status,
      s.enabled AS tr_enabled
    FROM chats c
    LEFT JOIN contacts ct ON ct.id = c.id
    LEFT JOIN chat_settings s ON s.chat_id = c.id
    LEFT JOIN messages m ON m.rowid = (SELECT rowid FROM messages WHERE chat_id = c.id ORDER BY ts DESC LIMIT 1)
    WHERE c.archived = 0 OR c.unread > 0
    ORDER BY c.pinned DESC, c.last_ts DESC
    LIMIT 1000`).all()
}

export function getChat(id) {
  return db.prepare(`SELECT c.*, COALESCE(c.name, ct.name, ct.notify, ct.verified_name) AS display_name
    FROM chats c LEFT JOIN contacts ct ON ct.id = c.id WHERE c.id = ?`).get(id)
}

export function contactName(jid) {
  const r = db.prepare('SELECT COALESCE(name, notify, verified_name) AS n FROM contacts WHERE id = ?').get(jid)
  return r?.n || null
}

// ---------- messages ----------

const MEDIA_TYPES = {
  imageMessage: 'image',
  videoMessage: 'video',
  audioMessage: 'audio',
  documentMessage: 'document',
  stickerMessage: 'sticker'
}

function toNum(v) {
  if (v == null) return 0
  if (typeof v === 'object' && typeof v.toNumber === 'function') return v.toNumber()
  if (typeof v === 'object' && 'low' in v) return (v.high >>> 0) * 2 ** 32 + (v.low >>> 0)
  return Number(v)
}

function quotedText(ctx) {
  const q = ctx?.quotedMessage && normalizeMessageContent(ctx.quotedMessage)
  if (!q) return null
  const t = getContentType(q)
  return q.conversation || q[t]?.text || q[t]?.caption || (MEDIA_TYPES[t] ? `[${MEDIA_TYPES[t]}]` : null)
}

// Business messages (verification codes, promos, WhatsApp notices)
function interactiveText(b) {
  if (!b) return null
  const h = b.header || {}
  const headerCaption = h.imageMessage?.caption || h.videoMessage?.caption || h.documentMessage?.caption
  const parts = [h.title, headerCaption, b.body?.text, b.footer?.text].filter(Boolean)
  return parts.length ? [...new Set(parts)].join('\n\n') : null
}

function templateText(b) {
  const t = b.hydratedTemplate || b.hydratedFourRowTemplate || b.fourRowTemplate
  if (t) {
    const parts = [t.hydratedTitleText, t.hydratedContentText || t.content?.namespace, t.hydratedFooterText,
      t.imageMessage?.caption, t.videoMessage?.caption].filter(Boolean)
    if (parts.length) return [...new Set(parts)].join('\n\n')
  }
  return interactiveText(b.interactiveMessageTemplate)
}

/**
 * Turn a Baileys WAMessage into one of:
 *  { kind: 'message', row }      - a displayable message
 *  { kind: 'reaction', ... }     - reaction to another message
 *  { kind: 'edit' | 'revoke', ...}
 *  null                          - nothing to show
 */
export function parseMessage(m) {
  const key = m.key || {}
  let remote = key.remoteJid
  if (ignoredJid(remote)) return null
  if (remote?.endsWith('@lid') && key.remoteJidAlt) addLidMapping(remote, key.remoteJidAlt)
  if (key.participant?.endsWith('@lid') && key.participantAlt) addLidMapping(key.participant, key.participantAlt)
  const chatId = canonical(remote)
  const content = normalizeMessageContent(m.message)
  if (!content) return null
  const type = getContentType(content)
  if (!type) return null
  const body = content[type]

  if (type === 'reactionMessage') {
    return {
      kind: 'reaction', chatId, msgId: body.key?.id,
      sender: key.fromMe ? 'me' : canonical(key.participant || remote),
      emoji: body.text || null
    }
  }
  if (type === 'protocolMessage') {
    if (body.type === 14 && body.editedMessage) { // MESSAGE_EDIT
      const ed = normalizeMessageContent(body.editedMessage)
      const et = getContentType(ed)
      const text = ed?.conversation || ed?.[et]?.text || ed?.[et]?.caption
      return text ? { kind: 'edit', chatId, msgId: body.key?.id, text } : null
    }
    if (body.type === 0) return { kind: 'revoke', chatId, msgId: body.key?.id } // REVOKE
    return null
  }
  if (['senderKeyDistributionMessage', 'messageContextInfo', 'pollUpdateMessage', 'keepInChatMessage',
    'encReactionMessage', 'peerDataOperationRequestMessage', 'peerDataOperationRequestResponseMessage',
    'albumMessage', 'placeholderMessage'].includes(type)) return null

  let text = null
  let mediaType = MEDIA_TYPES[type] || null
  if (type === 'conversation') text = content.conversation
  else if (type === 'extendedTextMessage') text = body.text
  else if (mediaType) text = body.caption || null
  else if (type === 'locationMessage' || type === 'liveLocationMessage') {
    text = `📍 ${body.name || 'Location'} https://maps.google.com/?q=${body.degreesLatitude},${body.degreesLongitude}`
  } else if (type === 'contactMessage') text = `👤 ${body.displayName || 'Contact'}`
  else if (type === 'contactsArrayMessage') text = `👥 ${body.displayName || 'Contacts'}`
  else if (type.startsWith('pollCreationMessage')) text = `📊 ${body.name}\n` + (body.options || []).map(o => `• ${o.optionName}`).join('\n')
  else if (type === 'buttonsResponseMessage') text = body.selectedDisplayText
  else if (type === 'listResponseMessage') text = body.title
  else if (type === 'templateButtonReplyMessage') text = body.selectedDisplayText
  else if (type === 'templateMessage') text = templateText(body)
  else if (type === 'interactiveMessage') text = interactiveText(body)
  else if (type === 'richResponseMessage') text = '🤖 Meta AI response (open on your phone)'

  const fromMe = !!key.fromMe
  const sender = fromMe ? 'me' : canonical(key.participant || remote)
  return {
    kind: 'message',
    row: {
      chat_id: chatId,
      id: key.id,
      from_me: fromMe ? 1 : 0,
      sender,
      push_name: m.pushName || null,
      ts: toNum(m.messageTimestamp) || Math.floor(Date.now() / 1000),
      type: mediaType || (text != null ? 'text' : type),
      text,
      quoted_text: quotedText(body?.contextInfo),
      media_mime: mediaType ? body.mimetype || null : null,
      media_name: type === 'documentMessage' ? body.fileName || body.title || null : null,
      media_state: mediaType ? 'pending' : null,
      media_size: mediaType ? toNum(body.fileLength) : 0,
      status: m.status ?? null,
      key_json: JSON.stringify(key),
      raw_json: JSON.stringify(m, BufferJSON.replacer)
    }
  }
}

export function saveMessageRow(r) {
  db.prepare(`INSERT INTO messages (chat_id, id, from_me, sender, push_name, ts, type, text, quoted_text,
      media_mime, media_name, media_state, status, key_json, raw_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(chat_id, id) DO UPDATE SET
      text = COALESCE(excluded.text, messages.text),
      push_name = COALESCE(excluded.push_name, messages.push_name),
      status = MAX(COALESCE(messages.status, 0), COALESCE(excluded.status, 0)),
      raw_json = excluded.raw_json`)
    .run(r.chat_id, r.id, r.from_me, r.sender, r.push_name, r.ts, r.type, r.text, r.quoted_text,
      r.media_mime, r.media_name, r.media_state, r.status, r.key_json, r.raw_json)
  if (!r.from_me && r.push_name && r.sender && !r.sender.endsWith('@g.us')) {
    db.prepare(`INSERT INTO contacts (id, notify) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET notify = excluded.notify`)
      .run(r.sender, r.push_name)
  }
}

export function getMessage(chatId, id) {
  return db.prepare('SELECT * FROM messages WHERE chat_id = ? AND id = ?').get(chatId, id)
}

export function findMessageById(id) {
  return db.prepare('SELECT * FROM messages WHERE id = ? LIMIT 1').get(id)
}

export function rawMessage(row) {
  return row?.raw_json ? JSON.parse(row.raw_json, BufferJSON.reviver) : null
}

const KNOWN_TYPES = new Set(['text', 'revoked', ...Object.values(MEDIA_TYPES)])

/** Re-parse stored messages whose type the parser didn't understand when they were saved. */
export function reparseUnknown() {
  const rows = db.prepare('SELECT chat_id, id, type, raw_json FROM messages WHERE raw_json IS NOT NULL').all()
    .filter(r => !KNOWN_TYPES.has(r.type))
  tx(() => {
    for (const r of rows) {
      const parsed = parseMessage(JSON.parse(r.raw_json, BufferJSON.reviver))
      if (!parsed || parsed.kind !== 'message') {
        db.prepare('DELETE FROM messages WHERE chat_id = ? AND id = ?').run(r.chat_id, r.id)
      } else if (parsed.row.type !== r.type || parsed.row.text) {
        db.prepare('UPDATE messages SET type = ?, text = ? WHERE chat_id = ? AND id = ?')
          .run(parsed.row.type, parsed.row.text, r.chat_id, r.id)
      }
    }
  })
  return rows.length
}

export function recentFailedMedia(days = 365) {
  return db.prepare(`SELECT chat_id, id FROM messages WHERE media_state = 'failed' AND ts > ? ORDER BY ts DESC`)
    .all(Math.floor(Date.now() / 1000) - days * 86400)
}

export function saveRawMessage(chatId, id, m) {
  db.prepare('UPDATE messages SET raw_json = ? WHERE chat_id = ? AND id = ?')
    .run(JSON.stringify(m, BufferJSON.replacer), chatId, id)
}

export function setMediaState(chatId, id, state, filePath = null) {
  db.prepare('UPDATE messages SET media_state = ?, media_path = COALESCE(?, media_path) WHERE chat_id = ? AND id = ?')
    .run(state, filePath, chatId, id)
}

export function updateStatus(chatId, id, status) {
  status = Number(status)
  if (!chatId || !id || !Number.isFinite(status)) return
  db.prepare('UPDATE messages SET status = MAX(COALESCE(status, 0), ?) WHERE chat_id = ? AND id = ?').run(status, chatId, id)
}

export function applyEdit(chatId, id, text) {
  db.prepare('UPDATE messages SET text = ? WHERE chat_id = ? AND id = ?').run(text, chatId, id)
  db.prepare('DELETE FROM translations WHERE chat_id = ? AND msg_id = ?').run(chatId, id)
}

export function applyRevoke(chatId, id) {
  db.prepare(`UPDATE messages SET type = 'revoked', text = NULL WHERE chat_id = ? AND id = ?`).run(chatId, id)
  db.prepare('DELETE FROM translations WHERE chat_id = ? AND msg_id = ?').run(chatId, id)
}

export function saveReaction({ chatId, msgId, sender, emoji }) {
  if (!msgId) return
  if (!emoji) db.prepare('DELETE FROM reactions WHERE chat_id = ? AND msg_id = ? AND sender = ?').run(chatId, msgId, sender)
  else db.prepare(`INSERT INTO reactions (chat_id, msg_id, sender, emoji) VALUES (?, ?, ?, ?)
    ON CONFLICT(chat_id, msg_id, sender) DO UPDATE SET emoji = excluded.emoji`).run(chatId, msgId, sender, emoji)
}

export function listMessages(chatId, { before, limit = 60, lang }) {
  const rows = db.prepare(`SELECT chat_id, id, from_me, sender, push_name, ts, type, text, quoted_text, media_path,
      media_mime, media_name, media_state, status
    FROM messages WHERE chat_id = ? AND ts <= ? ORDER BY ts DESC, rowid DESC LIMIT ?`)
    .all(chatId, before || Number.MAX_SAFE_INTEGER, limit).reverse()
  return rows.map(r => decorate(r, lang))
}

export function decorate(r, lang) {
  const reactions = db.prepare('SELECT emoji, COUNT(*) AS n FROM reactions WHERE chat_id = ? AND msg_id = ? GROUP BY emoji')
    .all(r.chat_id, r.id)
  const tr = lang
    ? db.prepare('SELECT text FROM translations WHERE chat_id = ? AND msg_id = ? AND lang = ?').get(r.chat_id, r.id, lang)
    : null
  return {
    ...r,
    sender_name: r.from_me ? 'You' : (contactName(r.sender) || r.push_name || r.sender?.split('@')[0]),
    reactions,
    translation: tr?.text ?? null
  }
}

// ---------- translations / settings ----------

export function saveTranslation(chatId, msgId, lang, text, model) {
  db.prepare(`INSERT INTO translations (chat_id, msg_id, lang, text, model) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(chat_id, msg_id, lang) DO UPDATE SET text = excluded.text, model = excluded.model`)
    .run(chatId, msgId, lang, text, model)
}

export function getChatSettings(chatId) {
  const row = db.prepare('SELECT * FROM chat_settings WHERE chat_id = ?').get(chatId)
  return row ? { enabled: !!row.enabled, model: row.model, originLang: row.origin_lang, destLang: row.dest_lang } : null
}

export function setChatSettings(chatId, s) {
  db.prepare(`INSERT INTO chat_settings (chat_id, enabled, model, origin_lang, dest_lang) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(chat_id) DO UPDATE SET enabled = excluded.enabled, model = excluded.model,
      origin_lang = excluded.origin_lang, dest_lang = excluded.dest_lang`)
    .run(chatId, s.enabled ? 1 : 0, s.model || null, s.originLang || null, s.destLang || null)
}

/** The text messages just before `ts` in a chat, oldest first, as translation context. */
export function contextBefore(chatId, ts, excludeId = '', limit = 3) {
  return db.prepare(`SELECT from_me, sender, push_name, text FROM messages
    WHERE chat_id = ? AND ts <= ? AND id <> ? AND text IS NOT NULL AND TRIM(text) <> ''
    ORDER BY ts DESC, rowid DESC LIMIT ?`)
    .all(chatId, ts, excludeId, limit)
    .reverse()
    .map(r => ({
      from: r.from_me ? 'me' : (isJidGroup(chatId) ? (contactName(r.sender) || r.push_name || 'them') : 'them'),
      text: r.text.length > 500 ? r.text.slice(0, 500) + '…' : r.text
    }))
}

/** Incoming text messages that still need translating into `lang`. */
export function untranslated(chatId, lang, limit = 60) {
  return db.prepare(`SELECT m.chat_id, m.id, m.text, m.ts FROM messages m
    LEFT JOIN translations t ON t.chat_id = m.chat_id AND t.msg_id = m.id AND t.lang = ?
    WHERE m.chat_id = ? AND m.from_me = 0 AND m.text IS NOT NULL AND TRIM(m.text) <> '' AND t.msg_id IS NULL
    ORDER BY m.ts DESC LIMIT ?`).all(lang, chatId, limit)
}
