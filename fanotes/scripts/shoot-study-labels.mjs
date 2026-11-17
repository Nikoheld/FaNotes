// Study labels and legend on a synthetic PDF note (web build served on a local port): imports the PDF through the
// app, writes callouts, stamps and a legend through the app's own API, then for each theme reloads, opens the
// Lernwerkzeuge layer and prints the computed text colour and contrast of the label and legend inputs.
// Screenshots (cropped to the labels) are written for the light and dark theme.
// usage: node scripts/shoot-study-labels.mjs <baseUrl> <outDir> <prefix> [themes=light,dark] [shots=1]
//   e.g. node scripts/shoot-study-labels.mjs 'http://127.0.0.1:5337/?web' /tmp/shots study-labels dark,midnight,forest,aurora,light,sepia,snow
// Synthetic PDF and annotations only; a fresh browser context per run (no real profile is read).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
const require = createRequire('/srv/agents/fanotes/.site-redesign-tools/')
const { chromium } = require('playwright-core')
const [base = 'http://127.0.0.1:5380/?web', out = '.', prefix = 'run', themeArg = 'light,dark', shotsArg = '1'] = process.argv.slice(2)
const themes = themeArg.split(',').filter(Boolean)
const takeShots = shotsArg !== '0'
fs.mkdirSync(out, { recursive: true })

// -- a tiny one page PDF with a figure to label, written by hand ---------------------------
const content = [
  'BT /F1 18 Tf 60 790 Td (Arbeitsblatt Insekten \\(synthetisch\\)) Tj ET',
  'BT /F1 11 Tf 60 765 Td (Beschrifte die Teile des Insekts.) Tj ET',
  '0.86 0.91 0.96 rg 200 380 200 260 re f',
  '0.2 0.2 0.2 RG 2 w 200 380 200 260 re S',
  '0.96 0.82 0.35 rg 250 570 100 60 re f',
  '0 0 0 RG 1 w 250 570 100 60 re S',
  '300 630 m 270 700 l S 300 630 m 330 700 l S',
  '200 520 m 120 540 l S 200 460 m 120 450 l S 400 520 m 480 540 l S 400 460 m 480 450 l S',
].join('\n')
const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
  '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
  `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
  '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>']
let pdf = '%PDF-1.4\n'
const offsets = objects.map((body, index) => { const at = pdf.length; pdf += `${index + 1} 0 obj\n${body}\nendobj\n`; return at })
const xref = pdf.length
pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((at) => `${String(at).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
const work = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'fanotes-labels-'))
const pdfFile = path.join(work, 'Arbeitsblatt Insekten.pdf')
fs.writeFileSync(pdfFile, Buffer.from(pdf, 'latin1'))

