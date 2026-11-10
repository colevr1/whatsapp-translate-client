# WhatsApp Translate

A local WhatsApp client that runs in your browser and translates chats automatically with the models in your Codex CLI.

## Requirements

- Node.js 22.5 or newer (it uses the built-in `node:sqlite`)
- [Codex CLI](https://github.com/openai/codex), logged in (`codex login`)

## Run

```bash
npm install
npm start
```

Open http://localhost:3210 and scan the QR code from WhatsApp → Settings → Linked devices.

## Features

- WhatsApp login by QR code. The session persists, and the client reconnects on its own.
- Chat list with search, unread counts, groups and contacts. Full history is synced from your phone.
- Messages: text, photos, videos, voice notes and documents, stickers, replies, reactions, edits and deletions, and delivery and read ticks.
- Sending text and files, including replies.
- Everything is stored locally: `data/whatsapp.db` (SQLite) and `data/media/` (images and files).

### Translation (per chat)

Turn on **🌐 Translate** in a chat's header, then pick:

- **Model**: any model your Codex install lists (`codex debug models`).
- **Mine**: your language. Incoming messages get a translation into it, shown below each message.
- **Theirs**: the contact's language. What you type is translated into it.

When you press Enter, the translation of your draft shows up as a preview under your original text. You can edit it, then click **Send translation**, or **Send original**. The contact receives the translated text. Your original stays saved locally and appears under the sent message.

Translations are batched and cached in the database, so a chat with many messages costs a single Codex run, and nothing gets translated twice.

## Notes

- The server listens on `127.0.0.1` only, because it has full access to your WhatsApp account.
- Codex runs with `--ignore-user-config` (so your MCP servers aren't loaded), a read-only sandbox and an empty working directory. The prompt treats messages as untrusted text.
- This client uses [Baileys](https://github.com/WhiskeySockets/Baileys), an unofficial WhatsApp Web protocol library. WhatsApp doesn't officially support third-party clients, so use it at your own risk.
- Environment variables: `PORT` (default 3210), `WA_DATA_DIR` (default `./data`), `CODEX_BIN`, `WA_LOG_LEVEL`.
