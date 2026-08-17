import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
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
  defaultPenOnlyForPlatform,
  keepGotPointerCaptureId,
  shouldIgnorePointerAfterPen,
  shouldRejectNonPenInk,
} = await server.ssrLoadModule('/src/lib/inkPointerPolicy.ts')

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const drawing = readFileSync(join(root, 'src/components/DrawingBoard.tsx'), 'utf8')
const main = readFileSync(join(root, 'electron/main.cjs'), 'utf8')
const packagedDefaults = createRequire(import.meta.url)('../electron/ink-defaults.cjs')

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

  assert.equal(defaultPenOnlyForPlatform('win32'), true, 'Windows default is pen-only')
  assert.equal(defaultPenOnlyForPlatform('linux'), false)
  assert.equal(defaultPenOnlyForPlatform('darwin'), false)
  assert.equal(packagedDefaults.defaultPenOnlyForPlatform('win32'), defaultPenOnlyForPlatform('win32'))
  assert.equal(packagedDefaults.shouldRejectNonPenInk('touch', true), shouldRejectNonPenInk('touch', true))
  assert.equal(shouldRejectNonPenInk('touch', true), true, 'Windows palm/touch must not start ink')
  assert.equal(shouldRejectNonPenInk('mouse', true), true, 'Windows mouse must not start ink')
  assert.equal(shouldRejectNonPenInk('pen', true), false)
  assert.equal(shouldRejectNonPenInk('mouse', false), false)
  assert.equal(shouldIgnorePointerAfterPen('mouse', leftover.lastContactAt, leftover.lastContactAt + 100), true)
  assert.equal(shouldIgnorePointerAfterPen('touch', leftover.lastContactAt, leftover.lastContactAt + 100), true)
  assert.match(main, /defaultPenOnlyForPlatform\(process\.platform\)/)

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
