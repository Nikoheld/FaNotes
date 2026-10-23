import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { createServer } from 'vite'

const here = dirname(fileURLToPath(import.meta.url))
const appRoot = join(here, '..')
const workspace = join(appRoot, '..')

const server = await createServer({
  root: workspace,
  appType: 'custom',
  logLevel: 'error',
  optimizeDeps: { noDiscovery: true },
  server: { middlewareMode: true },
})

const {
  HAND_GESTURE_CLAIM,
  bindHandGestures,
  createHandGestureState,
  handGestureSample,
  pinchFactorFromWheel,
  swipeDirection,
} = await server.ssrLoadModule('/src/lib/handGestures.ts')

let state = createHandGestureState()
let update = handGestureSample(state, { id: 1, phase: 'down', pointerType: 'pen', x: 0, y: 0 })
assert.equal(update.swallow, false, 'a pen is not a hand gesture')
assert.equal(update.state.points.size, 0)

update = handGestureSample(state, { id: 1, phase: 'down', pointerType: 'touch', x: 10, y: 10 })
assert.equal(update.swallow, false)
assert.equal(update.justClaimed, false)
state = update.state

update = handGestureSample(state, { id: 2, phase: 'down', pointerType: 'touch', x: 110, y: 10 })
assert.equal(update.justClaimed, true, 'the second finger claims the gesture')
assert.equal(update.frame, null, 'the claim samples the span before it zooms')
assert.equal(HAND_GESTURE_CLAIM, 'fanotes-hand-gesture-claim')
state = update.state

update = handGestureSample(state, { id: 2, phase: 'move', pointerType: 'touch', x: 160, y: 10 })
assert.ok(update.frame.pinch > 1, 'fingers moving apart zoom in')
assert.equal(update.frame.rotateDeg, 0)
state = update.state

update = handGestureSample(state, { id: 1, phase: 'move', pointerType: 'touch', x: 30, y: 40 })
update = handGestureSample(update.state, { id: 2, phase: 'move', pointerType: 'touch', x: 180, y: 40 })
assert.ok(update.frame.panY > 0, 'both fingers moving down pan down')

state = createHandGestureState()
state = handGestureSample(state, { id: 1, phase: 'down', pointerType: 'touch', x: 0, y: 0 }).state
state = handGestureSample(state, { id: 2, phase: 'down', pointerType: 'touch', x: 0, y: 80 }).state
update = handGestureSample(state, { id: 2, phase: 'move', pointerType: 'touch', x: 80, y: 0 })
assert.ok(Math.abs(update.frame.rotateDeg) > 20, 'a twist rotates the sheet')

state = update.state
update = handGestureSample(state, { id: 2, phase: 'up', pointerType: 'touch', x: 80, y: 0 })
assert.equal(update.swallow, true, 'one remaining finger stays in the gesture')
assert.equal(update.state.live, true)
update = handGestureSample(update.state, { id: 1, phase: 'up', pointerType: 'touch', x: 0, y: 0 })
assert.equal(update.state.live, false)
assert.equal(update.swallow, true, 'the last lift still belongs to the gesture')

assert.equal(swipeDirection(80, 10), 'right')
assert.equal(swipeDirection(-80, 10), 'left')
assert.equal(swipeDirection(10, -90), 'up')
assert.equal(swipeDirection(10, 4), null)
assert.ok(pinchFactorFromWheel(-40) > 1)
assert.ok(pinchFactorFromWheel(40) < 1)
assert.equal(typeof bindHandGestures, 'function')

const paper = readFileSync(join(appRoot, 'src/components/PaperView.tsx'), 'utf8')
const pdf = readFileSync(join(appRoot, 'src/components/PdfNoteView.tsx'), 'utf8')
const board = readFileSync(join(appRoot, 'src/components/DrawingBoard.tsx'), 'utf8')
const book = readFileSync(join(appRoot, 'src/components/SubjectBookPane.tsx'), 'utf8')
const calendar = readFileSync(join(appRoot, 'src/components/CalendarView.tsx'), 'utf8')
const homework = readFileSync(join(appRoot, 'src/components/HomeworkBoard.tsx'), 'utf8')
const cards = readFileSync(join(appRoot, 'src/components/FlashcardReview.tsx'), 'utf8')
const workspaceHost = readFileSync(join(appRoot, 'src/components/GlyphenWerkWorkspace.tsx'), 'utf8')
const glyphen = readFileSync(join(workspace, 'src/App.tsx'), 'utf8')
const main = readFileSync(join(appRoot, 'electron/main.cjs'), 'utf8')
const app = readFileSync(join(appRoot, 'src/App.tsx'), 'utf8')

