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
  WRITE_CAP_HEIGHT,
  WRITE_CAP_WIDTH,
  WRITE_MARGIN_X,
  WRITE_MARGIN_Y,
  growWriteExtent,
} = await server.ssrLoadModule('/src/lib/noteCanvas.ts')

try {
  const pageH = PAGE_START_HEIGHT
  const pageW = PAGE_START_WIDTH
  const edge = 0.94

  let height = pageH
  const heights = [height]
  for (let i = 0; i < 6; i += 1) {
    const next = growWriteExtent(edge, height, WRITE_MARGIN_Y, GROW_STEP_Y)
    assert.ok(next > height, `bottom write must grow height at step ${i} (${height} → ${next})`)
    assert.ok(next < WRITE_CAP_HEIGHT, 'A4-scale writing must not hit the memory cap')
    height = next
    heights.push(height)
  }
  assert.ok(height > pageH * 1.5, 'height must continue past one starting page')

  let width = pageW
  const widths = [width]
  for (let i = 0; i < 6; i += 1) {
    const next = growWriteExtent(edge, width, WRITE_MARGIN_X, GROW_STEP_X)
    assert.ok(next > width, `right write must grow width at step ${i} (${width} → ${next})`)
    assert.ok(next < WRITE_CAP_WIDTH, 'A4-scale writing must not hit the width cap')
    width = next
    widths.push(width)
  }
  assert.ok(width > pageW * 1.5, 'width must continue past one starting column')

  console.log(JSON.stringify({
    slackHeight: WRITE_MARGIN_Y,
    slackWidth: WRITE_MARGIN_X,
    heights,
    widths,
    capH: WRITE_CAP_HEIGHT,
    capW: WRITE_CAP_WIDTH,
  }))
  console.log('infinite-canvas-grow ok')
} finally {
  await server.close()
}
