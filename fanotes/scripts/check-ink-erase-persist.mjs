// An erased stroke stays erased.
//
// Report: “I erase a line and eventualy it spawns right back.” Two causes:
//   1. The first autosave of a new page gives it an id. The app writes that
//      snapshot back into the session, the board saw a new drawingId and
//      loaded the snapshot — putting back every stroke erased (and dropping
//      every stroke drawn) while the save was in flight, and clearing the
//      undo history. The board now recognises its own save and only
//      acknowledges it.
//   2. Every save path skipped an empty stroke list, so erasing the last
//      stroke never reached the vault; the next open (or note switch) showed
//      the old ink again. A page that has a record persists even when empty.
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
const { inkDocumentIsOwnSave, inkPagePersists } = await server.ssrLoadModule('/src/lib/overlayInteract.ts')
await server.close()

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const board = readFileSync(join(root, 'src/components/DrawingBoard.tsx'), 'utf8')

const section = (source, start, end, label) => {
  const from = source.indexOf(start)
  assert.ok(from >= 0, `${label}: missing ${start}`)
  const to = source.indexOf(end, from + start.length)
  assert.ok(to > from, `${label}: missing ${end}`)
  return source.slice(from, to)
}

// 2. Persistence rule: ink always; an empty page only once it has a record.
assert.equal(inkPagePersists(3, false), true)
assert.equal(inkPagePersists(3, true), true)
assert.equal(inkPagePersists(0, true), true, 'erasing the last stroke must reach the vault')
assert.equal(inkPagePersists(0, false), false, 'switching the pen on must not create a record for every note')

// 1. Own-save recognition: by the exact snapshot, or by the id the save produced.
const snapshot = JSON.stringify({ strokes: [{ id: 'a' }, { id: 'b' }] })
const other = JSON.stringify({ strokes: [{ id: 'z' }] })
assert.equal(inkDocumentIsOwnSave(null, 'x1', snapshot), false, 'nothing authored yet: a document is loaded')
assert.equal(inkDocumentIsOwnSave({ id: null, drawingJson: snapshot }, 'x1', snapshot), true, 'echo of the first save (id not known yet) is recognised by its snapshot')
assert.equal(inkDocumentIsOwnSave({ id: 'x1', drawingJson: snapshot }, 'x1', other), true, 'same record: the board holds the live strokes')
assert.equal(inkDocumentIsOwnSave({ id: 'x1', drawingJson: snapshot }, 'x2', other), false, 'a different record with different ink is loaded')
assert.equal(inkDocumentIsOwnSave({ id: null, drawingJson: snapshot }, 'x2', other), false)

// The reported sequence, replayed against the rule: draw a, b → autosave starts
// (snapshot ab, no id yet) → erase b while it is in flight → app echoes {x1, ab}.
let strokes = ['a', 'b']
const authored = { id: null, drawingJson: JSON.stringify(strokes) }
strokes = strokes.filter((stroke) => stroke !== 'b')
const echoed = { id: 'x1', drawingJson: authored.drawingJson }
if (!inkDocumentIsOwnSave(authored, echoed.id, echoed.drawingJson)) strokes = JSON.parse(echoed.drawingJson)
assert.deepEqual(strokes, ['a'], 'the erased stroke does not come back when the first save lands')
// …and the follow-up save carries the erased state even when it emptied the page.
strokes = []
assert.equal(inkPagePersists(strokes.length, echoed.id !== ''), true)

// Source: the load effect acknowledges the board's own save instead of loading it.
const load = section(board, '    const sourceId = drawingId ?? null\n    if (loadedDrawingIdRef.current === sourceId) return', 'const document: unknown = JSON.parse(initialDrawingJson)', 'document load guard')
assert.match(load, /if \(inkDocumentIsOwnSave\(authoredSaveRef\.current, sourceId, initialDrawingJson\)\) \{/)
assert.match(load, /loadedDrawingIdRef\.current = sourceId\s*if \(sourceId\) drawingIdRef\.current = sourceId\s*return/)

// Source: one write path notes the snapshot before the app can echo it, and adopts the id.
const write = section(board, 'const writeInkPage = useCallback(async (payload: DrawingSavePayload) => {', '}, [onSaveDrawing])', 'writeInkPage')
assert.ok(write.indexOf('authoredSaveRef.current = { id: payload.id || null, drawingJson: payload.drawingJson }') < write.indexOf('await onSaveDrawing(payload)'), 'the snapshot is noted before the save resolves')
assert.match(write, /authoredSaveRef\.current = \{ id: result\.id, drawingJson: payload\.drawingJson \}\s*drawingIdRef\.current = result\.id/)
assert.equal((board.match(/await onSaveDrawing\(/g) ?? []).length, 1, 'every save goes through writeInkPage')

// Source: every save path uses the persistence rule — no bare stroke-count guard left.
const save = section(board, 'const saveDrawing = useCallback((insertAfterSave: boolean, silent = false) => {', 'const run = async () => {', 'saveDrawing guard')
assert.match(save, /if \(!inkPagePersists\(strokesRef\.current\.length, inkRecordExists\(\)\)\) return Promise\.resolve\(\)/)
const flush = section(board, 'flush: async () => {', 'refreshTraining:', 'flush')
assert.match(flush, /if \(!dirtyRef\.current \|\| !inkPagePersists\(strokesRef\.current\.length, inkRecordExists\(\)\)\) return/)
assert.match(flush, /await writeInkPage\(drawingPayload\(\)\)/)
assert.match(board, /if \(dirtyRef\.current && inkPagePersists\(strokesRef\.current\.length, inkRecordExists\(\)\)\) void saveLatestRef\.current\(\)/, 'unmount save')
const autosave = section(board, 'if (revision === 0 || !dirtyRef.current) return', 'return () => {', 'autosave effect')
assert.match(autosave, /if \(!inkPagePersists\(strokesRef\.current\.length, inkRecordExists\(\)\)\) return/)
assert.match(autosave, /void saveDrawing\(false, true\)/)
for (const guard of board.matchAll(/!strokesRef\.current\.length\) return/g)) {
  const before = board.slice(Math.max(0, guard.index - 400), guard.index)
  assert.ok(
    /const clear = useCallback|transcriptRevision === 0/.test(before),
    `a save path still skips an empty page: …${board.slice(guard.index - 60, guard.index + 30).replace(/\s+/g, ' ')}`,
  )
}
const record = section(board, 'const inkRecordExists = useCallback(() => (', '), [])', 'inkRecordExists')
assert.match(record, /Boolean\(drawingIdRef\.current\) \|\| loadedDrawingIdRef\.current !== undefined/, 'a record exists once loaded from the note or written by this board')

console.log(JSON.stringify({
  ownSaveNotReloaded: true,
  emptyPagePersists: true,
  undoSurvivesFirstSave: true,
}))
