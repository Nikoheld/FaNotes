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
  PAPER_PAGE_BACKGROUND,
  growSheetFromInk,
  inkOverlayCoversStage,
  mapClientToSheet,
  paperCanvasLayout,
} = await server.ssrLoadModule('/src/lib/paperCanvas.ts')
const { SCROLL_ROOM } = await server.ssrLoadModule('/src/lib/noteCanvas.ts')
const { paintMarkdownNoteStiftStroke } = await server.ssrLoadModule('/src/lib/inkStrokePaint.ts')

const runOnce = () => {
  const page = { width: 900, height: 1273 }
  const layout = paperCanvasLayout(page)
  assert.equal(layout.pad, SCROLL_ROOM)
  assert.equal(layout.page.x, 0)
  assert.equal(layout.page.y, 0)
  assert.equal(layout.sheet.x, 0)
  assert.equal(layout.sheet.y, 0)
  assert.equal(layout.scroll.width, page.width + SCROLL_ROOM * 2)
  assert.equal(layout.scroll.height, page.height + SCROLL_ROOM * 2)
  assert.equal(PAPER_PAGE_BACKGROUND, '#fff')

  const collapsed = inkOverlayCoversStage({ width: 0, height: 0 }, page)
  assert.ok(collapsed.width >= layout.scroll.width - 1, `0×0 overlay must cover the write page plus extra paper, got ${collapsed.width}`)
  assert.ok(collapsed.height >= layout.scroll.height - 1)
  assert.equal(inkOverlayCoversStage({ width: 0, height: 0 }, { width: 0, height: 0 }).width, 0)

  const sheetBox = {
    left: 40,
    top: 24,
    width: 900,
    height: 1273,
    offsetWidth: 900,
    offsetHeight: 1273,
  }
  const onSheet = mapClientToSheet({
    clientX: sheetBox.left + 0.22 * sheetBox.width,
    clientY: sheetBox.top + 0.28 * sheetBox.height,
    pressure: 0.55,
    pointerType: 'pen',
  }, sheetBox)
  assert.ok(onSheet && onSheet.x > 0.2 && onSheet.y > 0.2)

  const pastLeft = mapClientToSheet({
    clientX: sheetBox.left - 80,
    clientY: sheetBox.top + 200,
    pressure: 0.55,
    pointerType: 'pen',
  }, sheetBox)
  assert.ok(pastLeft && pastLeft.x < 0, 'left of the page is extra paper that can grow the page')

  const pastTop = mapClientToSheet({
    clientX: sheetBox.left + 200,
    clientY: sheetBox.top - 40,
    pressure: 0.55,
    pointerType: 'pen',
  }, sheetBox)
  assert.ok(pastTop && pastTop.y < 0, 'above the page is extra paper')

  const leftGrow = growSheetFromInk(0.02, 0.5, 900, 1273)
  assert.ok(leftGrow.padX > 0)
  assert.ok(leftGrow.width > 900, 'writing at the left edge widens the page')
  const down = growSheetFromInk(0.5, 0.94, 900, 1273)
  assert.ok(down.height > 1273, 'writing at the bottom still grows the page')
  const right = growSheetFromInk(0.94, 0.5, 900, 1273)
  assert.ok(right.width > 900, 'writing at the right still grows the page')

  const painted = paintMarkdownNoteStiftStroke({
    overlay: { left: 40, top: 24, width: 0, height: 0 },
    paper: page,
    events: [
      { type: 'pointerdown', clientX: 0, clientY: 0, pressure: 0, pointerType: 'pen', timeStamp: 0 },
      { type: 'pointerdown', clientX: 40 + 0.22 * 900, clientY: 24 + 0.28 * 1273, pressure: 0.55, pointerType: 'pen', timeStamp: 16 },
      { type: 'pointermove', clientX: 40 + 0.28 * 900, clientY: 24 + 0.34 * 1273, pressure: 0.55, pointerType: 'pen', timeStamp: 32 },
      { type: 'pointermove', clientX: 40 + 0.36 * 900, clientY: 24 + 0.41 * 1273, pressure: 0.55, pointerType: 'pen', timeStamp: 48 },
      { type: 'pointermove', clientX: 40 + 0.44 * 900, clientY: 24 + 0.47 * 1273, pressure: 0.55, pointerType: 'pen', timeStamp: 64 },
    ],
  })
  assert.ok(painted.overlayWidth >= layout.scroll.width - 1, `overlay must cover extra paper, got ${painted.overlayWidth}`)
  assert.ok(painted.bitmapWidth >= 8 && painted.bitmapHeight >= 8)
  assert.ok(painted.points >= 3, `mapped page stroke must keep real samples, got ${painted.points}`)
  assert.ok(painted.opaque > 0, `page-covering overlay still paints on the page (${painted.opaque})`)
  assert.ok(painted.area >= 16, `stroke bounding box must be a visible line, got ${painted.boxW}x${painted.boxH}`)
  assert.ok(painted.boxW >= 4 && painted.boxH >= 4)

  const css = readFileSync(join(root, 'src/styles.css'), 'utf8')
  const board = readFileSync(join(root, 'src/components/DrawingBoard.tsx'), 'utf8')
  const noteViewBlock = css.slice(css.indexOf('.unified-note-view {'), css.indexOf('.unified-note-view.is-pdf-note {'))
  assert.match(noteViewBlock, /background:\s*#fff/)
  assert.match(board, /inset:calc\(-1 \* var\(--paper-scroll-room/)
  assert.match(board, /mapClientToSheet/)
  assert.match(board, /markdownNoteInkOverlaySize/)

  return {
    scrollW: layout.scroll.width,
    overlayW: painted.overlayWidth,
    opaque: painted.opaque,
    leftPad: leftGrow.padX,
    downH: down.height,
  }
}

try {
  const first = runOnce()
  const second = runOnce()
  assert.deepEqual(first, second)
  console.log(JSON.stringify(first))
  console.log('paper-canvas ok')
} finally {
  await server.close()
}
