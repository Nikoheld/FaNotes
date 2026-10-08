'use strict'

const assert = require('node:assert/strict')
const {
  companionNotePath,
  emptyFamdPayload,
  parseFamd,
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

const os = require('node:os')
const fsp = require('node:fs/promises')
const crypto = require('node:crypto')
const { recordNoteHistorySnapshot, listNoteHistory } = require('../electron/note-history.cjs')
const { createAddonStore } = require('../electron/addons.cjs')

async function assertUnreadableRecordsStayPut() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'fanotes-read-failure-'))
  try {
    await recordNoteHistorySnapshot(root, 'Note.md', 'first revision\n')
    await recordNoteHistorySnapshot(root, 'Note.md', 'second revision\n')
    assert.equal((await listNoteHistory(root, 'Note.md')).length, 2)
    const index = path.join(root, '.fanotes', 'history', crypto.createHash('sha1').update('Note.md').digest('hex'), 'index.json')
    await fsp.chmod(index, 0)
    await assert.rejects(recordNoteHistorySnapshot(root, 'Note.md', 'third revision\n'), { code: 'EACCES' })
    await fsp.chmod(index, 0o600)
    assert.equal((await listNoteHistory(root, 'Note.md')).length, 2)

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
