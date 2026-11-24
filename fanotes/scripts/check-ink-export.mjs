// Vector export of a handwriting note and of a PDF note, in the real desktop app.
//
// Handwriting note (strokes, a highlighter, a text box "x ≤ 1 α", a picture):
//   - the export dialog's PDF export gives a vector PDF: no page-sized raster image,
//     the text box text is extractable, the page count fits the sheet;
//   - rendering page 1 (pdf.js, as the DOCX export does) and the sheet on
//     screen at the same scale agree on where the ink is (loose overlap);
//   - the DOCX export holds one page picture per page and the text box as a paragraph.
// PDF note: the PDF with ink drawn on page 2 exports with the same page count,
// its text still selectable, and ink operators on the marked page only.
//
// Needs a built renderer (`vite build`), xvfb-run and playwright-core
// (PLAYWRIGHT_CORE); FANOTES_SKIP_BROWSER=1 skips it. Synthetic vault only.
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const { serializeFamd, emptyFamdPayload } = require('../electron/famd.cjs')
const JSZip = require('jszip')

const electron = path.join(root, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron')
const xvfb = spawnSync('sh', ['-c', 'command -v xvfb-run'], { encoding: 'utf8' }).stdout.trim()
let playwright = null
if (process.env.FANOTES_SKIP_BROWSER !== '1') {
  try { playwright = await import(process.env.PLAYWRIGHT_CORE || 'playwright-core') } catch { playwright = null }
}
const missing = process.env.FANOTES_SKIP_BROWSER === '1' ? 'FANOTES_SKIP_BROWSER=1'
  : !xvfb ? 'no xvfb-run'
    : !fs.existsSync(path.join(root, 'dist', 'index.html')) ? 'no dist/ (run vite build)'
      : !fs.existsSync(electron) ? 'no electron'
        : !playwright ? 'no playwright-core (set PLAYWRIGHT_CORE)' : ''
if (missing) {
  console.log(`ink export: skipped (${missing})`)
  process.exit(0)
}
const chromium = playwright.chromium ?? playwright.default.chromium
const pdfjs = await import(path.join(root, 'node_modules/pdfjs-dist/legacy/build/pdf.mjs'))

const temporary = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'fanotes-ink-export-'))
const home = path.join(temporary, 'home')
const configHome = path.join(temporary, 'config')
const runtime = path.join(temporary, 'runtime')
const vault = path.join(home, 'Notizen')
const userData = path.join(configHome, 'FaNotes')
for (const directory of [home, configHome, runtime, vault, userData]) fs.mkdirSync(directory, { recursive: true, mode: 0o700 })

