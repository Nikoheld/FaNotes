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
  REPORT_VISUAL_GROW_GLYPH,
  VISUAL_GROW_REFRESH_FRAMES,
  applyVisualGrowCorrection,
  applyVisualGrowOp,
  emptyVisualGrowState,
  forcePaperCompositorRefresh,
  glyphExpectedVisual,
  growCanvasSurfaceVisualOffset,
  growCompositorVisualOffset,
  paintPaperCanvasSurfaceUpdate,
  refreshPaperCanvasSurface,
  sampleVisualAfterGrowRefresh,
  schedulePaperVisualGrowRefresh,
  visualGrowOpsFromBugEvents,
} = await server.ssrLoadModule('/src/lib/paperCaretScroll.ts')

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const fixture = JSON.parse(readFileSync(join(root, 'scripts/fixtures/bug-1788704214528.json'), 'utf8'))
const boardSource = readFileSync(join(root, 'src/components/DrawingBoard.tsx'), 'utf8')
const caretSource = readFileSync(join(root, 'src/lib/paperCaretScroll.ts'), 'utf8')

const makeClassList = (initial = '') => {
  const values = new Set(initial.split(/\s+/u).filter(Boolean))
  return {
    contains: (name) => values.has(name),
    add: (...names) => { names.forEach((name) => values.add(name)) },
  }
}

const makeScroller = (camX, camY) => {
  const attrs = new Map()
  const plane = {
    className: 'unified-paper paper-sheet-plane',
    classList: makeClassList('unified-paper paper-sheet-plane'),
    style: { transform: '' },
    offsetHeight: 1,
    offsetWidth: 1,
  }
  const scroller = {
    className: 'unified-note-view paper-view',
    classList: makeClassList('unified-note-view paper-view'),
    scrollTop: camY,
    scrollLeft: camX,
    offsetWidth: 900,
    offsetHeight: 700,
    style: {},
    parentElement: null,
    children: [],
    closest: (selector) => {
      const wanted = String(selector).split(',').map((part) => part.trim().replace(/^\./u, ''))
      return wanted.some((name) => scroller.classList.contains(name)) ? scroller : null
    },
    querySelector: (selector) => (
      String(selector).includes('unified-paper') || String(selector).includes('paper-sheet')
        ? plane
        : null
    ),
    querySelectorAll: () => [],
    getAttribute: (name) => (attrs.has(name) ? attrs.get(name) : null),
    setAttribute: (name, value) => { attrs.set(name, String(value)) },
  }
  return scroller
}

const makeCanvas = (width, height) => {
  let w = width
  let h = height
  let paints = 0
  const pixel = { data: new Uint8ClampedArray([0, 0, 0, 0]), width: 1, height: 1 }
  const ctx = {
    setTransform() {},
    clearRect() { paints += 1 },
    getImageData() { return pixel },
    putImageData() { paints += 1 },
  }
  return {
    get width() { return w },
    set width(value) { w = Number(value) || 0; paints += 1 },
    get height() { return h },
    set height(value) { h = Number(value) || 0 },
    getContext: () => ctx,
    style: { transform: '' },
    paints: () => paints,
  }
}

const makeSurface = () => {
  const attrs = new Map()
  const canvases = []
  return {
    style: { transform: '', width: '', height: '' },
    offsetWidth: 900,
    offsetHeight: 700,
    canvases,
    querySelectorAll: (selector) => (String(selector).includes('canvas') ? canvases : []),
    getAttribute: (name) => (attrs.has(name) ? attrs.get(name) : null),
    setAttribute: (name, value) => { attrs.set(name, String(value)) },
  }
}

