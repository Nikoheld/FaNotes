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
  growLiveInkAndMapNext,
  neededWriteExtent,
} = await server.ssrLoadModule('/src/lib/paperGrow.ts')
const { classifyInkJumpAppend } = await server.ssrLoadModule('/src/lib/inkSampleMap.ts')

try {
  const prevH = PAPER_SOURCE_HEIGHT
  const nextH = neededWriteExtent(0.52, prevH, WRITE_SLACK_HEIGHT, PAGE_GROW_STEP_HEIGHT)
  assert.ok(nextH > prevH)
  const last = { x: 0.5, y: 0.52, t: 40, pressure: 0.5, tiltX: 0, tiltY: 0, pointerType: 'pen' }
  const oldHeight = 1276
  const newHeight = oldHeight * (nextH / prevH)
  const result = growLiveInkAndMapNext(
    last,
    prevH,
    nextH,
    { type: 'pointermove', clientX: 40 + 0.5 * 600, clientY: 20 + last.y * oldHeight, pressure: 0.5, pointerType: 'pen' },
    { left: 40, top: 20, width: 600, height: newHeight, offsetWidth: 900, offsetHeight: nextH },
    0,
    oldHeight,
    newHeight,
  )
  assert.equal(result.jumped, false)
  assert.equal(classifyInkJumpAppend(last, result.next, 3), 'skip')
  assert.equal(classifyInkJumpAppend(result.last, result.next, 3), 'append')
  assert.ok(result.last.y > 0.2)
  assert.ok(result.next.y > 0.2)

  const upper = neededWriteExtent(0.3, prevH, WRITE_SLACK_HEIGHT, PAGE_GROW_STEP_HEIGHT)
  assert.equal(upper, prevH, 'y≈0.30 still must not grow')

  console.log(JSON.stringify({
    prevH,
    nextH,
    remapped: result.last.y,
    next: result.next.y,
    jumped: result.jumped,
  }))
  console.log('bug-ink-up-stay ok')
} finally {
  await server.close()
}
