import assert from 'node:assert/strict'
import { createServer } from 'vite'

const server = await createServer({
  appType: 'custom',
  logLevel: 'error',
  optimizeDeps: { noDiscovery: true },
  server: { middlewareMode: true },
})

const {
  INK_POINTER_IDLE_MS,
  inkPointerSessionFromSample,
  isInkTipDown,
  resolveInkFinishSample,
  shouldAllowNewInkPointer,
  shouldHardEndInkPointerSession,
  touchInkPointerSession,
} = await server.ssrLoadModule('/src/lib/inkPointerSession.ts')

const now = 10_000
const penDown = inkPointerSessionFromSample({
  pointerId: 7,
  pointerType: 'pen',
  buttons: 1,
  pressure: 0.55,
}, now)

try {
  assert.equal(isInkTipDown({ pointerType: 'pen', buttons: 1, pressure: 0.55 }), true)
  assert.equal(isInkTipDown({ pointerType: 'pen', buttons: 0, pressure: 0 }), false)
  assert.equal(isInkTipDown({ pointerType: 'pen', buttons: 1, pressure: 0 }), false, 'Linux Wacom hover with a stuck button bit is not tip-down')
  assert.equal(isInkTipDown({ pointerType: 'mouse', buttons: 1 }), true)

  assert.equal(
    shouldHardEndInkPointerSession(penDown, now + 16, { pointerId: 7, pointerType: 'pen', buttons: 0, pressure: 0 }),
    true,
    'pen down then buttons===0 / tip-up must end the session',
  )

  assert.equal(
    shouldHardEndInkPointerSession(penDown, now + INK_POINTER_IDLE_MS + 1),
    true,
    'pen down with no end event past the idle timeout must end the session',
  )

  assert.equal(
    shouldHardEndInkPointerSession(penDown, now + 40, { pointerId: 7, pointerType: 'pen', buttons: 1, pressure: 0.4 }),
    false,
    'a live tip-down sample must not hard-end mid-stroke',
  )

  const afterTipUp = shouldHardEndInkPointerSession(penDown, now + 20, { pointerId: 7, buttons: 0, pressure: 0 })
  assert.equal(afterTipUp, true)
  assert.equal(
    shouldAllowNewInkPointer(afterTipUp ? null : penDown, { pointerId: 3, pointerType: 'mouse' }, now + 30),
    true,
    'after end, a different mouse/trackpad pointer may begin ink',
  )
  assert.equal(
    shouldAllowNewInkPointer(penDown, { pointerId: 3, pointerType: 'mouse' }, now + 80),
    true,
    'a leftover pen id must not block trackpad/mouse',
  )
  assert.equal(
    shouldAllowNewInkPointer(penDown, { pointerId: 9, pointerType: 'touch' }, now + 80),
    false,
    'live pen still rejects palm/touch until idle',
  )
  assert.equal(
    shouldAllowNewInkPointer(penDown, { pointerId: 9, pointerType: 'touch' }, now + INK_POINTER_IDLE_MS + 5),
    true,
    'after idle, another pointer is allowed',
  )

  const hovered = touchInkPointerSession(penDown, { pointerId: 7, pointerType: 'pen', buttons: 1, pressure: 0 }, now + 12)
  assert.equal(hovered.lastContactAt, now, 'hover must not refresh contact time')
  assert.equal(shouldHardEndInkPointerSession(hovered, now + 12, { pointerId: 7, pointerType: 'pen', buttons: 1, pressure: 0 }), true)

  const tipUpFinish = resolveInkFinishSample({ type: 'pointermove', clientX: 142, clientY: 388 })
  assert.deepEqual(tipUpFinish, { clientX: 142, clientY: 388 }, 'tip-up uses the real last sample, not the canvas center')
  assert.equal(resolveInkFinishSample({ type: 'pointercancel', clientX: 450, clientY: 636 }), null, 'idle/watchdog cancel must not append a center point')
  assert.equal(resolveInkFinishSample({ type: 'lostpointercapture', clientX: 450, clientY: 636 }), null)
  assert.equal(resolveInkFinishSample({ type: 'pointercancel' }), null)
  assert.equal(resolveInkFinishSample(null), null)

  console.log(JSON.stringify({
    tipUpEnds: true,
    idleEnds: true,
    midStrokeStays: true,
    otherPointerAfterEnd: true,
    hoverStuckButtonEnds: true,
    tipUpKeepsRealSample: tipUpFinish,
    cancelSkipsAppend: resolveInkFinishSample({ type: 'pointercancel', clientX: 450, clientY: 636 }) === null,
    idleMs: INK_POINTER_IDLE_MS,
  }))
  console.log('wacom-lift ok')
} finally {
  await server.close()
}
