// "Leere Seiten daneben": blank writing pages beside the pages of a PDF note.
// Part 1: storage format, famd round trip, read compatibility of older code
// paths, and the merge/split of the shared ink frame (mixed page sizes and
// rotation). Part 2: the real desktop app (Electron under Xvfb): the toolbar
// toggle, side page boxes equal to their PDF pages, ink on a side page saved
// and reopened at the same spot, the toggle off/on keeping it, and no file for
// empty side pages. Part 2 needs a built renderer (`vite build`), xvfb-run and
// playwright-core (PLAYWRIGHT_CORE); FANOTES_SKIP_BROWSER=1 skips it.
// Synthetic PDF and vault only.
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const famdMain = require('../electron/famd.cjs')
const server = await createServer({
  root,
  appType: 'custom',
  logLevel: 'error',
  optimizeDeps: { noDiscovery: true },
  server: { middlewareMode: true },
})
const side = await server.ssrLoadModule('/src/lib/pdfSidePages.ts')
const famd = await server.ssrLoadModule('/src/lib/famd.ts')
await server.close()

const close = (actual, expected, label, tolerance = 1e-9) => {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${label}: ${actual} != ${expected}`)
}
const stroke = (points, extra = {}) => ({
  points: points.map(([x, y], index) => ({ x, y, t: index * 8, pressure: 0.5, tiltX: 0, tiltY: 0, pointerType: 'pen' })),
  baseWidth: 3.5,
  pressureEnabled: true,
  color: '#1f2430',
  purpose: 'handwriting',
  colorEffect: 'solid',
  opacity: 1,
  textureSeed: 7,
  ...extra,
})

// ---- Part 1: format and frame ------------------------------------------------

// Path of the companion.
assert.equal(side.pdfSidePagesPath('Bio/Zelle.pdf'), '.fanotes/pdf-side/Bio/Zelle.pdf.famd')
assert.equal(side.pdfSidePagesPath('\\Top.pdf'), '.fanotes/pdf-side/Top.pdf.famd')

// Mixed sizes and rotation: page boxes in the board frame.
const sizes = [{ width: 595, height: 842 }, { width: 842, height: 595 }, { width: 420, height: 595 }]
const layoutFor = (rotation) => {
  const column = 820
  const gap = side.PDF_SIDE_PAGE_GAP_PX
  const paperWidth = Math.max(1154, 2 * column + gap)
  const left = (paperWidth - (2 * column + gap)) / 2
  let top = 18
  const pages = sizes.map((size) => {
    const height = column * side.pdfSidePageRatio(size, rotation)
    const box = { left: left + column + gap, top, width: column, height }
    top += height + 16
    return box
  })
  return { paperWidth, paperHeight: top - 16 + 36, scrollerWidth: 1154, pdfColumnLeft: left, pdfColumnWidth: column, rotation, pages, sizes }
}
const layout = layoutFor(0)
close(layout.pages[1].height, 820 * 595 / 842, 'landscape page box')
close(side.pdfSidePageRatio(sizes[0], 90), 595 / 842, 'rotated ratio swaps the box')
for (const rotation of [0, 90, 180, 270]) {
  const [u, v] = side.rotatePagePoint(0.2, 0.7, rotation)
  const back = side.unrotatePagePoint(u, v, rotation)
  close(back[0], 0.2, `rotation ${rotation} u`)
  close(back[1], 0.7, `rotation ${rotation} v`)
}

// The PDF's own ink: saved without side pages on a 1154 px paper.
const pdfDrawing = {
  schemaVersion: 1,
  title: 'Handschrift · Blatt',
  paperStyle: 'blank',
  sourceWidth: 1154,
  sourceHeight: 3600,
  createdAt: '2026-11-01T10:00:00.000Z',
  updatedAt: '2026-11-01T10:00:00.000Z',
  strokes: [stroke([[0.4, 0.1], [0.5, 0.11], [0.6, 0.12]])],
  inkHistory: { extras: [stroke([[0.3, 0.3], [0.31, 0.31]])], undo: [[], [{ extra: 0 }]], redo: [] },
}

// 1. Toggle on and off without writing: the PDF ink comes back unchanged.
{
  const merged = side.mergePdfSideInk(pdfDrawing, null, layout, { title: 'x' })
  assert.equal(merged.drawing.sourceWidth, layout.paperWidth)
  assert.equal(merged.drawing.strokes.length, 1)
  // Same spot on the PDF page: column-relative x is kept.
  const plainLeft = (1154 - 820) / 2
  const columnX = (0.4 * 1154 - plainLeft) / 820
  close(merged.drawing.strokes[0].points[0].x * layout.paperWidth, layout.pdfColumnLeft + columnX * 820, 'PDF ink moves with the column', 1e-6)
  close(merged.drawing.strokes[0].points[0].y * merged.drawing.sourceHeight, 0.1 * 3600, 'PDF ink keeps its height', 1e-6)
  const split = side.splitPdfSideInk(merged.drawing, layout, merged, 'Bio/Blatt.pdf')
  assert.equal(split.pdfFingerprint, merged.pdfFingerprint, 'an untouched PDF needs no save')
  assert.equal(split.sideFingerprint, merged.sideFingerprint)
  assert.equal(split.store.ink.length, 0, 'no side entry without side ink')
  assert.equal(split.pdfDrawing.sourceWidth, 1154)
  split.pdfDrawing.strokes[0].points.forEach((point, index) => {
    close(point.x, pdfDrawing.strokes[0].points[index].x, 'PDF x round trip')
    close(point.y, pdfDrawing.strokes[0].points[index].y, 'PDF y round trip')
  })
  // Undo history survives both ways and never lists side strokes.
  assert.equal(merged.drawing.inkHistory.undo.length, 2)
  assert.deepEqual(split.pdfDrawing.inkHistory.undo, [[], [{ extra: 0 }]])
  close(split.pdfDrawing.inkHistory.extras[0].points[0].x, 0.3, 'history extra round trip')
}

// 2. Ink on side pages (mixed sizes, every rotation) saves page-local and reopens at the same spot.
for (const rotation of [0, 90, 180, 270]) {
  const frame = layoutFor(rotation)
  const merged = side.mergePdfSideInk(pdfDrawing, null, frame, { title: 'x' })
  const W = merged.drawing.sourceWidth
  const H = merged.drawing.sourceHeight
  const onSide = (page, u, v) => {
    const box = frame.pages[page - 1]
    return [(box.left + u * box.width) / W, (box.top + v * box.height) / H]
  }
  const drawn = [
    stroke([onSide(2, 0.25, 0.5), onSide(2, 0.5, 0.5), onSide(2, 0.75, 0.52)]),
    stroke([onSide(3, 0.1, 0.1), onSide(3, 0.2, 0.15)], { color: '#d03030' }),
  ]
  const board = { ...merged.drawing, strokes: [...merged.drawing.strokes, ...drawn] }
  const split = side.splitPdfSideInk(board, frame, merged, 'Bio/Blatt.pdf', '2026-11-20T10:00:00.000Z')
  assert.equal(split.pdfFingerprint, merged.pdfFingerprint, `rotation ${rotation}: side ink leaves the PDF ink alone`)
  assert.notEqual(split.sideFingerprint, merged.sideFingerprint)
  assert.deepEqual(split.store.ink.map((entry) => entry.page), [2, 3], `rotation ${rotation}: one entry per inked page`)
  const entry2 = split.store.ink[0]
  assert.deepEqual([entry2.width, entry2.height], [842, 595], 'entry keeps the PDF page size in points')
  const [u0, v0] = side.unrotatePagePoint(0.25, 0.5, rotation)
  close(entry2.ink.strokes[0].points[0].x, u0, `rotation ${rotation}: page-local x`)
  close(entry2.ink.strokes[0].points[0].y, v0, `rotation ${rotation}: page-local y`)
  // File round trip, then merge again: the strokes land where they were drawn.
  const text = side.serializePdfSidePages(split.store)
  const reread = side.parsePdfSidePages(text)
  assert.deepEqual(reread.ink.map((entry) => entry.page), [2, 3])
  const again = side.mergePdfSideInk(split.pdfDrawing, reread, frame, { title: 'x' })
  const sideStrokes = again.drawing.strokes.slice(1)
  assert.equal(sideStrokes.length, 2)
  sideStrokes.forEach((placed, index) => placed.points.forEach((point, at) => {
    close(point.x * again.drawing.sourceWidth, drawn[index].points[at].x * W, `rotation ${rotation}: reopened x`, 1e-6)
    close(point.y * again.drawing.sourceHeight, drawn[index].points[at].y * H, `rotation ${rotation}: reopened y`, 1e-6)
  }))
  assert.equal(sideStrokes[1].color, '#d03030', 'colour and tool fields pass through')
}

// 3. A stroke that crosses into the gap belongs to the column holding its centre.
{
  const merged = side.mergePdfSideInk(null, null, layout, { title: 'x' })
  const W = merged.drawing.sourceWidth
  const H = merged.drawing.sourceHeight
  const edge = layout.pdfColumnLeft + layout.pdfColumnWidth
  const pdfish = stroke([[(edge - 60) / W, 0.05], [(edge + 10) / W, 0.05]])
  const sideish = stroke([[(edge + 2) / W, 0.05], [(edge + 80) / W, 0.05]])
  const split = side.splitPdfSideInk({ ...merged.drawing, strokes: [pdfish, sideish] }, layout, merged, 'a.pdf')
  assert.equal(split.pdfDrawing.strokes.length, 1)
  assert.equal(split.store.ink.length, 1)
  assert.equal(split.store.ink[0].page, 1)
  assert.equal(split.pdfDrawing.sourceWidth, 1154, 'a PDF without ink gets the plain paper width')
  void H
}

// 4. famd round trip and the readers of older versions.
{
  const store = side.parsePdfSidePages(side.serializePdfSidePages({
    schemaVersion: 1,
    kind: side.PDF_SIDE_PAGES_KIND,
    pdf: 'Bio/Blatt.pdf',
    updatedAt: '2026-11-20T10:00:00.000Z',
    ink: [{ page: 2, width: 842, height: 595, ink: { schemaVersion: 1, paperStyle: 'blank', sourceWidth: 820, sourceHeight: 579, strokes: [stroke([[0.2, 0.3], [0.4, 0.5]])] } }],
  }))
  const text = side.serializePdfSidePages(store)
  assert.match(text, /^<!-- fanotes-famd:v1 chars=\d+ -->\n/u, 'a plain famd v1 file')
  assert.equal(side.serializePdfSidePages(side.parsePdfSidePages(text)), text, 'byte-stable round trip')
  assert.equal(side.pdfSidePagesHaveInk(store), true)
  // Desktop main (every released build): parses it, keeps the payload ink whole on a rewrite.
  const parsed = famdMain.parseFamd(text)
  assert.equal(parsed.payload.ink.kind, side.PDF_SIDE_PAGES_KIND)
  const rewritten = famdMain.serializeFamd(parsed.markdown, parsed.payload, 'v1')
  assert.deepEqual(famdMain.parseFamd(rewritten).payload.ink, parsed.payload.ink, 'an old rewrite keeps every side page')
  assert.equal(famdMain.inkHasMarks(parsed.payload), true, 'old blank-note check sees the marks (main)')
  // Renderer famd and sync: present, not blank; a side-ink edit changes the sync identity.
  const bytes = new TextEncoder().encode(text)
  assert.equal(famd.noteSyncKind(side.pdfSidePagesPath('Bio/Blatt.pdf'), bytes), 'present')
  assert.equal(famd.inkHasMarks(famd.parseFamd(text).payload), true)
  const edited = side.serializePdfSidePages({ ...store, ink: [{ ...store.ink[0], ink: { ...store.ink[0].ink, strokes: [stroke([[0.25, 0.3], [0.4, 0.5]])] } }] })
  const identity = (value) => Buffer.from(famd.identitySyncBytes('.fanotes/pdf-side/Bio/Blatt.pdf.famd', new TextEncoder().encode(value))).toString('utf8')
  assert.notEqual(identity(edited), identity(text), 'sync sees a side-ink change')
  assert.equal(Buffer.from(famd.canonicalSyncBytes('x.famd', bytes)).toString('utf8'), text, 'sync uploads the bytes unchanged')
  // Garbage and foreign files are not side pages.
  assert.equal(side.parsePdfSidePages(''), null)
  assert.equal(side.parsePdfSidePages(famdMain.serializeFamd('# Note', famdMain.emptyFamdPayload(), 'v1')), null)
  // The shared Android/legacy fixture parses and matches.
  const fixture = fs.readFileSync(path.join(root, '..', 'android', 'core', 'src', 'test', 'resources', 'famd', 'pdf-side-pages.famd'), 'utf8')
  const fromFixture = side.parsePdfSidePages(fixture)
  assert.deepEqual(fromFixture.ink.map((entry) => [entry.page, entry.width, entry.height, entry.ink.strokes.length]), [[1, 595, 842, 1], [3, 842, 595, 2]])
  assert.equal(famdMain.inkHasMarks(famdMain.parseFamd(fixture).payload), true)
}

// 5. Empty side pages cost nothing: no entries, nothing serialized beyond the shell.
{
  const merged = side.mergePdfSideInk(pdfDrawing, null, layout, { title: 'x' })
  const split = side.splitPdfSideInk(merged.drawing, layout, merged, 'Bio/Blatt.pdf')
  assert.equal(split.store.ink.length, 0)
  assert.equal(side.pdfSidePagesHaveInk(split.store), false)
}

console.log('pdf side pages: format, famd round trip, legacy readers and frame checks passed')

// ---- Part 2: the desktop app ------------------------------------------------

const electron = path.join(root, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron')
const xvfb = spawnSync('sh', ['-c', 'command -v xvfb-run'], { encoding: 'utf8' }).stdout.trim()
const builtRenderer = fs.existsSync(path.join(root, 'dist', 'index.html'))
if (process.env.FANOTES_SKIP_BROWSER === '1' || !xvfb || !fs.existsSync(electron) || !builtRenderer) {
  console.log(`pdf side pages: desktop part skipped (${process.env.FANOTES_SKIP_BROWSER === '1' ? 'FANOTES_SKIP_BROWSER=1' : !xvfb ? 'no xvfb-run' : !builtRenderer ? 'no dist/ (run vite build)' : 'no electron'})`)
  process.exit(0)
}
let playwright
try {
  playwright = await import(process.env.PLAYWRIGHT_CORE || 'playwright-core')
} catch {
  console.log('pdf side pages: desktop part skipped (no playwright-core; set PLAYWRIGHT_CORE)')
  process.exit(0)
}
const chromium = playwright.chromium ?? playwright.default.chromium

const temporary = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'fanotes-side-'))
const home = path.join(temporary, 'home')
const configHome = path.join(temporary, 'config')
const runtime = path.join(temporary, 'runtime')
const vault = path.join(home, 'Notizen')
const userData = path.join(configHome, 'FaNotes')
for (const directory of [home, configHome, runtime, vault, userData, path.join(vault, 'Biologie')]) fs.mkdirSync(directory, { recursive: true, mode: 0o700 })

// Three pages: A4 portrait, A4 landscape, A5 portrait.
const makePdf = () => {
  const boxes = ['[0 0 595 842]', '[0 0 842 595]', '[0 0 420 595]']
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', `<< /Type /Pages /Kids [${boxes.map((_, index) => `${3 + index * 2} 0 R`).join(' ')}] /Count ${boxes.length} >>`]
  boxes.forEach((box, index) => {
    const text = `BT /F1 24 Tf 40 60 Td (Seite ${index + 1}) Tj ET`
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox ${box} /Contents ${4 + index * 2} 0 R /Resources << /Font << /F1 ${3 + boxes.length * 2} 0 R >> >> >>`)
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
fs.writeFileSync(path.join(vault, 'Biologie', 'Blatt.pdf'), makePdf())
fs.writeFileSync(path.join(userData, 'config.json'), `${JSON.stringify({
  version: 3,
  vaultPath: vault,
  settings: { uiLanguage: 'de', autoCheckUpdates: false, autoDownloadUpdates: false, reduceMotion: true },
  onboarding: { version: 1, completed: true },
}, null, 2)}\n`, { mode: 0o600 })
const sideFile = path.join(vault, '.fanotes', 'pdf-side', 'Biologie', 'Blatt.pdf.famd')
const companion = path.join(vault, 'Biologie', 'Blatt.famd')

