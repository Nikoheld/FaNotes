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
  PAPER_STAGE_BACKGROUND,
  growSheetFromInk,
  inkOverlayCoversStage,
  mapClientToSheet,
  paperCanvasLayout,
} = await server.ssrLoadModule('/src/lib/paperCanvas.ts')
const { SCROLL_ROOM } = await server.ssrLoadModule('/src/lib/paperGrow.ts')
const { paintMarkdownNoteStiftStroke } = await server.ssrLoadModule('/src/lib/inkStrokePaint.ts')

const runOnce = () => {
  const sheet = { width: 900, height: 1273 }
  const layout = paperCanvasLayout(sheet)
  assert.equal(layout.pad, SCROLL_ROOM)
  assert.equal(layout.sheet.x, SCROLL_ROOM)
  assert.equal(layout.sheet.y, SCROLL_ROOM)
  assert.equal(layout.stage.width, sheet.width + SCROLL_ROOM * 2)
  assert.equal(layout.stage.height, sheet.height + SCROLL_ROOM * 2)
  assert.equal(PAPER_STAGE_BACKGROUND, '#111')

  const collapsed = inkOverlayCoversStage({ width: 0, height: 0 }, sheet)
  assert.ok(collapsed.width >= layout.stage.width - 1, `0×0 overlay must cover the stage, got ${collapsed.width}`)
  assert.ok(collapsed.height >= layout.stage.height - 1)
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

  const onStage = mapClientToSheet({
    clientX: sheetBox.left - 80,
    clientY: sheetBox.top + 200,
    pressure: 0.55,
    pointerType: 'pen',
  }, sheetBox)
  assert.equal(onStage, null, 'left of the Blatt is dark stage, not more paper')

  const above = mapClientToSheet({
    clientX: sheetBox.left + 200,
    clientY: sheetBox.top - 40,
    pressure: 0.55,
    pointerType: 'pen',
  }, sheetBox)
  assert.equal(above, null, 'above the Blatt is dark stage')

  const leftGrow = growSheetFromInk(0.02, 0.5, 900, 1273)
  assert.equal(leftGrow.padX, 0)
  assert.equal(leftGrow.width, 900, 'writing at the left edge must not widen the Blatt')
  const down = growSheetFromInk(0.5, 0.94, 900, 1273)
  assert.ok(down.height > 1273, 'writing at the bottom still grows the Blatt')
  const right = growSheetFromInk(0.94, 0.5, 900, 1273)
  assert.ok(right.width > 900, 'writing at the right still grows the Blatt')

  const painted = paintMarkdownNoteStiftStroke({
    overlay: { left: 40, top: 24, width: 0, height: 0 },
    paper: sheet,
    events: [
      { type: 'pointerdown', clientX: 0, clientY: 0, pressure: 0, pointerType: 'pen', timeStamp: 0 },
      { type: 'pointerdown', clientX: 40 + 0.22 * 900, clientY: 24 + 0.28 * 1273, pressure: 0.55, pointerType: 'pen', timeStamp: 16 },
      { type: 'pointermove', clientX: 40 + 0.28 * 900, clientY: 24 + 0.34 * 1273, pressure: 0.55, pointerType: 'pen', timeStamp: 32 },
      { type: 'pointermove', clientX: 40 + 0.36 * 900, clientY: 24 + 0.41 * 1273, pressure: 0.55, pointerType: 'pen', timeStamp: 48 },
      { type: 'pointermove', clientX: 40 + 0.44 * 900, clientY: 24 + 0.47 * 1273, pressure: 0.55, pointerType: 'pen', timeStamp: 64 },
    ],
  })
  assert.ok(painted.overlayWidth >= layout.stage.width - 1, `overlay must cover stage, got ${painted.overlayWidth}`)
  assert.ok(painted.bitmapWidth >= 8 && painted.bitmapHeight >= 8)
  assert.ok(painted.points >= 3, `mapped Blatt stroke must keep real samples, got ${painted.points}`)
  assert.ok(painted.opaque > 0, `stage-covering overlay still paints on the Blatt (${painted.opaque})`)
  assert.ok(painted.area >= 16, `stroke bounding box must be a visible line, got ${painted.boxW}x${painted.boxH}`)
  assert.ok(painted.boxW >= 4 && painted.boxH >= 4)

  const css = readFileSync(join(root, 'src/styles.css'), 'utf8')
  const board = readFileSync(join(root, 'src/components/DrawingBoard.tsx'), 'utf8')
  assert.match(css, /\.unified-note-view \{[\s\S]*?background:\s*#111/)
  assert.match(board, /inset:calc\(-1 \* var\(--paper-scroll-room/)
  assert.match(board, /mapClientToSheet/)
  assert.match(board, /markdownNoteInkOverlaySize/)

  return {
    stageW: layout.stage.width,
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
