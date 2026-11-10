// Renders build/icon.svg into build/icon.png and the macOS build/icon.icns.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

const BUILD = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../build')
const svg = fs.readFileSync(path.join(BUILD, 'icon.svg'))
const iconset = fs.mkdtempSync(path.join(os.tmpdir(), 'icon-')) + '/icon.iconset'
fs.mkdirSync(iconset)

const render = (size, file) => sharp(svg, { density: Math.ceil(72 * size / 1024 * 4) }).resize(size, size).png().toFile(file)

await render(1024, path.join(BUILD, 'icon.png'))
for (const size of [16, 32, 128, 256, 512]) {
  await render(size, path.join(iconset, `icon_${size}x${size}.png`))
  await render(size * 2, path.join(iconset, `icon_${size}x${size}@2x.png`))
}
execFileSync('iconutil', ['-c', 'icns', iconset, '-o', path.join(BUILD, 'icon.icns')])
fs.rmSync(path.dirname(iconset), { recursive: true, force: true })
console.log('wrote build/icon.png and build/icon.icns')
