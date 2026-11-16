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
  QUICK_MENU_CROSS_POINTER_MS,
  QUICK_MENU_EXTENT,
  clampQuickMenuCenter,
  quickMenuChordOnDown,
  quickMenuChordOnMove,
  ringPositions,
} = await server.ssrLoadModule('/src/lib/penQuickMenu.ts')

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

const pan = (extra = {}) => ({
  pointerId: 7,
  stylusButton: true,
  tipDown: false,
  menu: false,
  lastAt: 0,
  ...extra,
})

try {
  // Pan button alone (hover, upper button = middle = 4): moves never open the menu.
  const hover = pan()
  for (let t = 1; t < 20; t += 1) assert.equal(quickMenuChordOnMove(hover, 7, 4, t), false)
  assert.equal(hover.lastAt, 19)

  // Then the tip goes down (4 | 1): exactly one chord.
  assert.equal(quickMenuChordOnMove(hover, 7, 5, 20), true)
  hover.menu = true
  assert.equal(quickMenuChordOnMove(hover, 7, 5, 21), false, 'an open menu does not reopen')

  // A pan that started with the tip already down (Windows barrel + contact) keeps panning.
  const contact = pan({ tipDown: true })
  assert.equal(quickMenuChordOnMove(contact, 7, 3, 1), false)
  assert.equal(quickMenuChordOnMove(contact, 7, 2, 2), false, 'tip lifted')
  assert.equal(quickMenuChordOnMove(contact, 7, 3, 3), true, 'tip pressed again while the button is held')

  // A finger pan never chords, other pointers are ignored, unknown buttons are ignored.
  assert.equal(quickMenuChordOnMove(pan({ stylusButton: false }), 7, 1, 1), false)
  assert.equal(quickMenuChordOnMove(pan(), 8, 5, 1), false)
  assert.equal(quickMenuChordOnMove(pan(), 7, undefined, 1), false)

  // The tip sent as its own pen pointer while a mouse-labelled pan button is held.
  const tip = { pointerId: 9, pointerType: 'pen', button: 0, buttons: 1 }
  assert.equal(quickMenuChordOnDown(pan({ lastAt: 100 }), tip, 200), true)
  assert.equal(
    quickMenuChordOnDown(pan({ lastAt: 100 }), tip, 100 + QUICK_MENU_CROSS_POINTER_MS + 1),
    false,
    'a stale pan does not swallow normal writing',
  )
  assert.equal(quickMenuChordOnDown(null, tip, 1), false)
  assert.equal(quickMenuChordOnDown(pan({ stylusButton: false }), tip, 1), false)
  assert.equal(quickMenuChordOnDown(pan(), { ...tip, pointerType: 'mouse' }, 1), false)
  assert.equal(quickMenuChordOnDown(pan(), { ...tip, button: 2, buttons: 2 }, 1), false)

  // Ring layout starts at 12 o'clock; the menu stays inside the viewport.
  const ring = ringPositions(4, 50)
  assert.deepEqual(ring[0], { x: 0, y: -50 })
  assert.deepEqual(ring[1], { x: 50, y: 0 })
  assert.deepEqual(clampQuickMenuCenter(5, 5, 1000, 800), { x: QUICK_MENU_EXTENT, y: QUICK_MENU_EXTENT })
  assert.deepEqual(clampQuickMenuCenter(995, 795, 1000, 800), { x: 1000 - QUICK_MENU_EXTENT, y: 800 - QUICK_MENU_EXTENT })
  assert.deepEqual(clampQuickMenuCenter(400, 300, 1000, 800), { x: 400, y: 300 })
  assert.deepEqual(clampQuickMenuCenter(10, 10, 100, 100), { x: 50, y: 50 })

  // Wiring in the board: both move paths pass the buttons, and button pans are stylus pans.
  const board = readFileSync(join(root, 'src/components/DrawingBoard.tsx'), 'utf8')
  assert.match(board, /dragSheetWithPointer\(event\.pointerId, event\.clientX, event\.clientY, event\.buttons\)/)
  assert.match(board, /dragSheetWithPointerRef\.current\(event\.pointerId, event\.clientX, event\.clientY, event\.buttons\)/)
  assert.match(board, /beginTabletPan\(event\.pointerId, event\.clientX, event\.clientY, event\.pointerType, now, true, event\.buttons\)/)
  assert.match(board, /quickMenuChordOnDown\(tabletPanRef\.current/)
  assert.match(board, /<PenQuickMenu/)
  const menu = readFileSync(join(root, 'src/components/PenQuickMenu.tsx'), 'utf8')
  assert.match(menu, /data-fanotes-drawing-chrome="quick-menu"/)
  console.log('pen-quick-menu ok')
} finally {
  await server.close()
}
