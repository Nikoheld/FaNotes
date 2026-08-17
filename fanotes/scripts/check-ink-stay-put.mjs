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

try {
  const prevSourceH = PAPER_SOURCE_HEIGHT
  const nextSourceH = neededWriteExtent(0.55, prevSourceH, WRITE_SLACK_HEIGHT, PAGE_GROW_STEP_HEIGHT)
  assert.ok(nextSourceH > prevSourceH, 'grow starts from a live mid-page point, not after remap')

  const start = { x: 0.42, y: 0.55 }
  const pixelY = paperPixelY(start.y, prevSourceH)
  assert.ok(pixelY > 600, 'the live point is mid-page in paper pixels')

  const grownLayout = applyLiveHandwritingGrow(
    start,
    { sourceW: PAPER_SOURCE_WIDTH, sourceH: prevSourceH, layoutW: 700, layoutH: 990 },
    { sourceW: PAPER_SOURCE_WIDTH, sourceH: nextSourceH, layoutW: 700, layoutH: 1486 },
  )
  assert.equal(grownLayout.remapped, true)
  assert.ok(Math.abs(grownLayout.nextPixelY - pixelY) <= 1, `pixel Y ${grownLayout.nextPixelY} must stay ${pixelY}`)
  assert.ok(grownLayout.y < start.y, 'normalized Y may shrink only after the box grew')
  assert.ok(grownLayout.y * nextSourceH > pixelY - 1)

  const staleLayout = applyLiveHandwritingGrow(
    start,
    { sourceW: PAPER_SOURCE_WIDTH, sourceH: prevSourceH, layoutW: 700, layoutH: 990 },
    { sourceW: PAPER_SOURCE_WIDTH, sourceH: nextSourceH, layoutW: 700, layoutH: 990 },
  )
  assert.equal(staleLayout.remapped, false, 'must not shrink 0–1 while the painted sheet is still short')
  assert.equal(staleLayout.y, start.y)
  assert.ok(Math.abs(staleLayout.nextPixelY - pixelY) <= 1, 'stale box keeps the same paper-pixel Y')

  console.log(JSON.stringify({
    pixelY,
    grownY: grownLayout.y,
    grownPixel: grownLayout.nextPixelY,
    staleY: staleLayout.y,
  }))
  console.log('ink-stay-put ok')
} finally {
  await server.close()
}