assert.match(paper, /bindHandGestures/)
assert.match(paper, /data-hand-gesture-root/)
assert.match(paper, /onEdgeSwipe/)
assert.doesNotMatch(paper, /onRotate/, 'two fingers do not turn the note sheet')
assert.match(pdf, /bindHandGestures/)
assert.doesNotMatch(pdf, /onRotate/, 'two fingers do not turn a PDF page')
assert.match(pdf, /shouldTakeSheetZoom/)
assert.match(book, /data-hand-gesture-root/)
assert.match(board, /HAND_GESTURE_CLAIM/)
assert.match(board, /data-pen-contact|penContact/)
assert.match(calendar, /bindHandGestures/)
assert.match(homework, /bindHandGestures/)
assert.match(cards, /bindHandGestures/)
assert.match(workspaceHost, /glyphenwerk:sheet-zoom/)
assert.match(glyphen, /bindHandGestures/)
assert.match(main, /function forwardLockedSheetZoom/)
assert.equal(main.match(/forwardLockedSheetZoom\(/gu).length, 3, 'the note window and the book pop-out both forward pinch')
assert.match(app, /onEdgeSwipe/)

await server.close()

const probeDir = mkdtempSync(join(tmpdir(), 'fanotes-hand-gestures-'))
await build({
  absWorkingDir: workspace,
  entryPoints: [join(workspace, 'src/lib/handGestures.ts')],
  bundle: true,
  format: 'iife',
  globalName: 'HandGestures',
  outfile: join(probeDir, 'gestures.js'),
  logLevel: 'silent',
})
writeFileSync(join(probeDir, 'index.html'), `<!doctype html>
<meta charset="utf-8">
<style>
  #root { width: 240px; height: 180px; overflow: auto; }
  #sheet { width: 480px; height: 420px; touch-action: none; }
</style>
<div id="root" data-hand-gesture-root>
  <div id="sheet"></div>
</div>
<pre id="out"></pre>
<script src="./gestures.js"></script>
<script>
  const root = document.getElementById('root')
  const sheet = document.getElementById('sheet')
  const log = { pinch: 1, panY: 0, rotate: 0, claimed: false, swipes: [] }
  root.addEventListener('fanotes-hand-gesture-claim', () => { log.claimed = true })
  HandGestures.bindHandGestures(root, {
    captureNavigation: true,
    onPan: (_x, y) => { log.panY += y },
    onPinch: (factor) => { log.pinch *= factor },
    onRotate: (degrees) => { log.rotate += degrees },
    onSwipe: (direction) => { log.swipes.push(direction) },
  })
  const fire = (type, id, x, y) => sheet.dispatchEvent(new PointerEvent(type, {
    pointerId: id, pointerType: 'touch', clientX: x, clientY: y, bubbles: true, cancelable: true,
  }))
  fire('pointerdown', 1, 20, 40)
  fire('pointerdown', 2, 90, 40)
  fire('pointermove', 2, 150, 40)
  fire('pointermove', 1, 20, 10)
  fire('pointermove', 2, 150, 10)
  fire('pointerup', 2, 150, 10)
  fire('pointerup', 1, 20, 10)
  fire('pointerdown', 3, 8, 20)
  fire('pointerup', 3, 90, 24)
  sheet.dataset.penContact = '1'
  const pinchBeforePalm = log.pinch
  fire('pointerdown', 4, 20, 40)
  fire('pointerdown', 5, 90, 40)
  fire('pointermove', 5, 160, 40)
  fire('pointerup', 5, 160, 40)
  fire('pointerup', 4, 20, 40)
  log.palmHeld = log.pinch === pinchBeforePalm
  document.getElementById('out').textContent = JSON.stringify(log)
</script>
`)
const chromium = spawn('chromium', [
  '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
  '--virtual-time-budget=3000',
  '--dump-dom',
  `file://${join(probeDir, 'index.html')}`,
], { stdio: ['ignore', 'pipe', 'pipe'] })
let dom = ''
chromium.stdout.on('data', (chunk) => { dom += chunk })
const exitCode = await new Promise((resolve) => chromium.on('close', resolve))
assert.equal(exitCode, 0, 'Chromium probe failed')
const match = dom.match(/<pre id="out">([^<]*)<\/pre>/u)
assert.ok(match, `probe output missing: ${dom.slice(0, 500)}`)
const probe = JSON.parse(match[1])
assert.equal(probe.claimed, true, 'second finger claims the ink gesture')
assert.ok(probe.pinch > 1, 'pinch on a touch-action:none sheet zooms in')
assert.ok(probe.panY < 0, 'two fingers moving up pan the sheet')
assert.deepEqual(probe.swipes, ['right'], 'a one-finger swipe is reported')
assert.equal(probe.palmHeld, true, 'a resting hand does not zoom while the pen is down')
console.log('hand gestures ok', JSON.stringify(probe))
