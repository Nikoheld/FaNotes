// Read-only report of sync blob hashes, missing files, and orphans.
// It never deletes or rewrites anything. Pass a directory, or set FANOTES_SYNC_DIR.
// The live store is refused unless SYNC_INTEGRITY_ALLOW_LIVE=1.
//
//   node fanotes-site/scripts/sync-integrity-report.mjs /path/to/sync-copy
import { resolve } from 'node:path'
import { promises as fs } from 'node:fs'
import { inspectSyncAccount } from '../sync-integrity.mjs'

const requested = process.argv[2] || process.env.FANOTES_SYNC_DIR
if (!requested) {
  process.stderr.write('Pass the sync directory. This report only reads.\n')
  process.exit(1)
}
const root = resolve(requested)
if (root === '/var/lib/fanotes-sync' && process.env.SYNC_INTEGRITY_ALLOW_LIVE !== '1') {
  process.stderr.write('Refusing the live store without SYNC_INTEGRITY_ALLOW_LIVE=1. Nothing would be deleted.\n')
  process.exit(1)
}
const accountsRoot = resolve(root, 'accounts')
let names = []
try {
  names = await fs.readdir(accountsRoot)
} catch (error) {
  process.stderr.write(`Cannot read ${accountsRoot}: ${error?.code || 'error'}\n`)
  process.exit(1)
}
const reports = []
for (const accountId of names) {
  if (!/^[a-f0-9]{32}$/u.test(accountId)) continue
  reports.push(await inspectSyncAccount(root, accountId))
}
process.stdout.write(`${JSON.stringify({ accounts: reports.length, reports }, null, 2)}\n`)
