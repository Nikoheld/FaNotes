import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createServer } from 'vite'

const server = await createServer({
  appType: 'custom',
  logLevel: 'error',
  optimizeDeps: { noDiscovery: true },
  server: { middlewareMode: true },
})

const {
  activateNoteLink,
  noteLinkPageAtPoint,
  noteLinkPageHost,
  placeNewNoteLink,
} = await server.ssrLoadModule('/src/lib/noteLink.ts')
const { emptyFamdPayload, parseFamd, serializeFamd } = await server.ssrLoadModule('/src/lib/famd.ts')
const layerSource = readFileSync(new URL('../src/components/NoteLinkLayer.tsx', import.meta.url), 'utf8')

const rect = (left, top, width, height) => ({
  left,
  top,
  width,
  height,
  right: left + width,
  bottom: top + height,
})

const runOnce = () => {
  const markdownSource = 'Faecher/Mechanik.md'
  const pdfSource = 'Faecher/Skript.pdf'
  const markdownTarget = 'Faecher/Mechanik · Notiz.md'
  const pdfTarget = 'Faecher/Skript · Notiz.md'

  const page1Rect = rect(40, 80, 800, 1130)
  const page3Rect = rect(40, 2480, 800, 1130)
  const paperRect = rect(20, 40, 840, 3700)
  const page1 = {
    dataset: { pdfPage: '1' },
    getAttribute: (name) => name === 'data-pdf-page' ? '1' : null,
    getBoundingClientRect: () => page1Rect,
  }
  const page3 = {
    dataset: { pdfPage: '3' },
    getAttribute: (name) => name === 'data-pdf-page' ? '3' : null,
    getBoundingClientRect: () => page3Rect,
  }
  const paper = {
    querySelectorAll: (selector) => selector === '[data-pdf-page]' ? [page1, page3] : [],
    getBoundingClientRect: () => paperRect,
    closest: (selector) => selector === '.unified-paper' ? paper : null,
  }
  const overlay = {
    querySelectorAll: () => [],
    getBoundingClientRect: () => paperRect,
    closest: (selector) => selector === '.unified-paper' ? paper : null,
  }

  assert.equal(noteLinkPageHost(overlay), paper)
  assert.equal(overlay.querySelectorAll('[data-pdf-page]').length, 0, 'overlay itself has no page descendants')

  const clickX = page3Rect.left + 0.81 * page3Rect.width
  const clickY = page3Rect.top + 0.17 * page3Rect.height
  const pdfHit = noteLinkPageAtPoint(clickX, clickY, overlay)
  assert.equal(pdfHit.page, 3)
  assert.notEqual(pdfHit.page, 1)
  assert.ok(Math.abs(pdfHit.x - 0.81) < 1e-9, `page-relative x ${pdfHit.x} must be 0.81, not whole-paper`)
  assert.ok(Math.abs(pdfHit.y - 0.17) < 1e-9, `page-relative y ${pdfHit.y} must be 0.17`)
  const wholePaper = { x: (clickX - paperRect.left) / paperRect.width, y: (clickY - paperRect.top) / paperRect.height }
  assert.notEqual(Math.round(pdfHit.y * 1000), Math.round(wholePaper.y * 1000))

  const markdownPaper = {
    querySelectorAll: () => [],
    getBoundingClientRect: () => paperRect,
    closest: (selector) => selector === '.unified-paper' ? markdownPaper : null,
  }
  const markdownOverlay = {
    querySelectorAll: () => [],
    getBoundingClientRect: () => paperRect,
    closest: (selector) => selector === '.unified-paper' ? markdownPaper : null,
  }
  const mdHit = noteLinkPageAtPoint(paperRect.left + 0.22 * paperRect.width, paperRect.top + 0.41 * paperRect.height, markdownOverlay)
  assert.equal(mdHit.page, 1)
  assert.ok(Math.abs(mdHit.x - 0.22) < 1e-9)
  assert.ok(Math.abs(mdHit.y - 0.41) < 1e-9)

  assert.match(layerSource, /noteLinkPageAtPoint/)
  assert.doesNotMatch(layerSource, /querySelectorAll<HTMLElement>\('\[data-pdf-page\]'\)/)

  const markdownLink = placeNewNoteLink({
    sourcePath: markdownSource,
    page: mdHit.page,
    x: mdHit.x,
    y: mdHit.y,
    style: 'symbol',
    id: 'nl-md-place',
  }, { targetPath: markdownTarget })

  const pdfLink = placeNewNoteLink({
    sourcePath: pdfSource,
    page: pdfHit.page,
    x: pdfHit.x,
    y: pdfHit.y,
    style: 'text',
    id: 'nl-pdf-place',
  }, { targetPath: pdfTarget })

  assert.equal(markdownLink.sourcePath, markdownSource)
  assert.equal(markdownLink.page, 1)
  assert.equal(markdownLink.x, 0.22)
  assert.equal(markdownLink.y, 0.41)
  assert.equal(markdownLink.style, 'symbol')
  assert.equal(activateNoteLink(markdownLink), markdownTarget)
  assert.notEqual(activateNoteLink(markdownLink), markdownSource)
  assert.match(activateNoteLink(markdownLink), /\.md$/u)

  assert.equal(pdfLink.page, 3)
  assert.notEqual(pdfLink.page, 1)
  assert.equal(pdfLink.style, 'text')
  assert.equal(activateNoteLink(pdfLink), pdfTarget)
  assert.notEqual(pdfLink.targetPath, pdfSource)

  const encoded = serializeFamd('# Mechanik', {
    ...emptyFamdPayload('2026-08-19T12:00:00.000Z'),
    noteLinks: [markdownLink, pdfLink],
  })
  const parsed = parseFamd(encoded)
  assert.equal(parsed.payload?.noteLinks?.length, 2)
  const restoredMd = parsed.payload.noteLinks.find((link) => link.id === 'nl-md-place')
  const restoredPdf = parsed.payload.noteLinks.find((link) => link.id === 'nl-pdf-place')
  assert.equal(restoredMd.targetPath, markdownTarget)
  assert.equal(restoredMd.style, 'symbol')
  assert.equal(restoredMd.x, 0.22)
  assert.equal(restoredMd.y, 0.41)
  assert.equal(restoredPdf.targetPath, pdfTarget)
  assert.equal(restoredPdf.style, 'text')
  assert.equal(restoredPdf.page, 3)
  assert.equal(restoredPdf.x, 0.81)
  assert.equal(activateNoteLink(restoredPdf), pdfTarget)

  return {
    markdownTarget: activateNoteLink(markdownLink),
    pdfPage: restoredPdf.page,
    pdfX: restoredPdf.x,
    pdfY: restoredPdf.y,
    styles: [restoredMd.style, restoredPdf.style],
  }
}

try {
  const first = runOnce()
  const second = runOnce()
  assert.deepEqual(first, second)
  console.log(JSON.stringify(first))
  console.log('note-link-place ok')
} finally {
  await server.close()
}
