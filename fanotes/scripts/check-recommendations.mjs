// The twenty recommendations: pure behaviour, plus the wiring that keeps them reachable.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

const appRoot = fileURLToPath(new URL('..', import.meta.url))
const require = createRequire(import.meta.url)
const read = (relative) => readFileSync(new URL(`../${relative}`, import.meta.url), 'utf8')

const server = await createServer({
  root: appRoot,
  appType: 'custom',
  logLevel: 'error',
  optimizeDeps: { noDiscovery: true },
  server: { middlewareMode: true },
})

const load = (path) => server.ssrLoadModule(path)

try {
  const anchor = await load('/src/lib/searchInkAnchor.ts')
  const transcript = `${anchor.formatTranscriptLine(0.2, 'Integral')}\n${anchor.formatTranscriptLine(0.8, 'Wurzel')}`
  assert.equal(anchor.inkAnchorForQuery(transcript, 'wurzel').y, 0.8)
  assert.equal(anchor.scrollTopForNormalizedY(1000, 200, 0.8), 700)
  assert.equal(anchor.inkAnchorForQuery('eine Zeile\nzweite Zeile', 'zweite').y, 1)
  const cjs = require('../electron/search-ink.cjs')
  assert.equal(cjs.inkAnchorForQuery(transcript, 'wurzel').y, 0.8)

  const sections = await load('/src/lib/inkSectionMarkdown.ts')
  const markdown = '# Aufgabe 1\n\nText\n\n## Aufgabe 2\n\nMehr\n'
  assert.equal(sections.headingLineForSection(markdown, 0), 1)
  assert.equal(sections.headingLineForSection(markdown, 1), 5)
  assert.equal(sections.headingLineForSection(markdown, 4), null)

  const conflict = await load('/src/lib/sync/markdownConflict.ts')
  const rows = conflict.diffLines('a\nb\n', 'a\nc\n')
  assert.ok(rows.some((row) => row.kind === 'removed' && row.text === 'b'))
  assert.ok(rows.some((row) => row.kind === 'added' && row.text === 'c'))
  assert.match(conflict.mergeMarkdownKeepingBoth('Remote Absatz', 'Remote Absatz\n\nLokaler Absatz'), /Lokaler Absatz/)
  assert.equal(conflict.resolveMarkdownConflict('remote', 'local', 'local'), 'local')
  assert.equal(conflict.isMarkdownConflictPath('a.md'), true)
  assert.equal(conflict.isMarkdownConflictPath('a.pdf'), false)

  const folders = await load('/src/lib/sync/folderSync.ts')
  assert.deepEqual(folders.syncPrefixesFromSetting('Physik/Buch\nChemie'), ['Physik/Buch', 'Chemie'])
  assert.equal(folders.pathIsSyncExcluded('Physik/Buch/1.pdf', ['Physik/Buch']), true)
  assert.equal(folders.pathIsSyncExcluded('Physik/Notiz.md', ['Physik/Buch']), false)
  assert.equal(folders.toggleSyncPrefix('Physik/Buch', 'Physik/Buch'), '')

  const engine = await load('/src/lib/sync/engine.ts')
  assert.equal(engine.isSyncablePath('.fanotes/recognition-model.json'), false)
  assert.equal(engine.isSyncablePath('.fanotes/recognition-model.json', { includeRecognitionModel: true }), true)
  assert.equal(engine.isSyncablePath('.fanotes/history/abc/index.json'), false)
  assert.equal(engine.isSyncablePath('.fanotes/history/abc/index.json', { includeHistory: true }), true)
  assert.equal(engine.isSyncablePath('Physik/Buch/seite.pdf', { excludedPrefixes: ['Physik/Buch'] }), false)
  assert.equal(engine.isSyncablePath('Physik/Notiz.md', { excludedPrefixes: ['Physik/Buch'] }), true)

  const bundle = await load('/src/lib/sync/recognitionModelBundle.ts')
  const packed = bundle.serializeRecognitionBundle(bundle.rememberCorrection(bundle.emptyRecognitionBundle(), 'Tost', 'Test'))
  const parsed = bundle.parseRecognitionBundle(packed)
  assert.equal(bundle.correctionFor(parsed, 'tost'), 'Test')

  const study = await load('/src/lib/studyOverview.ts')
  const overview = study.aggregateStudy([
    { path: 'Mathe/a.md', stats: { dwellMs: 120000, focusMs: 0, dwellByWeekday: [0, 120000, 0, 0, 0, 0, 0], typing: { ms: 30000 }, ink: { ms: 90000, lengthMm: 40 } } },
    { path: 'Deutsch/b.md', stats: { dwellMs: 60000, focusMs: 0, dwellByWeekday: [0, 0, 60000, 0, 0, 0, 0], typing: { ms: 60000 }, ink: { ms: 0, lengthMm: 0 } } },
  ])
  assert.equal(overview.subjects[0].subject, 'Mathe')
  assert.equal(overview.dwellByWeekday[1], 120000)
  assert.match(study.formatStudyDuration(120000), /2 min/)

  const homework = await load('/src/lib/homeworkCalendar.ts')
  const calendar = await load('/src/lib/calendarModel.ts')
  const synced = homework.applyHomeworkToCalendar(calendar.emptyCalendarDocument(), {
    version: 1,
    tasks: [{ id: 't1', title: 'Seite 4', notes: '', subject: 'Mathe', dueDate: '2026-10-12', dueTime: null, done: false, kind: 'homework', priority: 'normal', createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z' }],
  })
  assert.ok(synced.calendars.some((entry) => entry.name === 'Hausaufgaben'))
  assert.ok(synced.events.some((event) => event.id === 'hw:t1' && event.title === 'Seite 4'))
  const done = homework.applyHomeworkToCalendar(synced, {
    version: 1,
    tasks: [{ id: 't1', title: 'Seite 4', notes: '', subject: 'Mathe', dueDate: '2026-10-12', dueTime: null, done: true, kind: 'homework', priority: 'normal', createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z' }],
  })
  assert.ok(done.events.some((event) => event.id === 'hw:t1' && event.title.startsWith('✓')))

  const ics = await load('/src/lib/icsCalendar.ts')
  const exported = ics.exportIcs(synced)
  assert.match(exported, /BEGIN:VCALENDAR/)
  assert.match(exported, /SUMMARY:Seite 4/)
  const imported = ics.importIcs('BEGIN:VCALENDAR\nBEGIN:VEVENT\nUID:abc\nSUMMARY:Probe\nDTSTART;VALUE=DATE:20261020\nDTEND;VALUE=DATE:20261021\nRRULE:FREQ=WEEKLY\nEND:VEVENT\nEND:VCALENDAR\n', synced.calendars[0].id)
  assert.equal(imported[0].title, 'Probe')
  assert.equal(imported[0].recurrence, 'weekly')

  const reminders = await load('/src/lib/calendarReminders.ts')
  const baseCalendar = calendar.emptyCalendarDocument()
  const soon = calendar.createEvent({
    calendarId: baseCalendar.calendars[0].id,
    title: 'Jetzt',
    start: new Date(Date.now() + 5 * 60_000),
    end: new Date(Date.now() + 35 * 60_000),
  })
  const withSoon = calendar.upsertEvent(baseCalendar, soon)
  assert.ok(reminders.dueReminders(withSoon, new Date(), 15).some((item) => item.title === 'Jetzt'))

  const french = await load('/src/lib/frenchLexicon.ts')
  assert.equal(french.isFrenchWord('école'), true)
  assert.equal(french.isFrenchWord('eleve'), true)
  const german = await load('/src/lib/germanRecognition.ts')
  assert.equal(german.repairGermanToken('Maedchen'), 'mädchen')
  assert.equal(german.repairGermanLine('Maedchen schreibt'), 'Mädchen schreibt')
  const polish = await load('/src/lib/recognitionPolish.ts')
  assert.equal(polish.modelLanguageFor('fr'), 'en')
  assert.equal(polish.polishRecognizedText('Maedchen', 'de'), 'Mädchen')

  const math = await load('/src/lib/mathSolver.ts')
  const stepped = math.solveMathExpression('2*x+4=0', 'step')
  assert.equal(stepped.steps.length, 1)
  assert.notEqual(stepped.steps[0].expression, '2*x+4=0')

  const lasso = await load('/src/lib/inkLasso.ts')
  const square = [{ x: 0.1, y: 0.1 }, { x: 0.5, y: 0.1 }, { x: 0.5, y: 0.5 }, { x: 0.1, y: 0.5 }]
  const strokes = [
    { color: '#202333', points: [{ x: 0.2, y: 0.2 }, { x: 0.3, y: 0.3 }] },
    { color: '#202333', points: [{ x: 0.8, y: 0.8 }, { x: 0.9, y: 0.9 }] },
  ]
  const inside = lasso.strokesInsideLasso(strokes, square)
  assert.deepEqual(inside, [0])
  const moved = lasso.applyLasso(strokes, inside, 'move', { dx: 0.1, dy: 0 })
  assert.ok(Math.abs(moved[0].points[0].x - 0.3) < 1e-9)
  assert.equal(lasso.applyLasso(strokes, inside, 'delete').length, 1)
  assert.equal(lasso.applyLasso(strokes, inside, 'recolor', { color: '#ff0000' })[0].color, '#ff0000')
  assert.equal(lasso.applyLasso(strokes, inside, 'copy', { dx: 0.05, dy: 0.05 }).length, 3)

  const templates = await load('/src/lib/noteTemplates.ts')
  assert.ok(templates.templatesForProfile('school').some((template) => template.id === 'protocol'))
  assert.ok(templates.templatesForProfile('university').some((template) => template.id === 'proof'))
  assert.equal(templates.templatesToSeed(['Vorlagen/Protokoll.md'], 'school').length, 0)
  assert.ok(templates.templatesToSeed([], 'work').some((template) => template.id === 'meeting'))

  const links = await load('/src/lib/backlinks.ts')
  const found = links.backlinksFor('Mathe/Algebra.md', [
    { path: 'Deutsch/Text.md', content: 'Siehe [[Algebra]] im Heft.' },
    { path: 'Mathe/Algebra.md', content: 'Selbst.' },
  ])
  assert.equal(found.length, 1)
  assert.equal(found[0].path, 'Deutsch/Text.md')

  const marks = await load('/src/lib/pdfTextMarks.ts')
  const withMark = marks.writePdfMarks('# PDF\n', marks.addPdfMark([], { page: 2, quote: 'der Satz', kind: 'highlight' }))
  assert.equal(marks.readPdfMarks(withMark)[0].quote, 'der Satz')
  assert.equal(marks.readPdfMarks(withMark)[0].page, 2)
  assert.match(withMark, /der Satz/)

  const diff = await load('/src/lib/markdownDiff.ts')
  const changed = diff.diffNoteLines('alt\n', 'neu\n')
  assert.ok(changed.some((row) => row.kind === 'removed' && row.text === 'alt'))
  assert.equal(diff.timelineHasInk('<!-- fanotes-ink:abc -->'), true)

  const cards = await load('/src/lib/flashcards.ts')
  const note = '## Lernfragen\n\n<details><summary>Was ist 2+2?</summary>4</details>\n'
  const deck = cards.cardsFromMarkdown(note, new Date('2026-10-08T12:00:00Z'))
  assert.equal(deck[0].front, 'Was ist 2+2?')
  const reviewed = cards.reviewCard(deck[0], 'good', new Date('2026-10-08T12:00:00Z'))
  assert.ok(reviewed.due > '2026-10-08')
  const saved = cards.embedCards(note, [reviewed])
  assert.equal(cards.parseStoredCards(saved)[0].front, 'Was ist 2+2?')

  const margin = await load('/src/lib/marginTranscript.ts')
  const lines = margin.marginLinesFromTranscript(transcript)
  assert.equal(lines[1].text, 'Wurzel')
  assert.equal(margin.replaceTranscriptWord('0.2000\tTost bleibt', 'Tost', 'Test').includes('Test'), true)

  const ink = await load('/src/lib/addonInk.ts')
  const clean = ink.sanitizeAddonStrokes([{ color: '#112233', points: [{ x: 0.1, y: 0.2 }, { x: 2, y: -1 }] }])
  assert.equal(clean[0].points[1].x, 1)
  assert.equal(clean[0].points[1].y, 0)
  const document = JSON.parse(ink.inkDocumentWithStrokes(null, clean, 'replace'))
  assert.equal(document.strokes.length, 1)

  const app = read('src/App.tsx')
  const board = read('src/components/DrawingBoard.tsx')
  const editor = read('src/components/MarkdownEditor.tsx')
  const pkg = JSON.parse(read('package.json'))
  assert.match(app, /SplitInkEditor/)
  assert.match(app, /onSectionFold/)
  assert.match(app, /includeRecognitionModel/)
  assert.match(app, /syncExcludedFolders/)
  assert.match(app, /StudyOverview/)
  assert.match(app, /FlashcardReview/)
  assert.match(app, /id: 'study'/)
  assert.match(app, /readPdfMarks/)
  assert.match(board, /Nächster Schritt/)
  assert.match(board, /commitLasso/)
  assert.match(board, /MarginTranscript/)
  assert.match(editor, /foldHeading/)
  assert.ok(pkg.build.mac.target.some((target) => target.target === 'dmg'))
  assert.match(pkg.scripts['dist:mac'], /--mac/)
  assert.match(read('src/lib/addons/protocol.ts'), /'ink.write': 'ink:write'/)
  assert.match(read('src/lib/addons/protocol.ts'), /'recognition.run': 'recognition'/)
  assert.match(read('src/lib/addons/protocol.ts'), /'calendar.write': 'calendar:write'/)
  assert.match(read('src/lib/addons/protocol.ts'), /'homework.write': 'homework:write'/)
  assert.match(read('src/components/SyncSettingsSection.tsx'), /Zusammenführen/)
  assert.match(read('src/components/CalendarView.tsx'), /exportIcs/)
  assert.match(read('src/components/HomeworkBoard.tsx'), /calendarMarkdownWithHomework/)
  assert.match(read('packaging/INSTALL_MAC.md'), /dist:mac/)

  console.log('recommendations ok')
} finally {
  await server.close()
}
