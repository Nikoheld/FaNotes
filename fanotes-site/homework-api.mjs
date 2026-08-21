import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { resolve, sep } from 'node:path'

const HOMEWORK_ROOT = resolve(process.env.FANOTES_HOMEWORK_DIR || '/var/lib/fanotes-homework')
const PUBLIC_ORIGIN = process.env.FANOTES_PUBLIC_ORIGIN || 'https://fanotes.fasrv.ch'
const CHANNEL_PATTERN = /^[a-f0-9]{32}$/u
const MIN_SECRET_LENGTH = 12
const MAX_TASKS = 2_000
const MAX_BODY_BYTES = 512 * 1024
const TASK_FIELDS = Object.freeze([
  'id', 'title', 'notes', 'subject', 'dueDate', 'dueTime', 'done', 'kind', 'priority', 'createdAt', 'updatedAt',
])

const rateWindows = new Map()

class HomeworkApiError extends Error {
  constructor(status, publicMessage) {
    super(publicMessage)
    this.status = status
    this.publicMessage = publicMessage
  }
}

const fail = (status, publicMessage) => {
  throw new HomeworkApiError(status, publicMessage)
}

const denyBody = (error) => ({ error })

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

const scryptHash = (secret, salt) => new Promise((resolveHash, rejectHash) => {
  scrypt(secret, salt, 32, { N: 16_384, r: 8, p: 1, maxmem: 32 * 1024 * 1024 }, (error, key) => {
    if (error) rejectHash(error)
    else resolveHash(key)
  })
})

export const createHomeworkSecretRecord = async (secret) => {
  const trimmed = String(secret || '').trim()
  if (trimmed.length < MIN_SECRET_LENGTH) fail(400, 'Das API-Passwort ist zu kurz.')
  const salt = randomBytes(16)
  const hash = await scryptHash(trimmed, salt)
  return { salt: salt.toString('base64'), hash: hash.toString('base64') }
}

export const verifyHomeworkSecret = async (secret, record) => {
  if (!record?.salt || !record?.hash) return false
  const trimmed = String(secret || '').trim()
  if (trimmed.length < MIN_SECRET_LENGTH) return false
  try {
    const expected = Buffer.from(record.hash, 'base64')
    const actual = await scryptHash(trimmed, Buffer.from(record.salt, 'base64'))
    if (expected.length !== actual.length) return false
    return timingSafeEqual(expected, actual)
  } catch {
    return false
  }
}

const isIsoDate = (value) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/u.test(value)
const isIsoTime = (value) => typeof value === 'string' && /^\d{2}:\d{2}$/u.test(value)

export const sanitizeHomeworkApiTask = (raw) => {
  if (!raw || typeof raw !== 'object') return null
  const title = typeof raw.title === 'string' ? raw.title.trim() : ''
  if (!title || title.length > 240) return null
  const now = new Date().toISOString()
  return {
    id: typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim().slice(0, 80) : createHash('sha256').update(`${title}:${now}`).digest('hex').slice(0, 32),
    title: title.slice(0, 240),
    notes: typeof raw.notes === 'string' ? raw.notes.slice(0, 4_000) : '',
    subject: typeof raw.subject === 'string' ? raw.subject.trim().slice(0, 80) : '',
    dueDate: isIsoDate(raw.dueDate) ? raw.dueDate : null,
    dueTime: isIsoTime(raw.dueTime) ? raw.dueTime : null,
    done: Boolean(raw.done),
    kind: raw.kind === 'appointment' ? 'appointment' : 'homework',
    priority: raw.priority === 'high' ? 'high' : 'normal',
    createdAt: typeof raw.createdAt === 'string' && Number.isFinite(Date.parse(raw.createdAt)) ? raw.createdAt : now,
    updatedAt: typeof raw.updatedAt === 'string' && Number.isFinite(Date.parse(raw.updatedAt)) ? raw.updatedAt : now,
  }
}

export const homeworkTasksToApiPayload = (tasks) => ({
  schemaVersion: 1,
  tasks: (Array.isArray(tasks) ? tasks : []).map(sanitizeHomeworkApiTask).filter(Boolean).slice(0, MAX_TASKS),
})

