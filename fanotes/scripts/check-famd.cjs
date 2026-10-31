'use strict'

const assert = require('node:assert/strict')
const {
  companionNotePath,
  emptyFamdPayload,
  parseFamd,
  parseNoteBackups,
  parseNoteLinks,
  parseNoteTextFields,
  readFamdCompanion,
  serializeFamd,
  stripFamdPayload,
  worksheetIdsFromMarkdown,
} = require('../electron/famd.cjs')

const markdown = '# Analysis\n\n$$\\int x$$\n\n<!-- fanotes-ink:abc -->\n<!-- fanotes-worksheet:ws-1 -->\n'
const ink = {
  schemaVersion: 1,
  title: 'Handschrift',
  strokes: [{ points: [{ x: 0.2, y: 0.3, t: 1, pressure: 0.5 }] }],
  searchTranscript: 'integral',
}
const noteLinks = [{
  id: 'nl-famd-check',
  sourcePath: 'Mathe/Skript.pdf',
  targetPath: 'Mathe/Skript-Notiz.md',
  page: 3,
  x: 0.72,
  y: 0.18,
  style: 'text',
  label: 'Skript-Notiz',
}]
const noteBackups = [{
  id: 'nb-famd-check',
  notePath: 'Mathe/Analysis.md',
  createdAt: '2026-08-19T12:00:00.000Z',
  content: 'Stand A',
}]
const encoded = serializeFamd(markdown, {
  ...emptyFamdPayload('2026-08-14T12:00:00.000Z'),
  ink,
  worksheets: worksheetIdsFromMarkdown(markdown),
  noteLinks,
  noteBackups,
})

assert.match(encoded, /<!-- fanotes-famd:v1 chars=\d+ -->/u)
assert.equal(stripFamdPayload(encoded).includes('fanotes-famd'), false)
assert.equal(stripFamdPayload(encoded).includes('"schema"'), false)
assert.ok(stripFamdPayload(encoded).includes('# Analysis'))
assert.equal(
  stripFamdPayload('{"schema":"fanotes-famd-v1","updatedAt":"2026-09-07T00:00:00.000Z","ink":null,"worksheets":[]}'),
  '',
)
assert.equal(
  stripFamdPayload('# Hello\n\n{"schema":"fanotes-famd-v1","updatedAt":"2026-09-07T00:00:00.000Z","ink":null,"worksheets":[]}'),
  '# Hello',
)

const parsed = parseFamd(encoded)
assert.equal(parsed.payload?.schema, 'fanotes-famd-v1')
assert.equal(parsed.payload?.ink?.title, 'Handschrift')
assert.deepEqual(parsed.payload?.worksheets, ['ws-1'])
assert.equal(parsed.payload?.noteLinks?.[0]?.targetPath, 'Mathe/Skript-Notiz.md')
assert.equal(parsed.payload?.noteLinks?.[0]?.page, 3)
assert.equal(parsed.payload?.noteLinks?.[0]?.style, 'text')
assert.equal(parsed.payload?.noteBackups?.[0]?.content, 'Stand A')
assert.equal(parsed.markdown.includes('$$\\int x$$'), true)
assert.equal(companionNotePath('Mathe/Analysis.md', '.famd'), 'Mathe/Analysis.famd')
assert.equal(companionNotePath('Mathe/Analysis.famd', '.md'), 'Mathe/Analysis.md')
assert.equal(companionNotePath('Mathe/Skript.pdf', '.famd'), 'Mathe/Skript.famd')

const richPageStats = {
  version: 2,
  createdAt: '2026-01-02T03:04:05.000Z',
  modifiedAt: '2026-01-02T03:04:05.000Z',
  lastOpenedAt: '2026-01-02T03:05:05.000Z',
  dwellMs: 1500.9,
  openCount: 2.2,
  typing: { wordsAdded: 4, wordsRemoved: 1 },
  document: { words: 10 },
}
const richEncoded = serializeFamd('# Hi\n', {
  ...emptyFamdPayload('2026-01-02T03:04:05.000Z'),
  pageStats: richPageStats,
})
const richStats = parseFamd(richEncoded).payload?.pageStats
assert.equal(richStats?.typing?.wordsAdded, 4)
assert.equal(richStats?.document?.words, 10)
assert.equal(richStats?.dwellMs, 1500)
assert.equal(richStats?.openCount, 2)
assert.equal(richStats?.version, 2)
const bareStats = serializeFamd('', {
  ...emptyFamdPayload('2026-01-02T03:04:05.000Z'),
  pageStats: { words: 2 },
})
assert.equal(bareStats.includes('pageStats'), false)

