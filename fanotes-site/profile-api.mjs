import { randomBytes } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

// Public usernames and the activity overview. Not vault sync (/api/v1/sync)
// and not a note share (/api/v1/share). The record is a name, the claim time,
// and the numbers the owner published. Note text is not accepted.

const PROFILE_ROOT = resolve(process.env.FANOTES_PROFILE_DIR || '/var/lib/fanotes-profiles')
const PAGE_PATH = fileURLToPath(new URL('./public/user/index.html', import.meta.url))
const USERNAME_PATTERN = /^[a-z0-9](?:[a-z0-9]|[-_](?![_-])){1,22}[a-z0-9]$/u
const OWNER_PATTERN = /^[a-f0-9]{32}$/u
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/u
const MAX_BODY_BYTES = 64 * 1024
const MAX_ACTIVE_DAYS = 1500
const THEME_IDS = new Set(['dark', 'light', 'midnight', 'forest', 'aurora', 'sepia'])
const HEX_COLOR = /^#[0-9a-f]{6}$/iu

const RESERVED_USERNAMES = new Set([
  'about', 'admin', 'api', 'assets', 'css', 'download', 'fanotes', 'favicon',
  'help', 'index', 'js', 'login', 'me', 'notes', 'null', 'profile', 'public',
  'robots', 'root', 'settings', 'share', 'static', 'support', 'undefined',
  'user', 'users', 'viewer', 'www',
])

const rateWindows = new Map()
let profileTail = Promise.resolve()

const withProfileLock = (task) => {
  const run = profileTail.then(task, task)
  profileTail = run.then(() => undefined, () => undefined)
  return run
}

class ProfileApiError extends Error {
  constructor(status, publicMessage, taken = false) {
    super(publicMessage)
    this.status = status
    this.publicMessage = publicMessage
    this.taken = taken
  }
}

const fail = (status, publicMessage, taken = false) => {
  throw new ProfileApiError(status, publicMessage, taken)
}

const clientAddress = (request) => {
  const forwarded = request.headers['x-real-ip']
  return typeof forwarded === 'string' && forwarded.length <= 64 ? forwarded : request.socket.remoteAddress || 'unknown'
}

const rateLimit = (key, maximum, windowMs) => {
  const now = Date.now()
  const current = rateWindows.get(key)
  if (!current || current.until <= now) {
    rateWindows.set(key, { count: 1, until: now + windowMs })
    return
  }
  if (current.count >= maximum) fail(429, 'Zu viele Anfragen. Bitte später erneut versuchen.')
  current.count += 1
}

const safeJoin = (root, name) => {
  const target = resolve(root, name)
  if (target !== root && !target.startsWith(`${root}${sep}`)) fail(400, 'Ungültiger Pfad.')
  return target
}

const namesDir = () => safeJoin(PROFILE_ROOT, 'names')
const ownersDir = () => safeJoin(PROFILE_ROOT, 'owners')
const namePath = (username) => safeJoin(namesDir(), `${username}.json`)
const ownerPath = (ownerId) => safeJoin(ownersDir(), ownerId)

const readRecord = async (username) => {
  try {
    const raw = JSON.parse(await fs.readFile(namePath(username), 'utf8'))
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
    return raw
  } catch {
    return null
  }
}

const readOwnerName = async (ownerId) => {
  try {
    const name = (await fs.readFile(ownerPath(ownerId), 'utf8')).trim()
    return normalizeUsername(name)
  } catch {
    return null
  }
}

const writeRecord = async (username, value) => {
  await fs.mkdir(namesDir(), { recursive: true, mode: 0o700 })
  const target = namePath(username)
  const temporary = `${target}.${randomBytes(8).toString('hex')}.tmp`
  await fs.writeFile(temporary, JSON.stringify(value), { encoding: 'utf8', mode: 0o600, flag: 'wx' })
  await fs.rename(temporary, target)
}

const writeOwnerName = async (ownerId, username) => {
  await fs.mkdir(ownersDir(), { recursive: true, mode: 0o700 })
  const target = ownerPath(ownerId)
  const temporary = `${target}.${randomBytes(8).toString('hex')}.tmp`
  await fs.writeFile(temporary, username, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
  await fs.rename(temporary, target)
}

const readJsonBody = async (request) => {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) fail(413, 'Die Anfrage ist zu groß.')
    chunks.push(chunk)
  }
  if (!chunks.length) fail(400, 'Ungültiges Profil.')
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    fail(400, 'Ungültiges JSON.')
  }
}

