import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

// Wacom side button mapped to the eraser: erasing must survive tip lifts,
// touch-downs and hover moves while the button stays pressed, and end only on
// release, cancel or leaving the sheet.

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const server = await createServer({
  appType: 'custom',
  logLevel: 'error',
  optimizeDeps: { noDiscovery: true },
  server: { middlewareMode: true },
})

try {
  const {
    nextPenEraserHold,
    penEraserButtonMask,
    penEraserHeldFor,
  } = await server.ssrLoadModule('/src/lib/penEraserHold.ts')
  const { DEFAULT_TABLET_BUTTON_ACTIONS } = await server.ssrLoadModule('/src/lib/tabletButtons.ts')
  const { shouldHardEndInkPointerSession, inkPointerSessionFromSample } = await server.ssrLoadModule('/src/lib/inkPointerSession.ts')

  const map = DEFAULT_TABLET_BUTTON_ACTIONS
  const pen = (buttons, button = -1, pointerId = 3) => ({ pointerId, pointerType: 'pen', buttons, button })

  assert.equal(penEraserButtonMask(map, 2), 2, 'barrel is the eraser by default')
  assert.equal(penEraserButtonMask(map, 3), 2, 'barrel + tip still erases')
  assert.equal(penEraserButtonMask(map, 1), 0, 'tip alone is ink')
  assert.equal(penEraserButtonMask(map, 4), 0, 'upper button pans by default')
  assert.equal(penEraserButtonMask({ ...map, 'pen-barrel': 'undo' }, 2), 0, 'remapped barrel does not erase')
  assert.equal(penEraserButtonMask({ ...map, 'pen-upper': 'eraser' }, 4), 4)

  // Hover with the barrel pressed, touch, lift, hover, touch again, release.
  let hold = null
  hold = nextPenEraserHold(hold, pen(2, 2), map, true)
  assert.ok(penEraserHeldFor(hold, 3), 'barrel press in hover latches the eraser')
  hold = nextPenEraserHold(hold, pen(3, 0), map, true)
  assert.ok(penEraserHeldFor(hold, 3), 'touch-down keeps erasing')
  hold = nextPenEraserHold(hold, pen(2, 0), map, true)
  assert.ok(penEraserHeldFor(hold, 3), 'tip lift with barrel held keeps erasing')
  hold = nextPenEraserHold(hold, pen(2), map, true)
  assert.ok(penEraserHeldFor(hold, 3), 'hover move keeps erasing')
  hold = nextPenEraserHold(hold, pen(1), map, true)
  assert.ok(penEraserHeldFor(hold, 3), 'a contact sample that drops the barrel bit (Linux Wacom) keeps erasing')
  hold = nextPenEraserHold(hold, pen(3), map, true)
  assert.ok(penEraserHeldFor(hold, 3))
  hold = nextPenEraserHold(hold, pen(0, 2), map, true)
  assert.equal(hold, null, 'releasing the barrel stops erasing')

  // Chorded release while the tip is still down names the released button.
  hold = nextPenEraserHold(null, pen(3), map, true)
  assert.equal(nextPenEraserHold(hold, pen(1, 2), map, true), null, 'barrel released during contact stops erasing')

  // Leaving the sheet or a cancel ends it even with the button still held.
  hold = nextPenEraserHold(null, pen(2), map, true)
  assert.equal(nextPenEraserHold(hold, pen(2), map, false), null, 'leaving the sheet stops erasing')
  assert.ok(penEraserHeldFor(nextPenEraserHold(null, pen(2), map, true), 3), 'coming back with the button held erases again')

  // Other devices and pens.
  hold = nextPenEraserHold(null, pen(2), map, true)
  assert.equal(nextPenEraserHold(hold, { pointerId: 9, pointerType: 'mouse', buttons: 0, button: 0 }, map, true), hold, 'mouse samples leave the pen latch alone')
  assert.equal(nextPenEraserHold(hold, pen(1, 0, 4), map, true), null, 'another pen without the button is not erasing')
  assert.equal(penEraserHeldFor(hold, 4), false)
  assert.equal(nextPenEraserHold(null, { pointerId: 9, pointerType: 'mouse', buttons: 2, button: 2 }, map, true), null, 'mouse right button is not a pen eraser hold')

  // The plain session helper would hard-end at a lift with the barrel held;
  // this is why DrawingBoard bypasses it while the latch holds.
  const session = inkPointerSessionFromSample(pen(3), 1000)
  assert.equal(shouldHardEndInkPointerSession(session, 1010, pen(2)), true)

  const board = readFileSync(join(root, 'src/components/DrawingBoard.tsx'), 'utf8')
  assert.match(board, /nextPenEraserHold\(penEraserHoldRef\.current, event, tabletButtonsRef\.current, overSheet\)/, 'board tracks the held button on every pen sample')
  assert.match(board, /penEraserHeldFor\(penEraserHoldRef\.current, event\.pointerId\)\s*\)\s*\{[\s\S]{0,400}handlePointerDown\(event\)/, 'a move with the button held re-opens the erase')
  assert.ok((board.match(/!heldEraser && shouldHardEndInkPointerSession/g) ?? []).length >= 3, 'move, window move and watchdog keep a held-button erase alive')
  assert.match(board, /buttonEraserGestureRef\.current = pointerEraser/)
  assert.match(board, /buttonEraserGestureRef\.current = false/)

  console.log('pen eraser hold: ok')
} finally {
  await server.close()
}
