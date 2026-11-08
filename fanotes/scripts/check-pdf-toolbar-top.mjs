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
const {
  PDF_THUMBNAIL_ROOT_MARGIN,
  enqueuePdfRender,
  pdfThumbnailRailScrollTop,
} = await server.ssrLoadModule('/src/lib/pdfDocument.ts')

/**
 * Opening the thumbnail rail queued every thumbnail ahead of the page the
 * reader jumps to next. A page now runs before any thumbnail still waiting,
 * one render at a time, and a failed job does not stop the queue.
 */
const checkRenderLanes = async () => {
  const order = []
  let running = 0
  let overlap = false
  const job = (name, ms = 2) => async () => {
    running += 1
    if (running > 1) overlap = true
    order.push(name)
    await new Promise((resolve) => setTimeout(resolve, ms))
    running -= 1
    return name
  }
  const thumbs = [1, 2, 3, 4].map((n) => enqueuePdfRender(job(`thumb ${n}`), 'thumbnail'))
  let startedInCall = false
  const first = enqueuePdfRender(async () => { startedInCall = true; return 'page 1' })
  assert.equal(startedInCall, false, 'a queued render never starts inside the call that queued it')
  await new Promise((resolve) => setTimeout(resolve, 1))
  const later = enqueuePdfRender(job('page 40'))
  const failed = enqueuePdfRender(async () => { throw new Error('bad page') })
  assert.equal(await first, 'page 1')
  assert.equal(await later, 'page 40')
  await assert.rejects(failed, /bad page/)
  assert.deepEqual(await Promise.all(thumbs), ['thumb 1', 'thumb 2', 'thumb 3', 'thumb 4'])
  assert.ok(order.indexOf('page 40') < order.indexOf('thumb 3'), `a page queued behind the rail runs first: ${order.join(', ')}`)
  assert.equal(order.at(-1), 'thumb 4', 'the thumbnails still all run')
  assert.equal(overlap, false, 'renders stay one at a time')
  assert.match(pdfSource, /\}, 'thumbnail'\)\.catch\(/, 'thumbnails queue behind the pages')
}

/** Every page has a thumbnail, painted near the rail's view; the current one is scrolled into the rail. */
const checkThumbnailRail = () => {
  assert.doesNotMatch(pdfSource, /Math\.min\(pdf\.numPages, 80\)/, 'pages past 80 have thumbnails')
  assert.doesNotMatch(pdfSource, /Erste \{thumbs\.length\} Seiten/)
  assert.match(pdfSource, /rootMargin: PDF_THUMBNAIL_ROOT_MARGIN/)
  assert.match(PDF_THUMBNAIL_ROOT_MARGIN, /^\d+px 0px$/)
  const thumb = pdfSource.slice(pdfSource.indexOf('const Thumbnail = memo('), pdfSource.indexOf('async function outlineFromPdf('))
  assert.match(thumb, /canvas\.width = 0\n\s+canvas\.height = 0/, 'a far thumbnail lets its bitmap go')
  assert.match(thumb, /canvas\.style\.height = `\$\{thumbnailCssHeight\(1, ratio\)\}px`/, 'an unpainted thumbnail keeps the page shape')
  assert.doesNotMatch(pdfSource, /data-pdf-thumb[\s\S]{0,400}scrollIntoView/, 'the rail scrolls itself, not the page column')
  assert.equal(pdfThumbnailRailScrollTop(0, 600, 120, 130), null)
  assert.equal(pdfThumbnailRailScrollTop(500, 600, 500, 130), null)
  assert.equal(pdfThumbnailRailScrollTop(0, 600, 1990, 130), 1520)
  assert.equal(pdfThumbnailRailScrollTop(4000, 600, 260, 130), 260)
  assert.equal(pdfThumbnailRailScrollTop(0, 600, 540, 130), 70)
  assert.equal(pdfThumbnailRailScrollTop(0, 100, 540, 130), 540)
  assert.equal(pdfThumbnailRailScrollTop(0, 0, 540, 130), null)
  assert.equal(pdfThumbnailRailScrollTop(0, 600, Number.NaN, 130), null)
}

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
  await checkRenderLanes()
  checkThumbnailRail()
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
