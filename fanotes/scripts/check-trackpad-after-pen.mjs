import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

const server = await createServer({
  appType: 'custom',
  logLevel: 'error',
  optimizeDeps: { noDiscovery: true },
  server: { middlewareMode: true },
})

const {
  applyPenUpInkCleanup,
  applyWheelInkPolicy,
  keepGotPointerCaptureId,
} = await server.ssrLoadModule('/src/lib/inkPointerPolicy.ts')

const drawing = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../src/components/DrawingBoard.tsx'), 'utf8')

try {
  const leftover = { activePointerId: 7, captureId: 7, lastContactAt: 1_200 }
  const pan = applyWheelInkPolicy(leftover, { ctrlKey: false })
  assert.equal(pan.session.activePointerId, null, 'wheel must clear the leftover pen pointer')
  assert.equal(pan.session.captureId, null, 'wheel must release leftover capture')
  assert.equal(pan.session.lastContactAt, 0, 'wheel must clear last contact')
  assert.equal(pan.preventDefault, false, 'two-finger pan at zoom 1 must not preventDefault')
  assert.equal(pan.allowPan, true, 'two-finger pan is allowed when zoom is 1')

  const pinch = applyWheelInkPolicy(leftover, { ctrlKey: true })
  assert.equal(pinch.preventDefault, true, 'pinch ctrlKey wheel must preventDefault')
  assert.equal(pinch.session.activePointerId, null)

  const up = applyPenUpInkCleanup(leftover)
  assert.equal(up.session.activePointerId, null)
  assert.equal(up.session.captureId, null)
  assert.equal(up.session.lastContactAt, 0)
  assert.equal(up.releaseCapture, true)
  assert.equal(up.blurCanvas, true)

  assert.equal(keepGotPointerCaptureId(99, 7), false, 'gotpointercapture must not keep a foreign id')
  assert.equal(keepGotPointerCaptureId(7, 7), true, 'the live stroke id may be kept')
  assert.equal(keepGotPointerCaptureId(7, null), false, 'no live stroke means no kept capture')

  assert.match(drawing, /applyWheelInkPolicy/)
  assert.match(drawing, /applyPenUpInkCleanup/)
  assert.match(drawing, /keepGotPointerCaptureId/)
  assert.doesNotMatch(drawing, /setIgnoreMouseEvents|setBounds\(|BrowserWindow/)
  assert.doesNotMatch(drawing, /lastPointerTypeRef\.current === 'pen'/)

  console.log(JSON.stringify({ pan: pan.preventDefault, pinch: pinch.preventDefault, captureKept: false }))
  console.log('trackpad-after-pen ok')
} finally {
  await server.close()
}
