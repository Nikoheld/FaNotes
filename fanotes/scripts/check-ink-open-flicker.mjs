// Opening a handwriting note in the desktop app shows its ink complete from
// the first frame: no blank, partial, flashing or misplaced ink frame, and no
// blank pane between the last note and the next one.
//
// Drives the real app (Electron under Xvfb) over CDP. Every frame is sampled
// right before paint (a ResizeObserver made each frame): every canvas inside
// each paper pane is composited, at a quarter of the screen resolution, into
// one picture of what the pane shows, and the frame is classified against the
// picture the pane settles on 1.5 s later:
//   old     the previous note is still shown (the open is preparing)
//   blank   the pane shows no note (hidden, empty, or no text)
//   noink   the note's text shows without any of its ink
//   partial the ink shows only in part, or elsewhere (scale, offset)
//   fading  the ink shows below full opacity
//   ok      the settled picture
// Cases: the note open at app start, the first ink note opened after start,
// cold opens from the tree (small, medium, packed, very large, images and
// text boxes), warm tab switches, returning to a scrolled note (remembered
// camera) and the second pane of the split view. Fails on any frame after the
// click that is not old/ok, and when the first complete frame comes later than
// the budget. FANOTES_INK_OPEN_DUMP=1 prints every frame. Needs a built
// renderer (`vite build`), xvfb-run and playwright-core (PLAYWRIGHT_CORE);
// FANOTES_SKIP_BROWSER=1 skips it. Synthetic vault only.
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
  console.log(`ink open flicker: skipped (${missing})`)
  process.exit(0)
}
const dump = process.env.FANOTES_INK_OPEN_DUMP === '1'
// Report only (no assertions): FANOTES_INK_OPEN_MEASURE=1.
const measureOnly = process.env.FANOTES_INK_OPEN_MEASURE === '1'
const scale = Number(process.env.FANOTES_INK_OPEN_DPR || 1)
// Time budgets (click to first complete frame) leave room for a slow runner;
// a page restored over frames again (900 ms and more on the large notes) fails.
const budgetScale = Number(process.env.FANOTES_INK_OPEN_BUDGET_SCALE || 1)

const temporary = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'fanotes-ink-open-'))
const home = path.join(temporary, 'home')
const configHome = path.join(temporary, 'config')
const runtime = path.join(temporary, 'runtime')
const vault = path.join(home, 'Notizen')
const userData = path.join(configHome, 'FaNotes')
for (const directory of [home, configHome, runtime, vault, userData]) fs.mkdirSync(directory, { recursive: true, mode: 0o700 })

