import { randomBytes } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { resolve, sep } from 'node:path'

const BUG_REPORT_ROOT = resolve(process.env.FANOTES_BUG_REPORT_DIR || '/var/lib/fanotes-bug-reports')
export const BUG_REPORT_MAX_DESCRIPTION = 2_000
export const BUG_REPORT_MAX_EVENTS = 900
export const BUG_REPORT_MAX_BODY_BYTES = 256 * 1024
const MAX_DESCRIPTION = BUG_REPORT_MAX_DESCRIPTION
const MAX_EVENTS = BUG_REPORT_MAX_EVENTS
const MAX_BODY_BYTES = BUG_REPORT_MAX_BODY_BYTES
const rateWindows = new Map()

export const acceptBugReportPayload = (body) => {
  const description = typeof body?.description === 'string' ? body.description.trim() : ''
  if (!description) {
    return { ok: false, status: 400, error: 'Bitte beschreibe den Fehler kurz.' }
  }
  if (description.length > MAX_DESCRIPTION) {
    return { ok: false, status: 400, error: 'Die Fehlerbeschreibung ist zu lang.' }
  }
  const rawEvents = Array.isArray(body?.events) ? body.events : []
  const events = rawEvents.map(sanitizeEvent).filter(Boolean).slice(0, MAX_EVENTS)
  if (!events.length) {
    return { ok: false, status: 400, error: 'Dem Bericht fehlen die Diagnoseprotokolle.' }
  }
  return {
    ok: true,
    status: 202,
    report: {
      schemaVersion: 1,
      description: description.slice(0, MAX_DESCRIPTION),
      events,
      version: typeof body?.version === 'string' ? body.version.slice(0, 40) : '',
      platform: typeof body?.platform === 'string' ? body.platform.slice(0, 40) : '',
      sentAt: Number.isFinite(body?.sentAt) ? body.sentAt : Date.now(),
    },
  }
}

const sanitizeEvent = (raw) => {
  if (!raw || typeof raw !== 'object' || !Number.isFinite(raw.at)) return null
  const kind = ['pen', 'note', 'tool', 'error', 'app'].includes(raw.kind) ? raw.kind : 'app'
  return {
    at: raw.at,
    kind,
    noteId: typeof raw.noteId === 'string' ? raw.noteId.slice(0, 240) : undefined,
    x: typeof raw.x === 'number' && Number.isFinite(raw.x) ? raw.x : undefined,
    y: typeof raw.y === 'number' && Number.isFinite(raw.y) ? raw.y : undefined,
    pointerType: typeof raw.pointerType === 'string' ? raw.pointerType.slice(0, 24) : undefined,
    tool: typeof raw.tool === 'string' ? raw.tool.slice(0, 40) : undefined,
    version: typeof raw.version === 'string' ? raw.version.slice(0, 40) : undefined,
    platform: typeof raw.platform === 'string' ? raw.platform.slice(0, 40) : undefined,
    message: typeof raw.message === 'string' ? raw.message.slice(0, 400) : undefined,
  }
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
    return true
  }
  if (current.count >= maximum) return false
  current.count += 1
  return true
}

const readJsonBody = async (request) => {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) {
      const error = new Error('Die Anfrage ist zu groß.')
      error.status = 413
      throw error
    }
    chunks.push(chunk)
  }
  if (!chunks.length) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    const error = new Error('Ungültiges JSON.')
    error.status = 400
    throw error
  }
}

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
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

const persistReport = async (report) => {
  await fs.mkdir(BUG_REPORT_ROOT, { recursive: true, mode: 0o700 })
  const id = `${Date.now()}-${randomBytes(6).toString('hex')}`
  const target = resolve(BUG_REPORT_ROOT, `${id}.json`)
  if (target !== BUG_REPORT_ROOT && !target.startsWith(`${BUG_REPORT_ROOT}${sep}`)) {
    throw new Error('Ungültiger Speicherpfad.')
  }
  const temporary = `${target}.${randomBytes(6).toString('hex')}.tmp`
  await fs.writeFile(temporary, JSON.stringify(report), { encoding: 'utf8', mode: 0o600, flag: 'wx' })
  await fs.rename(temporary, target)
  return id
}

export const handleBugReportRequest = async (request, response, url) => {
  if (url.pathname !== '/api/v1/bug-report') return false
  if (request.method === 'OPTIONS') {
    response.writeHead(204, { ...corsHeaders, 'Access-Control-Max-Age': '600' })
    response.end()
    return true
  }
  if (request.method !== 'POST') {
    writeJson(response, 405, { error: 'Nur POST ist für Fehlerberichte erlaubt.' })
    return true
  }
  try {
    if (!rateLimit(clientAddress(request), 8, 10 * 60 * 1000)) {
      writeJson(response, 429, { error: 'Zu viele Fehlerberichte. Bitte später erneut versuchen.' })
      return true
    }
    const body = await readJsonBody(request)
    const accepted = acceptBugReportPayload(body)
    if (!accepted.ok) {
      writeJson(response, accepted.status, { error: accepted.error })
      return true
    }
    const id = await persistReport(accepted.report)
    writeJson(response, 202, { ok: true, id })
  } catch (error) {
    writeJson(response, Number(error?.status) || 400, { error: error?.message || 'Ungültiger Fehlerbericht.' })
  }
  return true
}
