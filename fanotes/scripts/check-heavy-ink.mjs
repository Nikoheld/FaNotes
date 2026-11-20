// Heavy ink pages (1,000 strokes): the first pen-down must not repaint every
// stroke on the main thread.
//
// The first press near the top/left edge of a page grows it (an origin pad) and
// remaps every 0–1 point. Mid-stroke the heavy repaint job may not run, so the
// board painted the whole page inside that pointer event: 150–300 ms at 1x,
// close to 1 s at 4x CPU. Now the held bitmap is moved by one copy
// (lib/inkGrowRemap), and the page is repainted exactly, in slices, after the
// pen lifts.
//
// Part 1: remap math and wasm parity (pure). Part 2: source guards.
// Part 3: real Chromium via playwright-core (skipped with FANOTES_SKIP_BROWSER=1
// or when no browser exists): stroke calls on the committed canvas during the
// first press, and the re-sealed page against a fresh open, pixel by pixel.
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { createServer as createNetServer } from 'node:net'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createServer } from 'vite'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
// The app's vite config pins its dev port; a check takes any free one.
const freePort = await new Promise((resolve, reject) => {
  const probe = createNetServer()
  probe.once('error', reject)
  probe.listen(0, '127.0.0.1', () => {
    const { port } = probe.address()
    probe.close(() => resolve(port))
  })
})
const server = await createServer({
  root,
  appType: 'spa',
  logLevel: 'error',
  server: { host: '127.0.0.1', port: freePort, strictPort: true, fs: { strict: false } },
})
await server.listen()

// ---- Part 1: remap math --------------------------------------------------
const remap = await server.ssrLoadModule('/src/lib/inkGrowRemap.ts')
const { keepMarkOnPage } = await server.ssrLoadModule('/src/lib/paperCore.ts')

// The inline per-point remap must give exactly the wasm result.
let seed = 7
const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296
const inline = (value, prev, next, pad) => {
  const axis = remap.keepMarkOnPageAxis(prev, next, pad)
  if (!axis) return value
  return Number.isFinite(value) ? (value * axis.prev + axis.pad) / axis.next : value
}
const extents = [[1344, 1488, 144], [994, 1102, 108], [1273, 1344, 0], [900, 900, 0], [900, 900 + 5e-7, 0], [900, 900, 36], [0, 900, 0], [900, -1, 0], [Number.NaN, 900, 0], [900, 1800, Number.NaN], [900, 1800, -20]]
const values = [0, 1, 0.5, -0.25, 1.75, Number.NaN, Number.POSITIVE_INFINITY, 1e-300, ...Array.from({ length: 400 }, () => rnd() * 1.4 - 0.2)]
let compared = 0
for (const [prev, next, pad] of [...extents, ...Array.from({ length: 60 }, () => [200 + rnd() * 3000, 200 + rnd() * 3000, rnd() < 0.5 ? 0 : Math.round(rnd() * 300)])]) {
  for (const value of values) {
    const want = keepMarkOnPage(value, prev, next, pad)
    const got = inline(value, prev, next, pad)
    assert.ok(Object.is(want, got), `inline remap ${got} differs from wasm ${want} for v=${value} ${prev}->${next} pad ${pad}`)
    compared += 1
  }
}

