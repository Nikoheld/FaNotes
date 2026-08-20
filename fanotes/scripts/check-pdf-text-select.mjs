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
  applyPdfTextOverlayScale,
  pdfTextOverlayCssVars,
  pdfTextOverlayScale,
} = await server.ssrLoadModule('/src/lib/pdfDocument.ts')
const { pointerEventsForInkLayer } = await server.ssrLoadModule('/src/lib/pdfInkHit.ts')

const runOnce = () => {
  const cssWidth = 800
  const pageWidth = 595.28
  const scale = pdfTextOverlayScale(cssWidth, pageWidth)
  assert.equal(scale, cssWidth / pageWidth)
  assert.ok(scale > 1, 'an 800px box on an A4 PDF page is larger than 1 user unit')

  const rotatedPageWidth = 841.89
  assert.equal(
    pdfTextOverlayScale(cssWidth, rotatedPageWidth),
    cssWidth / rotatedPageWidth,
  )

  const vars = pdfTextOverlayCssVars(scale)
  assert.equal(vars['--scale-factor'], String(scale))
  assert.equal(vars['--total-scale-factor'], String(scale))
  assert.equal(vars['--user-unit'], '1')
  assert.equal(vars['--scale-round-x'], '1px')
  assert.equal(vars['--scale-round-y'], '1px')

  const props = new Map()
  const overlayScale = applyPdfTextOverlayScale(
    { style: { setProperty: (name, value) => { props.set(name, value) } } },
    cssWidth,
    pageWidth,
  )
  assert.equal(overlayScale, scale)
  assert.equal(props.get('--scale-factor'), String(scale))
  assert.equal(props.get('--total-scale-factor'), String(scale))

  const dprBitmap = 1400
  assert.notEqual(pdfTextOverlayScale(cssWidth, pageWidth), dprBitmap / pageWidth)

  const css = readFileSync(join(root, 'src/styles.css'), 'utf8')
  const board = readFileSync(join(root, 'src/components/PdfNoteView.tsx'), 'utf8')
  const layerStart = css.indexOf('.pdf-note-text-layer {')
  assert.ok(layerStart >= 0)
  const layerBlock = css.slice(layerStart, layerStart + 1400)
  assert.match(layerBlock, /--total-scale-factor:\s*calc\(\s*var\(--scale-factor\)\s*\*\s*var\(--user-unit\)\s*\)/)
  assert.match(layerBlock, /transform-origin:\s*0 0/)
  assert.match(layerBlock, /pointer-events:\s*auto/)
  assert.match(css, /font-size:\s*calc\(\s*var\(--text-scale-factor\)\s*\*\s*var\(--font-height\)\s*\)/)
  assert.match(css, /transform:\s*rotate\(var\(--rotate\)\)\s*scaleX\(var\(--scale-x\)\)/)
  assert.match(css, /white-space:\s*pre/)
  assert.match(css, /color:\s*transparent/)
  assert.match(css, /\.pdf-note-text-layer ::selection/)
  assert.match(css, /user-select:\s*text/)
  assert.match(css, /\[data-main-rotation="90"\]/)

  const pageStart = css.indexOf('.pdf-note-page {')
  const pageBlock = css.slice(pageStart, pageStart + 700)
  assert.doesNotMatch(pageBlock, /contain:\s*layout paint style/)
  assert.match(css, /\.pdf-note-page\.is-visible \{[^}]*contain:\s*none/)
  assert.match(css, /\.pdf-note-page\.is-visible \{[^}]*content-visibility:\s*visible/)

  assert.match(board, /applyPdfTextOverlayScale/)
  assert.match(board, /getViewport\(\{ scale: overlayScale, rotation \}\)/)
  assert.equal(pointerEventsForInkLayer('pdf-text', false), 'auto')
  assert.equal(pointerEventsForInkLayer('pdf-text', true), 'none')
  const inking = css.slice(css.indexOf('.pdf-note-view.is-inking,'), css.indexOf('.pdf-note-view.is-inking,') + 900)
  assert.match(inking, /pointer-events:\s*none/)

  return {
    scale,
    total: vars['--total-scale-factor'],
    cssWidth,
    pageWidth,
    notBitmap: true,
  }
}

try {
  const first = runOnce()
  const second = runOnce()
  assert.deepEqual(first, second)
  console.log(JSON.stringify(first))
  console.log('pdf-text-select ok')
} finally {
  await server.close()
}
