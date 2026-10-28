// Renders build/icon.svg (macOS layout) and build/icon-square.svg (Windows / Linux layout) into the files
// electron-builder and the app use: build/icon.icns, build/icon.ico, build/icon.png (1024) and resources/icon.png (512,
// the runtime window icon), plus resources/icon.icns (the icon of the Claudock.app npx makes, bin/macApp.js) and the
// menu bar icons in resources/: trayTemplate and trayWaiting (macOS, 18x16 pt), tray and trayDot (Windows / Linux,
// 16 px), each with an @2x file. Run with `npm run icons` (it needs Electron for SVG rendering, plus macOS `iconutil` for .icns).
import { BrowserWindow, app } from 'electron'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const build = path.join(root, 'build')

app.disableHardwareAcceleration()
app.dock?.hide()

let win

/** Draws the SVG onto a canvas at `size` px (or `size` x `height`) in a hidden window and returns PNG bytes (transparent background). */
async function render(svgFile, size, height = size) {
  if (!win) {
    win = new BrowserWindow({ show: false, webPreferences: { offscreen: true } })
    await win.loadURL('data:text/html,<html><body></body></html>')
  }
  const svg = Buffer.from(fs.readFileSync(svgFile, 'utf8')).toString('base64')
  const dataUrl = await win.webContents.executeJavaScript(`(async () => {
    const img = new Image(${size}, ${height})
    img.src = 'data:image/svg+xml;base64,${svg}'
    await img.decode()
    const c = document.createElement('canvas')
    c.width = ${size}
    c.height = ${height}
    const g = c.getContext('2d')
    g.imageSmoothingQuality = 'high'
    g.drawImage(img, 0, 0, ${size}, ${height})
    return c.toDataURL('image/png')
  })()`)
  return Buffer.from(dataUrl.split(',')[1], 'base64')
}

/** ICO with PNG-compressed entries (Windows Vista and later). */
function ico(pngs) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(pngs.length, 4)
  const dir = Buffer.alloc(16 * pngs.length)
  let offset = 6 + dir.length
  pngs.forEach(({ size, data }, i) => {
    const e = i * 16
    dir.writeUInt8(size >= 256 ? 0 : size, e)
    dir.writeUInt8(size >= 256 ? 0 : size, e + 1)
    dir.writeUInt16LE(1, e + 4) // colour planes
    dir.writeUInt16LE(32, e + 6) // bits per pixel
    dir.writeUInt32LE(data.length, e + 8)
    dir.writeUInt32LE(offset, e + 12)
    offset += data.length
  })
  return Buffer.concat([header, dir, ...pngs.map((p) => p.data)])
}

app.whenReady().then(async () => {
  try {
    const mac = path.join(build, 'icon.svg')
    const square = path.join(build, 'icon-square.svg')

    // macOS .icns via an .iconset
    const set = fs.mkdtempSync(path.join(os.tmpdir(), 'claudock-icon-')) + '/icon.iconset'
    fs.mkdirSync(set)
    for (const pt of [16, 32, 128, 256, 512]) {
      fs.writeFileSync(path.join(set, `icon_${pt}x${pt}.png`), await render(mac, pt))
      fs.writeFileSync(path.join(set, `icon_${pt}x${pt}@2x.png`), await render(mac, pt * 2))
    }
    execFileSync('iconutil', ['-c', 'icns', set, '-o', path.join(build, 'icon.icns')])
    fs.rmSync(path.dirname(set), { recursive: true, force: true })

    // Windows .ico
    const sizes = [16, 20, 24, 32, 40, 48, 64, 128, 256]
    const pngs = []
    for (const size of sizes) pngs.push({ size, data: await render(square, size) })
    fs.writeFileSync(path.join(build, 'icon.ico'), ico(pngs))

    // Linux / generic PNGs
    fs.writeFileSync(path.join(build, 'icon.png'), await render(square, 1024))
    fs.mkdirSync(path.join(root, 'resources'), { recursive: true })
    fs.writeFileSync(path.join(root, 'resources', 'icon.png'), await render(square, 512))
    fs.copyFileSync(path.join(build, 'icon.icns'), path.join(root, 'resources', 'icon.icns'))

    // menu bar / tray
    const res = (name) => path.join(root, 'resources', name)
    for (const [svg, name, w, h] of [
      ['trayTemplate.svg', 'trayTemplate', 18, 16],
      ['trayWaiting.svg', 'trayWaiting', 18, 16],
      ['icon-square.svg', 'tray', 16, 16],
      ['trayDot.svg', 'trayDot', 16, 16]
    ]) {
      fs.writeFileSync(res(`${name}.png`), await render(path.join(build, svg), w, h))
      fs.writeFileSync(res(`${name}@2x.png`), await render(path.join(build, svg), w * 2, h * 2))
    }
    console.log('icons: build/icon.icns, build/icon.ico, build/icon.png, resources/icon.png, resources/icon.icns, resources/tray*.png')
    app.exit(0)
  } catch (e) {
    console.error(e)
    app.exit(1)
  }
})