try {
  assert.equal(fixture.id, '1788704214528')
  assert.equal(fixture.version, '2026.9.14')
  assert.equal(fixture.platform, 'linux')
  assert.equal(fixture.description, 'Bug Description in the text. Bugreport just for the logs.')
  assert.equal(fixture.events.some((event) => event.noteId === 'Mathematik/Untitled note.md'), true)
  assert.equal(fixture.events.some((event) => event.noteId === 'Geschichte/Dossier1_Einstieg_Zionismus.pdf'), true)
  assert.equal(fixture.id === '1788698537115', false)
  const pen = fixture.events.filter((event) => event.kind === 'pen')
  assert.equal(pen.length, 14)
  assert.equal(pen.filter((event) => event.grew === true).length, 9)
  assert.equal(pen[0].padX, 108)
  assert.equal(pen[0].pageH, 1408)
  assert.equal(pen.at(-2).pageH, 2448)
  assert.equal(pen.at(-2).camY, 2134)

  const ops = visualGrowOpsFromBugEvents(fixture.events)
  assert.equal(ops.length, 14)
  assert.equal(ops.filter((op) => op.grew).length, 9)
  assert.equal(ops.at(-2).height, 2448)

  assert.equal(VISUAL_GROW_REFRESH_FRAMES, 2)
  assert.equal(growCompositorVisualOffset(144, false).y, 144)
  assert.equal(
    growCompositorVisualOffset(144, true).y,
    144,
    'compositor-generation-only must still leave the height-delta slip',
  )
  assert.equal(growCanvasSurfaceVisualOffset(144, false).y, 144)
  assert.equal(growCanvasSurfaceVisualOffset(144, true).y, 0)

  const staleLayout = {
    paperX: REPORT_VISUAL_GROW_GLYPH.paperX,
    paperY: REPORT_VISUAL_GROW_GLYPH.paperY,
    camX: 637,
    camY: 1456,
    padX: 108,
    padY: 0,
    editorX: 0,
    editorY: 0,
  }
  const previous = sampleVisualAfterGrowRefresh(null, { ...staleLayout, camY: 1456 }, true, 0)
  const stale = sampleVisualAfterGrowRefresh(previous, { ...staleLayout, camY: 1456 }, false, 144)
  const staleMotionExpected = glyphExpectedVisual(staleLayout)
  assert.ok(
    Math.abs(stale.visualY - staleMotionExpected.y) > 2,
    'uncorrected grow must leave a visual slip',
  )
  const corrected = sampleVisualAfterGrowRefresh(previous, { ...staleLayout, camY: 1456 }, true, 144)
  assert.ok(Math.abs(corrected.visualY - staleMotionExpected.y) <= 2)

  const growOp = {
    width: 2580,
    height: 1584,
    padX: 108,
    padY: 0,
    camX: 637,
    camY: 1456,
    grew: true,
  }
  const skippedState = emptyVisualGrowState({
    width: 2580,
    height: 1408,
    padX: 108,
    padY: 0,
    camX: 637,
    camY: 1456,
  })
  const skipped = applyVisualGrowOp(skippedState, growOp, null)
  assert.equal(skipped.slip, true, 'skipping canvas/surface visual update must still be the old slip')
  assert.equal(skipped.canvasUpdated, false)

  const compositorScroller = makeScroller(637, 1456)
  const compositorOnly = applyVisualGrowOp(skippedState, growOp, compositorScroller)
  assert.ok(compositorOnly.refreshGen > 0, 'compositor generation can still bump')
  assert.equal(
    compositorOnly.slip,
    true,
    'grow that only bumps compositor generation must still slip',
  )
  assert.equal(compositorOnly.canvasUpdated, false)
  assert.ok(forcePaperCompositorRefresh(compositorScroller) > compositorOnly.refreshGen)

  const canvas = makeCanvas(900, 700)
  assert.equal(paintPaperCanvasSurfaceUpdate(canvas), true)
  assert.ok(canvas.paints() > 0)
  const surface = makeSurface()
  surface.canvases.push(canvas)
  const painted = refreshPaperCanvasSurface(surface, [canvas])
  assert.ok(painted > 0, 'canvas/surface paint must bump generation')

  const scroller = makeScroller(ops[0].camX, ops[0].camY)
  const liveCanvas = makeCanvas(900, 700)
  const committedCanvas = makeCanvas(900, 700)
  const liveSurface = makeSurface()
  liveSurface.canvases.push(liveCanvas, committedCanvas)
  let state = emptyVisualGrowState({
    width: ops[0].width,
    height: ops[0].height,
    padX: ops[0].padX,
    padY: ops[0].padY,
    camX: ops[0].camX,
    camY: ops[0].camY,
  })
  const frames = []
  for (const op of ops) {
    const next = applyVisualGrowOp(state, op, scroller, {
      surface: liveSurface,
      canvases: [liveCanvas, committedCanvas],
    })
    if (op.grew) {
      assert.equal(next.slip, false, `grow ${op.height} must not slip after canvas/surface update`)
      assert.equal(next.back, false, 'grow must not rely on a later snap-back')
      assert.equal(next.canvasUpdated, true, 'grow must paint the canvas/surface in the same step')
      assert.ok(Math.abs(next.sample.visualX - next.expectedX) <= 2)
      assert.ok(Math.abs(next.sample.visualY - next.expectedY) <= 2)
      assert.ok(next.canvasGen > state.canvasGen, 'grow must bump the canvas/surface generation')
    }
    frames.push({
      height: next.stay.height,
      camY: next.stay.camY,
      grew: op.grew,
      slip: next.slip,
      back: next.back,
      canvasUpdated: next.canvasUpdated,
      visualY: next.sample.visualY,
      expectedY: next.expectedY,
    })
    state = next
  }
  assert.equal(state.stay.height, 2448)
  assert.equal(frames.filter((frame) => frame.grew && frame.slip).length, 0)
  assert.equal(frames.some((frame) => frame.back === true), false)
  assert.equal(frames.filter((frame) => frame.grew && !frame.canvasUpdated).length, 0)

  let scheduled = 0
  schedulePaperVisualGrowRefresh((callback) => {
    scheduled += 1
    callback()
    return scheduled
  }, scroller, { x: 637, y: 1456 }, VISUAL_GROW_REFRESH_FRAMES, {
    surface: liveSurface,
    canvases: [liveCanvas, committedCanvas],
  })
  assert.equal(scheduled, VISUAL_GROW_REFRESH_FRAMES)
  const correction = applyVisualGrowCorrection(scroller, { x: 637, y: 1456 }, {
    surface: liveSurface,
    canvases: [liveCanvas, committedCanvas],
  })
  assert.equal(correction.canvasUpdated, true)
  assert.ok(correction.canvasGen > 0)

  assert.match(boardSource, /applyVisualGrowCorrection\(/)
  assert.match(boardSource, /schedulePaperVisualGrowRefresh\(/)
  assert.match(boardSource, /const canvases = \[canvasRef\.current, committedCanvasRef\.current\]/)
  assert.match(boardSource, /committedCanvasDirtyRef\.current = true\n    redraw\(true\)/)
  assert.doesNotMatch(boardSource, /schedulePageLayoutRefresh\(/)
  assert.match(caretSource, /export const applyVisualGrowOp/)
  assert.match(caretSource, /export const refreshPaperCanvasSurface/)
  assert.match(caretSource, /export const paintPaperCanvasSurfaceUpdate/)
  assert.match(caretSource, /export const applyVisualGrowCorrection/)
  assert.match(caretSource, /VISUAL_GROW_REFRESH_FRAMES = 2/)
  assert.match(caretSource, /scheduleFrame/)
  assert.doesNotMatch(caretSource, /setInterval\(/)
  assert.doesNotMatch(caretSource, /while\s*\(\s*true\s*\)/)

  console.log(JSON.stringify({
    report: fixture.id,
    version: fixture.version,
    platform: fixture.platform,
    description: fixture.description,
    notes: ['Geschichte/Dossier1_Einstieg_Zionismus.pdf', 'Mathematik/Untitled note.md'],
    growFrames: frames.filter((frame) => frame.grew).length,
    lastHeight: state.stay.height,
    lastSlip: state.slip,
    lastBack: frames.at(-1)?.back ?? false,
    lastCanvasUpdated: state.canvasUpdated,
    lastVisualY: state.sample.visualY,
    lastExpectedY: frames.at(-1)?.expectedY,
  }))
  console.log('latest-bug ok')
} finally {
  await server.close()
}
