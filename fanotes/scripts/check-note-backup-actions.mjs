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
  noteBackupActions,
  noteBackupControlPolicy,
} = await server.ssrLoadModule('/src/lib/noteBackup.ts')

const runOnce = () => {
  const hidden = noteBackupControlPolicy(false, 0)
  assert.equal(hidden.visible, false)
  assert.equal(noteBackupActions(false, emptyNoteBackups()).length, 0)

  const emptyOn = noteBackupControlPolicy(true, 0)
  assert.equal(emptyOn.visible, true)
  assert.equal(emptyOn.snapshot, true)
  assert.equal(emptyOn.restore, false)
  const emptyActions = noteBackupActions(true, emptyNoteBackups(), 'Faecher/Mechanik.md')
  assert.deepEqual(emptyActions.map((action) => action.kind), ['snapshot'])
  assert.equal(emptyActions.some((action) => action.kind === 'restore'), false)

  const seeded = createNoteBackup(emptyNoteBackups(), {
    notePath: 'Faecher/Mechanik.md',
    content: 'Stand',
    id: 'nb-live',
  }).list
  const filled = noteBackupControlPolicy(true, seeded.length)
  assert.equal(filled.visible, true)
  assert.equal(filled.snapshot, true)
  assert.equal(filled.restore, true)
  const filledActions = noteBackupActions(true, seeded, 'Faecher/Mechanik.md')
  assert.equal(filledActions.some((action) => action.kind === 'snapshot'), true)
  const restore = filledActions.find((action) => action.kind === 'restore')
  assert.ok(restore && restore.kind === 'restore')
  assert.equal(restore.id, 'nb-live')

  const stillHidden = noteBackupActions(false, seeded)
  assert.equal(stillHidden.length, 0)

  return {
    hidden: hidden.visible,
    emptyRestore: emptyOn.restore,
    filledRestore: filled.restore,
    restoreId: restore.id,
  }
}

try {
  const first = runOnce()
  const second = runOnce()
  assert.deepEqual(first, second)
  console.log(JSON.stringify(first))
  console.log('note-backup-actions ok')
} finally {
  await server.close()
}