const TASK_ID_PATTERN = /^[A-Za-z0-9._:-]{1,80}$/u

export const applyHomeworkTaskCreate = (tasks, raw) => {
  const title = typeof raw?.title === 'string' ? raw.title.trim() : ''
  if (!title) return { status: 400, error: 'Titel fehlt.', tasks }
  if ((Array.isArray(tasks) ? tasks : []).length >= MAX_TASKS) {
    return { status: 400, error: 'Die Liste ist voll.', tasks }
  }
  const task = sanitizeHomeworkApiTask({
    ...raw,
    id: typeof raw?.id === 'string' && TASK_ID_PATTERN.test(raw.id.trim()) ? raw.id.trim() : randomBytes(16).toString('hex'),
    title,
  })
  if (!task) return { status: 400, error: 'Ungültiger Eintrag.', tasks }
  const current = Array.isArray(tasks) ? tasks : []
  if (current.some((entry) => entry.id === task.id)) {
    return { status: 409, error: 'Dieser Eintrag existiert bereits.', tasks: current }
  }
  return { status: 201, task, tasks: [task, ...current].slice(0, MAX_TASKS) }
}

export const applyHomeworkTaskPatch = (tasks, taskId, raw) => {
  const current = Array.isArray(tasks) ? tasks : []
  const index = current.findIndex((task) => task.id === taskId)
  if (index < 0) return { status: 404, error: 'Eintrag nicht gefunden.', tasks: current }
  const patch = raw && typeof raw === 'object' ? raw : {}
  const next = sanitizeHomeworkApiTask({
    ...current[index],
    ...patch,
    id: current[index].id,
    createdAt: current[index].createdAt,
    updatedAt: new Date().toISOString(),
  })
  if (!next) return { status: 400, error: 'Ungültige Änderung.', tasks: current }
  const tasksNext = current.slice()
  tasksNext[index] = next
  return { status: 200, task: next, tasks: tasksNext }
}

export const applyHomeworkTaskDelete = (tasks, taskId) => {
  const current = Array.isArray(tasks) ? tasks : []
  if (!current.some((task) => task.id === taskId)) {
    return { status: 404, error: 'Eintrag nicht gefunden.', tasks: current }
  }
  return { status: 204, tasks: current.filter((task) => task.id !== taskId) }
}

export const resolveHomeworkApiQuery = ({ enabled, secretOk, payload }) => {
  if (!enabled || !payload) {
    return { status: 404, body: denyBody('Hausaufgaben-API ist nicht verfügbar.') }
  }
  if (!secretOk) {
    return { status: 401, body: denyBody('Anmeldung fehlgeschlagen.') }
  }
  return { status: 200, body: payload }
}

const safeJoin = (root, ...segments) => {
  const target = resolve(root, ...segments)
  if (target !== root && !target.startsWith(`${root}${sep}`)) fail(400, 'Ungültiger Pfad.')
  return target
}

const recordPath = (channelId) => safeJoin(HOMEWORK_ROOT, `${channelId}.json`)

const readRecord = async (channelId) => {
  try {
    const raw = JSON.parse(await fs.readFile(recordPath(channelId), 'utf8'))
    if (!raw || typeof raw !== 'object') return null
    return raw
  } catch {
    return null
  }
}

const writeRecord = async (channelId, value) => {
  await fs.mkdir(HOMEWORK_ROOT, { recursive: true, mode: 0o700 })
  const target = recordPath(channelId)
  const temporary = `${target}.${randomBytes(8).toString('hex')}.tmp`
  await fs.writeFile(temporary, JSON.stringify(value), { encoding: 'utf8', mode: 0o600, flag: 'wx' })
  await fs.rename(temporary, target)
}

