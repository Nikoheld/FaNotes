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
  PAGE_START_WIDTH,
  SCROLL_ROOM,
  growPageFromMark,
  mapClientToPage,
  pageCanvasLayout,
  writePageLayoutSize,
  writePageSurface,
  writeSurfaceIsPage,
} = await server.ssrLoadModule('/src/lib/noteCanvas.ts')
const { mapClientToPaperPoint } = await server.ssrLoadModule('/src/lib/inkSampleMap.ts')

const runOnce = () => {
  const page = { x: 0, y: 0, width: 2020, height: 1600 }
  const surface = writePageSurface(page)
  assert.equal(writeSurfaceIsPage(surface, page), true)
  assert.equal(surface.width, page.width)
  assert.equal(surface.height, page.height)

  const layout = pageCanvasLayout({ width: page.width, height: page.height })
  assert.equal(layout.page.x, 0)
  assert.equal(layout.page.y, 0)
  assert.ok(layout.scroll.width > layout.page.width)
  assert.equal(layout.scroll.width - layout.page.width, layout.pad * 2)

  const canvasBox = { left: 40, top: 20, width: page.width, height: page.height }
  const inner = mapClientToPage(canvasBox.left + 80, canvasBox.top + 80, canvasBox)
  const outer = mapClientToPage(canvasBox.left + 400, canvasBox.top + 80, canvasBox)
  assert.ok(inner && inner.x > 0 && inner.x < 1)
  assert.ok(outer && outer.x > inner.x)
  assert.notEqual(inner.x, 0)
  assert.notEqual(outer.x, 1)

  const bottomOuter = mapClientToPaperPoint(
    { clientX: canvasBox.left + 400, clientY: canvasBox.top + page.height - 40, pressure: 0.5, pointerType: 'mouse' },
    { ...canvasBox, offsetWidth: page.width, offsetHeight: page.height },
  )
  assert.ok(bottomOuter, 'bottom of the write page is writable')
  assert.ok(bottomOuter.y > 0.9 && bottomOuter.y <= 1.05, `bottom sample is on the page, got ${bottomOuter.y}`)
  const pastPage = mapClientToPaperPoint(
    { clientX: canvasBox.left + page.width + 28, clientY: canvasBox.top + page.height + 28, pressure: 0.5, pointerType: 'pen' },
    { ...canvasBox, offsetWidth: page.width, offsetHeight: page.height },
  )
  assert.ok(pastPage && pastPage.x > 1 && pastPage.y > 1, 'a sample just beyond the sheet still maps')

  const below = mapClientToPage(canvasBox.left + 40, canvasBox.top + 800 + 80, canvasBox)
  assert.ok(below && below.y > 0 && below.y < 1)

  const css = readFileSync(join(root, 'src/styles.css'), 'utf8')
  const planeBlock = css.slice(css.indexOf('.paper-sheet-plane {'), css.indexOf('.paper-view-hud {'))
  assert.match(planeBlock, /padding:\s*var\(--paper-scroll-room\)/)
  assert.doesNotMatch(planeBlock, /background-clip:\s*content-box/)
  const noteViewBlock = css.slice(css.indexOf('.unified-note-view {'), css.indexOf('.unified-note-view.is-pdf-note {'))
  assert.match(noteViewBlock, /background:\s*#fff/)
  const board = readFileSync(join(root, 'src/components/DrawingBoard.tsx'), 'utf8')
  assert.match(board, /\.lw-drawing-board\.is-inline\{[^}]*inset:calc\(-1 \* var\(--paper-scroll-room/)
  assert.match(board, /mapClientToPage/)
  assert.match(board, /markdownNoteInkOverlaySize/)
  assert.doesNotMatch(board, /expandSourceToOneCanvas/)
  assert.match(board, /lw-canvas-surface/)
  assert.match(board, /--ink-page-width/)
  const planePaper = css.slice(
    css.indexOf('.paper-sheet-plane > .unified-paper {'),
    css.indexOf('.paper-sheet-plane > .unified-paper.has-ink-extent {'),
  )
  assert.doesNotMatch(planePaper, /(?:^|\n)\s*width:\s*100%/)
  assert.match(css, /width:\s*max\(100%,\s*var\(--ink-page-width/)
  const grownOnWideCss = growPageFromMark(
    { width: PAGE_START_WIDTH, height: 144 },
    { x: 0.94, y: 0.94 },
    { width: 1600, height: 900 },
  )
  assert.ok(grownOnWideCss.width > PAGE_START_WIDTH)
  assert.ok(grownOnWideCss.height > 144)
  const laid = writePageLayoutSize(
    { width: grownOnWideCss.width, height: grownOnWideCss.height },
    { width: 1052, height: 371 },
  )
  assert.ok(laid.width >= grownOnWideCss.width)
  assert.match(css, /\.unified-note-view\.is-inking \.unified-paper \{ box-shadow:\s*none/)

  return {
    oneCanvas: true,
    innerX: inner.x,
    outerX: outer.x,
    room: SCROLL_ROOM,
    startWidth: PAGE_START_WIDTH,
  }
}

try {
  const first = runOnce()
  const second = runOnce()
  assert.deepEqual(first, second)
  console.log(JSON.stringify(first))
  console.log('one-canvas ok')
} finally {
  await server.close()
}