const results = []
const ok = (name, pass, detail = '') => {
  results.push(Boolean(pass))
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail !== '' ? ` -> ${String(detail).slice(0, 240)}` : ''}`)
}

const launch = () => {
  const port = 19_300 + Math.floor(Math.random() * 400)
  const child = spawn('xvfb-run', ['-a', '-s', '-screen 0 1440x1000x24', electron, root, `--remote-debugging-port=${port}`, '--no-sandbox'], {
    env: { ...process.env, HOME: home, XDG_CONFIG_HOME: configHome, XDG_RUNTIME_DIR: runtime },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  })
  let output = ''
  child.stdout.on('data', (chunk) => { output += chunk })
  child.stderr.on('data', (chunk) => { output += chunk })
  return { child, port, output: () => output }
}
const connect = async (app) => {
  let browser = null
  const deadline = Date.now() + 60_000
  while (!browser && Date.now() < deadline) {
    try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${app.port}`) } catch { await new Promise((resolve) => setTimeout(resolve, 250)) }
    if (app.child.exitCode !== null) throw new Error(`Electron exited: ${app.output().slice(-400)}`)
  }
  assert.ok(browser, 'Electron did not open a debugging port')
  let page = null
  for (let tries = 0; tries < 120 && !page; tries += 1) {
    page = browser.contexts().flatMap((context) => context.pages()).find((candidate) => !candidate.url().startsWith('devtools')) ?? null
    if (!page) await new Promise((resolve) => setTimeout(resolve, 250))
  }
  assert.ok(page, 'no renderer page')
  page.on('pageerror', (error) => console.log('pageerror', String(error).slice(0, 200)))
  await page.waitForFunction(() => Boolean(window.fanotes && document.querySelector('.file-tree__row')), null, { timeout: 60_000 })
  return { browser, page }
}
const stop = async (app, browser) => {
  await browser?.close().catch(() => {})
  try { process.kill(-app.child.pid, 'SIGTERM') } catch { /* gone */ }
  await new Promise((resolve) => setTimeout(resolve, 800))
}

