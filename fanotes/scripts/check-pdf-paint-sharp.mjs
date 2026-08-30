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
  MAX_PDF_DPR,
  MAX_PDF_EDGE,
  MAX_PDF_PIXELS,
  paintSizeForPage,
  pdfPaintDeviceScale,
} = await server.ssrLoadModule('/src/lib/pdfDocument.ts')
const {
  INK_MAX_CANVAS_PIXELS_TALL,
  INK_TALL_SCALE_FLOOR,
  inkOverlayPixelSize,
  inkStrokeCssPixels,
} = await server.ssrLoadModule('/src/lib/paperGrow.ts')

const A4 = { width: 900, height: 1273 }

const runOnce = () => {
  assert.ok(MAX_PDF_DPR >= 2.5, `HiDPI DPR cap must cover 2× tablets, got ${MAX_PDF_DPR}`)
  assert.ok(MAX_PDF_EDGE >= 8_192, `PDF edge cap must cover zoomed HiDPI, got ${MAX_PDF_EDGE}`)
  assert.ok(MAX_PDF_PIXELS >= 24_000_000, `PDF page budget must keep zoomed 2× A4, got ${MAX_PDF_PIXELS}`)
  assert.ok(INK_MAX_CANVAS_PIXELS_TALL >= 16_000_000, `tall ink budget must stay HiDPI, got ${INK_MAX_CANVAS_PIXELS_TALL}`)
  assert.ok(INK_TALL_SCALE_FLOOR >= 0.8, `tall ink floor must not collapse, got ${INK_TALL_SCALE_FLOOR}`)

  const hidpi = paintSizeForPage(A4.width, A4.height, { dpr: 2, viewZoom: 1 })
  assert.ok(
    hidpi.pixelWidth >= A4.width * 2 * 0.92,
    `2× A4 page must keep device pixels (got ${hidpi.pixelWidth} for ${A4.width} CSS)`,
  )
  assert.ok(
    Math.abs(hidpi.pixelWidth / hidpi.pixelHeight - A4.width / A4.height) < 0.01,
    'page aspect must survive the pixel budget',
  )

  const zoomed = paintSizeForPage(A4.width, A4.height, { dpr: 2, viewZoom: 2 })
  assert.ok(
    zoomed.pixelWidth > hidpi.pixelWidth * 1.2,
    `sheet zoom 2× must re-raster PDF, got ${zoomed.pixelWidth} vs ${hidpi.pixelWidth}`,
  )
  assert.ok(
    zoomed.pixelWidth >= A4.width * 2 * 2 * 0.92,
    `zoomed 2× A4 at DPR 2 must keep device pixels (got ${zoomed.pixelWidth})`,
  )
  assert.equal(pdfPaintDeviceScale(2, 1), 2)
  assert.ok(pdfPaintDeviceScale(2, 2) > pdfPaintDeviceScale(2, 1))

  const oldBudgetWouldCrush = A4.width * 1.75 * A4.height * 1.75
  assert.ok(oldBudgetWouldCrush > 2_400_000, 'the previous 2.4M cap crushed a 2× A4 page')
  assert.ok(hidpi.pixelWidth * hidpi.pixelHeight > 2_400_000)

  const viewportInk = inkOverlayPixelSize(900, 2_200, 1, true, 2)
  assert.ok(
    viewportInk.width >= 900 * 2 * 0.85,
    `visible PDF ink window must stay HiDPI, got ${viewportInk.width}`,
  )
  const bitmapPen = inkStrokeCssPixels(3.5, viewportInk.width, 900)
  assert.ok(
    bitmapPen >= 3.5 * 2 * 0.85,
    `a 3.5px pen on a 2× PDF window must occupy HiDPI backing pixels, got ${bitmapPen}`,
  )
  const cssPen = bitmapPen * 900 / viewportInk.width
  assert.ok(Math.abs(cssPen - 3.5) < 1e-6, `pen must still read as 3.5 CSS px, got ${cssPen}`)

  const pdf = readFileSync(join(root, 'src', 'components', 'PdfNoteView.tsx'), 'utf8')
  const worksheet = readFileSync(join(root, 'src', 'components', 'WorksheetLayer.tsx'), 'utf8')
  const board = readFileSync(join(root, 'src', 'components', 'DrawingBoard.tsx'), 'utf8')
  const paperView = readFileSync(join(root, 'src', 'lib', 'paperView.ts'), 'utf8')
  const css = readFileSync(join(root, 'src', 'styles.css'), 'utf8')
  assert.match(pdf, /paintBoxForPage\(cssWidth, cssHeight, \{/)
  assert.match(pdf, /watchSheetZoom\(host, schedule\)/)
  assert.match(pdf, /imageSmoothingQuality = 'high'/)
  assert.match(pdf, /liveCanvas\.style\.width = `\$\{Math\.round\(box\.cssWidth\)\}px`/)
  assert.match(pdf, /liveCanvas\.style\.height = `\$\{Math\.round\(box\.cssHeight\)\}px`/)
  assert.match(worksheet, /paintBoxForPage\(cssWidth, cssHeight, \{/)
  assert.match(worksheet, /watchSheetZoom\(host, schedule\)/)
  assert.doesNotMatch(worksheet, /MAX_PDF_PIXELS = 2_400_000/)
  assert.match(board, /inkOverlayPixelSize\(/)
  assert.doesNotMatch(board, /MAX_CANVAS_PIXELS_TALL = 4_200_000/)
  assert.match(paperView, /export const watchSheetZoom/)
  assert.match(css, /\.pdf-note-page canvas \{[\s\S]*?image-rendering:\s*auto/)

  return {
    hidpiWidth: hidpi.pixelWidth,
    zoomedWidth: zoomed.pixelWidth,
    inkWidth: viewportInk.width,
    bitmapPen,
    cssPen,
  }
}

try {
  const first = runOnce()
  const second = runOnce()
  assert.deepEqual(first, second)
  console.log(JSON.stringify(first))
  console.log('pdf-paint-sharp ok')
} finally {
  await server.close()
}
