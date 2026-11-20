import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { migrateAccounts } from './scripts/migrate-accounts-v2.mjs'

test('the migration stamps old accounts once and changes nothing else', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fanotes-migrate-'))
  try {
    const id = 'a'.repeat(32)
    mkdirSync(join(root, 'accounts', id), { recursive: true })
    const old = { version: 1, id, email: 'old@example.org', auth: { salt: 's', hash: 'h' }, devices: {}, sessions: {} }
    writeFileSync(join(root, 'accounts', id, 'account.json'), JSON.stringify(old))
    const dry = await migrateAccounts({ root, dryRun: true })
    assert.equal(dry.migrated, 1)
    assert.equal(JSON.parse(readFileSync(join(root, 'accounts', id, 'account.json'), 'utf8')).version, 1, 'a dry run writes nothing')
    const first = await migrateAccounts({ root })
    assert.equal(first.migrated, 1)
    const migrated = JSON.parse(readFileSync(join(root, 'accounts', id, 'account.json'), 'utf8'))
    assert.deepEqual({ ...migrated, version: 1, username: undefined, credential: undefined }, { ...old, username: undefined, credential: undefined })
    assert.equal(migrated.version, 2)
    assert.equal(migrated.username, null)
    assert.equal(migrated.credential, 'password')
    const second = await migrateAccounts({ root })
    assert.equal(second.migrated, 0)
    assert.equal(second.alreadyCurrent, 1)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