const openBlatt = async (page) => {
  const row = page.locator('.file-tree__row', { hasText: 'Blatt' }).first()
  for (let attempt = 0; attempt < 3 && !(await row.isVisible().catch(() => false)); attempt += 1) {
    await page.locator('.file-tree__row[data-kind="folder"]', { hasText: 'Biologie' }).first().click()
    await row.waitFor({ state: 'visible', timeout: 4000 }).catch(() => {})
  }
  await row.click()
  await page.waitForFunction(() => [...document.querySelectorAll('[data-pdf-page="1"] canvas')].some((canvas) => canvas.width > 0), null, { timeout: 60_000 })
}

const sideInk = () => (fs.existsSync(sideFile) ? side.parsePdfSidePages(fs.readFileSync(sideFile, 'utf8')) : null)
const pdfInk = () => (fs.existsSync(companion) ? famdMain.parseFamd(fs.readFileSync(companion, 'utf8')).payload?.ink ?? null : null)

let app = launch()
let browser = null
try {
  let page
  ;({ browser, page } = await connect(app))
  const settle = (ms = 400) => page.waitForTimeout(ms)
  const openPdf = async () => {
    await openBlatt(page)
    await settle(1200)
  }
  const toggleButton = () => page.locator('.pdf-note-toolbar button[aria-label="Leere Seiten daneben"]')
  const boxes = () => page.evaluate(() => [...document.querySelectorAll('[data-pdf-page]')].map((node) => {
    const pdf = node.getBoundingClientRect()
    const blank = document.querySelector(`[data-pdf-side-page="${node.getAttribute('data-pdf-page')}"]`)?.getBoundingClientRect()
    return { pdf: { x: pdf.x, y: pdf.y, w: pdf.width, h: pdf.height }, side: blank ? { x: blank.x, y: blank.y, w: blank.width, h: blank.height } : null }
  }))
  const zoom = () => page.evaluate(() => Number(getComputedStyle(document.querySelector('.paper-sheet-plane')).zoom) || 1)
  const inkAlphaAt = ({ x, y }) => page.evaluate(([cx, cy]) => {
    let total = 0
    for (const canvas of document.querySelectorAll('.lw-drawing-board canvas')) {
      const rect = canvas.getBoundingClientRect()
      if (!rect.width || !rect.height || cx < rect.left || cx > rect.right || cy < rect.top || cy > rect.bottom) continue
      const context = canvas.getContext('2d', { willReadFrequently: true })
      if (!context) continue
      const px = Math.floor((cx - rect.left) * canvas.width / rect.width)
      const py = Math.floor((cy - rect.top) * canvas.height / rect.height)
      if (px < 0 || py < 0 || px >= canvas.width || py >= canvas.height) continue
      for (let dy = -2; dy <= 2; dy += 1) for (let dx = -2; dx <= 2; dx += 1) {
        if (px + dx < 0 || py + dy < 0 || px + dx >= canvas.width || py + dy >= canvas.height) continue
        total += context.getImageData(px + dx, py + dy, 1, 1).data[3]
      }
    }
    return total
  }, [x, y])
  const drag = async (from, to) => {
    await page.mouse.move(from.x, from.y)
    await page.mouse.down()
    for (let step = 1; step <= 12; step += 1) await page.mouse.move(from.x + (to.x - from.x) * step / 12, from.y + (to.y - from.y) * step / 12)
    await page.mouse.up()
    await settle(500)
  }
  const penOn = async () => {
    await page.locator('button[aria-label="Stift"]').first().click()
    await page.waitForSelector('.lw-drawing-board.is-input-active', { timeout: 20_000 }).catch(() => {})
    await settle(1000)
  }
  const keyboardOn = async () => {
    await page.locator('button[aria-label="Tastatur"], button[aria-label="Zur Tastatur wechseln"]').first().click().catch(() => {})
    await settle(800)
  }
  const waitFor = async (check, timeout = 8000) => {
    const deadline = Date.now() + timeout
    while (Date.now() < deadline) {
      if (check()) return true
      await settle(250)
    }
    return check()
  }
  // Scrolls page n's pair into view and returns a client point at (u, v) of its side page.
  const sidePoint = async (n, u, v) => {
    await page.evaluate((number) => document.querySelector(`[data-pdf-page="${number}"]`)?.scrollIntoView({ block: 'center' }), n)
    await settle(600)
    const box = await page.locator(`[data-pdf-side-page="${n}"]`).boundingBox()
    return { x: box.x + box.width * u, y: box.y + box.height * v }
  }
  const pdfPoint = async (n, u, v) => {
    await page.evaluate((number) => document.querySelector(`[data-pdf-page="${number}"]`)?.scrollIntoView({ block: 'center' }), n)
    await settle(600)
    const box = await page.locator(`[data-pdf-page="${n}"]`).boundingBox()
    return { x: box.x + box.width * u, y: box.y + box.height * v }
  }

  await openPdf()
  ok('the toggle sits in the PDF toolbar', await toggleButton().count() === 1)
  ok('the toggle starts off', await toggleButton().getAttribute('aria-pressed') === 'false')
  ok('no side pages before the toggle', (await page.locator('[data-pdf-side-page]').count()) === 0)

  // PDF ink written before the side pages exist.
  await penOn()
  const pdfA = await pdfPoint(1, 0.3, 0.4)
  const pdfB = await pdfPoint(1, 0.6, 0.4)
  await drag(pdfA, pdfB)
  ok('PDF ink is saved without side pages', await waitFor(() => (pdfInk()?.strokes?.length ?? 0) === 1, 10_000))
  const pdfBefore = pdfInk().strokes[0].points.map((point) => [point.x, point.y])
  await keyboardOn()

  // 1. Toggle on.
  await toggleButton().click()
  await page.waitForSelector('[data-pdf-side-page="3"]', { timeout: 20_000 })
  await settle(1200)
  ok('the toggle shows as pressed', await toggleButton().getAttribute('aria-pressed') === 'true')
  ok('one side page per PDF page', (await page.locator('[data-pdf-side-page]').count()) === 3)
  ok('the PDF ink is still painted on its PDF page', (await inkAlphaAt(await pdfPoint(1, 0.45, 0.4))) > 0)

  // 2. Every side page has its PDF page's box (mixed sizes), right of it, one gap apart.
  const checkBoxes = async (label) => {
    const list = await boxes()
    const gap = 16 * await zoom()
    const same = list.every(({ pdf, side: blank }) => blank
      && Math.abs(blank.w - pdf.w) < 1.5 && Math.abs(blank.h - pdf.h) < 1.5 && Math.abs(blank.y - pdf.y) < 1.5
      && Math.abs(blank.x - (pdf.x + pdf.w + gap)) < 2)
    ok(`${label}: side pages match their PDF pages`, same, JSON.stringify(list.map(({ pdf, side: blank }) => [Math.round(pdf.w), Math.round(pdf.h), Math.round(blank?.w ?? 0), Math.round(blank?.h ?? 0)])))
    return list
  }
  const upright = await checkBoxes('upright')
  ok('mixed sizes: the landscape page is wider than tall', upright[1].side.w > upright[1].side.h * 1.3)
  close(upright[2].side.h / upright[2].side.w, 595 / 420, 'A5 side page ratio', 0.01)

  // 3. Empty side pages cost nothing.
  await penOn()
  await settle(2500)
  ok('no file is written for empty side pages', !fs.existsSync(sideFile))

  // 4. Ink on side page 2 saves page-local and reopens at the same spot.
  const sideA = await sidePoint(2, 0.25, 0.5)
  const sideB = await sidePoint(2, 0.75, 0.5)
  await drag(sideA, sideB)
  ok('side ink is written to the side companion', await waitFor(() => (sideInk()?.ink.length ?? 0) === 1, 10_000))
  const entry = sideInk()?.ink[0]
  ok('the entry is page 2 with its PDF size', entry?.page === 2 && entry.width === 842 && entry.height === 595, JSON.stringify(entry && [entry.page, entry.width, entry.height]))
  const xs = entry?.ink.strokes[0].points.map((point) => point.x) ?? []
  const ys = entry?.ink.strokes[0].points.map((point) => point.y) ?? []
  ok('the side stroke is stored page-local where it was drawn', Math.abs(Math.min(...xs) - 0.25) < 0.02 && Math.abs(Math.max(...xs) - 0.75) < 0.02 && ys.every((y) => Math.abs(y - 0.5) < 0.02), JSON.stringify([Math.min(...xs), Math.max(...xs), ys[0]]))
  const pdfNow = pdfInk().strokes[0].points.map((point) => [point.x, point.y])
  ok('the PDF ink did not move', pdfNow.every(([x, y], index) => Math.abs(x - pdfBefore[index][0]) < 1e-6 && Math.abs(y - pdfBefore[index][1]) < 1e-6))
  ok('side ink is painted on the side page', (await inkAlphaAt(await sidePoint(2, 0.5, 0.5))) > 0)

  // Eraser and undo work on side pages like everywhere else.
  await page.keyboard.press('Control+z')
  await settle(900)
  ok('undo takes the side stroke off', (await inkAlphaAt(await sidePoint(2, 0.5, 0.5))) === 0)
  await page.keyboard.press('Control+y')
  await settle(900)
  ok('redo puts it back', (await inkAlphaAt(await sidePoint(2, 0.5, 0.5))) > 0)
  // Highlighter and eraser on another side page.
  const tool = async (name) => {
    await page.locator('.lw-draw-toolbar button', { hasText: name }).first().click().catch(() => {})
    await settle(300)
  }
  await tool('Zeichnen')
  await page.locator('button[aria-label="Textmarker"], button[title^="Textmarker"]').first().click().catch(() => {})
  await settle(300)
  await drag(await sidePoint(3, 0.2, 0.3), await sidePoint(3, 0.8, 0.3))
  ok('a highlighter stroke on side page 3 is saved', await waitFor(() => sideInk()?.ink.some((item) => item.page === 3), 10_000))
  ok('the highlighter stroke is painted', (await inkAlphaAt(await sidePoint(3, 0.5, 0.3))) > 0)
  await tool('Radierer')
  const eraseAt = await sidePoint(3, 0.5, 0.3)
  await drag({ x: eraseAt.x - 40, y: eraseAt.y - 30 }, { x: eraseAt.x + 40, y: eraseAt.y + 30 })
  ok('the eraser works on a side page', (await inkAlphaAt(eraseAt)) === 0)
  await tool('Schreiben')
  await page.keyboard.press('Control+z')
  await settle(900)
  ok('undo brings the erased part back', (await inkAlphaAt(eraseAt)) > 0)
  await page.keyboard.press('Control+y')
  await settle(900)
  await keyboardOn()

  // 5. Toggle off keeps everything; toggle on shows it again at the same spot.
  const entriesBefore = JSON.stringify(sideInk()?.ink.map((item) => [item.page, item.ink.strokes.length]))
  await toggleButton().click()
  await settle(1500)
  ok('toggle off hides the side pages', (await page.locator('[data-pdf-side-page]').count()) === 0 && await toggleButton().getAttribute('aria-pressed') === 'false')
  ok('toggle off deletes nothing', JSON.stringify(sideInk()?.ink.map((item) => [item.page, item.ink.strokes.length])) === entriesBefore, entriesBefore)
  ok('the PDF ink is back in place without side pages', (await inkAlphaAt(await pdfPoint(1, 0.45, 0.4))) > 0)
  const pdfOff = pdfInk().strokes[0].points.map((point) => [point.x, point.y])
  ok('the PDF ink file is unchanged after off', pdfOff.every(([x, y], index) => Math.abs(x - pdfBefore[index][0]) < 1e-6 && Math.abs(y - pdfBefore[index][1]) < 1e-6))
  await toggleButton().click()
  await page.waitForSelector('[data-pdf-side-page="3"]', { timeout: 20_000 })
  await settle(1500)
  ok('toggle on again shows the side ink at the same spot', (await inkAlphaAt(await sidePoint(2, 0.5, 0.5))) > 0)

  // 6. Rotation: the side pages follow the rotated PDF pages; the ink stays page-local.
  await page.locator('.pdf-note-toolbar button[aria-label="Seite drehen"]').click()
  await page.waitForSelector('[data-pdf-side-page="3"]', { timeout: 20_000 })
  await settle(1800)
  await checkBoxes('rotated')
  for (let turn = 0; turn < 3; turn += 1) {
    await page.locator('.pdf-note-toolbar button[aria-label="Seite drehen"]').click()
    await settle(1400)
  }
  await page.waitForSelector('[data-pdf-side-page="3"]', { timeout: 20_000 })
  await settle(1200)
  ok('after a full turn the side ink is where it was', (await inkAlphaAt(await sidePoint(2, 0.5, 0.5))) > 0)
  const afterTurn = sideInk()?.ink[0]?.ink.strokes[0]?.points ?? []
  ok('rotating does not move the stored side ink', afterTurn.length > 0 && Math.abs(afterTurn[0].x - xs[0]) < 1e-6 && Math.abs(afterTurn[0].y - ys[0]) < 1e-6)

  // Renaming and moving the PDF note takes its side pages along.
  {
    const renamed = await page.evaluate(() => window.fanotes.renameEntry('Biologie/Blatt.pdf', 'Arbeitsblatt.pdf'))
    const movedSide = path.join(vault, '.fanotes', 'pdf-side', 'Biologie', 'Arbeitsblatt.pdf.famd')
    ok('rename moves the side pages', renamed === 'Biologie/Arbeitsblatt.pdf' && fs.existsSync(movedSide) && !fs.existsSync(sideFile))
    await page.evaluate(() => window.fanotes.renameEntry('Biologie', 'Bio'))
    ok('a renamed folder takes its side pages along', fs.existsSync(path.join(vault, '.fanotes', 'pdf-side', 'Bio', 'Arbeitsblatt.pdf.famd')))
    await page.evaluate(() => window.fanotes.renameEntry('Bio', 'Biologie'))
    await page.evaluate(() => window.fanotes.renameEntry('Biologie/Arbeitsblatt.pdf', 'Blatt.pdf'))
    ok('renaming back restores the original path', fs.existsSync(sideFile))
    await page.evaluate(() => window.fanotes.getTree())
    await settle(1200)
  }

  // 7. The toggle is remembered per PDF note: quit the app the normal way and start it again.
  await page.evaluate(() => { void window.fanotes.requestClose?.() }).catch(() => {})
  for (let tries = 0; tries < 60 && app.child.exitCode === null; tries += 1) await new Promise((resolve) => setTimeout(resolve, 250))
  await stop(app, browser)
  app = launch()
  ;({ browser, page } = await connect(app))
  {
    await page.waitForTimeout(1500)
    await openBlatt(page)
    await page.waitForSelector('[data-pdf-side-page="2"]', { timeout: 20_000 })
    await page.waitForTimeout(2000)
    ok('the toggle is remembered after a restart', await page.locator('.pdf-note-toolbar button[aria-label="Leere Seiten daneben"]').getAttribute('aria-pressed') === 'true')
    await page.evaluate(() => document.querySelector('[data-pdf-page="2"]')?.scrollIntoView({ block: 'center' }))
    await page.waitForTimeout(1200)
    const box = await page.locator('[data-pdf-side-page="2"]').boundingBox()
    const alpha = await page.evaluate(([cx, cy]) => {
      let total = 0
      for (const canvas of document.querySelectorAll('.lw-drawing-board canvas')) {
        const rect = canvas.getBoundingClientRect()
        if (!rect.width || cx < rect.left || cx > rect.right || cy < rect.top || cy > rect.bottom) continue
        const context = canvas.getContext('2d', { willReadFrequently: true })
        const px = Math.floor((cx - rect.left) * canvas.width / rect.width)
        const py = Math.floor((cy - rect.top) * canvas.height / rect.height)
        for (let dy = -2; dy <= 2; dy += 1) for (let dx = -2; dx <= 2; dx += 1) total += context?.getImageData(px + dx, py + dy, 1, 1).data[3] ?? 0
      }
      return total
    }, [box.x + box.width * 0.5, box.y + box.height * 0.5])
    ok('after a restart the side ink is painted on its side page', alpha > 0)
    // The command palette has the entry too.
    await page.keyboard.press('Control+p')
    await page.waitForTimeout(500)
    await page.keyboard.type('Leere Seiten')
    await page.waitForTimeout(500)
    const entry = page.getByText('Leere Seiten daneben ausblenden').first()
    ok('the command palette lists the toggle', (await entry.count()) > 0)
    if (await entry.count()) {
      await entry.click()
      await page.waitForTimeout(1500)
      ok('the palette entry turns the side pages off', (await page.locator('[data-pdf-side-page]').count()) === 0)
    }
  }
} catch (error) {
  console.log('ERROR', error instanceof Error ? error.message.slice(0, 500) : error)
  results.push(false)
} finally {
  await stop(app, browser)
  fs.rmSync(temporary, { recursive: true, force: true })
}
const failed = results.filter((result) => !result).length
console.log(failed ? `pdf side pages: ${failed} desktop check(s) failed` : `pdf side pages: all ${results.length} desktop checks passed`)
process.exit(failed ? 1 : 0)
