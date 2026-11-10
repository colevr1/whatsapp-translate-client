// Builds "dist/WhatsApp Translate/" — the app plus the Codex setup script — ready to zip.
//   npm run dist                  Apple Silicon (default)
//   npm run dist -- --arch=x64    Intel Macs
//   npm run dist -- --arch=universal
import { packager } from '@electron/packager'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
const NAME = pkg.productName
const arch = process.argv.find(a => a.startsWith('--arch='))?.split('=')[1] || 'arm64'
const OUT = path.join(ROOT, 'dist')
const SHIP = path.join(OUT, arch === 'arm64' ? NAME : `${NAME} (${arch})`)

execFileSync('node', [path.join(ROOT, 'scripts/make-icon.mjs')], { stdio: 'inherit' })

// Only ship what the app needs at runtime.
const keep = /^\/(package\.json|server|public|electron|build\/icon\.png|node_modules)(\/|$)/
// sharp's native binaries for the other CPU type aren't needed (except in universal builds)
const otherArch = { arm64: /^\/node_modules\/@img\/[^/]*-x64(\/|$)/, x64: /^\/node_modules\/@img\/[^/]*-arm64(\/|$)/ }[arch]
const [outDir] = await packager({
  dir: ROOT,
  out: path.join(OUT, '.build'),
  overwrite: true,
  platform: 'darwin',
  arch,
  name: NAME,
  executableName: NAME,
  appVersion: pkg.version,
  appBundleId: 'local.whatsapp-translate',
  appCategoryType: 'public.app-category.social-networking',
  icon: path.join(ROOT, 'build/icon.icns'),
  darwinDarkModeSupport: true,
  asar: { unpack: '**/node_modules/{sharp,@img}/**' }, // native image library must stay on disk
  ignore: p => p !== '' && p !== '/build' && (!keep.test(p) || !!otherArch?.test(p)),
  prune: true
})
const appPath = path.join(outDir, `${NAME}.app`)

// No Apple Developer ID here, so sign ad-hoc: Apple Silicon refuses to run unsigned code.
execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], { stdio: 'inherit' })

fs.rmSync(SHIP, { recursive: true, force: true })
fs.mkdirSync(SHIP, { recursive: true })
execFileSync('ditto', [appPath, path.join(SHIP, `${NAME}.app`)])
for (const f of ['Setup Codex.command', 'READ ME FIRST.txt']) {
  fs.copyFileSync(path.join(ROOT, 'ship', f), path.join(SHIP, f))
}
fs.chmodSync(path.join(SHIP, 'Setup Codex.command'), 0o755)
fs.rmSync(path.join(OUT, '.build'), { recursive: true, force: true })

console.log(`\nReady to zip: ${path.relative(ROOT, SHIP)}/`)