// -- annotations: plain labels in the four picker colours, a legend with two stamps ----------
const items = [
  { kind: 'callout', id: 'c1', page: 1, ax: 0.5, ay: 0.2, lx: 0.74, ly: 0.12, text: 'Fühler', color: '#1d4ed8' },
  { kind: 'callout', id: 'c2', page: 1, ax: 0.5, ay: 0.3, lx: 0.2, ly: 0.3, text: 'Kopf', color: '#dc2626' },
  { kind: 'callout', id: 'c3', page: 1, ax: 0.4, ay: 0.42, lx: 0.78, ly: 0.42, text: 'Vorderbein', color: '#16a34a' },
  { kind: 'callout', id: 'c4', page: 1, ax: 0.5, ay: 0.5, lx: 0.22, ly: 0.5, text: 'Hinterleib', color: '#111827' },
  { kind: 'stamp', id: 's1', page: 1, x: 0.3, y: 0.2, stamp: 'gain', size: 28 },
  { kind: 'stamp', id: 's2', page: 1, x: 0.38, y: 0.2, stamp: 'loss', size: 28 },
  { kind: 'legend', id: 'l1', page: 1, x: 0.08, y: 0.36, names: { gain: 'Zunahme', loss: 'Abnahme' } },
]

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/usr/bin/chromium', args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'] })
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'de-CH', colorScheme: themes[0] === 'light' ? 'light' : 'dark' })
const page = await context.newPage()
const errors = []
page.on('pageerror', (error) => errors.push(String(error).slice(0, 200)))
// The app opens a file chooser through a detached <input>; keep the click a no-op so we can feed it.
await page.addInitScript(() => {
  const click = HTMLInputElement.prototype.click
  HTMLInputElement.prototype.click = function () { if (this.type === 'file') return undefined; return click.call(this) }
})
await page.goto(base, { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(3500)
await page.evaluate(async () => { await window.fanotes.completeOnboarding(['Biologie']) })
await page.reload({ waitUntil: 'domcontentloaded' })
await page.waitForTimeout(3500)

await page.locator('button', { hasText: /^\s*PDF\s*$/ }).first().click()
const input = page.locator('input[type=file]').last()
await input.waitFor({ state: 'attached' })
await input.setInputFiles(pdfFile)
await page.waitForTimeout(3500)
const pdfPath = await page.evaluate(() => new Promise((resolve, reject) => {
  const request = indexedDB.open('fanotes-web-vault')
  request.onerror = () => reject(request.error)
  request.onsuccess = () => {
    const db = request.result
    const keys = db.transaction('assets', 'readonly').objectStore('assets').getAllKeys()
    keys.onerror = () => reject(keys.error)
    keys.onsuccess = () => { db.close(); resolve(keys.result.find((key) => /\.pdf$/iu.test(String(key))) ?? null) }
  }
}))
if (!pdfPath) throw new Error('imported PDF not found in the web vault')
await page.evaluate(([notePath, list]) => window.fanotes.writeNoteAnnotations(notePath, list), [pdfPath, items])

const audit = () => page.evaluate(() => {
  const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  const rgba = (css, under) => {
    ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = `rgb(${under.join(',')})`; ctx.fillRect(0, 0, 1, 1)
    ctx.fillStyle = css; ctx.fillRect(0, 0, 1, 1)
    const d = ctx.getImageData(0, 0, 1, 1).data
    return [d[0], d[1], d[2]]
  }
  const lum = ([r, g, b]) => { const f = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4 }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b) }
  const ratio = (a, b) => { const hi = Math.max(lum(a), lum(b)); const lo = Math.min(lum(a), lum(b)); return (hi + 0.05) / (lo + 0.05) }
  const rows = []
  const check = (name, element, backdrop) => {
    const style = getComputedStyle(element)
    // Ancestor backgrounds, drawn bottom-up over the white PDF page.
    const chain = []
    for (let node = element; node; node = node.parentElement) {
      const bg = getComputedStyle(node).backgroundColor
      if (bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent') chain.unshift(bg)
      if (node === backdrop) break
    }
    let under = [255, 255, 255]
    for (const bg of chain) under = rgba(bg, under)
    const fg = rgba(style.color, under)
    rows.push({ name, color: style.color, caret: style.caretColor, scheme: style.colorScheme, bg: `rgb(${under.join(',')})`, contrast: Number(ratio(fg, under).toFixed(2)) })
  }
  document.querySelectorAll('.study-label').forEach((label, index) => { const field = label.querySelector('input'); if (field) check(`label input #${index + 1} "${field.value}"`, field, label.closest('.unified-paper')) })
  document.querySelectorAll('.study-legend-row input').forEach((field, index) => check(`legend row input #${index + 1} "${field.value}"`, field, field.closest('.unified-paper')))
  const legend = document.querySelector('.study-legend')
  if (legend) check('legend text', legend, legend.closest('.unified-paper'))
  return rows
})

const results = {}
for (const theme of themes) {
  await page.evaluate(async (value) => { const boot = await window.fanotes.bootstrap(); await window.fanotes.saveSettings({ ...boot.settings, theme: value }) }, theme)
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(3500)
  if (!(await page.locator('.unified-paper').count())) {
    await page.locator('.file-tree__name', { hasText: 'Arbeitsblatt Insekten' }).first().click()
    await page.locator('.unified-paper').first().waitFor({ timeout: 20000 })
  }
  await page.locator('button', { hasText: /^\s*Lernen\s*$/ }).first().click()
  await page.locator('.study-label').first().waitFor({ timeout: 20000 })
  await page.waitForTimeout(1200)
  results[theme] = await audit()
  const themeClass = await page.evaluate(() => [...document.querySelector('.app-shell').classList].find((name) => name.startsWith('theme-')))
  console.log(`\n== ${theme} (${themeClass}) ==`)
  console.table(results[theme])
  if (takeShots && (theme === 'light' || theme === 'dark')) {
    // Crop to the labels, stamps and legend; keep the study panel out of the picture.
    await page.addStyleTag({ content: '.study-panel{display:none!important}' }).catch(() => undefined)
    const union = await page.evaluate(() => {
      const boxes = [...document.querySelectorAll('.study-label, .study-legend, .study-stamp')].map((node) => node.getBoundingClientRect())
      if (!boxes.length) return null
      const left = Math.min(...boxes.map((b) => b.left)); const top = Math.min(...boxes.map((b) => b.top))
      const right = Math.max(...boxes.map((b) => b.right)); const bottom = Math.max(...boxes.map((b) => b.bottom))
      return { left, top, right, bottom }
    })
    const pad = 40
    const clip = union ? { x: Math.max(0, union.left - pad), y: Math.max(0, union.top - pad), width: Math.min(1440, union.right + pad) - Math.max(0, union.left - pad), height: Math.min(1000, union.bottom + pad) - Math.max(0, union.top - pad) } : undefined
    await page.screenshot({ path: path.join(out, `${prefix}-${theme}.png`), clip })
  }
}
console.log('page errors:', errors.length ? errors.join(' | ') : 'none')
await context.close()
await browser.close()
fs.rmSync(work, { recursive: true, force: true })
