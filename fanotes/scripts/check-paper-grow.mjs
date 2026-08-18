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
  WRITE_SLACK_HEIGHT,
  WRITE_SLACK_WIDTH,
  neededWriteExtent,
} = await server.ssrLoadModule('/src/lib/paperGrow.ts')

try {
  const a4H = PAPER_SOURCE_HEIGHT
  const a4W = PAPER_SOURCE_WIDTH
  const oldHeightSlack = Math.round(a4H * 0.34)

  assert.ok(WRITE_SLACK_HEIGHT > oldHeightSlack, 'height slack must be larger than the previous 0.34 A4 buffer')
  assert.equal(neededWriteExtent(0.4, a4H, WRITE_SLACK_HEIGHT, PAGE_GROW_STEP_HEIGHT), a4H, 'upper page must not grow yet')
  const mid = neededWriteExtent(0.55, a4H, WRITE_SLACK_HEIGHT, PAGE_GROW_STEP_HEIGHT)
  assert.ok(mid > a4H, 'pen at mid-page must already grow the sheet')
  assert.equal(
    neededWriteExtent(0.55, a4H, oldHeightSlack, PAGE_GROW_STEP_HEIGHT),
    a4H,
    'the old slack would still wait until closer to the edge',
  )
  assert.equal(neededWriteExtent(0.5, a4W, WRITE_SLACK_WIDTH, PAGE_GROW_STEP_WIDTH), a4W, 'left half must not grow sideways')
  assert.ok(
    neededWriteExtent(0.65, a4W, WRITE_SLACK_WIDTH, PAGE_GROW_STEP_WIDTH) > a4W,
    'pen nearer the right edge must grow sideways earlier',
  )
  assert.equal(neededWriteExtent(undefined, a4H, WRITE_SLACK_HEIGHT, PAGE_GROW_STEP_HEIGHT), a4H)
  assert.equal(neededWriteExtent(Number.NaN, a4H, WRITE_SLACK_HEIGHT, PAGE_GROW_STEP_HEIGHT), a4H)
  assert.equal(neededWriteExtent(Number.POSITIVE_INFINITY, a4H, WRITE_SLACK_HEIGHT, PAGE_GROW_STEP_HEIGHT), a4H)
  assert.equal(neededWriteExtent(0.9, 0, WRITE_SLACK_HEIGHT, PAGE_GROW_STEP_HEIGHT), 0)
  assert.equal(neededWriteExtent(0.9, a4H, WRITE_SLACK_HEIGHT, 0), a4H)

  console.log(JSON.stringify({
    slackHeight: WRITE_SLACK_HEIGHT,
    slackWidth: WRITE_SLACK_WIDTH,
    growAtMid: mid,
    oldSlackStillHoldsMid: a4H,
  }))
  console.log('paper-grow ok')
} finally {
  await server.close()
}
