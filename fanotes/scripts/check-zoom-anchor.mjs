// Smooth view movement: the zoom stays anchored under the cursor or the
// fingers, and no frame shows a blank sheet while zooming.
//
// Part 1 (node): the pinch wheel mapping, the frame-sampled two-finger
// gesture and the live preview anchor.
// Part 2 (browser, web build via the vite dev server): on a long Markdown
// note with ink, a ctrl+wheel zoom and a touch pinch keep the text line under
// the cursor / fingers on every painted frame (no jump when the zoom commits),
// and the ink bitmap never goes blank; on a PDF, every frame keeps a painted
// page bitmap and the page is sharp shortly after the gesture.
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createServer } from 'vite'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const server = await createServer({
  root,
  logLevel: 'error',
  // The app config pins 5173; any free port will do here.
  server: { host: '127.0.0.1', port: 5390 + Math.floor(Math.random() * 9), strictPort: false, fs: { strict: false } },
})
await server.listen()

// ---- Part 1: node -------------------------------------------------------
const {
  PAPER_ZOOM_GESTURE_SETTLE_MS,
  PAPER_ZOOM_PINCH_SETTLE_MS,
  SHEET_ZOOM_REPAINT_DEBOUNCE_MS,
  isPinchZoomWheel,
  paperZoomGestureScreenAnchor,
  zoomFactorFromWheel,
  zoomFactorFromWheelEvent,
} = await server.ssrLoadModule('/src/lib/paperView.ts')
const {
  createHandGestureState,
  handGestureMoveBatch,
  handGestureSample,
} = await server.ssrLoadModule(join(root, '../src/lib/handGestures.ts'))

{
  // Chromium sends a trackpad pinch as ctrl+wheel with deltaY = -100·ln(scale).
  const steps = 24
  let zoom = 1
  for (let i = 0; i < steps; i += 1) {
    const deltaY = (-100 * Math.log(2)) / steps + 0.000123
    const event = { deltaY, deltaMode: 0 }
    assert.equal(isPinchZoomWheel(event), true, 'fractional small deltas are a pinch')
    zoom *= zoomFactorFromWheelEvent(event, 5)
  }
  assert.ok(Math.abs(zoom - 2) < 0.02, `a 2x finger spread zooms 2x, got ${zoom.toFixed(3)}`)
  // Mouse notches keep the notch curve and the user's zoom speed.
  for (const deltaY of [100, -100, 120, -120, 53, 3]) {
    for (const speed of [1, 5, 10]) {
      assert.equal(
        zoomFactorFromWheelEvent({ deltaY, deltaMode: 0 }, speed),
        zoomFactorFromWheel(deltaY, 0, speed),
        `notch ${deltaY} at speed ${speed} is unchanged`,
      )
    }
  }
  assert.equal(zoomFactorFromWheelEvent({ deltaY: 1.5, deltaMode: 1 }, 5), zoomFactorFromWheel(1.5, 1, 5), 'line mode is a notch')
  assert.ok(PAPER_ZOOM_PINCH_SETTLE_MS < PAPER_ZOOM_GESTURE_SETTLE_MS, 'a pinch pause ends it sooner than a notch pause')
  assert.ok(SHEET_ZOOM_REPAINT_DEBOUNCE_MS <= 50, 'a committed zoom re-rasters within a few frames')
}

{
  // A straight two-finger pan: per-event sampling reads it as a pinch and its
  // reverse; one sample per frame is a clean pan.
  let state = createHandGestureState()
  state = handGestureSample(state, { id: 1, phase: 'down', pointerType: 'touch', x: 100, y: 300 }).state
  state = handGestureSample(state, { id: 2, phase: 'down', pointerType: 'touch', x: 220, y: 300 }).state
  const perEvent = handGestureSample(state, { id: 1, phase: 'move', pointerType: 'touch', x: 100, y: 260 })
  assert.notEqual(perEvent.frame?.pinch ?? 1, 1, 'one finger at a time looks like a pinch')
  const batch = handGestureMoveBatch(state, new Map([[1, { x: 100, y: 260 }], [2, { x: 220, y: 260 }]]))
  assert.equal(batch.frame.pinch, 1, 'both fingers together are a pan')
  assert.equal(batch.frame.panY, -40)
  assert.equal(handGestureMoveBatch(state, new Map([[9, { x: 0, y: 0 }]])).frame, null, 'an unknown pointer is ignored')
}

{
  // The preview scales around anchor O; O is on screen at rect.left + O·zoom
  // whatever the scale and the pan scroll.
  const plane = { getBoundingClientRect: () => ({ left: -120, top: -900, width: 2000, height: 6000 }) }
  const anchor = paperZoomGestureScreenAnchor(plane, { zoom: 2, anchorLocalX: 300, anchorLocalY: 700, origin: { x: 0, y: 0 } })
  assert.deepEqual(anchor, { x: 480, y: 500 })
}
console.log('zoom anchor: node part ok')

