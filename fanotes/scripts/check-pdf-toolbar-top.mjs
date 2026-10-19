import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

const appRoot = fileURLToPath(new URL('..', import.meta.url))
const appSource = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')
const pdfSource = readFileSync(new URL('../src/components/PdfNoteView.tsx', import.meta.url), 'utf8')
const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8')

const server = await createServer({
  root: appRoot,
  appType: 'custom',
  logLevel: 'error',
  optimizeDeps: { noDiscovery: true },
  server: { middlewareMode: true },
})

const { INK_TOOLBAR_SLOT_ID, PDF_TOOLBAR_SLOT_ID, penModeToolbarSlot } = await server.ssrLoadModule('/src/lib/pdfInkHit.ts')

const runOnce = () => {
  assert.equal(PDF_TOOLBAR_SLOT_ID, 'fanotes-pdf-toolbar-slot')
  assert.equal(INK_TOOLBAR_SLOT_ID, 'fanotes-ink-toolbar-slot')
  assert.equal(penModeToolbarSlot(false, true), 'pdf')
  assert.equal(penModeToolbarSlot(true, true), 'ink')
  assert.match(appSource, /toolbar-context/)
  assert.match(appSource, /PDF_TOOLBAR_SLOT_ID/)
  assert.match(appSource, /penModeToolbarSlot/)
  assert.match(appSource, /pdf-toolbar-slot/)
  assert.doesNotMatch(appSource, /pdf-toolbar-hint/)
  assert.match(pdfSource, /createPortal/)
  assert.match(pdfSource, /PDF_TOOLBAR_SLOT_ID/)
  assert.match(pdfSource, /createPortal\(chrome, toolbarHost\)/)
  assert.match(pdfSource, /pdf-note-pager/)
  assert.match(pdfSource, /pdf-note-zoom/)
  assert.match(pdfSource, /Im PDF suchen/)
  assert.doesNotMatch(
    pdfSource,
    /<header className="pdf-note-toolbar">[\s\S]*<\/header>\s*\{loading &&/,
  )
  const ribbonStart = css.indexOf('.toolbar-context .pdf-note-toolbar {')
  const ribbonEnd = css.indexOf('.toolbar-group {', ribbonStart)
  assert.ok(ribbonStart >= 0 && ribbonEnd > ribbonStart)
  const ribbon = css.slice(ribbonStart, ribbonEnd)
  assert.match(ribbon, /\.toolbar-context \.pdf-note-toolbar button,[\s\S]*?background:\s*transparent/)
  assert.match(ribbon, /\.toolbar-context \.pdf-note-toolbar button\.is-active \{[\s\S]*?background:\s*var\(--panel-active\)/)
  assert.match(ribbon, /\.toolbar-context \.pdf-note-pager input,[\s\S]*?background:\s*var\(--panel\)/)
  assert.match(ribbon, /\.toolbar-context \.pdf-note-identity svg \{ color: var\(--accent-readable\)/)
  assert.doesNotMatch(ribbon, /#fff|#f1f2f6|249,\s*249,\s*252/)
}

try {
  runOnce()
  runOnce()
  console.log(JSON.stringify({
    slot: PDF_TOOLBAR_SLOT_ID,
    portal: true,
    overlayHeader: false,
  }))
  console.log('pdf-toolbar-top ok')
} finally {
  await server.close()
}
