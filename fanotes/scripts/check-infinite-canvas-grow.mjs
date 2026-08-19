import assert from 'node:assert/strict'
import { createServer } from 'vite'

const server = await createServer({
  appType: 'custom',
  logLevel: 'error',
  optimizeDeps: { noDiscovery: true },
  server: { middlewareMode: true },
})

const {
  PAGE_GROW_STEP_HEIGHT,
  PAGE_GROW_STEP_WIDTH,
  PAPER_SOURCE_HEIGHT,
  PAPER_SOURCE_WIDTH,
  WRITE_MEMORY_CAP_HEIGHT,
  WRITE_MEMORY_CAP_WIDTH,
  WRITE_SLACK_HEIGHT,
  WRITE_SLACK_WIDTH,
  neededWriteExtent,
} = await server.ssrLoadModule('/src/lib/paperGrow.ts')

try {
  const a4H = PAPER_SOURCE_HEIGHT
  const a4W = PAPER_SOURCE_WIDTH
  const edge = 0.94

  let height = a4H
  const heights = [height]
  for (let i = 0; i < 6; i += 1) {
    const next = neededWriteExtent(edge, height, WRITE_SLACK_HEIGHT, PAGE_GROW_STEP_HEIGHT)
    assert.ok(next > height, `bottom write must grow height at step ${i} (${height} → ${next})`)
    assert.ok(next < WRITE_MEMORY_CAP_HEIGHT, 'A4-scale writing must not hit the memory cap')
    height = next
    heights.push(height)
  }
  assert.ok(height > a4H * 1.5, 'height must continue past one A4')

  let width = a4W
  const widths = [width]
  for (let i = 0; i < 6; i += 1) {
    const next = neededWriteExtent(edge, width, WRITE_SLACK_WIDTH, PAGE_GROW_STEP_WIDTH)
    assert.ok(next > width, `right write must grow width at step ${i} (${width} → ${next})`)
    assert.ok(next < WRITE_MEMORY_CAP_WIDTH, 'A4-scale writing must not hit the width cap')
    width = next
    widths.push(width)
  }
  assert.ok(width > a4W * 1.5, 'width must continue past one A4 column')

  console.log(JSON.stringify({
    slackHeight: WRITE_SLACK_HEIGHT,
    slackWidth: WRITE_SLACK_WIDTH,
    heights,
    widths,
    capH: WRITE_MEMORY_CAP_HEIGHT,
    capW: WRITE_MEMORY_CAP_WIDTH,
  }))
  console.log('infinite-canvas-grow ok')
} finally {
  await server.close()
}
