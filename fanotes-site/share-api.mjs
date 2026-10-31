import { randomBytes } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { resolve, sep } from 'node:path'

// Public note links. This store is not vault sync (/api/v1/sync).
// The link id is the capability: the desktop client uploads the readable
// title, the markdown, and a public drawing of the handwriting. The browser
// viewer reads the same record. Undo history is not accepted.

const SHARE_ROOT = resolve(process.env.FANOTES_SHARE_DIR || '/var/lib/fanotes-shares')
const ID_PATTERN = /^[a-f0-9]{32}$/u
const MAX_BODY_BYTES = 8 * 1024 * 1024
const MAX_NOTES = 400
const MAX_NOTE_CHARS = 500_000
const MAX_PATH_CHARS = 512
const MAX_TITLE_CHARS = 300

const rateWindows = new Map()
const shareTails = new Map()

/** One writer at a time per link, so a stop cannot be overwritten by an older upload. */
const withShareLock = (id, task) => {
  const previous = shareTails.get(id) ?? Promise.resolve()
  const run = previous.then(task, task)
  const settled = run.then(() => undefined, () => undefined)
  shareTails.set(id, settled)
  settled.then(() => {
    if (shareTails.get(id) === settled) shareTails.delete(id)
  })
  return run
}

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

const finiteNumber = (value) => {
  const number = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(number) ? number : null
}

const SHARE_INK_STROKES = 2500
const SHARE_INK_POINTS = 40_000

const sanitizeShareInk = (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Array.isArray(value.strokes)) return undefined
  const widthNumber = finiteNumber(value.width)
  const heightNumber = finiteNumber(value.height)
  const width = widthNumber !== null && widthNumber >= 200 && widthNumber <= 24000 ? Math.round(widthNumber) : 900
  const height = heightNumber !== null && heightNumber >= 200 && heightNumber <= 80000 ? Math.round(heightNumber) : 1273
  const strokes = []
  let pointsUsed = 0
  for (const entry of value.strokes) {
    if (strokes.length >= SHARE_INK_STROKES || pointsUsed >= SHARE_INK_POINTS) break
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) || !Array.isArray(entry.points)) continue
    const points = []
    for (const point of entry.points) {
      if (pointsUsed + points.length >= SHARE_INK_POINTS) break
      if (!point || typeof point !== 'object') continue
      const x = finiteNumber(point.x)
      const y = finiteNumber(point.y)
      if (x === null || y === null) continue
      points.push({
        x: Math.round(Math.max(-0.25, Math.min(1.25, x)) * 10000) / 10000,
        y: Math.round(Math.max(-0.25, Math.min(1.25, y)) * 10000) / 10000,
      })
      if (points.length >= 500) break
    }
    if (!points.length) continue
    const widthValue = finiteNumber(entry.width)
    const opacityValue = finiteNumber(entry.opacity)
    strokes.push({
      color: typeof entry.color === 'string' && /^#[0-9a-fA-F]{6}$/u.test(entry.color) ? entry.color : '#20222b',
      width: widthValue !== null ? Math.max(0.5, Math.min(48, widthValue)) : 3.5,
      opacity: opacityValue !== null ? Math.max(0.08, Math.min(1, opacityValue)) : 1,
      points,
    })
    pointsUsed += points.length
  }
  const sections = sanitizeShareSections(value.sections)
  if (!strokes.length && !sections.length) return undefined
  return { width, height, strokes, ...(sections.length ? { sections } : {}) }
}

const clampUnit = (value, fallback) => {
  const number = finiteNumber(value)
  if (number === null) return fallback
  return Math.round(Math.max(0, Math.min(1, number)) * 10000) / 10000
}

const sanitizeShareSections = (value) => {
  if (!Array.isArray(value)) return []
  const sections = []
  for (const entry of value) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue
    const top = finiteNumber(entry.top)
    const bodyTop = finiteNumber(entry.bodyTop)
    if (top === null || bodyTop === null || !(bodyTop > top) || top < -0.25 || bodyTop > 1.5) continue
    const id = typeof entry.id === 'string' && entry.id.length > 0 && entry.id.length <= 64 ? entry.id : `section-${sections.length + 1}`
    const parentId = typeof entry.parentId === 'string' && entry.parentId.length > 0 && entry.parentId.length <= 64 && entry.parentId !== id
      ? entry.parentId
      : ''
    const title = typeof entry.title === 'string'
      ? entry.title.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 120)
      : ''
    const left = clampUnit(entry.left, 0)
    const right = clampUnit(entry.width, 1)
    if (!(right > left)) continue
    sections.push({
      id,
      ...(parentId ? { parentId } : {}),
      ...(title ? { title } : {}),
      top: Math.round(Math.max(-0.25, Math.min(1.25, top)) * 10000) / 10000,
      bodyTop: Math.round(Math.max(-0.25, Math.min(1.25, bodyTop)) * 10000) / 10000,
      ...(left ? { left } : {}),
      ...(right !== 1 ? { width: right } : {}),
    })
    if (sections.length >= 80) break
  }
  return sections
}

