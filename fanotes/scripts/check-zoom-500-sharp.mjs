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
  INK_MAX_VIEW_QUALITY_ZOOM,
  inkOverlayPixelSize,
  inkViewQualityZoom,
} = await server.ssrLoadModule('/src/lib/paperGrow.ts')
const {
  FULL_INK_WINDOW,
  inkWindowSpan,
  isFullInkWindow,
  layoutInkWindow,
  resolveInkOverlayWindow,
  visibleFitsInkWindow,
} = await server.ssrLoadModule('/src/lib/pdfInkHit.ts')
const {
  MAX_PDF_VIEW_QUALITY_ZOOM,
  paintBoxForPage,
  pdfPaintDeviceScale,
  visiblePageCssWindow,
} = await server.ssrLoadModule('/src/lib/pdfDocument.ts')

const A4 = { width: 900, height: 1273 }
const VIEW = { width: 1200, height: 800 }
const ZOOM_500 = 5
const ZOOM_300 = 3
const DPR = 2

const pixelsPerVisualCss = (bitmapWidth, layoutWidth, viewZoom) => (
  bitmapWidth / Math.max(1, layoutWidth * viewZoom)
)

const runOnce = () => {
  assert.ok(INK_MAX_VIEW_QUALITY_ZOOM >= 5, `ink quality zoom must cover 500%, got ${INK_MAX_VIEW_QUALITY_ZOOM}`)
  assert.ok(MAX_PDF_VIEW_QUALITY_ZOOM >= 5, `PDF quality zoom must cover 500%, got ${MAX_PDF_VIEW_QUALITY_ZOOM}`)
  assert.equal(inkViewQualityZoom(ZOOM_500), ZOOM_500)
  assert.equal(inkViewQualityZoom(1), 1)
  assert.equal(pdfPaintDeviceScale(DPR, ZOOM_500), DPR * ZOOM_500)

  const at100 = layoutInkWindow({
    paperHeight: A4.height,
    viewHeight: VIEW.height,
    scrollTop: 0,
    viewZoom: 1,
  })
  assert.deepEqual(at100, FULL_INK_WINDOW)

  const visible500 = layoutInkWindow({
    paperHeight: A4.height,
    viewHeight: VIEW.height,
    scrollTop: 0,
    viewZoom: ZOOM_500,
    padRatio: 0,
  })
  const next500 = layoutInkWindow({
    paperHeight: A4.height,
    viewHeight: VIEW.height,
    scrollTop: 0,
    viewZoom: ZOOM_500,
  })
  assert.ok(!isFullInkWindow(visible500), `500% visible slice must not be full, got ${JSON.stringify(visible500)}`)
  assert.equal(
    visibleFitsInkWindow(FULL_INK_WINDOW, visible500),
    false,
    'a full overlay must not keep covering a 500% visible slice',
  )
  const fromFull = resolveInkOverlayWindow(FULL_INK_WINDOW, visible500, next500, false)
  const fromFullForced = resolveInkOverlayWindow(FULL_INK_WINDOW, visible500, next500, true)
  assert.equal(fromFull, next500)
  assert.equal(fromFullForced, next500)
  assert.ok(!isFullInkWindow(fromFull), `100%→500% keep-vs-window must leave the full overlay, got ${JSON.stringify(fromFull)}`)
  const kept = resolveInkOverlayWindow(next500, visible500, next500, false)
  assert.equal(kept, next500)

  const inkWindow = fromFull
  assert.ok(inkWindow.y1 - inkWindow.y0 < 0.94, `500% A4 must window the visible slice, got ${JSON.stringify(inkWindow)}`)
  const windowHeight = A4.height * inkWindowSpan(inkWindow)
  const ink500 = inkOverlayPixelSize(A4.width, windowHeight, ZOOM_500, true, DPR)
  const fullAt500 = inkOverlayPixelSize(A4.width, A4.height, ZOOM_500, true, DPR)
  const fullPerVisual = pixelsPerVisualCss(fullAt500.width, A4.width, ZOOM_500)
  assert.ok(
    fullPerVisual < DPR * 0.85,
    `a kept full A4 at 5× must still be the budget-capped miss this check exists to catch, got ${fullPerVisual.toFixed(3)}`,
  )
  const inkPerVisual = pixelsPerVisualCss(ink500.width, A4.width, ZOOM_500)
  assert.ok(
    inkPerVisual >= DPR * 0.85,
    `visible ink at 500% must stay near DPR, got ${inkPerVisual.toFixed(3)} px/css (bitmap ${ink500.width} for ${A4.width} CSS at ${ZOOM_500}×)`,
  )
  const naive3x = inkOverlayPixelSize(A4.width, A4.height, 3, true, DPR)
  const stretched3x = pixelsPerVisualCss(naive3x.width, A4.width, ZOOM_500)
  assert.ok(
    inkPerVisual > stretched3x * 1.15,
    `500% must not be a 3× bitmap stretched to 5× (${inkPerVisual.toFixed(3)} vs stretched ${stretched3x.toFixed(3)})`,
  )

  const ink300 = inkOverlayPixelSize(A4.width, A4.height * inkWindowSpan(layoutInkWindow({
    paperHeight: A4.height,
    viewHeight: VIEW.height,
    scrollTop: 0,
    viewZoom: ZOOM_300,
  })), ZOOM_300, true, DPR)
  const ink300PerVisual = pixelsPerVisualCss(ink300.width, A4.width, ZOOM_300)
  assert.ok(ink300PerVisual >= DPR * 0.85, `3× control must stay HiDPI, got ${ink300PerVisual.toFixed(3)}`)

  const pdfVisible500 = visiblePageCssWindow({
    pageWidth: A4.width,
    pageHeight: A4.height,
    viewWidth: VIEW.width,
    viewHeight: VIEW.height,
    viewZoom: ZOOM_500,
    scrollTop: 0,
    pageOffsetTop: 0,
  })
  assert.ok(pdfVisible500.height < A4.height * 0.8, `500% PDF window must be the viewport, got ${pdfVisible500.height}`)
  const pdf500 = paintBoxForPage(A4.width, A4.height, {
    dpr: DPR,
    viewZoom: ZOOM_500,
    visibleLeft: pdfVisible500.left,
    visibleTop: pdfVisible500.top,
    visibleCssWidth: pdfVisible500.width,
    visibleCssHeight: pdfVisible500.height,
  })
  const pdfPerVisual = pixelsPerVisualCss(pdf500.pixelWidth, pdf500.cssWidth, ZOOM_500)
  assert.ok(
    pdfPerVisual >= DPR * 0.85,
    `visible PDF at 500% must stay near DPR, got ${pdfPerVisual.toFixed(3)} (bitmap ${pdf500.pixelWidth} for ${pdf500.cssWidth} CSS)`,
  )
  assert.ok(pdf500.cssHeight <= pdfVisible500.height + 1, 'windowed PDF bitmap must not cover the full sheet when the budget cannot')

  const pdf300Visible = visiblePageCssWindow({
    pageWidth: A4.width,
    pageHeight: A4.height,
    viewWidth: VIEW.width,
    viewHeight: VIEW.height,
    viewZoom: ZOOM_300,
  })
  const pdf300 = paintBoxForPage(A4.width, A4.height, {
    dpr: DPR,
    viewZoom: ZOOM_300,
    visibleLeft: pdf300Visible.left,
    visibleTop: pdf300Visible.top,
    visibleCssWidth: pdf300Visible.width,
    visibleCssHeight: pdf300Visible.height,
  })
  const pdf300PerVisual = pixelsPerVisualCss(pdf300.pixelWidth, pdf300.cssWidth, ZOOM_300)
  assert.ok(pdf300PerVisual >= DPR * 0.85, `3× PDF control must stay HiDPI, got ${pdf300PerVisual.toFixed(3)}`)

  const board = readFileSync(join(root, 'src', 'components', 'DrawingBoard.tsx'), 'utf8')
  const pdf = readFileSync(join(root, 'src', 'components', 'PdfNoteView.tsx'), 'utf8')
  const worksheet = readFileSync(join(root, 'src', 'components', 'WorksheetLayer.tsx'), 'utf8')
  const inkHit = readFileSync(join(root, 'src', 'lib', 'pdfInkHit.ts'), 'utf8')
  const paperGrow = readFileSync(join(root, 'src', 'lib', 'paperGrow.ts'), 'utf8')
  const pdfDoc = readFileSync(join(root, 'src', 'lib', 'pdfDocument.ts'), 'utf8')
  assert.match(board, /inkOverlayPixelSize\(/)
  assert.match(board, /layoutInkWindow\(/)
  assert.match(board, /resolveInkOverlayWindow\(/)
  assert.match(board, /syncInkWindow\(true\)/)
  assert.match(board, /viewZoomRef\.current/)
  assert.match(inkHit, /export const resolveInkOverlayWindow/)
  assert.match(inkHit, /isFullInkWindow\(window\)\) return false/)
  assert.match(pdf, /paintBoxForPage\(/)
  assert.match(pdf, /visiblePageCssWindow\(/)
  assert.match(pdf, /viewZoom/)
  assert.match(pdf, /transform: \[1, 0, 0, 1, -box\.cssLeft/)
  assert.match(worksheet, /paintBoxForPage\(/)
  assert.match(worksheet, /visiblePageCssWindow\(/)
  assert.match(worksheet, /transform: \[1, 0, 0, 1, -box\.cssLeft/)
  assert.match(inkHit, /paperHeight < 1_600 && zoom <= 1\.4/)
  assert.match(paperGrow, /INK_MAX_VIEW_QUALITY_ZOOM = 6/)
  assert.match(pdfDoc, /MAX_PDF_VIEW_QUALITY_ZOOM = 6/)
  assert.doesNotMatch(paperGrow, /INK_MAX_VIEW_QUALITY_ZOOM = 3/)
  assert.doesNotMatch(pdfDoc, /MAX_PDF_VIEW_QUALITY_ZOOM = 3/)
  assert.match(paperGrow, /Math\.max\(baseBoost, zoomBoost\)/)

  return {
    inkPerVisual: Number(inkPerVisual.toFixed(4)),
    pdfPerVisual: Number(pdfPerVisual.toFixed(4)),
    ink300PerVisual: Number(ink300PerVisual.toFixed(4)),
    pdf300PerVisual: Number(pdf300PerVisual.toFixed(4)),
    inkWindowSpan: Number(inkWindowSpan(inkWindow).toFixed(4)),
    pdfCssHeight: Math.round(pdf500.cssHeight),
    stretched3x: Number(stretched3x.toFixed(4)),
    fullPerVisual: Number(fullPerVisual.toFixed(4)),
    fromFullSpan: Number(inkWindowSpan(fromFull).toFixed(4)),
  }
}

try {
  const first = runOnce()
  const second = runOnce()
  assert.deepEqual(first, second)
  console.log(JSON.stringify(first))
  console.log('zoom-500-sharp ok')
} finally {
  await server.close()
}
