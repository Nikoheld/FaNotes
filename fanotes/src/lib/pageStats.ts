export type PageStats = {
  createdAt: string
  modifiedAt: string
  dwellMs: number
  lastOpenedAt: string
  openCount: number
}

export type PageStatsSession = PageStats & {
  active: boolean
  sessionStartedAt: number | null
}

const toIso = (ms: number) => new Date(ms).toISOString()

const parseIsoMs = (value: unknown) => {
  if (typeof value !== 'string' || !value) return null
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? ms : null
}

export const emptyPageStats = (now: number): PageStats => {
  const at = toIso(now)
  return {
    createdAt: at,
    modifiedAt: at,
    dwellMs: 0,
    lastOpenedAt: at,
    openCount: 0,
  }
}

export const parsePageStats = (input: unknown, now = Date.now()): PageStats => {
  const raw = input && typeof input === 'object' ? input as Record<string, unknown> : {}
  const created = parseIsoMs(raw.createdAt) ?? now
  const modified = parseIsoMs(raw.modifiedAt) ?? created
  const lastOpened = parseIsoMs(raw.lastOpenedAt) ?? created
  const dwell = Number(raw.dwellMs)
  const opens = Number(raw.openCount)
  return {
    createdAt: toIso(created),
    modifiedAt: toIso(modified),
    lastOpenedAt: toIso(lastOpened),
    dwellMs: Number.isFinite(dwell) && dwell >= 0 ? Math.floor(dwell) : 0,
    openCount: Number.isFinite(opens) && opens >= 0 ? Math.floor(opens) : 0,
  }
}

export const openPageStats = (state: PageStats, now: number): PageStatsSession => ({
  ...state,
  lastOpenedAt: toIso(now),
  openCount: state.openCount + 1,
  active: true,
  sessionStartedAt: now,
})

export const tickPageStats = (
  session: PageStatsSession,
  now: number,
  active: boolean,
): PageStatsSession => {
  if (!session.active || session.sessionStartedAt == null) {
    return active
      ? { ...session, active: true, sessionStartedAt: now }
      : { ...session, active: false, sessionStartedAt: null }
  }
  const extra = Math.max(0, now - session.sessionStartedAt)
  if (!active) {
    return {
      ...session,
      dwellMs: session.dwellMs + extra,
      active: false,
      sessionStartedAt: null,
    }
  }
  return {
    ...session,
    dwellMs: session.dwellMs + extra,
    sessionStartedAt: now,
    active: true,
  }
}

export const closePageStats = (session: PageStatsSession, now: number): PageStats => {
  const next = tickPageStats(session, now, false)
  return {
    createdAt: next.createdAt,
    modifiedAt: next.modifiedAt,
    dwellMs: next.dwellMs,
    lastOpenedAt: next.lastOpenedAt,
    openCount: next.openCount,
  }
}

export const touchPageModified = (stats: PageStats, now: number): PageStats => ({
  ...stats,
  modifiedAt: toIso(now),
})

export const formatPageDwell = (dwellMs: number) => {
  const totalSeconds = Math.max(0, Math.floor(dwellMs / 1000))
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  if (hours > 0) return `${hours} h ${minutes} min`
  if (minutes > 0) return `${minutes} min ${seconds} s`
  return `${seconds} s`
}

export const snapshotPageStats = (session: PageStatsSession): PageStats => ({
  createdAt: session.createdAt,
  modifiedAt: session.modifiedAt,
  dwellMs: session.dwellMs,
  lastOpenedAt: session.lastOpenedAt,
  openCount: session.openCount,
})