// ---- Part 2: browser ----------------------------------------------------
const chromium = process.env.FANOTES_CHROMIUM ?? '/usr/bin/chromium'
const playwrightEntry = process.env.PLAYWRIGHT_CORE ?? '/srv/agents/fanotes/.site-redesign-tools/node_modules/playwright-core/index.mjs'
if (process.env.FANOTES_SKIP_BROWSER === '1' || !existsSync(chromium) || !existsSync(playwrightEntry)) {
  console.log('zoom anchor: browser part skipped (no chromium / playwright-core)')
  await server.close()
  process.exit(0)
}
const { chromium: browserType } = await import(pathToFileURL(playwrightEntry).href)
const base = `http://127.0.0.1:${server.httpServer.address().port}`

// Synthetic note: long text (CodeMirror estimates the lines it has not laid
// out) and a band of ink.
let seed = 99
const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296
const words = 'the quick brown fox jumps over lazy dog energy momentum integral derivative vector matrix function limit series'.split(' ')
const markdown = Array.from({ length: 160 }, (_, i) => `${i % 10 === 0 ? `## Part ${i / 10}\n\n` : ''}${Array.from({ length: 40 + Math.floor(rnd() * 60) }, () => words[Math.floor(rnd() * words.length)]).join(' ')}`).join('\n\n')
const strokes = Array.from({ length: 120 }, (_, s) => ({
  color: '#202333',
  baseWidth: 3.5,
  brush: 'fineliner',
  pressureEnabled: true,
  points: Array.from({ length: 30 }, (_, i) => ({ x: 0.06 + (s % 12) * 0.075 + i * 0.0016, y: 0.03 + Math.floor(s / 12) * 0.02 + Math.sin(i / 3 + s) * 0.004, t: i * 8, pressure: 0.5, tiltX: 0, tiltY: 0, pointerType: 'pen' })),
}))
const now = '2026-11-01T00:00:00.000Z'
const drawingId = 'zoom_anchor_note'
const drawing = { schemaVersion: 1, title: 'zoom', paperStyle: 'lines', sourceWidth: 900, sourceHeight: 1273, createdAt: now, updatedAt: now, strokes }

const buildPdf = (count) => {
  const objs = []
  objs[1] = '<< /Type /Catalog /Pages 2 0 R >>'
  objs[2] = `<< /Type /Pages /Kids [${Array.from({ length: count }, (_, i) => `${4 + i * 2} 0 R`).join(' ')}] /Count ${count} >>`
  objs[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
  for (let i = 0; i < count; i += 1) {
    const lines = Array.from({ length: 40 }, (_, l) => `BT /F1 11 Tf 50 ${780 - l * 18} Td (Line ${l} of page ${i + 1} energy momentum vector) Tj ET`).join('\n')
    objs[4 + i * 2] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + i * 2} 0 R >>`
    objs[5 + i * 2] = `<< /Length ${lines.length} >>\nstream\n${lines}\nendstream`
  }
  let out = '%PDF-1.4\n'
  const offsets = []
  for (let i = 1; i < objs.length; i += 1) {
    offsets[i] = out.length
    out += `${i} 0 obj\n${objs[i]}\nendobj\n`
  }
  const xref = out.length
  out += `xref\n0 ${objs.length}\n0000000000 65535 f \n${offsets.slice(1).map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`
  out += `trailer\n<< /Size ${objs.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(out, 'latin1')
}
const pdfPath = join(mkdtempSync(join(tmpdir(), 'fanotes-zoom-anchor-')), 'Blatt.pdf')
writeFileSync(pdfPath, buildPdf(4))

const browser = await browserType.launch({ executablePath: chromium, args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--window-size=1280,900'] })
const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'de-CH', hasTouch: true })
const page = await context.newPage()
const pageErrors = []
page.on('pageerror', (error) => pageErrors.push(String(error)))
const cdp = await context.newCDPSession(page)
const wait = (ms) => page.waitForTimeout(ms)
// Gestures stay inside 800×600: Chromium's synthetic input rejects points
// outside the default headless window.
const X = 620
const Y = 480

// Post-paint samples (a task posted from rAF runs after the frame rendered):
// where the anchored paper point is, and whether the sheet shows a bitmap.
const startRecorder = (x, y) => page.evaluate(([x, y]) => {
  const all = document.elementsFromPoint(x, y)
  const el = all.find((node) => node.matches('.cm-line')) ?? all.find((node) => node.matches('.pdf-note-page, .unified-paper'))
  if (!el) return false
  const r0 = el.getBoundingClientRect()
  const fx = (x - r0.left) / r0.width
  const fy = (y - r0.top) / r0.height
  const frames = []
  let on = true
  const channel = new MessageChannel()
  channel.port1.onmessage = () => {
    const r = el.getBoundingClientRect()
    const pdfHosts = [...document.querySelectorAll('.pdf-note-canvas-host')].filter((host) => {
      const b = host.getBoundingClientRect()
      return b.bottom > 100 && b.top < innerHeight - 100 && b.width > 0
    })
    const pdfBlank = pdfHosts.filter((host) => ![...host.querySelectorAll('canvas')].some((c) => c.width > 0 && getComputedStyle(c).visibility !== 'hidden')).length
    const ink = document.querySelector('.paper-view .lw-tablet-canvas-committed')
    frames.push({
      x: r.left + fx * r.width,
      y: r.top + fy * r.height,
      connected: el.isConnected,
      pdfBlank,
      inkBlank: Boolean(ink && (ink.width === 0 || getComputedStyle(ink).visibility === 'hidden')),
      zoom: Number(document.querySelector('.paper-view')?.dataset.paperZoom || 1),
      preview: Boolean(document.querySelector('.paper-sheet-plane.is-zoom-gesture')),
      t: performance.now(),
    })
  }
  const tick = () => {
    if (!on) return
    channel.port2.postMessage(0)
    requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
  window.__stopZoomRecorder = () => { on = false; return frames }
  return true
}, [x, y])
const stopRecorder = () => page.evaluate(() => window.__stopZoomRecorder())
const touch = (type, points) => cdp.send('Input.dispatchTouchEvent', {
  type,
  touchPoints: points.map(([x, y], id) => ({ x, y, id, radiusX: 4, radiusY: 4, force: 1 })),
})
const resetView = async () => {
  await cdp.send('Emulation.resetPageScaleFactor')
  await page.mouse.move(X, Y)
  await page.keyboard.press('Control+0')
  await wait(900)
}
const summarise = (frames, expected) => {
  let jump = 0
  for (let i = 1; i < frames.length; i += 1) {
    const a = frames[i - 1]
    const b = frames[i]
    if (a.connected && b.connected && !a.preview && !b.preview) jump = Math.max(jump, Math.hypot(b.x - a.x, b.y - a.y))
  }
  const last = frames.at(-1)
  return { jump, drift: Math.hypot(last.x - expected.x, last.y - expected.y), zoom: last.zoom, frames: frames.length }
}

try {
  await page.goto(`${base}/fanotes-app.svg`)
  await page.evaluate(async ([record, drawingRow]) => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('fanotes-web-vault', 1)
      request.onupgradeneeded = () => {
        for (const [name, key] of [['meta', 'key'], ['files', 'path'], ['folders', 'path'], ['assets', 'path'], ['drawings', 'id'], ['worksheets', 'id']]) {
          if (!request.result.objectStoreNames.contains(name)) request.result.createObjectStore(name, { keyPath: key })
        }
      }
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    await new Promise((resolve, reject) => {
      const tx = db.transaction(['meta', 'files', 'drawings'], 'readwrite')
      tx.objectStore('files').put(record)
      tx.objectStore('drawings').put(drawingRow)
      tx.objectStore('meta').put({ key: 'initialized', value: true })
      tx.objectStore('meta').put({ key: 'onboardingComplete', value: true })
      tx.oncomplete = resolve
      tx.onerror = () => reject(tx.error)
    })
    db.close()
  }, [
    { path: 'Zoom.md', content: `${markdown}\n\n<!-- fanotes-ink:${drawingId} -->\n`, modifiedAt: now },
    { id: drawingId, title: 'zoom', updatedAt: now, imageRelativePath: `.fanotes/assets/${drawingId}.png`, dataRelativePath: `.fanotes/assets/${drawingId}.json`, drawingJson: JSON.stringify(drawing) },
  ])
  await page.goto(`${base}/?web`, { waitUntil: 'domcontentloaded' })
  await page.locator('.file-tree__entry-button[data-path="Zoom.md"]').click({ timeout: 90_000 })
  await page.waitForSelector('.paper-view .unified-paper canvas', { timeout: 60_000 })
  await wait(2500)
  // Text under the gesture point, a third of the way down the note.
  await page.evaluate(() => {
    const scroller = document.querySelector('.paper-view')
    scroller.scrollTop = Math.round(scroller.scrollHeight * 0.35)
  })
  await wait(800)

  // 1. Ctrl+wheel zoom in over text (Ctrl held first, like a mouse user).
  await page.mouse.move(X, Y)
  assert.ok(await startRecorder(X, Y), 'a text line under the cursor')
  await page.keyboard.down('Control')
  for (let i = 0; i < 16; i += 1) {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: X, y: Y, deltaX: 0, deltaY: -40, modifiers: 2 })
    await wait(16)
  }
  await page.keyboard.up('Control')
  await wait(1400)
  let frames = await stopRecorder()
  let result = summarise(frames, { x: X, y: Y })
  assert.ok(result.zoom > 1.6, `wheel zoomed in (${result.zoom})`)
  assert.ok(result.jump < 4, `no jump when the wheel zoom commits on a long note (max ${result.jump.toFixed(1)} px)`)
  assert.ok(result.drift < 4, `the text under the cursor stays there (${result.drift.toFixed(1)} px)`)
  assert.equal(frames.filter((frame) => frame.inkBlank).length, 0, 'the ink bitmap is never blank while zooming')
  console.log('zoom anchor: wheel', JSON.stringify(result))

  // 2. Touch pinch over text: the sheet owns it (the browser does not take
  // the gesture and cancel the pointers part-way).
  await resetView()
  await page.evaluate(() => {
    const scroller = document.querySelector('.paper-view')
    scroller.scrollTop = Math.round(scroller.scrollHeight * 0.35)
  })
  await wait(600)
  assert.ok(await startRecorder(X, Y), 'a text line under the fingers')
  await touch('touchStart', [[X - 40, Y], [X + 40, Y]])
  for (let i = 1; i <= 24; i += 1) {
    const s = 40 + 60 * i / 24
    await touch('touchMove', [[X - s, Y], [X + s, Y]])
    await wait(16)
  }
  await touch('touchEnd', [])
  await wait(1200)
  frames = await stopRecorder()
  result = summarise(frames, { x: X, y: Y })
  assert.ok(result.zoom > 2.2, `a 2.5x finger spread over text zooms the sheet (${result.zoom})`)
  assert.ok(result.jump < 4, `no jump when the pinch commits (max ${result.jump.toFixed(1)} px)`)
  assert.ok(result.drift < 6, `the text under the fingers stays there (${result.drift.toFixed(1)} px)`)
  assert.equal(frames.filter((frame) => frame.inkBlank).length, 0, 'the ink bitmap is never blank while pinching')
  console.log('zoom anchor: pinch', JSON.stringify(result))

  // 3. PDF: no blank page bitmap while zooming, sharp soon after.
  await resetView()
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.locator('button.pdf-import-button').first().click(),
  ])
  await chooser.setFiles(pdfPath)
  await page.waitForFunction(() => [...document.querySelectorAll('[data-pdf-page="1"] canvas')].some((c) => c.width > 0), null, { timeout: 90_000 })
  await wait(2500)
  await page.mouse.move(X, Y)
  assert.ok(await startRecorder(X, Y), 'a PDF page under the cursor')
  const before = await page.evaluate(() => Number(document.querySelector('.paper-view')?.dataset.paperZoom || 1))
  await page.keyboard.down('Control')
  for (let i = 0; i < 14; i += 1) {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: X, y: Y, deltaX: 0, deltaY: -40, modifiers: 2 })
    await wait(16)
  }
  await page.keyboard.up('Control')
  const endedAt = await page.evaluate(() => performance.now())
  await wait(1600)
  frames = await stopRecorder()
  result = summarise(frames, { x: X, y: Y })
  assert.ok(result.zoom > before * 1.5, `the PDF zoomed in (${before} -> ${result.zoom})`)
  assert.equal(frames.filter((frame) => frame.pdfBlank > 0).length, 0, 'every frame keeps a painted bitmap on the visible PDF pages')
  assert.ok(result.drift < 4, `the PDF point under the cursor stays there (${result.drift.toFixed(1)} px)`)
  assert.ok(result.jump < 4, `no jump when the PDF zoom commits (max ${result.jump.toFixed(1)} px)`)
  const sharp = await page.evaluate(() => {
    const dpr = devicePixelRatio || 1
    return [...document.querySelectorAll('.pdf-note-canvas-host')].filter((host) => {
      const b = host.getBoundingClientRect()
      return b.bottom > 100 && b.top < innerHeight - 100
    }).every((host) => [...host.querySelectorAll('canvas')].some((c) => {
      if (c.width === 0 || getComputedStyle(c).visibility === 'hidden') return false
      const r = c.getBoundingClientRect()
      return c.width / (r.width * dpr) >= 0.85
    }))
  })
  assert.ok(sharp, 'the visible PDF pages are re-rasterised at the new zoom')
  const committedAt = frames.find((frame) => frame.t > endedAt && !frame.preview)?.t ?? endedAt
  assert.ok(committedAt - endedAt < 600, `the sharp camera commits soon after the wheel (${Math.round(committedAt - endedAt)} ms)`)
  console.log('zoom anchor: pdf', JSON.stringify({ ...result, commitMs: Math.round(committedAt - endedAt) }))

  assert.deepEqual(pageErrors, [], `page errors: ${pageErrors.join('\n')}`)
  console.log('zoom anchor ok')
} finally {
  await browser.close()
  await server.close()
}
