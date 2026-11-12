// An empty handwriting page never replaces stored ink it did not load.
//
// Production: pairs of files collapsed within a second — the drawing record
// `.fanotes/assets/<id>.json` (7.6 MB → 481 B) and the note's `.famd`
// (3.5 MB → 726 B). Both are what one save of an inline board with zero
// strokes writes under the note's real ink id: a board that was still
// restoring a heavy page (or failed to read it) when a note switch, the app
// closing, or an autosave flushed it.
//
//   1. DrawingBoard: no save path writes while the stored page is pending,
//      restoring, or unreadable; an unreadable page stays read-only.
//   2. Main `saveDrawing`: an empty page without an undo/redo step is not
//      written over a record or companion that still has strokes. Nothing is
//      written to either file, and the renderer gets the usual result.
//   3. Opening a note whose `.famd` holds such an empty page while the
//      record still has strokes opens the record. Nothing is written.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const guard = require('../electron/ink-save-guard.cjs')
const famd = require('../electron/famd.cjs')
const { INK_PACK_POINTS } = await import('../electron/famdPack.mjs')

const section = (source, start, end, label) => {
  const from = source.indexOf(start)
  assert.ok(from >= 0, `${label}: missing ${start}`)
  const to = source.indexOf(end, from + start.length)
  assert.ok(to > from, `${label}: missing ${end}`)
  return source.slice(from, to)
}

// ── Fixtures: the documents a board really sends ───────────────────────────
const INK_ID = '3f1c2b9e-8d7a-4c1e-9f0b-2a6d5e4c3b21'
const BODY = `# Physik\n\n<!-- fanotes-ink:${INK_ID} -->`
let strokeSerial = 0
const stroke = (x, points = 2) => {
  strokeSerial += 1
  return {
    id: `stroke-${strokeSerial}`,
    color: '#1f2937',
    baseWidth: 2.4,
    points: Array.from({ length: points }, (_, index) => ({ x: x + index * 1e-5, y: 0.2, t: index, pressure: 0.5, pointerType: 'pen' })),
  }
}
// Key order and fields of DrawingBoard `drawingPayload` for an empty board.
const page = (extra = {}) => ({
  schemaVersion: 1,
  title: 'Handschrift · Physik',
  paperStyle: 'dots',
  sourceWidth: 900,
  sourceHeight: 1273,
  sourceOriginX: 0,
  sourceOriginY: 0,
  overlayQuality: 1.75,
  overlayQualityZoom: 6,
  createdAt: '2026-11-08T21:07:20.000Z',
  updatedAt: '2026-11-08T21:07:22.123Z',
  strokes: [],
  searchTranscript: '',
  transcriptMode: 'text-and-math',
  recognitionPreference: 'auto',
  detectedRecognitionMode: 'text',
  mathSolverEnabled: false,
  mathSolverHistory: [],
  ...extra,
})
const skeleton = page()
const inked = page({ strokes: [stroke(0.1), stroke(0.3)], searchTranscript: 'Kraft ist Masse mal Beschleunigung' })
const morePen = page({ strokes: [stroke(0.1), stroke(0.3), stroke(0.5)] })
// clear() and an erase push an undo snapshot; encodeInkHistory keeps the erased strokes as extras.
const cleared = page({ inkHistory: { extras: inked.strokes, undo: [[{ extra: 0 }, { extra: 1 }]], redo: [] } })
// Undo of the only stroke: the undo stack is empty, the redo stack is not.
const undone = page({ inkHistory: { extras: [stroke(0.2)], undo: [], redo: [[{ extra: 0 }]] } })
// Collapse resets the history; the strokes live in a collapsed subsection's body.
const nestedCollapsed = page({
  sections: [{
    id: 'a', top: 0.1, bodyTop: 0.2, collapsed: true,
    hidden: {
      widthPx: 900, heightPx: 300, strokes: [],
      sections: [{ id: 'b', parentId: 'a', top: 0.3, bodyTop: 0.35, collapsed: true, hidden: { widthPx: 900, heightPx: 100, strokes: [stroke(0.5)], sections: [] } }],
    },
  }],
})
const companionOf = (ink, encoding = 'v2') => famd.serializeFamd(BODY, {
  schema: 'fanotes-famd-v1',
  updatedAt: '2026-10-01T08:00:00.000Z',
  worksheets: [],
  paperStyle: 'dots',
  pageStats: { createdAt: '2026-09-01T07:12:44.987Z', modifiedAt: '2026-11-08T21:00:00.000Z', lastOpenedAt: '2026-11-08T21:06:00.000Z', dwellMs: 123456, openCount: 41 },
  ink,
}, encoding)

