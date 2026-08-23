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
  mapClientToPage,
  pageCanvasLayout,
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
  assert.match(css, /\.paper-sheet-plane > \.unified-paper \{[\s\S]*?width:\s*100%/)
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
