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

const { INK_HISTORY_LIMIT, decodeInkHistory, encodeInkHistory } = await server.ssrLoadModule('/src/lib/inkHistory.ts')

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const board = readFileSync(join(root, 'src/components/DrawingBoard.tsx'), 'utf8')

const stroke = (id, x) => ({ id, points: [{ x, y: 0.2 }] })

try {
  assert.equal(INK_HISTORY_LIMIT, 80)

  const kept = stroke('kept', 0.1)
  const also = stroke('also', 0.4)
  const erased = stroke('erased', 0.7)
  const live = [kept, also]
  const undo = [[], [kept], [kept, also, erased]]
  const redo = [[kept, also]]
  const encoded = encodeInkHistory(live, undo, redo)
  assert.ok(encoded)
  assert.deepEqual(encoded.extras.map((entry) => entry.id), ['erased'])
  assert.deepEqual(encoded.undo, [
    [],
    [{ live: 0 }],
    [{ live: 0 }, { live: 1 }, { extra: 0 }],
  ])
  assert.deepEqual(encoded.redo, [[{ live: 0 }, { live: 1 }]])

  const reloadedLive = JSON.parse(JSON.stringify(live))
  const reloaded = decodeInkHistory(
    reloadedLive,
    JSON.parse(JSON.stringify(encoded)),
    (entry) => (entry && typeof entry === 'object' && typeof entry.id === 'string' ? entry : null),
  )
  assert.equal(reloaded.undo.length, 3)
  assert.equal(reloaded.redo.length, 1)
  assert.equal(reloaded.undo[2][0], reloadedLive[0], 'undo must share the reloaded live stroke')
  assert.equal(reloaded.undo[2][1], reloadedLive[1])
  assert.notEqual(reloaded.undo[2][2], reloadedLive[0])
  assert.equal(reloaded.undo[2][2].id, 'erased')
  assert.equal(reloaded.redo[0][0], reloadedLive[0])
  reloadedLive[0].points[0].x = 0.55
  assert.equal(reloaded.undo[1][0].points[0].x, 0.55, 'a page grow must move the shared history stroke once')

  const document = JSON.stringify({ strokes: live, inkHistory: encoded })
  assert.equal(document.split('"erased"').length - 1, 1, 'an erased stroke is stored once')
  assert.equal(document.split('"kept"').length - 1, 1, 'a live stroke is not copied into every undo step')

  assert.equal(encodeInkHistory(live, [], []), null)
  assert.deepEqual(decodeInkHistory(reloadedLive, undefined, () => null), { undo: [], redo: [] })
  assert.deepEqual(
    decodeInkHistory(reloadedLive, { extras: [], undo: [[{ live: 9 }]], redo: [] }, () => null),
    { undo: [], redo: [] },
    'a broken history must not replace the page',
  )
  const longUndo = Array.from({ length: INK_HISTORY_LIMIT + 5 }, () => [kept])
  const capped = encodeInkHistory(live, longUndo, [])
  assert.equal(capped.undo.length, INK_HISTORY_LIMIT)

  assert.match(board, /decodeInkHistory\(strokesRef\.current, raw\.inkHistory/)
  assert.match(board, /undoRef\.current = loadedHistory\.undo/)
  assert.match(board, /redoRef\.current = loadedHistory\.redo/)
  assert.match(board, /const inkHistory = encodeInkHistory\(strokesRef\.current, undoRef\.current, redoRef\.current\)/)
  assert.match(board, /\.\.\.\(inkHistory \? \{ inkHistory \} : \{\}\)/)
  assert.doesNotMatch(board, /SCRIBBLE_ERASE_NOTICE_TEXT/)
  assert.doesNotMatch(board, /Konvertierung eingefügt\./)
  assert.doesNotMatch(board, /Einige Zeichen sind noch unsicher/)

  console.log(JSON.stringify({
    steps: reloaded.undo.length,
    shared: true,
    extras: encoded.extras.length,
    survivesReload: true,
  }))
  console.log('ink-history-persist ok')
} finally {
  await server.close()
}
