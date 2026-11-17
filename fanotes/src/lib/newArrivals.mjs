// Per-vault store for the "new from outside" dots, plus the rule for which watcher
// arrivals count. Pure functions: the caller passes the storage and the clock.

export const ARRIVAL_TTL_MS = 7 * 86_400_000
export const ARRIVAL_CAP = 200
/** Watcher events this soon after a sync batch still belong to that sync (debounce 1.2 s + scan time). */
export const SYNC_GRACE_MS = 8000
/** How long a path that sync wrote is never flagged as new. */
export const SYNC_WRITTEN_MS = 10 * 60_000

export const arrivalStorageKey = (vaultPath) => `fanotes.newArrivals.v1:${String(vaultPath ?? '')}`

/** Reads { path -> arrivedAt } and drops expired or malformed entries. Never throws. */
export const loadArrivals = (storage, vaultPath, now = Date.now()) => {
  const result = new Map()
  try {
    const raw = storage?.getItem(arrivalStorageKey(vaultPath))
    const parsed = raw ? JSON.parse(raw) : null
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      for (const [entryPath, at] of Object.entries(parsed)) {
        if (typeof at === 'number' && Number.isFinite(at) && now - at < ARRIVAL_TTL_MS && at <= now + 60_000) result.set(entryPath, at)
      }
    }
  } catch { /* unreadable store: start empty */ }
  return result
}

/** Keeps the newest ARRIVAL_CAP entries. Never throws. */
export const saveArrivals = (storage, vaultPath, arrivals) => {
  try {
    const newest = [...arrivals].sort((a, b) => b[1] - a[1]).slice(0, ARRIVAL_CAP)
    if (!newest.length) storage?.removeItem(arrivalStorageKey(vaultPath))
    else storage?.setItem(arrivalStorageKey(vaultPath), JSON.stringify(Object.fromEntries(newest)))
  } catch { /* quota or blocked storage: the dots just do not survive a restart */ }
}

/**
 * Which of the watcher's new files count as "from outside". Files FaNotes wrote
 * itself or that sync pulled never do.
 * @param input.files       candidate file paths
 * @param input.syncBusy    the sync engine is running right now
 * @param input.syncEndedAt ms timestamp when the last sync run ended (0 = never)
 * @param input.syncWritten paths sync wrote (path -> ms timestamp)
 */
export const externalArrivals = ({ files, now, syncBusy, syncEndedAt = 0, syncWritten, ownRecently }) => {
  if (ownRecently || syncBusy || (syncEndedAt && now - syncEndedAt < SYNC_GRACE_MS)) return []
  return files.filter((entryPath) => {
    const wroteAt = syncWritten?.get?.(entryPath)
    return !(typeof wroteAt === 'number' && now - wroteAt < SYNC_WRITTEN_MS)
  })
}
