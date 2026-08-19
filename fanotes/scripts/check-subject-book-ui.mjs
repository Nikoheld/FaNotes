import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

const appRoot = fileURLToPath(new URL('..', import.meta.url))
const appSource = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')
const treeSource = readFileSync(new URL('../src/components/FileTree.tsx', import.meta.url), 'utf8')
const mainSource = readFileSync(new URL('../electron/main.cjs', import.meta.url), 'utf8')
const bookSource = readFileSync(new URL('../src/lib/subjectBook.ts', import.meta.url), 'utf8')

const server = await createServer({
  root: appRoot,
  appType: 'custom',
  logLevel: 'error',
  optimizeDeps: { noDiscovery: true },
  server: { middlewareMode: true },
})

const { SUBJECT_BOOK_PLACEMENT_OPTIONS } = await server.ssrLoadModule('/src/lib/subjectBook.ts')

const runOnce = () => {
  assert.match(appSource, /className="subject-book-control"/)
  assert.match(appSource, /className=\{`editor-toolbar/)
  assert.ok(appSource.indexOf('editor-toolbar') < appSource.indexOf('subject-book-control'))
  assert.match(appSource, /subjectBookViewPolicy/)
  assert.match(appSource, /SUBJECT_BOOK_PLACEMENT_OPTIONS/)
  assert.match(bookSource, /label: 'Links'/)
  assert.match(bookSource, /label: 'Rechts'/)
  assert.match(bookSource, /label: 'Oben'/)
  assert.match(bookSource, /label: 'Unten'/)
  assert.match(bookSource, /label: 'Auspoppen'/)
  assert.match(appSource, /[Aa]uspoppen|[Bb]uch/)
  assert.doesNotMatch(appSource, /glyphenwerk-sidebar-back[\s\S]{0,40}subject-book-control/)
  assert.match(treeSource, /Buch hinzufügen/)
  assert.match(mainSource, /openSubjectBookPopout/)
  assert.match(mainSource, /new BrowserWindow/)
  assert.equal(SUBJECT_BOOK_PLACEMENT_OPTIONS.map((item) => item.id).join(','), 'links,rechts,oben,unten,popout')
  return { toolbar: true, placements: SUBJECT_BOOK_PLACEMENT_OPTIONS.map((item) => item.label) }
}

try {
  const first = runOnce()
  const second = runOnce()
  assert.deepEqual(first, second)
  console.log(JSON.stringify(first))
  console.log('subject-book-ui ok')
} finally {
  await server.close()
}
