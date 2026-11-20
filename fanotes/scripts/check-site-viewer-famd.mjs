// Website .famd viewer (fanotes-site/public/viewer): ink must render for famd v1 and v2.
// Part 1 (node): the viewer's reader decodes files written by the app's own serializeFamd.
// Part 2 (Chromium via playwright-core, skipped when unavailable): load the page, open the
// files and assert that ink pixels appear where the strokes are, for several brushes, paper
// styles, PDF side pages (several pages) and zoom.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { existsSync, readFileSync, readdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import http from 'node:http'
import vm from 'node:vm'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const publicDir = path.resolve(here, '../../fanotes-site/public')
const require = createRequire(import.meta.url)
const { serializeFamd } = require('../electron/famd.cjs')
// The viewer script is a classic browser script: run it in a sandbox to get window.FamdRead.
const sandbox = {}
vm.runInNewContext(readFileSync(path.join(publicDir, 'viewer/famd-read.js'), 'utf8'), Object.assign(sandbox, { window: sandbox, TextEncoder }))
const { readFamd, collectPages } = sandbox.FamdRead

const pt = (x, y, pressure = 0.6) => ({ x, y, t: 1, pressure, tiltX: 0, tiltY: 0, pointerType: 'pen' })
const line = (x0, y0, x1, y1, n = 12, pressure = 0.6) => Array.from({ length: n }, (_, i) => pt(x0 + (x1 - x0) * i / (n - 1), y0 + (y1 - y0) * i / (n - 1), pressure))
const stroke = (points, extra = {}) => ({
  points, baseWidth: 6, pressureEnabled: true, color: '#d11a1a', purpose: 'handwriting', colorEffect: 'solid', opacity: 1, textureSeed: 3, ...extra,
})
// name -> { stroke, probe } ; probe is a page fraction on the stroke centre line.
const cases = {
  pen: { stroke: stroke(line(0.1, 0.10, 0.5, 0.10)), probe: [0.3, 0.10] },
  highlighter: { stroke: stroke(line(0.1, 0.20, 0.5, 0.20), { purpose: 'art', brush: 'highlighter', baseWidth: 22, opacity: 0.6, color: '#f5d90a' }), probe: [0.3, 0.20] },
  marker: { stroke: stroke(line(0.1, 0.30, 0.5, 0.30), { purpose: 'art', brush: 'marker', baseWidth: 10, color: '#1a4fd1' }), probe: [0.3, 0.30] },
  pencil: { stroke: stroke(line(0.1, 0.40, 0.5, 0.40), { purpose: 'art', brush: 'pencil', baseWidth: 8, color: '#222222' }), probe: [0.3, 0.40] },
  paintbrush: { stroke: stroke(line(0.1, 0.50, 0.5, 0.50), { purpose: 'art', brush: 'paintbrush', baseWidth: 12, color: '#0a8a3a' }), probe: [0.3, 0.50] },
  calligraphy: { stroke: stroke(line(0.1, 0.60, 0.5, 0.65), { purpose: 'art', brush: 'calligraphy', baseWidth: 12, color: '#7a1fa2' }), probe: [0.3, 0.625] },
  watercolor: { stroke: stroke(line(0.1, 0.70, 0.5, 0.70), { purpose: 'art', brush: 'watercolor', baseWidth: 16, color: '#1f8fd1' }), probe: [0.3, 0.70] },
  rainbow: { stroke: stroke(line(0.1, 0.80, 0.9, 0.80), { colorEffect: 'rainbow' }), probe: [0.5, 0.80] },
  dot: { stroke: stroke([pt(0.7, 0.9)], { baseWidth: 14 }), probe: [0.7, 0.9] },
}
const strokes = Object.values(cases).map((c) => c.stroke)
const makeInk = (paperStyle) => ({ schemaVersion: 1, title: 'T', paperStyle, sourceWidth: 900, sourceHeight: 1273, strokes })
const payload = (ink, paperStyle) => ({ schema: 'fanotes-famd-v1', updatedAt: '2026-11-20T08:00:00.000Z', ink, worksheets: [], ...(paperStyle ? { paperStyle } : {}) })
const sideInk = { schemaVersion: 1, kind: 'fanotes-pdf-side-pages', pdf: 'x.pdf', updatedAt: '2026-11-20T08:00:00.000Z',
  ink: [1, 3].map((page) => ({ page, width: 595, height: 842, ink: { sourceWidth: 820, sourceHeight: 1160.34, paperStyle: 'blank', strokes: [cases.pen.stroke] } })) }