export const normalizeUsername = (raw) => {
  if (typeof raw !== 'string') return null
  const name = raw.trim().toLowerCase()
  if (!USERNAME_PATTERN.test(name) || RESERVED_USERNAMES.has(name)) return null
  return name
}

const publicOrigin = () => (process.env.FANOTES_PUBLIC_ORIGIN || 'https://fanotes.fasrv.ch').replace(/\/$/u, '')

const profilePath = (username) => `/user/${username}`

const formatDwell = (dwellMs) => {
  const totalSeconds = Math.max(0, Math.floor(dwellMs / 1000))
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  if (hours > 0) return `${hours} h ${minutes} min`
  if (minutes > 0) return `${minutes} min ${seconds} s`
  return `${seconds} s`
}

const parseJoined = (value) => {
  if (typeof value !== 'string' || value.length > 40) return null
  const ms = Date.parse(value)
  if (!Number.isFinite(ms)) return null
  const year = new Date(ms).getUTCFullYear()
  if (year < 2000 || year > 2100) return null
  return new Date(ms).toISOString()
}

/** A later date never replaces the stored one. An earlier date may. */
const earlierJoined = (current, requested) => {
  const stored = parseJoined(current)
  const next = parseJoined(requested)
  if (stored && next) return next < stored ? next : stored
  return stored || next || (typeof current === 'string' ? current : new Date().toISOString())
}

const visibleJoinedAt = (record) => {
  let best = parseJoined(record?.joinedAt)
  const days = Array.isArray(record?.activeDays) ? record.activeDays : []
  for (const day of days) {
    if (typeof day !== 'string' || !DAY_PATTERN.test(day)) continue
    const stamp = parseJoined(`${day}T00:00:00.000Z`)
    if (stamp && (!best || stamp < best)) best = stamp
  }
  return best || record?.joinedAt
}

const sanitizeHex = (value) => (typeof value === 'string' && HEX_COLOR.test(value) ? value.toLowerCase() : '')

const sanitizeTheme = (value) => (typeof value === 'string' && THEME_IDS.has(value) ? value : '')

const sanitizeDayCounts = (raw, activeDays) => {
  const counts = {}
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return counts
  for (const day of activeDays) {
    const value = raw[day]
    if (!Number.isSafeInteger(value) || value <= 0 || value > 10000) continue
    counts[day] = value
  }
  return counts
}

/** Same even sample as the client's capProfileDays: the first day, the last day, and the shape stay. */
const capActiveDays = (days) => {
  const unique = [...new Set(days)].sort()
  if (unique.length <= MAX_ACTIVE_DAYS) return unique
  const kept = new Set()
  const stride = (unique.length - 1) / (MAX_ACTIVE_DAYS - 1)
  for (let index = 0; index < MAX_ACTIVE_DAYS; index += 1) kept.add(unique[Math.round(index * stride)])
  return [...kept].sort()
}

const sanitizeActivity = (raw) => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail(400, 'Ungültige Übersicht.')
  if (!Number.isSafeInteger(raw.noteCount) || raw.noteCount < 0 || raw.noteCount > 1_000_000) fail(400, 'Ungültige Übersicht.')
  if (!Number.isSafeInteger(raw.dwellMs) || raw.dwellMs < 0 || raw.dwellMs > 100 * 365 * 24 * 60 * 60 * 1000) fail(400, 'Ungültige Übersicht.')
  if (!Array.isArray(raw.activeDays)) fail(400, 'Ungültige Übersicht.')
  const activeDays = []
  for (const day of raw.activeDays) {
    if (typeof day !== 'string' || !DAY_PATTERN.test(day)) fail(400, 'Ungültige Übersicht.')
    activeDays.push(day)
  }
  return {
    noteCount: raw.noteCount,
    dwellMs: raw.dwellMs,
    durationLabel: formatDwell(raw.dwellMs),
    activeDays: capActiveDays(activeDays),
  }
}

