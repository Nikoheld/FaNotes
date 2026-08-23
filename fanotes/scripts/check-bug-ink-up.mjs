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
  inkExtentStyleValues,
  liveGrowScale,
  neededWriteExtent,
  nextWriteExtent,
  paperPixelY,
} = await server.ssrLoadModule('/src/lib/paperGrow.ts')

try {
  const a4H = PAPER_SOURCE_HEIGHT
  const a4W = PAPER_SOURCE_WIDTH
  const reportY = 0.94
  const nextH = neededWriteExtent(reportY, a4H, WRITE_SLACK_HEIGHT, PAGE_GROW_STEP_HEIGHT)
  assert.ok(nextH >= a4H + PAGE_GROW_STEP_HEIGHT, 'y≈0.94 on A4 must grow at least one writing-margin step')

  const a4Painted = inkExtentStyleValues(a4H, a4W, a4W)
  const tallPainted = inkExtentStyleValues(nextH, a4W, a4W)
  assert.ok(tallPainted.paintedHeightPx > a4Painted.paintedHeightPx)

  const start = { x: 0.5, y: reportY }
  const visualY = paperPixelY(reportY, a4Painted.paintedHeightPx)
  const grown = applyLiveHandwritingGrow(
    start,
    { sourceW: a4W, sourceH: a4H, layoutW: a4W, layoutH: a4Painted.paintedHeightPx },
    { sourceW: a4W, sourceH: nextH, layoutW: a4W, layoutH: tallPainted.paintedHeightPx },
  )
  assert.ok(Math.abs(grown.nextPixelY - visualY) <= 1, `painted Y ${grown.nextPixelY} must stay ${visualY}`)
  assert.ok(grown.y > 0.2, 'must not slam toward y≈0')

  const pdfH = 3200
  assert.equal(liveGrowScale(pdfH, pdfH, a4H, nextH), 1, 'PDF-tall layout that did not grow must not scale Y')
  const pdfStay = applyLiveHandwritingGrow(
    start,
    { sourceW: a4W, sourceH: a4H, layoutW: a4W, layoutH: pdfH },
    { sourceW: a4W, sourceH: nextH, layoutW: a4W, layoutH: pdfH },
  )
  assert.equal(pdfStay.remapped, false)
  assert.equal(pdfStay.y, reportY)
  assert.ok(Math.abs(pdfStay.nextPixelY - paperPixelY(reportY, pdfH)) <= 1)

  const a4Next = nextWriteExtent(reportY, a4H, WRITE_SLACK_HEIGHT, PAGE_GROW_STEP_HEIGHT, a4Painted.paintedHeightPx)
  assert.ok(a4Next > a4H, 'A4 painted box still grows source when it is short')
  const pdfNext = nextWriteExtent(reportY, a4H, WRITE_SLACK_HEIGHT, PAGE_GROW_STEP_HEIGHT, pdfH)
  assert.equal(pdfNext, a4H, 'a taller PDF painted box must not grow source at y≈0.52')

  console.log(JSON.stringify({
    reportY,
    nextH,
    a4Painted: a4Painted.paintedHeightPx,
    tallPainted: tallPainted.paintedHeightPx,
    remappedY: grown.y,
    paintedY: grown.nextPixelY,
    pdfY: pdfStay.y,
  }))
  console.log('bug-ink-up ok')
} finally {
  await server.close()
}
