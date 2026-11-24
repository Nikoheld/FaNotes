// Zooming a note with many sections and a lot of handwriting stays smooth.
//
// Drives the real app (Electron under Xvfb, device pixel ratio 1) over CDP on
// a tall grid note: 48 Markdown heading sections (every fourth one folded)
// and 48 handwriting sections on the sheet (every sixth one collapsed), with
// about 50,000 ink points written across the expanded bodies. Each case zooms
// (a trackpad pinch in and out, Ctrl+wheel notches, the zoom buttons) and
// records, from the first input until the picture has come to rest:
//   frames     requestAnimationFrame deltas: p50, p95, max, count > 33 / > 50 ms
//   long tasks PerformanceObserver 'longtask': count, total and longest
//   sharp      last input to the sharp ink bitmap the picture settles on
//   renders    section headers React wrote to the DOM (attribute and child
//              list mutations under the bands): a zoom must not touch them
//   restyled   elements the zoom commit restyles (first case, from a CDP trace)
// The assertions are structural or generous (CI runners are slower than this
// machine): no section band is rewritten by a zoom (main re-rendered all 48
// at every settle, 40-50 ms of React work), the commit restyles at most
// MAX_RESTYLED elements, no single main-thread task is longer than
// LONGEST_TASK_MS, and the sharp bitmap is up within SHARP_BUDGET_MS.
//   FANOTES_ZOOM_PERF_REPORT=1        print every case's numbers (before/after)
//   FANOTES_ZOOM_PERF_TRACE=<case>    record a CDP trace of the matching case and
//                                     print where the main thread spent its time
//   FANOTES_ZOOM_PERF_PROFILE=<case>  CPU profile of the matching case (top functions)
//   FANOTES_ZOOM_PERF_SLACK=2         multiply every time budget
//   FANOTES_ZOOM_PERF_CPU=1           CPU time per thread kind for every case (a trace each)
//   FANOTES_ZOOM_PERF_BANDS=0 / _INK=0 / _FOLDS=0  the same note without the
//                                     handwriting bands / the ink / folded headings
// Needs a built renderer (`vite build`), xvfb-run and playwright-core
// (PLAYWRIGHT_CORE); FANOTES_SKIP_BROWSER=1 skips it. Synthetic vault only.
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const { serializeFamd, emptyFamdPayload } = require('../electron/famd.cjs')

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
  console.log(`zoom sections perf: skipped (${missing})`)
  process.exit(0)
}
const report = process.env.FANOTES_ZOOM_PERF_REPORT === '1'
const traceCase = process.env.FANOTES_ZOOM_PERF_TRACE || ''
const profileCase = process.env.FANOTES_ZOOM_PERF_PROFILE || ''
const cpuMode = process.env.FANOTES_ZOOM_PERF_CPU === '1'
const slack = Number(process.env.FANOTES_ZOOM_PERF_SLACK || 1)
const SECTION_COUNT = 48
// Comparison runs: the same note without the handwriting section bands, without ink.
const WITH_BANDS = process.env.FANOTES_ZOOM_PERF_BANDS !== '0'
const WITH_INK = process.env.FANOTES_ZOOM_PERF_INK !== '0'
/** No single main-thread task during a zoom may take longer than this. */
const LONGEST_TASK_MS = 400
/**
 * Elements one zoom commit restyles at most. CSS zoom restyles the sheet;
 * the 48 bands hold about 1,100 elements, and those far from the view must
 * not be among them (main restyled 1,477 here, the fix about 630).
 */
const MAX_RESTYLED = 1000
/** Last zoom input to the sharp bitmap on screen. */
const SHARP_BUDGET_MS = 900

