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
  DEFAULT_TABLET_BUTTON_ACTIONS,
  sanitizeTabletButtonMap,
  tabletButtonAction,
  tabletButtonActionFromPointer,
  tabletButtonIdentityFromPointer,
} = await server.ssrLoadModule('/src/lib/tabletButtons.ts')
const { defaultSettingsForPlatform } = await server.ssrLoadModule('/src/defaults.ts')
const {
  POST_PEN_IGNORE_MS,
  shouldIgnorePointerAfterPen,
  shouldIgnoreUnmappedPointerAfterPen,
  shouldRejectNonPenInk,
  shouldRejectNonPenInkMove,
} = await server.ssrLoadModule('/src/lib/inkPointerPolicy.ts')

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const packaged = require('../electron/tablet-buttons.cjs')

const runOnce = () => {
  const barrel = { pointerType: 'pen', button: 2, buttons: 2 }
  const eraser = { pointerType: 'pen', button: 5, buttons: 32 }
  const pad = { pointerType: 'mouse', button: 3, buttons: 8 }
  const tip = { pointerType: 'pen', button: 0, buttons: 1 }
  const mouseRight = { pointerType: 'mouse', button: 2, buttons: 2 }
  const wacomAsMouse = { pointerType: 'mouse', button: 2, buttons: 2 }

  assert.equal(tabletButtonIdentityFromPointer(barrel), 'pen-barrel')
  assert.equal(tabletButtonIdentityFromPointer(eraser), 'pen-eraser')
  assert.equal(tabletButtonIdentityFromPointer(pad), 'tablet-1')
  assert.equal(tabletButtonIdentityFromPointer(tip), 'pen-tip')
  assert.equal(tabletButtonIdentityFromPointer(mouseRight), null)
  assert.equal(tabletButtonIdentityFromPointer(wacomAsMouse, true), 'pen-barrel')

  const factory = defaultSettingsForPlatform('linux').tabletButtons
  assert.equal(tabletButtonAction(factory, 'pen-barrel'), 'eraser')
  assert.equal(tabletButtonActionFromPointer(factory, barrel), 'eraser')
  assert.equal(tabletButtonActionFromPointer(factory, eraser), 'eraser')
  assert.equal(tabletButtonActionFromPointer(factory, pad), 'undo')

  const changed = sanitizeTabletButtonMap({
    'pen-barrel': 'undo',
    'pen-eraser': 'none',
    'tablet-1': 'redo',
    junk: 'pan',
  })
  assert.equal(changed['pen-barrel'], 'undo')
  assert.equal(changed['pen-eraser'], 'none')
  assert.equal(changed['tablet-1'], 'redo')
  assert.equal(changed['pen-tip'], 'ink')
  assert.equal(tabletButtonActionFromPointer(changed, barrel), 'undo')
  assert.equal(tabletButtonActionFromPointer(changed, eraser), 'none')
  assert.equal(tabletButtonActionFromPointer(changed, pad), 'redo')
  assert.notEqual(tabletButtonActionFromPointer(changed, barrel), DEFAULT_TABLET_BUTTON_ACTIONS['pen-barrel'])

  assert.deepEqual(packaged.sanitizeTabletButtonMap(changed), changed)
  assert.equal(packaged.DEFAULT_TABLET_BUTTON_ACTIONS['pen-barrel'], DEFAULT_TABLET_BUTTON_ACTIONS['pen-barrel'])

  const lastPen = 1_000
  const soon = lastPen + 100
  assert.ok(soon - lastPen < POST_PEN_IGNORE_MS)
  assert.equal(shouldIgnorePointerAfterPen('mouse', lastPen, soon), true, 'plain mouse after pen is still ignored')
  assert.equal(
    shouldIgnoreUnmappedPointerAfterPen('mouse', lastPen, soon, true),
    false,
    'mapped barrel-as-mouse in the post-pen window must not be dropped',
  )
  assert.equal(shouldIgnoreUnmappedPointerAfterPen('mouse', lastPen, soon, false), true)
  const winPenOnly = defaultSettingsForPlatform('win32').penOnly
  assert.equal(shouldRejectNonPenInk('mouse', winPenOnly), true)
  assert.equal(
    shouldRejectNonPenInkMove('mouse', winPenOnly, true),
    false,
    'a live mapped mouse-labelled eraser/ink stroke must receive moves',
  )
  assert.equal(shouldRejectNonPenInkMove('mouse', winPenOnly, false), true)
  assert.equal(shouldRejectNonPenInkMove('pen', winPenOnly, false), false)

  const board = readFileSync(join(root, 'src/components/DrawingBoard.tsx'), 'utf8')
  const settings = readFileSync(join(root, 'src/components/SettingsModal.tsx'), 'utf8')
  assert.match(board, /tabletButtonActionFromPointer\(/)
  assert.match(board, /tabletButtonIdentityFromPointer\(/)
  assert.match(board, /settings\.tabletButtons/)
  assert.match(board, /shouldIgnoreUnmappedPointerAfterPen\(/)
  assert.match(board, /shouldRejectNonPenInkMove\(/)
  assert.match(board, /Boolean\(buttonIdentity\)/)
  assert.match(board, /activePointerRef\.current === event\.pointerId/)
  assert.match(settings, /tablet-button-group is-\$\{group\}/)
  assert.match(settings, /group === 'pen' \? 'Stift' : 'Tablett'/)
  assert.match(settings, /settings-tablet-buttons/)
  assert.doesNotMatch(board, /if \(event\.button !== 0 && event\.pointerType !== 'pen'\) return/)
  return {
    barrel: tabletButtonActionFromPointer(changed, barrel),
    eraser: tabletButtonActionFromPointer(changed, eraser),
    pad: tabletButtonActionFromPointer(changed, pad),
  }
}

try {
  const first = runOnce()
  const second = runOnce()
  assert.deepEqual(first, second)
  console.log(JSON.stringify(first))
  console.log('wacom-buttons ok')
} finally {
  await server.close()
}
