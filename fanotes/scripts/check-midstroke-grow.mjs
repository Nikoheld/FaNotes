import assert from 'node:assert/strict'
import { createServer } from 'vite'

const server = await createServer({
  appType: 'custom',
  logLevel: 'error',
  optimizeDeps: { noDiscovery: true },
  server: { middlewareMode: true },
})

const {
  continueStrokeAfterExtentGrow,
  growLiveInkAndMapNext,
  growPageFromMark,
  keepMarkOnPage,
  neededWriteExtent,
  pendingGrowScale,
  PAPER_SOURCE_HEIGHT,
  PAPER_SOURCE_WIDTH,
  PAGE_GROW_STEP_HEIGHT,
  PAGE_GROW_STEP_WIDTH,
  WRITE_SLACK_HEIGHT,
  WRITE_SLACK_WIDTH,
} = await server.ssrLoadModule('/src/lib/paperGrow.ts')
const { classifyInkJumpAppend, INK_JUMP_HYPOT, mapClientToPaperPoint } = await server.ssrLoadModule('/src/lib/inkSampleMap.ts')

try {
  const prevH = PAPER_SOURCE_HEIGHT
  const nextH = neededWriteExtent(0.94, prevH, WRITE_SLACK_HEIGHT, PAGE_GROW_STEP_HEIGHT)
  assert.ok(nextH > prevH, 'bottom-edge writing must grow the sheet')

  const last = { x: 0.5, y: 0.94, t: 40, pressure: 0.5, tiltX: 0, tiltY: 0, pointerType: 'pen' }
  const remappedY = last.y * prevH / nextH
  const oldHeight = 800
  const newHeight = oldHeight * (nextH / prevH)
  const surfaceAfter = {
    left: 40,
    top: 20,
    width: 600,
    height: newHeight,
    offsetWidth: 900,
    offsetHeight: nextH,
  }
  const sameVisualClientY = 20 + last.y * oldHeight
  const result = growLiveInkAndMapNext(
    last,
    prevH,
    nextH,
    { type: 'pointermove', clientX: 40 + 0.5 * 600, clientY: sameVisualClientY, pressure: 0.5, pointerType: 'pen' },
    surfaceAfter,
  )
  assert.ok(result.last.y > 0.2 && result.last.y < last.y, 'last point remaps down the new page, not to the top')
  assert.ok(Math.abs(result.last.y - remappedY) < 1e-9)
  assert.ok(result.next, 'the same visual sample must still map')
  assert.ok(Math.abs(result.next.y - result.last.y) < 0.04, 'next sample stays continuous with the remapped last point')
  assert.ok(result.next.y > 0.2, 'must not teleport toward y≈0')
  assert.equal(result.jumped, false)
  assert.equal(
    classifyInkJumpAppend(last, result.next, 3),
    'skip',
    'leap-filter before remap would drop the same-visual sample',
  )
  assert.equal(
    classifyInkJumpAppend(result.last, result.next, 3),
    'append',
    'after remap the same-visual sample must stay on the stroke',
  )

  const stale = growLiveInkAndMapNext(
    last,
    prevH,
    nextH,
    { type: 'pointermove', clientX: 40 + 0.5 * 600, clientY: 20 + 0.55 * oldHeight, pressure: 0.5, pointerType: 'pen' },
    { left: 40, top: 20, width: 600, height: oldHeight, offsetWidth: 900, offsetHeight: prevH },
  )
  if (stale.jumped) {
    assert.equal(stale.next.y, stale.last.y, 'a stale box must not append a teleport')
    assert.ok(stale.next.y > 0.2)
  }

  const prevLayoutH = 1500
  const nextLayoutH = Math.round(1500 * nextH / prevH)
  const visualY = last.y * prevLayoutH
  const layoutGrown = {
    left: 40,
    top: 20,
    width: 600,
    height: oldHeight * (nextLayoutH / prevLayoutH),
    offsetWidth: 900,
    offsetHeight: nextLayoutH,
  }
  const mismatched = growLiveInkAndMapNext(
    last,
    prevH,
    nextH,
    { type: 'pointermove', clientX: 40 + 0.5 * 600, clientY: 20 + last.y * oldHeight, pressure: 0.5, pointerType: 'pen' },
    layoutGrown,
    0,
    prevLayoutH,
    nextLayoutH,
  )
  assert.ok(Math.abs(mismatched.last.y * nextLayoutH - visualY) <= 1, 'mismatched layout keeps the same visual Y')
  assert.ok(mismatched.last.y < last.y)
  assert.equal(mismatched.jumped, false)

  const nextW = neededWriteExtent(0.94, PAPER_SOURCE_WIDTH, WRITE_SLACK_WIDTH, PAGE_GROW_STEP_WIDTH)
  assert.ok(nextW > PAPER_SOURCE_WIDTH)
  const wideLast = { ...last, x: 0.94 }
  const wide = growLiveInkAndMapNext(
    wideLast,
    prevH,
    prevH,
    { type: 'pointermove', clientX: 40 + 0.94 * 600 * (PAPER_SOURCE_WIDTH / nextW), clientY: 20 + 0.94 * oldHeight, pressure: 0.5, pointerType: 'pen' },
    { left: 40, top: 20, width: 600, height: oldHeight, offsetWidth: nextW, offsetHeight: prevH },
    0,
    oldHeight,
    oldHeight,
    PAPER_SOURCE_WIDTH,
    nextW,
    600,
    600 * (nextW / PAPER_SOURCE_WIDTH),
  )
  assert.ok(wide.last.x < wideLast.x, 'last X remaps on a width grow')
  assert.equal(wide.jumped, false)

  const pending = {
    prevH,
    nextH,
    prevW: PAPER_SOURCE_WIDTH,
    nextW: PAPER_SOURCE_WIDTH,
    prevLayoutH: 990,
    prevLayoutW: 700,
  }
  assert.equal(pendingGrowScale(pending, 700, 990).ready, false, 'stale box is not ready to remap')
  const ready = pendingGrowScale(pending, 700, 1486)
  assert.equal(ready.ready, true)
  assert.ok(ready.scaleY < 1)

  const page = { width: PAPER_SOURCE_WIDTH, height: PAPER_SOURCE_HEIGHT }
  const liveLast = { x: 0.94, y: 0.5 }
  const hitBox = { left: 40, top: 20, width: page.width, height: page.height, offsetWidth: page.width, offsetHeight: page.height }
  const crossing = mapClientToPaperPoint(
    { clientX: hitBox.left + page.width + 80, clientY: hitBox.top + 0.5 * page.height, pressure: 0.55, pointerType: 'pen' },
    hitBox,
  )
  assert.ok(crossing && crossing.x > 1, 'sample past the old right edge must map')
  const grown = growPageFromMark(page, { x: crossing.x, y: crossing.y })
  assert.ok(grown.width > page.width, 'that sample must grow the write page')
  assert.equal(
    classifyInkJumpAppend(liveLast, crossing, 4),
    'skip',
    'leap-filter against the unremapped crossing sample would kill the stroke',
  )
  assert.ok(Math.hypot(crossing.x - liveLast.x, crossing.y - liveLast.y) > INK_JUMP_HYPOT)
  const lastSnapshot = { x: liveLast.x, y: liveLast.y }
  liveLast.x = keepMarkOnPage(liveLast.x, page.width, grown.width, grown.padX)
  liveLast.y = keepMarkOnPage(liveLast.y, page.height, grown.height, grown.padY)
  assert.ok(liveLast.x < lastSnapshot.x, 'setPageExtent mutates last in place')
  const doubled = continueStrokeAfterExtentGrow(liveLast, crossing, page, grown, 4)
  assert.equal(doubled.action, 'skip', 'feeding the already-mutated last remaps it twice and skips')
  const continued = continueStrokeAfterExtentGrow(lastSnapshot, crossing, page, grown, 4)
  assert.equal(continued.action, 'append', 'append only when last is remapped once from the pre-grow snapshot')
  assert.ok(continued.last && continued.last.x < lastSnapshot.x)
  assert.ok(Math.abs(continued.last.x - liveLast.x) < 1e-9, 'one remap matches setPageExtent')
  assert.ok(continued.current.x < crossing.x)
  assert.ok(Math.hypot(continued.current.x - continued.last.x, continued.current.y - continued.last.y) < INK_JUMP_HYPOT)

  const { readFileSync } = await import('node:fs')
  const { dirname, join } = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const board = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'src/components/DrawingBoard.tsx'), 'utf8')
  const appendAt = board.indexOf('const appendPointerEvent = useCallback')
  assert.ok(appendAt >= 0)
  const usableAt = board.indexOf('acceptUsableInkClient', appendAt)
  const snapshotAt = board.indexOf('lastSnapshot', appendAt)
  const growAt = board.indexOf('ensureWriteRoom(point.y, point.x)', appendAt)
  const continueAt = board.indexOf('continueStrokeAfterExtentGrow(lastSnapshot', appendAt)
  assert.ok(usableAt >= 0 && snapshotAt > usableAt && growAt > snapshotAt && continueAt > growAt, 'appendPointerEvent must snapshot last, grow, then continueStrokeAfterExtentGrow(lastSnapshot)')
  assert.match(board, /prev: \{ width: prevPaintW, height: prevPaintH \}/)
  assert.equal(board.includes('acceptNextCommittedInkSample'), false)

  console.log(JSON.stringify({
    prevH,
    nextH,
    remapped: result.last.y,
    next: result.next.y,
    jumped: result.jumped,
    mismatchedY: mismatched.last.y,
    mismatchedPixel: mismatched.last.y * nextLayoutH,
  }))
  console.log('midstroke-grow ok')
} finally {
  await server.close()
}
