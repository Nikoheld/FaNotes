import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const server = await createServer({
  appType: 'custom',
  logLevel: 'error',
  optimizeDeps: { noDiscovery: true },
  server: { middlewareMode: true },
})

const {
  inkBlockedPdfSelectors,
  inkOverlayHitSelector,
  pdfOverlayPointFromClient,
  pdfOverlaySourceHeight,
  pointerEventsForInkLayer,
  shouldSyncPdfOverlaySource,
} = await server.ssrLoadModule('/src/lib/pdfInkHit.ts')
const { inkPointOnWriteSurface, mapClientToPaperPoint } = await server.ssrLoadModule('/src/lib/inkSampleMap.ts')
const { PAPER_SOURCE_HEIGHT, PAPER_SOURCE_WIDTH } = await server.ssrLoadModule('/src/lib/paperGrow.ts')

const runOnce = () => {
  const overlay = { left: 40, top: 20, width: 800, height: 2000 }
  const pages = [
    { top: 20, height: 1000 },
    { top: 1020, height: 1000 },
  ]
  const page1 = pdfOverlayPointFromClient(overlay.left + 400, pages[0].top + 500, overlay, pages)
  const page2 = pdfOverlayPointFromClient(overlay.left + 400, pages[1].top + 500, overlay, pages)
  assert.ok(page1 && page2)
  assert.equal(page1.page, 1)
  assert.equal(page2.page, 2)
  assert.ok(page1.y > 0.2 && page1.y < 0.3, `page-1 center must be first half, got ${page1.y}`)
  assert.ok(page2.y > 0.7 && page2.y < 0.8, `page-2 center must be second half, got ${page2.y}`)
  assert.ok(Math.abs(page1.y - page2.y) > 0.3, 'pages must not collapse onto the same overlay band')

  const a4Card = { left: overlay.left, top: overlay.top, width: 800, height: PAPER_SOURCE_HEIGHT }
  const page2OnA4 = mapClientToPaperPoint({
    clientX: overlay.left + 400,
    clientY: pages[1].top + 500,
    pressure: 0.5,
    pointerType: 'pen',
  }, { ...a4Card, offsetWidth: a4Card.width, offsetHeight: a4Card.height })
  assert.ok(!page2OnA4 || page2OnA4.y > 1 || Math.abs((page2OnA4.y) - page1.y) > 0.2)

  const tall = { left: 10, top: 10, width: 800, height: 4000 }
  const reportY = 0.3
  const tallPoint = pdfOverlayPointFromClient(
    tall.left + 0.42 * tall.width,
    tall.top + reportY * tall.height,
    tall,
    [{ top: tall.top, height: tall.height }],
  )
  assert.ok(tallPoint)
  assert.ok(tallPoint.y > 0.2 && tallPoint.y < 0.4, `tall PDF y ${tallPoint.y} must stay in 0.2…0.4`)

  const overlayH = pdfOverlaySourceHeight(PAPER_SOURCE_WIDTH, 900, 2200)
  assert.ok(overlayH > PAPER_SOURCE_HEIGHT, 'two-page overlay must be taller than one A4 in source space')
  assert.equal(shouldSyncPdfOverlaySource(PAPER_SOURCE_HEIGHT, overlayH), true)
  const page2Source = page2.y * overlayH
  const page1Source = page1.y * overlayH
  assert.ok(page2Source > page1Source + 400, 'page-2 ink in source space must not sit on page 1')
  assert.ok(page2Source > PAPER_SOURCE_HEIGHT, 'page-2 y must sit past a single A4 so conversion is not page 1')

  // One-canvas plane is wider than the 900px column. That width must not
  // shrink a two-page overlay below A4 (the live pen path maps against the plane).
  const wideOverlay = { left: 0, top: 0, width: 2020, height: 2000 }
  const widePages = [
    { top: 0, height: 1000 },
    { top: 1000, height: 1000 },
  ]
  const widePen1 = mapClientToPaperPoint({
    clientX: 400,
    clientY: 500,
    pressure: 0.5,
    pointerType: 'pen',
  }, { ...wideOverlay, offsetWidth: wideOverlay.width, offsetHeight: wideOverlay.height })
  const widePen2 = mapClientToPaperPoint({
    clientX: 400,
    clientY: 1500,
    pressure: 0.5,
    pointerType: 'pen',
  }, { ...wideOverlay, offsetWidth: wideOverlay.width, offsetHeight: wideOverlay.height })
  const wideInk1 = inkPointOnWriteSurface(widePen1, wideOverlay, { width: 2020, height: 800 })
  const wideInk2 = inkPointOnWriteSurface(widePen2, wideOverlay, { width: 2020, height: 800 })
  assert.ok(wideInk1 && wideInk2)
  assert.ok(wideInk1.y > 0.2 && wideInk1.y < 0.3, `wide page-1 pen y ${wideInk1.y}`)
  assert.ok(wideInk2.y > 0.7 && wideInk2.y < 0.8, `wide page-2 pen y ${wideInk2.y}`)
  const wideHit2 = pdfOverlayPointFromClient(400, 1500, wideOverlay, widePages)
  assert.equal(wideHit2?.page, 2)
  assert.equal(wideInk2.y, wideHit2.y)
  const wideH = pdfOverlaySourceHeight(PAPER_SOURCE_WIDTH, wideOverlay.width, wideOverlay.height)
  assert.ok(wideH > PAPER_SOURCE_HEIGHT, `wide-plane overlay source ${wideH} must stay taller than A4`)
  assert.equal(shouldSyncPdfOverlaySource(PAPER_SOURCE_HEIGHT, wideH), true)
  assert.ok(wideInk2.y * wideH > PAPER_SOURCE_HEIGHT, 'wide-plane page-2 source must not sit on page 1')

  const windowed = inkPointOnWriteSurface({ x: 0.4, y: 0.75 }, overlay, { width: 800, height: 800 })
  assert.ok(windowed)
  assert.equal(windowed.y, 0.75, 'windowed bitmap must not rescale page-2 y onto page 1')
  assert.ok(windowed.y < 1)

  assert.equal(pointerEventsForInkLayer('pdf-canvas', true), 'none')
  assert.equal(pointerEventsForInkLayer('overlay', true), 'auto')

  const css = readFileSync(join(root, 'src/styles.css'), 'utf8')
  const board = readFileSync(join(root, 'src/components/DrawingBoard.tsx'), 'utf8')
  const inkingBlock = css.slice(css.indexOf('.pdf-note-view.is-inking,'), css.indexOf('.pdf-note-view.is-inking,') + 900)
  for (const selector of inkBlockedPdfSelectors) {
    assert.ok(css.includes(selector), selector)
  }
  assert.match(inkingBlock, /pointer-events:\s*none/)
  assert.match(board, /inkPointOnWriteSurface/)
  assert.match(board, /pdfOverlaySourceHeight/)
  assert.match(board, /shouldSyncPdfOverlaySource/)
  assert.match(board, /is-pdf-note/)
  assert.equal(inkOverlayHitSelector, '.lw-drawing-board.is-inline.is-input-active .lw-canvas-surface')

  return {
    page1Y: page1.y,
    page2Y: page2.y,
    tallY: tallPoint.y,
    overlayH,
    wideH,
    widePage2Y: wideInk2.y,
    windowedY: windowed.y,
  }
}

try {
  const first = runOnce()
  const second = runOnce()
  assert.deepEqual(first, second)
  console.log(JSON.stringify(first))
  console.log('pdf-write ok')
} finally {
  await server.close()
}
