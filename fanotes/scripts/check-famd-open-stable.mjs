// Opening a handwriting note (.famd: typed Markdown, ink, text boxes) in the
// desktop app: the first painted frame already has the final layout.
//
// Before: the note's text showed for a few frames on a sheet without its
// saved page (a packed page hydrates its strokes over several frames, and the
// page box - size and origin pad - came with the last chunk), so the typed
// text slid by the origin pad and the text boxes jumped down when it landed.
// The boxes came from a second file read a frame or two later, laid out on
// that short sheet, and the first layout pass of the ink board remapped them
// against the wrong page and saved that: every open pulled them left and
// narrowed them (their text rewrapped). The open camera was measured on the
// previous note's sheet, so a short note opened scrolled to its empty bottom.
//
// Drives the real app (Electron under Xvfb) over CDP. Every frame is sampled
// right before paint (a ResizeObserver made after the app's own observers),
// from the click until 1.2 s later. Asserts for each open, cold and warm, from
// the tree and from a tab: the first frame that shows the note is its settled
// layout (top text line, text boxes, sheet, scroll), the boxes sit at their
// stored page fractions, text is on screen, and no stored box moved. Prints the
// time from click to first frame. Needs a built renderer (`vite build`),
// xvfb-run and playwright-core (PLAYWRIGHT_CORE); FANOTES_SKIP_BROWSER=1 skips it.
// Synthetic vault only.
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
  console.log(`famd open stable: skipped (${missing})`)
  process.exit(0)
}

const temporary = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'fanotes-famd-open-'))
const home = path.join(temporary, 'home')
const configHome = path.join(temporary, 'config')
const runtime = path.join(temporary, 'runtime')
const vault = path.join(home, 'Notizen')
const userData = path.join(configHome, 'FaNotes')
for (const directory of [home, configHome, runtime, vault, userData]) fs.mkdirSync(directory, { recursive: true, mode: 0o700 })

const at = '2026-11-01T00:00:00.000Z'
const paragraph = (n) => `Absatz ${n}: Der schnelle braune Fuchs springt über den faulen Hund und läuft weiter über die ganze Seite.`
// Strokes in the right half of the page; above 8,000 points the page opens packed and hydrates over several frames.
const ink = (strokes, pointsPerStroke, page) => ({
  schemaVersion: 1, title: 'Seite', paperStyle: 'lines', sourceWidth: 900, sourceHeight: 1273, createdAt: at, updatedAt: at, ...page,
  strokes: Array.from({ length: strokes }, (_, i) => ({
    color: '#202333', baseWidth: 3, pressureEnabled: true, brush: 'fineliner',
    points: Array.from({ length: pointsPerStroke }, (_, k) => ({ x: 0.56 + (k / pointsPerStroke) * 0.3, y: 0.06 + (i / strokes) * 0.55 + Math.sin(k / 3) * 0.004, t: k * 8, pressure: 0.5, tiltX: 0, tiltY: 0, pointerType: 'pen' })),
  })),
})
const boxes = (name) => [
  { id: `tf-${name}-1`, page: 1, x: 0.12, y: 0.62, width: 0.42, fontSize: 18, text: `Textfeld ${name}: getippter Text auf der Handschriftseite, der umbricht.` },
  { id: `tf-${name}-2`, page: 1, x: 0.55, y: 0.3, width: 0.3, fontSize: 16, text: 'Kurz **fett** und mehr' },
]
const notes = {
  // Page grown at the top and left (origin pad) and wider than the sheet; packed ink.
  Gewachsen: { style: 'lines', body: `# Gewachsen\n\n${[1, 2, 3, 4, 5].map(paragraph).join('\n\n')}\n`, ink: ink(160, 80, { sourceOriginX: 108, sourceOriginY: 144, sourceWidth: 1224, sourceHeight: 1561 }) },
  // An A4 page as Android saves it (900 wide) opened in a wider pane.
  Kurz: { style: 'squares', body: `# Kurz\n\n${[1, 2].map(paragraph).join('\n\n')}\n`, ink: ink(40, 30, {}) },
  // Long typed text on a tall packed page.
  Lang: { style: 'grid', body: `# Lang\n\n${Array.from({ length: 120 }, (_, i) => paragraph(i)).join('\n\n')}\n`, ink: ink(200, 60, { sourceHeight: 9000 }) },
}
// The app opens a note at start; a plain one, so every check below is a real switch.
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

