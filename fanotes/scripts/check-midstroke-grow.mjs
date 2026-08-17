import assert from 'node:assert/strict'
import { createServer } from 'vite'

const server = await createServer({
  appType: 'custom',
  logLevel: 'error',
  optimizeDeps: { noDiscovery: true },
  server: { middlewareMode: true },
})

const { growLiveInkAndMapNext, neededWriteExtent, PAPER_SOURCE_HEIGHT, PAGE_GROW_STEP_HEIGHT, WRITE_SLACK_HEIGHT } = await server.ssrLoadModule('/src/lib/paperGrow.ts')

try {
  const prevH = PAPER_SOURCE_HEIGHT
  const nextH = neededWriteExtent(0.55, prevH, WRITE_SLACK_HEIGHT, PAGE_GROW_STEP_HEIGHT)
  assert.ok(nextH > prevH, 'mid-page writing must grow the sheet')

  const last = { x: 0.5, y: 0.55, t: 40, pressure: 0.5, tiltX: 0, tiltY: 0, pointerType: 'pen' }
  const remappedY = last.y * prevH / nextH
  const oldHeight = 800
  const newHeight = oldHeight * (nextH / prevH)
  const surfaceAfter = {
    left: 40,
    top: 20,
    width: 600,
    height: newHeight,
    offsetWidth: 900,
    offsetHeight: nextH,
  }
  const sameVisualClientY = 20 + last.y * oldHeight
  const result = growLiveInkAndMapNext(
    last,
    prevH,
    nextH,
    { type: 'pointermove', clientX: 40 + 0.5 * 600, clientY: sameVisualClientY, pressure: 0.5, pointerType: 'pen' },
    surfaceAfter,
  )
  assert.ok(result.last.y > 0.2 && result.last.y < 0.5, 'last point remaps down the new page, not to the top')
  assert.ok(Math.abs(result.last.y - remappedY) < 1e-9)
  assert.ok(result.next, 'the same visual sample must still map')
  assert.ok(Math.abs(result.next.y - result.last.y) < 0.04, 'next sample stays continuous with the remapped last point')
  assert.ok(result.next.y > 0.2, 'must not teleport toward y≈0')
  assert.equal(result.jumped, false)

  const stale = growLiveInkAndMapNext(
    last,
    prevH,
    nextH,
    { type: 'pointermove', clientX: 40 + 0.5 * 600, clientY: 20 + 0.55 * oldHeight, pressure: 0.5, pointerType: 'pen' },
    { left: 40, top: 20, width: 600, height: oldHeight, offsetWidth: 900, offsetHeight: prevH },
  )
  if (stale.jumped) {
    assert.equal(stale.next.y, stale.last.y, 'a stale box must not append a teleport')
    assert.ok(stale.next.y > 0.2)
  }

  const prevLayoutH = 1500
  const nextLayoutH = nextH
  const visualY = last.y * prevLayoutH
  const layoutGrown = {
    left: 40,
    top: 20,
    width: 600,
    height: oldHeight * (nextLayoutH / prevLayoutH),
    offsetWidth: 900,
    offsetHeight: nextLayoutH,
  }
  const mismatched = growLiveInkAndMapNext(
    last,
    prevH,
    nextH,
    { type: 'pointermove', clientX: 40 + 0.5 * 600, clientY: 20 + last.y * oldHeight, pressure: 0.5, pointerType: 'pen' },
    layoutGrown,
    0,
    prevLayoutH,
    nextLayoutH,
  )
  assert.ok(Math.abs(mismatched.last.y * nextLayoutH - visualY) <= 1, 'mismatched layout keeps the same visual Y')
  assert.ok(mismatched.last.y < last.y)
  assert.equal(mismatched.jumped, false)

  console.log(JSON.stringify({
    prevH,
    nextH,
    remapped: result.last.y,
    next: result.next.y,
    jumped: result.jumped,
    mismatchedY: mismatched.last.y,
    mismatchedPixel: mismatched.last.y * nextLayoutH,
  }))
  console.log('midstroke-grow ok')
} finally {
  await server.close()
}
