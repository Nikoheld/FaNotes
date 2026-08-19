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
  createNoteBackup,
  emptyNoteBackups,
  restoreNoteBackup,
} = await server.ssrLoadModule('/src/lib/noteBackup.ts')
const { emptyFamdPayload, parseFamd, serializeFamd } = await server.ssrLoadModule('/src/lib/famd.ts')

const runOnce = () => {
  const notePath = 'Faecher/Mechanik.md'
  let list = emptyNoteBackups()
  assert.equal(list.length, 0)
  assert.equal(restoreNoteBackup(list, 'nb-missing'), null)

  const first = createNoteBackup(list, {
    notePath,
    content: 'Inhalt A',
    id: 'nb-first',
    createdAt: '2026-08-19T12:00:00.000Z',
  })
  list = first.list
  assert.equal(list.length, 1)
  assert.equal(restoreNoteBackup(list, first.snapshot.id), 'Inhalt A')

  const second = createNoteBackup(list, {
    notePath,
    content: 'Inhalt B',
    id: 'nb-second',
    createdAt: '2026-08-19T13:00:00.000Z',
  })
  list = second.list
  assert.equal(list.length, 2)
  assert.equal(restoreNoteBackup(list, first.snapshot.id), 'Inhalt A')
  assert.equal(restoreNoteBackup(list, second.snapshot.id), 'Inhalt B')
  assert.equal(restoreNoteBackup(list, 'nb-unknown'), null)
  assert.notEqual(restoreNoteBackup(list, 'nb-unknown'), 'Inhalt A')
  assert.notEqual(restoreNoteBackup(list, 'nb-unknown'), 'Inhalt B')

  const encoded = serializeFamd('# Mechanik', {
    ...emptyFamdPayload('2026-08-19T12:00:00.000Z'),
    noteBackups: list,
  })
  const parsed = parseFamd(encoded)
  assert.equal(parsed.payload?.noteBackups?.length, 2)
  assert.equal(restoreNoteBackup(parsed.payload.noteBackups, 'nb-first'), 'Inhalt A')
  assert.equal(restoreNoteBackup(parsed.payload.noteBackups, 'nb-second'), 'Inhalt B')

  return {
    count: list.length,
    first: restoreNoteBackup(list, 'nb-first'),
    second: restoreNoteBackup(list, 'nb-second'),
    unknown: restoreNoteBackup(list, 'nb-unknown'),
  }
}

try {
  const first = runOnce()
  const second = runOnce()
  assert.deepEqual(first, second)
  console.log(JSON.stringify(first))
  console.log('note-backup-roundtrip ok')
} finally {
  await server.close()
}