const poisoned = `${encoded}\n<!-- fanotes-famd:v1 chars=2 -->\n{}`
const last = parseFamd(poisoned)
assert.equal(last.payload, null)

const fs = require('node:fs')
const path = require('node:path')
const main = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.cjs'), 'utf8')
const preload = fs.readFileSync(path.join(__dirname, '..', 'electron', 'preload.cjs'), 'utf8')
const app = fs.readFileSync(path.join(__dirname, '..', 'src', 'App.tsx'), 'utf8')
assert.match(app, /const visibleContent = stripFamdPayload\(nextContent\)/u)
// The editor keeps the text as typed (a trimmed body pushed back moved the cursor);
// only the saved snapshot follows the write, and never with the embedded payload.
assert.match(app, /savedContent: tab\.content === content \? content : visibleContent/u)
assert.doesNotMatch(app, /savedContent: nextContent/u)
assert.doesNotMatch(app, /content: tab\.content === content \? nextContent : tab\.content/u)
assert.doesNotMatch(app, /pendingWrites\.current\.set\(path, writePageStatsIntoNote/u)
assert.match(main, /fanotes:read-famd-ink/u)
assert.match(main, /fanotes:import-pdf-note/u)
assert.match(main, /writeFamdCompanion/u)
assert.match(main, /omitFamdCompanions/u)
assert.match(preload, /readFamdInk:\s*\(relativePath\)/u)
assert.match(app, /readFamdInk/u)
assert.match(app, /noteRelativePath/u)
assert.match(main, /fanotes:move-entry/u)
const readOptional = main.slice(main.indexOf('async function readOptionalNoteFile'), main.indexOf('async function writeFamdCompanion'))
assert.match(readOptional, /if \(error\?\.code === 'ENOENT'\) return null/u)
assert.match(readOptional, /throw error/u)
assert.doesNotMatch(readOptional, /return null\s*\}\s*$/u)
const paperStyleWrite = main.slice(main.indexOf('handle(IPC.setNotePaperStyle'), main.indexOf('handle(IPC.readNoteLinks'))
assert.match(paperStyleWrite, /return mutateFamdCompanion\(notePath/u)
assert.doesNotMatch(paperStyleWrite, /atomicWrite\(/u)
const linkWrite = main.slice(main.indexOf('handle(IPC.writeNoteLinks'), main.indexOf('handle(IPC.readNoteBackups'))
assert.match(linkWrite, /mutateFamdCompanion\(notePath/u)
assert.doesNotMatch(linkWrite, /atomicWrite\(/u)
const backupWrite = main.slice(main.indexOf('handle(IPC.writeNoteBackups'), main.indexOf('handle(IPC.readSubjectBooks'))
assert.match(backupWrite, /mutateFamdCompanion\(notePath/u)
assert.doesNotMatch(backupWrite, /atomicWrite\(/u)
const textFieldWrite = main.slice(main.indexOf('handle(IPC.writeNoteTextFields'), main.indexOf('handle(IPC.readSubjectBooks'))
assert.match(textFieldWrite, /parseNoteTextFields\(rawFields\)/u)
assert.match(textFieldWrite, /mutateFamdCompanion\(notePath/u)
assert.doesNotMatch(textFieldWrite, /atomicWrite\(/u)
assert.match(main, /textFields: loaded\.textFields/u)
const drawingSave = main.slice(main.indexOf('handle(IPC.saveDrawing'), main.indexOf('handle(IPC.listDrawings'))
const inkEmbed = drawingSave.slice(drawingSave.indexOf('queueFileWrite(famdTarget'))
assert.ok(inkEmbed.indexOf('readOptionalNoteFile') > inkEmbed.indexOf('queueFileWrite(famdTarget'))
const folderColors = main.slice(main.indexOf('async function readFolderColors'), main.indexOf('async function writeFolderColors'))
assert.match(folderColors, /if \(error\?\.code === 'ENOENT'\) return new Map\(\)/u)
assert.match(folderColors, /throw error/u)
assert.doesNotMatch(folderColors, /return new Map\(\)\s*\}\s*$/u)
const subjectBooks = main.slice(main.indexOf('async function readSubjectBooksFromVault'), main.indexOf('async function writeSubjectBooksToVault'))
assert.match(subjectBooks, /if \(error\?\.code === 'ENOENT'\) return \[\]/u)
assert.match(subjectBooks, /throw error/u)
assert.match(main, /const companionInk = incomingInk && typeof incomingInk === 'object' \? incomingInk : undefined/u)
assert.match(app, /readNoteInk\(path, markdown\)/u)
assert.match(app, /subjectBooksLoadedRef/u)
assert.match(app, /Die Fachbücher konnten nicht gelesen werden\. Es wurde nichts überschrieben\./u)
assert.doesNotMatch(app, /subjectBooksDiskRef\.current = \[\]/u)
assert.match(preload, /moveEntry:\s*\(relativePath, destFolder\)/u)
assert.match(app, /onMove=\{moveEntry\}/u)
assert.match(main, /readNotePageStats: 'fanotes:read-note-page-stats'/u)
assert.match(preload, /readNotePageStats:\s*\(relativePath\)/u)
assert.match(app, /readNotePageStats/u)
assert.match(app, /pageStatsUnreadableRef/u)
assert.match(app, /remapPageStats\(path, nextPath\)/u)
assert.match(app, /if \(hit\.notePath\)/u)
const writeFileHandler = main.slice(main.indexOf('handle(IPC.writeFile'), main.indexOf('handle(IPC.createNote'))
assert.match(writeFileHandler, /await writeFamdCompanion\(normalizedRelativePath, content, companionInk/u)
assert.doesNotMatch(writeFileHandler, /Begleiter konnte nicht geschrieben werden/u)
const searchHandler = main.slice(main.indexOf('handle(IPC.search'), main.indexOf('handle(IPC.saveDrawing'))
assert.match(searchHandler, /rememberDrawingOwner\(drawingOwners/u)
assert.match(searchHandler, /const notePath = drawingOwners\.get\(id\)/u)
assert.match(app, /activeWorksheetMarkerKey/u)
assert.match(app, /const restored = stripFamdPayload\(raw\)/u)
assert.match(app, /pendingHistoryInkRef/u)
assert.match(app, /pageStatsRef\.current\.delete\(path\)/u)
assert.match(app, /drawingLoadRequestRef\.current/u)

const readNoteTabSource = app.slice(app.indexOf('const readNoteTab = useCallback'), app.indexOf('const installCompanionPageStats'))
assert.match(readNoteTabSource, /stripFamdPayload\(await window\.fanotes\.readFile\(companionNotePath\(path, '\.famd'\)\)\)/u)
assert.match(readNoteTabSource, /stripFamdPayload\(await window\.fanotes\.readFile\(path\)\)/u)
assert.doesNotMatch(readNoteTabSource, /parseFamd|readNotePageStats|preparePageStats|readNoteCompanion/u)
const loaderSource = app.slice(app.indexOf('const loadNoteCompanion = useCallback'), app.indexOf('const revealOpenedNote = useCallback'))
assert.match(loaderSource, /readNoteCompanion\(path\)/u)
assert.doesNotMatch(loaderSource, /readNotePageStats|readNotePaperStyle|readNoteLinks|readNoteBackups|readFamdInk|readNoteTextFields/u)
assert.match(app, /NoteTextFieldLayer/u)
assert.match(app, /writeNoteTextFields/u)
assert.match(app, /is-placing-text-field/u)
const revealSource = app.slice(app.indexOf('const revealOpenedNote = useCallback'), app.indexOf('const openNote = useCallback'))
assert.match(revealSource, /setActivePath\(path\)/u)
assert.match(revealSource, /void loadNoteCompanion\(path\)/u)
assert.doesNotMatch(revealSource, /await /u)
const openSource = app.slice(app.indexOf('const openNote = useCallback'), app.indexOf('const restoreWorkspace = useCallback'))
assert.equal(openSource.match(/revealOpenedNote\(/g).length, 2)
assert.doesNotMatch(openSource, /await preparePageStats/u)
assert.doesNotMatch(openSource, /await loadNoteCompanion/u)
assert.match(main, /readNoteCompanion: 'fanotes:read-note-companion'/u)
assert.match(preload, /readNoteCompanion:\s*\(relativePath\)/u)
assert.match(main, /readFamdCompanion\(source\)/u)
const famdInkRead = main.slice(main.indexOf('handle(IPC.readFamdInk'), main.indexOf('handle(IPC.readNotePaperStyle'))
assert.match(famdInkRead, /noteInkMarkerId\(parsed\.markdown\)/u)
assert.match(famdInkRead, /markerId \?\? /u)
assert.doesNotMatch(famdInkRead, /validateDrawingJson\(drawingJson\)/u)

const points = Array.from({ length: 4000 }, (_, index) => ({ x: index / 4000, y: 0.25, t: index, pressure: 0.4 }))
const heavyInk = {
  schemaVersion: 1,
  title: 'Handschrift',
  strokes: [{ points }],
  paperStyle: 'squares',
}
const heavyStats = {
  version: 2,
  createdAt: '2026-03-01T08:00:00.000Z',
  modifiedAt: '2026-03-01T09:00:00.000Z',
  lastOpenedAt: '2026-03-01T09:30:00.000Z',
  dwellMs: 2400,
  openCount: 6,
  typing: { wordsAdded: 4, wordsRemoved: 1 },
  document: { words: 12 },
}
const heavyLink = {
  id: 'nl-open-check',
  sourcePath: 'Mathe/Skript.pdf',
  targetPath: 'Mathe/Skript-Notiz.md',
  page: 2,
  x: 0.4,
  y: 0.6,
  style: 'text',
  label: 'Skript-Notiz',
}
const heavyBackup = {
  id: 'nb-open-check',
  notePath: 'Mathe/Analysis.md',
  createdAt: '2026-03-01T08:30:00.000Z',
  content: 'Stand vor dem Öffnen',
}
const heavyField = {
  id: 'tf-open-check',
  page: 1,
  x: 0.25,
  y: 0.5,
  width: 0.32,
  fontSize: 18,
  text: 'Neben dem Text',
}
const heavyBody = '# Instant\n\nThe note text is already here.\n'
const heavyEncoded = serializeFamd(heavyBody, {
  ...emptyFamdPayload('2026-03-01T08:00:00.000Z'),
  ink: heavyInk,
  paperStyle: 'squares',
  pageStats: heavyStats,
  noteLinks: [heavyLink],
  noteBackups: [heavyBackup],
  textFields: [heavyField],
})
const originalJsonParse = JSON.parse
const countParses = (run) => {
  let count = 0
  JSON.parse = (...args) => {
    count += 1
    return originalJsonParse.apply(JSON, args)
  }
  try {
    const value = run()
    return { count, value }
  } finally {
    JSON.parse = originalJsonParse
  }
}
const stripped = countParses(() => stripFamdPayload(heavyEncoded))
assert.equal(stripped.count, 0)
assert.equal(stripped.value, '# Instant\n\nThe note text is already here.')
assert.equal(stripped.value.includes('fanotes-famd'), false)
const opened = countParses(() => readFamdCompanion(heavyEncoded))
assert.equal(opened.count, 1)
assert.equal(opened.value.markdown, stripped.value)
assert.equal(opened.value.ink.strokes[0].points.length, 4000)
assert.equal(opened.value.ink.title, 'Handschrift')
assert.equal(opened.value.paperStyle, 'squares')
assert.equal(opened.value.pageStats.dwellMs, 2400)
assert.equal(opened.value.pageStats.openCount, 6)
assert.equal(opened.value.pageStats.typing.wordsAdded, 4)
assert.equal(opened.value.pageStats.document.words, 12)
assert.equal(opened.value.pageStats.version, 2)
assert.deepEqual(opened.value.noteLinks, parseNoteLinks([heavyLink]))
assert.deepEqual(opened.value.noteBackups, parseNoteBackups([heavyBackup]))
assert.deepEqual(opened.value.textFields, parseNoteTextFields([heavyField]))
const emptySaved = serializeFamd('Hallo\n', emptyFamdPayload('2026-01-02T00:00:00.000Z'))
assert.equal(emptySaved.includes('textFields'), false)
const repaired = parseNoteTextFields([{ page: 'nope', x: 4, y: -2, width: 9, fontSize: 3, text: 'x'.repeat(8001) }, null, 1])
assert.equal(repaired.length, 1)
assert.equal(repaired[0].page, 1)
assert.equal(repaired[0].x, 1)
assert.equal(repaired[0].y, 0)
assert.equal(repaired[0].width, 0.92)
assert.equal(repaired[0].fontSize, 16)
assert.equal(repaired[0].text.length, 8000)
assert.equal(parseNoteTextFields(Array.from({ length: 205 }, (_, index) => ({ id: `tf-${index}`, text: 'a' }))).length, 200)
const cleared = serializeFamd('Hallo\n', { ...parseFamd(serializeFamd('Hallo\n', { ...emptyFamdPayload('2026-01-02T00:00:00.000Z'), textFields: [heavyField] })).payload, textFields: [] })
assert.equal(cleared.includes('textFields'), false)
const payloadBytes = Buffer.byteLength(heavyEncoded, 'utf8')
console.log(`payload size ${payloadBytes}`)
console.log(`strip parse count ${stripped.count}`)
console.log(`companion parse count ${opened.count}`)

const os = require('node:os')
const fsp = require('node:fs/promises')
const crypto = require('node:crypto')
const { recordNoteHistorySnapshot, listNoteHistory, readNoteHistory, pruneVaultHistory } = require('../electron/note-history.cjs')
const { SHORT_INTERVAL_MS, SHORT_RETENTION_MS, WEEK_INTERVAL_MS } = require('../electron/noteHistoryPolicy.mjs')
const { createAddonStore } = require('../electron/addons.cjs')

async function assertUnreadableRecordsStayPut() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'fanotes-read-failure-'))
  try {
    const started = Date.parse('2026-03-01T00:00:00.000Z')
    await recordNoteHistorySnapshot(root, 'Note.md', 'first revision\n', { now: started })
    await recordNoteHistorySnapshot(root, 'Note.md', 'second revision\n', { now: started + SHORT_INTERVAL_MS })
    assert.equal((await listNoteHistory(root, 'Note.md', started + SHORT_INTERVAL_MS)).length, 2)
    const historyDir = path.join(root, '.fanotes', 'history', crypto.createHash('sha1').update('Note.md').digest('hex'))
    const index = path.join(historyDir, 'index.json')
    const snapshotCount = async () => (await fsp.readdir(historyDir)).filter((name) => name.endsWith('.md') || name.endsWith('.famd')).length
    await fsp.chmod(index, 0)
    await assert.rejects(recordNoteHistorySnapshot(root, 'Note.md', 'third revision\n', { now: started + SHORT_INTERVAL_MS * 2 }), { code: 'EACCES' })
    await fsp.chmod(index, 0o600)
    assert.equal((await listNoteHistory(root, 'Note.md', started + SHORT_INTERVAL_MS)).length, 2)
    assert.equal(await snapshotCount(), 2, 'Ein fehlgeschlagener Index darf keine verwaiste Verlaufsdatei hinterlassen.')

    const cadence = started
    await recordNoteHistorySnapshot(root, 'Long.md', 'week\n', { now: cadence })
    await recordNoteHistorySnapshot(root, 'Long.md', 'too soon\n', { now: cadence + 60_000 })
    await recordNoteHistorySnapshot(root, 'Long.md', 'half day\n', { now: cadence + SHORT_INTERVAL_MS })
    let history = await listNoteHistory(root, 'Long.md', cadence + SHORT_INTERVAL_MS)
    assert.equal(history.length, 2)
    assert.equal((await readNoteHistory(root, 'Long.md', history[0].id)).content, 'half day\n')
    assert.equal((await readNoteHistory(root, 'Long.md', history[1].id)).content, 'week\n')
    history = await listNoteHistory(root, 'Long.md', cadence + SHORT_INTERVAL_MS + SHORT_RETENTION_MS)
    assert.equal(history.length, 1)
    assert.equal((await readNoteHistory(root, 'Long.md', history[0].id)).content, 'week\n')
    await recordNoteHistorySnapshot(root, 'Long.md', 'next week\n', { now: cadence + WEEK_INTERVAL_MS })
    history = await listNoteHistory(root, 'Long.md', cadence + WEEK_INTERVAL_MS)
    assert.equal(history.length, 2)
    const longDir = path.join(root, '.fanotes', 'history', crypto.createHash('sha1').update('Long.md').digest('hex'))
    const longIndex = JSON.parse(await fsp.readFile(path.join(longDir, 'index.json'), 'utf8'))
    assert.deepEqual(longIndex.snapshots.map((item) => item.tier), ['week', 'week'])

    await recordNoteHistorySnapshot(root, 'Ink.famd', 'handwriting-bytes', { now: cadence })
    const famdDir = path.join(root, '.fanotes', 'history', crypto.createHash('sha1').update('Ink.famd').digest('hex'))
    const famdFiles = await fsp.readdir(famdDir)
    assert.equal(famdFiles.filter((name) => name.endsWith('.famd')).length, 1)
    assert.equal(famdFiles.filter((name) => name.endsWith('.md')).length, 0)
    const famdHistory = await listNoteHistory(root, 'Ink.famd', cadence)
    assert.equal((await readNoteHistory(root, 'Ink.famd', famdHistory[0].id)).content, 'handwriting-bytes')

    await recordNoteHistorySnapshot(root, 'Both.md', '# Text\n', { now: cadence, companion: 'companion-famd' })
    const both = await readNoteHistory(root, 'Both.md', (await listNoteHistory(root, 'Both.md', cadence))[0].id)
    assert.equal(both.content, '# Text\n')
    assert.equal(both.companion, 'companion-famd')
    const bothDir = path.join(root, '.fanotes', 'history', crypto.createHash('sha1').update('Both.md').digest('hex'))
    const bothFiles = await fsp.readdir(bothDir)
    assert.equal(bothFiles.filter((name) => name.endsWith('.md') && name !== 'index.json').length, 1)
    assert.equal(bothFiles.filter((name) => name.endsWith('.famd')).length, 1)

    const legacyDir = path.join(root, '.fanotes', 'history', crypto.createHash('sha1').update('Old.md').digest('hex'))
    await fsp.mkdir(legacyDir, { recursive: true })
    const legacySnapshots = []
    for (let revision = 0; revision < 6; revision += 1) {
      const createdAt = new Date(Date.parse('2026-01-01T00:00:00.000Z') + revision * 60_000).toISOString()
      const id = `${createdAt.replace(/[:.]/gu, '-')}-aa000${revision}`
      await fsp.writeFile(path.join(legacyDir, `${id}.md`), `revision ${revision}\n`, 'utf8')
      legacySnapshots.push({ id, createdAt, bytes: 12 })
    }
    await fsp.writeFile(path.join(legacyDir, 'index.json'), `${JSON.stringify({ format: 'fanotes-history-v1', snapshots: legacySnapshots, path: 'Old.md' }, null, 2)}\n`)
    const legacy = await listNoteHistory(root, 'Old.md', Date.parse('2026-08-01T00:00:00.000Z'))
    assert.equal(legacy.length, 1)
    assert.equal((await readNoteHistory(root, 'Old.md', legacy[0].id)).content, 'revision 0\n')
    assert.equal((await fsp.readdir(legacyDir)).filter((name) => name.endsWith('.md')).length, 1)
    await pruneVaultHistory(root, Date.parse('2026-08-01T00:00:00.000Z'))
    assert.equal((await listNoteHistory(root, 'Old.md', Date.parse('2026-08-01T00:00:00.000Z'))).length, 1)

    const addonRoot = path.join(root, 'addons')
    const store = createAddonStore(addonRoot)
    await store.save({ id: 'alpha', title: 'Alpha' })
    await store.save({ id: 'beta', title: 'Beta' })
    const recordsFile = path.join(addonRoot, 'addons.json')
    await fsp.chmod(recordsFile, 0)
    await assert.rejects(store.save({ id: 'gamma', title: 'Gamma' }), { code: 'EACCES' })
    await fsp.chmod(recordsFile, 0o600)
    const listed = await store.list()
    assert.deepEqual(listed.map((item) => item.id).sort(), ['alpha', 'beta'])
  } finally {
    await fsp.rm(root, { recursive: true, force: true })
  }
}

void assertUnreadableRecordsStayPut().then(() => {
  const viewerDir = path.join(__dirname, '..', '..', 'fanotes-site', 'public', 'viewer')
  const viewerHtml = fs.readFileSync(path.join(viewerDir, 'index.html'), 'utf8')
  const viewerJs = fs.readFileSync(path.join(viewerDir, 'viewer.js'), 'utf8')
  assert.match(viewerHtml, /Nur anschauen/u)
  assert.match(viewerJs, /parseFamd/u)
  assert.match(viewerJs, /fanotes-famd-v1/u)
  assert.doesNotMatch(viewerJs, /writeFile|createNote|indexedDB|localStorage|fetch\(/u)
  console.log('FAMD-Prüfung erfolgreich: Markdown bleibt lesbar, Handschrift sitzt im Längen-präfixierten Block, Begleiterpfade, Verschieben und der Nur-Lesen-Viewer stimmen.')
}).catch((error) => {
  console.error(error)
  process.exit(1)
})