const at = '2026-11-01T00:00:00.000Z'
const SHEET_WIDTH = 1224
const HEADER_PX = 72
const BODY_PX = 330
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// ── The note ────────────────────────────────────────────────────────────────
// Px layout of the sheet first, then everything normalised to 0–1 of it.
const bands = []
let cursorPx = 160
for (let index = 0; index < SECTION_COUNT; index += 1) {
  const collapsed = index % 6 === 5
  bands.push({ index, top: cursorPx, bodyTop: cursorPx + HEADER_PX, collapsed })
  cursorPx += HEADER_PX + (collapsed ? 0 : BODY_PX)
}
const SHEET_HEIGHT = cursorPx + 240
const word = (x0, yPx, seed, length = 24) => ({
  color: seed % 4 === 0 ? '#1f4fb3' : '#202333', baseWidth: 3, pressureEnabled: true, brush: 'fineliner',
  points: Array.from({ length }, (_, k) => ({
    x: x0 + (k / length) * 0.11,
    y: (yPx + Math.sin(k / 2.2 + seed) * 5) / SHEET_HEIGHT,
    t: k * 8, pressure: 0.4 + 0.2 * Math.sin(k / 5), tiltX: 0, tiltY: 0, pointerType: 'pen',
  })),
})
const strokes = []
for (const band of bands) {
  if (band.collapsed || !WITH_INK) continue
  for (let line = 0; line < 9; line += 1) {
    for (let column = 0; column < 7; column += 1) {
      strokes.push(word(0.05 + column * 0.13, band.bodyTop + 24 + line * 34, band.index * 31 + line * 7 + column))
    }
  }
}
// Collapsed sections park their body ink, normalised to the hidden box.
const hiddenInk = () => Array.from({ length: 20 }, (_, index) => {
  const stroke = word(0.05 + (index % 7) * 0.13, 0, index)
  return { ...stroke, points: stroke.points.map((point) => ({ ...point, y: 0.1 + Math.floor(index / 7) * 0.3 + (point.y * SHEET_HEIGHT) / 300 })) }
})
const sections = WITH_BANDS ? bands.map((band) => ({
  id: `s${band.index}`,
  top: band.top / SHEET_HEIGHT,
  bodyTop: band.bodyTop / SHEET_HEIGHT,
  collapsed: band.collapsed,
  title: `Abschnitt ${band.index + 1}`,
  hidden: band.collapsed ? { widthPx: SHEET_WIDTH, heightPx: 300, strokes: hiddenInk() } : null,
})) : undefined
const points = strokes.reduce((sum, stroke) => sum + stroke.points.length, 0)
const inkPage = { schemaVersion: 1, title: 'Seite', paperStyle: 'grid', sourceWidth: SHEET_WIDTH, sourceHeight: SHEET_HEIGHT, createdAt: at, updatedAt: at, strokes, ...(sections ? { sections } : {}) }
const paragraph = (index) => `Absatz ${index}: Notizen zur Stunde mit Beispielen, Fragen und einer kurzen Zusammenfassung der wichtigsten Punkte, damit der Text über mehrere Zeilen läuft.`
const headings = SECTION_COUNT
const noteBody = `# Zoomprobe\n\n${Array.from({ length: headings }, (_, index) => `## Thema ${index + 1}\n\n${paragraph(index * 2)}\n\n${paragraph(index * 2 + 1)}\n`).join('\n')}`
const foldedHeadings = process.env.FANOTES_ZOOM_PERF_FOLDS !== '0' ? Array.from({ length: headings }, (_, index) => index).filter((index) => index % 4 === 3).map((index) => `2:Thema ${index + 1}#1`) : []