const at = '2026-11-01T00:00:00.000Z'
const SHEET_W = 900
const SHEET_H = 2400
const strokeRows = 22
const ink = {
  schemaVersion: 1, title: 'Seite', paperStyle: 'lines', sourceWidth: SHEET_W, sourceHeight: SHEET_H, createdAt: at, updatedAt: at,
  strokes: [
    ...Array.from({ length: strokeRows * 3 }, (_, i) => {
      const line = Math.floor(i / 3)
      const word = i % 3
      const x0 = 0.08 + word * 0.29
      const y0 = 0.07 + line * (0.86 / strokeRows)
      return {
        color: word === 1 ? '#1f4fb3' : '#202333', baseWidth: 3.5, pressureEnabled: true, brush: 'fineliner',
        points: Array.from({ length: 45 }, (_unused, k) => ({
          x: x0 + (k / 45) * 0.26, y: y0 + Math.sin(k / 3 + i) * 0.004, t: k * 8, pressure: 0.4 + 0.3 * Math.sin(k / 5), tiltX: 0, tiltY: 0, pointerType: 'pen',
        })),
      }
    }),
    // The highlighter: a wide translucent bar across a line of writing.
    {
      color: '#ffd84d', baseWidth: 26, pressureEnabled: false, purpose: 'art', brush: 'highlighter', opacity: 1,
      points: [{ x: 0.08, y: 0.07 + 4 * (0.86 / strokeRows), t: 0, pressure: 0.5 }, { x: 0.8, y: 0.07 + 4 * (0.86 / strokeRows), t: 100, pressure: 0.5 }],
    },
  ],
}
// A 64x64 PNG for the picture in the typed text.
const png = (() => {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0 })
  const crc = (buffer) => { let c = 0xffffffff; for (const byte of buffer) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0 }
  const chunk = (type, data) => { const length = Buffer.alloc(4); length.writeUInt32BE(data.length); const body = Buffer.concat([Buffer.from(type), data]); const sum = Buffer.alloc(4); sum.writeUInt32BE(crc(body)); return Buffer.concat([length, body, sum]) }
  const header = Buffer.alloc(13); header.writeUInt32BE(64, 0); header.writeUInt32BE(64, 4); header[8] = 8; header[9] = 2
  const raw = Buffer.alloc(64 * (1 + 64 * 3)); for (let y = 0; y < 64; y += 1) for (let x = 0; x < 64; x += 1) raw.set([40 + x * 3, 120, 200 - y * 2], y * 193 + 1 + x * 3)
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
})()
fs.writeFileSync(path.join(vault, 'bild.png'), png)
fs.writeFileSync(path.join(vault, 'Export.famd'), serializeFamd('# Export\n\n<!-- fanotes-ink:export-ink -->\n\nGetippter Absatz.\n\n![Bild](bild.png)\n\nZweiter Absatz.\n', {
  ...emptyFamdPayload(at),
  ink,
  paperStyle: 'lines',
  textFields: [{ id: 'tf-math', page: 1, x: 0.5, y: 0.6, width: 0.4, fontSize: 18, text: 'x ≤ 1 α' }],
}))

