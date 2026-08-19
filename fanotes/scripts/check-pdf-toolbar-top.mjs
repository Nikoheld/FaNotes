import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

const appRoot = fileURLToPath(new URL('..', import.meta.url))
const appSource = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')
const pdfSource = readFileSync(new URL('../src/components/PdfNoteView.tsx', import.meta.url), 'utf8')

const server = await createServer({
  root: appRoot,
  appType: 'custom',
  logLevel: 'error',
  optimizeDeps: { noDiscovery: true },
  server: { middlewareMode: true },
})

const { PDF_TOOLBAR_SLOT_ID } = await server.ssrLoadModule('/src/lib/pdfInkHit.ts')

const runOnce = () => {
  assert.equal(PDF_TOOLBAR_SLOT_ID, 'fanotes-pdf-toolbar-slot')
  assert.match(appSource, /toolbar-context/)
  assert.match(appSource, /PDF_TOOLBAR_SLOT_ID/)
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
