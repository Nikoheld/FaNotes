// A pinch zoom paints the ink of a heavy page once, not twice (follow-up of #1460 / #1467), in the real app.
//
// A resting pinch re-rasters the page for the zoom on screen before the camera commits. The commit then planned the
// slice again at its own geometry and painted every stroke a second time into another bitmap: two full rasters per
// pinch, the first one visible for a moment. The check counts the strokes painted into the page bitmaps (offscreen
// pages and the committed canvas, `stroke()` calls) from the first pinch event until the page has been still for a
// while, and compares them with the biggest single page painted. It also looks at the layers afterwards: only the
// committed canvas holds ink, the live canvas is empty, and the committed bitmap covers the visible sheet.
// Needs `vite build`, xvfb-run and playwright-core (PLAYWRIGHT_CORE). Synthetic vault and temp profile only.
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'
import { connect, createProfile, createReporter, dismissNotices, electronBinary, launch, root, sleep, stop } from './lib/desktop-flow.mjs'

const require = createRequire(import.meta.url)
const xvfb = spawnSync('sh', ['-c', 'command -v xvfb-run'], { encoding: 'utf8' }).stdout.trim()
const skipReason = process.env.FANOTES_SKIP_BROWSER === '1' ? 'FANOTES_SKIP_BROWSER=1'
  : !xvfb ? 'no xvfb-run'
    : !fs.existsSync(path.join(root, 'dist', 'index.html')) ? 'no dist/ (run vite build)'
      : !fs.existsSync(electronBinary) ? 'no electron' : ''
if (skipReason) {
  console.log(`ink double raster: skipped (${skipReason})`)
  process.exit(0)
}
try { await import(process.env.PLAYWRIGHT_CORE || 'playwright-core') } catch {
  console.log('ink double raster: skipped (no playwright-core; set PLAYWRIGHT_CORE)')
  process.exit(0)
}
const { serializeFamd, emptyFamdPayload } = require('../electron/famd.cjs')
const { ok, failed, count } = createReporter()

const at = '2026-11-01T00:00:00.000Z'
// Above 8,000 points a page is painted across frames into an offscreen bitmap (the heavy path).
const strokes = []
for (let line = 0; line < 60; line += 1) {
  for (let word = 0; word < 6; word += 1) {
    const x0 = 0.06 + word * 0.15
    const y0 = 0.02 + line * 0.015
    strokes.push({
      color: '#202333', baseWidth: 3, pressureEnabled: true, brush: 'fineliner',
      points: Array.from({ length: 24 }, (_, k) => ({ x: x0 + (k / 24) * 0.11, y: y0 + Math.sin(k / 2.2 + line) * 0.003, t: k * 8, pressure: 0.5 })),
    })
  }
}
const ink = { schemaVersion: 1, title: 'Seite', paperStyle: 'grid', sourceWidth: 1224, sourceHeight: 2400, createdAt: at, updatedAt: at, strokes }

// Runs in the page: counts strokes painted per canvas and lists the layers.
const install = () => {
  if (window.__raster) return
  const state = { strokes: new Map(), pages: [] }
  window.__raster = state
  const original = CanvasRenderingContext2D.prototype.stroke
  CanvasRenderingContext2D.prototype.stroke = function stroke(...args) {
    const canvas = this.canvas
    const key = canvas.classList?.contains('lw-tablet-canvas-committed') ? 'committed'
      : canvas.classList?.contains('lw-tablet-canvas-live') ? 'live'
        : canvas.isConnected ? '' : `page ${canvas.width}x${canvas.height}`
    if (key) state.strokes.set(key, (state.strokes.get(key) ?? 0) + 1)
    return original.apply(this, args)
  }
}
const reset = () => window.__raster.strokes.clear()
const painted = () => Object.fromEntries(window.__raster.strokes)

const layers = () => {
  const view = document.querySelector('.paper-view')
  const box = view.getBoundingClientRect()
  const paperBox = view.querySelector('.unified-paper').getBoundingClientRect()
  const inkPixels = (canvas) => {
    const width = Math.min(canvas.width, 300)
    const height = Math.min(canvas.height, 600)
    const scratch = document.createElement('canvas')
    scratch.width = width
    scratch.height = height
    const context = scratch.getContext('2d', { willReadFrequently: true })
    context.drawImage(canvas, 0, 0, width, height)
    const data = context.getImageData(0, 0, width, height).data
    let total = 0
    for (let index = 3; index < data.length; index += 4) if (data[index] > 40) total += 1
    return total
  }
  const out = {}
  for (const canvas of view.querySelectorAll('canvas')) {
    const rect = canvas.getBoundingClientRect()
    const name = canvas.classList.contains('lw-tablet-canvas-committed') ? 'committed' : canvas.classList.contains('lw-tablet-canvas-live') ? 'live' : 'other'
    out[name] = { ink: inkPixels(canvas), visible: rect.bottom > box.top && rect.top < box.bottom, top: rect.top, bottom: rect.bottom }
  }
  // The sheet rows on screen: the pane, cut to the paper.
  return { layers: out, view: { top: Math.max(box.top, paperBox.top), bottom: Math.min(box.bottom, paperBox.bottom) } }
}

