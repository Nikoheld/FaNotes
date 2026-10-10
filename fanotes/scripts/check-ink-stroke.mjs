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
const { pressureWidth } = await server.ssrLoadModule('/src/lib/inkStrokePaint.ts')
const { viewportRasterEnabled } = await server.ssrLoadModule('/src/lib/viewportRasterFlag.ts')
const viewportRaster = viewportRasterEnabled() ? await server.ssrLoadModule('/src/lib/viewportRaster.ts') : null

/** Opaque rows the viewport raster paints for a horizontal pen line, at the bitmap's center column. */
const rasterLineRows = (pen, bitmapWidth, layoutWidth) => {
  const width = Math.round(bitmapWidth)
  const image = viewportRaster.rasterizeInkStrokes([{
    points: [{ x: 0.1, y: 0.5, pressure: 0.5 }, { x: 0.9, y: 0.5, pressure: 0.5 }],
    baseWidth: pen,
    pressureEnabled: false,
    color: '#202333',
    purpose: 'handwriting',
  }], width, width, { layoutWidth })
  const x = Math.floor(image.width / 2)
  let rows = 0
  for (let y = 0; y < image.height; y += 1) {
    if (image.data[(y * image.width + x) * 4 + 3] >= 24) rows += 1
  }
  return rows
}

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

  let raster = null
  if (viewportRaster) {
    // Flag on: the Rust viewport raster paints the same CSS pen on every sheet.
    for (const pressure of [0, 0.35, 0.5, 1]) {
      assert.equal(viewportRaster.rasterPressureWidth(pen, true, pressure), pressureWidth({ baseWidth: pen, pressureEnabled: true }, pressure))
    }
    assert.equal(viewportRaster.rasterPressureWidth(pen, false, 0.9), pen)
    raster = {
      a4Rows: rasterLineRows(pen, 900, 900),
      dprRows: rasterLineRows(pen, 1800, 900),
      stripRows: rasterLineRows(pen, tallPdf.width, tallPdf.width),
      absorbedRows: rasterLineRows(pen, 560, 560),
    }
    assert.ok(Math.abs(raster.a4Rows - pen) <= 1.5, `raster A4 pen must be ${pen} px, got ${raster.a4Rows}`)
    assert.ok(Math.abs(raster.dprRows - pen * 2) <= 1.5, `raster dpr-2 pen must be ${pen * 2} px, got ${raster.dprRows}`)
    assert.ok(Math.abs(raster.stripRows - pen) <= 1.5, `raster pen on the tall PDF strip must stay ${pen} px, got ${raster.stripRows}`)
    assert.ok(Math.abs(raster.absorbedRows - pen) <= 1.5, `raster pen on an absorbed sheet must stay ${pen} px, got ${raster.absorbedRows}`)
    assert.match(board, /viewportRasterEnabled\(\)/)
    assert.match(board, /import\('\.\.\/lib\/viewportRaster'\)/)
    assert.match(board, /redrawViewportRaster\(layoutWidth, layoutHeight, measureLayout\)/)
    assert.match(board, /renderDocument\(\s*committedCanvas,\s*strokesRef\.current/, 'the slice bitmap stays the flag-off path')
  }

  return {
    a4,
    plane: newNote,
    tallStrip: tallPdf.width,
    oldPdfHairline,
    fixedPdf,
    oldAbsorbed,
    ...(raster ? { raster } : {}),
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