// A two page PDF note.
const makePdf = () => {
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>']
  ;['Erste Seite', 'Zweite Seite'].forEach((label, index) => {
    const text = `BT /F1 24 Tf 60 700 Td (${label}) Tj ET`
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents ${4 + index * 2} 0 R /Resources << /Font << /F1 7 0 R >> >> >>`)
    objects.push(`<< /Length ${text.length} >>\nstream\n${text}\nendstream`)
  })
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')
  let out = '%PDF-1.4\n'
  const offsets = []
  objects.forEach((body, index) => { offsets.push(out.length); out += `${index + 1} 0 obj\n${body}\nendobj\n` })
  const xref = out.length
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}`
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(out, 'latin1')
}
fs.mkdirSync(path.join(vault, 'Fach'))
fs.writeFileSync(path.join(vault, 'Fach', 'Blatt.pdf'), makePdf())
fs.writeFileSync(path.join(userData, 'config.json'), `${JSON.stringify({
  version: 3,
  vaultPath: vault,
  settings: { uiLanguage: 'de', autoCheckUpdates: false, autoDownloadUpdates: false, diagnosticsEnabled: false, reduceMotion: true },
  onboarding: { version: 1, completed: true },
}, null, 2)}\n`, { mode: 0o600 })

const results = []
const ok = (name, pass, detail = '') => {
  results.push(Boolean(pass))
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail !== '' ? ` -> ${String(detail).slice(0, 300)}` : ''}`)
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const port = 19_300 + Math.floor(Math.random() * 600)
const child = spawn(xvfb, ['-a', '-s', '-screen 0 1440x1000x24', electron, root, `--remote-debugging-port=${port}`, '--no-sandbox'], {
  env: { ...process.env, HOME: home, XDG_CONFIG_HOME: configHome, XDG_RUNTIME_DIR: runtime },
  stdio: ['ignore', 'pipe', 'pipe'],
  detached: true,
})
let output = ''
child.stdout.on('data', (chunk) => { output += chunk })
child.stderr.on('data', (chunk) => { output += chunk })

const standardFonts = path.join(root, 'node_modules/pdfjs-dist/standard_fonts/')
const openPdf = (bytes) => pdfjs.getDocument({ data: new Uint8Array(bytes), useSystemFonts: false, standardFontDataUrl: standardFonts, verbosity: 0 }).promise
const pageText = async (pdf, number) => (await (await pdf.getPage(number)).getTextContent()).items.map((item) => item.str).join('').replace(/\s+/gu, ' ')
const pageOps = async (pdf, number) => {
  const list = await (await pdf.getPage(number)).getOperatorList()
  let strokes = 0
  const images = []
  list.fnArray.forEach((fn, index) => {
    const paint = fn === pdfjs.OPS.constructPath ? list.argsArray[index][0] : fn
    if (paint === pdfjs.OPS.stroke || paint === pdfjs.OPS.closeStroke || paint === pdfjs.OPS.fillStroke) strokes += 1
    if (fn === pdfjs.OPS.paintImageXObject || fn === pdfjs.OPS.paintInlineImageXObject) images.push(list.argsArray[index].slice(1, 3))
  })
  return { strokes, images }
}

let browser = null
let failure = null
try {
  const deadline = Date.now() + 60_000
  while (!browser && Date.now() < deadline) {
    try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`) } catch { await sleep(250) }
    if (child.exitCode !== null) throw new Error(`Electron exited: ${output.slice(-400)}`)
  }
  assert.ok(browser, 'Electron did not open a debugging port')
  let page = null
  for (let tries = 0; tries < 120 && !page; tries += 1) {
    page = browser.contexts().flatMap((context) => context.pages()).find((candidate) => !/^devtools|ocr-host|recognition\.html|fanotes-note-export/u.test(candidate.url())) ?? null
    if (!page) await sleep(250)
  }
  assert.ok(page, 'no renderer page')
  page.on('pageerror', (error) => console.log('pageerror', String(error).slice(0, 300)))
  page.on('console', (message) => { if (message.type() === 'error') console.log('console.error', message.text().slice(0, 300)) })
  await page.waitForFunction(() => Boolean(window.fanotes && document.querySelector('.file-tree__row')), null, { timeout: 60_000 })

  await page.emulateMedia({ colorScheme: 'light' })
  // Downloads the app starts (anchor with a blob) are kept in the page instead of written.
  await page.evaluate(() => {
    window.__exports = []
    const blobs = new Map()
    const create = URL.createObjectURL.bind(URL)
    URL.createObjectURL = (blob) => { const url = create(blob); blobs.set(url, blob); return url }
    HTMLAnchorElement.prototype.click = function click() {
      const blob = blobs.get(this.href)
      if (this.download && blob) window.__exports.push({ name: this.download, blob })
    }
  })
  const exported = async (count) => {
    await page.waitForFunction((n) => window.__exports.length >= n, count, { timeout: 120_000 })
    const base64 = await page.evaluate(async (n) => {
      const entry = window.__exports[n - 1]
      const bytes = new Uint8Array(await entry.blob.arrayBuffer())
      let text = ''
      for (let i = 0; i < bytes.length; i += 32_768) text += String.fromCharCode(...bytes.subarray(i, i + 32_768))
      return { name: entry.name, data: btoa(text) }
    }, count)
    return { name: base64.name, bytes: Buffer.from(base64.data, 'base64') }
  }
  const palette = async (query) => {
    await page.keyboard.press('Control+p')
    await page.waitForSelector('input[role="combobox"], .command-palette input, [data-command-palette] input', { timeout: 10_000 }).catch(() => {})
    await page.keyboard.type(query)
    await sleep(400)
    await page.keyboard.press('Enter')
  }

  const exportViaDialog = async () => {
    await palette('Notiz exportieren')
    const dialog = page.locator('.note-export-dialog')
    await dialog.waitFor({ state: 'visible', timeout: 10_000 })
    await dialog.locator('button[data-format="pdf"]').click()
    await dialog.getByRole('button', { name: 'Exportieren', exact: true }).click()
  }

  // ---- Handwriting note ----
  await page.locator('.file-tree__row', { hasText: 'Export' }).first().click()
  await page.waitForFunction(() => document.querySelector('.cm-content')?.textContent?.includes('Getippter Absatz') && [...document.querySelectorAll('.lw-drawing-board canvas')].some((canvas) => canvas.width > 0), null, { timeout: 60_000 })
  await page.waitForFunction(() => document.querySelector('.note-text-field') && document.querySelector('.cm-live-image'), null, { timeout: 30_000 }).catch(() => {})
  await sleep(2500)
  const sheet = await page.evaluate(() => {
    const paper = document.querySelector('.unified-paper')
    return { width: paper.offsetWidth, height: paper.offsetHeight }
  })
  console.log(`sheet ${sheet.width} x ${sheet.height}`)

  const started = Date.now()
  await exportViaDialog()
  const first = await exported(1)
  const exportMs = Date.now() - started
  if (process.env.INK_EXPORT_DUMP) fs.writeFileSync(process.env.INK_EXPORT_DUMP, first.bytes)
  ok('the export is a PDF named after the note', first.name === 'Export.pdf' && first.bytes.subarray(0, 5).toString() === '%PDF-', first.name)
  const pdf = await openPdf(first.bytes)
  const lowest = ink.strokes.reduce((value, stroke) => Math.max(value, ...stroke.points.map((point) => point.y)), 0) * sheet.height
  const scale = (595.28 - 96) / sheet.width
  const pageCapPx = (841.89 - 96 - 30) / scale
  const expected = Math.max(1, Math.ceil((lowest + 16) / pageCapPx))
  ok('the page count fits the sheet', pdf.numPages >= expected && pdf.numPages <= expected + 1, `${pdf.numPages} pages, expected ${expected}`)
  let rasterFullPage = 0
  let strokesTotal = 0
  let imagesTotal = 0
  for (let number = 1; number <= pdf.numPages; number += 1) {
    const ops = await pageOps(pdf, number)
    strokesTotal += ops.strokes
    for (const [width, height] of ops.images) {
      imagesTotal += 1
      if (width > 400 || height > 400) rasterFullPage += 1
    }
  }
  ok('no full-page raster images', rasterFullPage === 0, `${imagesTotal} images`)
  ok('the strokes are vector paths', strokesTotal >= strokeRows * 3 * 0.8, `${strokesTotal} stroked paths`)
  const allText = (await Promise.all(Array.from({ length: pdf.numPages }, (_, index) => pageText(pdf, index + 1)))).join(' ')
  ok('the text box text is extractable', allText.includes('x ≤ 1 α'), allText.slice(0, 160))
  ok('the typed text is extractable', allText.includes('Getippter Absatz'), allText.slice(0, 160))
  ok('the picture is embedded', imagesTotal >= 1, `${imagesTotal}`)
  ok('the vector PDF is far smaller than the page picture', first.bytes.length < 1_500_000, `${(first.bytes.length / 1024).toFixed(0)} KB in ${exportMs} ms`)

  // The DOCX export (through the board handle): page pictures rendered from the vector PDF.
  const docx = await page.evaluate(async () => {
    const find = (start) => {
      for (const key of Object.keys(start)) {
        if (!key.startsWith('__reactFiber$')) continue
        for (let fiber = start[key]; fiber; fiber = fiber.return) {
          const handle = fiber.ref?.current
          if (handle && typeof handle.exportInkDocument === 'function') return handle
        }
      }
      return null
    }
    const handle = find(document.querySelector('.lw-drawing-board'))
    if (!handle) return null
    const bytes = await handle.exportInkDocument('docx', { format: 'docx', pageSize: 'a4', margins: 'normal', includeTitle: true, pageNumbers: false, paperBackground: false, annotations: true })
    if (!bytes) return null
    let text = ''
    for (let i = 0; i < bytes.length; i += 32_768) text += String.fromCharCode(...bytes.subarray(i, i + 32_768))
    return btoa(text)
  })
  ok('the board hands out a DOCX', Boolean(docx))
  let pagePng = null
  if (docx) {
    const zip = await JSZip.loadAsync(Buffer.from(docx, 'base64'))
    const documentXml = await zip.file('word/document.xml').async('string')
    const pictures = Object.keys(zip.files).filter((name) => /^word\/media\/page\d+\.png$/u.test(name))
    ok('the DOCX has one picture per PDF page', pictures.length === pdf.numPages, `${pictures.length}`)
    ok('the DOCX lists the text box as a paragraph under Textfelder', documentXml.includes('Textfelder') && documentXml.includes('x ≤ 1 α'))
    pagePng = await zip.file('word/media/page1.png').async('nodebuffer')
    ok('the DOCX page picture is about 200 dpi', pagePng.readUInt32BE(16) >= 1600, `${pagePng.readUInt32BE(16)} px wide`)
  }

  // Ink placement: page 1 (rendered by pdf.js) against the sheet on screen, as dark-pixel masks on a coarse grid.
  if (pagePng) {
    // The sheet is taller than the window: a taller window shows (and paints) all of it at once.
    await page.setViewportSize({ width: 1440, height: sheet.height + 400 }).catch(() => {})
    await sleep(2500)
    await page.evaluate(() => { const scroller = document.querySelector('.unified-note-view'); if (scroller) scroller.scrollTop = 0 })
    await sleep(800)
    const shot = await page.locator('.unified-paper').first().screenshot({ type: 'png' })
    if (process.env.INK_EXPORT_DUMP) fs.writeFileSync(`${process.env.INK_EXPORT_DUMP}.sheet.png`, shot)
    const verdict = await page.evaluate(async ({ pdfPng, sheetPng, sheetWidth, cap }) => {
      const load = (data) => new Promise((resolve, reject) => {
        const image = new Image()
        image.onload = () => resolve(image)
        image.onerror = reject
        image.src = `data:image/png;base64,${data}`
      })
      const [pdfImage, sheetImage] = await Promise.all([load(pdfPng), load(sheetPng)])
      const CELL = 6
      // A cell of sheet css px; the PDF page shows the sheet in [margin, margin + sheetWidth * s] pt.
      const mask = (image, originX, originY, pxPerCss, rows) => {
        const cols = Math.floor(sheetWidth / CELL)
        const canvas = document.createElement('canvas')
        canvas.width = Math.ceil(cols * CELL * pxPerCss)
        canvas.height = Math.ceil(rows * CELL * pxPerCss)
        const context = canvas.getContext('2d', { willReadFrequently: true })
        context.fillStyle = '#fff'
        context.fillRect(0, 0, canvas.width, canvas.height)
        context.drawImage(image, originX, originY, canvas.width, canvas.height, 0, 0, canvas.width, canvas.height)
        const data = context.getImageData(0, 0, canvas.width, canvas.height).data
        const out = new Float32Array(cols * rows)
        const step = CELL * pxPerCss
        for (let y = 0; y < canvas.height; y += 1) {
          for (let x = 0; x < canvas.width; x += 1) {
            const at = (y * canvas.width + x) * 4
            const dark = data[at] + data[at + 1] + data[at + 2] < 330 ? 1 : 0
            if (!dark) continue
            const cx = Math.min(cols - 1, Math.floor(x / step))
            const cy = Math.min(rows - 1, Math.floor(y / step))
            out[cy * cols + cx] += 1 / (step * step)
          }
        }
        return { out, cols, rows }
      }
      const rows = Math.floor(cap / CELL)
      const dpiScale = pdfImage.width / 595.28
      const margin = 48
      const sheetScale = sheetImage.width / sheetWidth
      // PDF page 1: the title band (30 pt) sits above the sheet.
      const pdfMask = mask(pdfImage, margin * dpiScale, (margin + 30) * dpiScale, (((595.28 - 2 * margin) / sheetWidth) * dpiScale), rows)
      const sheetMask = mask(sheetImage, 0, 0, sheetScale, rows)
      const inked = (value) => value > 0.06
      let both = 0
      let either = 0
      let pdfOnly = 0
      let sheetOnly = 0
      const near = (a, cols, x, y) => {
        for (let dy = -2; dy <= 2; dy += 1) for (let dx = -2; dx <= 2; dx += 1) {
          const nx = x + dx
          const ny = y + dy
          if (nx >= 0 && ny >= 0 && nx < cols && ny < rows && inked(a[ny * cols + nx])) return true
        }
        return false
      }
      for (let y = 0; y < rows; y += 1) {
        for (let x = 0; x < pdfMask.cols; x += 1) {
          const a = inked(pdfMask.out[y * pdfMask.cols + x])
          const b = inked(sheetMask.out[y * pdfMask.cols + x])
          if (a || b) either += 1
          if (a && near(sheetMask.out, pdfMask.cols, x, y)) both += 1
          else if (a) pdfOnly += 1
          if (b && !near(pdfMask.out, pdfMask.cols, x, y)) sheetOnly += 1
        }
      }
      const pdfCells = both + pdfOnly
      return { pdfCells, matchedOfPdf: pdfCells ? both / pdfCells : 0, sheetOnly, either }
    }, { pdfPng: pagePng.toString('base64'), sheetPng: shot.toString('base64'), sheetWidth: sheet.width, cap: Math.floor(pageCapPx * 0.7) })
    ok('the ink in the PDF sits where the sheet shows it', verdict.pdfCells > 40 && verdict.matchedOfPdf >= 0.7, JSON.stringify(verdict))
    ok('the sheet shows no ink the PDF lacks', verdict.sheetOnly <= verdict.either * 0.35, JSON.stringify(verdict))
  }

  // ---- PDF note ----
  await page.locator('.file-tree__row[data-kind="folder"]', { hasText: 'Fach' }).first().click()
  const blatt = page.locator('.file-tree__row', { hasText: 'Blatt' }).first()
  await blatt.waitFor({ state: 'visible', timeout: 10_000 })
  await blatt.click()
  await page.waitForFunction(() => [...document.querySelectorAll('[data-pdf-page="2"] canvas')].some((canvas) => canvas.width > 0) || document.querySelector('[data-pdf-page="2"]'), null, { timeout: 60_000 })
  await sleep(1500)
  await page.locator('button[aria-label="Stift"]').first().click()
  await page.waitForSelector('.lw-drawing-board.is-input-active', { timeout: 20_000 }).catch(() => {})
  await sleep(1000)
  await page.evaluate(() => document.querySelector('[data-pdf-page="2"]')?.scrollIntoView({ block: 'center' }))
  await sleep(700)
  const box = await page.locator('[data-pdf-page="2"]').boundingBox()
  const from = { x: box.x + box.width * 0.2, y: box.y + box.height * 0.4 }
  const to = { x: box.x + box.width * 0.7, y: box.y + box.height * 0.45 }
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  for (let step = 1; step <= 14; step += 1) await page.mouse.move(from.x + (to.x - from.x) * step / 14, from.y + (to.y - from.y) * step / 14 + Math.sin(step) * 6)
  await page.mouse.up()
  await sleep(1200)
  await exportViaDialog()
  const second = await exported(2)
  const notePdf = await openPdf(second.bytes)
  ok('the annotated PDF note keeps its page count', notePdf.numPages === 2, `${notePdf.numPages}`)
  ok('the original text stays selectable', (await pageText(notePdf, 1)).includes('Erste Seite') && (await pageText(notePdf, 2)).includes('Zweite Seite'))
  const one = await pageOps(notePdf, 1)
  const two = await pageOps(notePdf, 2)
  ok('ink is drawn on the marked page only', two.strokes >= 1 && one.strokes === 0, `page 1: ${one.strokes}, page 2: ${two.strokes}`)
  ok('the annotated PDF note adds no raster image', two.images.length === 0 && one.images.length === 0)
} catch (error) {
  failure = error
  console.log(`FAIL ${error instanceof Error ? error.stack ?? error.message : error}`)
  console.log(output.slice(-600))
} finally {
  await browser?.close().catch(() => {})
  try { process.kill(-child.pid, 'SIGTERM') } catch { /* gone */ }
  await sleep(500)
  fs.rmSync(temporary, { recursive: true, force: true })
}
if (failure || results.some((pass) => !pass)) {
  console.log(`ink export: ${results.filter((pass) => !pass).length} failed${failure ? ' (and an error)' : ''}`)
  process.exit(1)
}
console.log(`ink export: ${results.length} checks passed`)
process.exit(0)
