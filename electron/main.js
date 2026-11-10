// macOS desktop shell: runs the local server in-process and shows it in a window.
import { app, BrowserWindow, dialog, shell } from 'electron'
import { execFile, execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const APP_NAME = 'WhatsApp Translate'
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

app.setName(APP_NAME)

// Log unexpected errors instead of showing Electron's "Uncaught Exception" crash dialog.
process.on('uncaughtException', err => console.error('[main] uncaught exception:', err))
process.on('unhandledRejection', err => console.error('[main] unhandled rejection:', err))
if (!app.requestSingleInstanceLock()) app.exit(0)

// Apps opened from Finder get a bare PATH (/usr/bin:/bin:...), so `codex` (and the
// `node` an npm-installed codex needs) wouldn't be found. Borrow the login shell's PATH.
function fixPath() {
  let shellPath = ''
  try {
    const out = execFileSync(process.env.SHELL || '/bin/zsh', ['-ilc', 'printf "__P__%s__P__" "$PATH"'],
      { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] })
    shellPath = out.match(/__P__(.*)__P__/)?.[1] || ''
  } catch {}
  const parts = [
    ...shellPath.split(':'),
    path.join(os.homedir(), '.local/bin'), // Codex standalone installer
    '/opt/homebrew/bin', '/usr/local/bin',
    ...(process.env.PATH || '').split(':')
  ].filter(Boolean)
  process.env.PATH = [...new Set(parts)].join(':')
}

// In the packaged app, keep a log file for troubleshooting.
function setupLogging() {
  const dir = app.getPath('logs')
  fs.mkdirSync(dir, { recursive: true })
  const stream = fs.createWriteStream(path.join(dir, 'main.log'), { flags: 'a' })
  for (const level of ['log', 'warn', 'error']) {
    const orig = console[level].bind(console)
    console[level] = (...args) => {
      stream.write(`[${new Date().toISOString()}] ${level}: ${args.map(a => (a instanceof Error ? a.stack : typeof a === 'string' ? a : JSON.stringify(a))).join(' ')}\n`)
      orig(...args)
    }
  }
}

function codexStatus() {
  return new Promise(resolve => {
    execFile('codex', ['login', 'status'], { timeout: 15000 }, (err, stdout, stderr) => {
      if (err?.code === 'ENOENT') return resolve('missing')
      resolve(err ? 'logged-out' : 'ok')
    })
  })
}

async function warnIfCodexNotReady(win) {
  const status = await codexStatus()
  if (status === 'ok') return
  const detail = status === 'missing'
    ? 'The Codex CLI is not installed, so messages can\'t be translated. WhatsApp itself works normally.'
    : 'The Codex CLI is not signed in, so messages can\'t be translated. WhatsApp itself works normally.'
  const { response } = await dialog.showMessageBox(win, {
    type: 'warning',
    message: 'Translation is not set up yet',
    detail: detail + '\n\nRun "Setup Codex" (it came in the same folder as this app), then restart WhatsApp Translate.',
    buttons: ['OK', 'How to install Codex']
  })
  if (response === 1) shell.openExternal('https://github.com/openai/codex#quickstart')
}

let mainWindow = null
let serverUrl = null

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 720,
    minHeight: 500,
    title: APP_NAME,
    backgroundColor: '#f0f2f5',
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true }
  })
  // links in messages open in the default browser, not inside the app
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })
  mainWindow.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(serverUrl)) {
      e.preventDefault()
      if (/^https?:/.test(url)) shell.openExternal(url)
    }
  })
  mainWindow.on('closed', () => { mainWindow = null })
  mainWindow.loadURL(serverUrl)
  return mainWindow
}

app.on('second-instance', () => {
  if (!mainWindow) return createWindow()
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.focus()
})

// Like most Mac apps, closing the window keeps the app (and WhatsApp sync) running.
app.on('window-all-closed', () => {})
app.on('activate', () => { if (!mainWindow && serverUrl) createWindow() })

app.whenReady().then(async () => {
  if (app.isPackaged) setupLogging()
  fixPath()
  if (!app.isPackaged) app.dock?.setIcon(path.join(ROOT, 'build/icon.png'))

  // the server reads these when imported
  process.env.WA_DATA_DIR = path.join(app.getPath('userData'), 'data')
  process.env.PORT = '0'
  try {
    const { ready } = await import('../server/index.js')
    serverUrl = `http://127.0.0.1:${await ready}`
  } catch (err) {
    console.error(err)
    dialog.showErrorBox('WhatsApp Translate could not start', String(err?.stack || err))
    app.exit(1)
    return
  }
  const win = createWindow()
  win.webContents.once('did-finish-load', () => warnIfCodexNotReady(win))
})
