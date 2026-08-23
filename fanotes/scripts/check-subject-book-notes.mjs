import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

const server = await createServer({
  root: fileURLToPath(new URL('..', import.meta.url)),
  appType: 'custom',
  logLevel: 'error',
  optimizeDeps: { noDiscovery: true },
  server: { middlewareMode: true },
})

const {
  persistSubjectBookNotes,
  readSubjectBookNotes,
  subjectBookCompanionPath,
  subjectBookNotesTarget,
} = await server.ssrLoadModule('/src/lib/subjectBook.ts')
const { emptyFamdPayload, parseFamd, serializeFamd } = await server.ssrLoadModule('/src/lib/famd.ts')

const runOnce = () => {
  const bookPath = 'Faecher/Mechanik/Buch.pdf'
  const otherPath = 'Faecher/Mechanik/Skript.md'
  const ink = {
    schemaVersion: 1,
    title: 'Buchnotiz',
    strokes: [{ points: [{ x: 0.2, y: 0.3, t: 1, pressure: 0.4 }] }],
  }
  const stored = persistSubjectBookNotes('', {
    bookPath,
    text: 'Randnotiz zur Seite 7',
    ink,
  })
  const parsed = parseFamd(stored)
  const notes = readSubjectBookNotes(stored)
  assert.equal(notes.text, 'Randnotiz zur Seite 7')
  assert.equal(parsed.markdown, 'Randnotiz zur Seite 7')
  assert.equal(parsed.payload?.ink?.title, 'Buchnotiz')
  assert.equal(subjectBookNotesTarget(bookPath, bookPath), true)
  assert.equal(subjectBookNotesTarget(bookPath, subjectBookCompanionPath(bookPath)), true)
  assert.equal(subjectBookNotesTarget(bookPath, otherPath), false)

  const other = serializeFamd('# Skript', emptyFamdPayload('2026-08-20T12:00:00.000Z'))
  assert.notEqual(readSubjectBookNotes(other).text, 'Randnotiz zur Seite 7')
  assert.equal(readSubjectBookNotes(other).text, '# Skript')

  const reloaded = persistSubjectBookNotes(stored, { bookPath })
  assert.equal(readSubjectBookNotes(reloaded).text, 'Randnotiz zur Seite 7')
  assert.equal(readSubjectBookNotes(reloaded).ink?.title, 'Buchnotiz')

  return {
    text: notes.text,
    ink: notes.ink?.title ?? null,
    other: readSubjectBookNotes(other).text,
    companion: subjectBookCompanionPath(bookPath),
  }
}

try {
  const first = runOnce()
  const second = runOnce()
  assert.deepEqual(first, second)
  console.log(JSON.stringify(first))
  console.log('subject-book-notes ok')
} finally {
  await server.close()
}