// ── 2. Main saveDrawing: the guard against real files ──────────────────────
// `saveLikeMain` follows the handler in electron/main.cjs: read both files as
// `storedInkTexts` does, ask `refusesEmptyInkSave`, and only then write the
// record and compose the companion with the real `composeFamdCompanion`.
// The order inside the handler itself is asserted further down.
const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'fanotes-empty-ink-'))
const recordPath = path.join(vault, '.fanotes', 'assets', `${INK_ID}.json`)
const companionPath = path.join(vault, 'Physik.famd')
fs.mkdirSync(path.dirname(recordPath), { recursive: true })

const readStored = (file) => {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch (error) {
    return error?.code === 'ENOENT' ? null : undefined
  }
}
const put = (file, text) => {
  if (text === null) fs.rmSync(file, { force: true })
  else fs.writeFileSync(file, text)
}
const saveLikeMain = (document) => {
  const drawingJson = JSON.stringify(document)
  const large = drawingJson.length >= famd.FAMD_ASYNC_CHARS
  const refused = guard.refusesEmptyInkSave({
    document,
    large,
    ...(guard.isUnexplainedEmptyPage(document) ? { recordText: readStored(recordPath), companionText: readStored(companionPath) } : {}),
  })
  if (refused) return { refused: true }
  fs.writeFileSync(recordPath, drawingJson)
  fs.writeFileSync(companionPath, famd.composeFamdCompanion(readStored(companionPath), BODY, JSON.parse(drawingJson), 'dots'))
  return { refused: false }
}
const snapshot = () => [readStored(recordPath), readStored(companionPath)]

