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

  const combined = growPageFromMark(
    { width: firstGrow.width, height: firstGrow.height, originX: firstGrow.padX, originY: firstGrow.padY },
    { x: 0.97, y: 0.97 },
    { width: Math.max(firstGrow.width, viewport.width), height: Math.max(firstGrow.height, viewport.height) },
  )
  assert.ok(combined.width > firstGrow.width, 'bottom-right after a corner pad must still grow max-edge width')
  assert.ok(combined.height > firstGrow.height, 'bottom-right after a corner pad must still grow max-edge height')

  const sequence = markdownAndInkAfterGrowSequence(existingInk, text, start, samples, viewport)
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
  }

  const last = sequence.steps.at(-1)
  assert.ok(last.width > start.width && last.height > start.height, 'the corner sequence must grow both axes')
  assert.ok(sequence.steps[0].padX > 0 && sequence.steps[0].padY > 0)
  assert.ok(sequence.steps.some((step, index) => index > 0 && step.width > sequence.steps[index - 1].width))
  assert.ok(sequence.steps.some((step, index) => index > 0 && step.height > sequence.steps[index - 1].height))

  const board = readFileSync(join(root, 'src/components/DrawingBoard.tsx'), 'utf8')
  const noteCanvas = readFileSync(join(root, 'src/lib/noteCanvas.ts'), 'utf8')
  assert.match(noteCanvas, /export const paintedStayExtent/)
  assert.match(noteCanvas, /export const markdownAndInkAfterGrowSequence/)
  assert.match(noteCanvas, /liveW = paintedStayExtent/)
  assert.match(noteCanvas, /finiteOriginPx\(pad\)/)
  assert.match(board, /originX: sourceOriginXRef\.current/)
  assert.match(board, /originY: sourceOriginYRef\.current/)
  assert.match(board, /growPageFromMark\(/)
  assert.match(board, /paintedStayExtent\(prevW/)
  assert.match(board, /paintedStayExtent\(nextW/)
  assert.match(board, /paperOriginScrollDelta\(addX\)/)
  assert.match(board, /paperOriginScrollDelta\(addY\)/)
  assert.doesNotMatch(board, /paintedW > sourceWidthRef\.current/)
  assert.doesNotMatch(noteCanvas, /_painted/)

  return {
    firstPadX: sequence.steps[0].padX,
    firstPadY: sequence.steps[0].padY,
    lastWidth: last.width,
    lastHeight: last.height,
    visualTextX: last.visualTextX,
    visualTextY: last.visualTextY,
    visualInkX: last.visualInkX,
    visualInkY: last.visualInkY,
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
