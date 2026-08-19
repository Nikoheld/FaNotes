import assert from 'node:assert/strict'
import { createServer } from 'vite'

const server = await createServer({
  appType: 'custom',
  logLevel: 'error',
  optimizeDeps: { noDiscovery: true },
  server: { middlewareMode: true },
})

const {
  activateNoteLink,
  placeNewNoteLink,
} = await server.ssrLoadModule('/src/lib/noteLink.ts')
const { emptyFamdPayload, parseFamd, serializeFamd } = await server.ssrLoadModule('/src/lib/famd.ts')

const runOnce = () => {
  const markdownSource = 'Faecher/Mechanik.md'
  const pdfSource = 'Faecher/Skript.pdf'
  const markdownTarget = 'Faecher/Mechanik · Notiz.md'
  const pdfTarget = 'Faecher/Skript · Notiz.md'

  const markdownLink = placeNewNoteLink({
    sourcePath: markdownSource,
    page: 1,
    x: 0.22,
    y: 0.41,
    style: 'symbol',
    id: 'nl-md-place',
  }, { targetPath: markdownTarget })

  const pdfLink = placeNewNoteLink({
    sourcePath: pdfSource,
    page: 3,
    x: 0.81,
    y: 0.17,
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
