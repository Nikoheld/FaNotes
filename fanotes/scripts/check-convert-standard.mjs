import assert from 'node:assert/strict'
import { createServer } from 'vite'

const server = await createServer({
  appType: 'custom',
  logLevel: 'error',
  optimizeDeps: { noDiscovery: true },
  server: { middlewareMode: true },
})

const { INK_MIN_INLINE_QUALITY, inkOverlayPixelSize } = await server.ssrLoadModule('/src/lib/paperGrow.ts')
const {
  CURRENT_NOTE_INK_QUALITY,
  convertNoteSourceToCurrentStandard,
  convertNoteToCurrentStandard,
  isOldPixelatedNote,
  noteInkQuality,
  noteInkStrokes,
} = await server.ssrLoadModule('/src/lib/noteStandard.ts')
const { serializeFamd } = await server.ssrLoadModule('/src/lib/famd.ts')

const markdown = '# Alte Notiz\n\nText bleibt.'
const strokes = [
  { id: 's1', color: '#111', width: 2, points: [{ x: 0.12, y: 0.34, p: 0.5 }, { x: 0.22, y: 0.44, p: 0.6 }] },
  { id: 's2', color: '#222', width: 3, points: [{ x: 0.5, y: 0.5, p: 1 }] },
]
const pageStats = {
  createdAt: '2026-01-02T10:00:00.000Z',
  modifiedAt: '2026-02-03T11:00:00.000Z',
  dwellMs: 12000,
  lastOpenedAt: '2026-02-03T11:00:00.000Z',
  openCount: 4,
}
const oldInk = {
  schemaVersion: 1,
  title: 'Handschrift',
  overlayQuality: 1,
  strokes,
}
const source = serializeFamd(markdown, {
  schema: 'fanotes-famd-v1',
  updatedAt: pageStats.modifiedAt,
  ink: oldInk,
  worksheets: ['ws-old'],
  pageStats,
})

const runOnce = () => {
  assert.ok(isOldPixelatedNote(oldInk))
  assert.ok(CURRENT_NOTE_INK_QUALITY >= INK_MIN_INLINE_QUALITY)
  const current = inkOverlayPixelSize(900, 1273, 1, true, 2)
  const old = inkOverlayPixelSize(900, 1273, 1, false, 1)
  assert.ok(current.scale > old.scale, 'current overlay quality must be sharper than old 1× paint')

  const converted = convertNoteToCurrentStandard({
    markdown,
    ink: oldInk,
    worksheets: ['ws-old'],
    pageStats,
  })
  assert.deepEqual(noteInkStrokes(converted.ink), strokes)
  assert.equal(converted.markdown, markdown)
  assert.deepEqual(converted.worksheets, ['ws-old'])
  assert.deepEqual(converted.pageStats, pageStats)
  assert.ok(noteInkQuality(converted.ink) >= INK_MIN_INLINE_QUALITY - 1e-6)

  let dropped = false
  try {
    convertNoteToCurrentStandard({
      markdown,
      ink: oldInk,
      worksheets: ['ws-old'],
      pageStats,
    }, (note) => ({
      ...note,
      ink: { ...note.ink, strokes: noteInkStrokes(note.ink).slice(0, 1) },
    }))
  } catch (error) {
    dropped = /stroke/i.test(error instanceof Error ? error.message : String(error))
  }
  assert.equal(dropped, true, 'a dropping apply must fail the convert')

  const fromSource = convertNoteSourceToCurrentStandard(source)
  assert.equal(fromSource.converted, true)
  assert.equal(fromSource.note.markdown, markdown)
  assert.deepEqual(noteInkStrokes(fromSource.note.ink), strokes)
  assert.deepEqual(fromSource.note.pageStats, pageStats)
  return {
    strokes: noteInkStrokes(converted.ink).length,
    quality: noteInkQuality(converted.ink),
    droppedApplyFails: dropped,
  }
}

try {
  const first = runOnce()
  const second = runOnce()
  assert.deepEqual(first, second)
  console.log(JSON.stringify(first))
  console.log('convert-standard ok')
} finally {
  await server.close()
}