const profile = createProfile('ink-double-raster-')
fs.writeFileSync(path.join(profile.vault, 'Seite.famd'), serializeFamd('# Seite\n\nText.\n', { ...emptyFamdPayload(at), ink, paperStyle: 'grid', textFields: [] }))
const app = launch(profile)
let browser = null
try {
  const connected = await connect(app)
  browser = connected.browser
  const { page } = connected
  await dismissNotices(page)
  await page.locator('.file-tree__row', { hasText: 'Seite' }).first().click()
  await page.waitForFunction(() => document.querySelector('.paper-view .unified-paper canvas'), null, { timeout: 60_000 })
  await sleep(2500)
  await page.evaluate(`(${install.toString()})()`)
  const pane = await page.evaluate(() => { const box = document.querySelector('.paper-view').getBoundingClientRect(); return { left: box.left, top: box.top, width: box.width, height: box.height } })
  const cursor = { x: Math.round(pane.left + pane.width * 0.42), y: Math.round(pane.top + pane.height * 0.5) }
  await page.mouse.move(cursor.x, cursor.y)
  const cdp = await page.context().newCDPSession(page)
  const pinch = async (factor, steps) => {
    const delta = (-100 * Math.log(factor)) / steps
    const sent = []
    for (let step = 0; step < steps; step += 1) {
      sent.push(cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: cursor.x, y: cursor.y, deltaX: 0, deltaY: delta + 0.013, modifiers: 2 }))
      await sleep(16)
    }
    await Promise.all(sent)
  }
  const zoomNow = () => page.evaluate(() => { const paper = document.querySelector('.paper-view .unified-paper'); return Math.round(paper.getBoundingClientRect().width / paper.offsetWidth * 100) })

  const run = async (name, factor, steps, rest = 0, allowed = rest ? 2.6 : 1.3) => {
    await page.evaluate(reset)
    const before = await zoomNow()
    if (rest) {
      await pinch(Math.sqrt(factor), steps / 2)
      await sleep(rest)
      await pinch(Math.sqrt(factor), steps / 2)
    } else await pinch(factor, steps)
    // The sharp page is done when no stroke is painted for a while.
    let quiet = 0
    let last = JSON.stringify(await page.evaluate(painted))
    for (let waited = 0; waited < 8000 && quiet < 1200; waited += 200) {
      await sleep(200)
      const now = JSON.stringify(await page.evaluate(painted))
      quiet = now === last ? quiet + 200 : 0
      last = now
    }
    const counts = await page.evaluate(painted)
    const pages = Object.entries(counts).filter(([key]) => key.startsWith('page '))
    const biggest = Math.max(0, ...pages.map(([, value]) => value))
    const total = Object.values(counts).reduce((sum, value) => sum + value, 0)
    const state = await page.evaluate(layers)
    const after = await zoomNow()
    const detail = `${before}% -> ${after}%, painted ${JSON.stringify(counts)}`
    ok(`${name}: the zoom changed`, Math.abs(after - before) >= 15, detail)
    // A pinch that rests in the middle is two zooms: its first sharp page is painted for the rest, its second for the end.
    ok(`${name}: the ink was painted once per zoom (total strokes <= ${allowed} x the biggest page)`, biggest > 0 && total <= biggest * allowed, `${total} vs ${biggest}; ${detail}`)
    const { committed, live, other } = state.layers
    ok(`${name}: only the committed canvas holds ink, the live canvas is empty`, committed?.ink > 0 && live?.ink === 0 && !other, JSON.stringify(state.layers))
    ok(`${name}: the committed bitmap covers the visible sheet`, committed && committed.top <= state.view.top + 2 && committed.bottom >= state.view.bottom - 2, JSON.stringify({ committed, view: state.view }))
  }

  await run('pinch in', 2.0, 14)
  await run('pinch out', 0.6, 14)
  await run('pinch in a lot', 3.2, 18)
  await run('pinch out a lot', 0.35, 18)
  await run('pinch in with a rest in the middle', 2.6, 16, 260)
  await page.keyboard.press('Control+d')
  await sleep(600)
  await run('pen out: pinch in', 2.0, 14)
  await run('pen out: pinch out', 0.6, 14)
  await run('pen out: pinch in with a rest in the middle', 2.6, 16, 260)
} catch (error) {
  ok('ink double raster flow ran to the end', false, error instanceof Error ? error.stack ?? error.message : String(error))
} finally {
  await stop(app, browser)
  profile.dispose()
}
console.log(`ink double raster: ${count() - failed()}/${count()} checks passed`)
process.exit(failed() === 0 ? 0 : 1)