// ── In the page: frames, long tasks, section rewrites, bitmap per frame ────
const installRecorder = () => {
  if (window.__zoomPerf) return
  const state = { on: false, frames: [], tasks: [], inputs: [], mutations: 0, mutationSamples: [] }
  window.__zoomPerf = state
  window.addEventListener('wheel', (event) => { if (event.ctrlKey) state.inputs.push(performance.now()) }, true)
  window.addEventListener('click', () => { state.inputs.push(performance.now()) }, true)
  try {
    new PerformanceObserver((list) => {
      if (!state.on) return
      for (const entry of list.getEntries()) state.tasks.push({ start: entry.startTime, duration: entry.duration })
    }).observe({ type: 'longtask', buffered: false })
  } catch {}
  const observer = new MutationObserver((records) => {
    if (!state.on) return
    for (const record of records) {
      state.mutations += 1
      if (state.mutationSamples.length < 5) {
        const target = record.target instanceof Element ? record.target : record.target.parentElement
        state.mutationSamples.push(`${record.type} ${record.attributeName ?? ''} on ${target?.className?.toString().slice(0, 60) ?? '?'}${record.attributeName ? ` (${record.oldValue} -> ${target?.getAttribute(record.attributeName)})` : ''}`)
      }
    }
  })
  let watched = []
  const watch = () => {
    // The bands on the board and, while typing, their titles on the paper.
    const hosts = [...document.querySelectorAll('.paper-view .lw-ink-sections, .paper-view .lw-ink-section-titles')]
    if (hosts.length === watched.length && hosts.every((host, index) => host === watched[index])) return
    observer.disconnect()
    watched = hosts
    for (const host of hosts) observer.observe(host, { subtree: true, childList: true, attributes: true, attributeOldValue: true, characterData: true })
  }
  state.watch = watch
  const tick = (now) => {
    if (state.on) {
      const plane = document.querySelector('.paper-view .paper-sheet-plane')
      const canvas = document.querySelector('.paper-view canvas.lw-tablet-canvas-committed')
      state.frames.push({
        t: now,
        bitmap: canvas ? `${canvas.width}x${canvas.height} ${canvas.style.top} ${canvas.style.height}` : '',
        preview: Boolean(plane?.style.transform),
        zoom: plane?.style.zoom || '',
      })
    }
    requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
}

// ── Trace summary: where the renderer main thread spent the case ──────────
const summariseTrace = (events) => {
  const threadNames = new Map(events.filter((event) => event.name === 'thread_name').map((event) => [`${event.pid}:${event.tid}`, event.args?.name ?? '']))
  const main = new Set([...threadNames].filter(([, name]) => name === 'CrRendererMain').map(([key]) => key))
  const onMain = events.filter((event) => main.has(`${event.pid}:${event.tid}`) && event.ph === 'X' && typeof event.dur === 'number')
  // Busy time per thread kind: top-level tasks only (no nesting).
  const busy = new Map()
  for (const event of events) {
    if (event.ph !== 'X' || typeof event.dur !== 'number' || !['ThreadControllerImpl::RunTask', 'RunTask', 'TaskGraphRunner::RunTask'].includes(event.name)) continue
    const name = (threadNames.get(`${event.pid}:${event.tid}`) || `tid ${event.tid}`).replace(/\d+$/, '')
    busy.set(name, (busy.get(name) ?? 0) + event.dur / 1000)
  }
  for (const kind of ['ThreadPoolForegroundWorker', 'VizCompositorThread', 'Compositor']) {
    const names = new Map()
    for (const event of events) {
      if (event.ph !== 'X' || typeof event.dur !== 'number') continue
      const thread = (threadNames.get(`${event.pid}:${event.tid}`) || '').replace(/\d+$/, '')
      if (thread !== kind) continue
      names.set(event.name, (names.get(event.name) ?? 0) + event.dur / 1000)
    }
    console.log(`    ${kind}: ${[...names.entries()].sort((x, y) => y[1] - x[1]).slice(0, 8).map(([name, ms]) => `${name} ${ms.toFixed(0)}`).join(', ')}`)
  }
  console.log(`    busy ms per thread: ${[...busy.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([name, ms]) => `${name} ${ms.toFixed(0)}`).join(', ')}`)
  const byName = new Map()
  for (const event of onMain) {
    const entry = byName.get(event.name) ?? { count: 0, total: 0, max: 0 }
    entry.count += 1
    entry.total += (event.tdur ?? event.dur) / 1000
    entry.max = Math.max(entry.max, event.dur / 1000)
    byName.set(event.name, entry)
  }
  const rows = [...byName.entries()].sort((a, b) => b[1].total - a[1].total).slice(0, 16)
  console.log('    main thread (inclusive CPU ms; nested events overlap):')
  for (const [name, entry] of rows) console.log(`      ${name.padEnd(34)} ${String(entry.count).padStart(5)}x  total ${entry.total.toFixed(1).padStart(8)}  max ${entry.max.toFixed(1).padStart(7)}`)
  // The commit of the zoom: the task that restyles the zoomed sheet. CPU ms.
  for (const style of onMain.filter((event) => event.name === 'UpdateLayoutTree' && (event.args?.elementCount ?? 0) > 150)) {
    const task = onMain.find((event) => event.name === 'ThreadControllerImpl::RunTask' && event.ts <= style.ts && event.ts + event.dur >= style.ts + style.dur)
    if (!task) continue
    const inner = new Map()
    for (const event of onMain) {
      if (event === task || event.ts < task.ts || event.ts + event.dur > task.ts + task.dur || typeof event.tdur !== 'number') continue
      if (!['FunctionCall', 'TimerFire', 'FireAnimationFrame', 'EventDispatch', 'UpdateLayoutTree', 'Layout', 'Paint', 'PrePaint', 'Layerize', 'Commit', 'HitTest', 'v8.callFunction', 'ParseHTML'].includes(event.name)) continue
      inner.set(event.name, (inner.get(event.name) ?? 0) + event.tdur / 1000)
    }
    console.log(`      commit task: cpu ${(task.tdur / 1000).toFixed(1)} ms (wall ${(task.dur / 1000).toFixed(1)}), restyled ${style.args.elementCount}: ${[...inner.entries()].sort((x, y) => y[1] - x[1]).slice(0, 8).map(([name, ms]) => `${name} ${ms.toFixed(1)}`).join(', ')}`)
  }
  // React renders (the scheduler's work loop), CPU ms each.
  // The scheduler lives in the react chunk; its tasks are React's render and commit work.
  const renders = onMain.filter((event) => event.name === 'FunctionCall' && typeof event.tdur === 'number' && event.tdur > 500 && (event.args?.data?.functionName === 'performWorkUntilDeadline' || /\/react-[^/]*\.js$/.test(event.args?.data?.url ?? '')))
  console.log(`      react work: ${renders.length} tasks, cpu ${renders.map((event) => (event.tdur / 1000).toFixed(1)).join(' ')} ms`)
  // Every long main-thread task with what it spent its time on.
  const tops = onMain.filter((event) => event.name === 'ThreadControllerImpl::RunTask' && event.dur > 40_000).sort((x, y) => x.ts - y.ts)
  const t0 = onMain.reduce((min, event) => Math.min(min, event.ts), Infinity)
  const interesting = new Set(['FunctionCall', 'TimerFire', 'FireAnimationFrame', 'EventDispatch', 'UpdateLayoutTree', 'Layout', 'Paint', 'PrePaint', 'Layerize', 'Commit', 'LayerTreeHost::DoUpdateLayers', 'HitTest', 'RunMicrotasks', 'ResizeObserverController::BroadcastObservations', 'IntersectionObserverController::computeIntersections', 'ScrollLayer', 'MajorGC', 'MinorGC', 'V8.GC_MC_BACKGROUND_MARKING', 'ParseHTML'])
  for (const task of tops) {
    const inner = new Map()
    for (const event of onMain) {
      if (event === task || !interesting.has(event.name) || event.ts < task.ts || event.ts + event.dur > task.ts + task.dur) continue
      inner.set(event.name, (inner.get(event.name) ?? 0) + event.dur / 1000)
    }
    const fn = onMain.find((event) => event.name === 'FunctionCall' && event.ts >= task.ts && event.ts < task.ts + task.dur)
    const where = fn?.args?.data ? ` js ${fn.args.data.functionName || '?'}@${(fn.args.data.url || '').split('/').at(-1)}:${fn.args.data.lineNumber}` : ''
    console.log(`      task +${((task.ts - t0) / 1000).toFixed(0)} ms ${(task.dur / 1000).toFixed(1)} ms: ${[...inner.entries()].sort((x, y) => y[1] - x[1]).slice(0, 7).map(([name, ms]) => `${name} ${ms.toFixed(1)}`).join(', ')}${where}`)
  }
  // Paint invalidations (what made layers repaint) and style invalidations.
  const invalidations = new Map()
  for (const event of events) {
    if (!/Invalidation|invalidation/.test(event.name)) continue
    const data = event.args?.data ?? {}
    const key = `${event.name} ${data.reason ?? data.invalidationSet ?? ''} ${(data.nodeName ?? '').slice(0, 70)}`
    invalidations.set(key, (invalidations.get(key) ?? 0) + 1)
  }
  for (const [key, count] of [...invalidations.entries()].sort((x, y) => y[1] - x[1]).slice(0, 25)) console.log(`      ${String(count).padStart(5)}x ${key}`)
  const layouts = onMain.filter((event) => event.name === 'Layout').sort((a, b) => b.dur - a.dur).slice(0, 6)
  for (const layout of layouts) {
    const data = layout.args?.beginData ?? {}
    console.log(`      layout ${(layout.dur / 1000).toFixed(1)} ms: ${data.dirtyObjects ?? '?'} of ${data.totalObjects ?? '?'} objects, partial ${data.partialLayout ?? '?'}`)
  }
  const styles = onMain.filter((event) => event.name === 'UpdateLayoutTree').sort((a, b) => b.dur - a.dur).slice(0, 4)
  for (const style of styles) console.log(`      style ${(style.dur / 1000).toFixed(1)} ms: ${style.args?.elementCount ?? '?'} elements`)
}

const summariseProfile = (profile) => {
  const self = new Map()
  const byId = new Map(profile.nodes.map((node) => [node.id, node]))
  const interval = new Map()
  for (let index = 0; index < profile.samples.length; index += 1) {
    const id = profile.samples[index]
    interval.set(id, (interval.get(id) ?? 0) + (profile.timeDeltas[index] ?? 0) / 1000)
  }
  for (const [id, ms] of interval) {
    const frame = byId.get(id).callFrame
    const key = `${frame.functionName || '(anonymous)'} ${frame.url.split('/').at(-1)}:${frame.lineNumber + 1}:${frame.columnNumber + 1}`
    self.set(key, (self.get(key) ?? 0) + ms)
  }
  // Inclusive time: a node's samples plus its children's.
  const parent = new Map()
  for (const node of profile.nodes) for (const childId of node.children ?? []) parent.set(childId, node.id)
  const inclusive = new Map()
  for (const [id, ms] of interval) {
    const seen = new Set()
    for (let node = id; node !== undefined; node = parent.get(node)) {
      const frame = byId.get(node).callFrame
      if (!frame.url) continue
      const key = `${frame.functionName || '(anonymous)'} ${frame.url.split('/').at(-1)}:${frame.lineNumber + 1}`
      if (seen.has(key)) continue
      seen.add(key)
      inclusive.set(key, (inclusive.get(key) ?? 0) + ms)
    }
  }
  console.log('    CPU profile, inclusive ms:')
  for (const [key, ms] of [...inclusive.entries()].sort((x, y) => y[1] - x[1]).slice(0, 30)) console.log(`      ${ms.toFixed(1).padStart(8)}  ${key}`)
  console.log('    CPU profile, self ms:')
  for (const [key, ms] of [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25)) console.log(`      ${ms.toFixed(1).padStart(8)}  ${key}`)
}

const percentile = (values, fraction) => {
  if (!values.length) return 0
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))]
}