const results = {}
try {
  // Skeleton over an inked record and companion (v2 and v1): refused, both files byte-identical.
  for (const encoding of ['v2', 'v1']) {
    put(recordPath, JSON.stringify(inked))
    put(companionPath, companionOf(inked, encoding))
    const before = snapshot()
    const outcome = saveLikeMain(skeleton)
    assert.equal(outcome.refused, true, `skeleton over inked ${encoding} note must be refused`)
    assert.deepEqual(snapshot(), before, `refused ${encoding} save must leave record and companion byte-identical`)
  }
  results.skeletonOverInk = 'refused, files unchanged'

  // Only one of the two still has strokes: still refused.
  put(recordPath, JSON.stringify(skeleton))
  put(companionPath, companionOf(inked))
  assert.equal(saveLikeMain(skeleton).refused, true, 'companion with strokes keeps the page')
  put(recordPath, JSON.stringify(inked))
  put(companionPath, famd.composeFamdCompanion(companionOf(inked), BODY, skeleton, 'dots'))
  assert.equal(saveLikeMain(skeleton).refused, true, 'record with strokes keeps the page')
  put(recordPath, null)
  put(companionPath, companionOf(inked))
  assert.equal(saveLikeMain(skeleton).refused, true, 'companion with strokes and no record keeps the page')

  // Strokes only in a collapsed subsection (deeper than famd.cjs inkHasMarks looks).
  assert.equal(famd.inkHasMarks(nestedCollapsed), false, 'fixture: famd.cjs inkHasMarks misses a subsection body')
  assert.equal(guard.pageHasStrokes(nestedCollapsed), true)
  put(recordPath, JSON.stringify(nestedCollapsed))
  put(companionPath, companionOf(nestedCollapsed))
  assert.equal(saveLikeMain(skeleton).refused, true, 'ink in a collapsed subsection is stored ink')
  put(recordPath, JSON.stringify(inked))
  put(companionPath, companionOf(inked))
  assert.equal(saveLikeMain(nestedCollapsed).refused, false, 'a page whose ink is all collapsed is not empty')

  // An unreadable or truncated companion is kept.
  put(recordPath, null)
  const full = companionOf(inked)
  put(companionPath, full.slice(0, full.length - 40))
  assert.equal(guard.companionTextHasInk(readStored(companionPath)), true)
  assert.equal(saveLikeMain(skeleton).refused, true, 'a truncated companion is never replaced by an empty page')
  assert.equal(guard.refusesEmptyInkSave({ document: skeleton, recordText: undefined, companionText: null }), true, 'an unreadable record is kept')
  results.partialAndUnreadable = 'refused'

  // Deliberate clear (inkHistory undo step) over ink: written.
  put(recordPath, JSON.stringify(inked))
  put(companionPath, companionOf(inked))
  assert.equal(saveLikeMain(cleared).refused, false, 'clear() / erase-all must be written')
  assert.equal(JSON.parse(readStored(recordPath)).strokes.length, 0)
  assert.equal(guard.companionTextHasInk(readStored(companionPath)), false)
  put(recordPath, JSON.stringify(inked))
  put(companionPath, companionOf(inked))
  assert.equal(saveLikeMain(undone).refused, false, 'undo of the last stroke (redo step) must be written')
  results.deliberateClear = 'written'

  // Zero strokes over an already-empty record and companion: written.
  put(recordPath, JSON.stringify(skeleton))
  put(companionPath, famd.composeFamdCompanion(null, BODY, skeleton, 'dots'))
  const emptyBefore = readStored(recordPath)
  assert.equal(saveLikeMain(page({ updatedAt: '2026-11-09T10:00:00.000Z' })).refused, false, 'empty over empty is written')
  assert.notEqual(readStored(recordPath), emptyBefore)
  // A brand-new page (no record, no companion yet).
  put(recordPath, null)
  put(companionPath, null)
  assert.equal(saveLikeMain(skeleton).refused, false, 'a new empty page has nothing to protect')
  results.emptyOverEmpty = 'written'

  // Normal saves with strokes: written, also over fewer strokes or a large page.
  put(recordPath, JSON.stringify(inked))
  put(companionPath, companionOf(inked))
  assert.equal(saveLikeMain(morePen).refused, false)
  assert.equal(JSON.parse(readStored(recordPath)).strokes.length, 3)
  assert.equal(saveLikeMain(page({ strokes: [stroke(0.7)] })).refused, false, 'fewer strokes are a normal save')
  assert.equal(guard.refusesEmptyInkSave({ document: page(), large: true, recordText: JSON.stringify(inked) }), false, 'a large drawing is never a skeleton')
  results.normalSave = 'written'

  // ── 3. Opening: an empty companion with an inked record opens the record ──
  const opened = (ink) => famd.openFamdFile(companionOf(ink))
  const emptyCompanion = famd.openFamdFile(famd.composeFamdCompanion(companionOf(inked), BODY, skeleton, 'dots'))
  assert.equal(guard.companionInkNeedsRecord(emptyCompanion), true)
  const fromRecord = guard.recordDocumentForEmptyCompanion(emptyCompanion, JSON.stringify(inked))
  assert.ok(fromRecord, 'empty famd + record with strokes → the record is opened')
  assert.equal(fromRecord.strokes.length, 2)
  assert.equal(guard.recordDocumentForEmptyCompanion(emptyCompanion, JSON.stringify(skeleton)), null, 'both empty → the companion (empty) as before')
  assert.equal(guard.recordDocumentForEmptyCompanion(emptyCompanion, null), null, 'no record → the companion as before')
  assert.equal(guard.recordDocumentForEmptyCompanion(emptyCompanion, '{"strokes":[{"points":[{"x":0.1'), null, 'a damaged record is not opened')
  assert.equal(guard.recordDocumentForEmptyCompanion(opened(inked), JSON.stringify(morePen)), null, 'famd with strokes → famd is used')
  assert.equal(guard.recordDocumentForEmptyCompanion(opened(cleared), JSON.stringify(inked)), null, 'a deliberately cleared famd stays cleared')
  assert.equal(guard.recordDocumentForEmptyCompanion(opened(nestedCollapsed), JSON.stringify(inked)), null, 'collapsed ink is ink')
  assert.equal(guard.companionInkNeedsRecord(famd.openFamdFile(famd.createNoteCompanion('# Neu\n\n'))), false, 'a companion without ink keeps the existing library fallback')
  const heavy = page({ strokes: [stroke(0.1, INK_PACK_POINTS + 10)] })
  const heavyOpen = famd.openFamdFile(companionOf(heavy))
  assert.ok(heavyOpen.packedInk?.columns, 'fixture: a heavy companion opens packed')
  assert.equal(guard.companionInkNeedsRecord(heavyOpen), false, 'a packed companion is never replaced')
  results.openFallback = 'record only for empty famd + inked record'
} finally {
  fs.rmSync(vault, { recursive: true, force: true })
}

