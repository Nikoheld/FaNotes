import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

const server = await createServer({
  appType: 'custom',
  logLevel: 'error',
  optimizeDeps: { noDiscovery: true },
  server: { middlewareMode: true },
})

const {
  INLINE_INK_ACTIVE_CLASS,
  PDF_INKING_CLASS,
  WORKSHEET_INKING_CLASS,
  inkBlockedPdfSelectors,
  inkBlockedWorksheetSelectors,
  inkCoveringPaperSelectors,
  inkOverlayHitSelector,
  pointerEventsForInkLayer,
} = await server.ssrLoadModule('/src/lib/pdfInkHit.ts')
const { acceptUsableInkClient } = await server.ssrLoadModule('/src/lib/inkSampleMap.ts')

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const css = readFileSync(join(root, 'src/styles.css'), 'utf8')
const boardCss = readFileSync(join(root, 'src/components/DrawingBoard.tsx'), 'utf8')
const pdfView = readFileSync(join(root, 'src/components/PdfNoteView.tsx'), 'utf8')
const worksheet = readFileSync(join(root, 'src/components/WorksheetLayer.tsx'), 'utf8')

const selectorBlock = (source, selector) => {
  const start = source.indexOf(selector)
  assert.ok(start >= 0, `missing selector ${selector}`)
  return source.slice(start, start + 900)
}

try {
  assert.equal(pointerEventsForInkLayer('pdf-page', true), 'none')
  assert.equal(pointerEventsForInkLayer('pdf-canvas', true), 'none')
  assert.equal(pointerEventsForInkLayer('pdf-text', true), 'none')
  assert.equal(pointerEventsForInkLayer('worksheet-page', true), 'none')
  assert.equal(pointerEventsForInkLayer('overlay', true), 'auto')
  assert.equal(pointerEventsForInkLayer('overlay', false), 'none')
  assert.equal(pointerEventsForInkLayer('pdf-page', false), 'auto')

  for (const selector of inkBlockedPdfSelectors) {
    const block = selectorBlock(css, selector)
    assert.match(block, /pointer-events:\s*none/, `${selector} must drop the pen`)
  }
  for (const selector of inkBlockedWorksheetSelectors) {
    const block = selectorBlock(css, selector)
    assert.match(block, /pointer-events:\s*none/, `${selector} must drop the pen`)
  }
  for (const selector of inkCoveringPaperSelectors) {
    const block = selectorBlock(css, selector)
    assert.match(block, /height:\s*auto/, `${selector} must grow with the PDF`)
  }
  assert.match(selectorBlock(boardCss, inkOverlayHitSelector), /pointer-events:\s*auto/)

  assert.match(pdfView, new RegExp(`inputDisabled \\? ${PDF_INKING_CLASS}|inputDisabled \\? PDF_INKING_CLASS`))
  assert.match(pdfView, /PDF_INKING_CLASS/)
  assert.match(worksheet, /WORKSHEET_INKING_CLASS/)
  assert.match(boardCss, /INLINE_INK_ACTIVE_CLASS/)
  assert.equal(PDF_INKING_CLASS, 'is-inking')
  assert.equal(WORKSHEET_INKING_CLASS, 'is-disabled')
  assert.equal(INLINE_INK_ACTIVE_CLASS, 'is-input-active')

  const pdfSurface = {
    left: 48,
    top: 36,
    width: 800,
    height: 1132,
    offsetWidth: 800,
    offsetHeight: 1132,
  }
  const reportY = 0.3
  const mapped = acceptUsableInkClient({
    type: 'pointerdown',
    clientX: pdfSurface.left + 0.42 * pdfSurface.width,
    clientY: pdfSurface.top + reportY * pdfSurface.height,
    pressure: 0.5,
    pointerType: 'pen',
  }, pdfSurface)
  assert.ok(mapped, 'a pen sample on a PDF-sized box must map')
  assert.ok(Math.abs(mapped.y - reportY) < 0.02, `mapped y ${mapped.y} must stay in the report band`)
  assert.ok(mapped.y > 0.2 && mapped.y < 0.4)

  const ghost = acceptUsableInkClient({
    type: 'pointerdown',
    clientX: 0,
    clientY: 0,
    pressure: 0.4,
    pointerType: 'pen',
  }, pdfSurface)
  assert.equal(ghost, null, '0,0 stays rejected when the PDF sheet is not at the origin')

  console.log(JSON.stringify({
    reportY,
    mappedY: mapped.y,
    blocked: inkBlockedPdfSelectors.length + inkBlockedWorksheetSelectors.length,
    overlay: inkOverlayHitSelector,
  }))
  console.log('bug-pdf-pen ok')
} finally {
  await server.close()
}
