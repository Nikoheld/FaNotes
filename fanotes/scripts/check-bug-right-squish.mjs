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
  PAGE_GROW_STEP_WIDTH,
  WRITE_SLACK_WIDTH,
  applyLiveHandwritingGrow,
  neededWriteExtent,
  paperPixelY,
  resolvePaintedLayoutGrow,
} = await server.ssrLoadModule('/src/lib/paperGrow.ts')

try {
  const a4H = PAPER_SOURCE_HEIGHT
  const a4W = PAPER_SOURCE_WIDTH
  const left = { x: 0.2, y: 0.35 }
  const nextW = neededWriteExtent(0.92, a4W, WRITE_SLACK_WIDTH, PAGE_GROW_STEP_WIDTH)
  assert.ok(nextW > a4W, 'writing past the right slack must grow write-width')
  const grownPaintedW = a4W * (nextW / a4W)
  const visualX = paperPixelY(left.x, a4W)

  const grown = applyLiveHandwritingGrow(
    left,
    { sourceW: a4W, sourceH: a4H, layoutW: a4W, layoutH: a4H },
    { sourceW: nextW, sourceH: a4H, layoutW: grownPaintedW, layoutH: a4H },
  )
  assert.ok(Math.abs(grown.nextPixelX - visualX) <= 1, `left mark painted X ${grown.nextPixelX} must stay ${visualX}`)
  assert.ok(grown.x > 0.08, 'must not slam the left mark to x≈0')
  assert.equal(grown.y, left.y, 'width grow must not rescale Y')

  const pending = {
    prevH: a4H,
    nextH: a4H,
    prevW: a4W,
    nextW,
    prevLayoutH: a4H,
    prevLayoutW: a4W,
  }
  const first = resolvePaintedLayoutGrow({
    pending,
    prevLayoutW: a4W,
    prevLayoutH: a4H,
    nextLayoutW: grownPaintedW,
    nextLayoutH: a4H,
    sourceW: nextW,
    sourceH: a4H,
  })
  assert.equal(first.apply, true)
  assert.notEqual(first.scaleX, 1)
  assert.equal(first.scaleY, 1)
  const after = { x: left.x * first.scaleX, y: left.y * first.scaleY }
  assert.ok(Math.abs(after.x * grownPaintedW - visualX) <= 1)

  const second = resolvePaintedLayoutGrow({
    pending: first.pending,
    prevLayoutW: grownPaintedW,
    prevLayoutH: a4H,
    nextLayoutW: grownPaintedW,
    nextLayoutH: a4H,
    sourceW: nextW,
    sourceH: a4H,
  })
  assert.equal(second.apply, false, 'a second flush must not remap X again')
  assert.equal(second.scaleX, 1)
  const doubled = after.x * (second.apply ? second.scaleX : 1)
  assert.ok(Math.abs(doubled * grownPaintedW - visualX) <= 1, 'left ink must not be squished by a double remap')

  console.log(JSON.stringify({
    leftX: left.x,
    nextW,
    remappedX: grown.x,
    paintedX: grown.nextPixelX,
    visualX,
    secondApply: second.apply,
  }))
  console.log('bug-right-squish ok')
} finally {
  await server.close()
}
