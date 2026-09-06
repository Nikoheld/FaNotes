// Ink must be painted where it is stored, also after the page auto-grows.
//
// Bug: after a grow the page is taller than 1600px, so scrolling re-slices the
// ink window. The committed bitmap was never re-rendered (scheduleRedraw was
// dead: the mount-effect cleanup cancelled a pending frame but kept its id),
// and the canvas — a replaced element with `width: auto` — followed the stale
// bitmap ratio. Handwriting showed shifted/stretched until an erase forced a
// synchronous redraw, which snapped it back onto the stored 0–1 points.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createServer } from 'vite'

const server = await createServer({
  appType: 'custom',
  logLevel: 'error',
  optimizeDeps: { noDiscovery: true },
  server: { middlewareMode: true },
})

try {
  const {
    FULL_INK_WINDOW,
    INK_WINDOW_PAD_CSS,
    inkWindowCanvasBox,
    inkWindowLayoutStyle,
    inkWindowSpan,
    layoutInkWindow,
  } = await server.ssrLoadModule('/src/lib/pdfInkHit.ts')
  const {
    GROW_STEP_Y,
    SCROLL_ROOM,
    WRITE_CAP_HEIGHT,
    WRITE_CAP_WIDTH,
    WRITE_MARGIN_Y,
    continueLiveWriteStroke,
  } = await server.ssrLoadModule('/src/lib/paperGrow.ts')

  // --- 1. The canvas CSS box must not depend on the bitmap aspect ratio. ---
  // CSS 2.1 §10.3.8: an absolutely positioned *replaced* element with
  // `width: auto` and a non-auto `height` takes `height × intrinsic ratio` as
  // its used width and ignores `right`. Only an explicit width pins the canvas
  // to the paper slice regardless of what the backing store currently holds.
  const usedCssWidth = (style, sliceHeight, bitmap) => (
    style.width === 'auto' ? sliceHeight * (bitmap.width / bitmap.height) : 'explicit'
  )
  const paper = { width: 2172, height: 1728 }
  const board = { width: paper.width + 2 * SCROLL_ROOM, height: paper.height + 2 * SCROLL_ROOM }
  const paperCss = `calc(100% - 2 * ${INK_WINDOW_PAD_CSS})`
  const scrolledWindow = layoutInkWindow({ paperHeight: paper.height, viewHeight: 758, scrollTop: 0, viewZoom: 1 })
  assert.notEqual(scrolledWindow.y1, 1, 'a grown page taller than 1600px is windowed, so the slice can move on scroll')
  for (const window of [FULL_INK_WINDOW, scrolledWindow, { y0: 0.154, y1: 1 }]) {
    const style = inkWindowLayoutStyle(window)
    assert.equal(style.width, paperCss, 'ink canvas width must be the explicit paper width, never auto')
    assert.equal(style.left, INK_WINDOW_PAD_CSS)
    assert.equal(style.right, INK_WINDOW_PAD_CSS)
    assert.equal(style.bottom, 'auto')
    const box = inkWindowCanvasBox(window, board, SCROLL_ROOM)
    assert.equal(box.width, paper.width, 'layout box of the slice is the paper width')
    assert.equal(usedCssWidth(style, box.height, { width: 3801, height: 2558 }), 'explicit', 'bitmap ratio must not size the canvas')
  }
  assert.ok(Math.abs(inkWindowSpan(scrolledWindow) * paper.height - inkWindowCanvasBox(scrolledWindow, board, SCROLL_ROOM).height) < 1e-6)
  // Reproduction: bitmap 3801×2558 was painted for the slice 0.154–1, then the
  // slice moved to 0–0.889 (scroll back to the top). With width:auto the used
  // width became 1535.6 × 3801/2558 ≈ 2282 instead of the 2172px paper.
  const movedSlice = inkWindowCanvasBox({ y0: 0, y1: 0.8886574 }, board, SCROLL_ROOM)
  const buggyWidth = usedCssWidth({ ...inkWindowLayoutStyle({ y0: 0, y1: 0.8886574 }), width: 'auto' }, movedSlice.height, { width: 3801, height: 2558 })
  assert.ok(buggyWidth > paper.width + 100, `sanity: width:auto followed the stale bitmap ratio (${buggyWidth.toFixed(1)}px)`)

  // --- 2. Live grow uses the layout box, not the zoomed visual rect. ---
  // At view zoom 1.25 the visual rect is 25% larger than the source page. Fed
  // as `painted`, every grow made the next sample grow again until WRITE_CAP.
  const page = { width: 2172, height: 1463, originX: 0, originY: 0 }
  const bottomEdge = { x: 0.15, y: 0.985 }
  const grownFromLayout = continueLiveWriteStroke({
    last: { x: 0.15, y: 0.92 },
    current: bottomEdge,
    page,
    painted: { width: page.width, height: page.height },
    existingCount: 12,
  })
  assert.equal(grownFromLayout.grew, true)
  assert.equal(grownFromLayout.grown.width, page.width, 'a bottom-edge stroke must not grow the width')
  assert.ok(
    grownFromLayout.grown.height > page.height && grownFromLayout.grown.height <= page.height + WRITE_MARGIN_Y + GROW_STEP_Y,
    `bottom-edge grow is one margin step, got ${grownFromLayout.grown.height}`,
  )
  const zoom = 1.25
  const grownFromVisual = continueLiveWriteStroke({
    last: { x: 0.15, y: 0.92 },
    current: bottomEdge,
    page,
    painted: { width: page.width * zoom, height: page.height * zoom },
    existingCount: 12,
  })
  assert.ok(grownFromVisual.grown.width > page.width, 'sanity: the zoomed rect as painted box would also widen the page (the bug)')

  // A whole stroke crossing the bottom edge. The pen moves in paper pixels
  // (origin fixed at the top-left, so a grow does not move it); each sample is
  // normalized against the box the DOM has after setPageExtent's forced
  // reflow, and `pendingStale` is threaded like appendPointerEvent does.
  const runStrokeAcrossBottomEdge = (paintedFor) => {
    let livePage = { ...page }
    let pendingStale = null
    let last = null
    for (let index = 0; index <= 24; index += 1) {
      const pen = { x: 0.15 * page.width + index * 2, y: 0.94 * page.height + index * 7 }
      const painted = paintedFor(livePage)
      const current = { x: pen.x / painted.width, y: pen.y / painted.height }
      const step = continueLiveWriteStroke({
        last,
        current,
        page: livePage,
        painted,
        existingCount: index,
        pendingStale,
      })
      pendingStale = step.pendingStale
      if (step.grew) livePage = { ...livePage, width: step.grown.width, height: step.grown.height }
      last = step.current
    }
    return livePage
  }
  const penBottom = 0.94 * page.height + 24 * 7
  assert.ok(penBottom > page.height, 'sanity: the stroke really crosses the old bottom edge')
  const settled = runStrokeAcrossBottomEdge((live) => ({ width: live.width, height: live.height }))
  assert.equal(settled.width, page.width, 'crossing the bottom edge must not widen the page')
  assert.ok(settled.height >= penBottom + WRITE_MARGIN_Y, `pen plus write margin fits, got ${settled.height}`)
  assert.ok(settled.height < page.height + 3 * GROW_STEP_Y, `stroke crossing the edge grows a few steps, got ${settled.height}`)
  assert.ok(settled.height < WRITE_CAP_HEIGHT && settled.width < WRITE_CAP_WIDTH)
  // Same stroke with the zoomed bounding rect as `painted` (the old wiring):
  // the page widens although the pen never went near the right edge.
  const runaway = runStrokeAcrossBottomEdge((live) => ({ width: live.width * zoom, height: live.height * zoom }))
  assert.ok(runaway.width > page.width, `sanity: zoomed rect as painted extent widens the page (${runaway.width}px)`)

  // --- 3. DrawingBoard wiring. ---
  const boardSource = await readFile(new URL('../src/components/DrawingBoard.tsx', import.meta.url), 'utf8')
  const appendAt = boardSource.indexOf('const appendPointerEvent = useCallback')
  const liveAt = boardSource.indexOf('continueLiveWriteStroke({', appendAt)
  assert.ok(appendAt >= 0 && liveAt > appendAt)
  const liveCall = boardSource.slice(liveAt, boardSource.indexOf('})', liveAt))
  assert.match(
    liveCall,
    /painted: \{ width: surface\.offsetWidth, height: surface\.offsetHeight \}/,
    'appendPointerEvent must pass the layout box (offsetWidth/offsetHeight) as painted extent',
  )
  assert.doesNotMatch(liveCall, /painted: \{ width: surface\.width/, 'the zoomed bounding rect must not be the painted extent')

  const scheduleAt = boardSource.indexOf('const scheduleRedraw = useCallback')
  assert.ok(scheduleAt >= 0)
  const scheduleBody = boardSource.slice(scheduleAt, boardSource.indexOf('}, [redraw])', scheduleAt))
  assert.match(scheduleBody, /if \(drawFrameRef\.current !== null\) return/, 'scheduleRedraw coalesces on a pending frame id')
  assert.match(
    boardSource,
    /cancelAnimationFrame\(drawFrameRef\.current\)\s*\n\s*drawFrameRef\.current = null/,
    'cancelling the pending redraw frame must reset its id, or every later scheduleRedraw() is skipped',
  )
  assert.match(
    boardSource,
    /cancelAnimationFrame\(visualGrowFrameRef\.current\)\s*\n\s*visualGrowFrameRef\.current = null/,
  )
  assert.doesNotMatch(
    boardSource,
    /if \(drawFrameRef\.current !== null\) cancelAnimationFrame\(drawFrameRef\.current\)\n/,
    'no bare cancel without reset',
  )

  console.log('ink-render-stay ok')
} finally {
  await server.close()
}
