// Zooming a handwriting note keeps the ink on the paper in every frame.
//
// Drives the real app (Electron under Xvfb) over CDP on a long, heavy grid note
// with a left and a right column of writing, at device pixel ratio 2 and 1.
// The note carries red dots at known places on the sheet. Every frame is
// sampled right before paint: every canvas in the pane is composited the way
// the screen shows it (its bitmap stretched into its on-screen box) and each
// dot whose place is on screen is looked up there. A frame fails when
//   moved    a dot is not where the paper puts it (more than 1.5 CSS px off,
//            or three quarters of a bitmap px while the old bitmap is scaled up)
//   missing  a dot that belongs on screen is not painted (a stale slice of
//            the page, a bitmap stretched into the wrong box, a clipped area)
// Cases, with the pen out and with it away: a trackpad pinch from about 140 %
// to the maximum (500 %) and back, a pinch that turns round, one down to the
// minimum, Ctrl+wheel notches, the keyboard (Ctrl++ / Ctrl+-) and the zoom
// buttons. Without the picture sampling (which costs frame time) the same
// zooms are timed at device pixel ratio 1: the sharp bitmap must be on screen
// within the budget after the last input, and the toolbar percentage must
// follow the picture.
// FANOTES_ZOOM_INK_DUMP=1 prints every changed frame; FANOTES_ZOOM_INK_MEASURE=1
// reports without failing. Needs a built renderer (`vite build`), xvfb-run and
// playwright-core (PLAYWRIGHT_CORE); FANOTES_SKIP_BROWSER=1 skips it.
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
  console.log(`zoom ink registration: skipped (${missing})`)
  process.exit(0)
}
const dump = process.env.FANOTES_ZOOM_INK_DUMP === '1'
// Run (sample) only the cases whose name contains this; the others still zoom.
const only = process.env.FANOTES_ZOOM_INK_ONLY || ''
const measureOnly = process.env.FANOTES_ZOOM_INK_MEASURE === '1'
const scales = (process.env.FANOTES_ZOOM_INK_DPR || '2,1').split(',').map(Number).filter((value) => value > 0)
// Time budgets leave room for a slow runner (software rendering under Xvfb).
const budgetScale = Number(process.env.FANOTES_ZOOM_INK_BUDGET_SCALE || 1)
/** Last zoom input to the sharp bitmap on screen. */
const SHARP_BUDGET_MS = 500
/** The toolbar percentage may trail the picture by this much. */
const LABEL_BUDGET_MS = 150
/** A dot further than this from its place on the paper is a moved frame (CSS px). */
const MOVED_PX = 1.5

