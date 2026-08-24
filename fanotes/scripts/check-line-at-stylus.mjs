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
  mapClientToPaperPoint,
} = await server.ssrLoadModule('/src/lib/inkSampleMap.ts')
const {
  markdownInkPageBox,
  SCROLL_ROOM,
} = await server.ssrLoadModule('/src/lib/noteCanvas.ts')
const {
  paintMarkdownNoteStiftStroke,
} = await server.ssrLoadModule('/src/lib/inkStrokePaint.ts')
const { mapClientToSheet } = await server.ssrLoadModule('/src/lib/paperCanvas.ts')

const runOnce = () => {
  const paper = { width: 900, height: 1273 }
  const overlay = {
    left: 20,
    top: 30,
    width: paper.width + SCROLL_ROOM * 2,
    height: paper.height + SCROLL_ROOM * 2,
  }
  const plane = { width: overlay.width, height: overlay.height }
  const { page, padY } = markdownInkPageBox(overlay, paper, plane)
  assert.ok(Math.abs(padY - SCROLL_ROOM) <= 1, `page must sit extra-paper inset, padY=${padY}`)
  assert.ok(Math.abs(page.top - (overlay.top + SCROLL_ROOM)) <= 1, 'map box must be the write page, not overlay top')
  assert.equal(page.width, paper.width)
  assert.equal(page.height, paper.height)

  const band = [
    [0.25, 0.24],
    [0.32, 0.25],
    [0.40, 0.26],
    [0.48, 0.255],
    [0.55, 0.27],
    [0.60, 0.26],
  ]
  const events = [
    { type: 'pointerdown', clientX: 0, clientY: 0, pressure: 0, pointerType: 'pen', timeStamp: 0 },
    ...band.map(([nx, ny], index) => ({
      type: index === 0 ? 'pointerdown' : 'pointermove',
      clientX: page.left + nx * page.width,
      clientY: page.top + ny * page.height,
      pressure: 0.55,
      pointerType: 'pen',
      timeStamp: 16 * (index + 1),
    })),
  ]

  const painted = paintMarkdownNoteStiftStroke({ overlay, paper, plane, events })
  assert.ok(Math.abs(painted.page.top - page.top) <= 1, 'paint must use the same page box as mapping')
  assert.ok(painted.points >= 5, `kept samples ${painted.points}`)
  assert.ok(painted.opaque > 0, 'stroke must paint pixels')

  const offsets = []
  for (const event of events) {
    if (event.clientX === 0 && event.clientY === 0) continue
    const mapped = mapClientToPaperPoint(event, page)
    assert.ok(mapped, 'stylus sample on the page must map')
    const viaSheet = mapClientToSheet(event, page)
    assert.ok(viaSheet && Math.abs(viaSheet.y - mapped.y) <= 1e-9)
    const pointerY = event.clientY - page.top
    const paintedY = mapped.y * page.height
    const dy = paintedY - pointerY
    assert.ok(Math.abs(dy) <= 1, `painted Y ${paintedY} is ${dy}px from stylus ${pointerY}`)
    assert.ok(dy <= 1, `line must not sit further up than the stylus (dy=${dy})`)
    offsets.push({ y: mapped.y, paintedY, pointerY, dy })
  }
  const meanDy = offsets.reduce((sum, item) => sum + item.dy, 0) / offsets.length
  assert.ok(Math.abs(meanDy) <= 1, `band systematically shifted by ${meanDy}px`)

  const paintSource = readFileSync(join(root, 'src/lib/inkStrokePaint.ts'), 'utf8')
  const board = readFileSync(join(root, 'src/components/DrawingBoard.tsx'), 'utf8')
  assert.match(paintSource, /markdownInkPageBox/)
  assert.match(board, /var\(--paper-scroll-room, 0px\)/)
  assert.match(board, /calc\(100% - 2 \* \$\{pad\}\)/)

  return {
    padY,
    pageTop: page.top,
    samples: offsets.length,
    last: offsets.at(-1),
    meanDy,
  }
}

try {
  const first = runOnce()
  const second = runOnce()
  assert.deepEqual(first, second)
  console.log(JSON.stringify(first))
  console.log('line-at-stylus ok')
} finally {
  await server.close()
}
