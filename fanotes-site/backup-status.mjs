import { readdir } from 'node:fs/promises'

const STAMP = /^\d{8}T\d{6}Z$/u
/** A daily backup that is older than this missed its run. The timer may wait about 24 hours plus its delay. */
export const BACKUP_LATE_SECONDS = 26 * 60 * 60

/** Newest ciphertext backup, as a stamp and an age. Names that are not stamps are ignored. */
export const backupStatusFromNames = (names, now = Date.now()) => {
  const stamps = [...(names || [])].filter((name) => STAMP.test(name)).sort()
  if (!stamps.length) return null
  const stamp = stamps.at(-1)
  const parsed = Date.parse(`${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}T${stamp.slice(9, 11)}:${stamp.slice(11, 13)}:${stamp.slice(13, 15)}Z`)
  const ageSeconds = Number.isFinite(parsed) ? Math.max(0, Math.round((now - parsed) / 1000)) : null
  return { stamp, ageSeconds, late: ageSeconds != null && ageSeconds > BACKUP_LATE_SECONDS }
}

/** Unreadable or missing store reports nothing. Health must still answer. */
export const readBackupStatus = async (directory, now = Date.now()) => {
  try {
    return backupStatusFromNames(await readdir(directory), now)
  } catch {
    return null
  }
}
