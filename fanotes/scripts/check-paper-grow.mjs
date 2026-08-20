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

  assert.ok(WRITE_SLACK_HEIGHT < a4H * 0.25, 'slack is a writing margin, not half a page')
  assert.ok(WRITE_SLACK_WIDTH < a4W * 0.25)
  assert.equal(neededWriteExtent(0.4, a4H, WRITE_SLACK_HEIGHT, PAGE_GROW_STEP_HEIGHT), a4H, 'upper page must not grow yet')
  assert.equal(neededWriteExtent(0.55, a4H, WRITE_SLACK_HEIGHT, PAGE_GROW_STEP_HEIGHT), a4H, 'mid-page must not grow with modest slack')
  const bottom = neededWriteExtent(0.94, a4H, WRITE_SLACK_HEIGHT, PAGE_GROW_STEP_HEIGHT)
  assert.ok(bottom > a4H, 'pen at the bottom must grow the sheet')
  const again = neededWriteExtent(0.94, bottom, WRITE_SLACK_HEIGHT, PAGE_GROW_STEP_HEIGHT)
  assert.ok(again > bottom, 'the new bottom must grow again')
  assert.equal(neededWriteExtent(0.5, a4W, WRITE_SLACK_WIDTH, PAGE_GROW_STEP_WIDTH), a4W, 'left half must not grow sideways')
  assert.ok(
    neededWriteExtent(0.94, a4W, WRITE_SLACK_WIDTH, PAGE_GROW_STEP_WIDTH) > a4W,
    'pen at the right edge must grow sideways',
  )
  assert.equal(neededWriteExtent(undefined, a4H, WRITE_SLACK_HEIGHT, PAGE_GROW_STEP_HEIGHT), a4H)
  assert.equal(neededWriteExtent(Number.NaN, a4H, WRITE_SLACK_HEIGHT, PAGE_GROW_STEP_HEIGHT), a4H)
  assert.equal(neededWriteExtent(Number.POSITIVE_INFINITY, a4H, WRITE_SLACK_HEIGHT, PAGE_GROW_STEP_HEIGHT), a4H)
  assert.equal(neededWriteExtent(0.9, 0, WRITE_SLACK_HEIGHT, PAGE_GROW_STEP_HEIGHT), 0)
  assert.equal(neededWriteExtent(0.9, a4H, WRITE_SLACK_HEIGHT, 0), a4H)

  console.log(JSON.stringify({
    slackHeight: WRITE_SLACK_HEIGHT,
    slackWidth: WRITE_SLACK_WIDTH,
    growAtBottom: bottom,
    growAgain: again,
  }))
  console.log('paper-grow ok')
} finally {
  await server.close()
}
