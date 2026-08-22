import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

const server = await createServer({
  root: fileURLToPath(new URL('..', import.meta.url)),
  appType: 'custom',
  logLevel: 'error',
  optimizeDeps: { noDiscovery: true },
  server: { middlewareMode: true },
})

const {
  paperCameraSheetLayout,
  paperRulingCoversCameraSides,
  paperRulingFillBox,
  paperRulingStaysOnSheet,
} = await server.ssrLoadModule('/src/lib/paperRuling.ts')
const { SCROLL_ROOM } = await server.ssrLoadModule('/src/lib/paperGrow.ts')

const runOnce = () => {
  const layout = paperCameraSheetLayout(2020, 2393, 900, 1273)
  assert.equal(layout.room, SCROLL_ROOM)
  const fill = paperRulingFillBox(layout.sheet, layout.plane)
  assert.ok(layout.sheet.x >= SCROLL_ROOM - 1, 'left of the Blatt is stage, not paper')
  assert.ok(layout.sheet.y >= SCROLL_ROOM - 1, 'top of the Blatt is stage, not paper')
  assert.equal(fill.x, layout.sheet.x)
  assert.equal(fill.y, layout.sheet.y)
  assert.equal(fill.width, layout.sheet.width)
  assert.equal(fill.height, layout.sheet.height)
  assert.equal(paperRulingStaysOnSheet(fill, layout.sheet), true)
  assert.equal(paperRulingCoversCameraSides(fill, layout.sheet, layout.plane), false)
  assert.ok(layout.text.width <= 900)
  assert.ok(fill.x > layout.plane.x, 'ruling must not paint the left stage')
  assert.ok(fill.y > layout.plane.y, 'ruling must not paint the top stage')
  return {
    coversPlane: false,
    sheetOnStage: true,
    left: fill.x - layout.plane.x,
    top: fill.y - layout.plane.y,
    right: layout.plane.x + layout.plane.width - (fill.x + fill.width),
    bottom: layout.plane.y + layout.plane.height - (fill.y + fill.height),
  }
}

try {
  const first = runOnce()
  const second = runOnce()
  assert.deepEqual(first, second)
  console.log(JSON.stringify(first))
  console.log('paper-ruling-fill ok')
} finally {
  await server.close()
}
