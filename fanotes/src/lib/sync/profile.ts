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
  children?: ProfileVaultNode[]
}

/** A note the overview may count. Text fields are accepted and then dropped. */
export type ProfileNoteSource = {
  path?: string
  title?: string
  content?: string
  createdAt?: string
  dwellMs?: number
  activeDays?: readonly string[]
  pageStats?: Pick<PageStats, 'createdAt' | 'dwellMs' | 'activeDays'> | null
}

export type ProfileActivity = {
  joinedAt: string
  noteCount: number
  dwellMs: number
  durationLabel: string
  activeDays: string[]
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

/**
 * Joined time, note count, total visible time, and the dates those notes were
 * used. Titles, paths, and written text are not copied into the result.
 */
export const summarizeProfileActivity = (notes: readonly ProfileNoteSource[], joinedAt: string): ProfileActivity => {
  const days = new Set<string>()
  let dwellMs = 0
  for (const note of notes) {
    const stats = note.pageStats
    dwellMs += finiteMs(stats?.dwellMs ?? note.dwellMs)
    for (const day of daysFrom(stats?.activeDays ?? note.activeDays)) days.add(day)
  }
  return {
    joinedAt,
    noteCount: notes.length,
    dwellMs,
    durationLabel: formatPageDwell(dwellMs),
    activeDays: [...days].sort(),
  }
}

const isMarkdownNote = (node: ProfileVaultNode) => (
  node.kind === 'file' && (node.extension === 'md' || node.relativePath.toLowerCase().endsWith('.md'))
)

/** Counts markdown notes and reads their page stats. File text is never read. */
export const loadProfileNotes = async (
  nodes: readonly ProfileVaultNode[],
  readStats: (path: string) => Promise<unknown>,
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
          const record = raw as { dwellMs?: unknown; activeDays?: unknown }
          pageStats = {
            createdAt: '',
            dwellMs: finiteMs(record.dwellMs),
            activeDays: Array.isArray(record.activeDays) ? record.activeDays.filter((day): day is string => typeof day === 'string') : [],
          }
        }
      } catch {
        pageStats = null
      }
      notes.push({ pageStats })
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
  port: ProfilePort
  origin?: string
}): Promise<ProfileClaim> {
  const username = requireUsername(input.username)
  const ownerId = requireOwner(input.ownerId)
  const origin = (input.origin ?? resolveProfileOrigin()).replace(/\/$/u, '')
  const response = await input.port.exchange({
    method: 'PUT',
    url: `${origin}${PROFILE_API_PATH}`,
    headers: profileHeaders,
    body: JSON.stringify({
      schemaVersion: 1,
      action: 'claim',
      username,
      ownerId,
      ...(input.joinedAt ? { joinedAt: input.joinedAt } : {}),
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
  }
}

export async function publishProfile(input: {
  username: string
  ownerId: string
  notes: readonly ProfileNoteSource[]
  joinedAt?: string
  port: ProfilePort
  origin?: string
}): Promise<PublicProfile> {
  const username = requireUsername(input.username)
  const ownerId = requireOwner(input.ownerId)
  const origin = (input.origin ?? resolveProfileOrigin()).replace(/\/$/u, '')
  const response = await input.port.exchange({
    method: 'PUT',
    url: `${origin}${PROFILE_API_PATH}`,
    headers: profileHeaders,
    body: JSON.stringify({
      schemaVersion: 1,
      action: 'publish',
      username,
      ownerId,
      ...activityBody(input.notes, input.joinedAt ?? ''),
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
  return {
    public: true,
    username,
    path: typeof parsed.path === 'string' ? parsed.path : profilePath(username),
    joinedAt: parsed.joinedAt,
    noteCount: parsed.noteCount,
    dwellMs: parsed.dwellMs,
    durationLabel: parsed.durationLabel,
    activeDays: parsed.activeDays.filter((day): day is string => typeof day === 'string'),
  }
}
