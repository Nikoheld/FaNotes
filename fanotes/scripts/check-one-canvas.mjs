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
  PAPER_SOURCE_WIDTH,
  SCROLL_ROOM,
  expandSourceToOneCanvas,
  mapClientToOneCanvas,
  oneCanvasSurface,
  remapNormalizedAfterExtent,
  textColumnOnOneCanvas,
  writeSurfaceIsPlane,
} = await server.ssrLoadModule('/src/lib/paperGrow.ts')
const { mapClientToPaperPoint } = await server.ssrLoadModule('/src/lib/inkSampleMap.ts')

const runOnce = () => {
  const plane = { x: 0, y: 0, width: 2020, height: 1600 }
  const surface = oneCanvasSurface(plane)
  assert.equal(writeSurfaceIsPlane(surface, plane), true)
  assert.equal(surface.width, plane.width)
  assert.equal(surface.height, plane.height)

  const column = textColumnOnOneCanvas(plane.width, plane.height)
  assert.ok(column.x > 0, 'text column is inset, not a second canvas')
  assert.equal(column.width, PAPER_SOURCE_WIDTH)
  assert.ok(column.x + column.width <= plane.width)

  const canvasBox = { left: 40, top: 20, width: plane.width, height: plane.height }
  const innerLeft = mapClientToOneCanvas(canvasBox.left + column.x, canvasBox.top + 80, canvasBox)
  const outerLeft = mapClientToOneCanvas(canvasBox.left + 80, canvasBox.top + 80, canvasBox)
  const innerEdge = mapClientToOneCanvas(canvasBox.left + column.x, canvasBox.top + 80, {
    left: canvasBox.left + column.x,
    top: canvasBox.top,
    width: column.width,
    height: plane.height,
  })
  assert.ok(outerLeft.x > 0 && outerLeft.x < innerLeft.x, 'outer-plane writing is on the one canvas, not clamped to the column edge')
  assert.ok(Math.abs(innerEdge.x) < 1e-6, 'column-left in column space is 0')
  assert.notEqual(outerLeft.x, 0, 'must not pin outer writing to x=0')
  assert.notEqual(outerLeft.x, 1, 'must not pin outer writing to x=1')

  const bottomOuter = mapClientToPaperPoint(
    { clientX: canvasBox.left + 400, clientY: canvasBox.top + plane.height - 40, pressure: 0.5, pointerType: 'mouse' },
    { ...canvasBox, offsetWidth: plane.width, offsetHeight: plane.height },
  )
  assert.ok(bottomOuter, 'bottom of the one canvas is writable')
  assert.ok(bottomOuter.y > 0.9 && bottomOuter.y <= 1.05, `bottom sample is on the canvas, got ${bottomOuter.y}`)

  const belowCardClient = { x: canvasBox.left + column.x + 40, y: canvasBox.top + 800 + 80 }
  const belowOnCanvas = mapClientToOneCanvas(belowCardClient.x, belowCardClient.y, canvasBox)
  const belowOnCard = mapClientToOneCanvas(belowCardClient.x, belowCardClient.y, {
    left: canvasBox.left + column.x,
    top: canvasBox.top,
    width: column.width,
    height: 800,
  })
  assert.ok(belowOnCard.y > 1, 'report-shaped sample sits past the inner card')
  assert.ok(belowOnCanvas.y > 0 && belowOnCanvas.y < 1, 'the same sample is inside the one canvas, not clamped to y=1')
  assert.notEqual(belowOnCanvas.y, 1)

  const expanded = expandSourceToOneCanvas({
    sourceW: PAPER_SOURCE_WIDTH,
    sourceH: 800,
    paintedW: plane.width,
    paintedH: plane.height,
    columnW: column.width,
    columnH: 800,
    originXpx: column.x,
    originYpx: 0,
  })
  assert.equal(expanded.absorb, true)
  const leftInk = remapNormalizedAfterExtent(0, PAPER_SOURCE_WIDTH, expanded.nextW, expanded.padX)
  const leftPx = leftInk * plane.width
  assert.ok(Math.abs(leftPx - column.x) < 2, `legacy x=0 stays on the text column (${leftPx} vs ${column.x})`)

  const css = readFileSync(join(root, 'src/styles.css'), 'utf8')
  const planeBlock = css.slice(css.indexOf('.paper-sheet-plane {'), css.indexOf('.paper-view-hud {'))
  assert.match(planeBlock, /padding:\s*0/)
  assert.doesNotMatch(planeBlock, /padding:\s*var\(--paper-scroll-room\)/)
  const board = readFileSync(join(root, 'src/components/DrawingBoard.tsx'), 'utf8')
  assert.match(board, /\.lw-drawing-board\.is-inline\{[^}]*inset:0/)
  assert.doesNotMatch(board, /inset:calc\(-1 \* var\(--paper-scroll-room/)
  assert.match(board, /mapClientToOneCanvas/)
  assert.match(board, /expandSourceToOneCanvas/)
  assert.match(board, /lw-canvas-surface/)
  assert.match(css, /\.paper-sheet-plane > \.unified-paper \{[\s\S]*?width:\s*100%/)
  assert.match(css, /\.unified-note-view\.is-inking \.unified-paper \{ box-shadow:\s*none/)

  return {
    oneCanvas: true,
    outerX: outerLeft.x,
    columnX: innerLeft.x,
    legacyLeftPx: leftPx,
    room: SCROLL_ROOM,
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
