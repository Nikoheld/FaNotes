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
  PDF_PAGE_COLUMN_MAX,
  pdfPageColumnCssWidth,
  pdfTextOverlayScale,
  pdfTextOverlayScaleForPaper,
} = await server.ssrLoadModule('/src/lib/pdfDocument.ts')
const {
  pdfOverlaySourceHeight,
  shouldSyncPdfOverlaySource,
  pointerEventsForInkLayer,
} = await server.ssrLoadModule('/src/lib/pdfInkHit.ts')
const {
  PAPER_SOURCE_HEIGHT,
  PAPER_SOURCE_WIDTH,
  inkExtentStyleValues,
} = await server.ssrLoadModule('/src/lib/paperGrow.ts')

const runOnce = () => {
  const paperClient = 2020
  const paintedH = 2200
  const pageWidth = 595.28
  const column = pdfPageColumnCssWidth(paperClient)
  assert.equal(column, PDF_PAGE_COLUMN_MAX)
  assert.equal(pdfPageColumnCssWidth(800), 800)
  const scale = pdfTextOverlayScaleForPaper(paperClient, pageWidth)
  assert.equal(scale, pdfTextOverlayScale(column, pageWidth))
  assert.notEqual(scale, pdfTextOverlayScale(paperClient, pageWidth), 'must not scale glyphs to the grown plane')

  const overlayH = pdfOverlaySourceHeight(PAPER_SOURCE_WIDTH, paperClient, paintedH)
  assert.equal(shouldSyncPdfOverlaySource(PAPER_SOURCE_HEIGHT, overlayH), true)
  const styles = inkExtentStyleValues(overlayH, PAPER_SOURCE_WIDTH, paperClient)
  const grownPaper = Math.max(paperClient, PAPER_SOURCE_WIDTH * styles.widthExtent)
  assert.equal(pdfPageColumnCssWidth(grownPaper), column)
  assert.equal(pdfTextOverlayScaleForPaper(grownPaper, pageWidth), scale)

  const css = readFileSync(join(root, 'src/styles.css'), 'utf8')
  const pdfView = readFileSync(join(root, 'src/components/PdfNoteView.tsx'), 'utf8')
  const board = readFileSync(join(root, 'src/components/DrawingBoard.tsx'), 'utf8')

  assert.doesNotMatch(pdfView, /textEnabled=\{!inputDisabled\}/)
  assert.match(pdfView, /textEnabled\n\s+highlight=/)
  assert.doesNotMatch(pdfView, /textEnabled \? 1 : 0/)
  assert.doesNotMatch(pdfView, /else if \(textHost\) \{\s*textHost\.replaceChildren\(\)/)
  assert.match(pdfView, /textEnabled \|\| textHost\.childElementCount > 0/)
  assert.match(pdfView, /style\.removeProperty\('width'\)/)
  assert.equal(pointerEventsForInkLayer('pdf-text', true), 'none')
  assert.equal(pointerEventsForInkLayer('pdf-text', false), 'auto')

  const pageStart = css.indexOf('.pdf-note-page {')
  const pageBlock = css.slice(pageStart, pageStart + 700)
  assert.match(pageBlock, /overflow:\s*hidden/)
  assert.match(css, /\.pdf-note-page\.is-visible \{[^}]*content-visibility:\s*visible/)
  assert.match(css, /\.pdf-note-page\.is-visible \{[^}]*contain:\s*none/)
  assert.match(css, /\.pdf-note-page canvas \{[^}]*width:\s*100%/)
  assert.match(css, /\.pdf-note-page canvas \{[^}]*height:\s*100%/)
  const bodyStart = css.indexOf('.pdf-note-body {')
  const bodyBlock = css.slice(bodyStart, css.indexOf('.pdf-note-pages {'))
  assert.match(bodyBlock, /max-width:\s*var\(--paper-width, 900px\)/)
  assert.match(bodyBlock, /width:\s*min\(100%, var\(--paper-width, 900px\)\)/)
  assert.doesNotMatch(bodyBlock, /980px/)
  const inking = css.slice(css.indexOf('.pdf-note-view.is-inking,'), css.indexOf('.pdf-note-view.is-inking,') + 900)
  assert.match(inking, /pointer-events:\s*none/)
  assert.match(board, /shouldSyncPdfOverlaySource/)
  assert.match(board, /is-pdf-note/)

  return {
    column,
    scale,
    overlayH,
    grownPaper,
    scaleAfterGrow: pdfTextOverlayScaleForPaper(grownPaper, pageWidth),
  }
}

try {
  const first = runOnce()
  const second = runOnce()
  assert.deepEqual(first, second)
  console.log(JSON.stringify(first))
  console.log('pdf-text-while-write ok')
} finally {
  await server.close()
}