const at = '2026-11-01T00:00:00.000Z'
const SHEET_WIDTH = 1224
const SHEET_HEIGHT = 5200
// Handwriting in two columns, one stroke per word: well above the 8,000
// points from which a page is painted across frames (the heavy repaint).
const writing = []
for (let line = 0; line < 150; line += 1) {
  for (let word = 0; word < 6; word += 1) {
    const column = word < 3 ? 0.06 : 0.56
    const x0 = column + (word % 3) * 0.13
    const y0 = 0.012 + line * 0.0065
    writing.push({
      color: word % 4 === 0 ? '#1f4fb3' : '#202333', baseWidth: 3, pressureEnabled: true, brush: 'fineliner',
      points: Array.from({ length: 24 }, (_, k) => ({
        x: x0 + (k / 24) * 0.11, y: y0 + Math.sin(k / 2.2 + line + word) * 0.0012, t: k * 8, pressure: 0.4 + 0.2 * Math.sin(k / 5), tiltX: 0, tiltY: 0, pointerType: 'pen',
      })),
    })
  }
}
// Red dots on a lattice over the whole sheet, the last column near its right
// edge: the places the check looks at.
const DOT_COLUMNS = Array.from({ length: 23 }, (_, index) => Math.round((0.03 + index * 0.0425) * 10000) / 10000)
const DOT_ROW_GAP = 0.0065 * 2
const dots = []
for (let row = 0; row * DOT_ROW_GAP + 0.0185 < 0.99; row += 1) {
  for (const x of DOT_COLUMNS) {
    const y = 0.0185 + row * DOT_ROW_GAP
    dots.push({ x, y })
    writing.push({
      color: '#ff0000', baseWidth: 9, pressureEnabled: false, brush: 'fineliner',
      points: Array.from({ length: 6 }, (_, k) => ({
        x: x + Math.cos(k * 1.05) * 0.0006, y: y + Math.sin(k * 1.05) * 0.00014, t: k * 8, pressure: 0.5, tiltX: 0, tiltY: 0, pointerType: 'pen',
      })),
    })
  }
}
const inkPage = { schemaVersion: 1, title: 'Seite', paperStyle: 'grid', sourceWidth: SHEET_WIDTH, sourceHeight: SHEET_HEIGHT, createdAt: at, updatedAt: at, strokes: writing }
const noteBody = '# Zoomprobe\n\nHandschrift in zwei Spalten.\n'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// Runs in the page: samples every frame right before paint.
const installSampler = (dotList) => {
  if (window.__zoomInk) return
  const state = { frames: [], inputs: [], dots: dotList, calibrated: null, on: false }
  window.__zoomInk = state
  window.addEventListener('wheel', (event) => { if (event.ctrlKey) state.inputs.push(performance.now()) }, true)
  window.addEventListener('keydown', (event) => { if (event.ctrlKey && event.key !== 'Control') state.inputs.push(performance.now()) }, true)
  window.addEventListener('click', () => { state.inputs.push(performance.now()) }, true)
  const scratch = document.createElement('canvas')
  const context = scratch.getContext('2d', { willReadFrequently: true })
  let probe = null
  const hidden = (element, stop) => {
    for (let node = element; node && node !== stop.parentElement; node = node.parentElement) {
      const style = getComputedStyle(node)
      if (style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity) < 0.05) return true
    }
    return false
  }
  // The pane as the screen shows it, one scratch px per S CSS px.
  const S = 2
  const composite = (view, viewBox) => {
    const width = Math.max(1, Math.ceil(viewBox.width / S))
    const height = Math.max(1, Math.ceil(viewBox.height / S))
    if (scratch.width !== width || scratch.height !== height) { scratch.width = width; scratch.height = height }
    else context.clearRect(0, 0, width, height)
    const boxes = []
    for (const canvas of view.querySelectorAll('canvas')) {
      const rect = canvas.getBoundingClientRect()
      const name = canvas.classList.contains('lw-tablet-canvas-committed') ? 'committed' : canvas.className.split(' ').at(-1)?.slice(0, 18) ?? ''
      boxes.push([name, canvas.width, canvas.height, Math.round(rect.left * 10) / 10, Math.round(rect.top * 10) / 10, Math.round(rect.width * 10) / 10, Math.round(rect.height * 10) / 10])
      if (!canvas.width || !canvas.height || rect.width < 1 || rect.height < 1 || hidden(canvas, view)) continue
      if (rect.right < viewBox.left || rect.left > viewBox.right || rect.bottom < viewBox.top || rect.top > viewBox.bottom) continue
      context.drawImage(canvas, (rect.left - viewBox.left) / S, (rect.top - viewBox.top) / S, rect.width / S, rect.height / S)
    }
    return { width, height, boxes, data: context.getImageData(0, 0, width, height).data }
  }
  const isDot = (data, index) => data[index + 3] > 90 && data[index] > 150 && data[index + 1] < 110 && data[index + 2] < 110
  // Red pixels in a window around a point: how many and where their centre is.
  const lookAt = (picture, x, y, half) => {
    const x0 = Math.max(0, Math.floor((x - half) / S))
    const x1 = Math.min(picture.width - 1, Math.ceil((x + half) / S))
    const y0 = Math.max(0, Math.floor((y - half) / S))
    const y1 = Math.min(picture.height - 1, Math.ceil((y + half) / S))
    let count = 0
    let sumX = 0
    let sumY = 0
    for (let row = y0; row <= y1; row += 1) {
      for (let column = x0; column <= x1; column += 1) {
        if (isDot(picture.data, (row * picture.width + column) * 4)) { count += 1; sumX += column + 0.5; sumY += row + 0.5 }
      }
    }
    return { count: count * S * S, x: count ? (sumX / count) * S : 0, y: count ? (sumY / count) * S : 0 }
  }
  const geometry = () => {
    const view = document.querySelector('.paper-view')
    const paper = view?.querySelector('.unified-paper')
    if (!view || !paper || !paper.offsetWidth) return null
    const viewBox = view.getBoundingClientRect()
    const paperBox = paper.getBoundingClientRect()
    return { view, paper, viewBox, paperBox, scale: paperBox.width / paper.offsetWidth }
  }
  // Where the dots sit on the sheet, from the settled picture: the dots are a
  // lattice, so a straight line through the ones on screen gives every dot's
  // place (layout px from the paper corner) far closer than one reading.
  state.calibrate = () => {
    const g = geometry()
    if (!g) return 'no paper'
    const picture = composite(g.view, g.viewBox)
    const left = g.paperBox.left - g.viewBox.left
    const top = g.paperBox.top - g.viewBox.top
    const seenDots = []
    for (const dot of state.dots) {
      const x = left + dot.x * g.paperBox.width
      const y = top + dot.y * g.paperBox.height
      const half = 12 * g.scale
      if (x - half < 2 || y - half < 2 || x + half > g.viewBox.width - 2 || y + half > g.viewBox.height - 2) continue
      const seen = lookAt(picture, x, y, half)
      if (seen.count < 24) continue
      seenDots.push({ fx: dot.x, fy: dot.y, lx: (seen.x - left) / g.scale, ly: (seen.y - top) / g.scale, area: seen.count / (g.scale * g.scale) })
    }
    if (seenDots.length < 12) return `only ${seenDots.length} dots on screen`
    const line = (pairs) => {
      const n = pairs.length
      const meanA = pairs.reduce((sum, pair) => sum + pair[0], 0) / n
      const meanB = pairs.reduce((sum, pair) => sum + pair[1], 0) / n
      const slope = pairs.reduce((sum, pair) => sum + (pair[0] - meanA) * (pair[1] - meanB), 0) / pairs.reduce((sum, pair) => sum + (pair[0] - meanA) ** 2, 0)
      return { slope, offset: meanB - slope * meanA }
    }
    const across = line(seenDots.map((dot) => [dot.fx, dot.lx]))
    const down = line(seenDots.map((dot) => [dot.fy, dot.ly]))
    const area = seenDots.reduce((sum, dot) => sum + dot.area, 0) / seenDots.length
    const residual = Math.max(...seenDots.map((dot) => Math.hypot(across.offset + across.slope * dot.fx - dot.lx, down.offset + down.slope * dot.fy - dot.ly)))
    state.calibrated = state.dots.map((dot) => ({ fx: dot.x, fy: dot.y, lx: across.offset + across.slope * dot.x, ly: down.offset + down.slope * dot.y, area }))
    return { seen: seenDots.length, rightmost: Math.max(...seenDots.map((dot) => dot.fx)), residual, across, down, sheetWidth: g.paper.offsetWidth }
  }
  const sample = () => {
    if (!state.on || !state.calibrated) return
    const started = performance.now()
    const g = geometry()
    if (!g) { state.frames.push({ t: started, gone: true }); return }
    const plane = g.view.querySelector('.paper-sheet-plane')
    const label = document.querySelector('.lw-view-reset')?.textContent?.trim() ?? ''
    if (state.light) {
      // Timing only: no picture, so the sampling does not slow the app down.
      const canvas = g.view.querySelector('canvas.lw-tablet-canvas-committed')
      const rect = canvas?.getBoundingClientRect()
      state.frames.push({
        t: started, cost: performance.now() - started, scale: g.scale, looked: 99, missing: 0, moved: 0, worst: 0, rightmost: 0, detail: '',
        preview: Boolean(plane?.classList.contains('is-zoom-gesture') || plane?.style.transform),
        zoom: Number.parseFloat(plane?.style.zoom || '1') || 1,
        bitmap: canvas ? `${canvas.width}x${canvas.height}` : '',
        box: rect ? [rect.left, rect.top, rect.width, rect.height].map((value) => Math.round(value * 10) / 10).join(',') : '',
        slice: canvas ? `${canvas.style.top} ${canvas.style.height}` : '',
        label,
      })
      return
    }
    const picture = composite(g.view, g.viewBox)
    const left = g.paperBox.left - g.viewBox.left
    const top = g.paperBox.top - g.viewBox.top
    // One bitmap px can be several screen px while a zoom in still shows the
    // old bitmap: a dot cannot sit closer to its place than that grid allows.
    const inkCanvas = g.view.querySelector('canvas.lw-tablet-canvas-committed')
    const grain = inkCanvas?.width ? inkCanvas.getBoundingClientRect().width / inkCanvas.width : 1
    const limit = Math.max(state.movedPx, grain * 0.75)
    let looked = 0
    let missing = 0
    let moved = 0
    let worst = 0
    let rightmost = 0
    let detail = ''
    for (const dot of state.calibrated) {
      const x = left + dot.lx * g.scale
      const y = top + dot.ly * g.scale
      const half = 8 * g.scale + 6
      if (x - half < 1 || y - half < 1 || x + half > g.viewBox.width - 1 || y + half > g.viewBox.height - 1) continue
      looked += 1
      rightmost = Math.max(rightmost, dot.fx)
      const seen = lookAt(picture, x, y, half)
      const expected = dot.area * g.scale * g.scale
      if (seen.count < expected * 0.45) {
        missing += 1
        if (!detail) detail = `missing dot at ${dot.fx},${dot.fy.toFixed(3)} (${seen.count} of ${Math.round(expected)} px)`
        continue
      }
      const off = Math.hypot(seen.x - x, seen.y - y)
      if (off > worst) worst = off
      if (off > limit) {
        moved += 1
        if (!detail) detail = `dot at ${dot.fx},${dot.fy.toFixed(3)} is ${off.toFixed(1)} px off (${(seen.x - x).toFixed(1)}, ${(seen.y - y).toFixed(1)})`
      }
    }
    const committed = picture.boxes.find((box) => box[0] === 'committed')
    state.frames.push({
      t: started,
      cost: performance.now() - started,
      scale: g.scale,
      looked, missing, moved, worst, rightmost, detail,
      preview: Boolean(plane?.classList.contains('is-zoom-gesture') || plane?.style.transform),
      zoom: Number.parseFloat(plane?.style.zoom || '1') || 1,
      bitmap: committed ? `${committed[1]}x${committed[2]}` : '',
      box: committed ? committed.slice(3).join(',') : '',
      slice: (() => { const canvas = g.view.querySelector('canvas.lw-tablet-canvas-committed'); return canvas ? `${canvas.style.top} ${canvas.style.height}` : '' })(),
      label,
    })
  }
  const tick = () => {
    if (!probe && document.documentElement) {
      probe = document.createElement('div')
      probe.style.cssText = 'position:fixed;left:0;top:0;width:1px;height:1px;opacity:0;pointer-events:none'
      document.documentElement.appendChild(probe)
    }
    if (probe && state.on) {
      const observer = new ResizeObserver(() => { observer.disconnect(); sample() })
      observer.observe(probe)
    }
    requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
}