const at = '2026-11-01T00:00:00.000Z'
const paragraph = (n) => `Absatz ${n}: Der schnelle braune Fuchs springt über den faulen Hund und läuft weiter über die ganze Seite.`
// Handwriting: words along ruled lines across the page, one stroke per word.
const ink = ({ lines, words, points, top = 0.05, gap = 0.03, ...page }) => ({
  schemaVersion: 1, title: 'Seite', paperStyle: 'lines', sourceWidth: 900, sourceHeight: 1273, createdAt: at, updatedAt: at, ...page,
  strokes: Array.from({ length: lines * words }, (_, i) => {
    const line = Math.floor(i / words)
    const word = i % words
    const x0 = 0.07 + word * (0.86 / words)
    const y0 = top + line * gap
    return {
      color: word % 3 === 0 ? '#1f4fb3' : '#202333', baseWidth: 3, pressureEnabled: true, brush: 'fineliner',
      points: Array.from({ length: points }, (_, k) => ({
        x: x0 + (k / points) * (0.8 / words), y: y0 + Math.sin(k / 2.2 + i) * 0.006, t: k * 8, pressure: 0.4 + 0.2 * Math.sin(k / 5), tiltX: 0, tiltY: 0, pointerType: 'pen',
      })),
    }
  }),
})
const boxes = (name) => [
  { id: `tf-${name}-1`, page: 1, x: 0.12, y: 0.62, width: 0.42, fontSize: 18, text: `Textfeld ${name}: getippter Text auf der Handschriftseite.` },
  { id: `tf-${name}-2`, page: 1, x: 0.55, y: 0.3, width: 0.3, fontSize: 16, text: 'Kurz **fett** und mehr' },
]
// A 64x64 PNG (solid colour) for the image note.
const png = (() => {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0 })
  const crc = (buffer) => { let c = 0xffffffff; for (const byte of buffer) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0 }
  const chunk = (type, data) => { const length = Buffer.alloc(4); length.writeUInt32BE(data.length); const body = Buffer.concat([Buffer.from(type), data]); const sum = Buffer.alloc(4); sum.writeUInt32BE(crc(body)); return Buffer.concat([length, body, sum]) }
  const header = Buffer.alloc(13); header.writeUInt32BE(64, 0); header.writeUInt32BE(64, 4); header[8] = 8; header[9] = 2
  const raw = Buffer.alloc(64 * (1 + 64 * 3)); for (let y = 0; y < 64; y += 1) for (let x = 0; x < 64; x += 1) raw.set([40 + x * 3, 120, 200 - y * 2], y * 193 + 1 + x * 3)
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
})()
fs.writeFileSync(path.join(vault, 'bild.png'), png)
const notes = {
  Klein: { style: 'lines', body: `# Klein\n\n${[1, 2].map(paragraph).join('\n\n')}\n`, ink: ink({ lines: 6, words: 5, points: 30 }) },
  Mittel: { style: 'squares', body: `# Mittel\n\n${[1, 2, 3, 4].map(paragraph).join('\n\n')}\n`, ink: ink({ lines: 20, words: 6, points: 55, gap: 0.04 }), fields: true },
  // Above 8,000 points: opens packed.
  Gross: { style: 'lines', body: `# Gross\n\n${[1, 2, 3, 4, 5].map(paragraph).join('\n\n')}\n`, ink: ink({ lines: 30, words: 6, points: 70, sourceOriginX: 108, sourceOriginY: 144, sourceWidth: 1224, sourceHeight: 1561 }), fields: true },
  // A tall packed page with long typed text.
  Riesig: { style: 'grid', body: `# Riesig\n\n${Array.from({ length: 120 }, (_, i) => paragraph(i)).join('\n\n')}\n`, ink: ink({ lines: 220, words: 6, points: 60, sourceHeight: 9000, top: 0.01, gap: 0.0044 }) },
  Bilder: { style: 'lines', body: `# Bilder\n\n${paragraph(1)}\n\n![Bild](bild.png)\n\n${paragraph(2)}\n`, ink: ink({ lines: 14, words: 5, points: 50, top: 0.08 }), fields: true },
}
fs.writeFileSync(path.join(vault, 'Anfang.md'), '# Anfang\n\nDie Notiz, die beim Start offen ist.\n')
for (const [name, note] of Object.entries(notes)) {
  fs.writeFileSync(path.join(vault, `${name}.famd`), serializeFamd(note.body, { ...emptyFamdPayload(at), ink: note.ink, paperStyle: note.style, textFields: note.fields ? boxes(name) : [] }))
}
// Many notes in the tree.
for (let folder = 0; folder < 8; folder += 1) {
  const directory = path.join(vault, `Fach ${folder + 1}`)
  fs.mkdirSync(directory)
  for (let n = 0; n < 40; n += 1) fs.writeFileSync(path.join(directory, `Notiz ${n + 1}.md`), `# Notiz ${n + 1}\n\n${paragraph(n)}\n`)
}
const writeConfig = (lastOpenNotePath) => fs.writeFileSync(path.join(userData, 'config.json'), `${JSON.stringify({
  version: 3,
  vaultPath: vault,
  settings: { uiLanguage: 'de', autoCheckUpdates: false, autoDownloadUpdates: false, diagnosticsEnabled: false, lastOpenNotePath },
  onboarding: { version: 1, completed: true },
}, null, 2)}\n`, { mode: 0o600 })
writeConfig('Anfang.md')