// ── Main: the handler checks before it writes, and opening writes nothing ──
const main = fs.readFileSync(path.join(root, 'electron/main.cjs'), 'utf8')
const handler = section(main, 'handle(IPC.saveDrawing', 'handle(IPC.listDrawings', 'saveDrawing handler')
const guardAt = handler.indexOf('refusesEmptyInkSave({')
assert.ok(guardAt > 0, 'saveDrawing asks refusesEmptyInkSave')
for (const write of ['atomicWrite(', 'queueFileWrite(', 'writeFamdCompanion(']) {
  const at = handler.indexOf(write)
  assert.ok(at > guardAt, `saveDrawing decides before its first ${write}`)
}
const refusal = handler.slice(guardAt, handler.indexOf('return savedResult()', guardAt))
assert.doesNotMatch(refusal, /atomicWrite|queueFileWrite|writeFamdCompanion|handwriting-learning/u, 'a refused save writes nothing')
assert.match(refusal, /large: largeDrawing/u)
assert.match(refusal, /isUnexplainedEmptyPage\(drawingDocument\) \? await storedInkTexts\(dataPath, payload\.noteRelativePath\)/u)
assert.match(refusal, /console\.warn\('FaNotes: an empty handwriting page was not written over stored strokes\.'\)/u)
assert.equal(handler.split('return savedResult()').length - 1, 2, 'refused and written saves return the same shape')
const stored = section(main, 'async function storedInkTexts(', '\nfunction validateDrawingJson(', 'storedInkTexts')
assert.match(stored, /readRegularFileNoFollow\(dataPath, MAX_DRAWING_JSON_BYTES\)/u)
assert.match(stored, /readOptionalNoteFile\(famdRelativePath\)/u)
assert.match(stored, /error\?\.code === 'ENOENT' \? null : undefined/u)
const recordRead = section(main, 'async function readExistingDrawingRecord(', '\n}\n', 'readExistingDrawingRecord')
assert.doesNotMatch(recordRead, /mkdir|atomicWrite|ensureInternal|writeFile/u, 'the open fallback creates nothing')
const fallback = section(main, 'async function recordInkForEmptyCompanion(', '\n}\n', 'recordInkForEmptyCompanion')
assert.match(fallback, /recordDocumentForEmptyCompanion\(loaded, record\.drawingJson\)/u)
assert.doesNotMatch(fallback, /atomicWrite|queueFileWrite|writeFamdCompanion|mutateFamdCompanion/u)
assert.match(fallback, /console\.warn\('FaNotes: a note companion held an empty handwriting page; opened its drawing record instead\.'\)/u)
const readFamdInk = section(main, 'handle(IPC.readFamdInk', 'handle(IPC.readNotePageStats', 'readFamdInk')
assert.ok(readFamdInk.indexOf('recordInkForEmptyCompanion(') >= 0 && readFamdInk.indexOf('recordInkForEmptyCompanion(') < readFamdInk.indexOf('readCompanionInkDocument('))
const readCompanion = section(main, 'handle(IPC.readNoteCompanion', 'handle(IPC.writeNoteBackups', 'readNoteCompanion')
assert.ok(readCompanion.indexOf('recordInkForEmptyCompanion(') >= 0 && readCompanion.indexOf('recordInkForEmptyCompanion(') < readCompanion.indexOf('readCompanionInkDocument('))

