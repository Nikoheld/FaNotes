// Text boxes ("Textfeld einfügen") on a handwriting note (.famd) in the
// desktop app: dragging a box never selects text underneath, and a box stays
// exactly where the owner left it.
//
// Bug 1: dragging a box across the typed text or the ink started a text
// selection in the editor under it. Bug 2: boxes drifted away from the text
// they were placed next to (window width, zoom, note switches, page growth,
// restart). The boxes are stored as fractions of the painted sheet, so every
// change of the sheet's size must be absorbed by the remap that follows it.
//
// Drives the real app (Electron under Xvfb) over CDP with a synthetic vault.
// Needs a built renderer (`vite build`), xvfb-run and playwright-core
// (PLAYWRIGHT_CORE); FANOTES_SKIP_BROWSER=1 skips it.
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const { serializeFamd, emptyFamdPayload, parseFamd } = require('../electron/famd.cjs')

const executable = path.join(root, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron')
const xvfb = spawnSync('sh', ['-c', 'command -v xvfb-run'], { encoding: 'utf8' }).stdout.trim()
let playwright = null
if (process.env.FANOTES_SKIP_BROWSER !== '1') {
  try { playwright = await import(process.env.PLAYWRIGHT_CORE || 'playwright-core') } catch { playwright = null }
}
const missing = process.env.FANOTES_SKIP_BROWSER === '1' ? 'FANOTES_SKIP_BROWSER=1'
  : !xvfb ? 'no xvfb-run'
    : !fs.existsSync(path.join(root, 'dist', 'index.html')) ? 'no dist/ (run vite build)'
      : !fs.existsSync(executable) ? 'no electron'
        : !playwright ? 'no playwright-core (set PLAYWRIGHT_CORE)' : ''
if (missing) {
  console.log(`text field position: skipped (${missing})`)
  process.exit(0)
}

const temporary = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'fanotes-tf-pos-'))
const home = path.join(temporary, 'home')
const configHome = path.join(temporary, 'config')
const runtime = path.join(temporary, 'runtime')
const vault = path.join(home, 'Notizen')
const userData = path.join(configHome, 'FaNotes')
for (const directory of [home, configHome, runtime, vault, userData]) fs.mkdirSync(directory, { recursive: true, mode: 0o700 })

const at = '2026-11-01T00:00:00.000Z'
const paragraph = (n) => `Absatz ${n}: Der schnelle braune Fuchs springt über den faulen Hund.`
const ink = (page) => ({
  schemaVersion: 1, title: 'Seite', paperStyle: 'lines', sourceWidth: 900, sourceHeight: 1273, createdAt: at, updatedAt: at, ...page,
  strokes: Array.from({ length: 12 }, (_, i) => ({
    color: '#202333', baseWidth: 3, pressureEnabled: true, brush: 'fineliner',
    points: Array.from({ length: 40 }, (_, k) => ({ x: 0.6 + (k / 40) * 0.25, y: 0.1 + i * 0.035 + Math.sin(k / 3) * 0.004, t: k * 8, pressure: 0.5, tiltX: 0, tiltY: 0, pointerType: 'pen' })),
  })),
})
// Boxes sit on top of typed lines and of the ink.
const boxes = (name) => [
  { id: `tf-${name}-1`, page: 1, x: 0.1, y: 0.09, width: 0.4, fontSize: 18, text: 'Erstes Textfeld über dem Text' },
  { id: `tf-${name}-2`, page: 1, x: 0.62, y: 0.16, width: 0.25, fontSize: 16, text: 'Zweites über der Tinte' },
  { id: `tf-${name}-3`, page: 1, x: 0.2, y: 0.34, width: 0.3, fontSize: 16, text: 'Drittes weiter unten' },
]
const notes = {
  // A handwriting page: the ink page is taller than the typed text.
  Notiz: { style: 'lines', body: `# Notiz\n\n${Array.from({ length: 8 }, (_, i) => paragraph(i + 1)).join('\n\n')}\n`, ink: ink({}) },
  // Typed text taller than the ink page: the sheet's height follows the text.
  Lang: { style: 'lines', body: `# Lang\n\n${Array.from({ length: 40 }, (_, i) => paragraph(i + 1)).join('\n\n')}\n`, ink: ink({}) },
  Zwei: { style: 'squares', body: `# Zwei\n\n${Array.from({ length: 10 }, (_, i) => paragraph(i + 1)).join('\n\n')}\n`, ink: ink({}) },
}
fs.writeFileSync(path.join(vault, 'Anfang.md'), '# Anfang\n\nDie Notiz, die beim Start offen ist.\n')
for (const [name, note] of Object.entries(notes)) {
  fs.writeFileSync(path.join(vault, `${name}.famd`), serializeFamd(note.body, { ...emptyFamdPayload(at), ink: note.ink, paperStyle: note.style, textFields: boxes(name) }))
}
fs.writeFileSync(path.join(userData, 'config.json'), `${JSON.stringify({
  version: 3,
  vaultPath: vault,
  settings: { uiLanguage: 'de', autoCheckUpdates: false, autoDownloadUpdates: false, diagnosticsEnabled: false },
  onboarding: { version: 1, completed: true },
}, null, 2)}\n`, { mode: 0o600 })

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
let child = null
let browser = null
let page = null
let output = ''
const pageErrors = []

