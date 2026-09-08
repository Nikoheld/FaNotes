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
  ACTIVITY_GAP_MS,
  closePageStats,
  emptyPageStats,
  formatPageDwell,
  idlePageStatsSession,
  markPageStatsPersisted,
  measureDocument,
  openPageStats,
  pageStatsNeedPersist,
  parsePageStats,
  recordDocumentSaved,
  recordEditActivity,
  recordInkErased,
  recordInkSnapshot,
  recordInkStroke,
  snapshotPageStats,
  summarizeInkStrokes,
  tickPageStats,
} = await server.ssrLoadModule('/src/lib/pageStats.ts')
const {
  readPageStatsFromNote,
  stripFamdPayload,
  writePageStatsIntoNote,
} = await server.ssrLoadModule('/src/lib/famd.ts')

const sum = (values) => values.reduce((total, value) => total + value, 0)

const runOnce = () => {
  const t0 = Date.parse('2026-09-06T12:00:00.000Z')
  const empty = emptyPageStats(t0)
  assert.equal(Number.isFinite(Date.parse(empty.createdAt)), true)
  assert.equal(Number.isFinite(Date.parse(empty.modifiedAt)), true)
  assert.equal(empty.dwellMs, 0)
  assert.equal(empty.version, 2)

  /* ---- dwell, sessions, histograms ---- */
  const opened = openPageStats(empty, t0)
  assert.equal(opened.openCount, 1)
  assert.equal(opened.active, true)
  assert.equal(opened.activeDays.length, 1)
  assert.equal(sum(opened.opensByHour), 1)
  const ticked = tickPageStats(opened, t0 + 5_000, true)
  assert.equal(ticked.dwellMs, 5_000)
  assert.equal(ticked.focusMs, 5_000)
  assert.equal(sum(ticked.dwellByHour), 5_000)
  assert.equal(sum(ticked.dwellByWeekday), 5_000)
  const unfocused = tickPageStats(ticked, t0 + 6_000, true, false)
  assert.equal(unfocused.dwellMs, 6_000)
  assert.equal(unfocused.focusMs, 5_000, 'focus time must not grow while the window is in the background')
  const idle = tickPageStats(unfocused, t0 + 8_000, false)
  assert.equal(idle.dwellMs, 8_000)
  assert.equal(idle.active, false)
  const stillIdle = tickPageStats(idle, t0 + 20_000, false)
  assert.equal(stillIdle.dwellMs, 8_000, 'dwell must not grow while the page is inactive')
  assert.equal(stillIdle.lastSessionMs, 8_000)
  assert.equal(stillIdle.longestSessionMs, 8_000)
  assert.equal(stillIdle.revision, opened.revision, 'ticks alone must not bump the revision')
  assert.equal(pageStatsNeedPersist(stillIdle, 0), true, 'new dwell still needs a persist')
  assert.equal(pageStatsNeedPersist(stillIdle, 10_000), false, 'a short stay stays below the dwell threshold')

  /* ---- typing ---- */
  let typed = recordEditActivity(stillIdle, { kind: 'type', inserted: 5, deleted: 0, wordsCompleted: 0, lineBreaks: 0 }, t0 + 30_000)
  typed = recordEditActivity(typed, { kind: 'type', inserted: 1, deleted: 0, wordsCompleted: 1, lineBreaks: 0 }, t0 + 31_000)
  typed = recordEditActivity(typed, { kind: 'delete', inserted: 0, deleted: 2, wordsCompleted: 0, lineBreaks: 0 }, t0 + 32_000)
  typed = recordEditActivity(typed, { kind: 'type', inserted: 1, deleted: 0, wordsCompleted: 1, lineBreaks: 1 }, t0 + 32_000 + ACTIVITY_GAP_MS + 1)
  typed = recordEditActivity(typed, { kind: 'paste', inserted: 40, deleted: 0, wordsCompleted: 0, lineBreaks: 0 }, t0 + 40_000)
  typed = recordEditActivity(typed, { kind: 'autocorrect', inserted: 5, deleted: 4, wordsCompleted: 0, lineBreaks: 0 }, t0 + 40_500)
  typed = recordEditActivity(typed, { kind: 'undo', inserted: 4, deleted: 5, wordsCompleted: 0, lineBreaks: 0 }, t0 + 41_000)
  assert.equal(typed.typing.charsTyped, 7)
  assert.equal(typed.typing.charsDeleted, 2)
  assert.equal(typed.typing.wordsTyped, 2)
  assert.equal(typed.typing.linesTyped, 1)
  assert.equal(typed.typing.keystrokes, 5, 'autocorrect and undo are not keystrokes')
  assert.equal(typed.typing.pastes, 1)
  assert.equal(typed.typing.charsPasted, 40)
  assert.equal(typed.typing.autocorrects, 1)
  assert.equal(typed.typing.undos, 1)
  assert.equal(typed.typing.bursts, 2, 'a pause longer than the gap opens a new burst')
  assert.equal(typed.typing.ms, 2_000 + 2_999, 'typing time is the time between close keystrokes')
  assert.equal(typed.typing.longestBurstMs, 2_999)
  assert.equal(typed.modifiedAt, new Date(t0 + 41_000).toISOString())
  assert.ok(typed.revision > stillIdle.revision)

  /* ---- ink ---- */
  let inked = recordInkStroke(typed, { durationMs: 400, lengthMm: 12.34, points: 20, purpose: 'handwriting', color: '#1c1c1c' }, t0 + 60_000)
  inked = recordInkStroke(inked, { durationMs: 600, lengthMm: 8, points: 30, purpose: 'art', brush: 'marker', color: '#ff0' }, t0 + 61_000)
  inked = recordInkStroke(inked, { durationMs: 1_000, lengthMm: 30, points: 50, purpose: 'handwriting', color: '#1c1c1c' }, t0 + 61_000 + ACTIVITY_GAP_MS + 2_000)
  inked = recordInkErased(inked, 2, t0 + 70_000)
  assert.equal(inked.ink.strokes, 3)
  assert.equal(inked.ink.points, 100)
  assert.equal(inked.ink.lengthMm, 50.3)
  assert.equal(inked.ink.longestStrokeMm, 30)
  assert.equal(inked.ink.penDownMs, 2_000)
  assert.equal(inked.ink.handwritingStrokes, 2)
  assert.equal(inked.ink.artStrokes, 1)
  assert.equal(inked.ink.strokesErased, 2)
  assert.deepEqual(inked.ink.colors, ['#1c1c1c', '#ff0'])
  assert.deepEqual(inked.ink.brushes, { pen: 2, marker: 1 })
  assert.equal(inked.ink.bursts, 2)
  // First burst: stroke 1 (400 ms) + gap to stroke 2 (1000 - 600 = 400 ms) + stroke 2 (600 ms).
  // Second burst: only its own 1000 ms.
  assert.equal(inked.ink.ms, 400 + 400 + 600 + 1_000)
  assert.equal(inked.ink.longestBurstMs, 1_400)
  const snapshot = recordInkSnapshot(inked, { strokes: 1, points: 50, lengthMm: 30, penDownMs: 1_000 }, t0 + 71_000)
  assert.equal(snapshot.ink.current.strokes, 1)
  assert.equal(snapshot.ink.current.savedAt, new Date(t0 + 71_000).toISOString())

  const strokes = [
    { points: [{ x: 0, y: 0, t: 100 }, { x: 0.5, y: 0, t: 400 }] },
    { points: [{ x: 0, y: 0, t: 1_000 }, { x: 0, y: 0.5, t: 1_200 }, { x: 0, y: 1, t: 1_300 }] },
  ]
  const summary = summarizeInkStrokes(strokes, 900, 1_800)
  assert.equal(summary.strokes, 2)
  assert.equal(summary.points, 5)
  // 450 px along the 210 mm sheet width = 105 mm; the full 1800 px height = 420 mm.
  assert.equal(summary.lengthMm, 525)
  assert.equal(summary.penDownMs, 600)

  /* ---- document ---- */
  const markdown = [
    '# Titel',
    '',
    'Ein Absatz mit **fünf** Wörtern hier.',
    'Noch eine Zeile im selben Absatz.',
    '',
    '- [x] erledigt',
    '- [ ] offen',
    '- Punkt',
    '',
    '> Zitat',
    '',
    '```js',
    'const x = 1',
    '```',
    '',
    '$$',
    'a^2 + b^2 = c^2',
    '$$',
    '',
    '| a | b |',
    '|---|---|',
    '| 1 | 2 |',
    '',
    '![Bild](bild.png) und [Link](https://example.org) und [[Wiki]]',
  ].join('\n')
  const measured = measureDocument(markdown)
  assert.equal(measured.headings, 1)
  assert.equal(measured.paragraphs, 2)
  assert.equal(measured.tasks, 2)
  assert.equal(measured.tasksDone, 1)
  assert.equal(measured.listItems, 3)
  assert.equal(measured.blockquotes, 1)
  assert.equal(measured.codeBlocks, 1)
  assert.equal(measured.mathBlocks, 1)
  assert.equal(measured.tables, 1)
  assert.equal(measured.images, 1)
  assert.equal(measured.links, 2)
  assert.equal(measured.lines, markdown.split('\n').length)
  assert.equal(measured.characters, markdown.length)
  assert.ok(measured.words > 20)
  assert.ok(measured.charactersWithoutSpaces < measured.characters)
  assert.equal(measured.readingMinutes, 1)
  assert.equal(measureDocument('').words, 0)
  assert.equal(measureDocument('').readingMinutes, 0)

  let saved = recordDocumentSaved(snapshot, 'eins zwei drei', t0 + 80_000)
  assert.equal(saved.document.words, 3)
  assert.equal(saved.document.peakWords, 3)
  assert.equal(saved.document.wordsAdded, 3)
  assert.equal(saved.saveCount, 1)
  saved = recordDocumentSaved(saved, 'eins', t0 + 81_000)
  assert.equal(saved.document.words, 1)
  assert.equal(saved.document.peakWords, 3)
  assert.equal(saved.document.wordsRemoved, 2)
  assert.equal(saved.saveCount, 2)
  assert.equal(saved.lastSavedAt, new Date(t0 + 81_000).toISOString())

  /* ---- persist bookkeeping ---- */
  assert.equal(pageStatsNeedPersist(saved), true)
  const persisted = markPageStatsPersisted(saved)
  assert.equal(pageStatsNeedPersist(persisted), false)
  const laterTick = tickPageStats({ ...persisted, active: true, sessionStartedAt: t0 + 90_000 }, t0 + 92_000, true)
  assert.equal(pageStatsNeedPersist(laterTick, 3_000), false)
  assert.equal(pageStatsNeedPersist(laterTick, 1_000), true)

  /* ---- close and round trip ---- */
  const closed = closePageStats(saved, t0 + 100_000)
  assert.equal(closed.dwellMs, 8_000)
  assert.equal(closed.lastClosedAt, new Date(t0 + 100_000).toISOString())
  assert.equal(Number.isFinite(Date.parse(closed.createdAt)), true)
  assert.equal(Number.isFinite(Date.parse(closed.modifiedAt)), true)
  assert.equal('active' in closed, false, 'session-only fields never reach the disk')
  assert.equal('revision' in closed, false)
  assert.equal('typingBurstStartedAtMs' in closed, false)

  const persistedNote = writePageStatsIntoNote('# Hello\n', closed)
  const reloaded = readPageStatsFromNote(persistedNote, t0 + 130_000)
  assert.deepEqual(reloaded, closed, 'the full record must survive the .famd round trip')
  assert.deepEqual(parsePageStats(JSON.parse(JSON.stringify(reloaded))), reloaded, 'parsing is idempotent')
  assert.equal(JSON.stringify(parsePageStats(reloaded)), JSON.stringify(reloaded), 'key order is stable for sameJson checks')
  assert.match(persistedNote, /"schema":"fanotes-famd-v1"/u)
  const visible = stripFamdPayload(persistedNote)
  assert.equal(visible.includes('fanotes-famd'), false)
  assert.equal(visible.includes('"schema"'), false)
  assert.equal(visible.includes('"ink":null'), false)
  assert.match(visible, /^# Hello/u)
  assert.equal(stripFamdPayload('{"schema":"fanotes-famd-v1","updatedAt":"2026-09-07T00:00:00.000Z","ink":null,"worksheets":[]}'), '')
  assert.match(formatPageDwell(8_000), /8 s/)

  /* ---- legacy record ---- */
  const legacy = parsePageStats({
    createdAt: '2026-01-02T10:00:00.000Z',
    modifiedAt: '2026-02-03T11:00:00.000Z',
    dwellMs: 12000,
    lastOpenedAt: '2026-02-03T11:00:00.000Z',
    openCount: 4,
  })
  assert.equal(legacy.createdAt, '2026-01-02T10:00:00.000Z')
  assert.equal(legacy.dwellMs, 12000)
  assert.equal(legacy.openCount, 4)
  assert.equal(legacy.firstOpenedAt, '2026-01-02T10:00:00.000Z')
  assert.equal(legacy.typing.keystrokes, 0)
  assert.equal(legacy.ink.strokes, 0)
  assert.equal(legacy.opensByHour.length, 24)
  assert.equal(parsePageStats({ createdAt: closed.createdAt }).createdAt, closed.createdAt)
  const reopened = openPageStats(idlePageStatsSession(legacy), t0 + 200_000)
  assert.equal(reopened.openCount, 5)
  assert.equal(reopened.dwellMs, 12000)
  assert.equal(reopened.persistedDwellMs, 12000, 'a fresh session starts with its dwell already on disk')

  return { createdAt: closed.createdAt, dwellMs: closed.dwellMs, openCount: closed.openCount, strokes: closed.ink.strokes, words: closed.document.words }
}

/* ---- the app records quietly: no UI shows the dwell, every activity path reports ---- */
const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')
assert.equal(app.includes('Auf der Seite {formatPageDwell('), false, 'the status bar must not show the dwell time')
assert.equal(app.includes('setActivePageStats'), false, 'page stats never live in React state (the tick would re-render the app every second)')
for (const needle of ['recordEditActivityFor(activeTab.path', 'recordEditActivityFor(splitTab.path', 'onInkActivity={handleInkActivity}', 'recordInkSnapshotFor(notePath, inkSummary)', 'recordDocumentSaved(session, body, now)', 'persistPageStatsQuietly(', 'queuePageStatsWrite(tab.path)']) {
  assert.ok(app.includes(needle), `App.tsx must contain ${needle}`)
}
const inspector = readFileSync(new URL('../src/components/RightInspector.tsx', import.meta.url), 'utf8')
assert.equal(inspector.includes('pageStats'), false, 'the inspector no longer shows page statistics')
const editor = readFileSync(new URL('../src/components/MarkdownEditor.tsx', import.meta.url), 'utf8')
assert.ok(editor.includes('editActivityFromTransaction(transaction)'), 'the editor reports every user transaction')
const board = readFileSync(new URL('../src/components/DrawingBoard.tsx', import.meta.url), 'utf8')
assert.ok(board.includes('noteStrokeDrawn(stroke)'), 'every committed stroke is reported')
assert.equal((board.match(/noteStrokesErased\(/g) ?? []).length >= 3, true, 'eraser, scribble erase and selection delete report erased strokes')
assert.ok(board.includes('inkSummary: summarizeInkStrokes(strokesRef.current, page.width, page.height)'), 'the saved layer carries its summary')

try {
  const first = runOnce()
  const second = runOnce()
  assert.deepEqual(first, second)
  console.log(JSON.stringify(first))
  console.log('page-stats ok')
} finally {
  await server.close()
}
