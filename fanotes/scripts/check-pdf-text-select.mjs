import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import { pdfjsAssetPath } from './pdfjs-assets-plugin.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const server = await createServer({
  appType: 'custom',
  logLevel: 'error',
  optimizeDeps: { noDiscovery: true },
  server: { middlewareMode: true },
})

const {
  applyPdfTextOverlayScale,
  pdfJsSupportUrls,
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
  assert.match(css, /\.pdf-note-text-layer :is\(span, br\) \{[\s\S]*?color:\s*transparent/)
  const selectionStart = css.indexOf('.pdf-note-text-layer ::selection')
  assert.ok(selectionStart >= 0, 'missing .pdf-note-text-layer ::selection')
  const selectionBlock = css.slice(selectionStart, selectionStart + 280)
  assert.match(selectionBlock, /color:\s*transparent/, '::selection must keep overlay glyphs invisible (not global selection color)')
  assert.match(selectionBlock, /background:/)
  assert.match(css, /\.pdf-note-text-layer br::selection \{[^}]*background:\s*transparent/)
  assert.match(css, /user-select:\s*text/)
  assert.match(css, /\[data-main-rotation="90"\]/)

  const pageStart = css.indexOf('.pdf-note-page {')
  const pageBlock = css.slice(pageStart, pageStart + 700)
  assert.doesNotMatch(pageBlock, /contain:\s*layout paint style/)
  assert.match(css, /\.pdf-note-page\.is-visible \{[^}]*contain:\s*none/)
  assert.match(css, /\.pdf-note-page\.is-visible \{[^}]*content-visibility:\s*visible/)

  assert.match(board, /applyPdfTextOverlayScale/)
  assert.match(board, /getViewport\(\{ scale: overlayScale, rotation: used \}\)/)
  assert.match(board, /includeMarkedContent: true/)
  assert.match(board, /disableNormalization: true/)
  assert.match(board, /textHost\.style\.width = '100%'/)
  assert.match(board, /bindPdfTextSelection\(textHost\)/)
  assert.match(css, /\.pdf-note-text-layer \.endOfContent \{[^}]*user-select:\s*none/)
  assert.match(css, /\.pdf-note-text-layer\.selecting \.endOfContent \{[^}]*top:\s*0/)
  assert.match(css, /\.pdf-note-text-layer :is\(span, br\) \{[\s\S]*?z-index:\s*1/)
  const support = pdfJsSupportUrls('file:///opt/fanotes/dist/index.html')
  assert.equal(support.cMapUrl, 'file:///opt/fanotes/dist/pdfjs/cmaps/')
  assert.equal(support.standardFontDataUrl, 'file:///opt/fanotes/dist/pdfjs/standard_fonts/')
  assert.equal(support.wasmUrl, 'file:///opt/fanotes/dist/pdfjs/wasm/')
  assert.equal(support.iccUrl, 'file:///opt/fanotes/dist/pdfjs/iccs/')
  for (const href of Object.values(support)) assert.ok(href.endsWith('/'))
  const devSupport = pdfJsSupportUrls('http://127.0.0.1:5174/')
  assert.equal(devSupport.cMapUrl, 'http://127.0.0.1:5174/pdfjs/cmaps/')

  const documentSource = readFileSync(join(root, 'src/lib/pdfDocument.ts'), 'utf8')
  const worksheetSource = readFileSync(join(root, 'src/components/WorksheetLayer.tsx'), 'utf8')
  for (const source of [documentSource, worksheetSource]) {
    assert.match(source, /pdfJsDocumentOptions\(\)/)
    assert.match(source, /getDocument\(\{/)
  }
  assert.match(documentSource, /pdfJsDirectoryUrl\(root, 'cmaps'\)/)
  assert.match(documentSource, /pdfJsDirectoryUrl\(root, 'standard_fonts'\)/)
  assert.match(documentSource, /pdfJsDirectoryUrl\(root, 'wasm'\)/)
  assert.match(documentSource, /pdfJsDirectoryUrl\(root, 'iccs'\)/)
  assert.match(readFileSync(join(root, 'vite.config.ts'), 'utf8'), /pdfjsAssetsPlugin\(\)/)

  const packageRoot = join(root, 'node_modules/pdfjs-dist')
  assert.ok(existsSync(join(packageRoot, 'cmaps/78-EUC-H.bcmap')))
  assert.ok(existsSync(join(packageRoot, 'standard_fonts/LiberationSans-Regular.ttf')))
  assert.ok(existsSync(join(packageRoot, 'wasm/openjpeg.wasm')))
  assert.ok(existsSync(join(packageRoot, 'wasm/jbig2.wasm')))
  assert.ok(existsSync(join(packageRoot, 'iccs/CGATS001Compat-v2-micro.icc')))
  assert.equal(
    pdfjsAssetPath('/pdfjs/cmaps/78-EUC-H.bcmap', packageRoot),
    join(packageRoot, 'cmaps/78-EUC-H.bcmap'),
  )
  assert.equal(pdfjsAssetPath('/pdfjs/cmaps/../wasm/openjpeg.wasm', packageRoot), null)
  assert.equal(pdfjsAssetPath('/pdfjs/secret/openjpeg.wasm', packageRoot), null)

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