// The affine map of a real grow, and the copy plan it gives.
const padX = remap.inkAxisMapOf((v) => keepMarkOnPage(v, 994, 1102, 108))
const padY = remap.inkAxisMapOf((v) => keepMarkOnPage(v, 1344, 1488, 144))
assert.ok(padX && padY)
assert.ok(Math.abs(padX.a - 994 / 1102) < 1e-12 && Math.abs(padX.b - 108 / 1102) < 1e-12)
assert.equal(remap.inkAxisMapOf((v) => v * v), null, 'a non-affine remap is refused')
assert.equal(remap.inkAxisMapOf(() => Number.NaN), null)
const from = { width: 1740, height: 2352, virtualHeight: 2352, topPx: 0 }
const to = { width: 1929, height: 2604, virtualHeight: 2604, topPx: 0 }
const plan = remap.planHeldInkRemap(from, to, padX, padY)
assert.ok(plan, 'an origin pad at the same density is a copy')
assert.equal(plan.unit, true, 'same density: whole-pixel copy, no resampling')
assert.equal(plan.dx, Math.round(108 / 1102 * 1929))
assert.equal(plan.dy, Math.round(144 / 1488 * 2604))
assert.deepEqual(plan.bands[0], { y: 0, height: plan.dy }, 'the new top rows are painted from the model')
assert.equal(plan.bands.length, 1, 'the copy reaches the last row: nothing else to paint')
const short = remap.planHeldInkRemap({ ...from, height: 2200 }, to, padX, padY)
assert.deepEqual(short.bands.at(-1), { y: short.dy + 2200, height: to.height - short.dy - 2200 }, 'rows below a shorter copy are painted too')
// A bottom grow keeps every row where it was.
const bottom = remap.planHeldInkRemap(from, { ...to, width: 1740 }, remap.IDENTITY_AXIS, remap.inkAxisMapOf((v) => keepMarkOnPage(v, 1344, 1488, 0)))
assert.ok(bottom && bottom.unit && bottom.dx === 0 && bottom.dy === 0)
// A slice that moved: rows outside the old slice are band-painted.
const slice = remap.planHeldInkRemap({ width: 1000, height: 800, virtualHeight: 4000, topPx: 1200 }, { width: 1000, height: 800, virtualHeight: 4000, topPx: 1000 }, remap.IDENTITY_AXIS, remap.IDENTITY_AXIS)
assert.ok(slice && slice.unit && slice.dy === 200)
assert.deepEqual(slice.bands, [{ y: 0, height: 200 }])
// A density change, an empty bitmap or a mostly uncovered slice: repaint instead.
assert.equal(remap.planHeldInkRemap(from, { ...to, width: 3858, height: 5208, virtualHeight: 5208 }, padX, padY), null)
assert.equal(remap.planHeldInkRemap({ ...from, width: 0 }, to, padX, padY), null)
assert.equal(remap.planHeldInkRemap({ width: 1000, height: 800, virtualHeight: 4000, topPx: 0 }, { width: 1000, height: 800, virtualHeight: 4000, topPx: 600 }, remap.IDENTITY_AXIS, remap.IDENTITY_AXIS), null)
// Rounding density: a near-unit scale is still a crisp copy.
const near = remap.planHeldInkRemap({ width: 1740, height: 2352, virtualHeight: 2352, topPx: 0 }, { width: 1929, height: 2604, virtualHeight: 2604, topPx: 0 }, { a: 994 / 1102 * 1.00002, b: 108 / 1102 }, padY)
assert.ok(near && near.unit)
console.log(`remap math ok (${compared} wasm comparisons)`)