const results = []
const failures = []

const runAt = async (scale) => {
  const temporary = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'fanotes-zoom-ink-'))
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

  const port = 19_300 + Math.floor(Math.random() * 600)
  const child = spawn(xvfb, ['-a', '-s', `-screen 0 ${1440 * scale}x${900 * scale}x24`, executable, root, `--remote-debugging-port=${port}`, '--no-sandbox', `--force-device-scale-factor=${scale}`], {
    env: { ...process.env, HOME: home, XDG_CONFIG_HOME: configHome, XDG_RUNTIME_DIR: runtime },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  })
  let output = ''
  child.stdout.on('data', (chunk) => { output += chunk })
  child.stderr.on('data', (chunk) => { output += chunk })
  let browser
  let failure = null
  const tag = `dpr ${scale}`
  // Times are held to their budgets at device pixel ratio 1 only: at 2 the
  // software renderer under Xvfb needs 100 ms and more for a frame of a
  // 2880x1800 window, which says nothing about the app. They are still printed.
  const timed = scale === 1 || process.env.FANOTES_ZOOM_INK_TIME_ALL === '1'
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
    if (process.env.FANOTES_ZOOM_INK_TRACE === '1') page.on('console', (message) => { if (message.text().startsWith('ZT ')) console.log(`      ${message.text()}`) })
    await page.waitForFunction(() => Boolean(window.fanotes && document.querySelector('.paper-view .unified-paper canvas')), null, { timeout: 90_000 })
    await page.evaluate(`(${installSampler.toString()})(${JSON.stringify(dots)})`)
    await page.evaluate((limit) => { window.__zoomInk.movedPx = limit }, MOVED_PX)
    await sleep(2500)
    assert.equal(await page.evaluate(() => window.devicePixelRatio), scale, 'device pixel ratio')

    const pane = await page.evaluate(() => { const box = document.querySelector('.paper-view').getBoundingClientRect(); return { left: box.left, top: box.top, width: box.width, height: box.height } })
    const cursor = { x: Math.round(pane.left + pane.width * 0.42), y: Math.round(pane.top + pane.height * 0.5) }
    await page.mouse.move(cursor.x, cursor.y)
    const cdp = await page.context().newCDPSession(page)
    // A trackpad pinch: ctrl+wheel events with small fractional deltas, one per frame.
    // They are sent on the clock, not one after the other's answer: a slow
    // frame must not stretch the gesture into separate zooms.
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
    const zoomNow = () => page.evaluate(() => { const paper = document.querySelector('.paper-view .unified-paper'); return paper.getBoundingClientRect().width / paper.offsetWidth })
    const calibrate = async () => {
      const found = await page.evaluate(() => window.__zoomInk.calibrate())
      assert.ok(found && typeof found === 'object', `calibration: ${found}`)
      return found
    }

    // The pen is out, as while writing: the toolbar shows the zoom percentage.
    await page.keyboard.press('Control+d')
    await page.waitForFunction(() => Boolean(document.querySelector('.lw-view-reset')), null, { timeout: 15_000 })
    // Start: about 140 %, scrolled into the page so the ink slice is not at its top.
    await pinch(1.4 / (await zoomNow()), 12)
    await sleep(1200)
    await page.evaluate(() => { const view = document.querySelector('.paper-view'); view.scrollTop = Math.round(view.scrollHeight * 0.3); view.dispatchEvent(new Event('scroll')) })
    await sleep(1200)
    const found = await calibrate()
    assert.ok(found.seen >= 20, `${tag}: the settled page shows its dots (${found.seen})`)
    assert.ok(found.rightmost > 0.6, `${tag}: dots of the right column are on screen at the start`)
    // The dots are where the note has them: the settled picture is the page,
    // to the pixel, not a shifted or stretched copy of it.
    assert.ok(found.residual < 0.75, `${tag}: the settled dots sit on their lattice (worst ${found.residual.toFixed(2)} px off)`)
    assert.ok(Math.abs(found.across.slope - found.sheetWidth) < 2 && Math.abs(found.across.offset) < 2, `${tag}: the ink spans the sheet (0 to 1 is ${found.across.offset.toFixed(1)} to ${(found.across.offset + found.across.slope).toFixed(1)} px of ${found.sheetWidth})`)

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
    // `timing` samples no picture: how long the app itself takes to the sharp bitmap.
    const run = async (label, act, { timing = false, changes = true } = {}) => {
      if (only && !`${timing ? 'timing ' : ''}${label}`.includes(only)) { await act(); await rest(); return { zoom: 500 } }
      const before = await zoomNow()
      await page.evaluate((light) => { const state = window.__zoomInk; state.frames = []; state.inputs = []; state.light = light; state.on = true }, timing)
      await sleep(120)
      await act()
      await rest()
      const { frames, inputs } = await page.evaluate(() => { const state = window.__zoomInk; state.on = false; return { frames: state.frames, inputs: state.inputs } })
      const lastInput = inputs.at(-1) ?? frames[0]?.t ?? 0
      const final = frames.at(-1)
      const bad = frames.filter((frame) => frame.gone || frame.missing || frame.moved)
      const badMs = bad.length ? Math.round(bad.at(-1).t - bad[0].t + 16) : 0
      // Sharp: the bitmap the picture settles on is on screen (its size and
      // the rows of the sheet it holds), also while the camera is still a preview.
      const sharpIndex = frames.findLastIndex((frame) => frame.bitmap !== final.bitmap || frame.slice !== final.slice) + 1
      const sharpAfter = Math.max(0, Math.round((frames[sharpIndex]?.t ?? lastInput) - lastInput))
      // The percentage against the picture: for how long the label showed a
      // zoom the picture had already left (one frame behind is not a lag).
      let labelLag = 0
      let agreedAt = frames[0]?.t ?? 0
      for (const frame of frames) {
        const shown = Number.parseInt(frame.label, 10)
        if (!frame.label || Math.abs(shown - frame.scale * 100) <= 1.5) agreedAt = frame.t
        else {
          // The last frame whose picture was what the label says now.
          const match = frames.findLast((earlier) => earlier.t < frame.t && Math.abs(shown - earlier.scale * 100) <= 1.5)
          labelLag = Math.max(labelLag, frame.t - Math.max(agreedAt, match?.t ?? 0))
        }
      }
      const commitFrame = frames.find((frame) => frame.t >= lastInput && !frame.preview && Math.abs(frame.zoom - final.zoom) < 0.0005)
      const committedAfter = commitFrame ? Math.round(commitFrame.t - lastInput) : -1
      const result = {
        timed: timing && timed,
        committedAfter,
        label: `${tag} ${label}`,
        frames: frames.length,
        looked: Math.min(...frames.map((frame) => frame.looked ?? 0)),
        bad: bad.length,
        badMs,
        missing: frames.filter((frame) => frame.missing).length,
        moved: frames.filter((frame) => frame.moved).length,
        worst: Math.round(Math.max(0, ...frames.map((frame) => frame.worst ?? 0)) * 10) / 10,
        sharpAfter,
        labelLag: Math.round(labelLag),
        zoom: Math.round(final.scale * 100),
        rightmost: Math.max(0, ...frames.map((frame) => frame.rightmost ?? 0)),
        sampleCost: Math.round(Math.max(...frames.map((frame) => frame.cost ?? 0)) * 10) / 10,
      }
      results.push(result)
      console.log(timing
        ? `${!timed ? '-- ' : sharpAfter > SHARP_BUDGET_MS * budgetScale || result.labelLag > LABEL_BUDGET_MS * budgetScale ? 'BAD' : 'ok '} ${result.label}: to ${result.zoom} %, sharp ink ${sharpAfter} ms after the last input (layout zoom after ${committedAfter} ms), percentage trails the picture by at most ${result.labelLag} ms (${frames.length} frames)`
        : `${bad.length ? 'BAD' : 'ok '} ${result.label}: to ${result.zoom} %, ${frames.length} frames, at least ${result.looked} dots on screen (rightmost column ${result.rightmost}), ${bad.length} bad over ${badMs} ms (${result.missing} with missing ink, ${result.moved} with moved ink), worst offset ${result.worst} px, sampling up to ${result.sampleCost} ms a frame`)
      if (dump || bad.length) {
        let previous = ''
        let shown = 0
        for (const frame of frames) {
          if (!dump && !(frame.missing || frame.moved || frame.gone)) continue
          if (dump && timing) { console.log(`    ${String(Math.round(frame.t - lastInput)).padStart(6)} ms ${frame.preview ? 'preview' : 'layout '} zoom ${frame.zoom} x${frame.scale?.toFixed(3)} bitmap ${frame.bitmap} slice ${frame.slice} label ${frame.label}`); continue }
          const line = `${frame.preview ? 'preview' : 'layout '} zoom ${frame.zoom} x${frame.scale?.toFixed(3)} bitmap ${frame.bitmap} box ${frame.box} label ${frame.label} dots ${frame.looked} missing ${frame.missing} moved ${frame.moved} ${frame.detail}`
          if (line === previous) continue
          previous = line
          shown += 1
          if (shown <= (dump ? 400 : 6)) console.log(`    ${String(Math.round(frame.t - lastInput)).padStart(6)} ms ${line}`)
        }
      }
      if (changes && Math.abs(final.scale - before) < 0.02) failures.push(`${result.label}: the zoom did not change (${result.zoom} %)`)
      if (result.looked < 3) failures.push(`${result.label}: only ${result.looked} dots on screen in some frame (the check lost the page)`)
      if (bad.length) failures.push(`${result.label}: ${bad.length} frames over ${badMs} ms with ink off the paper (${result.missing} missing, ${result.moved} moved, worst ${result.worst} px)`)
      if (timing && timed && sharpAfter > SHARP_BUDGET_MS * budgetScale) failures.push(`${result.label}: sharp ink after ${sharpAfter} ms (budget ${Math.round(SHARP_BUDGET_MS * budgetScale)} ms)`)
      if (timing && timed && result.labelLag > LABEL_BUDGET_MS * budgetScale) failures.push(`${result.label}: the zoom percentage trailed the picture by ${result.labelLag} ms (budget ${Math.round(LABEL_BUDGET_MS * budgetScale)} ms)`)
      return result
    }

    const pinchTo = (target, steps) => async () => pinch(target / (await zoomNow()), steps)
    const keys = (key, count) => async () => { for (let step = 0; step < count; step += 1) { await page.keyboard.press(key); await sleep(90) } }
    const up = await run('pinch in to the maximum', pinchTo(5.2, 26))
    assert.ok(up.zoom >= 495, `${tag}: the pinch reached the maximum (${up.zoom} %)`)
    await run('pinch out to 150 %', pinchTo(1.5, 26))
    await run('pinch in a little (150 % to 230 %)', pinchTo(2.3, 10))
    await run('wheel notches in', () => notches(6, -100))
    await run('wheel notches out', () => notches(8, 100))
    // The board takes the keys while the pen is out.
    await page.evaluate(() => document.querySelector('.lw-drawing-board')?.focus({ preventScroll: true }))
    await run('keyboard in (Ctrl++ three times)', keys('Control+Equal', 3))
    await run('keyboard out (Ctrl+- three times)', keys('Control+Minus', 3))
    // A pinch that turns round before the page was re-rastered.
    await run('pinch in and straight back out', async () => { await pinchTo(4.6, 14)(); await sleep(260); await pinch(1.6 / 4.6, 14) })
    // A zoom far out, where the visible sheet outgrows the slice the bitmap had.
    await run('pinch out to the minimum', pinchTo(0.4, 20))
    await run('pinch back in to 140 %', pinchTo(1.4, 16))
    // The same page while typing (the pen put away).
    await page.keyboard.press('Control+d')
    await sleep(900)
    await run('text mode: pinch in to 400 %', pinchTo(4, 20))
    await run('text mode: pinch out to 140 %', pinchTo(1.4, 20))
    // The zoom buttons (shown while the pen is away).
    const clicks = (name, count) => async () => {
      const button = page.locator(`.paper-view-hud button[aria-label="${name}"]`).first()
      for (let step = 0; step < count; step += 1) { await button.click({ force: true }); await sleep(70) }
      await page.mouse.move(cursor.x, cursor.y)
    }
    await run('text mode: zoom button in (five clicks)', clicks('Hineinzoomen', 5))
    await run('text mode: zoom button out (five clicks)', clicks('Herauszoomen', 5))
    await page.keyboard.press('Control+d')
    await sleep(900)
    // Without the picture sampling: how long the app takes, and the percentage.
    await run('pinch in to the maximum', pinchTo(5.2, 26), { timing: true })
    await run('pinch out to 150 %', pinchTo(1.5, 26), { timing: true })
    await run('wheel notches in', () => notches(6, -100), { timing: true })
    await page.evaluate(() => document.querySelector('.lw-drawing-board')?.focus({ preventScroll: true }))
    await run('keyboard out (Ctrl+- three times)', keys('Control+Minus', 3), { timing: true })
    if (pageErrors.length) failures.push(`${tag}: page errors: ${pageErrors.join('; ').slice(0, 400)}`)
  } catch (error) {
    failure = error
  }
  try { await browser?.close() } catch {}
  try { process.kill(-child.pid, 'SIGTERM') } catch {}
  await sleep(500)
  fs.rmSync(temporary, { recursive: true, force: true })
  if (failure) throw failure
}

let crashed = null
for (const scale of scales) {
  try { await runAt(scale) } catch (error) { crashed = error; break }
}
if (results.length) {
  const frames = results.reduce((sum, result) => sum + result.frames, 0)
  const bad = results.reduce((sum, result) => sum + result.bad, 0)
  console.log(`summary: ${results.length} zooms, ${frames} frames, ${bad} with ink off the paper; sharp ink at most ${Math.max(0, ...results.filter((result) => result.timed).map((result) => result.sharpAfter))} ms after the last input and the percentage at most ${Math.max(0, ...results.filter((result) => result.timed).map((result) => result.labelLag))} ms behind (device pixel ratio 1)`)
}
if (crashed) {
  console.error(crashed instanceof Error ? crashed.stack : crashed)
  process.exit(1)
}
if (failures.length && !measureOnly) {
  console.error(failures.join('\n'))
  process.exit(1)
}
console.log(measureOnly ? 'zoom ink registration: measured' : 'zoom ink registration: ok')
process.exit(0)
