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
  WRITE_MARGIN_Y,
  growPageFromMark,
  markdownAndInkAfterGrowSequence,
} = await server.ssrLoadModule('/src/lib/noteCanvas.ts')
const { layoutGrowAlreadyInSource, resolvePaintedLayoutGrow } = await server.ssrLoadModule('/src/lib/paperGrow.ts')

const runOnce = () => {
  const start = { width: PAGE_START_WIDTH, height: PAGE_START_HEIGHT }
  const text = { x: 86, y: 78 }
  const existingInk = { x: 0.2, y: 0.3 }
  // Live report 1788098815147: a long line down on 2026.8.72.
  const samples = [
    { x: 0.063, y: 0.059 },
    { x: 0.081, y: 0.126 },
    { x: 0.078, y: 0.077 },
    { x: 0.046, y: 0.077 },
    { x: 0.091, y: 0.078 },
    { x: 0.108, y: 0.079 },
    { x: 0.075, y: 0.092 },
    { x: 0.180, y: 0.075 },
    { x: 0.107, y: 0.173 },
    { x: 0.066, y: 0.234 },
    { x: 0.088, y: 0.221 },
    { x: 0.096, y: 0.264 },
    { x: 0.090, y: 0.363 },
    { x: 0.12, y: 0.94 },
    { x: 0.13, y: 0.96 },
  ]

  const naivePads = []
  let naive = { ...start }
  for (const sample of samples) {
    const grown = growPageFromMark(naive, sample)
    naivePads.push(grown.padY)
    naive = { width: grown.width, height: grown.height }
  }

  const sequence = markdownAndInkAfterGrowSequence(existingInk, text, start, samples)
  const extraOriginPads = sequence.steps.filter((step, index) => index > 0 && step.padY > 0).length
  assert.ok(sequence.steps[0].padY > 0, 'the first near-top sample may open paper above')
  assert.equal(
    extraOriginPads,
    0,
    `a continuing downward stroke must not keep inserting top pad (got ${extraOriginPads})`,
  )
  assert.ok(
    naivePads.filter((pad, index) => index > 0 && pad > 0).length > 0,
    'without origin tracking the same downward samples would keep padding',
  )

  for (const [index, step] of sequence.steps.entries()) {
    assert.ok(
      Math.abs(step.visualTextY - sequence.originTextY) < 1e-6,
      `step ${index}: typed text visual Y ${step.visualTextY} must stay ${sequence.originTextY}`,
    )
    assert.ok(
      Math.abs(step.visualTextX - sequence.originTextX) < 1e-6,
      `step ${index}: typed text visual X ${step.visualTextX} must stay ${sequence.originTextX}`,
    )
    assert.ok(
      Math.abs(step.visualInkY - sequence.originInkY) < 1e-6,
      `step ${index}: existing ink visual Y ${step.visualInkY} must stay ${sequence.originInkY}`,
    )
    assert.ok(
      Math.abs(step.visualInkX - sequence.originInkX) < 1e-6,
      `step ${index}: existing ink visual X ${step.visualInkX} must stay ${sequence.originInkX}`,
    )
  }

  const last = sequence.steps.at(-1)
  assert.ok(last.height > start.height, 'writing down to the far edge must grow the page')
  assert.ok(last.padY === 0, 'the far-edge grow is max-edge, not another top pad')

  assert.equal(layoutGrowAlreadyInSource(1800, 1944, 1944), true)
  assert.equal(layoutGrowAlreadyInSource(1800, 1944, 1800), false)
  const flushed = resolvePaintedLayoutGrow({
    pending: null,
    prevLayoutW: start.width,
    prevLayoutH: 1800,
    nextLayoutW: start.width,
    nextLayoutH: 1944,
    sourceW: start.width,
    sourceH: 1944,
  })
  assert.equal(flushed.apply, false, 'layout catch-up after source remap must not scale 0–1 again')
  assert.equal(flushed.scaleY, 1)

  const board = readFileSync(join(root, 'src/components/DrawingBoard.tsx'), 'utf8')
  const noteCanvas = readFileSync(join(root, 'src/lib/noteCanvas.ts'), 'utf8')
  const paperGrow = readFileSync(join(root, 'src/lib/paperGrow.ts'), 'utf8')
  assert.match(noteCanvas, /export const markdownAndInkAfterGrowSequence/)
  assert.match(board, /originX: sourceOriginXRef\.current/)
  assert.match(board, /originY: sourceOriginYRef\.current/)
  assert.match(board, /growPageFromMark\(/)
  assert.match(paperGrow, /layoutGrowAlreadyInSource/)
  assert.match(paperGrow, /layoutGrowAlreadyInSource\(input\.prevLayoutH/)

  return {
    firstPadY: sequence.steps[0].padY,
    extraOriginPads,
    lastHeight: last.height,
    visualTextY: last.visualTextY,
    visualInkY: last.visualInkY,
    slackY: WRITE_MARGIN_Y,
    startH: PAGE_START_HEIGHT,
  }
}

try {
  const first = runOnce()
  const second = runOnce()
  assert.deepEqual(first, second)
  console.log(JSON.stringify(first))
  console.log('long-down-stay ok')
} finally {
  await server.close()
}
