import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const server = await createServer({
  appType: 'custom',
  logLevel: 'error',
  optimizeDeps: { noDiscovery: true },
  server: { middlewareMode: true },
})

const {
  PAGE_START_HEIGHT,
  PAGE_START_WIDTH,
  growPageFromMark,
  markdownAndInkAfterGrowSequence,
  paintedStayExtent,
  paperOriginScrollDelta,
} = await server.ssrLoadModule('/src/lib/noteCanvas.ts')
const {
  PAPER_DOT_TILE_PX,
  paperRulingBackgroundPosition,
  paperRulingPhase,
  paperRulingTileOrigin,
} = await server.ssrLoadModule('/src/lib/paperRuling.ts')

const CORNERS = {
  'top-left': { x: 0.04, y: 0.03 },
  'top-right': { x: 0.96, y: 0.03 },
  'bottom-left': { x: 0.04, y: 0.96 },
  'bottom-right': { x: 0.96, y: 0.96 },
}

const runOnce = () => {
  const start = { width: PAGE_START_WIDTH, height: PAGE_START_HEIGHT }
  const text = { x: 86, y: 78 }
  const existingInk = { x: 0.2, y: 0.3 }
  const viewport = { width: 1400, height: 800 }
  const samples = [
    CORNERS['top-left'],
    CORNERS['top-right'],
    CORNERS['bottom-left'],
    CORNERS['bottom-right'],
    { x: 0.97, y: 0.02 },
    { x: 0.02, y: 0.97 },
  ]

  assert.equal(paperOriginScrollDelta(144, 1417, 1800), 144, 'camera pan is the CSS pad, not pad×layout/source')
  assert.equal(paintedStayExtent(900, 1400), 1400)
  assert.equal(paintedStayExtent(900, 0), 900)

  const paintedFirst = {
    width: paintedStayExtent(start.width, viewport.width),
    height: paintedStayExtent(start.height, viewport.height),
  }
  const firstGrow = growPageFromMark({ ...start, originX: 0, originY: 0 }, CORNERS['top-left'], paintedFirst)
  assert.ok(firstGrow.padX > 0 && firstGrow.padY > 0, 'top-left must pad both min edges')
  assert.ok(
    firstGrow.padX % PAPER_DOT_TILE_PX !== 0 || firstGrow.padY % PAPER_DOT_TILE_PX !== 0,
    'min-edge pad must not secretly land on the same ruling phase without an origin shift',
  )

  const combined = growPageFromMark(
    { width: firstGrow.width, height: firstGrow.height, originX: firstGrow.padX, originY: firstGrow.padY },
    { x: 0.97, y: 0.97 },
    { width: Math.max(firstGrow.width, viewport.width), height: Math.max(firstGrow.height, viewport.height) },
  )
  assert.ok(combined.width > firstGrow.width, 'bottom-right after a corner pad must still grow max-edge width')
  assert.ok(combined.height > firstGrow.height, 'bottom-right after a corner pad must still grow max-edge height')

  const sequence = markdownAndInkAfterGrowSequence(existingInk, text, start, samples, viewport)
  const originTextPhase = paperRulingPhase(sequence.originTextX, sequence.originTextY, PAPER_DOT_TILE_PX)
  const originInkPhase = paperRulingPhase(sequence.originInkX, sequence.originInkY, PAPER_DOT_TILE_PX)
  for (const [index, step] of sequence.steps.entries()) {
    assert.ok(
      Math.abs(step.visualTextX - sequence.originTextX) < 1e-6,
      `step ${index} typed text X ${step.visualTextX} must stay ${sequence.originTextX}`,
    )
    assert.ok(
      Math.abs(step.visualTextY - sequence.originTextY) < 1e-6,
      `step ${index} typed text Y ${step.visualTextY} must stay ${sequence.originTextY}`,
    )
    assert.ok(
      Math.abs(step.visualInkX - sequence.originInkX) < 1e-6,
      `step ${index} ink X ${step.visualInkX} must stay ${sequence.originInkX}`,
    )
    assert.ok(
      Math.abs(step.visualInkY - sequence.originInkY) < 1e-6,
      `step ${index} ink Y ${step.visualInkY} must stay ${sequence.originInkY}`,
    )
    const plane = { x: 0, y: 0, width: step.paintW, height: step.paintH }
    const rulingOrigin = paperRulingTileOrigin(plane, { x: step.originX, y: step.originY })
    assert.equal(rulingOrigin.x, step.originX, `step ${index} ruling origin X must follow the min-edge pad`)
    assert.equal(rulingOrigin.y, step.originY, `step ${index} ruling origin Y must follow the min-edge pad`)
    const rulingCss = paperRulingBackgroundPosition(rulingOrigin, plane)
    assert.equal(rulingCss.x, step.originX)
    assert.equal(rulingCss.y, step.originY)
    const textPhase = paperRulingPhase(step.paperTextX, step.paperTextY, PAPER_DOT_TILE_PX, rulingOrigin.x, rulingOrigin.y)
    const inkPhase = paperRulingPhase(step.paperInkX, step.paperInkY, PAPER_DOT_TILE_PX, rulingOrigin.x, rulingOrigin.y)
    assert.ok(
      Math.abs(textPhase.u - originTextPhase.u) < 1e-6 && Math.abs(textPhase.v - originTextPhase.v) < 1e-6,
      `step ${index} text ruling phase ${textPhase.u},${textPhase.v} must stay ${originTextPhase.u},${originTextPhase.v}`,
    )
    assert.ok(
      Math.abs(inkPhase.u - originInkPhase.u) < 1e-6 && Math.abs(inkPhase.v - originInkPhase.v) < 1e-6,
      `step ${index} ink ruling phase ${inkPhase.u},${inkPhase.v} must stay ${originInkPhase.u},${originInkPhase.v}`,
    )
    if (step.originX > 0 || step.originY > 0) {
      const unshiftedText = paperRulingPhase(step.paperTextX, step.paperTextY, PAPER_DOT_TILE_PX, 0, 0)
      assert.ok(
        Math.abs(unshiftedText.u - originTextPhase.u) > 1e-6 || Math.abs(unshiftedText.v - originTextPhase.v) > 1e-6,
        `step ${index} a ruling pinned at 0,0 must slide the glyph on the lattice`,
      )
    }
  }

  const last = sequence.steps.at(-1)
  assert.ok(last.width > start.width && last.height > start.height, 'the corner sequence must grow both axes')
  assert.ok(sequence.steps[0].padX > 0 && sequence.steps[0].padY > 0)
  assert.ok(sequence.steps.some((step, index) => index > 0 && step.width > sequence.steps[index - 1].width))
  assert.ok(sequence.steps.some((step, index) => index > 0 && step.height > sequence.steps[index - 1].height))

  const board = readFileSync(join(root, 'src/components/DrawingBoard.tsx'), 'utf8')
  const noteCanvas = readFileSync(join(root, 'src/lib/noteCanvas.ts'), 'utf8')
  const ruling = readFileSync(join(root, 'src/lib/paperRuling.ts'), 'utf8')
  const css = readFileSync(join(root, 'src/styles.css'), 'utf8')
  const rulingBlock = css.slice(
    css.indexOf('.paper-sheet-plane > .paper-ruling {'),
    css.indexOf('.paper-dots .paper-sheet-plane > .paper-ruling {'),
  )
  assert.match(noteCanvas, /export const paintedStayExtent/)
  assert.match(noteCanvas, /export const markdownAndInkAfterGrowSequence/)
  assert.match(noteCanvas, /liveW = writePageStayExtent/)
  assert.match(noteCanvas, /finiteOriginPx\(pad\)/)
  assert.match(noteCanvas, /originX: page\.originX/)
  assert.match(noteCanvas, /paperTextX: stay\.textX/)
  assert.match(ruling, /originPad/)
  assert.match(ruling, /export const paperRulingTileOrigin/)
  assert.match(ruling, /export const paperRulingBackgroundPosition/)
  assert.match(ruling, /export const paperRulingPhase/)
  assert.match(rulingBlock, /background-position:\s*var\(--text-origin-x/)
  assert.match(rulingBlock, /var\(--text-origin-y/)
  assert.doesNotMatch(rulingBlock, /background-position:\s*0\s+0/)
  assert.match(board, /originX: sourceOriginXRef\.current/)
  assert.match(board, /originY: sourceOriginYRef\.current/)
  assert.match(board, /growPageFromMark\(/)
  assert.match(board, /writePageStayExtent\(prevW/)
  assert.match(board, /writePageStayExtent\(nextW/)
  assert.match(board, /stayPutAfterExtentGrow\(/)
  assert.match(board, /paperRulingTileOrigin\(/)
  assert.match(board, /paperRulingBackgroundPosition\(/)
  assert.match(board, /background-position/)
  assert.doesNotMatch(board, /paintedW > sourceWidthRef\.current/)
  assert.doesNotMatch(noteCanvas, /_painted/)

  const lastOrigin = paperRulingTileOrigin(
    { x: 0, y: 0, width: last.paintW, height: last.paintH },
    { x: last.originX, y: last.originY },
  )
  const lastPhase = paperRulingPhase(last.paperTextX, last.paperTextY, PAPER_DOT_TILE_PX, lastOrigin.x, lastOrigin.y)
  return {
    firstPadX: sequence.steps[0].padX,
    firstPadY: sequence.steps[0].padY,
    lastWidth: last.width,
    lastHeight: last.height,
    visualTextX: last.visualTextX,
    visualTextY: last.visualTextY,
    visualInkX: last.visualInkX,
    visualInkY: last.visualInkY,
    paperRulingPhaseU: lastPhase.u,
    paperRulingPhaseV: lastPhase.v,
    rulingOriginX: lastOrigin.x,
    rulingOriginY: lastOrigin.y,
    paintW: last.paintW,
    paintH: last.paintH,
  }
}

try {
  const first = runOnce()
  const second = runOnce()
  assert.deepEqual(first, second)
  console.log(JSON.stringify(first))
  console.log('corner-stay ok')
} finally {
  await server.close()
}
