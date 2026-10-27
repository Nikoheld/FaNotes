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
  shouldFingerPanInPenOnly,
  shouldIgnorePointerAfterPen,
  shouldRejectNonPenInk,
} = await server.ssrLoadModule('/src/lib/inkPointerPolicy.ts')
const {
  FINGER_PAN_FLING_TAU_MS,
  fingerPanReleaseVelocity,
  pushFingerPanSample,
  stepFingerPanFling,
} = await server.ssrLoadModule('/src/lib/fingerPanFling.ts')
const { defaultSettingsForPlatform } = await server.ssrLoadModule('/src/defaults.ts')

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

  const midSession = applyPenUpInkCleanup(pan.session.activePointerId === null ? leftover : pan.session)
  assert.equal(midSession.session.activePointerId, null)
  assert.equal(midSession.session.captureId, null)
  assert.equal(midSession.session.lastContactAt, 0)
  assert.equal(midSession.releaseCapture, true, 'pen-up after a leftover capture must release it')
  assert.equal(midSession.blurCanvas, true)

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
  assert.equal(defaultSettingsForPlatform('win32').penOnly, true, 'Windows factory settings keep pen-only')
  assert.equal(defaultSettingsForPlatform('linux').penOnly, false)
  assert.equal(packagedDefaults.defaultPenOnlyForPlatform('win32'), defaultPenOnlyForPlatform('win32'))
  assert.equal(packagedDefaults.shouldRejectNonPenInk('touch', true), shouldRejectNonPenInk('touch', true))
  assert.equal(shouldRejectNonPenInk('touch', defaultSettingsForPlatform('win32').penOnly), true, 'Windows palm/touch must not start ink')
  assert.equal(shouldRejectNonPenInk('mouse', defaultSettingsForPlatform('win32').penOnly), true, 'Windows mouse must not start ink')
  assert.equal(shouldRejectNonPenInk('pen', defaultSettingsForPlatform('win32').penOnly), false)
  const fingerPan = {
    pointerType: 'touch',
    penOnly: true,
    penDown: false,
    lastPenAt: 0,
    now: 5_000,
  }
  assert.equal(shouldFingerPanInPenOnly(fingerPan), true, 'pen-only: a finger pans the sheet')
  assert.equal(shouldFingerPanInPenOnly({ ...fingerPan, pointerType: 'mouse' }), false, 'a mouse does not pan')
  assert.equal(shouldFingerPanInPenOnly({ ...fingerPan, pointerType: 'pen' }), false)
  assert.equal(shouldFingerPanInPenOnly({ ...fingerPan, penOnly: false }), false, 'finger still inks when pen-only is off')
  assert.equal(shouldFingerPanInPenOnly({ ...fingerPan, penDown: true }), false, 'a palm does not pan while the pen is down')
  assert.equal(shouldFingerPanInPenOnly({ ...fingerPan, lastPenAt: 4_800, now: 5_000 }), false, 'a palm just after the pen does not pan')
  assert.match(drawing, /shouldFingerPanInPenOnly/)
  assert.match(drawing, /fingerPanReleaseVelocity/)
  assert.match(drawing, /stepFingerPanFling/)
  const flick = [
    { t: 1_000, x: 0, y: 40 },
    { t: 1_040, x: 80, y: 40 },
  ]
  const released = fingerPanReleaseVelocity(flick, 1_040)
  assert.ok(released.vx > 1.5 && released.vx < 2.2, `a rightward flick keeps speed, got ${released.vx}`)
  assert.equal(released.vy, 0)
  const held = fingerPanReleaseVelocity(flick, 1_040 + 220)
  assert.deepEqual(held, { vx: 0, vy: 0 }, 'a finger that has stopped does not fling')
  const capped = fingerPanReleaseVelocity([
    { t: 0, x: 0, y: 0 },
    { t: 16, x: 400, y: 0 },
  ], 16)
  assert.ok(capped.vx > 3 && capped.vx <= 3.2, `a wild flick is capped, got ${capped.vx}`)
  let velocity = { vx: 1, vy: -0.5 }
  let distanceX = 0
  let distanceY = 0
  let frames = 0
  for (let t = 0; t < 2_000 && frames < 200; t += 16) {
    const step = stepFingerPanFling(velocity, 16)
    distanceX += step.dx
    distanceY += step.dy
    assert.ok(step.vx < velocity.vx, 'the coast slows down')
    assert.ok(step.vy > velocity.vy, 'an upward coast stays upward while it slows')
    velocity = { vx: step.vx, vy: step.vy }
    frames += 1
    if (step.done) break
  }
  assert.ok(frames > 8, 'the coast lasts more than a few frames')
  assert.ok(Math.abs(distanceX - FINGER_PAN_FLING_TAU_MS) < 12, `rightward coast covers about one tau, got ${distanceX}`)
  assert.ok(Math.abs(distanceY + FINGER_PAN_FLING_TAU_MS / 2) < 12, `upward coast covers about half a tau, got ${distanceY}`)
  const trimmed = pushFingerPanSample(flick, { t: 1_200, x: 80, y: 40 }, 1_200)
  assert.equal(trimmed.some((sample) => sample.t === 1_000), false, 'samples older than the fling window are dropped')
  assert.deepEqual(fingerPanReleaseVelocity(trimmed, 1_200), { vx: 0, vy: 0 })
  assert.equal(stepFingerPanFling({ vx: 1, vy: 0 }, 200).done, true, 'a stalled frame ends the coast instead of jumping')
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