const files = {
  'plain-v1.famd': serializeFamd('# Titel\n\nText', payload(makeInk('dots')), 'v1'),
  'plain-v2.famd': serializeFamd('# Titel\n\nText', payload(makeInk('dots')), 'v2'),
  'lines-v2.famd': serializeFamd('# Lines', payload(makeInk('lines'), 'lines'), 'v2'),
  'grid-v1.famd': serializeFamd('# Grid', payload(makeInk('grid'), 'grid'), 'v1'),
  'millimeter-v2.famd': serializeFamd('', payload(makeInk('millimeter'), 'millimeter'), 'v2'),
  'side-v1.famd': serializeFamd('', payload(sideInk), 'v1'),
}

// ---- part 1: codec ----
for (const [name, text] of Object.entries(files)) {
  const parsed = readFamd(text)
  assert.ok(parsed.payload, `${name}: payload parsed (${parsed.error ?? ''})`)
  assert.equal(parsed.version, name.includes('v2') ? 2 : 1, `${name}: version`)
  const pages = collectPages(parsed.payload)
  assert.equal(pages.length, name.startsWith('side') ? 2 : 1, `${name}: pages`)
  if (!name.startsWith('side')) {
    assert.equal(pages[0].doc.strokes.length, strokes.length, `${name}: stroke count`)
    assert.ok(pages[0].doc.strokes.every((s) => Array.isArray(s.points) && s.points.length), `${name}: points unpacked`)
  }
}
{ // corrupted v2: crc mismatch is reported, markdown is still readable
  const bad = files['plain-v2.famd'].replace('"#d11a1a"', '"#d11a1b"')
  const parsed = readFamd(bad)
  assert.equal(parsed.payload, null)
  assert.match(parsed.error, /checksum/u)
  assert.match(parsed.markdown, /Titel/u)
}
const specDir = process.env.FAMD_SPEC_FIXTURES ?? '/srv/agents/fanotes/.site-redesign-tools/tmp/famd-spec/fixtures-generated'
const fixtureFiles = existsSync(specDir) ? readdirSync(specDir).filter((n) => n.endsWith('.famd') && !n.startsWith('corrupt')) : []
for (const name of fixtureFiles) {
  const parsed = readFamd(readFileSync(path.join(specDir, name), 'utf8'))
  assert.ok(parsed.payload || /no-payload/u.test(name), `fixture ${name} parses`)
}
console.log(`codec ok (${Object.keys(files).length} generated, ${fixtureFiles.length} spec fixtures)`)