const port = 19_300 + Math.floor(Math.random() * 600)
const child = spawn(xvfb, ['-a', '-s', '-screen 0 1440x900x24', executable, root, `--remote-debugging-port=${port}`, '--no-sandbox', ...(scale !== 1 ? [`--force-device-scale-factor=${scale}`] : [])], {
  env: { ...process.env, HOME: home, XDG_CONFIG_HOME: configHome, XDG_RUNTIME_DIR: runtime },
  stdio: ['ignore', 'pipe', 'pipe'],
  detached: true,
})
let output = ''
child.stdout.on('data', (chunk) => { output += chunk })
child.stderr.on('data', (chunk) => { output += chunk })
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// Runs in the page (also as an init script, so it samples from navigation).
const installInkSampler = () => {
  if (window.__inkOpen) return
  const state = { frames: [], inputs: [] }
  window.__inkOpen = state
  // The open starts at the input event itself, not when the driver sent it.
  for (const type of ['pointerdown', 'keydown']) window.addEventListener(type, () => { state.inputs.push(performance.now()) }, true)
  const S = 4
  const scratch = document.createElement('canvas')
  const context = scratch.getContext('2d', { willReadFrequently: true })
  let probe = null
  const effective = (element, stop) => {
    let opacity = 1
    let hidden = false
    for (let node = element; node && node !== stop.parentElement; node = node.parentElement) {
      const style = getComputedStyle(node)
      if (style.visibility === 'hidden' || style.display === 'none') hidden = true
      opacity *= Number(style.opacity)
    }
    return { opacity, hidden }
  }
  const pane = (view) => {
    const content = view.querySelector('.cm-content')
    const viewBox = view.getBoundingClientRect()
    const heading = content?.querySelector('.cm-line')?.textContent.replace(/^#\s*/u, '').trim() ?? null
    const text = content ? effective(content, view) : { opacity: 0, hidden: true }
    let textShown = Boolean(content) && !text.hidden && text.opacity > 0.01 && !view.dataset.cameraRestoring
    if (textShown) {
      textShown = false
      for (const line of content.querySelectorAll('.cm-line')) {
        const rect = line.getBoundingClientRect()
        if (rect.bottom > viewBox.top && rect.top < viewBox.bottom && rect.height > 0 && line.textContent.trim()) { textShown = true; break }
      }
    }
    const width = Math.max(1, Math.ceil(viewBox.width / S))
    const height = Math.max(1, Math.ceil(viewBox.height / S))
    scratch.width = width
    scratch.height = height
    let minOpacity = 1
    const canvases = []
    for (const canvas of view.querySelectorAll('canvas')) {
      const rect = canvas.getBoundingClientRect()
      const look = effective(canvas, view)
      canvases.push([canvas.className.split(' ').at(-1)?.slice(0, 24) ?? '', canvas.width, canvas.height, Math.round(rect.width), Math.round(rect.height)])
      if (!canvas.width || !canvas.height || rect.width < 1 || rect.height < 1 || look.hidden || view.dataset.cameraRestoring) continue
      if (rect.right < viewBox.left || rect.left > viewBox.right || rect.bottom < viewBox.top || rect.top > viewBox.bottom) continue
      minOpacity = Math.min(minOpacity, look.opacity)
      context.globalAlpha = Math.max(0, Math.min(1, look.opacity))
      context.drawImage(canvas, (rect.left - viewBox.left) / S, (rect.top - viewBox.top) / S, rect.width / S, rect.height / S)
    }
    const data = context.getImageData(0, 0, width, height).data
    const mask = new Uint8Array(Math.ceil((width * height) / 8))
    let count = 0
    for (let index = 0, bit = 0; index < data.length; index += 4, bit += 1) {
      if (data[index + 3] > 60) { mask[bit >> 3] |= 1 << (bit & 7); count += 1 }
    }
    const layout = [...view.querySelectorAll('.cm-live-image')].map((image) => Math.round(image.getBoundingClientRect().height)).join(',') + `|${Math.round(content?.getBoundingClientRect().height ?? 0)}`
    return { heading, textShown, restoring: Boolean(view.dataset.cameraRestoring), count, mask, minOpacity, canvases: JSON.stringify(canvases), scroll: [Math.round(view.scrollLeft), Math.round(view.scrollTop)], layout }
  }
  const sample = () => {
    const started = performance.now()
    const panes = [...document.querySelectorAll('.paper-view')].map(pane)
    state.frames.push({ t: started, cost: performance.now() - started, panes })
  }
  const tick = () => {
    if (!probe && document.documentElement) {
      probe = document.createElement('div')
      probe.style.cssText = 'position:fixed;left:0;top:0;width:1px;height:1px;opacity:0;pointer-events:none'
      document.documentElement.appendChild(probe)
    }
    if (probe) {
      const observer = new ResizeObserver(() => { observer.disconnect(); sample() })
      observer.observe(probe)
    }
    requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
  // Classifies the frames since `from` for pane `index` against the last one.
  state.report = (after, index, name, previous) => {
    const from = state.inputs.find((at) => at >= after) ?? after
    const frames = state.frames.filter((frame) => frame.t >= from)
    const settled = frames.at(-1)?.panes[index]
    const popcount = (byte) => { let n = 0; for (let v = byte; v; v &= v - 1) n += 1; return n }
    const rows = frames.map((frame) => {
      const own = frame.panes[index]
      let kind
      // A second pane that does not exist yet is the screen before the open.
      if (!own) kind = index > 0 || previous ? 'old' : 'blank'
      else if (!own.textShown) kind = own.heading === previous && !own.restoring ? 'old' : 'blank'
      else if (own.heading !== name) kind = own.heading === previous ? 'old' : 'blank'
      else if (settled.count > 0 && own.count === 0) kind = 'noink'
      else {
        let differ = 0
        if (own.mask.length === settled.mask.length) for (let k = 0; k < own.mask.length; k += 1) differ += popcount(own.mask[k] ^ settled.mask[k])
        else differ = Math.max(own.count, settled.count)
        const share = differ / Math.max(1, settled.count)
        kind = share > 0.04 ? 'partial' : own.minOpacity < 0.99 ? 'fading' : 'ok'
        own.share = Math.round(share * 1000) / 10
      }
      return { t: frame.t - from, cost: frame.cost, kind, count: own?.count ?? 0, share: own?.share ?? null, canvases: own?.canvases ?? '', scroll: own?.scroll ?? null, heading: own?.heading ?? null, layout: own?.layout ?? '' }
    })
    return { rows, settledCount: settled?.count ?? 0 }
  }
}

let browser
let failure = null
const results = []
const failures = []
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
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Page.enable')
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: `(${installInkSampler.toString()})()` })
  await page.waitForFunction(() => Boolean(window.fanotes && document.querySelector('.file-tree__row')), null, { timeout: 90_000 })
  await sleep(1500)

  // Opening is not an edit: no note's text, ink, text boxes or links change by
  // opening or leaving it. (Its reading statistics are written on purpose.)
  const contents = () => Object.fromEntries(Object.keys(notes).map((name) => {
    const parsed = parseFamd(fs.readFileSync(path.join(vault, `${name}.famd`), 'utf8'))
    const payload = parsed.payload ?? {}
    return [name, JSON.stringify([parsed.markdown, payload.ink, payload.textFields ?? [], payload.noteLinks ?? []])]
  }))
  let lastTimes = contents()
  const noteWrites = (label) => {
    const now = contents()
    const written = Object.keys(now).filter((name) => now[name] !== lastTimes[name])
    lastTimes = now
    if (written.length) {
      console.log(`    ${label}: wrote ${written.join(', ')}`)
      if (process.env.FANOTES_INK_OPEN_KEEP) for (const name of written) fs.copyFileSync(path.join(vault, `${name}.famd`), path.join(process.env.FANOTES_INK_OPEN_KEEP, `${name}-${label.replace(/\W+/gu, '-')}.famd`))
      failures.push(`${label}: opening wrote ${written.join(', ')}`)
    }
  }
  const summarize = (label, report, budget) => {
    const { rows, settledCount } = report
    const firstShown = rows.find((row) => row.kind !== 'old' && row.kind !== 'blank')
    const lastBad = rows.findLastIndex((row) => row.kind !== 'ok')
    const complete = rows[lastBad + 1]
    const bad = rows.filter((row, index) => row.kind !== 'old' && row.kind !== 'ok' && (index > 0 || row.kind !== 'blank'))
    const kinds = {}
    for (const row of bad) kinds[row.kind] = (kinds[row.kind] ?? 0) + 1
    const resizes = new Set(rows.filter((row) => row.heading === rows.at(-1)?.heading).map((row) => row.canvases)).size - 1
    const result = {
      label,
      firstShown: firstShown ? Math.round(firstShown.t) : null,
      complete: complete ? Math.round(complete.t) : null,
      frames: rows.length,
      bad: bad.length,
      kinds,
      resizes,
      settledCount,
      sampleCost: Math.round(Math.max(...rows.map((row) => row.cost)) * 10) / 10,
    }
    results.push(result)
    console.log(`${bad.length ? 'BAD' : 'ok '} ${label}: first frame ${result.firstShown} ms, complete ${result.complete} ms, ${rows.length} frames, ${bad.length} bad ${JSON.stringify(kinds)}, canvas box changes ${resizes}, ink px ${settledCount}`)
    if (dump || bad.length) {
      let previousLine = ''
      for (const row of rows) {
        const line = `${row.kind} ${row.heading} n=${row.count} d=${row.share} ${row.canvases} ${row.scroll} text ${row.layout}`
        if (line !== previousLine) console.log(`    ${String(Math.round(row.t)).padStart(5)} ${line}`)
        previousLine = line
      }
    }
    if (settledCount < 50) failures.push(`${label}: the settled pane shows no ink (${settledCount} px)`)
    if (bad.length) failures.push(`${label}: ${bad.length} frames with blank, partial or flashing ink ${JSON.stringify(kinds)}`)
    if (budget && result.complete !== null && result.complete > budget * budgetScale) failures.push(`${label}: complete after ${result.complete} ms (budget ${Math.round(budget * budgetScale)} ms)`)
    if (result.complete === null) failures.push(`${label}: never complete`)
  }
  const profileLabel = process.env.FANOTES_INK_OPEN_PROFILE || ''
  const open = async (label, name, previous, click, { pane = 0, budget = 0, wait = 1500 } = {}) => {
    const profiling = profileLabel && label.includes(profileLabel)
    if (profiling) {
      await cdp.send('Profiler.enable')
      await cdp.send('Profiler.setSamplingInterval', { interval: 200 })
      await cdp.send('Profiler.start')
    }
    const from = await page.evaluate(() => performance.now())
    await click()
    await sleep(wait)
    if (profiling) {
      const { profile } = await cdp.send('Profiler.stop')
      fs.writeFileSync(path.join(process.env.FANOTES_INK_OPEN_PROFILE_DIR || os.tmpdir(), `ink-open-${label.replace(/\W+/gu, '-')}.cpuprofile`), JSON.stringify(profile))
    }
    const report = await page.evaluate(([start, index, own, last]) => window.__inkOpen.report(start, index, own, last), [from, pane, name, previous])
    summarize(label, report, budget)
    noteWrites(label)
  }
  const fromTree = (name) => () => page.locator(`.file-tree__entry-button[data-path="${name}.famd"]`).first().click()
  const fromTab = (name) => () => page.locator('.note-tab', { hasText: name }).first().click()
  const startup = async (label, name, budget, { record = true } = {}) => {
    await page.reload()
    await page.waitForFunction((own) => [...document.querySelectorAll('.paper-view .cm-line')].some((line) => line.textContent.includes(own)), name, { timeout: 60_000 })
    await sleep(2000)
    if (!record) return
    const report = await page.evaluate((own) => window.__inkOpen.report(0, 0, own, null), name)
    // Frames before the note's text came are the app starting, not the note.
    const firstNote = report.rows.findIndex((row) => row.heading === name && row.kind !== 'blank')
    report.rows = report.rows.slice(Math.max(0, firstNote))
    summarize(label, report, budget)
  }

  if (process.env.FANOTES_INK_OPEN_IPC === '1') {
    // Where an open's file work goes: main-process reads as the renderer sees them.
    const timings = await page.evaluate(async (names) => {
      const out = []
      for (const round of ['cold', 'warm']) {
        for (const name of names) {
          const file = `${name}.famd`
          const time = async (label, run) => { const started = performance.now(); const value = await run(); out.push(`${round} ${name} ${label} ${Math.round(performance.now() - started)} ms`); return value }
          await time('readFile', () => window.fanotes.readFile(file))
          const companion = await time('readNoteCompanion', () => window.fanotes.readNoteCompanion(file))
          await time('readFamdInk', () => window.fanotes.readFamdInk(file))
          const json = companion?.ink?.drawingJson ?? ''
          const started = performance.now(); JSON.parse(json); out.push(`${round} ${name} JSON.parse(${Math.round(json.length / 1024)} KiB, packed ${Boolean(companion?.ink?.packedInk)}) ${Math.round(performance.now() - started)} ms`)
        }
      }
      return out
    }, Object.keys(notes))
    console.log(timings.join('\n'))
  }
  // Fresh renderer with a plain note open, then the first ink note after start.
  await startup('app start (plain note)', 'Anfang', 0, { record: false })
  await open('first ink note after start: Gross (tree)', 'Gross', 'Anfang', fromTree('Gross'), { budget: 700 })
  await open('cold Klein (tree)', 'Klein', 'Gross', fromTree('Klein'), { budget: 450 })
  await open('cold Mittel (tree)', 'Mittel', 'Klein', fromTree('Mittel'), { budget: 450 })
  await open('cold Riesig (tree)', 'Riesig', 'Mittel', fromTree('Riesig'), { budget: 1100 })
  await open('cold Bilder (tree)', 'Bilder', 'Riesig', fromTree('Bilder'), { budget: 450 })
  await open('warm Klein (tab)', 'Klein', 'Bilder', fromTab('Klein'), { budget: 400 })
  await open('warm Gross (tab)', 'Gross', 'Klein', fromTab('Gross'), { budget: 600 })
  await open('warm Riesig (tab)', 'Riesig', 'Gross', fromTab('Riesig'), { budget: 900 })
  await open('warm Mittel (tab)', 'Mittel', 'Riesig', fromTab('Mittel'), { budget: 400 })
  // Returning to a note scrolled down: its remembered camera.
  await fromTab('Riesig')()
  await sleep(1200)
  await page.evaluate(() => { const view = document.querySelector('.paper-view'); view.scrollTop = Math.round(view.scrollHeight * 0.4); view.dispatchEvent(new Event('scroll')) })
  await sleep(1200)
  await fromTab('Gross')()
  await sleep(1200)
  await open('return to scrolled Riesig (tab)', 'Riesig', 'Gross', fromTab('Riesig'), { budget: 900 })
  // The second pane: Riesig on the left, the last other note (Gross) on the right.
  await open('split view: Gross in the second pane', 'Gross', null, () => page.keyboard.press('Control+Backslash'), { pane: 1, budget: 600 })
  await page.keyboard.press('Control+Backslash')
  await sleep(800)
  // The app restarting with an ink note open.
  await fromTab('Gross')()
  await sleep(1500)
  await startup('app start with Gross open', 'Gross', 0)
  if (pageErrors.length) failures.push(`page errors: ${pageErrors.join('; ').slice(0, 400)}`)
} catch (error) {
  failure = error
}
try { await browser?.close() } catch {}
try { process.kill(-child.pid, 'SIGTERM') } catch {}
await sleep(500)
fs.rmSync(temporary, { recursive: true, force: true })
if (results.length) {
  const totalBad = results.reduce((sum, result) => sum + result.bad, 0)
  const totalFrames = results.reduce((sum, result) => sum + result.frames, 0)
  console.log(`summary: ${results.length} opens, ${totalFrames} frames, ${totalBad} bad frames; first complete frame per open (ms): ${results.map((result) => `${result.label.split(':')[0].split(' (')[0]}=${result.complete}`).join(', ')}`)
}
if (failure) {
  console.error(failure instanceof Error ? failure.stack : failure)
  process.exit(1)
}
if (failures.length && !measureOnly) {
  console.error(failures.join('\n'))
  process.exit(1)
}
console.log(measureOnly ? 'ink open flicker: measured' : 'ink open flicker: ok')
process.exit(0)
