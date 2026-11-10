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

## Mac app for colleagues

```bash
npm run dist
```

This builds `dist/WhatsApp Translate/`, ready to zip and share. It contains:

- `WhatsApp Translate.app`: the desktop app (Electron), Apple Silicon by default. Use `npm run dist -- --arch=x64` for Intel Macs or `--arch=universal` for both.
- `Setup Codex.command`: installs the Codex CLI if it's missing (OpenAI's official installer, no admin rights needed), opens the browser to sign in, then closes itself. It also clears the "downloaded from the internet" flag on the app.
- `READ ME FIRST.txt`: setup steps for colleagues.

The app is ad-hoc signed, not notarized (that needs an Apple Developer ID), so on first launch macOS blocks the setup script until the user clicks "Open Anyway" in System Settings → Privacy & Security (right-click → Open no longer works on macOS 15+). The script then unblocks the app. The app keeps its data in `~/Library/Application Support/WhatsApp Translate/` and its log in `~/Library/Logs/WhatsApp Translate/`. Run `npm run app` to start the desktop app from source, and `npm run icon` to regenerate the icon from `build/icon.svg`.

## Features

- WhatsApp login by QR code. The session persists, and the client reconnects on its own.
- Chat list with search, unread counts, groups and contacts. Full history is synced from your phone.
- Messages: text, photos, videos, voice notes and documents, stickers, replies, reactions, edits and deletions, and delivery and read ticks.
- Sending text and files, including replies.
- Everything is stored locally: `data/whatsapp.db` (SQLite) and `data/media/` (images and files).

### Translation (per chat)

Translation turns on automatically the first time you open a chat, using **GPT-6-Luna**, **Italian** (mine) and **French** (theirs). You can change any of these per chat, or switch **🌐 Translate** off, in the chat's header:

- **Model**: any model your Codex install lists (`codex debug models`).
- **Mine**: your language. Incoming messages get a translation into it, shown below each message.
- **Theirs**: the contact's language. What you type is translated into it.

When you press Enter, the translation of your draft shows up as a preview under your original text. You can edit it, then click **Send translation**, or **Send original**. The contact receives the translated text. Your original stays saved locally and appears under the sent message.

Each message is sent to the model together with the 3 messages before it, so it can resolve references, pronouns and tone. Only the message itself is translated. Translations are batched and cached in the database, so a chat with many messages costs a single Codex run, and nothing gets translated twice.

## Notes

- The server listens on `127.0.0.1` only, because it has full access to your WhatsApp account.
- Codex runs with `--ignore-user-config` (so your MCP servers aren't loaded), a read-only sandbox and an empty working directory. The prompt treats messages as untrusted text.
- This client uses [Baileys](https://github.com/WhiskeySockets/Baileys), an unofficial WhatsApp Web protocol library. WhatsApp doesn't officially support third-party clients, so use it at your own risk.
- Environment variables: `PORT` (default 3210), `WA_DATA_DIR` (default `./data`), `TRANSLATE_MODEL` (default `gpt-6-luna`), `MY_LANGUAGE` (default Italian), `THEIR_LANGUAGE` (default French), `CODEX_BIN`, `WA_LOG_LEVEL`.
