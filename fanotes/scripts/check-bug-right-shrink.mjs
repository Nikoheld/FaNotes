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
  PAGE_GROW_STEP_WIDTH,
  WRITE_SLACK_HEIGHT,
  WRITE_SLACK_WIDTH,
  applyLiveHandwritingGrow,
  inkExtentStyleValues,
  liveGrowScale,
  mergePendingGrow,
  neededWriteExtent,
  paperPixelY,
  pendingGrowScale,
} = await server.ssrLoadModule('/src/lib/paperGrow.ts')

try {
  const a4H = PAPER_SOURCE_HEIGHT
  const a4W = PAPER_SOURCE_WIDTH
  const reportX = 0.75
  const reportY = 0.9
  const start = { x: reportX, y: reportY }
  const nextW = neededWriteExtent(reportX, a4W, WRITE_SLACK_WIDTH, PAGE_GROW_STEP_WIDTH)
  assert.ok(nextW > a4W, 'writing past the right slack must grow write-width')

  const visualX = paperPixelY(reportX, a4W)
  const visualY = paperPixelY(reportY, a4H)
  const grownPaintedW = a4W * (nextW / a4W)
  const realWidthGrow = applyLiveHandwritingGrow(
    start,
    { sourceW: a4W, sourceH: a4H, layoutW: a4W, layoutH: a4H },
    { sourceW: nextW, sourceH: a4H, layoutW: grownPaintedW, layoutH: a4H },
  )
  assert.equal(realWidthGrow.y, reportY, 'a width grow must not rescale Y')
  assert.ok(Math.abs(realWidthGrow.nextPixelX - visualX) <= 1, `painted X ${realWidthGrow.nextPixelX} must stay ${visualX}`)
  assert.ok(Math.abs(realWidthGrow.nextPixelY - visualY) <= 1)
  assert.ok(realWidthGrow.x > 0.2, 'must not slam X to 0')

  const accidentalTall = applyLiveHandwritingGrow(
    start,
    { sourceW: a4W, sourceH: a4H, layoutW: a4W, layoutH: a4H },
    { sourceW: nextW, sourceH: a4H, layoutW: grownPaintedW, layoutH: a4H * 1.4 },
  )
  assert.equal(accidentalTall.y, reportY, 'painted-height change from a width-only grow must not shrink Y')
  assert.equal(liveGrowScale(a4H, a4H * 1.4, a4H, a4H, true), 1)

  const zeroWidth = applyLiveHandwritingGrow(
    start,
    { sourceW: a4W, sourceH: a4H, layoutW: 0, layoutH: a4H },
    { sourceW: nextW, sourceH: a4H, layoutW: grownPaintedW, layoutH: a4H },
  )
  assert.equal(zeroWidth.x, reportX, 'zero painted width must not collapse X')
  assert.equal(zeroWidth.remapped, false)

  const staleWidth = pendingGrowScale({
    prevH: a4H,
    nextH: a4H,
    prevW: a4W,
    nextW,
    prevLayoutH: a4H,
    prevLayoutW: a4W,
  }, a4W, a4H)
  assert.equal(staleWidth.scaleX, 1, 'stale/same painted width keeps scale-X 1')
  assert.equal(staleWidth.ready, false)
  assert.ok(staleWidth.remaining, 'unready width stay pending')

  const nextH = neededWriteExtent(0.94, a4H, WRITE_SLACK_HEIGHT, PAGE_GROW_STEP_HEIGHT)
  const heightPending = {
    prevH: a4H,
    nextH,
    prevW: a4W,
    nextW: a4W,
    prevLayoutH: a4H,
    prevLayoutW: a4W,
  }
  const afterRightGrow = mergePendingGrow(
    heightPending,
    { prevH: nextH, nextH, prevW: a4W, nextW, prevLayoutH: a4H, prevLayoutW: a4W },
    { scaleX: 1, scaleY: 1 },
  )
  assert.ok(afterRightGrow, 'width grow must not drop a pending height remap')
  assert.equal(afterRightGrow.prevH, a4H)
  assert.equal(afterRightGrow.nextH, nextH)
  assert.equal(afterRightGrow.prevW, a4W)
  assert.equal(afterRightGrow.nextW, nextW)

  const widthFlushed = pendingGrowScale(afterRightGrow, nextW, a4H)
  assert.notEqual(widthFlushed.scaleX, 1, 'width layout grow remaps X')
  assert.equal(widthFlushed.scaleY, 1, 'width flush must not rescale Y')
  assert.ok(widthFlushed.remaining, 'height remap stays pending after a width flush')
  assert.equal(widthFlushed.remaining.prevH, a4H)
  assert.equal(widthFlushed.remaining.nextH, nextH)
  assert.equal(widthFlushed.remaining.prevW, widthFlushed.remaining.nextW)

  const bothFlushed = pendingGrowScale(widthFlushed.remaining, nextW, nextH)
  assert.equal(bothFlushed.scaleX, 1, 'already-flushed width must not remap X again')
  assert.notEqual(bothFlushed.scaleY, 1)
  assert.equal(bothFlushed.remaining, null)

  const afterWidth = inkExtentStyleValues(a4H, nextW, grownPaintedW)
  const a4Painted = inkExtentStyleValues(a4H, a4W, a4W)
  assert.ok(Math.abs(afterWidth.paintedHeightPx - a4Painted.paintedHeightPx) <= 4, 'width grow must not change column-based painted height')

  console.log(JSON.stringify({
    reportX,
    nextW,
    remappedX: realWidthGrow.x,
    remappedY: realWidthGrow.y,
    paintedX: realWidthGrow.nextPixelX,
    paintedHeight: afterWidth.paintedHeightPx,
  }))
  console.log('bug-right-shrink ok')
} finally {
  await server.close()
}
