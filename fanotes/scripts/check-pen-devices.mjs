import assert from 'node:assert/strict'
import { createServer } from 'vite'

const server = await createServer({
  appType: 'custom',
  logLevel: 'error',
  optimizeDeps: { noDiscovery: true },
  server: { middlewareMode: true },
})

try {
  const dev = await server.ssrLoadModule('/src/lib/penDevice.ts')
  const policy = await server.ssrLoadModule('/src/lib/inkPointerPolicy.ts')
  const session = await server.ssrLoadModule('/src/lib/inkPointerSession.ts')
  const buttons = await server.ssrLoadModule('/src/lib/tabletButtons.ts')
  const sampleMap = await server.ssrLoadModule('/src/lib/inkSampleMap.ts')
  const menu = await server.ssrLoadModule('/src/lib/penQuickMenu.ts')

  // PointerEvent-shaped samples for each device profile.
  const ev = (extra) => ({
    pointerId: 3, pointerType: 'pen', button: 0, buttons: 1, pressure: 0.5,
    tiltX: 0, tiltY: 0, twist: 0, clientX: 100, clientY: 100, timeStamp: 1, ...extra,
  })
  const box = { left: 0, top: 0, width: 800, height: 800, offsetWidth: 800, offsetHeight: 800 }
  const pressureOf = (event) => sampleMap.mapClientToPaperPoint(event, box, 0).pressure
  const toolOf = (event, asStylus = false) => buttons.tabletButtonActionFromPointer(undefined, event, asStylus)

  // Pen without pressure (reports 0 or nothing): constant width, still a pen, still ink.
  for (const pressure of [0, undefined, NaN]) {
    const down = ev({ pressure })
    assert.equal(pressureOf(down), 0.5, `pressure ${pressure} falls back to a constant`)
    assert.equal(dev.effectivePointerType(down), 'pen')
    assert.equal(policy.shouldRejectNonPenInk(dev.effectivePointerType(down), true), false, 'pen-only keeps it')
    assert.equal(toolOf(down), 'ink')
  }
  // Real pressure is kept; a mouse keeps its own constant.
  assert.equal(pressureOf(ev({ pressure: 0.8 })), 0.8)
  assert.equal(pressureOf(ev({ pointerType: 'mouse', pressure: 0.5 })), 0.5)
  assert.equal(pressureOf(ev({ pointerType: 'mouse', pressure: 0 })), 0.55)

  // A pressureless pen keeps its stroke: pressure 0 with the tip bit is not hover.
  const down0 = ev({ pressure: 0 })
  let live = session.inkPointerSessionFromSample(down0, 0)
  assert.equal(live.pressureless, true)
  for (let t = 100; t <= 5000; t += 100) {
    const move = ev({ pressure: 0, timeStamp: t })
    assert.equal(session.shouldHardEndInkPointerSession(live, t, move), false, `still writing at ${t}`)
    live = session.touchInkPointerSession(live, move, t)
  }
  assert.equal(session.shouldHardEndInkPointerSession(live, 5100, ev({ buttons: 0, pressure: 0 })), true, 'lift ends it')
  // A pen with pressure hovering with a stuck button bit still ends after the idle window.
  const real = session.inkPointerSessionFromSample(ev({ pressure: 0.4 }), 0)
  assert.equal(real.pressureless, false)
  assert.equal(session.shouldHardEndInkPointerSession(real, 100, ev({ pressure: 0 })), false)
  assert.equal(session.shouldHardEndInkPointerSession(real, 2000, ev({ pressure: 0 })), true)

  // Pen reported as mouse with real pressure (Windows driver quirk): treated as a pen.
  const asMouse = ev({ pointerType: 'mouse', pressure: 0.73 })
  assert.equal(dev.effectivePointerType(asMouse), 'pen')
  assert.equal(policy.shouldRejectNonPenInk(dev.effectivePointerType(asMouse), true), false)
  assert.equal(pressureOf(asMouse), 0.73)
  // A real mouse (pressure 0.5 down, tilt 0, hover) stays a mouse and is rejected in pen-only.
  for (const mouse of [ev({ pointerType: 'mouse', pressure: 0.5 }), ev({ pointerType: 'mouse', buttons: 0, pressure: 0 })]) {
    assert.equal(dev.effectivePointerType(mouse), 'mouse')
    assert.equal(policy.shouldRejectNonPenInk(dev.effectivePointerType(mouse), true), true)
  }
  // A finger is never promoted.
  assert.equal(dev.effectivePointerType(ev({ pointerType: 'touch', pressure: 0.3 })), 'touch')

  // Eraser end: button 5 on contact, buttons bit 32 afterwards.
  const eraserDown = ev({ button: 5, buttons: 32 })
  assert.equal(dev.isPenEraserEnd(eraserDown), true)
  assert.equal(toolOf(eraserDown), 'eraser')
  assert.equal(toolOf(ev({ button: -1, buttons: 33 })), 'eraser')
  assert.equal(session.isInkTipDown(eraserDown), true, 'eraser contact counts as down')
  assert.equal(toolOf(ev({ pointerType: 'mouse', button: 5, buttons: 32 })), 'eraser', 'eraser labelled mouse')

  // Barrel button (buttons 2) on a pen, also when the driver labels it mouse.
  const barrel = ev({ button: 2, buttons: 3 })
  assert.equal(buttons.tabletButtonIdentityFromPointer(barrel), 'pen-barrel')
  assert.equal(buttons.tabletButtonIdentityFromPointer(ev({ pointerType: 'mouse', button: 2, buttons: 2 }), true), 'pen-barrel')
  assert.equal(buttons.tabletButtonIdentityFromPointer(ev({ pointerType: 'mouse', button: 2, buttons: 2 }), false), null, 'a plain right click is not a barrel')

  // Hover (buttons 0) is not contact; tilt absent (USI / N-trig) is harmless.
  assert.equal(session.isInkTipDown(ev({ buttons: 0, pressure: 0 })), false)
  const usi = ev({ pressure: 0.6, tiltX: undefined, tiltY: undefined, twist: undefined })
  const mapped = sampleMap.mapClientToPaperPoint(usi, box, 0)
  assert.equal(mapped.tiltX, 0)
  assert.equal(mapped.tiltY, 0)
  assert.equal(mapped.pointerType, 'pen')

  // Palm rejection while the pen is near.
  assert.equal(dev.isPenNearPalmWindow(1000, 1200), true)
  assert.equal(dev.isPenNearPalmWindow(1000, 1000 + dev.PEN_NEAR_PALM_MS), false)
  assert.equal(dev.isPenNearPalmWindow(0, 10), false)

  // Marking menu: direction alone selects, dead zone cancels.
  const pick = menu.quickMenuSelectByDirection
  assert.equal(pick(3, -4, 5, 12), null, 'dead zone')
  assert.deepEqual(pick(0, -40, 5, 12), { ring: 'tool', index: 0 }, 'up = first tool')
  assert.deepEqual(pick(40, 0, 5, 12), { ring: 'tool', index: 1 })
  assert.deepEqual(pick(-40, 0, 5, 12), { ring: 'tool', index: 4 })
  for (const [index, spot] of menu.ringPositions(5, 52).entries()) {
    // Any distance along an option's direction picks it; no need to reach it.
    assert.deepEqual(pick(spot.x * 0.5, spot.y * 0.5, 5, 12), { ring: 'tool', index })
  }
  for (const [index, spot] of menu.ringPositions(12, 100, 0.5).entries()) {
    assert.deepEqual(pick(spot.x * 1.3, spot.y * 1.3, 5, 12), { ring: 'color', index })
    assert.deepEqual(pick(spot.x, spot.y, 5, 12), { ring: 'color', index })
  }
  console.log('check-pen-devices: ok')
} finally {
  await server.close()
}