const launch = async () => {
  const port = 19_300 + Math.floor(Math.random() * 600)
  output = ''
  child = spawn(xvfb, ['-a', '-s', '-screen 0 1440x900x24', executable, root, `--remote-debugging-port=${port}`, '--no-sandbox'], {
    env: { ...process.env, HOME: home, XDG_CONFIG_HOME: configHome, XDG_RUNTIME_DIR: runtime },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  })
  child.stdout.on('data', (chunk) => { output += chunk })
  child.stderr.on('data', (chunk) => { output += chunk })
  browser = null
  for (let tries = 0; tries < 240 && !browser; tries += 1) {
    try { browser = await playwright.chromium.connectOverCDP(`http://127.0.0.1:${port}`) } catch { await sleep(250) }
    if (child.exitCode !== null) throw new Error(`Electron exited (${child.exitCode}): ${output.slice(-600)}`)
  }
  assert.ok(browser, 'Electron did not open a debugging port')
  page = null
  for (let tries = 0; tries < 120 && !page; tries += 1) {
    page = browser.contexts().flatMap((context) => context.pages()).find((candidate) => !candidate.url().startsWith('devtools')) ?? null
    if (!page) await sleep(250)
  }
  assert.ok(page, 'no renderer page')
  page.on('pageerror', (error) => pageErrors.push(String(error)))
  await page.waitForFunction(() => Boolean(window.fanotes && document.querySelector('.file-tree__row')), null, { timeout: 90_000 })
  await sleep(1200)
  await page.locator('button', { hasText: /^OK$/ }).first().click({ timeout: 2000 }).catch(() => {})
}
const quit = async () => {
  try { await browser?.close() } catch {}
  try { process.kill(-child.pid, 'SIGTERM') } catch {}
  await sleep(1500)
}

const openNote = async (name) => {
  await page.locator(`.file-tree__entry-button[data-path="${name}.famd"]`).first().click()
  await page.locator('.cm-content', { hasText: 'Absatz' }).waitFor({ timeout: 30_000 })
  await page.waitForFunction(() => document.querySelectorAll('.note-text-field').length >= 3 && [...document.querySelectorAll('.note-text-field')].every((f) => getComputedStyle(f).opacity !== '0'), null, { timeout: 30_000 })
  await sleep(1200)
}

// Runs in the page: where each box is, relative to the typed line next to it and to the sheet's top-left (page px, zoom removed).
const snapshot = (anchors = {}) => page.evaluate((anchors) => {
  const view = document.querySelector('.paper-view')
  const sheet = view.querySelector('.unified-paper')
  const content = view.querySelector('.cm-content')
  const sheetRect = sheet.getBoundingClientRect()
  const zoom = sheetRect.width / sheet.offsetWidth
  const lines = [...content.querySelectorAll('.cm-line')].map((line) => ({ key: line.textContent.slice(0, 12), rect: line.getBoundingClientRect() })).filter((line) => line.key.trim())
  const fields = [...view.querySelectorAll('.note-text-field')].map((field) => {
    const rect = field.getBoundingClientRect()
    const id = field.querySelector('[data-note-text-field]').getAttribute('data-note-text-field')
    let best = null
    if (anchors[id]) best = lines.find((line) => line.key === anchors[id]) ?? null
    else for (const line of lines) if (!best || Math.abs(line.rect.top - rect.top) < Math.abs(best.rect.top - rect.top)) best = line
    return {
      id,
      line: best ? { key: best.key, dy: (rect.top - best.rect.top) / zoom, dx: (rect.left - best.rect.left) / zoom } : null,
      page: { dx: (rect.left - sheetRect.left) / zoom, dy: (rect.top - sheetRect.top) / zoom },
      width: rect.width / zoom,
    }
  })
  return { zoom, sheet: [sheetRect.left, sheetRect.top, sheetRect.width, sheetRect.height], fields }
}, anchors)

