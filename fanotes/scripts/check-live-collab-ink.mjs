// Live ink in real Chromium: two real DrawingBoard instances on one shared note. A stroke drawn on A appears on B, an
// erase on B removes it on A, simultaneous strokes both end up on both sheets, and a per-frame recorder composites each
// sheet's canvases under the stroke's points: once a point is painted it must never go blank while the stroke exists
// (flicker), and no ink may appear away from the stroke (jump). The remote pen indicator must show while A writes.
// Skipped with FANOTES_SKIP_BROWSER=1 or without a browser.
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createServer } from 'vite'

const chromium = process.env.FANOTES_CHROMIUM ?? '/usr/bin/chromium'
const playwrightEntry = process.env.PLAYWRIGHT_CORE ?? '/srv/agents/fanotes/.site-redesign-tools/node_modules/playwright-core/index.mjs'
if (process.env.FANOTES_SKIP_BROWSER === '1' || !existsSync(chromium) || !existsSync(playwrightEntry)) {
  console.log('live collaboration ink check skipped (no chromium / playwright-core)')
  process.exit(0)
}
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const server = await createServer({ root, appType: 'spa', logLevel: 'error', cacheDir: mkdtempSync(join(tmpdir(), 'fanotes-liveink-vite-')), server: { host: '127.0.0.1', port: 0, fs: { strict: false } } })
await server.listen()
const { chromium: browserType } = await import(pathToFileURL(playwrightEntry).href)
const browser = await browserType.launch({ executablePath: chromium, args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'] })
const errors = []
try {
  const context = await browser.newContext({ viewport: { width: 1300, height: 800 }, locale: 'en-US' })
  const page = await context.newPage()
  page.on('pageerror', (error) => errors.push(String(error)))
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/scripts/live-ink-harness/index.html`, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => window.__ready === true && document.querySelectorAll('.unified-paper canvas').length >= 2, null, { timeout: 40_000 })
  await page.waitForTimeout(800)

  // The recorder: every frame, composite the canvases of each sheet and read the alpha around the watched points.
  await page.evaluate(() => {
    const rec = { watch: [[], []], log: [[], []], frames: 0, running: true }
    window.__rec = rec
    const paperOf = (index) => document.querySelectorAll('.unified-paper')[index]
    const alphaAt = (paper, fx, fy) => {
      const box = paper.getBoundingClientRect()
      const px = box.left + fx * box.width
      const py = box.top + fy * box.height
      let best = 0
      for (const canvas of paper.querySelectorAll('canvas')) {
        const r = canvas.getBoundingClientRect()
        if (px < r.left || px > r.right || py < r.top || py > r.bottom || !r.width) continue
        const context2d = canvas.getContext('2d', { willReadFrequently: true })
        if (!context2d) continue
        const cx = Math.round(((px - r.left) / r.width) * canvas.width)
        const cy = Math.round(((py - r.top) / r.height) * canvas.height)
        const radius = Math.max(2, Math.round(canvas.width / r.width * 3))
        const data = context2d.getImageData(Math.max(0, cx - radius), Math.max(0, cy - radius), radius * 2 + 1, radius * 2 + 1).data
        for (let i = 3; i < data.length; i += 4) if (data[i] > best) best = data[i]
      }
      return best
    }
    window.__alphaAt = alphaAt
    const tick = () => {
      if (!rec.running) return
      rec.frames += 1
      for (let side = 0; side < 2; side += 1) {
        const paper = paperOf(side)
        for (const item of rec.watch[side]) {
          const painted = alphaAt(paper, item.x, item.y) > 40
          if (painted) item.seen = true
          else if (item.seen && item.active) item.flicker += 1
          item.last = painted
        }
      }
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
    window.__watch = (side, points) => { window.__rec.watch[side] = points.map((p) => ({ ...p, seen: false, flicker: 0, active: true, last: false })) }
    window.__unwatch = (side) => { for (const item of window.__rec.watch[side]) item.active = false }
    window.__stats = (side) => ({ seen: window.__rec.watch[side].filter((i) => i.seen).length, total: window.__rec.watch[side].length, flicker: window.__rec.watch[side].reduce((s, i) => s + i.flicker, 0) })
    window.__paintedNow = (side) => window.__rec.watch[side].filter((i) => alphaAt(paperOf(side), i.x, i.y) > 40).length
  })

  const box = async (side) => page.evaluate((s) => { const r = document.querySelectorAll('.unified-paper')[s].getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height } }, side)
  const strokes = (side) => page.evaluate((s) => window.__strokes(s), side)
  const pointsOf = (b, from, to, count) => Array.from({ length: count }, (_, i) => { const t = i / (count - 1); return { fx: from.x + (to.x - from.x) * t, fy: from.y + (to.y - from.y) * t, x: 0, y: 0, px: b.x + b.w * (from.x + (to.x - from.x) * t), py: b.y + b.h * (from.y + (to.y - from.y) * t) } })
  const drag = async (b, from, to, count = 24) => {
    const pts = pointsOf(b, from, to, count)
    await page.mouse.move(pts[0].px, pts[0].py)
    await page.mouse.down()
    for (const p of pts.slice(1)) { await page.mouse.move(p.px, p.py, { steps: 2 }); await page.waitForTimeout(8) }
    return pts
  }
  const watchOf = (pts) => pts.filter((_, i) => i % 3 === 1).map((p) => ({ x: p.fx, y: p.fy }))

  // 1. A draws; B sees the pen indicator while A writes, and the finished stroke on B.
  const boxA = await box(0)
  const boxB = await box(1)
  const startedAt = Date.now()
  const pts = await drag(boxA, { x: 0.2, y: 0.3 }, { x: 0.7, y: 0.4 })
  await page.waitForSelector('.unified-paper[data-peer="Ben_K"] .live-pen', { timeout: 3000 })
  const penLabel = await page.textContent('.unified-paper[data-peer="Ben_K"] .live-pen span')
  assert.equal(penLabel?.trim(), 'Anna_F', 'B shows where A\'s pen is, with A\'s name')
  await page.mouse.up()
  const watchA = watchOf(pts).map((p) => ({ x: p.x, y: p.y }))
  const points = pts.map((p) => ({ x: p.fx, y: p.fy })).filter((_, i) => i % 3 === 1)
  await page.evaluate((list) => { window.__watch(0, list); window.__watch(1, list) }, points)
  await page.waitForFunction(() => window.__strokes(0) === 1 && window.__strokes(1) === 1, null, { timeout: 4000 })
  await page.waitForFunction(() => window.__stats(1).seen >= window.__stats(1).total - 1, null, { timeout: 4000 })
  console.log(`stroke A to B: ${Date.now() - startedAt} ms including the drawing`)
  await page.waitForTimeout(600)
  let a = await page.evaluate(() => window.__stats(0)); let b = await page.evaluate(() => window.__stats(1))
  assert.ok(a.seen >= a.total - 1, `A paints its own stroke (${a.seen}/${a.total})`)
  assert.ok(b.seen >= b.total - 1, `B paints A's stroke (${b.seen}/${b.total})`)
  assert.equal(a.flicker + b.flicker, 0, `no flicker on either sheet while the stroke arrives (A ${a.flicker}, B ${b.flicker})`)
  void watchA, void boxB

  // 2. B erases it with the real eraser; A loses it too.
  await page.evaluate(() => window.__handles[1].applySupportTool('eraser'))
  await page.waitForTimeout(200)
  const erasePts = await drag(boxB, { x: 0.17, y: 0.295 }, { x: 0.73, y: 0.405 }, 60)
  await page.mouse.up()
  void erasePts
  await page.evaluate(() => { window.__unwatch(0); window.__unwatch(1) })
  await page.waitForFunction(() => window.__strokes(0) === 0 && window.__strokes(1) === 0, null, { timeout: 4000 })
  await page.waitForTimeout(500)
  assert.equal(await page.evaluate(() => window.__paintedNow(0)), 0, 'the erased stroke is gone from A\'s canvas')
  assert.equal(await page.evaluate(() => window.__paintedNow(1)), 0, 'and from B\'s')

  // 3. Both draw (strokes alternate with one mouse): both strokes end up on both sheets without disturbing each other.
  await page.evaluate(() => window.__handles[1].applySupportTool('pen'))
  await page.waitForTimeout(200)
  const draw = async (side, from, to) => {
    const b = await box(side)
    const list = pointsOf(b, from, to, 20)
    await page.evaluate(([s, items]) => { for (const target of [0, 1]) window.__watch(target, [...(window.__rec.watch[target] || []), ...items.filter((_, i) => i % 3 === 1).map((p) => ({ x: p.fx, y: p.fy }))]) }, [side, list])
    await page.mouse.move(list[0].px, list[0].py); await page.mouse.down()
    for (const p of list.slice(1)) { await page.mouse.move(p.px, p.py, { steps: 2 }); await page.waitForTimeout(8) }
    await page.mouse.up()
  }
  await page.evaluate(() => { window.__watch(0, []); window.__watch(1, []) })
  await draw(0, { x: 0.2, y: 0.5 }, { x: 0.8, y: 0.52 })
  await draw(1, { x: 0.2, y: 0.68 }, { x: 0.8, y: 0.7 })
  await page.waitForFunction(() => window.__strokes(0) === 2 && window.__strokes(1) === 2, null, { timeout: 4000 })
  await page.waitForTimeout(800)
  a = await page.evaluate(() => window.__stats(0)); b = await page.evaluate(() => window.__stats(1))
  assert.ok(a.seen >= a.total - 2 && b.seen >= b.total - 2, `both strokes are painted on both sheets (A ${a.seen}/${a.total}, B ${b.seen}/${b.total})`)
  assert.equal(a.flicker + b.flicker, 0, `no flicker when the other person's stroke arrives (A ${a.flicker}, B ${b.flicker})`)

  // 4. A's stroke jumps nowhere: the ink on B stays within the stroke's own box after it arrived.
  const extent = await page.evaluate((side) => {
    const paper = document.querySelectorAll('.unified-paper')[side]
    const box = paper.getBoundingClientRect()
    let minY = 1e9; let maxY = -1
    for (const canvas of paper.querySelectorAll('canvas')) {
      const r = canvas.getBoundingClientRect(); if (!r.width) continue
      const c = canvas.getContext('2d', { willReadFrequently: true }); if (!c) continue
      const data = c.getImageData(0, 0, canvas.width, canvas.height).data
      for (let y = 0; y < canvas.height; y += 2) for (let x = 0; x < canvas.width; x += 2) if (data[(y * canvas.width + x) * 4 + 3] > 40) {
        const fy = (r.top + (y / canvas.height) * r.height - box.top) / box.height
        minY = Math.min(minY, fy); maxY = Math.max(maxY, fy)
      }
    }
    return { minY, maxY }
  }, 1)
  assert.ok(extent.minY > 0.45 && extent.maxY < 0.76, `ink on B stays where it was written (${extent.minY.toFixed(2)}..${extent.maxY.toFixed(2)})`)

  await page.evaluate(() => { window.__rec.running = false })
  assert.deepEqual(errors, [], 'no page errors')
  console.log('live collaboration ink checks passed')
} finally {
  await browser.close()
  await server.close()
  setTimeout(() => process.exit(process.exitCode ?? 0), 50).unref()
}
