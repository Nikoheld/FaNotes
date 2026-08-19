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
  applyLiveHandwritingGrow,
  liveGrowScale,
  paperPixelY,
} = await server.ssrLoadModule('/src/lib/paperGrow.ts')
const { isInkCorridorLeap } = await server.ssrLoadModule('/src/lib/inkSampleMap.ts')

try {
  const a4H = PAPER_SOURCE_HEIGHT
  const a4W = PAPER_SOURCE_WIDTH
  const reportY = 0.16
  const a4Box = 1276
  const pdfBox = 4000
  const start = { x: 0.3, y: reportY }
  const visualY = paperPixelY(reportY, a4Box)

  assert.equal(liveGrowScale(a4Box, pdfBox, a4H, a4H), a4Box / pdfBox, 'PDF layout-only grow must remap Y')
  assert.equal(liveGrowScale(a4Box, a4Box * 1.4, a4H, a4H, true), 1, 'width-only leak must not remap Y')

  const shifted = applyLiveHandwritingGrow(
    start,
    { sourceW: a4W, sourceH: a4H, layoutW: a4W, layoutH: a4Box },
    { sourceW: a4W, sourceH: a4H, layoutW: a4W, layoutH: pdfBox },
  )
  assert.equal(shifted.remapped, true)
  assert.ok(Math.abs(shifted.nextPixelY - visualY) <= 1, `painted Y ${shifted.nextPixelY} must stay ${visualY}`)
  assert.ok(shifted.y > 0.02 && shifted.y < reportY)

  const stale = applyLiveHandwritingGrow(
    start,
    { sourceW: a4W, sourceH: a4H, layoutW: a4W, layoutH: a4Box },
    { sourceW: a4W, sourceH: a4H, layoutW: a4W, layoutH: pdfBox },
  )
  const continued = { x: 0.4, y: reportY }
  assert.equal(isInkCorridorLeap(stale, continued), true, 'unremapped next sample on the tall box looks like a leap')
  assert.equal(isInkCorridorLeap(shifted, { x: 0.4, y: shifted.y }), false)

  console.log(JSON.stringify({
    reportY,
    remappedY: shifted.y,
    paintedY: shifted.nextPixelY,
    visualY,
    pdfScale: a4Box / pdfBox,
  }))
  console.log('bug-ink-shift ok')
} finally {
  await server.close()
}
