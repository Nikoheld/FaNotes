import { randomBytes } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { resolve, sep } from 'node:path'

const SEND_DATA_ROOT = resolve(process.env.FANOTES_SEND_DATA_DIR || '/var/lib/fanotes-send-data')
export const SEND_DATA_MAX_BODY_BYTES = 48 * 1024
export const SEND_DATA_MAX_LOGS = 900
const rateWindows = new Map()

const clipText = (value, max) => (typeof value === 'string' ? value.slice(0, max) : '')

const sanitizeLog = (raw) => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const at = Number(raw.at)
  if (!Number.isFinite(at)) return null
  const kind = ['pen', 'note', 'tool', 'error', 'app'].includes(raw.kind) ? raw.kind : 'app'
  return {
    at,
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

const sanitizeNutzerdaten = (raw) => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const version = clipText(raw.version, 40)
  const platform = clipText(raw.platform, 40)
  if (!version && !platform) return null
  return {
    version,
    platform,
    theme: clipText(raw.theme, 40),
    uiLanguage: clipText(raw.uiLanguage, 16),
    paperStyle: clipText(raw.paperStyle, 24),
    penOnly: raw.penOnly === true,
    experimentalHandwritingToText: raw.experimentalHandwritingToText === true,
    experimentalNoteBackup: raw.experimentalNoteBackup === true,
    experimentalRemoteSupport: raw.experimentalRemoteSupport === true,
    hasOpenNote: raw.hasOpenNote === true,
  }
}

const sanitizeLinux = (raw) => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const platform = clipText(raw.platform, 40) || 'linux'
  const ozone = clipText(raw.ozone, 24)
  const desktop = clipText(raw.desktop, 80)
  const hyprland = raw.hyprland === true
  if (!ozone && !desktop && !hyprland && platform === 'linux') {
    // Generic linux-only label is not enough to diagnose Hyprland; still persist
    // the structured fields so later ticks with real compositor facts are stored.
  }
  return {
    platform,
    ozone,
    sessionType: clipText(raw.sessionType, 24),
    desktop,
    hyprland,
    hyprlandInstance: raw.hyprlandInstance === true,
    display: clipText(raw.display, 40),
    waylandDisplay: clipText(raw.waylandDisplay, 40),
    hyprlandZeroScaling: raw.hyprlandZeroScaling === true,
  }
}

export const acceptSendDataPayload = (body) => {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, status: 400, error: 'Ungültiges Send-Data-Paket.' }
  }
  if (body.kind !== 'send-data') {
    return { ok: false, status: 400, error: 'Das Paket ist kein Send-Data-Lauf.' }
  }
  const nutzerdaten = sanitizeNutzerdaten(body.nutzerdaten)
  if (!nutzerdaten) {
    return { ok: false, status: 400, error: 'Dem Paket fehlen die Nutzerdaten.' }
  }
  const linux = sanitizeLinux(body.linux)
  if (!linux) {
    return { ok: false, status: 400, error: 'Dem Paket fehlt der Linux/Hyprland-Kontext.' }
  }
  const logs = (Array.isArray(body.logs) ? body.logs : []).map(sanitizeLog).filter(Boolean).slice(0, SEND_DATA_MAX_LOGS)
  return {
    ok: true,
    status: 202,
    report: {
      schemaVersion: 1,
      kind: 'send-data',
      sentAt: Number.isFinite(body.sentAt) ? body.sentAt : Date.now(),
      logs,
      nutzerdaten,
      linux,
    },
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
    if (size > SEND_DATA_MAX_BODY_BYTES) {
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

export const sendDataCorsHeaders = {
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
    ...sendDataCorsHeaders,
  })
  response.end(body)
}

export const persistSendDataReport = async (report, root = SEND_DATA_ROOT) => {
  const base = resolve(root)
  await fs.mkdir(base, { recursive: true, mode: 0o700 })
  const id = `${Date.now()}-${randomBytes(6).toString('hex')}`
  const target = resolve(base, `${id}.json`)
  if (target !== base && !target.startsWith(`${base}${sep}`)) {
    throw new Error('Ungültiger Speicherpfad.')
  }
  const temporary = `${target}.${randomBytes(6).toString('hex')}.tmp`
  await fs.writeFile(temporary, JSON.stringify(report), { encoding: 'utf8', mode: 0o600, flag: 'wx' })
  await fs.rename(temporary, target)
  return id
}

export const handleSendDataRequest = async (request, response, url) => {
  if (url.pathname !== '/api/v1/send-data') return false
  if (request.method === 'OPTIONS') {
    response.writeHead(204, { ...sendDataCorsHeaders, 'Access-Control-Max-Age': '600' })
    response.end()
    return true
  }
  if (request.method !== 'POST') {
    writeJson(response, 405, { error: 'Nur POST ist für Send Data erlaubt.' })
    return true
  }
  try {
    if (!rateLimit(clientAddress(request), 24, 10 * 60 * 1000)) {
      writeJson(response, 429, { error: 'Zu viele Send-Data-Pakete. Bitte später erneut versuchen.' })
      return true
    }
    const body = await readJsonBody(request)
    const accepted = acceptSendDataPayload(body)
    if (!accepted.ok) {
      writeJson(response, accepted.status, { error: accepted.error })
      return true
    }
    const id = await persistSendDataReport(accepted.report)
    writeJson(response, 202, { ok: true, id })
  } catch (error) {
    writeJson(response, Number(error?.status) || 400, { error: error?.message || 'Ungültiges Send-Data-Paket.' })
  }
  return true
}