// ── 1. DrawingBoard: no save while the stored page is not in ───────────────
const board = fs.readFileSync(path.join(root, 'src/components/DrawingBoard.tsx'), 'utf8')
assert.match(board, /const inkLoadPendingRef = useRef\(Boolean\(initialDrawingJson\)\)/u)
assert.match(board, /const inkLoadFailedRef = useRef\(false\)/u)
assert.match(board, /const inkLoadBlocksSave = useCallback\(\(\) => \(\n\s+inkLoadPendingRef\.current \|\| inkHydratingRef\.current \|\| inkLoadFailedRef\.current\n\s+\), \[\]\)/u)
const loadEffect = section(board, '    if (!initialDrawingJson) return\n', '  }, [bumpInkRevision, clearRecognitionScope, drawingId, initialDrawingJson, packedInk, setDirty, updateHistoryState])', 'load effect')
assert.ok(loadEffect.indexOf('inkLoadPendingRef.current = false') >= 0 && loadEffect.indexOf('inkLoadPendingRef.current = false') < loadEffect.indexOf('drawingLoadStep('), 'the load effect takes the pending page first')
const failLoad = section(loadEffect, 'const failLoad = () => {', '\n    }\n', 'failLoad')
assert.match(failLoad, /inkLoadFailedRef\.current = true/u)
assert.match(failLoad, /setDirty\(false\)/u)
const applyLoaded = section(loadEffect, 'const applyLoaded = (', 'loadedDrawingJsonRef.current = initialDrawingJson\n    }', 'applyLoaded')
assert.match(applyLoaded, /inkHydratingRef\.current = false\n\s+inkLoadFailedRef\.current = false/u)
assert.match(loadEffect, /inkReadyRef\.current = false\n\s+inkHydratingRef\.current = true/u, 'the packed restore is still flagged')
const pointerDown = section(board, 'const handlePointerDown = useCallback(', 'if (overlayInert(inline, inputActive)', 'handlePointerDown')
assert.match(pointerDown, /if \(!inkReadyRef\.current \|\| inkLoadFailedRef\.current\) return/u, 'an unreadable page takes no pen or eraser')
const setDirty = section(board, 'const setDirty = useCallback(', '}, [inkLoadBlocksSave, onDirtyChange])', 'setDirty')
assert.match(setDirty, /onDirtyChange\?\.\(dirty && inkPagePersists\([^\n]*\) && !inkLoadBlocksSave\(\)\)/u, 'a page that is not in yet never reports dirty to the host')
const save = section(board, 'const saveDrawing = useCallback(', '  useEffect(() => {\n    saveLatestRef.current', 'saveDrawing')
assert.match(save, /^const saveDrawing = useCallback\(\(insertAfterSave: boolean, silent = false\) => \{\n(?:\s*\/\/[^\n]*\n)*\s+if \(inkLoadBlocksSave\(\)\) \{/u, 'saveDrawing checks the load before anything else')
assert.match(save, /try \{\n(?:\s*\/\/[^\n]*\n)*\s+if \(inkLoadBlocksSave\(\)\) return\n\s+const result = await writeInkPage\(drawingPayload\(insertAfterSave\)\)/u, 'a queued save checks again before it writes')
const flush = section(board, 'flush: async () => {', 'refreshTraining: async () => {', 'flush')
assert.match(flush, /for \(let attempt = 0; attempt < INK_FLUSH_MAX_ROUNDS; attempt \+= 1\) \{\n(?:\s*\/\/[^\n]*\n)*\s+if \(inkLoadBlocksSave\(\)\) return\n/u, 'flush checks the load in every round')
// Every write goes through saveDrawing's run or flush; nothing else calls writeInkPage or onSaveDrawing.
assert.equal(board.split('await writeInkPage(').length - 1, 2, 'writeInkPage has exactly the two gated callers')
assert.equal(board.split('onSaveDrawing(').length - 1, 1, 'only writeInkPage calls onSaveDrawing')

console.log(JSON.stringify({ ok: true, ...results }))