const requireOwner = (raw) => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail(400, 'Ungültiges Profil.')
  if (typeof raw.ownerId !== 'string' || !OWNER_PATTERN.test(raw.ownerId)) fail(400, 'Ungültiges Profil.')
  const username = normalizeUsername(raw.username)
  if (!username) fail(400, 'Ungültiger Benutzername.')
  return { ownerId: raw.ownerId, username }
}

const identityOf = (record, username) => ({
  schemaVersion: 1,
  username,
  ownerId: record.ownerId,
  path: profilePath(username),
  joinedAt: record.joinedAt,
  public: false,
})

const claimRecord = async (raw) => {
  const { ownerId, username } = requireOwner(raw)
  const existing = await readRecord(username)
  if (existing && existing.ownerId !== ownerId) fail(409, 'Dieser Benutzername ist vergeben.', true)
  const previousName = await readOwnerName(ownerId)
  if (previousName && previousName !== username) {
    const previous = await readRecord(previousName)
    if (previous?.ownerId === ownerId) await fs.rm(namePath(previousName), { force: true })
  }
  const joinedAt = existing?.ownerId === ownerId
    ? earlierJoined(existing.joinedAt, raw.joinedAt)
    : parseJoined(raw.joinedAt) || new Date().toISOString()
  const record = existing?.ownerId === ownerId
    ? { ...existing, username, path: profilePath(username), joinedAt }
    : { ...identityOf({ ownerId, joinedAt }, username), joinedAt }
  await writeRecord(username, record)
  await writeOwnerName(ownerId, username)
  return record
}

const publishRecord = async (raw) => {
  const { ownerId, username } = requireOwner(raw)
  const existing = await readRecord(username)
  if (!existing || existing.ownerId !== ownerId) fail(409, 'Zuerst den Benutzernamen festlegen.')
  const activity = sanitizeActivity(raw)
  const joinedAt = earlierJoined(existing.joinedAt, raw.joinedAt)
  const theme = sanitizeTheme(raw.theme) || sanitizeTheme(existing.theme)
  const accent = sanitizeHex(raw.accent) || sanitizeHex(existing.accent)
  const accentSecondary = sanitizeHex(raw.accentSecondary) || sanitizeHex(existing.accentSecondary)
  const dayCounts = raw.dayCounts === undefined && existing.dayCounts
    ? sanitizeDayCounts(existing.dayCounts, activity.activeDays)
    : sanitizeDayCounts(raw.dayCounts, activity.activeDays)
  const record = {
    ...identityOf(existing, username),
    joinedAt,
    public: true,
    noteCount: activity.noteCount,
    dwellMs: activity.dwellMs,
    durationLabel: activity.durationLabel,
    activeDays: activity.activeDays,
    ...(theme ? { theme } : {}),
    ...(accent ? { accent } : {}),
    ...(accentSecondary ? { accentSecondary } : {}),
    ...(raw.dayCounts !== undefined || existing.dayCounts ? { dayCounts } : {}),
  }
  await writeRecord(username, record)
  return record
}

const unpublishRecord = async (raw) => {
  const { ownerId, username } = requireOwner(raw)
  const existing = await readRecord(username)
  if (!existing) return identityOf({ ownerId, joinedAt: new Date().toISOString() }, username)
  if (existing.ownerId !== ownerId) fail(409, 'Dieser Benutzername ist vergeben.', true)
  const record = identityOf(existing, username)
  await writeRecord(username, record)
  return record
}

const claimResponse = (record) => ({
  ok: true,
  username: record.username,
  path: record.path,
  link: `${publicOrigin()}${record.path}`,
  joinedAt: record.joinedAt,
  public: record.public === true,
})

const overviewResponse = (record) => {
  const theme = sanitizeTheme(record.theme)
  const accent = sanitizeHex(record.accent)
  const accentSecondary = sanitizeHex(record.accentSecondary)
  const activeDays = Array.isArray(record.activeDays) ? record.activeDays : []
  const dayCounts = record.dayCounts ? sanitizeDayCounts(record.dayCounts, activeDays) : null
  return {
    public: true,
    username: record.username,
    path: record.path,
    link: `${publicOrigin()}${record.path}`,
    joinedAt: visibleJoinedAt(record),
    noteCount: record.noteCount,
    dwellMs: record.dwellMs,
    durationLabel: record.durationLabel,
    activeDays,
    ...(theme ? { theme } : {}),
    ...(accent ? { accent } : {}),
    ...(accentSecondary ? { accentSecondary } : {}),
    ...(dayCounts ? { dayCounts } : {}),
  }
}

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Accept, Content-Type',
  'Access-Control-Allow-Methods': 'GET, PUT, OPTIONS',
  'Access-Control-Max-Age': '600',
}

