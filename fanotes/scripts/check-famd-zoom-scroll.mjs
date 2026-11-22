// Zoom, stop, scroll in a handwriting note (typed text + ink): the text must not
// go through a second camera mid-scroll.
//
// Before: a wheel zoom is a compositor scale of the old raster until the burst
// has been quiet for 240 ms. A pan that began inside that window scrolled the
// stretched preview, then the settle timer fired in the middle of the pan: one
// reflow, an ink re-slice and a scroll remap while the text was moving (the
// "text bugs for a second" report). Now the first pan wheel settles the camera
// before it scrolls.
//
// Samples every animation frame: plane class/transform/zoom, the first rendered
// editor line (font size, height, top), the ink backing store. Asserts that from
// the first pan wheel on, no frame shows the preview, the layout zoom never
// changes, the line height keeps its ratio to the zoom, and the line never
// jumps more than a wheel tick between frames. Prints frame times.
// Part 1 is a source guard; part 2 needs chromium + playwright-core (skipped with
// FANOTES_SKIP_BROWSER=1).
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { createServer as createNetServer } from 'node:net'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createServer } from 'vite'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const view = readFileSync(join(root, 'src/components/PaperView.tsx'), 'utf8')
if (process.env.FANOTES_SKIP_SOURCE_GUARD !== '1') assert.match(
  view,
  /if \(zoomGestureRef\.current \|\| pendingFactor !== 1\) \{[\s\S]{0,200}commitZoomGestureRef\.current\(\)[\s\S]{0,80}lastPanWheelAtRef\.current = performance\.now\(\)/,
  'a pan wheel settles a pending zoom preview before it scrolls',
)
console.log('source guard ok')

const chromium = process.env.FANOTES_CHROMIUM ?? '/usr/bin/chromium'
const playwrightEntry = process.env.PLAYWRIGHT_CORE ?? '/srv/agents/fanotes/.site-redesign-tools/node_modules/playwright-core/index.mjs'
if (process.env.FANOTES_SKIP_BROWSER === '1' || !existsSync(chromium) || !existsSync(playwrightEntry)) {
  console.log('browser part skipped (no chromium / playwright-core)')
  process.exit(0)
}
const { chromium: browserType } = await import(pathToFileURL(playwrightEntry).href)
const port = await new Promise((resolve, reject) => {
  const probe = createNetServer()
  probe.once('error', reject)
  probe.listen(0, '127.0.0.1', () => { const { port } = probe.address(); probe.close(() => resolve(port)) })
})
const server = await createServer({ root, appType: 'spa', logLevel: 'error', server: { host: '127.0.0.1', port, strictPort: true, fs: { strict: false } } })
await server.listen()

const strokes = Array.from({ length: 60 }, (_, i) => ({
  color: '#202333', baseWidth: 3.5, pressureEnabled: true, brush: 'fineliner',
  points: Array.from({ length: 30 }, (_, k) => ({ x: 0.1 + k * 0.02, y: 0.05 + (i / 60) * 0.9 + Math.sin(k / 3) * 0.004, t: k * 8, pressure: 0.5, tiltX: 0, tiltY: 0, pointerType: 'pen' })),
}))
const id = 'check_zoom_scroll_ink'
const now = '2026-11-01T00:00:00.000Z'
const drawing = { schemaVersion: 1, title: 'p', paperStyle: 'lines', sourceWidth: 900, sourceHeight: 1273, createdAt: now, updatedAt: now, strokes }
const body = Array.from({ length: 40 }, (_, i) => `Paragraph ${i}: the quick brown fox jumps over the lazy dog and keeps running along the page.`).join('\n\n')
const files = [{ path: 'Probe.md', content: `# Probe\n\n${body}\n\n<!-- fanotes-ink:${id} -->\n`, modifiedAt: now }]
const drawings = [{ id, title: 'p', updatedAt: now, imageRelativePath: `.fanotes/assets/${id}.png`, dataRelativePath: `.fanotes/assets/${id}.json`, drawingJson: JSON.stringify(drawing) }]

const base = `http://127.0.0.1:${port}`
const browser = await browserType.launch({ executablePath: chromium, args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'] })
const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'de-CH', deviceScaleFactor: 1 })).newPage()
const pageErrors = []
page.on('pageerror', (error) => pageErrors.push(String(error)))
let failure = null
try {
  await page.goto(`${base}/fanotes-app.svg`)
  await page.evaluate(async ([files, drawings]) => {
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
      for (const row of drawings) tx.objectStore('drawings').put(row)
      for (const row of files) tx.objectStore('files').put(row)
      tx.objectStore('meta').put({ key: 'initialized', value: true })
      tx.objectStore('meta').put({ key: 'onboardingComplete', value: true })
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })
    db.close()
  }, [files, drawings])
  await page.goto(`${base}/?web`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.file-tree__entry-button[data-path="Probe.md"]', { timeout: 120_000 })
  await page.locator('.file-tree__entry-button[data-path="Probe.md"]').click()
  await page.waitForSelector('.cm-content', { timeout: 60_000 })
  await page.waitForTimeout(1500)
  await page.evaluate(() => {
    const log = []
    window.__log = log
    const t0 = performance.now()
    const tick = () => {
      const plane = document.querySelector('.paper-sheet-plane')
      const line = document.querySelector('.cm-line')
      const canvas = document.querySelector('.unified-paper canvas.lw-tablet-canvas-committed')
      const rect = line?.getBoundingClientRect()
      log.push({
        t: performance.now() - t0,
        preview: Boolean(plane?.classList.contains('is-zoom-gesture') || plane?.style.transform),
        zoom: Number.parseFloat(plane?.style.zoom || getComputedStyle(plane).zoom) || 1,
        font: line ? Number.parseFloat(getComputedStyle(line).fontSize) : 0,
        lineH: rect?.height ?? 0,
        lineW: rect?.width ?? 0,
        lineY: rect?.top ?? 0,
        ink: canvas ? canvas.width : 0,
        inkCss: canvas ? Number.parseFloat(canvas.style.width) : 0,
      })
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
    window.__panAt = null
    window.addEventListener('wheel', (event) => {
      if (!event.ctrlKey && window.__panAt === null) window.__panAt = performance.now() - t0
    }, { capture: true, passive: true })
  })
  await page.mouse.move(640, 450)
  await page.keyboard.down('Control')
  for (let i = 0; i < 10; i += 1) { await page.mouse.wheel(0, -100); await page.waitForTimeout(25) }
  await page.keyboard.up('Control')
  await page.waitForTimeout(120)
  for (let i = 0; i < 8; i += 1) { await page.mouse.wheel(0, 120); await page.waitForTimeout(30) }
  await page.waitForTimeout(1200)
  const panAt = await page.evaluate(() => window.__panAt)
  assert.ok(panAt !== null, 'pan wheel seen')
  const log = await page.evaluate(() => window.__log)
  const pan = log.filter((entry) => entry.t >= panAt)
  const finalZoom = log.at(-1).zoom
  assert.ok(finalZoom > 2, `zoomed in (zoom ${finalZoom})`)
  const times = log.filter((entry) => entry.t >= panAt - 300).map((entry) => entry.t)
  const gaps = times.slice(1).map((value, index) => value - times[index]).sort((a, b) => a - b)
  console.log(`frame gaps zoom-stop to pan end: p95 ${gaps[Math.floor(gaps.length * 0.95)].toFixed(1)} ms, max ${gaps.at(-1).toFixed(1)} ms (${gaps.length} frames)`)
  const preview = pan.filter((entry) => entry.preview)
  console.log(`pan frames showing the zoom preview: ${preview.length} of ${pan.length}`)
  // The wheel settles the camera in its own handler; allow the frame in flight.
  const settled = pan.slice(2)
  assert.equal(settled.filter((entry) => entry.preview).length, 0, 'no pan frame shows the compositor zoom preview')
  assert.ok(settled.every((entry) => Math.abs(entry.zoom - finalZoom) < 1e-6), 'layout zoom never changes during the pan')
  assert.ok(settled.every((entry) => entry.font === settled[0].font), 'font size is stable during the pan')
  assert.ok(settled.every((entry) => Math.abs(entry.lineH / entry.zoom - 27.5) < 1), 'line height stays at layout size times zoom')
  const widths = settled.map((entry) => entry.lineW)
  assert.ok(Math.max(...widths) - Math.min(...widths) < 1, 'line width does not change during the pan')
  const jump = Math.max(...settled.slice(1).map((entry, index) => Math.abs(entry.lineY - settled[index].lineY)))
  console.log(`largest text step between frames: ${jump.toFixed(0)} px`)
  assert.ok(jump <= 300, `text never jumps more than two wheel ticks per frame (${jump})`)
  // Raster state: the ink backing store seen from the first pan frame on is already the zoomed one.
  assert.ok(settled.every((entry) => entry.inkCss === 0 || entry.ink / (entry.inkCss * finalZoom) > 0.8 || entry.ink / entry.inkCss > 1.5),
    'ink bitmap is not a 1x stretch while panning')
  assert.deepEqual(pageErrors, [], 'no page errors')
  console.log('zoom -> scroll sequence ok')
} catch (error) {
  failure = error
}
await browser.close()
await server.close()
if (failure) { console.error(failure instanceof Error ? failure.message : failure); process.exit(1) }
process.exit(0)