const deleteRecord = async (channelId) => {
  try { await fs.unlink(recordPath(channelId)) } catch { /* already gone */ }
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

const extractSecret = (request) => {
  const header = request.headers.authorization
  if (typeof header === 'string' && header.startsWith('Bearer ')) return header.slice(7).trim()
  const custom = request.headers['x-fanotes-homework-secret']
  return typeof custom === 'string' ? custom.trim() : ''
}

const assertPublishOrigin = (request) => {
  const origin = request.headers.origin
  if (!origin || origin === 'null') return
  if (origin !== PUBLIC_ORIGIN) fail(403, 'Diese Anfrage stammt nicht von FaNotes.')
}

const collectPublishSecrets = (request, body) => {
  const secrets = []
  if (typeof body?.secret === 'string' && body.secret) secrets.push(body.secret)
  if (typeof body?.previousSecret === 'string' && body.previousSecret) secrets.push(body.previousSecret)
  const headerSecret = extractSecret(request)
  if (headerSecret) secrets.push(headerSecret)
  return secrets
}

const matchesHomeworkRecord = async (record, secrets) => {
  for (const secret of secrets) {
    if (await verifyHomeworkSecret(secret, record)) return true
  }
  return false
}

const writeJson = (response, status, value) => {
  const body = JSON.stringify(value)
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Authorization, X-FaNotes-Homework-Secret',
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, PUT, DELETE, OPTIONS',
  })
  response.end(body)
}

