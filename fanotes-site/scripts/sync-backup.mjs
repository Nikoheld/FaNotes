// Copy the FaNotes sync store without reading the notes. The blobs are already
// ciphertext. A backup is a directory of those bytes, and rotation never deletes
// the newest copy. Restore refuses to write onto the live store.
import { cp, mkdir, readdir, rm, stat } from 'node:fs/promises'
import { resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

const STAMP = /^\d{8}T\d{6}Z$/u

export const backupStamp = (date = new Date()) => date.toISOString().replace(/[-:]/gu, '').replace(/\.\d{3}Z$/u, 'Z')

const inside = (root, target) => {
  const base = resolve(root)
  const path = resolve(target)
  return path === base || path.startsWith(`${base}${sep}`)
}

export const listBackups = async (dest) => {
  let names = []
  try { names = await readdir(dest) } catch (error) { if (error?.code === 'ENOENT') return []; throw error }
  return names.filter((name) => STAMP.test(name)).sort()
}

const measure = async (root) => {
  let files = 0
  let bytes = 0
  const walk = async (dir) => {
    const entries = await readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      const path = resolve(dir, entry.name)
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) { await walk(path); continue }
      if (!entry.isFile()) continue
      files += 1
      bytes += (await stat(path)).size
    }
  }
  await walk(root)
  return { files, bytes }
}

export const runBackup = async ({ source, dest, keep = 7, dryRun = false, now = new Date() } = {}) => {
  const from = resolve(source || '')
  const into = resolve(dest || '')
  if (!from || !into || from === into || inside(from, into) || inside(into, from)) {
    throw new Error('Die Sicherung braucht getrennte Verzeichnisse.')
  }
  const sourceStat = await stat(from)
  if (!sourceStat.isDirectory()) throw new Error('Die Sync-Daten sind kein Verzeichnis.')
  const measured = await measure(from)
  const stamp = backupStamp(now)
  const existing = await listBackups(into)
  const names = existing.includes(stamp) ? existing : [...existing, stamp]
  const remove = names.slice(0, Math.max(0, names.length - keep)).filter((name) => name !== names.at(-1))
  if (!dryRun) {
    await mkdir(into, { recursive: true, mode: 0o700 })
    await cp(from, resolve(into, stamp), { recursive: true, verbatimSymlinks: false })
    for (const name of remove) await rm(resolve(into, name), { recursive: true, force: true })
  }
  return { stamp, ...measured, kept: names.length - remove.length, remove, dryRun }
}

export const restoreBackup = async ({ archive, dest, dryRun = false } = {}) => {
  const from = resolve(archive || '')
  const into = resolve(dest || '')
  const live = resolve(process.env.FANOTES_SYNC_DIR || '/var/lib/fanotes-sync')
  if (!from || !into || from === into || into === live || inside(live, into)) {
    throw new Error('Die Wiederherstellung schreibt nicht auf den laufenden Sync-Speicher.')
  }
  const archiveStat = await stat(from)
  if (!archiveStat.isDirectory()) throw new Error('Die Sicherung ist kein Verzeichnis.')
  const measured = await measure(from)
  let occupied = false
  try {
    occupied = (await readdir(into)).length > 0
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  if (occupied) throw new Error('Das Ziel ist nicht leer.')
  if (!dryRun) {
    await mkdir(into, { recursive: true, mode: 0o700 })
    await cp(from, into, { recursive: true, verbatimSymlinks: false })
  }
  return { ...measured, dryRun }
}

const usage = () => {
  process.stderr.write('usage: sync-backup.mjs backup|restore [--dry-run] [--source dir] [--dest dir] [--archive dir] [--keep n]\n')
  process.exit(2)
}

const flag = (args, name) => {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : ''
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2)
  const command = args[0]
  const dryRun = args.includes('--dry-run')
  try {
    const result = command === 'backup'
      ? await runBackup({
        source: flag(args, '--source') || process.env.FANOTES_SYNC_DIR || '/var/lib/fanotes-sync',
        dest: flag(args, '--dest') || process.env.FANOTES_SYNC_BACKUP_DIR || '/var/lib/fanotes-sync-backups',
        keep: Number(flag(args, '--keep') || 7),
        dryRun,
      })
      : command === 'restore'
        ? await restoreBackup({ archive: flag(args, '--archive'), dest: flag(args, '--dest'), dryRun })
        : usage()
    process.stdout.write(`${JSON.stringify(result)}\n`)
  } catch (error) {
    process.stderr.write(`${error?.message || 'backup failed'}\n`)
    process.exit(1)
  }
}