// ---- part 2: browser ----
const chromium = process.env.FANOTES_CHROMIUM ?? '/usr/bin/chromium'
const playwrightEntry = process.env.PLAYWRIGHT_CORE ?? '/srv/agents/fanotes/.site-redesign-tools/node_modules/playwright-core/index.mjs'
if (process.env.FANOTES_SKIP_BROWSER === '1' || !existsSync(chromium) || !existsSync(playwrightEntry)) {
  console.log('browser part skipped (no chromium / playwright-core)')
  process.exit(0)
}
const { chromium: browserType } = await import(pathToFileURL(playwrightEntry).href)
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' }
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x')
  let file = path.join(publicDir, decodeURIComponent(url.pathname))
  if (!file.startsWith(publicDir)) { res.writeHead(403); res.end(); return }
  if (existsSync(file) && !path.extname(file)) file = path.join(file, 'index.html')
  if (!existsSync(file)) { res.writeHead(404); res.end(); return }
  res.writeHead(200, { 'Content-Type': mime[path.extname(file)] ?? 'application/octet-stream' })
  res.end(readFileSync(file))
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port
const tmp = mkdtempSync(path.join(process.env.TMPDIR ?? tmpdir(), 'viewer-famd-'))
const browser = await browserType.launch({ executablePath: chromium, args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'] })
const failures = []
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } })
  page.on('pageerror', (error) => failures.push(`pageerror: ${error.message}`))

  // Pixel probe: [r,g,b] at a page fraction of canvas `index`, and the stroke-free paper at a far corner.
  const pixelAt = (index, fx, fy) => page.evaluate(([i, x, y]) => {
    const canvas = document.querySelectorAll('canvas.ink-canvas')[i]
    const ctx = canvas.getContext('2d')
    const d = ctx.getImageData(Math.round(x * (canvas.width - 1)), Math.round(y * (canvas.height - 1)), 1, 1).data
    return [d[0], d[1], d[2]]
  }, [index, fx, fy])
  const differsFromPaper = (rgb) => Math.abs(rgb[0] - 0xfb) + Math.abs(rgb[1] - 0xfc) + Math.abs(rgb[2] - 0xff) > 24

  const open = async (name) => {
    const file = path.join(tmp, name)
    writeFileSync(file, files[name])
    await page.goto(`http://127.0.0.1:${port}/viewer/`)
    await page.setInputFiles('#file', file)
    await page.waitForSelector('[data-ink-wrap]:not([hidden]) canvas.ink-canvas')
    await page.waitForTimeout(250)
  }

  for (const name of ['plain-v1.famd', 'plain-v2.famd', 'lines-v2.famd', 'grid-v1.famd', 'millimeter-v2.famd']) {
    await open(name)
    for (const [brush, c] of Object.entries(cases)) {
      const rgb = await pixelAt(0, c.probe[0], c.probe[1])
      if (!differsFromPaper(rgb)) failures.push(`${name}: no ink pixel for ${brush} at ${c.probe} (got ${rgb})`)
    }
    // Colour check: red pen is red, highlighter stays yellowish (multiply), rainbow is not grey.
    const pen = await pixelAt(0, ...cases.pen.probe)
    if (!(pen[0] > 150 && pen[1] < 80 && pen[2] < 80)) failures.push(`${name}: pen is not red (${pen})`)
    const hl = await pixelAt(0, ...cases.highlighter.probe)
    if (!(hl[0] > 200 && hl[1] > 190 && hl[2] < 235)) failures.push(`${name}: highlighter colour unexpected (${hl})`)
    // Blank spot far from every stroke shows paper, not ink.
    const blank = await pixelAt(0, 0.95, 0.02)
    if (differsFromPaper(blank) && !/millimeter|grid|lines/u.test(name)) failures.push(`${name}: stray ink at empty spot (${blank})`)
    const count = await page.textContent('[data-ink-count]')
    if (!/9 Striche/u.test(count ?? '')) failures.push(`${name}: stroke count text "${count}"`)
  }

  // Zoom: canvas CSS width follows the zoom buttons and ink still draws.
  await open('plain-v2.famd')
  const w0 = await page.evaluate(() => document.querySelector('canvas.ink-canvas').getBoundingClientRect().width)
  await page.click('[data-zoom="out"]')
  await page.waitForTimeout(250)
  const w1 = await page.evaluate(() => document.querySelector('canvas.ink-canvas').getBoundingClientRect().width)
  if (!(w1 < w0 * 0.9)) failures.push(`zoom out did not shrink (${w0} -> ${w1})`)
  if (!differsFromPaper(await pixelAt(0, ...cases.pen.probe))) failures.push('no ink after zoom out')
  await page.click('[data-zoom="in"]')
  await page.click('[data-zoom="in"]')
  await page.waitForTimeout(250)
  const w2 = await page.evaluate(() => document.querySelector('canvas.ink-canvas').getBoundingClientRect().width)
  if (!(w2 > w1 * 1.3)) failures.push(`zoom in did not grow (${w1} -> ${w2})`)
  if (!differsFromPaper(await pixelAt(0, ...cases.pen.probe))) failures.push('no ink after zoom in')

  // PDF side pages: two canvases (pages 1 and 3), each with ink.
  await open('side-v1.famd')
  const n = await page.evaluate(() => document.querySelectorAll('canvas.ink-canvas').length)
  if (n !== 2) failures.push(`side pages: expected 2 canvases, got ${n}`)
  for (let i = 0; i < n; i += 1) {
    if (!differsFromPaper(await pixelAt(i, ...cases.pen.probe))) failures.push(`side page ${i + 1}: no ink`)
  }
} finally {
  await browser.close()
  server.close()
  rmSync(tmp, { recursive: true, force: true })
}
if (failures.length) {
  console.error(failures.join('\n'))
  process.exit(1)
}
console.log('site viewer famd ink ok')
