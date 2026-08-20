import assert from 'node:assert/strict'
import { createServer } from 'vite'

const server = await createServer({
  appType: 'custom',
  logLevel: 'error',
  optimizeDeps: { noDiscovery: true },
  server: { middlewareMode: true },
})

const { chooseRestoredNote, collectNotePaths } = await server.ssrLoadModule('/src/lib/lastOpenNote.ts')

const tree = [
  { kind: 'file', name: 'Willkommen.md', relativePath: 'Willkommen.md' },
  {
    kind: 'folder',
    name: 'Faecher',
    relativePath: 'Faecher',
    children: [
      { kind: 'file', name: 'Beispiel.md', relativePath: 'Faecher/Beispiel.md' },
      { kind: 'file', name: 'Physik.md', relativePath: 'Faecher/Physik.md' },
    ],
  },
]

try {
  const paths = collectNotePaths(tree)
  assert.deepEqual(paths, ['Willkommen.md', 'Faecher/Beispiel.md', 'Faecher/Physik.md'])

  assert.equal(
    chooseRestoredNote('Faecher/Beispiel.md', paths, 'Willkommen.md'),
    'Faecher/Beispiel.md',
    'saved path must win when it still exists',
  )
  assert.equal(
    chooseRestoredNote('Faecher/Geloescht.md', paths, 'Willkommen.md'),
    'Willkommen.md',
    'missing path falls back without throwing',
  )
  assert.equal(chooseRestoredNote('', paths, 'Willkommen.md'), 'Willkommen.md')
  assert.equal(chooseRestoredNote(null, [], 'Willkommen.md'), null)
  assert.equal(chooseRestoredNote('Faecher/Beispiel.md', null, 'Willkommen.md'), null)

  console.log(JSON.stringify({
    saved: chooseRestoredNote('Faecher/Beispiel.md', paths, 'Willkommen.md'),
    missing: chooseRestoredNote('Faecher/Geloescht.md', paths, 'Willkommen.md'),
    paths: paths.length,
  }))
  console.log('last-note-restore ok')
} finally {
  await server.close()
}
