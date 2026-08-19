import assert from 'node:assert/strict'
import { createServer } from 'vite'

const server = await createServer({
  appType: 'custom',
  logLevel: 'error',
  optimizeDeps: { noDiscovery: true },
  server: { middlewareMode: true },
})

const {
  acceptCommittedInkSample,
  mapClientToPaperPoint,
} = await server.ssrLoadModule('/src/lib/inkSampleMap.ts')
const {
  PAPER_SOURCE_HEIGHT,
  PAPER_SOURCE_WIDTH,
  PAGE_GROW_STEP_HEIGHT,
  WRITE_SLACK_HEIGHT,
  applyLiveHandwritingGrow,
  neededWriteExtent,
  paperPixelY,
} = await server.ssrLoadModule('/src/lib/paperGrow.ts')

try {
  const reportY = 0.3
  const a4 = PAPER_SOURCE_HEIGHT
  assert.equal(
    neededWriteExtent(reportY, a4, WRITE_SLACK_HEIGHT, PAGE_GROW_STEP_HEIGHT),
    a4,
    'upper-third y≈0.30 on A4 must not grow',
  )

  const start = { x: 0.33, y: reportY }
  const visualY = paperPixelY(reportY, a4)
  const zeroBox = applyLiveHandwritingGrow(
    start,
    { sourceW: PAPER_SOURCE_WIDTH, sourceH: a4, layoutW: 0, layoutH: 0 },
    { sourceW: PAPER_SOURCE_WIDTH, sourceH: a4, layoutW: 900, layoutH: a4 },
  )
  assert.equal(zeroBox.remapped, false, 'zero painted box must not remap 0–1 Y')
  assert.equal(zeroBox.y, reportY)
  assert.ok(Math.abs(zeroBox.nextPixelY - visualY) <= 1)
  assert.ok(zeroBox.y > 0.2, 'must not slam the report point toward y≈0')

  const surface = { left: 140, top: 90, width: 600, height: 800, offsetWidth: 900, offsetHeight: a4 }
  assert.equal(
    mapClientToPaperPoint({ type: 'pointerdown', clientX: 0, clientY: 0, pressure: 0.4, pointerType: 'pen' }, surface),
    null,
    '0,0 is not accepted when the paper corner is not at the origin',
  )
  assert.equal(
    acceptCommittedInkSample(
      { type: 'pointermove', clientX: 0, clientY: 0, pressure: 0.4, pointerType: 'pen' },
      surface,
      { x: 0.33, y: reportY },
      PAPER_SOURCE_WIDTH,
      a4,
    ),
    null,
  )

  console.log(JSON.stringify({
    reportY,
    extent: a4,
    zeroBoxY: zeroBox.y,
    visualY,
  }))
  console.log('bug-pen-line-up-stay ok')
} finally {
  await server.close()
}