// ---- Part 2: source guards -----------------------------------------------
const board = readFileSync(join(root, 'src/components/DrawingBoard.tsx'), 'utf8')
const extentStart = board.indexOf('const setPageExtent = useCallback(')
const extent = board.slice(extentStart, board.indexOf('\n  }, [', extentStart))
assert.ok(extentStart > 0 && extent.length > 0)
assert.doesNotMatch(extent, /forEachTrackedPoint\(\(point\) => \{\s*point\.[xy] = keepMarkOnPage\(/, 'no wasm call per point in a page grow')
assert.match(extent, /growRemapRef\.current = activeStrokeRef\.current/, 'a grow under the pen hands the redraw its remap')
const redrawStart = board.indexOf('const redraw = useCallback(')
const redraw = board.slice(redrawStart, board.indexOf('\n  }, [', redrawStart))
assert.match(redraw, /const growRemap = growRemapRef\.current\s*growRemapRef\.current = null/, 'each remap is used by one redraw only')
assert.ok(redraw.indexOf('} else if (growPlan && remapHeldInk(growPlan)) {') > 0)
assert.ok(redraw.indexOf('} else if (growPlan && remapHeldInk(growPlan)) {') < redraw.indexOf('} else if (heavyRepaint) {'), 'the copy is tried before any repaint')
assert.match(redraw, /&& !\(held\.provisional && !activeStrokeRef\.current\)/, 'a provisional bitmap is repainted once the pen lifts')
assert.match(redraw, /committedBitmapRef\.current = \{ key: contentKey, topPx, provisional: true \}/)
console.log('source guards ok')

// ---- Part 3: browser -----------------------------------------------------
const chromium = process.env.FANOTES_CHROMIUM ?? '/usr/bin/chromium'
const playwrightEntry = process.env.PLAYWRIGHT_CORE ?? '/srv/agents/fanotes/.site-redesign-tools/node_modules/playwright-core/index.mjs'
if (process.env.FANOTES_SKIP_BROWSER === '1' || !existsSync(chromium) || !existsSync(playwrightEntry)) {
  console.log('browser part skipped (no chromium / playwright-core)')
  await server.close()
  process.exit(0)
}
const { chromium: browserType } = await import(pathToFileURL(playwrightEntry).href)

// Synthetic page: rows of handwriting plus marker, see-through, highlighter and neon ink.
const SRC_W = 900
const SRC_H = 1273
const makeStroke = (index, total) => {
  const rows = Math.ceil(total / 12)
  const row = Math.floor(index / 12)
  const col = index % 12
  const x0 = 0.06 + col * 0.075
  const y0 = 0.03 + (row / rows) * 0.92
  const n = 30 + Math.floor(rnd() * 20)
  const points = Array.from({ length: n }, (_, i) => ({
    x: +(x0 + i * 0.0016 + rnd() * 0.0004).toFixed(5),
    y: +(y0 + Math.sin(i / 3 + index) * 0.004).toFixed(5),
    t: i * 8,
    pressure: +(0.3 + 0.4 * Math.sin((i / n) * Math.PI)).toFixed(3),
    tiltX: 0,
    tiltY: 0,
    pointerType: 'pen',
  }))
  const base = { color: '#202333', baseWidth: 3.5, pressureEnabled: true, points }
  if (index % 97 === 5) return { ...base, purpose: 'art', brush: 'marker', color: '#e0457b', baseWidth: 14, opacity: 0.6 }
  if (index % 97 === 21) return { ...base, purpose: 'art', brush: 'highlighter', color: '#f5d33d', baseWidth: 22, pressureEnabled: false }
  if (index % 97 === 40) return { ...base, purpose: 'art', brush: 'fineliner', opacity: 0.45, color: '#3a7bd5', baseWidth: 8 }
  if (index % 97 === 63) return { ...base, purpose: 'art', brush: 'fineliner', colorEffect: 'neon', baseWidth: 8, color: '#3a7bd5' }
  return { ...base, brush: 'fineliner' }
}
const heavyId = 'check_heavy_ink'
const heavyDrawing = {
  schemaVersion: 1,
  title: 'heavy',
  paperStyle: 'lines',
  sourceWidth: SRC_W,
  sourceHeight: SRC_H,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  strokes: Array.from({ length: 1000 }, (_, i) => makeStroke(i, 1000)),
}
const now = '2026-11-01T00:00:00.000Z'
const files = [
  { path: 'Heavy.md', content: `# Heavy\n\nText.\n\n<!-- fanotes-ink:${heavyId} -->\n`, modifiedAt: now },
  { path: 'Light.md', content: '# Light\n\nNo ink here.\n', modifiedAt: now },
]
const drawings = [{ id: heavyId, title: 'heavy', updatedAt: now, imageRelativePath: `.fanotes/assets/${heavyId}.png`, dataRelativePath: `.fanotes/assets/${heavyId}.json`, drawingJson: JSON.stringify(heavyDrawing) }]

const base = `http://127.0.0.1:${server.httpServer.address().port}`
const browser = await browserType.launch({ executablePath: chromium, args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'] })
const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'de-CH', deviceScaleFactor: 1 })
const page = await context.newPage()
const pageErrors = []
page.on('pageerror', (error) => pageErrors.push(String(error)))
const settle = (ms) => page.waitForTimeout(ms)

try {
  await page.goto(`${base}/fanotes-app.svg`)
  await page.evaluate(async ([files, drawings]) => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('fanotes-web-vault', 1)
      request.onupgradeneeded = () => {
        const store = request.result
        for (const [name, key] of [['meta', 'key'], ['files', 'path'], ['folders', 'path'], ['assets', 'path'], ['drawings', 'id'], ['worksheets', 'id']]) {
          if (!store.objectStoreNames.contains(name)) store.createObjectStore(name, { keyPath: key })
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
  // Count what each canvas paints: the committed layer, and the offscreen page of the heavy job.
  await page.addInitScript(() => {
    const counts = { committed: 0, other: 0 }
    window.__inkPaints = counts
    for (const name of ['stroke', 'fill']) {
      const original = CanvasRenderingContext2D.prototype[name]
      CanvasRenderingContext2D.prototype[name] = function (...args) {
        if (this.canvas?.classList?.contains('lw-tablet-canvas-committed')) counts.committed += 1
        else counts.other += 1
        return original.apply(this, args)
      }
    }
    const marks = []
    window.__pressPaints = marks
    window.addEventListener('pointerdown', () => { marks.push({ at: 'before', ...counts }) }, true)
    window.addEventListener('pointerdown', () => { marks.push({ at: 'after', ...counts }) }, false)
  })
  await page.goto(`${base}/?web`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.file-tree__entry-button[data-path="Heavy.md"]', { timeout: 120_000 })
  const openNote = async (path) => {
    await page.locator(`.file-tree__entry-button[data-path="${path}"]`).click()
    await page.waitForSelector('.cm-content', { timeout: 60_000 })
  }
  // Snapshots stay in the page (a page bitmap is ~20 MB); only summaries cross over.
  const committedPixels = (name) => page.evaluate((name) => {
    const canvas = document.querySelector('.unified-paper canvas.lw-tablet-canvas-committed')
    if (!canvas || !canvas.width) return null
    const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data
    window.__snaps ??= {}
    window.__snaps[name] = { width: canvas.width, height: canvas.height, data }
    let ink = 0
    for (let i = 3; i < data.length; i += 4) if (data[i]) ink += 1
    return { width: canvas.width, height: canvas.height, ink }
  }, name)
  const comparePixels = (a, b, alphaOver = 0) => page.evaluate(([a, b, alphaOver]) => {
    const left = window.__snaps[a]
    const right = window.__snaps[b]
    if (left.width !== right.width || left.height !== right.height) return { sameSize: false }
    let differingBytes = 0
    let maxDelta = 0
    let alphaOff = 0
    for (let i = 0; i < left.data.length; i += 1) {
      const delta = Math.abs(left.data[i] - right.data[i])
      if (!delta) continue
      differingBytes += 1
      if (delta > maxDelta) maxDelta = delta
      if ((i & 3) === 3 && delta > alphaOver) alphaOff += 1
    }
    return { sameSize: true, differingBytes, maxDelta, alphaOff }
  }, [a, b, alphaOver])
  // The heavy job paints across frames: wait until a whole second passes without a paint.
  const waitQuiet = async () => {
    let last = -1
    for (let round = 0; round < 60; round += 1) {
      const total = await page.evaluate(() => window.__inkPaints.committed + window.__inkPaints.other)
      if (total === last) return
      last = total
      await settle(1000)
    }
  }
  await openNote('Heavy.md')
  await settle(1500)
  if (!(await page.evaluate(() => Boolean(document.querySelector('.lw-tablet-canvas.is-input-active'))))) {
    await page.locator('button[title^="Mit dem Stift schreiben"]').first().click()
  }
  await page.waitForSelector('.lw-tablet-canvas.is-input-active', { timeout: 30_000 })
  await waitQuiet()
  const before = await committedPixels('before')
  assert.ok(before && before.ink > 10_000, 'the heavy page is painted before the first press')
  const paper = await page.evaluate(() => {
    const box = document.querySelector('.unified-paper').getBoundingClientRect()
    return { x: box.x, y: box.y, width: box.width, height: box.height }
  })
  const cdp = await context.newCDPSession(page)
  const pen = (type, x, y, pressed) => cdp.send('Input.dispatchMouseEvent', {
    type, x, y, button: 'left', buttons: pressed ? 1 : 0, clickCount: type === 'mouseMoved' ? 0 : 1, pointerType: 'pen', force: 0.5,
  })
  // Near the sheet's top-left corner: the page grows an origin pad under the pen.
  const x0 = Math.max(paper.x, 300) + 40
  const y0 = Math.max(paper.y, 100) + 60
  await pen('mouseMoved', x0, y0, false)
  await pen('mousePressed', x0, y0, true)
  for (let i = 1; i <= 24; i += 1) await pen('mouseMoved', x0 + i * 4, y0 + Math.sin(i / 4) * 12, true)
  const grown = await page.evaluate(() => document.querySelector('.unified-paper').getBoundingClientRect().width)
  const provisional = await committedPixels('provisional')
  await pen('mouseReleased', x0 + 96, y0, false)
  const marks = await page.evaluate(() => window.__pressPaints)
  const firstPress = marks.findIndex((mark) => mark.at === 'before')
  const pressCommitted = marks[firstPress + 1].committed - marks[firstPress].committed
  console.log(JSON.stringify({ grewPx: Math.round(grown - paper.width), committedStrokeCallsInFirstPress: pressCommitted, strokesOnPage: heavyDrawing.strokes.length }))
  assert.ok(grown > paper.width + 20, 'the first press near the edge grows the page (an origin pad)')
  assert.ok(pressCommitted < heavyDrawing.strokes.length / 10, `the first press repainted ${pressCommitted} strokes on the committed layer`)
  assert.ok(provisional && provisional.ink > before.ink * 0.95, 'the moved picture shows the page while the pen is down')

  // After the lift the page is repainted exactly (in slices) and saved.
  await waitQuiet()
  await settle(2500)
  const sealed = await committedPixels('sealed')
  // A fresh open of the saved page paints it from the model in one go.
  await openNote('Light.md')
  await settle(1500)
  await openNote('Heavy.md')
  await page.waitForSelector('.lw-tablet-canvas.is-input-active', { timeout: 30_000 })
  await waitQuiet()
  const fresh = await committedPixels('fresh')
  assert.equal(`${sealed.width}x${sealed.height}`, `${fresh.width}x${fresh.height}`, 'the reopened page has the same bitmap')
  const exact = await comparePixels('sealed', 'fresh')
  // The stand-in picture during the stroke, against the exact page (pixels whose alpha is clearly off).
  const standIn = await comparePixels('provisional', 'fresh', 64)
  console.log(JSON.stringify({ sealedVsFresh: exact, provisionalVsFresh: standIn, inkPixels: fresh.ink }))
  const differ = exact.differingBytes
  assert.equal(differ, 0, 'after the lift the page is pixel-identical to a fresh paint')
  assert.deepEqual(pageErrors, [])
  console.log('heavy ink pen-down ok')
} finally {
  await browser.close()
  await server.close()
}
