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
  PAGE_GROW_STEP_HEIGHT,
  PAGE_GROW_STEP_WIDTH,
  PAPER_SOURCE_HEIGHT,
  PAPER_SOURCE_WIDTH,
  SCROLL_ROOM,
  WRITE_SLACK_HEIGHT,
  WRITE_SLACK_WIDTH,
  neededWriteExtent,
  neededWriteMinPad,
  paperScrollBounds,
  remapNormalizedAfterExtent,
} = await server.ssrLoadModule('/src/lib/paperGrow.ts')

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

const runOnce = () => {
  assert.ok(SCROLL_ROOM >= 400, 'pan room must be reasonably far')
  assert.ok(SCROLL_ROOM < PAPER_SOURCE_HEIGHT * 2, 'pan room must stay finite')

  const leftPad = neededWriteMinPad(0.02, PAPER_SOURCE_WIDTH, WRITE_SLACK_WIDTH, PAGE_GROW_STEP_WIDTH)
  const upPad = neededWriteMinPad(0.02, PAPER_SOURCE_HEIGHT, WRITE_SLACK_HEIGHT, PAGE_GROW_STEP_HEIGHT)
  assert.ok(leftPad > 0, 'writing on the left edge must open space to the left')
  assert.ok(upPad > 0, 'writing on the top edge must open space above')
  assert.equal(neededWriteMinPad(0.4, PAPER_SOURCE_WIDTH, WRITE_SLACK_WIDTH, PAGE_GROW_STEP_WIDTH), 0)
  assert.equal(neededWriteMinPad(0.4, PAPER_SOURCE_HEIGHT, WRITE_SLACK_HEIGHT, PAGE_GROW_STEP_HEIGHT), 0)

  const mark = { x: 0.2, y: 0.3 }
  const nextW = PAPER_SOURCE_WIDTH + leftPad
  const nextH = PAPER_SOURCE_HEIGHT + upPad
  const shiftedX = remapNormalizedAfterExtent(mark.x, PAPER_SOURCE_WIDTH, nextW, leftPad)
  const shiftedY = remapNormalizedAfterExtent(mark.y, PAPER_SOURCE_HEIGHT, nextH, upPad)
  assert.ok(Math.abs(shiftedX * nextW - (mark.x * PAPER_SOURCE_WIDTH + leftPad)) < 1e-6)
  assert.ok(Math.abs(shiftedY * nextH - (mark.y * PAPER_SOURCE_HEIGHT + upPad)) < 1e-6)

  const right = neededWriteExtent(0.94, PAPER_SOURCE_WIDTH, WRITE_SLACK_WIDTH, PAGE_GROW_STEP_WIDTH)
  const down = neededWriteExtent(0.94, PAPER_SOURCE_HEIGHT, WRITE_SLACK_HEIGHT, PAGE_GROW_STEP_HEIGHT)
  assert.ok(right > PAPER_SOURCE_WIDTH)
  assert.ok(down > PAPER_SOURCE_HEIGHT)

  const camera = paperScrollBounds({ minX: 0, minY: 0, maxX: PAPER_SOURCE_WIDTH, maxY: PAPER_SOURCE_HEIGHT })
  assert.equal(camera.minX, -SCROLL_ROOM)
  assert.equal(camera.minY, -SCROLL_ROOM)
  assert.equal(camera.maxX, PAPER_SOURCE_WIDTH + SCROLL_ROOM)
  assert.equal(camera.maxY, PAPER_SOURCE_HEIGHT + SCROLL_ROOM)

  const css = readFileSync(join(root, 'src/styles.css'), 'utf8')
  assert.match(css, /--paper-scroll-room:\s*560px/)
  assert.match(css, /\.paper-sheet-plane \{[\s\S]*?min-width:\s*100%/)
  assert.match(css, /\.paper-sheet-plane \{[\s\S]*?min-height:\s*100%/)
  assert.match(css, /\.unified-paper > \.editor-pane \{[\s\S]*?max-width:\s*900px/)
  assert.match(css, /\.unified-paper > \.editor-pane \{[\s\S]*?margin-left:\s*var\(--text-origin-x/)
  const worksheet = css.slice(css.indexOf('.worksheet-layer {'), css.indexOf('.worksheet-toolbar {'))
  assert.match(worksheet, /margin-left:\s*var\(--text-origin-x/)
  assert.match(worksheet, /max-width:\s*900px/)
  const sheet = readFileSync(join(root, 'src/components/WorksheetLayer.tsx'), 'utf8')
  assert.match(sheet, /className="worksheet-remove"/)
  assert.match(sheet, /Entfernen/)
  const textOnInk = css.slice(
    css.indexOf('.unified-paper.has-ink-extent .markdown-editor .cm-content {'),
    css.indexOf('.unified-paper.has-ink-extent .markdown-editor .cm-content {') + 280,
  )
  assert.match(textOnInk, /min-height:\s*0/)
  assert.doesNotMatch(textOnInk, /ink-extent-ratio/)

  const board = readFileSync(join(root, 'src/components/DrawingBoard.tsx'), 'utf8')
  assert.match(board, /neededWriteMinPad/)
  assert.match(board, /remapNormalizedAfterExtent/)
  assert.match(board, /--text-origin-x/)
  assert.match(board, /SCROLL_ROOM/)

  return { leftPad, upPad, shiftedX, shiftedY, cameraMinX: camera.minX, room: SCROLL_ROOM }
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