export const handleHomeworkRequest = async (request, response, url) => {
  if (url.pathname === '/api/v1/homework' && request.method === 'OPTIONS') {
    response.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Authorization, X-FaNotes-Homework-Secret',
      'Access-Control-Allow-Methods': 'GET, POST, PATCH, PUT, DELETE, OPTIONS',
      'Access-Control-Max-Age': '600',
    })
    response.end()
    return true
  }
  const listMatch = /^\/api\/v1\/homework\/([a-f0-9]{32})$/u.exec(url.pathname)
  const tasksMatch = /^\/api\/v1\/homework\/([a-f0-9]{32})\/tasks$/u.exec(url.pathname)
  const taskMatch = /^\/api\/v1\/homework\/([a-f0-9]{32})\/tasks\/([A-Za-z0-9._:-]{1,80})$/u.exec(url.pathname)
  if (!listMatch && !tasksMatch && !taskMatch) return false
  const channelId = (listMatch || tasksMatch || taskMatch)[1]
  const taskId = taskMatch?.[2]
  if (!CHANNEL_PATTERN.test(channelId)) return false

  try {
    if (request.method === 'OPTIONS') {
      response.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Authorization, X-FaNotes-Homework-Secret, Content-Type, X-FaNotes-Homework',
        'Access-Control-Allow-Methods': 'GET, POST, PATCH, PUT, DELETE, OPTIONS',
        'Access-Control-Max-Age': '600',
      })
      response.end()
      return true
    }

    const requireEnabledAuth = async () => {
      const record = await readRecord(channelId)
      if (!record?.enabled) fail(404, 'Hausaufgaben-API ist nicht verfügbar.')
      if (!(await verifyHomeworkSecret(extractSecret(request), record))) fail(401, 'Anmeldung fehlgeschlagen.')
      return record
    }

    const persistTasks = async (record, tasks) => {
      const payload = homeworkTasksToApiPayload(tasks)
      await writeRecord(channelId, {
        ...record,
        enabled: true,
        tasks: payload.tasks,
        updatedAt: new Date().toISOString(),
      })
      return payload
    }

    if (tasksMatch && request.method === 'POST') {
      rateLimit(`hw-post:${clientAddress(request)}`, 40, 60_000)
      const record = await requireEnabledAuth()
      const created = applyHomeworkTaskCreate(record.tasks, await readJsonBody(request))
      if (created.status >= 400) {
        writeJson(response, created.status, denyBody(created.error))
        return true
      }
      await persistTasks(record, created.tasks)
      writeJson(response, 201, { ok: true, task: created.task })
      return true
    }

    if (taskMatch && (request.method === 'GET' || request.method === 'HEAD')) {
      rateLimit(`hw-get:${clientAddress(request)}`, 40, 60_000)
      const record = await requireEnabledAuth()
      const task = (record.tasks || []).find((entry) => entry.id === taskId)
      if (!task) fail(404, 'Eintrag nicht gefunden.')
      if (request.method === 'HEAD') {
        response.writeHead(200, { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' })
        response.end()
        return true
      }
      writeJson(response, 200, { task: sanitizeHomeworkApiTask(task) })
      return true
    }

    if (taskMatch && request.method === 'PATCH') {
      rateLimit(`hw-patch:${clientAddress(request)}`, 40, 60_000)
      const record = await requireEnabledAuth()
      const patched = applyHomeworkTaskPatch(record.tasks, taskId, await readJsonBody(request))
      if (patched.status >= 400) {
        writeJson(response, patched.status, denyBody(patched.error))
        return true
      }
      await persistTasks(record, patched.tasks)
      writeJson(response, 200, { ok: true, task: patched.task })
      return true
    }

    if (taskMatch && request.method === 'DELETE') {
      rateLimit(`hw-del:${clientAddress(request)}`, 40, 60_000)
      const record = await requireEnabledAuth()
      const removed = applyHomeworkTaskDelete(record.tasks, taskId)
      if (removed.status >= 400) {
        writeJson(response, removed.status, denyBody(removed.error))
        return true
      }
      await persistTasks(record, removed.tasks)
      response.writeHead(204, { 'Cache-Control': 'no-store' })
      response.end()
      return true
    }

    if (!listMatch) {
      writeJson(response, 405, denyBody('Diese Methode ist nicht erlaubt.'))
      return true
    }

    if (request.method === 'GET' || request.method === 'HEAD') {
      rateLimit(`hw-get:${clientAddress(request)}`, 40, 60_000)
      const record = await readRecord(channelId)
      const secretOk = record ? await verifyHomeworkSecret(extractSecret(request), record) : false
      const result = resolveHomeworkApiQuery({
        enabled: Boolean(record?.enabled),
        secretOk,
        payload: record?.enabled ? homeworkTasksToApiPayload(record.tasks) : null,
      })
      if (request.method === 'HEAD') {
        response.writeHead(result.status, { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' })
        response.end()
        return true
      }
      writeJson(response, result.status, result.body)
      return true
    }

    if (request.method === 'PUT') {
      rateLimit(`hw-put:${clientAddress(request)}`, 20, 60_000)
      assertPublishOrigin(request)
      const body = await readJsonBody(request)
      const enabled = body.enabled === true
      const secret = typeof body.secret === 'string' ? body.secret : ''
      const existing = await readRecord(channelId)
      const secrets = collectPublishSecrets(request, body)
      if (existing && !(await matchesHomeworkRecord(existing, secrets))) {
        fail(401, 'Anmeldung fehlgeschlagen.')
      }
      if (!enabled) {
        await deleteRecord(channelId)
        writeJson(response, 200, { ok: true, enabled: false })
        return true
      }
      if (secret.length < MIN_SECRET_LENGTH) fail(400, 'Das API-Passwort ist zu kurz.')
      const credential = await createHomeworkSecretRecord(secret)
      const payload = homeworkTasksToApiPayload(body.tasks)
      await writeRecord(channelId, {
        enabled: true,
        salt: credential.salt,
        hash: credential.hash,
        tasks: payload.tasks,
        updatedAt: new Date().toISOString(),
      })
      writeJson(response, 200, { ok: true, enabled: true, taskCount: payload.tasks.length })
      return true
    }

    if (request.method === 'DELETE') {
      assertPublishOrigin(request)
      const existing = await readRecord(channelId)
      if (existing && !(await matchesHomeworkRecord(existing, collectPublishSecrets(request, {})))) {
        fail(401, 'Anmeldung fehlgeschlagen.')
      }
      await deleteRecord(channelId)
      response.writeHead(204, { 'Cache-Control': 'no-store' })
      response.end()
      return true
    }

    writeJson(response, 405, denyBody('Diese Methode ist nicht erlaubt.'))
    return true
  } catch (error) {
    if (error instanceof HomeworkApiError) {
      writeJson(response, error.status, denyBody(error.publicMessage))
      return true
    }
    throw error
  }
}

