import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

// PDF toolbar zoom is the sheet camera: "Breite" fills the viewport width on
// first open (no empty stage beside a 900px column), "Seite" shows one whole
// page, ± step the camera, and a user's own zoom is never re-fitted.

const server = await createServer({
  appType: 'custom',
  logLevel: 'error',
  optimizeDeps: { noDiscovery: true },
  server: { middlewareMode: true },
})

const {
  PDF_FIT_GUTTER,
  clampPdfZoom,
  pdfColumnCentreScrollLeft,
  pdfFitPageZoom,
  pdfFitWidthZoom,
  pdfPageTopScrollTop,
  pdfZoomModeForZoom,
  pdfZoomStep,
} = await server.ssrLoadModule('/src/lib/pdfCamera.ts')

// --- fit factors --------------------------------------------------------------
// 1600px window: 1252px scroller, 820px page column (900px paper − 2 × 18px + border).
const wide = { viewWidth: 1252, viewHeight: 860, columnWidth: 820, pageHeight: 1176, min: 0.25, max: 5 }
assert.equal(pdfFitWidthZoom(wide), 1.483, 'fit width fills the viewport minus the gutters')
assert.equal((1252 - 2 * PDF_FIT_GUTTER) / 1.483 > 819 && (1252 - 2 * PDF_FIT_GUTTER) / 1.483 < 821, true)
assert.equal(pdfFitPageZoom(wide), 0.701, 'fit page is the tighter (height) fit')
assert.equal(pdfFitPageZoom({ ...wide, viewHeight: 4000 }), 1.483, 'a very tall viewport: fit page = fit width')
assert.equal(pdfFitWidthZoom({ ...wide, viewWidth: 952 }), 1.117, 'narrower window → smaller fit')
assert.equal(pdfFitWidthZoom({ ...wide, columnWidth: 0 }), 1, 'unmeasured column → 1')
assert.equal(pdfFitWidthZoom({ ...wide, viewWidth: 20000 }), 5, 'clamped to the zoom max')
assert.equal(pdfFitWidthZoom({ ...wide, viewWidth: 40 }), 0.25, 'clamped to the zoom min')
assert.equal(pdfFitPageZoom({ ...wide, pageHeight: 0 }), 1.483, 'no page box yet → width fit')

// --- clamp / step / mode ------------------------------------------------------
assert.equal(clampPdfZoom(1.48349, 0.25, 5), 1.483)
assert.equal(clampPdfZoom(Number.NaN, 0.25, 5), 1)
assert.equal(clampPdfZoom(9, 0.25, 5), 5)
assert.equal(pdfZoomStep(1.483, 1, 0.25, 5), 1.78, '+ is one multiplicative step, rounded to 1/100')
assert.equal(pdfZoomStep(1.78, -1, 0.25, 5), 1.48, '− undoes a + up to label rounding')
assert.equal(pdfZoomStep(4.9, 1, 0.25, 5), 5, 'never past the max')
assert.equal(pdfZoomStep(0.26, -1, 0.25, 5), 0.25, 'never below the min')
const fit = { width: 1.483, page: 0.701 }
assert.equal(pdfZoomModeForZoom(1.483, fit), 'fit-width')
assert.equal(pdfZoomModeForZoom(1.4801, fit), 'fit-width', 'within 1/1000 rounding tolerance')
assert.equal(pdfZoomModeForZoom(0.701, fit), 'fit-page')
assert.equal(pdfZoomModeForZoom(1.78, fit), 'custom')
assert.equal(pdfZoomModeForZoom(1, fit), 'custom', '100% is a custom zoom for a PDF')

// --- camera scroll after a fit -----------------------------------------------
// Column visually 1216px wide starting 18px into a 1252px scroller: already centred.
assert.equal(pdfColumnCentreScrollLeft({ clientWidth: 1252, scrollLeft: 1133 }, 300, { left: 318, width: 1216 }), 1133)
// Column starts 218px in: shift the camera right by 200px.
assert.equal(pdfColumnCentreScrollLeft({ clientWidth: 1252, scrollLeft: 1133 }, 300, { left: 518, width: 1216 }), 1333)
assert.equal(pdfColumnCentreScrollLeft({ clientWidth: 1252, scrollLeft: 100 }, 0, { left: -2000, width: 1216 }), 0, 'never negative')
assert.equal(pdfColumnCentreScrollLeft({ clientWidth: 0, scrollLeft: 7 }, 0, { left: 0, width: 0 }), 7, 'unmeasured → unchanged')
// Page top 184px above the viewport top: scroll up so it sits one gutter below it.
assert.equal(pdfPageTopScrollTop({ scrollTop: 1041 }, 100, { top: -84 }), 839)
assert.equal(pdfPageTopScrollTop({ scrollTop: 5 }, 100, { top: 90 }), 0, 'never negative')

// --- wiring ------------------------------------------------------------------
const here = dirname(fileURLToPath(import.meta.url))
const pdfView = readFileSync(join(here, '../src/components/PdfNoteView.tsx'), 'utf8')
assert.match(pdfView, /const camera = usePaperView\(\)/u, 'the PDF view reads the sheet camera')
assert.match(pdfView, /style=\{\{ width: cameraHosted \? '100%' : `\$\{Math\.round\(appliedScale \* 100\)\}%` \}\}/u, 'camera-hosted column keeps its layout width (ink is 0–1 of the paper)')
assert.match(pdfView, /if \(cam && autoFit\) \{/u, 'first open fits the column')
assert.match(pdfView, /applyCameraZoom\(measured\.width, 'fit-width', \{ pageTop: currentPageRef\.current \}\)/u, 'first open: fit width, start page at the top')
assert.match(pdfView, /if \(cam \? cam\.recalled : recallPaperView\(loadPaperViewMemory\(\), path\)\) \{/u, 'a remembered camera is never re-fitted')
assert.match(pdfView, /const derived = pdfZoomModeForZoom\(cameraZoom, fit\)/u, 'wheel/pinch/HUD zoom shows as the toolbar mode')
assert.match(pdfView, /if \(mode === 'fit-width'\) applyCameraZoom\(fit\.width, 'fit-width'\)/u, 'fit modes follow a viewport resize')
assert.match(pdfView, /\{loading && !pdf && <div className="pdf-note-status">/u, 'loading placeholder leaves the flow once the document exists')
const app = readFileSync(join(here, '../src/App.tsx'), 'utf8')
assert.match(app, /<PdfNoteView path=\{splitTab\.path\} title=\{splitTab\.title\} inputDisabled autoFit=\{false\} \/>/u, 'split pane never drives the main camera')
const paperView = readFileSync(join(here, '../src/components/PaperView.tsx'), 'utf8')
assert.match(paperView, /zoomTo: \(zoom: number, originClient\?: \{ x: number; y: number \}\) => void/u, 'camera exposes absolute zoom')
assert.match(paperView, /setRecalled\(remembered !== null\)/u, 'camera reports whether a memory came back')
const css = readFileSync(join(here, '../src/styles.css'), 'utf8')
assert.match(css, /\.unified-note-view\.is-pdf-note \.paper-sheet-plane \{\s*background: #edeff3;/u, 'one stage colour around PDF pages')

await server.close()
console.log('pdf-camera ok')
