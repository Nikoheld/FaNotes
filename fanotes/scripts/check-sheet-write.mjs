import assert from 'node:assert/strict'
import { createServer } from 'vite'

const server = await createServer({
  appType: 'custom',
  logLevel: 'error',
  optimizeDeps: { noDiscovery: true },
  server: { middlewareMode: true },
})

const {
  PAPER_SOURCE_HEIGHT,
  PAPER_SOURCE_WIDTH,
  PAGE_GROW_STEP_HEIGHT,
  WRITE_SLACK_HEIGHT,
  applyLiveHandwritingGrow,
  neededWriteExtent,
  paperPixelY,
} = await server.ssrLoadModule('/src/lib/paperGrow.ts')
const { inkPointOnWriteSurface, mapClientToPaperPoint } = await server.ssrLoadModule('/src/lib/inkSampleMap.ts')

const runOnce = () => {
  const surface = {
    left: 80,
    top: 40,
    width: 900,
    height: 1273,
    offsetWidth: 900,
    offsetHeight: 1273,
  }
  const sampleX = 0.42
  const sampleY = 0.31
  const mapped = mapClientToPaperPoint({
    clientX: surface.left + sampleX * surface.width,
    clientY: surface.top + sampleY * surface.height,
    pressure: 0.5,
    pointerType: 'pen',
  }, surface)
  assert.ok(mapped)
  const ink = inkPointOnWriteSurface(mapped, surface, { width: 900, height: 1273 })
  assert.ok(ink)
  assert.ok(Math.abs(ink.x - sampleX) < 0.02, `sheet x ${ink.x} must stay at the pointer`)
  assert.ok(Math.abs(ink.y - sampleY) < 0.02, `sheet y ${ink.y} must stay at the pointer`)
  assert.ok(ink.y > 0.2 && ink.y < 0.4)

  const prevH = PAPER_SOURCE_HEIGHT
  const start = { x: 0.42, y: 0.94 }
  const nextH = neededWriteExtent(start.y, prevH, WRITE_SLACK_HEIGHT, PAGE_GROW_STEP_HEIGHT)
  assert.ok(nextH > prevH)
  const visualY = paperPixelY(start.y, prevH)
  const grown = applyLiveHandwritingGrow(
    start,
    { sourceW: PAPER_SOURCE_WIDTH, sourceH: prevH, layoutW: 900, layoutH: prevH },
    { sourceW: PAPER_SOURCE_WIDTH, sourceH: nextH, layoutW: 900, layoutH: nextH },
  )
  assert.equal(grown.remapped, true)
  assert.ok(Math.abs(grown.y * nextH - visualY) <= 1, `painted Y ${grown.y * nextH} must stay ${visualY}`)
  assert.ok(grown.y < start.y)

  return { sampleX: ink.x, sampleY: ink.y, grownY: grown.y, visualY, nextH }
}

try {
  const first = runOnce()
  const second = runOnce()
  assert.deepEqual(first, second)
  console.log(JSON.stringify(first))
  console.log('sheet-write ok')
} finally {
  await server.close()
}
