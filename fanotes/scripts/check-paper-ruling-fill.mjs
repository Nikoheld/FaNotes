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
} = await server.ssrLoadModule('/src/lib/paperRuling.ts')
const { SCROLL_ROOM } = await server.ssrLoadModule('/src/lib/paperGrow.ts')

const runOnce = () => {
  const layout = paperCameraSheetLayout(2020, 2393, 900, 1273)
  assert.equal(layout.room, SCROLL_ROOM)
  const fill = paperRulingFillBox(layout.sheet, layout.plane)
  assert.equal(fill.x, layout.plane.x)
  assert.equal(fill.y, layout.plane.y)
  assert.equal(fill.width, layout.plane.width)
  assert.equal(fill.height, layout.plane.height)
  assert.equal(layout.sheet.x, layout.plane.x, 'write sheet is the plane — one canvas')
  assert.equal(layout.sheet.y, layout.plane.y)
  assert.equal(layout.sheet.width, layout.plane.width)
  assert.equal(layout.sheet.height, layout.plane.height)
  assert.ok(layout.text.x > 0, 'text column stays inset on the one canvas')
  assert.ok(layout.text.width <= 900)
  assert.equal(fill.x, layout.plane.x)
  assert.equal(fill.width, layout.plane.width)
  assert.ok(fill.x < layout.text.x)
  assert.ok(fill.x + fill.width > layout.text.x + layout.text.width)
  assert.equal(paperRulingCoversCameraSides(layout.text, layout.text, layout.plane), false)
  return {
    coversPlane: true,
    oneCanvas: true,
    left: layout.text.x - fill.x,
    top: layout.text.y - fill.y,
    right: fill.x + fill.width - (layout.text.x + layout.text.width),
    bottom: fill.y + fill.height - (layout.text.y + layout.text.height),
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