const anchorsOf = (snap) => Object.fromEntries(snap.fields.map((field) => [field.id, field.line?.key]))
// Every box is where it was: by default next to the same typed line; `by: 'page'` keeps it at the same distance from the sheet's corner (ink does).
const expectStay = async (label, base, by = 'page') => {
  const now = await snapshot(anchorsOf(base))
  const rows = now.fields.flatMap((field) => {
    const was = base.fields.find((item) => item.id === field.id)
    assert.ok(was, `${label}: box ${field.id} is shown`)
    // Typed lines that are off screen have estimated heights: only lines that were drawn in both frames anchor a box.
    if (by === 'line' && !(field.line && was.line)) return []
    const [a, b] = by === 'line' ? [field.line, was.line] : [field.page, was.page]
    return [{ id: field.id.slice(-1), dx: a.dx - b.dx, dy: a.dy - b.dy }]
  })
  assert.ok(rows.length >= (by === 'line' ? 2 : 3), `${label}: boxes could be compared (${rows.length})`)
  console.log(`  ${label} (${by}): ${rows.map((row) => `${row.id}: ${row.dx.toFixed(1)},${row.dy.toFixed(1)}`).join(' | ')}`)
  for (const row of rows) {
    assert.ok(Math.abs(row.dx) <= 1 && Math.abs(row.dy) <= 1, `${label}: box ${row.id} moved by ${row.dx.toFixed(1)}, ${row.dy.toFixed(1)} px (${by})`)
  }
  return now
}
const storedFields = (name) => parseFamd(fs.readFileSync(path.join(vault, `${name}.famd`), 'utf8')).payload?.textFields ?? []

