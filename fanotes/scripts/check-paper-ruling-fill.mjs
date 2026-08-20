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
  assert.equal(paperRulingCoversCameraSides(fill, layout.sheet, layout.plane), true)
  assert.ok(fill.x < layout.sheet.x)
  assert.ok(fill.y < layout.sheet.y)
  assert.ok(fill.x + fill.width > layout.sheet.x + layout.sheet.width)
  assert.ok(fill.y + fill.height > layout.sheet.y + layout.sheet.height)
  assert.equal(paperRulingCoversCameraSides(layout.sheet, layout.sheet, layout.plane), false)
  return {
    coversPlane: true,
    left: layout.sheet.x - fill.x,
    top: layout.sheet.y - fill.y,
    right: fill.x + fill.width - (layout.sheet.x + layout.sheet.width),
    bottom: fill.y + fill.height - (layout.sheet.y + layout.sheet.height),
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
