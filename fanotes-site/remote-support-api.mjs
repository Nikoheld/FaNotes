import { createHash, timingSafeEqual } from 'node:crypto'

const PUBLIC_ORIGIN = process.env.FANOTES_PUBLIC_ORIGIN || 'https://fanotes.fasrv.ch'
const TOKEN_PATTERN = /^[0-9a-f]{24}$/u
const MAX_BODY_BYTES = 2 * 1024 * 1024
const MAX_PENDING = 32
const SESSION_TTL_MS = 4 * 60 * 60 * 1000
const RESULT_TTL_MS = 10 * 60 * 1000

const rateWindows = new Map()
const sessions = new Map()

class RemoteSupportApiError extends Error {
  constructor(status, publicMessage) {
    super(publicMessage)
    this.status = status
    this.publicMessage = publicMessage
  }
}

const fail = (status, publicMessage) => {
  throw new RemoteSupportApiError(status, publicMessage)
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

const normalizeToken = (value) => String(value || '').replace(/[^0-9a-fA-F]/gu, '').toLowerCase()

const tokenKey = (token) => createHash('sha256').update(normalizeToken(token)).digest('hex')

const tokensEqual = (expected, provided) => {
  const left = Buffer.from(normalizeToken(expected), 'utf8')
  const right = Buffer.from(normalizeToken(provided), 'utf8')
  if (left.length !== right.length || left.length === 0) return false
  return timingSafeEqual(left, right)
}

export const extractRemoteSupportToken = (request, body) => {
  const header = request.headers.authorization
  if (typeof header === 'string' && header.startsWith('Bearer ')) return normalizeToken(header.slice(7))
  if (typeof body?.token === 'string') return normalizeToken(body.token)
  return ''
}

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-FaNotes-Remote-Support',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
}

const writeJson = (response, status, value) => {
  const body = JSON.stringify(value)
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...corsHeaders,
  })
  response.end(body)
}

const readJsonBody = async (request) => {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) fail(413, 'Die Anfrage ist zu groß.')
    chunks.push(chunk)
  }
  if (!chunks.length) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    fail(400, 'Ungültiges JSON.')
  }
}

const sweepSessions = (now = Date.now()) => {
  for (const [key, session] of sessions) {
    if (session.expiresAt <= now) sessions.delete(key)
  }
}

export const resetRemoteSupportRelayForTests = () => {
  sessions.clear()
  rateWindows.clear()
}

const requireSession = (token) => {
  sweepSessions()
  const session = sessions.get(tokenKey(token))
  if (!session || !tokensEqual(session.token, token)) fail(401, 'Anmeldung fehlgeschlagen.')
  if (session.expiresAt <= Date.now()) {
    sessions.delete(tokenKey(token))
    fail(401, 'Anmeldung fehlgeschlagen.')
  }
  return session
}

const registerSession = (token) => {
  if (!TOKEN_PATTERN.test(token)) fail(400, 'Der Sitzungscode ist ungültig.')
  const now = Date.now()
  const key = tokenKey(token)
  const existing = sessions.get(key)
  const next = {
    token,
    createdAt: existing?.createdAt || now,
    expiresAt: now + SESSION_TTL_MS,
    pending: existing?.pending || [],
    results: existing?.results || new Map(),
    nextId: existing?.nextId || 1,
  }
  sessions.set(key, next)
  return next
}

export const enqueueRemoteSupportCommand = (session, command) => {
  if (!command || typeof command !== 'object' || typeof command.kind !== 'string') fail(400, 'Ungültiger Befehl.')
  const id = `rs${session.nextId}`
  session.nextId += 1
  session.pending.push({ id, command, queuedAt: Date.now() })
  if (session.pending.length > MAX_PENDING) session.pending.shift()
  return id
}

export const takeRemoteSupportPending = (session) => {
  const pending = session.pending
  session.pending = []
  return pending
}

export const storeRemoteSupportResult = (session, id, result) => {
  if (typeof id !== 'string' || !id) fail(400, 'Die Ergebnis-ID fehlt.')
  session.results.set(id, { result, at: Date.now() })
  for (const [key, entry] of session.results) {
    if (Date.now() - entry.at > RESULT_TTL_MS) session.results.delete(key)
  }
}

export const readRemoteSupportResult = (session, id) => {
  const entry = session.results.get(id)
  if (!entry) return { ready: false }
  return { ready: true, result: entry.result }
}

export const handleRemoteSupportRequest = async (request, response, url) => {
  if (!url.pathname.startsWith('/api/v1/remote-support')) return false
  if (request.method === 'OPTIONS') {
    response.writeHead(204, { ...corsHeaders, 'Access-Control-Max-Age': '600' })
    response.end()
    return true
  }

  try {
    if (url.pathname === '/api/v1/remote-support/session' && request.method === 'PUT') {
      rateLimit(`rs-reg:${clientAddress(request)}`, 20, 60_000)
      const body = await readJsonBody(request)
      const token = extractRemoteSupportToken(request, body)
      registerSession(token)
      writeJson(response, 200, { ok: true })
      return true
    }

    if (url.pathname === '/api/v1/remote-support/session' && request.method === 'DELETE') {
      const token = extractRemoteSupportToken(request, {})
      sessions.delete(tokenKey(token))
      writeJson(response, 200, { ok: true })
      return true
    }

    if (url.pathname === '/api/v1/remote-support/poll' && request.method === 'GET') {
      rateLimit(`rs-poll:${clientAddress(request)}`, 90, 60_000)
      const token = extractRemoteSupportToken(request, {})
      const session = requireSession(token)
      writeJson(response, 200, { commands: takeRemoteSupportPending(session) })
      return true
    }

    if (url.pathname === '/api/v1/remote-support/command' && request.method === 'POST') {
      rateLimit(`rs-cmd:${clientAddress(request)}`, 40, 60_000)
      const body = await readJsonBody(request)
      const token = extractRemoteSupportToken(request, body)
      const session = requireSession(token)
      const id = enqueueRemoteSupportCommand(session, body.command)
      writeJson(response, 202, { id })
      return true
    }

    if (url.pathname === '/api/v1/remote-support/result' && request.method === 'POST') {
      const body = await readJsonBody(request)
      const token = extractRemoteSupportToken(request, body)
      const session = requireSession(token)
      storeRemoteSupportResult(session, body.id, body.result)
      writeJson(response, 200, { ok: true })
      return true
    }

    const resultMatch = /^\/api\/v1\/remote-support\/result\/([^/]+)$/u.exec(url.pathname)
    if (resultMatch && request.method === 'GET') {
      const token = extractRemoteSupportToken(request, {})
      const session = requireSession(token)
      writeJson(response, 200, readRemoteSupportResult(session, resultMatch[1]))
      return true
    }

    writeJson(response, 404, { error: 'Remote-Support-Endpunkt nicht gefunden.' })
    return true
  } catch (error) {
    const status = error instanceof RemoteSupportApiError ? error.status : 500
    writeJson(response, status, { error: error.publicMessage || 'Remote Support ist nicht verfügbar.' })
    return true
  }
}

void PUBLIC_ORIGIN