let failure = null
const touchPoint = (cdp, type, x, y) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y, id: 1 }] })
try {
  await launch()
  await page.locator('.file-tree__entry-button[data-path="Anfang.md"]').first().click()
  await page.locator('.cm-content', { hasText: 'beim Start offen' }).waitFor({ timeout: 30_000 })
  await openNote('Notiz')
  const base = await snapshot()
  const anchors = anchorsOf(base)
  const cdp = await page.context().newCDPSession(page)
  const selection = () => page.evaluate(() => ({ text: String(window.getSelection()), cm: document.querySelectorAll('.cm-selectionBackground').length }))
  const noSelection = async (label) => {
    const state = await selection()
    assert.deepEqual(state, { text: '', cm: 0 }, `${label}: nothing under the box is selected`)
  }
  const centred = async (index) => {
    const field = page.locator('.note-text-field').nth(index)
    await field.evaluate((node) => node.scrollIntoView({ block: 'center', inline: 'nearest' }))
    await sleep(400)
    await field.hover()
    await sleep(250)
    return field
  }
  const centre = (box) => ({ x: box.x + box.width / 2, y: box.y + box.height / 2 })

  // Bug 1: moving or resizing a box across typed text never selects it (mouse, touch, pen), and the box lands where it was dropped.
  for (const kind of ['mouse', 'touch', 'pen']) {
    for (const handle of ['move', 'resize']) {
      const field = await centred(2)
      const before = await field.boundingBox()
      const grip = centre(await field.locator(`.note-text-field-${handle}`).boundingBox())
      // Across the typed lines: down and left (move) or right (resize).
      const dx = handle === 'move' ? (kind === 'touch' ? 50 : -50) : (kind === 'touch' ? -30 : 30)
      // Moves end in the edge zone of the note view (bottom, or top for touch), where the editor used to autoscroll and extend a selection.
      const view = await page.locator('.unified-note-view').boundingBox()
      const dy = handle === 'move' ? (kind === 'touch' ? view.y + 24 : view.y + view.height - 24) - grip.y : 0
      const steps = 16
      const at = (i) => ({ x: grip.x + (dx * i) / steps, y: grip.y + (dy * i) / steps })
      if (kind === 'touch') {
        await touchPoint(cdp, 'touchStart', grip.x, grip.y)
        for (let i = 1; i <= steps; i += 1) { await touchPoint(cdp, 'touchMove', at(i).x, at(i).y); await sleep(15) }
        await sleep(500)
        await noSelection(`${kind} ${handle} during`)
        await touchPoint(cdp, 'touchEnd')
      } else {
        const send = (type, point, extra = {}) => cdp.send('Input.dispatchMouseEvent', { type, x: point.x, y: point.y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1, ...(kind === 'pen' ? { pointerType: 'pen' } : {}), ...extra })
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: grip.x, y: grip.y, ...(kind === 'pen' ? { pointerType: 'pen' } : {}) })
        await send('mousePressed', grip)
        for (let i = 1; i <= steps; i += 1) { await send('mouseMoved', at(i)); await sleep(15) }
        await sleep(500)
        await noSelection(`${kind} ${handle} during`)
        await send('mouseReleased', at(steps))
      }
      await sleep(400)
      await noSelection(`${kind} ${handle} after`)
      const after = await field.boundingBox()
      if (handle === 'move') assert.ok(Math.abs(after.x - (before.x + dx)) <= 2 && Math.abs(after.y - (before.y + dy)) <= 2, `${kind} move: the box follows the pointer (${before.x},${before.y} -> ${after.x},${after.y})`)
      else assert.ok(Math.abs(after.width - before.width - dx) <= 3, `${kind} resize: the box got wider (${before.width} -> ${after.width})`)
      console.log(`ok ${kind} ${handle}: nothing selected, box ${handle === 'move' ? 'moved' : 'resized'}`)
    }
  }
  await sleep(1500)
  assert.equal(storedFields('Notiz').length, 3, 'three boxes are stored')
  const dragged = await snapshot(anchors)

  // Bug 2: the box stays where it was left.
  await openNote('Zwei')
  await openNote('Notiz')
  await expectStay('switch notes and back', dragged)
  for (const width of [940, 1440]) {
    await page.evaluate((w) => window.resizeTo(w, 800), width)
    await sleep(1000)
    await expectStay(`window ${width} wide`, dragged)
  }
  await page.locator('button[aria-label="Hineinzoomen"]').first().click()
  await sleep(500)
  await page.locator('button[aria-label="Hineinzoomen"]').first().click()
  await sleep(800)
  await expectStay('zoom in', dragged)
  for (let i = 0; i < 3; i += 1) await page.locator('button[aria-label="Herauszoomen"]').first().click()
  await sleep(800)
  await expectStay('zoom out', dragged)
  await page.locator('button[aria-label="Hineinzoomen"]').first().click()
  await sleep(800)
  await expectStay('zoom back', dragged)

  // Writing at the top-left edge grows the page there (origin pad); typed text, ink and boxes shift together.
  await page.evaluate(() => { document.querySelector('.unified-note-view').scrollTop = 0 })
  await sleep(500)
  const nearLines = await snapshot(anchors)
  await page.keyboard.press('Control+d')
  await sleep(800)
  const sheet = (await snapshot()).sheet
  const pen = async (points) => {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: points[0][0], y: points[0][1], pointerType: 'pen' })
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: points[0][0], y: points[0][1], button: 'left', buttons: 1, clickCount: 1, pointerType: 'pen' })
    for (const [x, y] of points.slice(1)) { await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'left', buttons: 1, pointerType: 'pen' }); await sleep(20) }
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: points.at(-1)[0], y: points.at(-1)[1], button: 'left', buttons: 0, clickCount: 1, pointerType: 'pen' })
  }
  await pen([[sheet[0] + 4, sheet[1] + 5], [sheet[0] + 30, sheet[1] + 8], [sheet[0] + 60, sheet[1] + 4]])
  await sleep(1500)
  const grown = await snapshot(anchors)
  console.log('  sheet before/after the edge stroke', JSON.stringify(nearLines.sheet.map(Math.round)), JSON.stringify(grown.sheet.map(Math.round)))
  await expectStay('page grown at the top-left edge', nearLines, 'line')
  await page.keyboard.press('Control+d')
  await sleep(1000)
  const written = await snapshot(anchors)

  // The same after closing and starting the app again.
  await sleep(1500)
  await quit()
  await launch()
  await openNote('Notiz')
  await expectStay('after a restart', written, 'line')
  await expectStay('after a restart (page)', written)
  await openNote('Zwei')
  await openNote('Notiz')
  await expectStay('after a restart, switched', written)

  // A note whose sheet is as tall as its text: typing changes the sheet's height, the boxes keep their place on the page.
  await openNote('Lang')
  const lang = await snapshot()
  await page.locator('.cm-line', { hasText: 'Absatz 20:' }).first().click({ position: { x: 4, y: 6 } })
  await page.keyboard.press('Control+Home')
  for (let i = 0; i < 6; i += 1) { await page.keyboard.type(`Neue Zeile ${i}`); await page.keyboard.press('Enter'); await page.keyboard.press('Enter') }
  await sleep(1500)
  await expectStay('typing above the boxes', lang)
  await page.keyboard.press('Control+End')
  for (let i = 0; i < 6; i += 1) { await page.keyboard.press('Enter'); await page.keyboard.type(`Ende ${i}`) }
  await sleep(1500)
  await expectStay('typing below the boxes', lang)
  assert.deepEqual(pageErrors, [], 'no page errors')
  console.log('text field position: ok')
} catch (error) {
  failure = error
}
await quit()
fs.rmSync(temporary, { recursive: true, force: true })
if (failure) { console.error(failure instanceof Error ? failure.stack : failure); process.exit(1) }
process.exit(0)
