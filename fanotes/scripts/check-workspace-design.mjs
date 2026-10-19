// Workspace Design must change pixels the user can see. A fill on .app-shell
// alone is covered by the ribbon, the sidebar, and the note sheet.
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { inflateSync } from 'node:zlib'
import assert from 'node:assert/strict'

const root = join(import.meta.dirname, '..')
const css = readFileSync(join(root, 'src/styles.css'), 'utf8')

const noteViewBlock = css.slice(css.indexOf('.unified-note-view {'), css.indexOf('.unified-note-view.is-pdf-note {'))
assert.match(noteViewBlock, /background:\s*#fff/, 'the note scroller stays white in its own rule')
const planeBlock = css.slice(css.indexOf('.paper-sheet-plane {'), css.indexOf('.paper-view-hud {'))
assert.match(planeBlock, /background:\s*#fff/)
assert.match(planeBlock, /Padding is extra paper you can pan into, not a second surface\./)
assert.doesNotMatch(planeBlock, /background-clip:\s*content-box/)
assert.match(css, /\.unified-note-view\.is-pdf-note \.paper-sheet-plane \{\s*background: #edeff3;/u)

const design = css.slice(css.indexOf('.app-shell.background-clean'), css.indexOf('.app-shell.no-motion'))
const cleanRule = design.slice(0, design.indexOf('.app-shell.background-gradient'))
assert.doesNotMatch(cleanRule, /paper-sheet-plane/)
for (const id of ['gradient', 'mesh', 'paper']) {
  assert.match(design, new RegExp(`\\.app-shell\\.background-${id} .unified-note-view:not\\(\\.is-pdf-note\\) \\.paper-sheet-plane`))
  assert.match(design, new RegExp(`\\.app-shell\\.background-${id} :is\\(\\.sidebar`))
  assert.match(design, new RegExp(`\\.app-shell\\.dashboard-shell\\.background-${id}`))
}
assert.match(design, /rgba\(var\(--accent-rgb\), \.32\)/)
assert.match(design, /rgba\(var\(--accent-rgb\), \.48\)/)
assert.match(design, /rgba\(var\(--accent-rgb\), \.66\)/)
assert.match(design, /background-color:\s*#f3eadc/)
assert.doesNotMatch(design, /rgba\(var\(--accent-rgb\), \.0[0-9]\)/, 'a design below 10% accent reads as no change')
assert.match(css, /html\.is-printing \.app-shell\.background-paper \.unified-note-view:not\(\.is-pdf-note\) \.paper-sheet-plane/)

function decodePng(file) {
  const buf = readFileSync(file)
  assert.equal(buf.subarray(0, 8).toString('hex'), '89504e470d0a1a0a')
  let offset = 8
  let width = 0
  let height = 0
  let bitDepth = 0
  let colorType = 0
  const idat = []
  while (offset + 8 <= buf.length) {
    const length = buf.readUInt32BE(offset)
    const type = buf.toString('ascii', offset + 4, offset + 8)
    const data = buf.subarray(offset + 8, offset + 8 + length)
    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      bitDepth = data[8]
      colorType = data[9]
    } else if (type === 'IDAT') {
      idat.push(data)
    } else if (type === 'IEND') break
    offset += 12 + length
  }
  assert.equal(bitDepth, 8)
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : 0
  assert.ok(channels, `unsupported png color type ${colorType}`)
  const inflated = inflateSync(Buffer.concat(idat))
  const stride = width * channels
  const out = Buffer.alloc(width * height * 4)
  let src = 0
  let prev = Buffer.alloc(stride)
  for (let y = 0; y < height; y += 1) {
    const filter = inflated[src]
    src += 1
    const row = Buffer.from(inflated.subarray(src, src + stride))
    src += stride
    for (let i = 0; i < stride; i += 1) {
      const left = i >= channels ? row[i - channels] : 0
      const up = prev[i]
      const ul = i >= channels ? prev[i - channels] : 0
      let value = row[i]
      if (filter === 1) value += left
      else if (filter === 2) value += up
      else if (filter === 3) value += Math.floor((left + up) / 2)
      else if (filter === 4) {
        const pa = Math.abs(left + up - ul - left)
        const pb = Math.abs(left + up - ul - up)
        const pc = Math.abs(left + up - ul - ul)
        value += pa <= pb && pa <= pc ? left : pb <= pc ? up : ul
      }
      row[i] = value & 255
    }
    for (let x = 0; x < width; x += 1) {
      const si = x * channels
      const di = (y * width + x) * 4
      out[di] = channels === 1 ? row[si] : row[si]
      out[di + 1] = channels === 1 ? row[si] : row[si + 1]
      out[di + 2] = channels === 1 ? row[si] : row[si + 2]
      out[di + 3] = channels === 4 ? row[si + 3] : 255
    }
    prev = row
  }
  return {
    width,
    height,
    average(x, y, size) {
      let r = 0
      let g = 0
      let b = 0
      let n = 0
      for (let yy = y; yy < y + size; yy += 1) {
        for (let xx = x; xx < x + size; xx += 1) {
          const i = (yy * width + xx) * 4
          r += out[i]
          g += out[i + 1]
          b += out[i + 2]
          n += 1
        }
      }
      return [r / n, g / n, b / n]
    },
  }
}

function distance(a, b) {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])
}

const directory = mkdtempSync(join(tmpdir(), 'fanotes-workspace-design-'))
const htmlPath = join(directory, 'index.html')
const pngPath = join(directory, 'shot.png')
const shell = (id, extra = '') => `<div class="app-shell theme-light background-${id}"><nav class="ribbon"></nav><div class="app-body"><aside class="sidebar"></aside><main class="workspace"><div class="tabs-bar"></div><div class="editor-stage"><div class="editor-stage-main"><div class="editor-split"><div class="unified-note-view ${extra}"><div class="paper-sheet-plane"></div></div></div></div></div></main></div></div>`
writeFileSync(htmlPath, `<!doctype html>
<html><head><link rel="stylesheet" href="${join(root, 'src/styles.css')}">
<style>
  html, body { min-width: 0 !important; min-height: 0 !important; width: 1920px !important; height: 640px !important; margin: 0 !important; overflow: hidden !important; background: #000 !important; }
  .shot { display: flex; flex-wrap: wrap; width: 1920px; }
  .shot .app-shell { width: 480px !important; height: 320px !important; }
  .shot .app-body { grid-template-columns: 150px minmax(0, 1fr) 0 !important; }
  .shot .unified-note-view, .shot .paper-sheet-plane, .shot .editor-stage, .shot .editor-stage-main, .shot .editor-split { height: 100%; min-height: 0; }
  .shot .paper-sheet-plane { padding: 0 !important; width: 100% !important; min-height: 100% !important; }
</style></head>
<body><div class="shot">${shell('clean')}${shell('gradient')}${shell('mesh')}${shell('paper')}${shell('gradient', 'is-pdf-note')}</div></body></html>`)

const chromium = spawn('chromium', [
  '--headless=new',
  '--no-sandbox',
  '--disable-gpu',
  '--disable-dev-shm-usage',
  '--hide-scrollbars',
  '--force-device-scale-factor=1',
  '--window-size=1920,640',
  '--virtual-time-budget=8000',
  `--screenshot=${pngPath}`,
  htmlPath,
], { stdio: ['ignore', 'ignore', 'pipe'] })
let stderr = ''
chromium.stderr.on('data', (chunk) => { stderr += chunk })
const exitCode = await new Promise((resolve) => chromium.on('close', resolve))
assert.equal(exitCode, 0, stderr.slice(-1500))

const png = decodePng(pngPath)
assert.equal(png.width, 1920, `screenshot width ${png.width}`)
assert.ok(png.height >= 640, `screenshot height ${png.height}`)

const names = ['clean', 'gradient', 'mesh', 'paper']
const samples = Object.fromEntries(names.map((name, index) => [name, {
  sidebar: png.average(index * 480 + 28, 150, 24),
  sheet: png.average(index * 480 + 280, 150, 28),
}]))
const pdfSheet = png.average(280, 320 + 150, 28)
const white = [255, 255, 255]
const pdfStage = [237, 239, 243]

for (let i = 0; i < names.length; i += 1) {
  for (let j = i + 1; j < names.length; j += 1) {
    const left = samples[names[i]]
    const right = samples[names[j]]
    const gap = Math.max(distance(left.sheet, right.sheet), distance(left.sidebar, right.sidebar))
    assert.ok(gap > 28, `${names[i]} and ${names[j]} look the same (${gap.toFixed(1)}): ${JSON.stringify({ left, right })}`)
  }
}
assert.ok(distance(samples.clean.sheet, white) < 8, `Klar sheet is not white: ${samples.clean.sheet}`)
assert.ok(distance(samples.gradient.sheet, white) > 24, `Verlauf sheet is still white: ${samples.gradient.sheet}`)
assert.ok(distance(samples.mesh.sheet, white) > 24, `Aurora sheet is still white: ${samples.mesh.sheet}`)
assert.ok(distance(samples.paper.sheet, white) > 20, `Papier sheet is still white: ${samples.paper.sheet}`)
assert.ok(distance(samples.gradient.sheet, samples.mesh.sheet) > 28, 'Verlauf and Aurora tint the sheet the same way')
assert.ok(distance(pdfSheet, pdfStage) < 12, `a PDF page room picked up the design: ${pdfSheet}`)
assert.ok(distance(pdfSheet, samples.gradient.sheet) > 28, 'the PDF room matches the Verlauf sheet')

rmSync(directory, { recursive: true, force: true })
console.log(`workspace-design ok ${JSON.stringify({
  clean: samples.clean.sheet.map((n) => Math.round(n)),
  gradient: samples.gradient.sheet.map((n) => Math.round(n)),
  mesh: samples.mesh.sheet.map((n) => Math.round(n)),
  paper: samples.paper.sheet.map((n) => Math.round(n)),
  pdf: pdfSheet.map((n) => Math.round(n)),
})}`)