const writeJson = (response, status, value, extraHeaders = {}) => {
  const body = JSON.stringify(value)
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...corsHeaders,
    ...extraHeaders,
  })
  response.end(body)
}

const usernameFromGet = (pathname) => {
  const match = /^\/api\/v1\/profile\/([^/]+)$/u.exec(pathname)
  if (!match) return ''
  let decoded = match[1]
  try { decoded = decodeURIComponent(match[1]) } catch { return '' }
  return normalizeUsername(decoded) || ''
}

let pageBytes = null
const profilePage = async () => {
  pageBytes ??= await fs.readFile(PAGE_PATH)
  return pageBytes
}

const serveProfilePage = async (request, response) => {
  const body = await profilePage()
  response.writeHead(request.method === 'HEAD' ? 200 : 200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  })
  response.end(request.method === 'HEAD' ? undefined : body)
}

export const handleProfileRequest = async (request, response, url) => {
  const { pathname } = url
  const isApi = pathname === '/api/v1/profile' || pathname.startsWith('/api/v1/profile/')
  const isPage = pathname === '/user' || (pathname.startsWith('/user/') && USERNAME_PATTERN.test(pathname.slice('/user/'.length)))
  if (!isApi && !isPage) return false
  try {
    if (isPage) {
      if (pathname === '/user') {
        response.writeHead(308, { Location: '/user/', 'Cache-Control': 'no-store' })
        response.end()
        return true
      }
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        writeJson(response, 405, { error: 'Diese Profiladresse erlaubt nur GET und HEAD.' }, { Allow: 'GET, HEAD' })
        return true
      }
      await serveProfilePage(request, response)
      return true
    }

    if (request.method === 'OPTIONS') {
      response.writeHead(204, { 'Cache-Control': 'no-store', ...corsHeaders })
      response.end()
      return true
    }

    if (request.method === 'PUT' && pathname === '/api/v1/profile') {
      rateLimit(`profile-put:${clientAddress(request)}`, 60, 60_000)
      const raw = await readJsonBody(request)
      const action = raw?.action
      const record = await withProfileLock(async () => {
        if (action === 'claim') return claimRecord(raw)
        if (action === 'publish') return publishRecord(raw)
        if (action === 'unpublish') return unpublishRecord(raw)
        fail(400, 'Ungültiges Profil.')
      })
      if (action === 'publish') writeJson(response, 200, overviewResponse(record))
      else if (action === 'unpublish') writeJson(response, 200, { ok: true, public: false, username: record.username, path: record.path })
      else writeJson(response, 200, claimResponse(record))
      return true
    }

    if ((request.method === 'GET' || request.method === 'HEAD') && pathname.startsWith('/api/v1/profile/')) {
      rateLimit(`profile-get:${clientAddress(request)}`, 120, 60_000)
      const username = usernameFromGet(pathname)
      if (!username) {
        writeJson(response, 404, { public: false })
        return true
      }
      const record = await readRecord(username)
      if (!record?.public) {
        writeJson(response, 404, { public: false })
        return true
      }
      if (request.method === 'HEAD') {
        response.writeHead(200, { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...corsHeaders })
        response.end()
        return true
      }
      writeJson(response, 200, overviewResponse(record))
      return true
    }

    writeJson(response, 405, { error: 'Für Profile sind nur GET, PUT und OPTIONS erlaubt.' }, { Allow: 'GET, PUT, OPTIONS' })
    return true
  } catch (error) {
    const status = error instanceof ProfileApiError ? error.status : 500
    const message = error instanceof ProfileApiError ? error.publicMessage : 'Das Profil ist vorübergehend nicht verfügbar.'
    const body = error instanceof ProfileApiError && error.taken ? { error: message, taken: true } : { error: message }
    writeJson(response, status, body)
    return true
  }
}
