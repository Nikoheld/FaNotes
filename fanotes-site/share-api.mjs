import { randomBytes } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { resolve, sep } from 'node:path'

// Public note links. This store is not vault sync (/api/v1/sync).
// The link id is the capability: the desktop client uploads readable
// title and markdown, and the browser viewer reads the same record.

const SHARE_ROOT = resolve(process.env.FANOTES_SHARE_DIR || '/var/lib/fanotes-shares')
const ID_PATTERN = /^[a-f0-9]{32}$/u
const MAX_BODY_BYTES = 8 * 1024 * 1024
const MAX_NOTES = 400
const MAX_NOTE_CHARS = 500_000
const MAX_PATH_CHARS = 512
const MAX_TITLE_CHARS = 300

const rateWindows = new Map()

class ShareApiError extends Error {
  constructor(status, publicMessage) {
    super(publicMessage)
    this.status = status
    this.publicMessage = publicMessage
  }
}

const fail = (status, publicMessage) => {
  throw new ShareApiError(status, publicMessage)
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

const recordPath = (id) => safeJoin(SHARE_ROOT, `${id}.json`)

const readRecord = async (id) => {
  try {
    const raw = JSON.parse(await fs.readFile(recordPath(id), 'utf8'))
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
    return raw
  } catch {
    return null
  }
}

const writeRecord = async (id, value) => {
  await fs.mkdir(SHARE_ROOT, { recursive: true, mode: 0o700 })
  const target = recordPath(id)
  const temporary = `${target}.${randomBytes(8).toString('hex')}.tmp`
  await fs.writeFile(temporary, JSON.stringify(value), { encoding: 'utf8', mode: 0o600, flag: 'wx' })
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
  if (!chunks.length) fail(400, 'Ungültige Freigabe.')
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    fail(400, 'Ungültiges JSON.')
  }
}

const boundedString = (value, maximum, label) => {
  if (typeof value !== 'string') fail(400, label)
  if (value.length > maximum) fail(413, 'Die Freigabe ist zu groß.')
  return value
}

export const sanitizeSharePayload = (raw, id) => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail(400, 'Ungültige Freigabe.')
  if (raw.schemaVersion !== 1) fail(400, 'Ungültige Freigabe.')
  if (raw.id !== id) fail(400, 'Die Freigabe-Kennung stimmt nicht.')
  if (raw.mode !== 'copy' && raw.mode !== 'live') fail(400, 'Ungültige Freigabeart.')
  if (!Array.isArray(raw.notes) || raw.notes.length > MAX_NOTES) fail(400, 'Ungültige Freigabe.')
  const notes = raw.notes.map((note) => {
    if (!note || typeof note !== 'object' || Array.isArray(note)) fail(400, 'Ungültige Notiz.')
    return {
      path: boundedString(note.path, MAX_PATH_CHARS, 'Ungültige Notiz.'),
      title: boundedString(typeof note.title === 'string' ? note.title : '', MAX_TITLE_CHARS, 'Ungültige Notiz.'),
      content: boundedString(note.content, MAX_NOTE_CHARS, 'Ungültige Notiz.'),
    }
  })
  return {
    schemaVersion: 1,
    id,
    mode: raw.mode,
    kind: raw.kind === 'folder' ? 'folder' : 'note',
    rootPath: boundedString(typeof raw.rootPath === 'string' ? raw.rootPath : '', MAX_PATH_CHARS, 'Ungültige Freigabe.'),
    title: boundedString(typeof raw.title === 'string' ? raw.title : '', MAX_TITLE_CHARS, 'Ungültige Freigabe.'),
    notes,
    updatedAt: boundedString(typeof raw.updatedAt === 'string' ? raw.updatedAt : new Date().toISOString(), 40, 'Ungültige Freigabe.'),
    stopped: false,
  }
}

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Accept, Content-Type, X-FaNotes-Share',
  'Access-Control-Allow-Methods': 'GET, PUT, DELETE, OPTIONS',
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

const shareIdFromPath = (pathname) => {
  const match = /^\/api\/v1\/share\/([a-f0-9]{32})$/u.exec(pathname)
  return match && ID_PATTERN.test(match[1]) ? match[1] : ''
}

export const handleShareRequest = async (request, response, url) => {
  if (url.pathname !== '/api/v1/share' && !url.pathname.startsWith('/api/v1/share/')) return false
  try {
    if (request.method === 'OPTIONS') {
      response.writeHead(204, { 'Cache-Control': 'no-store', ...corsHeaders })
      response.end()
      return true
    }
    const id = shareIdFromPath(url.pathname)
    if (!id) fail(400, 'Ungültige Freigabe-Kennung.')

    if (request.method === 'PUT') {
      rateLimit(`share-put:${clientAddress(request)}`, 60, 60_000)
      const existing = await readRecord(id)
      if (existing?.stopped) fail(410, 'Diese Freigabe wurde beendet.')
      const payload = sanitizeSharePayload(await readJsonBody(request), id)
      await writeRecord(id, payload)
      writeJson(response, 200, { ok: true, id })
      return true
    }

    if (request.method === 'GET' || request.method === 'HEAD') {
      rateLimit(`share-get:${clientAddress(request)}`, 120, 60_000)
      const record = await readRecord(id)
      if (!record) {
        writeJson(response, 404, { error: 'Nicht gefunden.' })
        return true
      }
      if (record.stopped) {
        writeJson(response, 410, { stopped: true, notes: [] })
        return true
      }
      if (request.method === 'HEAD') {
        response.writeHead(200, { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...corsHeaders })
        response.end()
        return true
      }
      writeJson(response, 200, record)
      return true
    }

    if (request.method === 'DELETE') {
      rateLimit(`share-delete:${clientAddress(request)}`, 60, 60_000)
      const record = await readRecord(id)
      if (record && !record.stopped) {
        await writeRecord(id, { ...record, stopped: true, notes: [] })
      }
      writeJson(response, 200, { ok: true, stopped: true })
      return true
    }

    writeJson(response, 405, { error: 'Nur GET, PUT und DELETE sind für Freigaben erlaubt.' }, { Allow: 'GET, PUT, DELETE, OPTIONS' })
    return true
  } catch (error) {
    const status = error instanceof ShareApiError ? error.status : 500
    const message = error instanceof ShareApiError ? error.publicMessage : 'Die Freigabe ist vorübergehend nicht verfügbar.'
    writeJson(response, status, { error: message })
    return true
  }
}
