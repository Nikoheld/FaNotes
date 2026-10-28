// Public username and activity overview. This is not vault sync and not a
// note share: /api/v1/sync stays encrypted, and /share/ stays the note link.
// The site stores only a username, when the name was claimed, and the numbers
// the owner chooses to publish. Note text never leaves this module.

import { formatPageDwell, type PageStats } from '../pageStats'

export const PROFILE_HOST = 'fanotes.fasrv.ch'
export const PROFILE_ORIGIN = `https://${PROFILE_HOST}`
export const PROFILE_API_PATH = '/api/v1/profile'
export const PROFILE_VIEW_PATH = '/user/'

const USERNAME_PATTERN = /^[a-z0-9](?:[a-z0-9]|[-_](?![_-])){1,22}[a-z0-9]$/u
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/u
const OWNER_PATTERN = /^[a-f0-9]{32}$/u

const RESERVED_USERNAMES = new Set([
  'about', 'admin', 'api', 'assets', 'css', 'download', 'fanotes', 'favicon',
  'help', 'index', 'js', 'login', 'me', 'notes', 'null', 'profile', 'public',
  'robots', 'root', 'settings', 'share', 'static', 'support', 'undefined',
  'user', 'users', 'viewer', 'www',
])

export type ProfileVaultNode = {
  relativePath: string
  kind: 'file' | 'folder'
  extension?: string
  createdAt?: string
  modifiedAt?: string
  children?: ProfileVaultNode[]
}

/** A note the overview may count. Text fields are accepted and then dropped. */
export type ProfileNoteSource = {
  path?: string
  title?: string
  content?: string
  /** File birth time, when the vault entry has one. Not a page-stat default. */
  createdAt?: string
  /** File modification time. One day, not the span between edits. */
  modifiedAt?: string
  firstOpenedAt?: string
  /** Revision times. The snapshot text is never copied. */
  historyAt?: readonly string[]
  dwellMs?: number
  activeDays?: readonly string[]
  pageStats?: Pick<PageStats, 'createdAt' | 'firstOpenedAt' | 'lastOpenedAt' | 'modifiedAt' | 'lastSavedAt' | 'dwellMs' | 'activeDays'> | null
}

export const PROFILE_THEMES = ['dark', 'light', 'midnight', 'forest', 'aurora', 'sepia'] as const
export type ProfileTheme = (typeof PROFILE_THEMES)[number]

export type ProfileAppearance = {
  theme: ProfileTheme
  accent: string
  accentSecondary: string
}

export type ProfileActivity = {
  joinedAt: string
  noteCount: number
  dwellMs: number
  durationLabel: string
  activeDays: string[]
  /** How many notes were used on that day. Missing days count as one on the page. */
  dayCounts: Record<string, number>
}

export type ProfileClaim = {
  username: string
  path: string
  link: string
  joinedAt: string
  public: boolean
}

export type PublicProfile = ProfileActivity & {
  username: string
  path: string
  public: true
  theme?: ProfileTheme
  accent?: string
  accentSecondary?: string
}

export type ProfileHttpRequest = {
  method: 'PUT' | 'GET'
  url: string
  headers: Record<string, string>
  body: string
}

export type ProfileHttpResponse = { status: number; body: string }

export type ProfilePort = {
  exchange(request: ProfileHttpRequest): Promise<ProfileHttpResponse>
}

export class ProfileRequestError extends Error {
  readonly status: number
  readonly taken: boolean

  constructor(status: number, message: string, taken = false) {
    super(message)
    this.name = 'ProfileRequestError'
    this.status = status
    this.taken = taken
  }
}

export const profilePath = (username: string) => `${PROFILE_VIEW_PATH}${username}`

export const profileViewUrl = (username: string, origin = PROFILE_ORIGIN) => (
  `${origin.replace(/\/$/u, '')}${profilePath(username)}`
)

export const normalizeUsername = (raw: string): string | null => {
  if (typeof raw !== 'string') return null
  const name = raw.trim().toLowerCase()
  if (!USERNAME_PATTERN.test(name) || RESERVED_USERNAMES.has(name)) return null
  return name
}

export const createProfileOwnerId = () => {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

export const isProfileOwnerId = (value: string) => OWNER_PATTERN.test(value)

const finiteMs = (value: unknown) => {
  const number = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(number) || number <= 0) return 0
  return Math.floor(number)
}

