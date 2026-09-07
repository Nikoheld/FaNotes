// Saved handwriting survives a note switch in both input modes.
//
// Report: “The Handwritten notes just disapear when i switch documents.”
// Three causes, all guarded here:
//   1. Keyboard-mode switches skipped the FAMD/ink read and kept the overlay
//      unmounted, so the note's ink only showed once Stift was on.
//   2. Mounting the overlay with a saved document looped: the first-paint
//      absorb measured the canvas surface (sheet + camera room), grew the page
//      by the room, the sheet followed, and fitPageToInk's identity re-armed
//      the pass after every grow until React gave up. The Handschrift boundary
//      swallowed the crash — no overlay, no ink.
//   3. Stift-on for an unmounted session read the drawing-library record the
//      note's marker points at; FAMD-embedded ink came back as 'famd-ink' and
//      later saves went to that shared record, so the marker's record went
//      stale and the pen resumed an old page.
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
  FAMD_INK_ID,
  noteInkDocument,
  overlayInert,
  overlaySessionAfterInkReady,
  overlaySessionAfterNoteSwitch,
} = await server.ssrLoadModule('/src/lib/overlayInteract.ts')
const { SCROLL_ROOM, paintedStayExtent, writePageStayExtent } = await server.ssrLoadModule('/src/lib/noteCanvas.ts')
await server.close()

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const app = readFileSync(join(root, 'src/App.tsx'), 'utf8')
const board = readFileSync(join(root, 'src/components/DrawingBoard.tsx'), 'utf8')
const main = readFileSync(join(root, 'electron/main.cjs'), 'utf8')

const section = (source, start, end, label) => {
  const from = source.indexOf(start)
  assert.ok(from >= 0, `${label}: missing ${start}`)
  const to = source.indexOf(end, from + start.length)
  assert.ok(to > from, `${label}: missing ${end}`)
  return source.slice(from, to)
}

// 1. Session lifecycle: ink loads and mounts in keyboard mode, inert, only for notes with ink.
const document = { id: 'a1', drawingJson: '{}' }
assert.deepEqual(overlaySessionAfterInkReady(false, { key: 4, document }), { key: 4, document })
assert.deepEqual(overlaySessionAfterInkReady(false, { key: 4, document: null }), { key: 0, document: null })
assert.deepEqual(overlaySessionAfterInkReady(true, { key: 4, document: null }), { key: 4, document: null })
assert.deepEqual(overlaySessionAfterInkReady(true, { key: 4, document }), { key: 4, document })
assert.deepEqual(overlaySessionAfterNoteSwitch({ drawingOpen: false, session: { key: 4, document: null } }), { key: 0, document: null })
assert.deepEqual(overlaySessionAfterNoteSwitch({ drawingOpen: true, session: { key: 4, document: null } }), { key: 4, document: null })
assert.equal(overlayInert(true, false), true, 'keyboard-mode overlay stays inert')
assert.equal(overlayInert(true, true), false)