const port = 19_300 + Math.floor(Math.random() * 600)
const child = spawn(xvfb, ['-a', '-s', '-screen 0 1440x900x24', executable, root, `--remote-debugging-port=${port}`, '--no-sandbox'], {
  env: { ...process.env, HOME: home, XDG_CONFIG_HOME: configHome, XDG_RUNTIME_DIR: runtime },
  stdio: ['ignore', 'pipe', 'pipe'],
  detached: true,
})
let output = ''
child.stdout.on('data', (chunk) => { output += chunk })
child.stderr.on('data', (chunk) => { output += chunk })
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// Runs in the page: one sample per frame, taken right before paint.
const installSampler = () => {
  if (window.__famdOpenLog) return
  const log = []
  window.__famdOpenLog = log
  const probe = document.createElement('div')
  probe.style.cssText = 'position:fixed;left:0;top:0;width:1px;height:1px;opacity:0;pointer-events:none'
  document.documentElement.appendChild(probe)
  const round = (value) => Math.round(value * 10) / 10
  const box = (element) => { const rect = element.getBoundingClientRect(); return [round(rect.left), round(rect.top), round(rect.width), round(rect.height)] }
  const sample = () => {
    const view = document.querySelector('.paper-view')
    const content = view?.querySelector('.cm-content')
    const sheet = view?.querySelector('.unified-paper')
    if (!view || !content || !sheet) { log.push({ t: performance.now(), note: null }); return }
    let hidden = Boolean(view.dataset.cameraRestoring)
    for (let element = content; element && !hidden; element = element.parentElement) {
      const style = getComputedStyle(element)
      if (style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity) < 0.01) hidden = true
    }
    const viewport = view.getBoundingClientRect()
    let top = null
    for (const line of content.querySelectorAll('.cm-line')) {
      const rect = line.getBoundingClientRect()
      if (rect.bottom > viewport.top + 4 && rect.top < viewport.bottom && rect.height > 0 && line.textContent.trim()) {
        top = { text: line.textContent.slice(0, 16), box: box(line), font: getComputedStyle(line).fontSize }
        break
      }
    }
    const heading = content.querySelector('.cm-line')?.textContent.replace(/^#\s*/u, '').trim() ?? null
    log.push({
      t: performance.now(),
      note: heading,
      hidden,
      top,
      sheet: box(sheet),
      scroll: [Math.round(view.scrollLeft), Math.round(view.scrollTop)],
      viewport: box(view),
      fields: [...view.querySelectorAll('.note-text-field')].map((field) => ({ box: box(field), shown: getComputedStyle(field).opacity !== '0' })),
    })
  }
  const tick = () => {
    const observer = new ResizeObserver(() => { observer.disconnect(); sample() })
    observer.observe(probe)
    requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
}

const same = (a, b, tolerance = 1) => (
  Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((value, index) => Math.abs(value - b[index]) <= tolerance)
)
const describe = (entry) => JSON.stringify({ t: Math.round(entry.t), top: entry.top, sheet: entry.sheet, scroll: entry.scroll, fields: entry.fields.map((field) => field.box) })

let browser
let failure = null
const openTimes = []
try {
  for (let tries = 0; tries < 240 && !browser; tries += 1) {
    try { browser = await playwright.chromium.connectOverCDP(`http://127.0.0.1:${port}`) } catch { await sleep(250) }
    if (child.exitCode !== null) throw new Error(`Electron exited (${child.exitCode}): ${output.slice(-600)}`)
  }
  assert.ok(browser, 'Electron did not open a debugging port')
  let page = null
  for (let tries = 0; tries < 120 && !page; tries += 1) {
    page = browser.contexts().flatMap((context) => context.pages()).find((candidate) => !candidate.url().startsWith('devtools')) ?? null
    if (!page) await sleep(250)
  }
  assert.ok(page, 'no renderer page')
  const pageErrors = []
  page.on('pageerror', (error) => pageErrors.push(String(error)))
  await page.waitForFunction(() => Boolean(window.fanotes && document.querySelector('.file-tree__row')), null, { timeout: 90_000 })
  await sleep(1500)
  await page.locator('.file-tree__entry-button[data-path="Anfang.md"]').first().click()
  await page.locator('.cm-content', { hasText: 'beim Start offen' }).waitFor({ timeout: 30_000 })
  await sleep(800)
  await page.evaluate(installSampler)

  const check = async (label, name, click) => {
    await page.evaluate(() => { window.__famdOpenLog.length = 0 })
    const clickedAt = await page.evaluate(() => performance.now())
    await click()
    await sleep(1200)
    const log = (await page.evaluate(() => window.__famdOpenLog)).filter((entry) => entry.t >= clickedAt)
    const own = log.filter((entry) => entry.note === name && !entry.hidden && entry.top)
    assert.ok(own.length > 5, `${label}: the note was shown (${log.length} frames; last ${JSON.stringify(log.at(-1)).slice(0, 400)})`)
    if (process.env.FAMD_OPEN_DUMP) {
      let previous = ''
      for (const entry of log) {
        const line = JSON.stringify([entry.note, entry.hidden, entry.top?.box, entry.sheet, entry.scroll])
        if (line !== previous) console.log(`  ${Math.round(entry.t - clickedAt)} ${line}`)
        previous = line
      }
    }
    const first = own[0]
    const settled = own.at(-1)
    openTimes.push(first.t - clickedAt)
    // The first frame of the note is its settled layout.
    for (const entry of own) {
      const where = `${label}: frame at ${Math.round(entry.t - clickedAt)} ms differs from the settled one\n  frame   ${describe(entry)}\n  settled ${describe(settled)}`
      // The typed text stays where it first showed on screen.
      assert.equal(entry.top.text, settled.top.text, where)
      assert.equal(entry.top.font, settled.top.font, where)
      assert.ok(same(entry.top.box, settled.top.box), where)
      // The sheet has its page from the first frame; the text boxes sit on it.
      // (A long note opened in its middle may slide the sheet under the text
      // once the editor has measured the lines above; the text holds still.)
      assert.ok(same(entry.sheet.slice(2), settled.sheet.slice(2)), where)
      assert.equal(entry.sheet[0], settled.sheet[0], where)
      assert.equal(entry.fields.length, settled.fields.length, where)
      const onSheet = (fieldBox, sheet) => [fieldBox[0] - sheet[0], fieldBox[1] - sheet[1], fieldBox[2], fieldBox[3]]
      entry.fields.forEach((field, index) => assert.ok(field.shown && same(onSheet(field.box, entry.sheet), onSheet(settled.fields[index].box, settled.sheet)), where))
    }
    // Settled: text on screen, boxes at their stored page fractions.
    const [, , viewWidth, viewHeight] = settled.viewport
    assert.ok(settled.top.box[1] < settled.viewport[1] + viewHeight - 20 && settled.top.box[0] < settled.viewport[0] + viewWidth - 40, `${label}: typed text is on screen`)
    assert.equal(settled.fields.length, 2, `${label}: both text boxes are shown`)
    boxes(name).forEach((stored, index) => {
      const [left, top, width] = settled.fields[index].box
      const [sheetLeft, sheetTop, sheetWidth, sheetHeight] = settled.sheet
      assert.ok(Math.abs(left - sheetLeft - stored.x * sheetWidth) <= 2, `${label}: box ${index + 1} left ${left - sheetLeft} vs ${stored.x * sheetWidth}`)
      assert.ok(Math.abs(top - sheetTop - stored.y * sheetHeight) <= 2, `${label}: box ${index + 1} top ${top - sheetTop} vs ${stored.y * sheetHeight}`)
      assert.ok(Math.abs(width - Math.max(96, stored.width * sheetWidth)) <= 2, `${label}: box ${index + 1} width ${width} vs ${stored.width * sheetWidth}`)
    })
    console.log(`ok ${label}: first frame at ${Math.round(first.t - clickedAt)} ms is the settled layout (${own.length} frames)`)
  }
  const fromTree = (name) => () => page.locator(`.file-tree__entry-button[data-path="${name}.famd"]`).first().click()
  const fromTab = (name) => () => page.locator('.note-tab', { hasText: name }).first().click()
  await check('cold Gewachsen (tree)', 'Gewachsen', fromTree('Gewachsen'))
  await check('cold Kurz (tree)', 'Kurz', fromTree('Kurz'))
  await check('cold Lang (tree)', 'Lang', fromTree('Lang'))
  await check('warm Kurz after Lang (tab)', 'Kurz', fromTab('Kurz'))
  await check('warm Gewachsen (tab)', 'Gewachsen', fromTab('Gewachsen'))
  await check('warm Lang (tab)', 'Lang', fromTab('Lang'))
  await check('warm Gewachsen (tree)', 'Gewachsen', fromTree('Gewachsen'))
  assert.deepEqual(pageErrors, [], 'no page errors')
  await sleep(2500)
  // Opening is not an edit: no stored text box moved.
  for (const name of Object.keys(notes)) {
    const stored = parseFamd(fs.readFileSync(path.join(vault, `${name}.famd`), 'utf8')).payload?.textFields ?? []
    boxes(name).forEach((expected, index) => {
      const field = stored[index]
      assert.ok(field && Math.abs(field.x - expected.x) < 1e-6 && Math.abs(field.y - expected.y) < 1e-6 && Math.abs(field.width - expected.width) < 1e-6,
        `${name}: stored text box ${index + 1} moved (${field ? `${field.x}, ${field.y}, ${field.width}` : 'missing'})`)
    })
  }
  const sorted = [...openTimes].sort((a, b) => a - b)
  console.log(`click to first frame: median ${Math.round(sorted[Math.floor(sorted.length / 2)])} ms, max ${Math.round(sorted.at(-1))} ms`)
} catch (error) {
  failure = error
}
try { await browser?.close() } catch {}
try { process.kill(-child.pid, 'SIGTERM') } catch {}
await sleep(500)
fs.rmSync(temporary, { recursive: true, force: true })
if (failure) {
  console.error(failure instanceof Error ? failure.message : failure)
  process.exit(1)
}
console.log('famd open stable: ok')
process.exit(0)
