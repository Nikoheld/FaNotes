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
  const start = { x: 0.42, y: 0.94 }
  const nextSourceH = neededWriteExtent(start.y, prevSourceH, WRITE_SLACK_HEIGHT, PAGE_GROW_STEP_HEIGHT)
  assert.ok(nextSourceH > prevSourceH, 'grow starts from a live bottom-edge point, not after remap')
  assert.ok(paperPixelY(start.y, prevSourceH) > 600, 'the live point is in the written band in paper pixels')

  const stayPut = (label, prevLayoutH, nextLayoutH) => {
    const visualY = paperPixelY(start.y, prevLayoutH)
    const grown = applyLiveHandwritingGrow(
      start,
      { sourceW: PAPER_SOURCE_WIDTH, sourceH: prevSourceH, layoutW: 700, layoutH: prevLayoutH },
      { sourceW: PAPER_SOURCE_WIDTH, sourceH: nextSourceH, layoutW: 700, layoutH: nextLayoutH },
    )
    const paintedY = grown.y * nextLayoutH
    assert.equal(grown.remapped, true, `${label}: remaps after the painted box grew`)
    assert.ok(Math.abs(paintedY - visualY) <= 1, `${label}: visual Y ${paintedY} must stay ${visualY}`)
    assert.ok(Math.abs(grown.nextPixelY - visualY) <= 1, `${label}: helper visual Y stays`)
    assert.ok(grown.y < start.y, `${label}: normalized Y may shrink only after the box grew`)
    return { visualY, y: grown.y, paintedY }
  }

  const proportional = stayPut('proportional', 990, Math.round(990 * nextSourceH / prevSourceH))
  const mismatched = stayPut('mismatched', 1500, Math.round(1500 * nextSourceH / prevSourceH))

  const staleVisualY = paperPixelY(start.y, 990)
  const staleLayout = applyLiveHandwritingGrow(
    start,
    { sourceW: PAPER_SOURCE_WIDTH, sourceH: prevSourceH, layoutW: 700, layoutH: 990 },
    { sourceW: PAPER_SOURCE_WIDTH, sourceH: nextSourceH, layoutW: 700, layoutH: 990 },
  )
  assert.equal(staleLayout.remapped, false, 'must not shrink 0–1 while the painted sheet is still short')
  assert.equal(staleLayout.y, start.y)
  assert.ok(Math.abs(staleLayout.y * 990 - staleVisualY) <= 1, 'stale box keeps the same visual Y')
  assert.ok(Math.abs(staleLayout.nextPixelY - staleVisualY) <= 1, 'stale helper keeps the same visual Y')

  const reportY = 0.31
  const reportVisual = paperPixelY(reportY, prevSourceH)
  assert.equal(neededWriteExtent(reportY, prevSourceH, WRITE_SLACK_HEIGHT, PAGE_GROW_STEP_HEIGHT), prevSourceH)
  const zeroPrev = applyLiveHandwritingGrow(
    { x: 0.42, y: reportY },
    { sourceW: PAPER_SOURCE_WIDTH, sourceH: prevSourceH, layoutW: 0, layoutH: 0 },
    { sourceW: PAPER_SOURCE_WIDTH, sourceH: prevSourceH, layoutW: 700, layoutH: prevSourceH },
  )
  assert.equal(zeroPrev.remapped, false, 'zero painted box must not remap a report-shaped y≈0.30')
  assert.equal(zeroPrev.y, reportY)
  assert.ok(Math.abs(zeroPrev.nextPixelY - reportVisual) <= 1)

  console.log(JSON.stringify({
    nextSourceH,
    proportional,
    mismatched,
    staleY: staleLayout.y,
  }))
  console.log('ink-stay-put ok')
} finally {
  await server.close()
}