const switchEffect = section(app, 'const requestId = ++drawingLoadRequestRef.current\n    drawingDirtyRef.current = false', '}, [activeTab?.path])', 'note-switch effect')
assert.doesNotMatch(switchEffect, /overlayInkLoadOnNoteSwitch/, 'keyboard-mode switch must not skip the ink read')
assert.doesNotMatch(app, /overlayInkLoadOnNoteSwitch/)
assert.match(switchEffect, /readNoteInk\(path, content\)/)
assert.match(switchEffect, /overlaySessionAfterInkReady\(\s*drawingOpenRef\.current,\s*drawingSessionFromLoad\(requestId, document\)/)
assert.match(switchEffect, /requestIdleCallback\(load/, 'the read stays off the switch itself')

// 3. One FAMD-first read for every path that opens ink; embedded ink carries the note's marker id.
const reader = section(app, 'const readNoteInk = async (path: string, content: string)', '\n}\n', 'readNoteInk')
assert.ok(reader.indexOf('readFamdInk(path)') < reader.indexOf('readDrawing(markerId)'), 'FAMD companion is read before the library record')
assert.match(reader, /noteInkDocument\(embedded, markerId\)/)
const openDrawing = section(app, 'const openDrawing = useCallback(() => {', '}, [activeTab, drawingSession.key, toast])', 'openDrawing')
assert.match(openDrawing, /if \(drawingSession\.key > 0\) return/, 'a mounted session is reused — no remount when Stift turns on')
assert.match(openDrawing, /readNoteInk\(path, content\)/)
assert.doesNotMatch(openDrawing, /window\.fanotes\.readDrawing\(/, 'Stift-on must not resume from the library record alone')

assert.equal(FAMD_INK_ID, 'famd-ink')
assert.deepEqual(noteInkDocument({ id: 'famd-ink', drawingJson: '{}' }, 'note-7'), { id: 'note-7', drawingJson: '{}' })
assert.deepEqual(noteInkDocument({ id: 'famd-ink', drawingJson: '{}' }, null), { id: '', drawingJson: '{}' }, 'no marker: Main assigns a fresh id on save')
assert.deepEqual(noteInkDocument({ id: 'lib-1', drawingJson: '{}' }, 'note-7'), { id: 'lib-1', drawingJson: '{}' })
const famdRead = section(main, 'handle(IPC.readFamdInk', 'handle(IPC.readNotePaperStyle', 'readFamdInk handler')
assert.match(famdRead, /noteInkMarkerId\(parsed\.markdown\)/, 'Main reports embedded ink under the note marker id')
assert.match(famdRead, /markerId \?\? /)
assert.match(main, /const NOTE_INK_MARKER = \/<!--\\s\*fanotes-ink:\(\[a-zA-Z0-9_-\]\{1,96\}\)\\s\*-->\/u/)

// 2. The first-paint absorb measures the sheet, grows through setPageExtent, and cannot loop.
const absorb = section(board, 'const absorbPaintedOneCanvas = useCallback(() => {', '}, [inline, resolvePaperElement, setPageExtent])', 'absorbPaintedOneCanvas')
assert.doesNotMatch(absorb, /surface(Ref\.current)?\??\.offset(Width|Height)/, 'the canvas surface (sheet + camera room) is not the 0–1 box')
assert.match(absorb, /paintedStayExtent\(sourceWidthRef\.current, paper\.offsetWidth\)/)
assert.match(absorb, /paintedStayExtent\(sourceHeightRef\.current, paper\.offsetHeight\)/)
assert.match(absorb, /if \(!setPageExtent\(/, 'grow through setPageExtent so loaded ink keeps its paper position')
assert.match(absorb, /for \(let pass = 0; pass < 3; pass \+= 1\)/, 'bounded passes')
assert.doesNotMatch(absorb, /setSourceWidth\(|setSourceHeight\(/, 'no raw source assignment without a remap')
assert.doesNotMatch(board, /absorbOneCanvasRef/, 'no one-shot flag that a churning effect can re-arm')
assert.match(board, /useEffect\(\(\) => \{\s*fitLoadedPageRef\.current\(\)\s*\}, \[drawingId, initialDrawingJson\]\)/, 'fit-to-ink runs once per loaded document')
const load = section(board, 'const document: unknown = JSON.parse(initialDrawingJson)', 'loadedDrawingIdRef.current = sourceId', 'document load')
assert.match(load, /paintedLayoutRef\.current = \{ w: sourceWidthRef\.current, h: sourceHeightRef\.current \}/, 'loaded 0–1 ink is relative to the saved page')
assert.match(load, /applyInkExtentStylesRef\.current\(sourceHeightRef\.current, sourceWidthRef\.current\)/, 'the sheet takes the saved page before the first redraw')
assert.match(board, /applyInkExtentStyles\(sourceHeightRef\.current, sourceWidthRef\.current\)\s*\}, \[applyInkExtentStyles, sourceHeight, sourceWidth\]\)/)

// Geometry: with the sheet as the measure, a sheet that equals the page never grows it,
// while the surface (sheet + 2·room) always did — by exactly the room, every pass.
const page = { w: 1252, h: 680 }
const room = 2 * SCROLL_ROOM
assert.equal(paintedStayExtent(page.w, page.w), page.w)
assert.equal(paintedStayExtent(page.h, page.h), page.h)
assert.equal(paintedStayExtent(page.h, page.h + room), page.h + room, 'the surface measure would have grown the page by the room')
assert.equal(writePageStayExtent(page.h, page.h + room), page.h, 'the room guard only helps when sheet === page exactly')
assert.equal(writePageStayExtent(page.h, page.h + room + 49), page.h + room + 49, '…and fails as soon as the sheet is a few px larger')
// A sheet larger than the page (viewport minimum) is adopted in one pass and then stable.
let source = 343
for (let pass = 0; pass < 3; pass += 1) {
  const sheet = Math.max(858, source)
  const painted = paintedStayExtent(source, sheet)
  if (painted <= source + 1) break
  source = painted
}
assert.equal(source, 858)

console.log(JSON.stringify({
  keyboardModeShowsInk: true,
  keyboardModeInert: true,
  famdFirstRead: true,
  embeddedInkKeepsMarkerId: true,
  absorbMeasuresSheet: true,
  fitOncePerDocument: true,
}))
