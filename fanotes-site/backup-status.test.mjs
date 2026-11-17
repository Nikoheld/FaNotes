import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { BACKUP_LATE_SECONDS, backupStatusFromNames, readBackupStatus } from './backup-status.mjs'

const now = Date.parse('2026-11-15T09:00:00Z')

test('the newest stamp is kept and paths are not part of the result', () => {
  const status = backupStatusFromNames(['notes', '20261115T075617Z', '20261114T033000Z'], now)
  assert.deepEqual(status, { stamp: '20261115T075617Z', ageSeconds: 3823, late: false })
  const late = backupStatusFromNames(['20261114T033000Z'], now)
  assert.equal(late.late, true)
  assert.ok(late.ageSeconds > BACKUP_LATE_SECONDS)
  assert.equal(JSON.stringify(status).includes('/'), false)
  assert.equal(backupStatusFromNames([], now), null)
  assert.equal(backupStatusFromNames(['not-a-stamp'], now), null)
})

test('a missing backup directory does not throw', async () => {
  const root = await mkdtemp(join(tmpdir(), 'backup-status-'))
  try {
    assert.equal(await readBackupStatus(join(root, 'missing'), now), null)
    const store = join(root, 'backups')
    await mkdir(join(store, '20261115T080000Z'), { recursive: true })
    await mkdir(join(store, 'ignore-me'), { recursive: true })
    assert.deepEqual(await readBackupStatus(store, now), { stamp: '20261115T080000Z', ageSeconds: 3600, late: false })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
