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
  detachSubjectBook,
  emptySubjectBooks,
  subjectBookFor,
  subjectHasBook,
} = await server.ssrLoadModule('/src/lib/subjectBook.ts')

const runOnce = () => {
  const subject = 'Faecher/Mechanik'
  const sibling = 'Faecher/Analysis'
  let list = emptySubjectBooks()
  assert.equal(subjectHasBook(list, subject), false)
  assert.equal(subjectBookFor(list, subject), null)
  assert.equal(subjectHasBook(list, sibling), false)

  const attached = attachSubjectBook(list, {
    subjectPath: subject,
    bookPath: 'Faecher/Mechanik/Buch.pdf',
  })
  list = attached.list
  assert.equal(subjectHasBook(list, subject), true)
  assert.equal(subjectBookFor(list, subject)?.bookPath, 'Faecher/Mechanik/Buch.pdf')
  assert.equal(subjectHasBook(list, sibling), false)
  assert.equal(subjectBookFor(list, sibling), null)

  list = detachSubjectBook(list, subject)
  assert.equal(subjectHasBook(list, subject), false)
  assert.equal(subjectHasBook(emptySubjectBooks(), subject), false)

  return {
    attached: subjectHasBook(attached.list, subject),
    sibling: subjectHasBook(attached.list, sibling),
    detached: subjectHasBook(list, subject),
  }
}

try {
  const first = runOnce()
  const second = runOnce()
  assert.deepEqual(first, second)
  console.log(JSON.stringify(first))
  console.log('subject-book-attach ok')
} finally {
  await server.close()
}
