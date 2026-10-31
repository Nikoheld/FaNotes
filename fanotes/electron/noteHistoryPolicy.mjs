/** How often a note keeps a local snapshot, shared by the desktop and browser vaults. */

export const SHORT_INTERVAL_MS = 12 * 60 * 60 * 1000
export const SHORT_RETENTION_MS = 2 * 24 * 60 * 60 * 1000
export const WEEK_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000
export const MAX_SNAPSHOT_BYTES = 16 * 1024 * 1024

export const snapshotExtension = (relativePath) => {
  const normalized = String(relativePath ?? '').replace(/\\/gu, '/')
  const slash = normalized.lastIndexOf('/')
  const dot = normalized.lastIndexOf('.')
  const ext = dot > slash ? normalized.slice(dot).toLowerCase() : ''
  return ext === '.famd' ? '.famd' : '.md'
}

const timeOf = (snapshot) => {
  const value = Date.parse(snapshot?.createdAt)
  return Number.isFinite(value) ? value : null
}

const storedExtension = (snapshot) => (snapshot?.ext === '.famd' ? '.famd' : '.md')

/**
 * Weekly snapshots stay. A 12-hour snapshot stays for two days.
 * Older files with no tier are folded into that same rule: one weekly
 * snapshot per seven days, and 12-hour snapshots only while they are
 * still inside the two-day window.
 */
export const retainSnapshots = (snapshots, nowMs) => {
  const sorted = [...(Array.isArray(snapshots) ? snapshots : [])]
    .filter((snapshot) => snapshot && typeof snapshot.id === 'string')
    .sort((left, right) => (timeOf(left) ?? 0) - (timeOf(right) ?? 0))
  const kept = []
  let lastWeek = null
  let lastAny = null
  for (const snapshot of sorted) {
    const at = timeOf(snapshot)
    const ext = storedExtension(snapshot)
    if (at == null) {
      kept.push({ ...snapshot, tier: snapshot.tier === 'short' ? 'short' : 'week', ext })
      continue
    }
    if (snapshot.tier === 'week') {
      kept.push({ ...snapshot, tier: 'week', ext })
      lastWeek = at
      lastAny = at
      continue
    }
    if (snapshot.tier === 'short') {
      if (nowMs - at < SHORT_RETENTION_MS) {
        kept.push({ ...snapshot, tier: 'short', ext })
        lastAny = at
      }
      continue
    }
    if (lastWeek == null || at - lastWeek >= WEEK_INTERVAL_MS) {
      kept.push({ ...snapshot, tier: 'week', ext })
      lastWeek = at
      lastAny = at
      continue
    }
    if (nowMs - at < SHORT_RETENTION_MS && (lastAny == null || at - lastAny >= SHORT_INTERVAL_MS)) {
      kept.push({ ...snapshot, tier: 'short', ext })
      lastAny = at
    }
  }
  return kept
}

/** `week` wins when both a weekly and a 12-hour snapshot are due. */
export const nextSnapshotTier = (snapshots, nowMs) => {
  let lastWeek = null
  let lastAny = null
  for (const snapshot of Array.isArray(snapshots) ? snapshots : []) {
    const at = timeOf(snapshot)
    if (at == null) continue
    if (snapshot.tier === 'week') lastWeek = lastWeek == null ? at : Math.max(lastWeek, at)
    if (snapshot.tier === 'week' || snapshot.tier === 'short') lastAny = lastAny == null ? at : Math.max(lastAny, at)
  }
  if (lastWeek == null || nowMs - lastWeek >= WEEK_INTERVAL_MS) return 'week'
  if (lastAny == null || nowMs - lastAny >= SHORT_INTERVAL_MS) return 'short'
  return null
}