const daysFrom = (value: readonly string[] | undefined) => {
  const days: string[] = []
  if (!value) return days
  for (const day of value) {
    if (typeof day === 'string' && DAY_PATTERN.test(day)) days.push(day)
  }
  return days
}

const HEX_COLOR = /^#[0-9a-f]{6}$/iu

/** A stored instant. Empty and out-of-range values are ignored, never replaced with now. */
export const profileStamp = (value: unknown): string | null => {
  if (typeof value !== 'string' || value.length === 0 || value.length > 40) return null
  const ms = Date.parse(value)
  if (!Number.isFinite(ms)) return null
  const date = new Date(ms)
  const year = date.getUTCFullYear()
  if (year < 2000 || year > 2100) return null
  return date.toISOString()
}

const dayStamp = (day: string) => (DAY_PATTERN.test(day) ? profileStamp(`${day}T00:00:00.000Z`) : null)

/** Calendar day on this device. A stored `YYYY-MM-DD` is kept as written. */
export const profileLocalDay = (value: unknown): string | null => {
  if (typeof value !== 'string' || value.length === 0 || value.length > 40) return null
  if (DAY_PATTERN.test(value)) {
    const year = Number(value.slice(0, 4))
    return year >= 2000 && year <= 2100 ? value : null
  }
  const stamp = profileStamp(value)
  if (!stamp) return null
  const date = new Date(stamp)
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

/** Keep the start and the shape when a vault has more days than the request can carry. */
export const capProfileDays = (days: readonly string[], max = 1500) => {
  const unique = [...new Set(days.filter((day) => DAY_PATTERN.test(day)))].sort()
  if (unique.length <= max) return unique
  const kept = new Set<string>()
  const stride = (unique.length - 1) / (max - 1)
  for (let index = 0; index < max; index += 1) kept.add(unique[Math.round(index * stride)])
  return [...kept].sort()
}

export const earlierProfileStamp = (left: unknown, right: unknown): string | null => {
  const first = profileStamp(left)
  const second = profileStamp(right)
  if (first && second) return first < second ? first : second
  return first || second
}

/**
 * The earliest real note history. Page-stat fields are read as stored.
 * A missing timestamp is skipped so it cannot become "today".
 */
export const earliestProfileJoinedAt = (notes: readonly ProfileNoteSource[]): string | null => {
  let best: string | null = null
  const consider = (value: unknown) => {
    const stamp = profileStamp(value)
    if (!stamp) return
    if (!best || stamp < best) best = stamp
  }
  for (const note of notes) {
    const stats = note.pageStats
    consider(stats?.createdAt)
    consider(stats?.firstOpenedAt)
    consider(note.createdAt)
    consider(note.firstOpenedAt)
    for (const day of daysFrom(stats?.activeDays ?? note.activeDays)) consider(dayStamp(day))
  }
  return best
}

const normalizeHex = (value: unknown, fallback: string) => {
  if (typeof value === 'string' && HEX_COLOR.test(value)) return value.toLowerCase()
  return fallback
}

/** `system` becomes the device's light or dark theme. The visitor's OS is not consulted. */
export const resolveProfileTheme = (theme: string | undefined): ProfileTheme => {
  if (theme === 'system') {
    try {
      const light = typeof window !== 'undefined'
        && typeof window.matchMedia === 'function'
        && window.matchMedia('(prefers-color-scheme: light)').matches
      return light ? 'light' : 'dark'
    } catch {
      return 'dark'
    }
  }
  if (theme && (PROFILE_THEMES as readonly string[]).includes(theme)) return theme as ProfileTheme
  return 'dark'
}

export const profileAppearanceFromSettings = (settings: {
  theme?: string
  accent?: string
  accentSecondary?: string
}): ProfileAppearance => ({
  theme: resolveProfileTheme(settings.theme),
  accent: normalizeHex(settings.accent, '#2a6f97'),
  accentSecondary: normalizeHex(settings.accentSecondary, '#6b7280'),
})

/**
 * Joined time, note count, total visible time, and the dates those notes were
 * used. Titles, paths, and written text are not copied into the result.
 */
export const summarizeProfileActivity = (notes: readonly ProfileNoteSource[], joinedAt: string): ProfileActivity => {
  const days = new Set<string>()
  const dayCounts: Record<string, number> = {}
  let dwellMs = 0
  for (const note of notes) {
    const stats = note.pageStats
    dwellMs += finiteMs(stats?.dwellMs ?? note.dwellMs)
    const seen = new Set(daysFrom(stats?.activeDays ?? note.activeDays))
    const stamps = [
      stats?.createdAt,
      stats?.firstOpenedAt,
      stats?.lastOpenedAt,
      stats?.modifiedAt,
      stats?.lastSavedAt,
      note.createdAt,
      note.modifiedAt,
      note.firstOpenedAt,
    ]
    for (const stamp of stamps) {
      const day = profileLocalDay(stamp)
      if (day) seen.add(day)
    }
    for (const stamp of note.historyAt ?? []) {
      const day = profileLocalDay(stamp)
      if (day) seen.add(day)
    }
    for (const day of seen) {
      days.add(day)
      dayCounts[day] = (dayCounts[day] ?? 0) + 1
    }
  }
  const activeDays = capProfileDays([...days].sort())
  const cappedCounts: Record<string, number> = {}
  for (const day of activeDays) cappedCounts[day] = dayCounts[day] ?? 1
  return {
    joinedAt,
    noteCount: notes.length,
    dwellMs,
    durationLabel: formatPageDwell(dwellMs),
    activeDays,
    dayCounts: cappedCounts,
  }
}

const isMarkdownNote = (node: ProfileVaultNode) => (
  node.kind === 'file' && (node.extension === 'md' || node.relativePath.toLowerCase().endsWith('.md'))
)

/** Dates of saved revisions. The reader must return timestamps only, never note text. */
export const profileHistoryReader = (
  listNoteHistory?: (path: string) => Promise<readonly { createdAt?: string }[] | null | undefined>,
) => {
  if (typeof listNoteHistory !== 'function') return undefined
  return async (path: string) => {
    const entries = await listNoteHistory(path)
    if (!Array.isArray(entries)) return null
    return entries.map((entry) => ({
      createdAt: entry && typeof entry.createdAt === 'string' ? entry.createdAt : undefined,
    }))
  }
}

/** Counts markdown notes and reads their page stats. File text is never read. */
export const loadProfileNotes = async (
  nodes: readonly ProfileVaultNode[],
  readStats: (path: string) => Promise<unknown>,
  readHistory?: (path: string) => Promise<readonly { createdAt?: string }[] | null>,
): Promise<ProfileNoteSource[]> => {
  const notes: ProfileNoteSource[] = []
  const walk = async (list: readonly ProfileVaultNode[]) => {
    for (const node of list) {
      if (node.children?.length) await walk(node.children)
      if (!isMarkdownNote(node)) continue
      let pageStats: ProfileNoteSource['pageStats'] = null
      try {
        const raw = await readStats(node.relativePath)
        if (raw && typeof raw === 'object') {
          const record = raw as {
            createdAt?: unknown
            firstOpenedAt?: unknown
            lastOpenedAt?: unknown
            modifiedAt?: unknown
            lastSavedAt?: unknown
            dwellMs?: unknown
            activeDays?: unknown
          }
          pageStats = {
            createdAt: typeof record.createdAt === 'string' ? record.createdAt : '',
            firstOpenedAt: typeof record.firstOpenedAt === 'string' ? record.firstOpenedAt : '',
            lastOpenedAt: typeof record.lastOpenedAt === 'string' ? record.lastOpenedAt : '',
            modifiedAt: typeof record.modifiedAt === 'string' ? record.modifiedAt : '',
            lastSavedAt: typeof record.lastSavedAt === 'string' ? record.lastSavedAt : '',
            dwellMs: finiteMs(record.dwellMs),
            activeDays: Array.isArray(record.activeDays) ? record.activeDays.filter((day): day is string => typeof day === 'string') : [],
          }
        }
      } catch {
        pageStats = null
      }
      let historyAt: string[] | undefined
      if (readHistory) {
        try {
          const entries = await readHistory(node.relativePath)
          if (Array.isArray(entries)) {
            historyAt = entries
              .map((entry) => entry?.createdAt)
              .filter((value): value is string => typeof value === 'string' && value.length > 0)
          }
        } catch {
          historyAt = undefined
        }
      }
      notes.push({
        createdAt: typeof node.createdAt === 'string' ? node.createdAt : undefined,
        modifiedAt: typeof node.modifiedAt === 'string' ? node.modifiedAt : undefined,
        historyAt,
        pageStats,
      })
    }
  }
  await walk(nodes)
  return notes
}

export const resolveProfileOrigin = () => {
  const platform = typeof window !== 'undefined' ? window.fanotes?.platform : undefined
  if ((platform === 'web' || platform === 'browser-preview') && typeof window !== 'undefined' && window.location?.origin?.startsWith('http')) {
    return window.location.origin
  }
  return PROFILE_ORIGIN
}

export function createFetchProfilePort(fetchImpl: typeof fetch = fetch): ProfilePort {
  return {
    async exchange(request) {
      let response: Response
      try {
        response = await fetchImpl(request.url, {
          method: request.method,
          headers: request.headers,
          body: request.method === 'GET' ? undefined : request.body,
          cache: 'no-store',
        })
      } catch (error) {
        const aborted = error instanceof Error && error.name === 'AbortError'
        throw new ProfileRequestError(0, aborted ? 'Die Profil-Anfrage wurde abgebrochen.' : 'Der Profil-Server ist nicht erreichbar.')
      }
      return { status: response.status, body: await response.text() }
    },
  }
}

const profileHeaders = { Accept: 'application/json', 'Content-Type': 'application/json' }

const readObject = (body: string) => {
  try {
    const parsed = JSON.parse(body) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    return parsed as Record<string, unknown>
  } catch {
    return null
  }
}

const requireUsername = (raw: string) => {
  const username = normalizeUsername(raw)
  if (!username) throw new ProfileRequestError(400, 'Zuerst einen Benutzernamen festlegen.')
  return username
}

const requireOwner = (ownerId: string) => {
  if (!isProfileOwnerId(ownerId)) throw new ProfileRequestError(400, 'Die Übersicht konnte nicht gespeichert werden.')
  return ownerId
}

const refuse = (response: ProfileHttpResponse): never => {
  const parsed = readObject(response.body)
  const taken = parsed?.taken === true
  throw new ProfileRequestError(
    response.status,
    taken ? 'Dieser Benutzername ist schon vergeben.' : 'Die Übersicht konnte nicht gespeichert werden.',
    taken,
  )
}

export async function claimUsername(input: {
  username: string
  ownerId: string
  joinedAt?: string
  loadNotes?: () => Promise<readonly ProfileNoteSource[]> | readonly ProfileNoteSource[]
  port: ProfilePort
  origin?: string
}): Promise<ProfileClaim> {
  const username = requireUsername(input.username)
  const ownerId = requireOwner(input.ownerId)
  const origin = (input.origin ?? resolveProfileOrigin()).replace(/\/$/u, '')
  let joinedAt = input.joinedAt
  if (input.loadNotes) {
    try {
      const notes = await adoptNotes(input.loadNotes)
      joinedAt = earlierProfileStamp(joinedAt, earliestProfileJoinedAt(notes)) ?? joinedAt
    } catch {
      // No history yet: the claim time below is the fallback.
    }
  }
  if (!joinedAt) joinedAt = new Date().toISOString()
  const response = await input.port.exchange({
    method: 'PUT',
    url: `${origin}${PROFILE_API_PATH}`,
    headers: profileHeaders,
    body: JSON.stringify({
      schemaVersion: 1,
      action: 'claim',
      username,
      ownerId,
      joinedAt,
    }),
  })
  if (response.status < 200 || response.status >= 300) refuse(response)
  const parsed = readObject(response.body)
  const path = typeof parsed?.path === 'string' ? parsed.path : ''
  if (!parsed || parsed.username !== username || path !== profilePath(username) || typeof parsed.joinedAt !== 'string') {
    throw new ProfileRequestError(502, 'Die Übersicht konnte nicht gespeichert werden.')
  }
  return {
    username,
    path,
    link: `${origin}${path}`,
    joinedAt: parsed.joinedAt,
    public: parsed.public === true,
  }
}

const activityBody = (notes: readonly ProfileNoteSource[], joinedAt: string) => {
  const activity = summarizeProfileActivity(notes, joinedAt)
  return {
    noteCount: activity.noteCount,
    dwellMs: activity.dwellMs,
    activeDays: activity.activeDays,
    dayCounts: activity.dayCounts,
  }
}

export async function publishProfile(input: {
  username: string
  ownerId: string
  notes: readonly ProfileNoteSource[]
  joinedAt?: string
  appearance?: ProfileAppearance
  port: ProfilePort
  origin?: string
}): Promise<PublicProfile> {
  const username = requireUsername(input.username)
  const ownerId = requireOwner(input.ownerId)
  const origin = (input.origin ?? resolveProfileOrigin()).replace(/\/$/u, '')
  const joinedAt = earlierProfileStamp(input.joinedAt, earliestProfileJoinedAt(input.notes))
  const response = await input.port.exchange({
    method: 'PUT',
    url: `${origin}${PROFILE_API_PATH}`,
    headers: profileHeaders,
    body: JSON.stringify({
      schemaVersion: 1,
      action: 'publish',
      username,
      ownerId,
      ...activityBody(input.notes, joinedAt ?? input.joinedAt ?? ''),
      ...(joinedAt ? { joinedAt } : {}),
      ...(input.appearance ? {
        theme: input.appearance.theme,
        accent: input.appearance.accent,
        accentSecondary: input.appearance.accentSecondary,
      } : {}),
    }),
  })
  if (response.status < 200 || response.status >= 300) refuse(response)
  const parsed = readObject(response.body)
  const overview = parsePublicProfile(parsed)
  if (!overview || overview.username !== username) throw new ProfileRequestError(502, 'Die Übersicht konnte nicht gespeichert werden.')
  return overview
}

export async function unpublishProfile(input: {
  username: string
  ownerId: string
  port: ProfilePort
  origin?: string
}): Promise<void> {
  const username = requireUsername(input.username)
  const ownerId = requireOwner(input.ownerId)
  const origin = (input.origin ?? resolveProfileOrigin()).replace(/\/$/u, '')
  const response = await input.port.exchange({
    method: 'PUT',
    url: `${origin}${PROFILE_API_PATH}`,
    headers: profileHeaders,
    body: JSON.stringify({ schemaVersion: 1, action: 'unpublish', username, ownerId }),
  })
  if (response.status < 200 || response.status >= 300) refuse(response)
}

/**
 * Republishes an overview that is already public. An empty read is ignored so
 * a vault that is not open yet cannot replace the stored activity with zeros.
 */
export async function refreshPublicOverview(input: {
  username: string
  ownerId: string
  loadNotes: () => Promise<readonly ProfileNoteSource[]> | readonly ProfileNoteSource[]
  appearance?: ProfileAppearance
  port: ProfilePort
  origin?: string
  stillEnabled?: () => boolean
}): Promise<PublicProfile | null> {
  if (input.stillEnabled && !input.stillEnabled()) return null
  const notes = await adoptNotes(input.loadNotes)
  if (input.stillEnabled && !input.stillEnabled()) return null
  if (!notes.length) return null
  return publishProfile({
    username: input.username,
    ownerId: input.ownerId,
    notes,
    appearance: input.appearance,
    port: input.port,
    origin: input.origin,
  })
}

/** The settings switch. It publishes the summary, or withdraws it. It does not claim a name. */
export async function setProfileVisibility(input: {
  enabled: boolean
  username: string
  ownerId: string
  notes?: readonly ProfileNoteSource[]
  port: ProfilePort
  origin?: string
}): Promise<PublicProfile | null> {
  if (!normalizeUsername(input.username)) throw new ProfileRequestError(400, 'Zuerst einen Benutzernamen festlegen.')
  if (!input.enabled) {
    await unpublishProfile(input)
    return null
  }
  return publishProfile({ ...input, notes: input.notes ?? [] })
}

const adoptNotes = (loadNotes: () => Promise<readonly ProfileNoteSource[]> | readonly ProfileNoteSource[]) => new Promise<readonly ProfileNoteSource[]>((resolve, reject) => {
  try {
    resolve(loadNotes())
  } catch (error) {
    reject(error)
  }
})

/**
 * Opens the public page with one small upload, then sends the activity
 * numbers as soon as they are counted. The page is public before the vault
 * walk finishes. A later switch-off withdraws the page instead of publishing
 * numbers over that choice.
 */
export async function enableProfileOverview(input: {
  username: string
  ownerId: string
  loadNotes: () => Promise<readonly ProfileNoteSource[]> | readonly ProfileNoteSource[]
  port: ProfilePort
  origin?: string
  joinedAt?: string
  appearance?: ProfileAppearance
  stillEnabled?: () => boolean
  onPublic?: (overview: PublicProfile) => void
}): Promise<PublicProfile | null> {
  requireUsername(input.username)
  requireOwner(input.ownerId)
  const current = () => input.stillEnabled?.() !== false
  if (!current()) return null
  const notesPromise = adoptNotes(input.loadNotes)
  void notesPromise.catch(() => undefined)
  const publish = (notes: readonly ProfileNoteSource[]) => publishProfile({
    username: input.username,
    ownerId: input.ownerId,
    notes,
    joinedAt: input.joinedAt,
    appearance: input.appearance,
    port: input.port,
    origin: input.origin,
  })
  const opened = await publish([])
  if (!current()) {
    await unpublishProfile(input)
    return null
  }
  input.onPublic?.(opened)
  const notes = await notesPromise
  if (!current()) {
    await unpublishProfile(input)
    return null
  }
  if (!notes.length) return opened
  const published = await publish(notes)
  if (!current()) {
    await unpublishProfile(input)
    return null
  }
  return published
}

export async function readPublicProfile(input: {
  username: string
  port: ProfilePort
  origin?: string
}): Promise<PublicProfile | null> {
  const username = normalizeUsername(input.username)
  if (!username) return null
  const origin = (input.origin ?? resolveProfileOrigin()).replace(/\/$/u, '')
  const response = await input.port.exchange({
    method: 'GET',
    url: `${origin}${PROFILE_API_PATH}/${encodeURIComponent(username)}`,
    headers: { Accept: 'application/json' },
    body: '',
  })
  if (response.status === 404 || response.status === 410) return null
  if (response.status < 200 || response.status >= 300) return null
  return parsePublicProfile(readObject(response.body))
}

export const parsePublicProfile = (parsed: Record<string, unknown> | null): PublicProfile | null => {
  if (!parsed || parsed.public !== true) return null
  if (typeof parsed.username !== 'string' || typeof parsed.joinedAt !== 'string') return null
  if (typeof parsed.noteCount !== 'number' || typeof parsed.dwellMs !== 'number' || typeof parsed.durationLabel !== 'string') return null
  if (!Array.isArray(parsed.activeDays) || parsed.activeDays.some((day) => typeof day !== 'string')) return null
  const username = normalizeUsername(parsed.username)
  if (!username) return null
  const dayCounts: Record<string, number> = {}
  if (parsed.dayCounts && typeof parsed.dayCounts === 'object' && !Array.isArray(parsed.dayCounts)) {
    const counts = parsed.dayCounts as Record<string, unknown>
    for (const day of Object.keys(counts)) {
      const value = counts[day]
      if (DAY_PATTERN.test(day) && typeof value === 'number' && Number.isSafeInteger(value) && value > 0) dayCounts[day] = value
    }
  }
  const theme = typeof parsed.theme === 'string' && (PROFILE_THEMES as readonly string[]).includes(parsed.theme)
    ? parsed.theme as ProfileTheme
    : undefined
  const accent = typeof parsed.accent === 'string' && HEX_COLOR.test(parsed.accent) ? parsed.accent.toLowerCase() : undefined
  const accentSecondary = typeof parsed.accentSecondary === 'string' && HEX_COLOR.test(parsed.accentSecondary)
    ? parsed.accentSecondary.toLowerCase()
    : undefined
  return {
    public: true,
    username,
    path: typeof parsed.path === 'string' ? parsed.path : profilePath(username),
    joinedAt: parsed.joinedAt,
    noteCount: parsed.noteCount,
    dwellMs: parsed.dwellMs,
    durationLabel: parsed.durationLabel,
    activeDays: parsed.activeDays.filter((day): day is string => typeof day === 'string'),
    dayCounts,
    ...(theme ? { theme } : {}),
    ...(accent ? { accent } : {}),
    ...(accentSecondary ? { accentSecondary } : {}),
  }
}
