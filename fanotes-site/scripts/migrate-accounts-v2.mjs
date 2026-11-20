// Stamp existing sync accounts with the fields accounts without e-mail and shares use, and create the new
// store directories. The server also reads old records as they are (no username, password credential), so this
// is safe to run before or after the new server code starts, and any number of times.
//   FANOTES_SYNC_DIR=/var/lib/fanotes-sync node fanotes-site/scripts/migrate-accounts-v2.mjs [--dry-run]
// Run it as the service user (www-data) so new files keep the right owner.
import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const ACCOUNT_ID = /^[a-f0-9]{32}$/u

export const migrateAccounts = async ({ root, dryRun = false } = {}) => {
  const base = resolve(root || process.env.FANOTES_SYNC_DIR || '/var/lib/fanotes-sync')
  const report = { accounts: 0, migrated: 0, alreadyCurrent: 0, skipped: 0, directories: [] }
  for (const name of ['usernames', 'user-shares', 'user-share-prefs']) {
    report.directories.push(name)
    if (!dryRun) await mkdir(join(base, name), { recursive: true, mode: 0o700 })
  }
  let ids = []
  try { ids = await readdir(join(base, 'accounts')) } catch (error) { if (error?.code !== 'ENOENT') throw error }
  for (const id of ids) {
    if (!ACCOUNT_ID.test(id)) continue
    const target = join(base, 'accounts', id, 'account.json')
    let account
    try { account = JSON.parse(await readFile(target, 'utf8')) } catch { report.skipped += 1; continue }
    report.accounts += 1
    const current = account.version === 2 && 'username' in account && 'credential' in account
    if (current) { report.alreadyCurrent += 1; continue }
    account.version = 2
    account.username ??= null
    account.credential ??= 'password'
    if (!dryRun) {
      const temporary = `${target}.migrate.tmp`
      await writeFile(temporary, `${JSON.stringify(account, null, 2)}\n`, { mode: 0o600 })
      await rename(temporary, target)
    }
    report.migrated += 1
  }
  return report
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const report = await migrateAccounts({ dryRun: process.argv.includes('--dry-run') })
  console.log(JSON.stringify(report))
}
