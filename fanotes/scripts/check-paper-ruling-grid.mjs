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
  PAPER_DOT_TILE_PX,
  paperCameraSheetLayout,
  paperRulingContinuousGrid,
  paperRulingDoublePaint,
  paperRulingFillBox,
  paperRulingSameLattice,
  paperRulingTileOrigin,
} = await server.ssrLoadModule('/src/lib/paperRuling.ts')

const runOnce = () => {
  const plane = { x: 0, y: 0, width: 2040, height: 2413 }
  const sheet = { x: 570, y: 570, width: 900, height: 1273 }
  assert.notEqual(sheet.x % PAPER_DOT_TILE_PX, 0)
  const fill = paperRulingFillBox(sheet, plane)
  const origin = paperRulingTileOrigin(sheet)
  const sheetPoint = { x: sheet.x + 14, y: sheet.y + 14 }
  const onSheet = { x: sheet.x + 42, y: sheet.y + 42 }
  assert.equal(paperRulingContinuousGrid(sheetPoint, onSheet, origin, PAPER_DOT_TILE_PX), true)
  assert.equal(paperRulingSameLattice(origin, origin, PAPER_DOT_TILE_PX), true)
  assert.equal(fill.x, sheet.x)
  assert.equal(fill.y, sheet.y)
  assert.ok(fill.x > plane.x, 'left stage has no ruling')
  assert.equal(paperRulingDoublePaint(fill, sheet), true)
  assert.equal(paperRulingDoublePaint(fill, null), false)
  const layout = paperCameraSheetLayout(2040, 2413, 900, 1273)
  assert.equal(paperRulingContinuousGrid(
    { x: layout.sheet.x + 10, y: layout.sheet.y + 10 },
    { x: layout.sheet.x + 38, y: layout.sheet.y + 38 },
    layout.origin,
    layout.tile,
  ), true)
  return {
    tile: PAPER_DOT_TILE_PX,
    continuous: true,
    noDouble: !paperRulingDoublePaint(fill, null),
  }
}

try {
  const first = runOnce()
  const second = runOnce()
  assert.deepEqual(first, second)
  console.log(JSON.stringify(first))
  console.log('paper-ruling-grid ok')
} finally {
  await server.close()
}
