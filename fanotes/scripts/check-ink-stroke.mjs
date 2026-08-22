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
  PAPER_SOURCE_HEIGHT,
  PAPER_SOURCE_WIDTH,
  a4AspectBoardSize,
  inkStrokeCssPixels,
  inkStrokePaintScale,
} = await server.ssrLoadModule('/src/lib/paperGrow.ts')

const runOnce = () => {
  const pen = 3.5
  const a4 = inkStrokeCssPixels(pen, 900, 900)
  assert.ok(Math.abs(a4 - pen) < 1e-6, `A4 3.5px pen must stay 3.5 CSS px, got ${a4}`)

  const dpr = inkStrokeCssPixels(pen, 1800, 900)
  assert.ok(Math.abs(dpr - pen * 2) < 1e-6, 'dpr-2 bitmap is 7px; CSS overlay is still 3.5')

  const plane = 2020
  const oldNote = pen * plane / 2020
  const newNote = inkStrokeCssPixels(pen, plane, plane)
  assert.ok(Math.abs(oldNote - pen) < 1e-6)
  assert.ok(Math.abs(newNote - pen) < 1e-6)

  const tallPdf = a4AspectBoardSize(plane, 800, PAPER_SOURCE_WIDTH, 4000)
  assert.ok(tallPdf.width < 250, `tall PDF A4-aspect overlay must be a strip, got ${tallPdf.width}`)
  const oldPdfHairline = pen * tallPdf.width / PAPER_SOURCE_WIDTH
  assert.ok(oldPdfHairline < 1, `old scale on the strip is a hairline (${oldPdfHairline})`)
  const fixedPdf = inkStrokeCssPixels(pen, tallPdf.width, tallPdf.width)
  assert.ok(Math.abs(fixedPdf - pen) < 1e-6, `fixed pen on the strip is still ${pen} CSS px`)

  const absorbedNote = inkStrokeCssPixels(pen, 560, 560)
  const oldAbsorbed = pen * 560 / 2020
  assert.ok(oldAbsorbed < 1.2, `absorbed sourceWidth shrank the pen to ${oldAbsorbed}`)
  assert.ok(Math.abs(absorbedNote - pen) < 1e-6)

  assert.equal(inkStrokePaintScale(900, 900), 1)
  assert.ok(Math.abs(inkStrokePaintScale(1800, 900) - 2) < 1e-6)

  const board = readFileSync(join(root, 'src/components/DrawingBoard.tsx'), 'utf8')
  const paint = readFileSync(join(root, 'src/lib/inkStrokePaint.ts'), 'utf8')
  assert.match(paint, /inkStrokePaintScale/)
  assert.match(paint, /export const drawInkStroke/)
  assert.match(board, /paintInkStroke/)
  assert.match(board, /markdownNoteInkOverlaySize/)
  assert.match(board, /overflow:visible/)
  assert.doesNotMatch(paint, /const scale = width \/ Math\.max\(1, sourceWidth\)/)
  assert.ok(PAPER_SOURCE_HEIGHT > 1000)

  return {
    a4,
    plane: newNote,
    tallStrip: tallPdf.width,
    oldPdfHairline,
    fixedPdf,
    oldAbsorbed,
  }
}

try {
  const first = runOnce()
  const second = runOnce()
  assert.deepEqual(first, second)
  console.log(JSON.stringify(first))
  console.log('ink-stroke ok')
} finally {
  await server.close()
}
