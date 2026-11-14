import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { revisionNamesToKeep } from './sync-api.mjs'
import { restoreBackup, runBackup } from './scripts/sync-backup.mjs'

test('revision retention keeps the newest names and a larger older blob', () => {
  const files = Array.from({ length: 10 }, (_, index) => ({ name: String(index + 1), revision: index + 1, size: index === 0 ? 5000 : 10 }))
  const keep = revisionNamesToKeep(files, 8, 10)
  assert.equal(keep.has('10'), true)
  assert.equal(keep.has('9'), true)
  assert.equal(keep.has('1'), true)
  assert.equal(keep.has('2'), false)
  assert.equal(keep.size, 9)
})

test('a backup copies ciphertext, rotates old copies, and restore can dry-run', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sync-backup-'))
  const source = join(root, 'sync')
  const dest = join(root, 'backups')
  const restored = join(root, 'restored')
  try {
    await mkdir(join(source, 'accounts', 'a'.repeat(32), 'blobs'), { recursive: true })
    await writeFile(join(source, 'accounts', 'a'.repeat(32), 'blobs', 'note'), Buffer.from('ciphertext-not-plaintext'))
    const first = await runBackup({ source, dest, keep: 2, now: new Date('2026-11-14T01:00:00Z') })
    assert.equal(first.dryRun, false)
    assert.equal(first.files, 1)
    assert.equal(await readFile(join(dest, first.stamp, 'accounts', 'a'.repeat(32), 'blobs', 'note'), 'utf8'), 'ciphertext-not-plaintext')
    await runBackup({ source, dest, keep: 2, now: new Date('2026-11-14T02:00:00Z') })
    const third = await runBackup({ source, dest, keep: 2, now: new Date('2026-11-14T03:00:00Z') })
    assert.deepEqual(third.remove, ['20261114T010000Z'])
    await assert.rejects(readFile(join(dest, '20261114T010000Z', 'accounts', 'a'.repeat(32), 'blobs', 'note')))
    const preview = await runBackup({ source, dest, keep: 2, dryRun: true, now: new Date('2026-11-14T04:00:00Z') })
    assert.equal(preview.dryRun, true)
    await assert.rejects(readFile(join(dest, preview.stamp, 'accounts', 'a'.repeat(32), 'blobs', 'note')))
    const plan = await restoreBackup({ archive: join(dest, third.stamp), dest: restored, dryRun: true })
    assert.equal(plan.dryRun, true)
    assert.equal(plan.files, 1)
    await assert.rejects(readFile(join(restored, 'accounts', 'a'.repeat(32), 'blobs', 'note')))
    const done = await restoreBackup({ archive: join(dest, third.stamp), dest: restored })
    assert.equal(done.dryRun, false)
    assert.equal(await readFile(join(restored, 'accounts', 'a'.repeat(32), 'blobs', 'note'), 'utf8'), 'ciphertext-not-plaintext')
    await assert.rejects(restoreBackup({ archive: join(dest, third.stamp), dest: source }))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
