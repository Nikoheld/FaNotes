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
  attachSubjectBook,
  emptySubjectBooks,
  recordSubjectBookPage,
  restoreSubjectBookPage,
  subjectBookDocumentKey,
  subjectBookForPopout,
  subjectBookOpenPageOnLoad,
} = await server.ssrLoadModule('/src/lib/subjectBook.ts')
const { pdfStartPageForLoad } = await server.ssrLoadModule('/src/lib/pdfDocument.ts')

const runOnce = () => {
  let book = attachSubjectBook(emptySubjectBooks(), {
    subjectPath: 'Faecher/Mechanik',
    bookPath: 'Faecher/Mechanik/Buch.pdf',
    lastPage: 1,
  }).book
  assert.equal(restoreSubjectBookPage(book, 10), 1)

  book = recordSubjectBookPage(book, 7, 10)
  assert.equal(restoreSubjectBookPage(book, 10), 7)

  const stayed = recordSubjectBookPage(book, 1, 10)
  assert.equal(restoreSubjectBookPage(stayed, 10), 1)

  const outOfRange = recordSubjectBookPage(book, 99, 10)
  assert.notEqual(restoreSubjectBookPage(outOfRange, 10), 99)
  assert.equal(restoreSubjectBookPage(outOfRange, 10), 7)

  const unknown = recordSubjectBookPage(book, 'nope', 10)
  assert.notEqual(restoreSubjectBookPage(unknown, 10), 'nope')
  assert.equal(restoreSubjectBookPage(unknown, 10), 7)
  assert.notEqual(restoreSubjectBookPage({ ...book, lastPage: 0 }, 10), 7)

  const path = book.bookPath
  assert.equal(subjectBookDocumentKey(book), path)
  assert.equal(subjectBookDocumentKey(stayed), subjectBookDocumentKey(book))
  assert.equal(subjectBookOpenPageOnLoad(path, null, 7), 7)
  assert.equal(subjectBookOpenPageOnLoad(path, path, 8), null)
  assert.equal(pdfStartPageForLoad(path, '', 7), 7)
  assert.equal(pdfStartPageForLoad(path, path, 8), null)
  assert.notEqual(pdfStartPageForLoad(path, path, 8), 7)

  const pending = subjectBookForPopout([], path, false)
  assert.equal(pending, null)
  const tooEarly = subjectBookOpenPageOnLoad(path, '', pending?.lastPage ?? 1)
  assert.notEqual(tooEarly, 7)
  const stored = subjectBookForPopout([{ ...book, lastPage: 7 }], path, false)
  assert.equal(stored?.lastPage, 7)
  assert.equal(subjectBookOpenPageOnLoad(path, '', stored.lastPage), 7)
  const missing = subjectBookForPopout([], path, true)
  assert.equal(missing?.lastPage, 1)

  return {
    start: restoreSubjectBookPage(attachSubjectBook(emptySubjectBooks(), {
      subjectPath: 'Faecher/Mechanik',
      bookPath: 'Faecher/Mechanik/Buch.pdf',
    }).book, 10),
    restored: restoreSubjectBookPage(book, 10),
    pageOne: restoreSubjectBookPage(stayed, 10),
    outOfRange: restoreSubjectBookPage(outOfRange, 10),
    sameDocument: pdfStartPageForLoad(path, path, 8),
    popoutWaits: pending,
    popoutPage: stored.lastPage,
  }
}

try {
  const first = runOnce()
  const second = runOnce()
  assert.deepEqual(first, second)
  console.log(JSON.stringify(first))
  console.log('subject-book-page ok')
} finally {
  await server.close()
}
