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
  appendAcceptedInkPoint,
  isInkCorridorLeap,
  resolveInkJumpAppend,
} = await server.ssrLoadModule('/src/lib/inkSampleMap.ts')
const {
  POST_PEN_IGNORE_MS,
  defaultPenOnlyForPlatform,
  shouldIgnorePointerAfterPen,
  shouldRejectNonPenInk,
} = await server.ssrLoadModule('/src/lib/inkPointerPolicy.ts')
const { defaultSettingsForPlatform } = await server.ssrLoadModule('/src/defaults.ts')

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const defaults = readFileSync(join(root, 'src/defaults.ts'), 'utf8')
const appSource = readFileSync(join(root, 'src/App.tsx'), 'utf8')
const main = readFileSync(join(root, 'electron/main.cjs'), 'utf8')

const A4 = 1273
const TALL = 5_000
const surface = { left: 0, top: 0, width: 600, height: 800, offsetWidth: 900, offsetHeight: A4 }
const clientAt = (nx, ny, extras = {}) => ({
  type: 'pointermove',
  clientX: surface.left + nx * surface.width,
  clientY: surface.top + ny * surface.height,
  timeStamp: extras.timeStamp ?? 16,
  pressure: 0.5,
  pointerType: 'pen',
  ...extras,
})

try {
  const points = []
  appendAcceptedInkPoint(points, clientAt(0.2, 0.3, { timeStamp: 16 }), surface, 900, A4)
  appendAcceptedInkPoint(points, clientAt(0.22, 0.31, { timeStamp: 32 }), surface, 900, A4)
  assert.equal(points.length, 2, 'short in-corridor deltas must commit from an empty start')

  const jump = { x: points.at(-1).x, y: points.at(-1).y + 0.15 }
  assert.equal(isInkCorridorLeap(points.at(-1), jump, 900, A4), true, 'dy 0.15 is a jump on A4')
  assert.equal(isInkCorridorLeap(points.at(-1), jump, 900, TALL), true, 'the same 0–1 jump is a jump on a tall page')
  const oldTallThreshold = Math.max(900, TALL) * 0.42
  const pixelDyOnTall = 0.15 * TALL
  assert.ok(pixelDyOnTall < oldTallThreshold, 'the old 42% height rule would have allowed this jump')

  const before = points.length
  appendAcceptedInkPoint(points, clientAt(0.22, 0.31 + 0.15), surface, 900, A4)
  assert.equal(points.length, before, 'a jump is not appended')

  const tallSurface = { left: 0, top: 0, width: 600, height: 800, offsetWidth: 900, offsetHeight: TALL }
  const midPage = []
  appendAcceptedInkPoint(midPage, clientAt(0.4, 0.55, { timeStamp: 80 }), tallSurface, 900, TALL)
  assert.equal(midPage.length, 1, 'grow/jump check starts from a live mid-page point')
  assert.ok(midPage[0].y > 0.5)
  appendAcceptedInkPoint(midPage, clientAt(0.41, 0.01, { timeStamp: 96 }), tallSurface, 900, TALL)
  assert.equal(midPage.length, 1, 'a jump to the top of a tall page is not kept')
  assert.ok(midPage[0].y > 0.5, 'the mid-page start must stay; the top sample must not replace it')

  const restart = []
  resolveInkJumpAppend(restart, { x: 0.2, y: 0.02, t: 1, pressure: 0.5, tiltX: 0, tiltY: 0, pointerType: 'pen' })
  const afterRestart = resolveInkJumpAppend(restart, { x: 0.4, y: 0.4, t: 2, pressure: 0.5, tiltX: 0, tiltY: 0, pointerType: 'pen' })
  assert.equal(afterRestart.action, 'restart')
  assert.equal(restart.length, 1)
  assert.equal(restart[0].y, 0.4)
  assert.notEqual(restart[0].y, 0.02)

  const penAt = 1_000
  assert.equal(shouldIgnorePointerAfterPen('mouse', penAt, penAt + 100), true)
  assert.equal(shouldIgnorePointerAfterPen('touch', penAt, penAt + 100), true)
  assert.equal(shouldIgnorePointerAfterPen('mouse', penAt, penAt + 900), false)
  assert.equal(shouldIgnorePointerAfterPen('pen', penAt, penAt + 100), false)
  assert.ok(POST_PEN_IGNORE_MS >= 850)

  assert.equal(defaultPenOnlyForPlatform('win32'), true)
  assert.equal(defaultPenOnlyForPlatform('linux'), false)
  assert.equal(defaultSettingsForPlatform('win32').penOnly, true, 'Windows factory settings keep pen-only')
  assert.equal(defaultSettingsForPlatform('linux').penOnly, false)
  assert.equal(shouldRejectNonPenInk('touch', defaultSettingsForPlatform('win32').penOnly), true)
  assert.equal(shouldRejectNonPenInk('pen', defaultSettingsForPlatform('win32').penOnly), false)
  assert.match(defaults, /defaultSettingsForPlatform/)
  assert.match(appSource, /defaultSettingsForPlatform\(window\.fanotes\.platform\)/)
  assert.match(main, /defaultPenOnlyForPlatform\(process\.platform\)/)
  assert.doesNotMatch(defaults, /penOnly:\s*process\.platform/)

  console.log(JSON.stringify({ corridor: 2, jumpRejected: true, restartY: restart[0].y, ignoreMs: POST_PEN_IGNORE_MS }))
  console.log('jump-filter ok')
} finally {
  await server.close()
}
