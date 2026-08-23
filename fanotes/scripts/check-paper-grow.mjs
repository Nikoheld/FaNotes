import assert from 'node:assert/strict'
import { createServer } from 'vite'

const server = await createServer({
  appType: 'custom',
  logLevel: 'error',
  optimizeDeps: { noDiscovery: true },
  server: { middlewareMode: true },
})

const {
  GROW_STEP_X,
  GROW_STEP_Y,
  PAGE_START_HEIGHT,
  PAGE_START_WIDTH,
  WRITE_MARGIN_X,
  WRITE_MARGIN_Y,
  growWriteExtent,
} = await server.ssrLoadModule('/src/lib/noteCanvas.ts')

try {
  const pageH = PAGE_START_HEIGHT
  const pageW = PAGE_START_WIDTH

  assert.ok(WRITE_MARGIN_Y < pageH * 0.25, 'slack is a writing margin, not half a page')
  assert.ok(WRITE_MARGIN_X < pageW * 0.25)
  assert.equal(growWriteExtent(0.4, pageH, WRITE_MARGIN_Y, GROW_STEP_Y), pageH, 'upper page must not grow yet')
  assert.equal(growWriteExtent(0.55, pageH, WRITE_MARGIN_Y, GROW_STEP_Y), pageH, 'mid-page must not grow with modest slack')
  const bottom = growWriteExtent(0.94, pageH, WRITE_MARGIN_Y, GROW_STEP_Y)
  assert.ok(bottom > pageH, 'pen at the bottom must grow the sheet')
  const again = growWriteExtent(0.94, bottom, WRITE_MARGIN_Y, GROW_STEP_Y)
  assert.ok(again > bottom, 'the new bottom must grow again')
  assert.equal(growWriteExtent(0.5, pageW, WRITE_MARGIN_X, GROW_STEP_X), pageW, 'left half must not grow sideways')
  assert.ok(
    growWriteExtent(0.94, pageW, WRITE_MARGIN_X, GROW_STEP_X) > pageW,
    'pen at the right edge must grow sideways',
  )
  assert.equal(growWriteExtent(undefined, pageH, WRITE_MARGIN_Y, GROW_STEP_Y), pageH)
  assert.equal(growWriteExtent(Number.NaN, pageH, WRITE_MARGIN_Y, GROW_STEP_Y), pageH)
  assert.equal(growWriteExtent(Number.POSITIVE_INFINITY, pageH, WRITE_MARGIN_Y, GROW_STEP_Y), pageH)
  assert.equal(growWriteExtent(0.9, 0, WRITE_MARGIN_Y, GROW_STEP_Y), 0)
  assert.equal(growWriteExtent(0.9, pageH, WRITE_MARGIN_Y, 0), pageH)

  console.log(JSON.stringify({
    slackHeight: WRITE_MARGIN_Y,
    slackWidth: WRITE_MARGIN_X,
    growAtBottom: bottom,
    growAgain: again,
  }))
  console.log('paper-grow ok')
} finally {
  await server.close()
}
