import { DatabaseSync } from 'node:sqlite'
import fs from 'node:fs'
import path from 'node:path'
import { DATA_DIR } from './paths.js'

fs.mkdirSync(DATA_DIR, { recursive: true })
export const db = new DatabaseSync(path.join(DATA_DIR, 'whatsapp.db'))

db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;

CREATE TABLE IF NOT EXISTS chats (
  id TEXT PRIMARY KEY,
  name TEXT,
  is_group INTEGER DEFAULT 0,
  last_ts INTEGER DEFAULT 0,
  unread INTEGER DEFAULT 0,
  archived INTEGER DEFAULT 0,
  pinned INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS contacts (
  id TEXT PRIMARY KEY,
  name TEXT,
  notify TEXT,
  verified_name TEXT
);

CREATE TABLE IF NOT EXISTS lid_map (
  lid TEXT PRIMARY KEY,
  pn TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  chat_id TEXT NOT NULL,
  id TEXT NOT NULL,
  from_me INTEGER NOT NULL,
  sender TEXT,
  push_name TEXT,
  ts INTEGER NOT NULL,
  type TEXT,
  text TEXT,
  quoted_text TEXT,
  media_path TEXT,
  media_mime TEXT,
  media_name TEXT,
  media_state TEXT,
  status INTEGER,
  key_json TEXT,
  raw_json TEXT,
  PRIMARY KEY (chat_id, id)
);
CREATE INDEX IF NOT EXISTS idx_messages_chat_ts ON messages (chat_id, ts);

CREATE TABLE IF NOT EXISTS reactions (
  chat_id TEXT NOT NULL,
  msg_id TEXT NOT NULL,
  sender TEXT NOT NULL,
  emoji TEXT,
  PRIMARY KEY (chat_id, msg_id, sender)
);

CREATE TABLE IF NOT EXISTS translations (
  chat_id TEXT NOT NULL,
  msg_id TEXT NOT NULL,
  lang TEXT NOT NULL,
  text TEXT NOT NULL,
  model TEXT,
  PRIMARY KEY (chat_id, msg_id, lang)
);

CREATE TABLE IF NOT EXISTS chat_settings (
  chat_id TEXT PRIMARY KEY,
  enabled INTEGER DEFAULT 0,
  model TEXT,
  origin_lang TEXT,
  dest_lang TEXT
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);
`)

let txDepth = 0
/** Run fn in a transaction; nested calls join the outer one. */
export function tx(fn) {
  if (txDepth > 0) return fn()
  db.exec('BEGIN')
  txDepth++
  try {
    const r = fn()
    db.exec('COMMIT')
    return r
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  } finally {
    txDepth--
  }
}

export function getSetting(key, fallback = null) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key)
  return row ? JSON.parse(row.value) : fallback
}

export function setSetting(key, value) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, JSON.stringify(value))
}
