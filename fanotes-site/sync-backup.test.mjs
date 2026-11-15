import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
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

test('revision retention keeps the archived copy when a short sibling sorts later', () => {
  const files = [
    { name: '1', revision: 1, size: 5000 },
    { name: 'c-1', revision: 1, size: 64 },
    ...Array.from({ length: 7 }, (_, index) => ({ name: String(index + 2), revision: index + 2, size: 100 })),
  ]
  const keep = revisionNamesToKeep(files, 8, 6000)
  assert.equal(keep.has('1'), true)
  assert.equal(keep.has('c-1'), true)
  assert.equal(keep.has('2'), true)
  assert.equal(keep.has('8'), true)
  assert.equal(keep.size, 9)
})

test('revision retention does not let a short sibling push out an older archive', () => {
  const files = [
    ...Array.from({ length: 9 }, (_, index) => ({ name: String(index + 1), revision: index + 1, size: 100 })),
    { name: 'c-9', revision: 9, size: 64 },
  ]
  const keep = revisionNamesToKeep(files, 8, 1000)
  assert.equal(keep.has('1'), false)
  assert.equal(keep.has('2'), true)
  assert.equal(keep.has('9'), true)
  assert.equal(keep.has('c-9'), true)
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

test('an unreadable blob fails the backup without naming the file', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sync-backup-'))
  const source = join(root, 'sync')
  const dest = join(root, 'backups')
  const hidden = join(source, 'accounts', 'secretblob', 'note')
  try {
    await mkdir(join(source, 'accounts', 'secretblob'), { recursive: true })
    await writeFile(hidden, Buffer.from('ciphertext'))
    await chmod(hidden, 0)
    await assert.rejects(
      runBackup({ source, dest, keep: 2, now: new Date('2026-11-15T01:00:00Z') }),
      (error) => {
        assert.match(error.message, /^Sicherung unvollständig \(EACCES\)\.$/u)
        assert.equal(error.message.includes('secretblob'), false)
        assert.equal(error.message.includes(root), false)
        return true
      },
    )
  } finally {
    await chmod(hidden, 0o600).catch(() => {})
    await rm(root, { recursive: true, force: true })
  }
})