const results = []
const failures = []
const temporary = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'fanotes-zoom-sections-'))
const home = path.join(temporary, 'home')
const configHome = path.join(temporary, 'config')
const runtime = path.join(temporary, 'runtime')
const vault = path.join(home, 'Notizen')
const userData = path.join(configHome, 'FaNotes')
for (const directory of [home, configHome, runtime, vault, userData]) fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
fs.writeFileSync(path.join(vault, 'Zoomprobe.famd'), serializeFamd(noteBody, { ...emptyFamdPayload(at), ink: inkPage, paperStyle: 'grid', textFields: [] }))
fs.writeFileSync(path.join(userData, 'config.json'), `${JSON.stringify({
  version: 3,
  vaultPath: vault,
  settings: { uiLanguage: 'de', autoCheckUpdates: false, autoDownloadUpdates: false, diagnosticsEnabled: false, lastOpenNotePath: 'Zoomprobe.famd', viewZoomMax: 500 },
  onboarding: { version: 1, completed: true },
}, null, 2)}\n`, { mode: 0o600 })

const port = 19_900 + Math.floor(Math.random() * 90)
const child = spawn(xvfb, ['-a', '-s', '-screen 0 1440x900x24', executable, root, `--remote-debugging-port=${port}`, '--no-sandbox', '--force-device-scale-factor=1'], {
  env: { ...process.env, HOME: home, XDG_CONFIG_HOME: configHome, XDG_RUNTIME_DIR: runtime },
  stdio: ['ignore', 'pipe', 'pipe'],
  detached: true,
})
let output = ''
child.stdout.on('data', (chunk) => { output += chunk })
child.stderr.on('data', (chunk) => { output += chunk })
let browser
let crashed = null
try {
  for (let tries = 0; tries < 240 && !browser; tries += 1) {
    try { browser = await playwright.chromium.connectOverCDP(`http://127.0.0.1:${port}`) } catch { await sleep(250) }
    if (child.exitCode !== null) throw new Error(`Electron exited (${child.exitCode}): ${output.slice(-600)}`)
  }
  if (!browser) throw new Error('Electron did not open a debugging port')
  let page = null
  for (let tries = 0; tries < 120 && !page; tries += 1) {
    page = browser.contexts().flatMap((context) => context.pages()).find((candidate) => !candidate.url().startsWith('devtools')) ?? null
    if (!page) await sleep(250)
  }
  if (!page) throw new Error('no renderer page')
  const pageErrors = []
  page.on('pageerror', (error) => pageErrors.push(String(error)))
  const ready = () => page.waitForFunction(() => Boolean(window.fanotes && document.querySelector('.paper-view .unified-paper canvas')), null, { timeout: 90_000 })
  await ready()
  // Folded headings live in the local profile: store them, then load again.
  if (foldedHeadings.length) {
    await page.evaluate(({ vaultPath, keys }) => {
      let hash = 5381
      for (const char of vaultPath) hash = ((hash * 33) ^ char.charCodeAt(0)) >>> 0
      localStorage.setItem('fanotes.headingFolds.v2', JSON.stringify({ [`${hash.toString(36)}|Zoomprobe.famd`]: { keys, at: Date.now() } }))
    }, { vaultPath: vault, keys: foldedHeadings })
    await page.reload()
    await ready()
  }
  // Experiments only: extra CSS in the page.
  if (process.env.FANOTES_ZOOM_PERF_CSS) await page.addStyleTag({ content: process.env.FANOTES_ZOOM_PERF_CSS })
  await page.evaluate(`(${installRecorder.toString()})()`)
  await sleep(2500)
  const shape = await page.evaluate(() => ({
    headers: document.querySelectorAll('.paper-view .lw-ink-section-header').length,
    folded: document.querySelectorAll('.paper-view .cm-foldPlaceholder').length,
    stored: Object.keys(JSON.parse(localStorage.getItem('fanotes.headingFolds.v2') || '{}')).join(','),
    lines: document.querySelectorAll('.paper-view .cm-line').length,
    bandElements: document.querySelectorAll('.paper-view .lw-ink-sections *, .paper-view .lw-ink-section-titles *').length,
    sheetElements: document.querySelectorAll('.paper-view .paper-sheet-plane *').length,
    sheet: document.querySelector('.paper-view .unified-paper')?.offsetHeight ?? 0,
  }))
  console.log(`note: ${SECTION_COUNT} heading sections (${foldedHeadings.length} folded), ${shape.headers} handwriting section headers on screen, ${strokes.length} strokes / ${points} points, sheet ${SHEET_WIDTH}x${shape.sheet} px, ${shape.lines} text lines in the DOM, ${shape.folded} fold placeholders, ${shape.bandElements} of ${shape.sheetElements} elements on the sheet are section bands${report ? ` (stored ${shape.stored})` : ''}`)
  if (WITH_BANDS && shape.headers < SECTION_COUNT) failures.push(`only ${shape.headers} of ${SECTION_COUNT} section headers rendered`)

  const pane = await page.evaluate(() => { const box = document.querySelector('.paper-view').getBoundingClientRect(); return { left: box.left, top: box.top, width: box.width, height: box.height } })
  const cursor = { x: Math.round(pane.left + pane.width * 0.45), y: Math.round(pane.top + pane.height * 0.5) }
  await page.mouse.move(cursor.x, cursor.y)
  await page.evaluate(() => { const view = document.querySelector('.paper-view'); view.scrollTop = Math.round(view.scrollHeight * 0.35); view.dispatchEvent(new Event('scroll')) })
  await sleep(1200)
  const cdp = await page.context().newCDPSession(page)
  const zoomNow = () => page.evaluate(() => { const paper = document.querySelector('.paper-view .unified-paper'); return paper.getBoundingClientRect().width / paper.offsetWidth })
  // A trackpad pinch: fractional ctrl+wheel deltas on the clock, one per frame.
  const pinch = async (factor, steps) => {
    const delta = (-100 * Math.log(factor)) / steps
    const sent = []
    for (let step = 0; step < steps; step += 1) {
      sent.push(cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: cursor.x, y: cursor.y, deltaX: 0, deltaY: delta + 0.013, modifiers: 2 }))
      await sleep(16)
    }
    await Promise.all(sent)
  }
  const notches = async (count, deltaY) => {
    const sent = []
    for (let step = 0; step < count; step += 1) {
      sent.push(cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: cursor.x, y: cursor.y, deltaX: 0, deltaY, modifiers: 2 }))
      await sleep(45)
    }
    await Promise.all(sent)
  }
  const clicks = (name, count) => async () => {
    const button = page.locator(`.paper-view-hud button[aria-label="${name}"]`).first()
    for (let step = 0; step < count; step += 1) { await button.click({ force: true }); await sleep(70) }
    await page.mouse.move(cursor.x, cursor.y)
  }
  const pinchTo = (target, steps) => async () => pinch(target / (await zoomNow()), steps)
  // The picture has come to rest: camera, bitmap and slice unchanged for 0.8 s.
  const rest = async () => {
    let last = ''
    let since = Date.now()
    const started = Date.now()
    while (Date.now() - started < 15_000) {
      const now = await page.evaluate(() => {
        const plane = document.querySelector('.paper-view .paper-sheet-plane')
        const canvas = document.querySelector('.paper-view canvas.lw-tablet-canvas-committed')
        return [plane?.className, plane?.style.zoom, plane?.style.transform, canvas?.width, canvas?.height, canvas?.style.top, canvas?.style.height].join('|')
      })
      if (now !== last) { last = now; since = Date.now() }
      else if (Date.now() - since >= 800) return
      await sleep(100)
    }
  }

  const run = async (label, act, { restyle = false } = {}) => {
    const detailed = traceCase && label.includes(traceCase)
    const tracing = detailed || cpuMode || restyle
    const profiling = profileCase && label.includes(profileCase)
    const before = await zoomNow()
    await page.evaluate(() => { window.__zoomPerf.watch() })
    let traceEvents = []
    let traceDone = null
    if (tracing) {
      const collected = (event) => { traceEvents = traceEvents.concat(event.value) }
      cdp.on('Tracing.dataCollected', collected)
      traceDone = new Promise((resolve) => cdp.once('Tracing.tracingComplete', () => { cdp.off('Tracing.dataCollected', collected); resolve() }))
      await cdp.send('Tracing.start', { categories: !detailed ? `toplevel${restyle ? ',devtools.timeline' : ''}` : 'devtools.timeline,disabled-by-default-devtools.timeline,blink.user_timing,v8.execute,toplevel,cc,viz,gpu,disabled-by-default-devtools.timeline.invalidationTracking', transferMode: 'ReportEvents' })
    }
    if (profiling) {
      await cdp.send('Profiler.enable')
      await cdp.send('Profiler.setSamplingInterval', { interval: 200 })
      await cdp.send('Profiler.start')
    }
    await page.evaluate(() => { const state = window.__zoomPerf; state.frames = []; state.tasks = []; state.inputs = []; state.mutations = 0; state.mutationSamples = []; state.on = true })
    await sleep(100)
    const startedAt = await page.evaluate(() => performance.now())
    await act()
    await rest()
    const data = await page.evaluate(() => { const state = window.__zoomPerf; state.on = false; return { frames: state.frames, tasks: state.tasks, inputs: state.inputs, mutations: state.mutations, mutationSamples: state.mutationSamples } })
    if (profiling) {
      const { profile } = await cdp.send('Profiler.stop')
      summariseProfile(profile)
    }
    if (tracing) {
      await cdp.send('Tracing.end')
      await traceDone
      if (detailed) summariseTrace(traceEvents)
    }
    const { frames, tasks, inputs } = data
    const firstInput = inputs[0] ?? startedAt
    const lastInput = inputs.at(-1) ?? startedAt
    const final = frames.at(-1)
    // From the first input until the bitmap the picture settles on is up.
    const sharpIndex = frames.findLastIndex((frame) => frame.bitmap !== final?.bitmap) + 1
    const sharpAt = frames[sharpIndex]?.t ?? lastInput
    const windowFrames = frames.filter((frame) => frame.t >= firstInput && frame.t <= Math.max(sharpAt, lastInput) + 50)
    const deltas = []
    for (let index = 1; index < windowFrames.length; index += 1) deltas.push(windowFrames[index].t - windowFrames[index - 1].t)
    const inWindow = tasks.filter((task) => task.start >= firstInput - 20)
    const result = {
      label,
      zoom: Math.round((await zoomNow()) * 100),
      from: Math.round(before * 100),
      frames: windowFrames.length,
      p50: Math.round(percentile(deltas, 0.5) * 10) / 10,
      p95: Math.round(percentile(deltas, 0.95) * 10) / 10,
      max: Math.round(Math.max(0, ...deltas)),
      over33: deltas.filter((delta) => delta > 33).length,
      over50: deltas.filter((delta) => delta > 50).length,
      tasks: inWindow.length,
      taskTotal: Math.round(inWindow.reduce((sum, task) => sum + task.duration, 0)),
      taskMax: Math.round(Math.max(0, ...inWindow.map((task) => task.duration))),
      sharpAfter: Math.max(0, Math.round(sharpAt - lastInput)),
      mutations: data.mutations,
      mutationSamples: data.mutationSamples,
    }
    const changes = []
    for (let index = 1; index < frames.length; index += 1) if (frames[index].bitmap !== frames[index - 1].bitmap) changes.push(`${Math.round(frames[index].t - lastInput)}ms ${frames[index].bitmap}`)
    result.bitmapChanges = changes.length
    if (report) console.log(`    bitmaps: ${changes.join(' | ')}`)
    if (tracing) {
      // CPU time (not wall time: the machine may be busy) per thread kind.
      const threadNames = new Map(traceEvents.filter((event) => event.name === 'thread_name').map((event) => [`${event.pid}:${event.tid}`, event.args?.name ?? '']))
      const cpu = { main: 0, raster: 0, viz: 0, compositor: 0 }
      for (const event of traceEvents) {
        if (event.ph !== 'X' || typeof event.tdur !== 'number' || !['ThreadControllerImpl::RunTask', 'TaskGraphRunner::RunTask'].includes(event.name)) continue
        const thread = threadNames.get(`${event.pid}:${event.tid}`) ?? ''
        const kind = thread === 'CrRendererMain' ? 'main' : thread.startsWith('ThreadPoolForegroundWorker') || thread.startsWith('CompositorTileWorker') ? 'raster' : thread === 'VizCompositorThread' ? 'viz' : thread === 'Compositor' ? 'compositor' : ''
        if (kind) cpu[kind] += event.tdur / 1000
      }
      result.cpu = Object.fromEntries(Object.entries(cpu).map(([key, ms]) => [key, Math.round(ms)]))
      console.log(`    cpu ms: main ${result.cpu.main}, raster ${result.cpu.raster}, viz ${result.cpu.viz}, compositor ${result.cpu.compositor}`)
    }
    if (restyle) {
      const main = new Set(traceEvents.filter((event) => event.name === 'thread_name' && event.args?.name === 'CrRendererMain').map((event) => `${event.pid}:${event.tid}`))
      result.restyled = Math.max(0, ...traceEvents.filter((event) => event.name === 'UpdateLayoutTree' && main.has(`${event.pid}:${event.tid}`)).map((event) => event.args?.elementCount ?? 0))
      console.log(`    the zoom commit restyled ${result.restyled} elements (at most ${MAX_RESTYLED})`)
      if (WITH_BANDS && result.restyled > MAX_RESTYLED) failures.push(`${label}: the zoom commit restyled ${result.restyled} elements (at most ${MAX_RESTYLED}): the section bands far from the view are restyled too`)
      if (!result.restyled) failures.push(`${label}: no restyle found in the trace`)
    }
    results.push(result)
    console.log(`${result.label.padEnd(30)} ${String(result.from).padStart(3)}->${String(result.zoom).padStart(3)} %  frames ${String(result.frames).padStart(3)}  p50 ${String(result.p50).padStart(5)}  p95 ${String(result.p95).padStart(5)}  max ${String(result.max).padStart(4)} ms  >33 ${String(result.over33).padStart(2)}  >50 ${String(result.over50).padStart(2)}  long tasks ${result.tasks} (${result.taskTotal} ms, longest ${result.taskMax})  sharp ${result.sharpAfter} ms  section writes ${result.mutations}`)
    if (report && result.mutationSamples.length) console.log(`    ${result.mutationSamples.join(' | ')}`)
    if (Math.abs(result.zoom - result.from) < 2) failures.push(`${label}: the zoom did not change (${result.zoom} %)`)
    if (WITH_BANDS && result.mutations > 0) failures.push(`${label}: the zoom rewrote the section bands ${result.mutations} times (${result.mutationSamples.join(' | ')})`)
    if (result.taskMax > LONGEST_TASK_MS * slack) failures.push(`${label}: a main-thread task took ${result.taskMax} ms (budget ${Math.round(LONGEST_TASK_MS * slack)} ms)`)
    if (result.sharpAfter > SHARP_BUDGET_MS * slack) failures.push(`${label}: sharp ink after ${result.sharpAfter} ms (budget ${Math.round(SHARP_BUDGET_MS * slack)} ms)`)
    return result
  }

  // Text mode (pen away): the zoom buttons are on the HUD.
  await run('pinch in 100 -> 250 %', pinchTo(2.5, 24), { restyle: true })
  await run('pinch out 250 -> 120 %', pinchTo(1.2, 24))
  await run('wheel notches in', () => notches(6, -100))
  await run('wheel notches out', () => notches(6, 100))
  await run('zoom button in (5 clicks)', clicks('Hineinzoomen', 5))
  await run('zoom button out (5 clicks)', clicks('Herauszoomen', 5))
  // With the pen out, as while writing.
  await page.keyboard.press('Control+d')
  await page.waitForFunction(() => Boolean(document.querySelector('.lw-view-reset')), null, { timeout: 15_000 })
  await sleep(900)
  await run('pen: pinch in -> 300 %', pinchTo(3, 24))
  await run('pen: pinch out -> 110 %', pinchTo(1.1, 24))
  await run('pen: wheel notches in', () => notches(6, -100))
  if (pageErrors.length) failures.push(`page errors: ${pageErrors.join('; ').slice(0, 400)}`)
} catch (error) {
  crashed = error
}
try { await browser?.close() } catch {}
try { process.kill(-child.pid, 'SIGTERM') } catch {}
await sleep(500)
fs.rmSync(temporary, { recursive: true, force: true })
if (results.length) {
  const all = results
  console.log(`summary: worst p95 ${Math.max(...all.map((r) => r.p95))} ms, frames > 50 ms ${all.reduce((s, r) => s + r.over50, 0)}, > 33 ms ${all.reduce((s, r) => s + r.over33, 0)}, long tasks ${all.reduce((s, r) => s + r.tasks, 0)} totalling ${all.reduce((s, r) => s + r.taskTotal, 0)} ms (longest ${Math.max(...all.map((r) => r.taskMax))}), sharp at most ${Math.max(...all.map((r) => r.sharpAfter))} ms after the last input, section band writes ${all.reduce((s, r) => s + r.mutations, 0)}`)
}
if (results.some((result) => result.cpu)) {
  const total = (key) => results.reduce((sum, result) => sum + (result.cpu?.[key] ?? 0), 0)
  console.log(`cpu summary: main ${total('main')} ms, raster ${total('raster')} ms, viz ${total('viz')} ms, compositor ${total('compositor')} ms`)
}
if (crashed) {
  console.error(crashed instanceof Error ? crashed.stack : crashed)
  process.exit(1)
}
if (failures.length) {
  console.error(failures.join('\n'))
  process.exit(1)
}
console.log('zoom sections perf: ok')
process.exit(0)
