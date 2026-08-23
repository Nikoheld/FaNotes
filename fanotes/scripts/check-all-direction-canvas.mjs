import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

const server = await createServer({
  appType: 'custom',
  logLevel: 'error',
  optimizeDeps: { noDiscovery: true },
  server: { middlewareMode: true },
})

const {
  GROW_STEP_X,
  GROW_STEP_Y,
  PAGE_START_HEIGHT,
  PAGE_START_WIDTH,
  SCROLL_ROOM,
  WRITE_MARGIN_X,
  WRITE_MARGIN_Y,
  canvasScrollBounds,
  growPageFromMark,
  growWriteExtent,
  growWriteOrigin,
  keepMarkOnPage,
  paperMinEdgeGrows,
} = await server.ssrLoadModule('/src/lib/noteCanvas.ts')
const {
  paperCameraSheetLayout,
  paperRulingCoversCameraSides,
  paperRulingFillBox,
  paperRulingStaysOnSheet,
} = await server.ssrLoadModule('/src/lib/paperRuling.ts')

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

const runOnce = () => {
  assert.ok(SCROLL_ROOM > WRITE_MARGIN_Y * 2, 'pan room must be reasonably far')
  assert.ok(SCROLL_ROOM < PAGE_START_HEIGHT * 2, 'pan room must stay finite')

  const leftPad = growWriteOrigin(0.02, PAGE_START_WIDTH, WRITE_MARGIN_X, GROW_STEP_X)
  const upPad = growWriteOrigin(0.02, PAGE_START_HEIGHT, WRITE_MARGIN_Y, GROW_STEP_Y)
  assert.ok(leftPad > 0, 'writing on the left edge must open more paper')
  assert.ok(upPad > 0, 'writing on the top edge must open more paper')
  assert.equal(paperMinEdgeGrows(0.02, PAGE_START_WIDTH, WRITE_MARGIN_X, GROW_STEP_X), true)
  assert.equal(paperMinEdgeGrows(0, PAGE_START_HEIGHT, WRITE_MARGIN_Y, GROW_STEP_Y), true)
  assert.equal(growWriteOrigin(0.4, PAGE_START_WIDTH, WRITE_MARGIN_X, GROW_STEP_X), 0)
  assert.equal(growWriteOrigin(0.4, PAGE_START_HEIGHT, WRITE_MARGIN_Y, GROW_STEP_Y), 0)

  const mark = { x: 0.2, y: 0.3 }
  const grownLeft = growPageFromMark(
    { width: PAGE_START_WIDTH, height: PAGE_START_HEIGHT },
    { x: 0.02, y: 0.02 },
  )
  const shiftedX = keepMarkOnPage(mark.x, PAGE_START_WIDTH, grownLeft.width, grownLeft.padX)
  const shiftedY = keepMarkOnPage(mark.y, PAGE_START_HEIGHT, grownLeft.height, grownLeft.padY)
  assert.ok(Math.abs(shiftedX * grownLeft.width - (mark.x * PAGE_START_WIDTH + grownLeft.padX)) < 1e-6)
  assert.ok(Math.abs(shiftedY * grownLeft.height - (mark.y * PAGE_START_HEIGHT + grownLeft.padY)) < 1e-6)

  const right = growWriteExtent(0.94, PAGE_START_WIDTH, WRITE_MARGIN_X, GROW_STEP_X)
  const down = growWriteExtent(0.94, PAGE_START_HEIGHT, WRITE_MARGIN_Y, GROW_STEP_Y)
  assert.ok(right > PAGE_START_WIDTH)
  assert.ok(down > PAGE_START_HEIGHT)

  const camera = canvasScrollBounds({ minX: 0, minY: 0, maxX: PAGE_START_WIDTH, maxY: PAGE_START_HEIGHT })
  assert.equal(camera.minX, -SCROLL_ROOM)
  assert.equal(camera.minY, -SCROLL_ROOM)
  assert.equal(camera.maxX, PAGE_START_WIDTH + SCROLL_ROOM)
  assert.equal(camera.maxY, PAGE_START_HEIGHT + SCROLL_ROOM)

  const layout = paperCameraSheetLayout(2020, 2393, 900, 1273)
  const fill = paperRulingFillBox(layout.sheet, layout.plane)
  assert.equal(layout.sheet.x, 0, 'write page starts at the origin, not after a dark stage')
  assert.equal(layout.sheet.y, 0)
  assert.equal(paperRulingStaysOnSheet(fill, layout.sheet), true)
  assert.equal(paperRulingCoversCameraSides(fill, layout.sheet, layout.plane), true)

  const css = readFileSync(join(root, 'src/styles.css'), 'utf8')
  assert.match(css, /--paper-scroll-room:/)
  const noteViewBlock = css.slice(css.indexOf('.unified-note-view {'), css.indexOf('.unified-note-view.is-pdf-note {'))
  assert.match(noteViewBlock, /background:\s*#fff/)
  assert.doesNotMatch(noteViewBlock, /background:\s*#111\b/)
  const planeBlock = css.slice(css.indexOf('.paper-sheet-plane {'), css.indexOf('.paper-view-hud {'))
  assert.match(planeBlock, /padding:\s*var\(--paper-scroll-room\)/)
  assert.match(planeBlock, /min-width:\s*100%/)
  assert.match(planeBlock, /min-height:\s*100%/)
  const board = readFileSync(join(root, 'src/components/DrawingBoard.tsx'), 'utf8')
  assert.match(board, /growPageFromMark/)
  assert.match(board, /keepMarkOnPage/)
  assert.match(board, /SCROLL_ROOM/)

  return {
    leftPad,
    upPad,
    shiftedX,
    shiftedY,
    cameraMinX: camera.minX,
    room: SCROLL_ROOM,
    sheetX: layout.sheet.x,
    sheetY: layout.sheet.y,
  }
}

try {
  const first = runOnce()
  const second = runOnce()
  assert.deepEqual(first, second)
  console.log(JSON.stringify(first))
  console.log('all-direction-canvas ok')
} finally {
  await server.close()
}
