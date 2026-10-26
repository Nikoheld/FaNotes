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
  PDF_FULL_PAGE_PIXEL_BUDGET,
  paintSizeForPage,
  pdfPaintDeviceScale,
  planPdfPagePaint,
} = await server.ssrLoadModule('/src/lib/pdfDocument.ts')
const {
  INK_MAX_CANVAS_PIXELS_TALL,
  INK_TALL_SCALE_FLOOR,
  inkOverlayPixelSize,
  inkStrokeCssPixels,
} = await server.ssrLoadModule('/src/lib/paperGrow.ts')
const { inkWindowSpan } = await server.ssrLoadModule('/src/lib/pdfInkHit.ts')
const { inkWindowHeightFor } = await server.ssrLoadModule('/src/lib/inkWindowPlan.ts')

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

  // A long PDF keeps a three-viewport slice. Stretching that slice up to 6%
  // of the stack, or pre-shrinking every tall window, dropped the pen below
  // one device pixel.
  const tinySpan = inkWindowSpan({ y0: 0.1, y1: 0.12 })
  assert.ok(Math.abs(tinySpan - 0.02) < 1e-9, `a 2% slice must not be raised to 6%, got ${tinySpan}`)
  const longSlice = inkWindowHeightFor(200_000, 800)
  assert.equal(longSlice, 2_400, `a long PDF slice stays three viewports, got ${longSlice}`)
  const longInk = inkOverlayPixelSize(900, longSlice, 1, true, 2)
  assert.ok(
    longInk.width / 900 >= 2 * 0.92,
    `a long PDF window at DPR 2 must stay at device pixels, got ${longInk.width}`,
  )
  const longZoomed = inkOverlayPixelSize(900, longSlice, 2, true, 2)
  assert.ok(
    longZoomed.width / 900 >= 2 * 2 * 0.92,
    `a zoomed long PDF window must stay at device pixels, got ${longZoomed.width}`,
  )
  const longPen = inkStrokeCssPixels(3.5, longZoomed.width, 900)
  assert.ok(
    longPen >= 3.5 * 2 * 2 * 0.92,
    `a 3.5px pen on a zoomed long PDF must occupy device pixels, got ${longPen}`,
  )

  // Camera zoom 2× at DPR 2: the base bitmap (screen density) stays while a
  // detail window for the viewport is painted on top.
  const base = planPdfPagePaint(
    { cssWidth: A4.width, cssHeight: A4.height, rotation: 0, dpr: 2, viewZoom: 1, view: null },
    { baseKey: '', detail: null },
  )
  assert.ok(base.base, 'first plan paints the base')
  assert.equal(base.base.key.includes('|window'), false, 'A4 at 2× stays a full-page base')
  assert.equal(base.detail, 'drop', 'no detail layer at 100%')
  const fullA4 = base.base.box.pixelWidth * base.base.box.pixelHeight
  assert.ok(fullA4 <= PDF_FULL_PAGE_PIXEL_BUDGET, 'A4 at 2× stays inside the full-page budget')

  // A long page at 2× is tens of megapixels. The base is the visible window,
  // and it stays until the viewport leaves that window.
  const tall = { width: 900, height: 8_000 }
  const tallView = {
    viewWidth: 1000,
    viewHeight: 800,
    scrollLeft: 0,
    scrollTop: 2_000,
    pageOffsetLeft: 0,
    pageOffsetTop: 0,
  }
  const tallPlan = planPdfPagePaint(
    { cssWidth: tall.width, cssHeight: tall.height, rotation: 0, dpr: 2, viewZoom: 1, view: tallView },
    { baseKey: '', detail: null },
  )
  assert.ok(tallPlan.base, 'a long page paints a base')
  assert.match(tallPlan.base.key, /\|window$/)
  assert.ok(tallPlan.base.box.cssHeight < tall.height * 0.5, 'the long-page base is a window, not the sheet')
  assert.ok(
    tallPlan.base.box.pixelWidth * tallPlan.base.box.pixelHeight < tall.width * 2 * tall.height * 2 * 0.5,
    'the long-page base allocates far fewer pixels than the sheet',
  )
  assert.equal(tallPlan.detail, 'drop')
  const tallStay = planPdfPagePaint(
    { cssWidth: tall.width, cssHeight: tall.height, rotation: 0, dpr: 2, viewZoom: 1, view: tallView },
    { baseKey: tallPlan.base.key, baseBox: tallPlan.base.box, detail: null },
  )
  assert.equal(tallStay.base, null, 'scrolling inside the painted window keeps the base')
  const tallMove = planPdfPagePaint(
    {
      cssWidth: tall.width,
      cssHeight: tall.height,
      rotation: 0,
      dpr: 2,
      viewZoom: 1,
      view: { ...tallView, scrollTop: 6_000 },
    },
    { baseKey: tallPlan.base.key, baseBox: tallPlan.base.box, detail: null },
  )
  assert.ok(tallMove.base, 'leaving the painted window plans a new base')
  const zoomedPlan = planPdfPagePaint(
    {
      cssWidth: A4.width,
      cssHeight: A4.height,
      rotation: 0,
      dpr: 2,
      viewZoom: 2,
      view: { viewWidth: 1200, viewHeight: 800, scrollLeft: 560, scrollTop: 900, pageOffsetLeft: 560, pageOffsetTop: 560 },
    },
    { baseKey: base.base.key, detail: null },
  )
  assert.equal(zoomedPlan.base, null, 'camera zoom must not re-key the base bitmap')
  assert.ok(typeof zoomedPlan.detail === 'object', 'camera zoom 2× paints a detail layer')
  assert.ok(
    zoomedPlan.detail.box.pixelWidth / zoomedPlan.detail.box.cssWidth >= 2 * 2 * 0.92,
    'detail window keeps device pixels at 2× camera zoom',
  )

  const pdf = readFileSync(join(root, 'src', 'components', 'PdfNoteView.tsx'), 'utf8')
  const worksheet = readFileSync(join(root, 'src', 'components', 'WorksheetLayer.tsx'), 'utf8')
  const painter = readFileSync(join(root, 'src', 'lib', 'pdfPagePainter.ts'), 'utf8')
  const board = readFileSync(join(root, 'src', 'components', 'DrawingBoard.tsx'), 'utf8')
  const paperView = readFileSync(join(root, 'src', 'lib', 'paperView.ts'), 'utf8')
  const css = readFileSync(join(root, 'src', 'styles.css'), 'utf8')
  assert.match(pdf, /createPdfPagePainter\(\{/)
  assert.match(pdf, /watchSheetZoom\(host, scheduleLayout\)/)
  assert.match(worksheet, /createPdfPagePainter\(\{/)
  assert.match(worksheet, /watchSheetZoom\(host, scheduleLayout\)/)
  assert.match(painter, /planPdfPagePaint\(/)
  assert.match(painter, /imageSmoothingQuality = 'high'/)
  assert.match(painter, /canvas\.style\.width = `\$\{box\.cssWidth\.toFixed\(2\)\}px`/)
  assert.match(painter, /canvas\.style\.height = `\$\{box\.cssHeight\.toFixed\(2\)\}px`/)
  assert.doesNotMatch(worksheet, /MAX_PDF_PIXELS = 2_400_000/)
  assert.match(board, /inkOverlayPixelSize\(/)
  assert.match(board, /inkWindowSpan,/)
  assert.doesNotMatch(board, /const inkWindowSpan = /)
  assert.doesNotMatch(board, /Math\.max\(0\.06/)
  assert.doesNotMatch(readFileSync(join(root, 'src', 'lib', 'pdfInkHit.ts'), 'utf8'), /Math\.max\(0\.06/)
  assert.doesNotMatch(readFileSync(join(root, 'src', 'lib', 'inkWindowPlan.ts'), 'utf8'), /INK_WINDOW_MIN_SPAN/)
  assert.doesNotMatch(board, /MAX_CANVAS_PIXELS_TALL = 4_200_000/)
  assert.match(paperView, /export const watchSheetZoom/)
  assert.match(css, /\.pdf-note-page canvas \{[\s\S]*?image-rendering:\s*auto/)

  return {
    hidpiWidth: hidpi.pixelWidth,
    zoomedWidth: zoomed.pixelWidth,
    inkWidth: viewportInk.width,
    bitmapPen,
    cssPen,
    longSlice,
    longInkWidth: longInk.width,
    longZoomedWidth: longZoomed.width,
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