const sanitizeShareTextColumn = (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const origin = (number) => {
    const parsed = finiteNumber(number)
    if (parsed === null || parsed < 0) return 0
    return Math.min(20000, Math.round(parsed))
  }
  const fontSize = finiteNumber(value.fontSize)
  const lineHeight = finiteNumber(value.lineHeight)
  const column = finiteNumber(value.column)
  const padX = finiteNumber(value.padX)
  const padY = finiteNumber(value.padY)
  return {
    originX: origin(value.originX),
    originY: origin(value.originY),
    column: column !== null ? Math.min(900, Math.max(540, Math.round(column))) : 820,
    padX: padX !== null ? Math.min(240, Math.max(0, Math.round(padX))) : 72,
    padY: padY !== null ? Math.min(240, Math.max(0, Math.round(padY))) : 78,
    fontSize: fontSize !== null ? Math.min(26, Math.max(12, Math.round(fontSize))) : 16,
    lineHeight: lineHeight !== null ? Math.min(2.2, Math.max(1.3, Math.round(lineHeight * 100) / 100)) : 1.72,
  }
}

const sanitizeShareTextFields = (value) => {
  if (!Array.isArray(value)) return []
  const fields = []
  for (const entry of value) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue
    const text = typeof entry.text === 'string' ? entry.text.slice(0, 8000) : ''
    if (!text.trim()) continue
    const page = finiteNumber(entry.page)
    const x = finiteNumber(entry.x)
    const y = finiteNumber(entry.y)
    const width = finiteNumber(entry.width)
    const fontSize = finiteNumber(entry.fontSize)
    fields.push({
      page: page !== null && Number.isInteger(page) && page >= 1 && page <= 10000 ? page : 1,
      x: x !== null ? Math.max(0, Math.min(1, x)) : 0.5,
      y: y !== null ? Math.max(0, Math.min(1, y)) : 0.5,
      width: width !== null ? Math.max(0.12, Math.min(0.92, width)) : 0.32,
      fontSize: fontSize !== null && Number.isInteger(fontSize) && fontSize >= 10 && fontSize <= 48 ? fontSize : 16,
      text,
    })
    if (fields.length >= 200) break
  }
  return fields
}

export const sanitizeSharePayload = (raw, id) => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail(400, 'Ungültige Freigabe.')
  if (raw.schemaVersion !== 1) fail(400, 'Ungültige Freigabe.')
  if (raw.id !== id) fail(400, 'Die Freigabe-Kennung stimmt nicht.')
  if (raw.mode !== 'copy' && raw.mode !== 'live') fail(400, 'Ungültige Freigabeart.')
  if (!Array.isArray(raw.notes) || raw.notes.length > MAX_NOTES) fail(400, 'Ungültige Freigabe.')
  const notes = raw.notes.map((note) => {
    if (!note || typeof note !== 'object' || Array.isArray(note)) fail(400, 'Ungültige Notiz.')
    const ink = sanitizeShareInk(note.ink)
    const textFields = sanitizeShareTextFields(note.textFields)
    const textColumn = sanitizeShareTextColumn(note.textColumn)
    return {
      path: boundedString(note.path, MAX_PATH_CHARS, 'Ungültige Notiz.'),
      title: boundedString(typeof note.title === 'string' ? note.title : '', MAX_TITLE_CHARS, 'Ungültige Notiz.'),
      content: boundedString(note.content, MAX_NOTE_CHARS, 'Ungültige Notiz.'),
      ...(ink ? { ink } : {}),
      ...(textFields.length ? { textFields } : {}),
      ...(textColumn && (ink || textFields.length) ? { textColumn } : {}),
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
      const payload = sanitizeSharePayload(await readJsonBody(request), id)
      await withShareLock(id, async () => {
        const existing = await readRecord(id)
        if (existing?.stopped) fail(410, 'Diese Freigabe wurde beendet.')
        await writeRecord(id, payload)
      })
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
      await withShareLock(id, async () => {
        const record = await readRecord(id)
        if (record && !record.stopped) {
          await writeRecord(id, { ...record, stopped: true, notes: [] })
        }
      })
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
