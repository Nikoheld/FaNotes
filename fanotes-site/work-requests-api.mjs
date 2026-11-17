// Work requests ("Fehler & Wünsche"): the owner reports a bug or asks for a feature in the app,
// a worker on the build host picks it up, and the app follows the progress live.
// Owner endpoints use the sync session (Authorization: Bearer + X-FaNotes-Account) and the
// allow-list env FANOTES_REQUEST_OWNERS (comma separated account ids; empty = feature off).
// Worker endpoints use the bearer token env FANOTES_AGENT_TOKEN.
// FANOTES_REQUESTS_AUTO_APPROVE=1 approves a request as soon as the worker reports waiting_for_you.
//   GET  /api/v1/requests/capabilities
//   POST /api/v1/requests                      GET /api/v1/requests
//   GET  /api/v1/requests/:id                  GET /api/v1/requests/:id/events   (SSE)
//   GET  /api/v1/requests/:id/attachments/(screenshot|logs)
//   POST /api/v1/requests/:id/(approve|cancel|messages)
//   POST /api/v1/worker/claim                  GET  /api/v1/worker/requests/:id/messages
//   POST /api/v1/worker/requests/:id/(events|status|merged)
//   GET  /api/v1/worker/requests/:id/attachments/(screenshot|logs)
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { promises as fs } from 'node:fs'
import { join, resolve } from 'node:path'
import { scrubText } from './diagnostics-api.mjs'
import { authenticateSyncRequest } from './sync-api.mjs'

export const REQUESTS_MAX_BODY_BYTES = 3_600_000
export const REQUESTS_MAX_SCREENSHOT_BYTES = 2 * 1024 * 1024
export const REQUESTS_MAX_LOG_BYTES = 256 * 1024
export const REQUESTS_MAX_TITLE = 120
export const REQUESTS_MAX_DESCRIPTION = 4_000
export const REQUESTS_MAX_MESSAGE = 2_000
export const REQUESTS_MAX_PROGRESS_TEXT = 300
export const REQUESTS_MAX_TOTAL = 500
export const REQUESTS_MAX_OPEN_PER_ACCOUNT = 20
export const REQUESTS_MAX_EVENTS_PER_REQUEST = 5_000
export const REQUESTS_CREATE_PER_HOUR = 10
export const REQUESTS_MESSAGES_PER_HOUR = 60
export const REQUESTS_SSE_PER_ACCOUNT = 5
export const REQUESTS_SSE_TOTAL = 20
export const REQUESTS_HEARTBEAT_MS = 15_000

const ID = /^r[0-9a-f]{16}$/u
export const TERMINAL = new Set(['merged', 'rejected', 'failed'])
// The only legal status moves. `queued -> picked` happens through the claim only.
export const TRANSITIONS = {
  queued: ['picked', 'rejected'],
  picked: ['working', 'failed', 'rejected'],
  working: ['pr_open', 'failed', 'rejected'],
  pr_open: ['waiting_for_you', 'working', 'failed', 'rejected'],
  waiting_for_you: ['merged', 'working', 'failed', 'rejected'],
  merged: [],
  rejected: [],
  failed: [],
}
const WORKER_SETTABLE = new Set(['working', 'pr_open', 'waiting_for_you', 'merged', 'rejected', 'failed'])
const PRIORITIES = ['low', 'normal', 'high']
const TYPES = ['bug', 'feature']
const CI_STATES = ['pending', 'success', 'failure']

const fail = (status, message) => { throw Object.assign(new Error(message), { status }) }
const sha = (value) => createHash('sha256').update(value).digest()
const safeEqual = (a, b) => timingSafeEqual(sha(a), sha(b))
const str = (value, max) => (typeof value === 'string' ? value.trim().slice(0, max) : '')

const imageKind = (bytes) => {
  if (bytes.length > 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { ext: 'png', mime: 'image/png' }
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return { ext: 'jpg', mime: 'image/jpeg' }
  return null
}
const scrubLogs = (text) => text.split('\n').slice(-1_000).map((line) => scrubText(line, {}, 500)).filter(Boolean).join('\n')

const writeAtomic = async (path, data) => {
  const temporary = `${path}.${randomBytes(6).toString('hex')}.tmp`
  await fs.writeFile(temporary, data, { mode: 0o600 })
  await fs.rename(temporary, path)
}

export const createWorkRequestsStore = (directory, options = {}) => {
  const root = resolve(directory)
  const now = options.now ?? (() => Date.now())
  const autoApprove = Boolean(options.autoApprove)
  const bus = new EventEmitter()
  bus.setMaxListeners(0)
  const requestPath = (id) => join(root, 'requests', `${id}.json`)
  const eventsPath = (id) => join(root, 'events', `${id}.jsonl`)
  const attachmentPath = (id, name) => join(root, 'attachments', id, name)
  // One mutation at a time: claims, transitions and event numbering never interleave.
  let chain = Promise.resolve()
  const locked = (work) => {
    const run = chain.then(work, work)
    chain = run.catch(() => undefined)
    return run
  }
  const ensure = async () => {
    for (const sub of ['requests', 'events', 'attachments']) await fs.mkdir(join(root, sub), { recursive: true, mode: 0o700 })
  }
  const load = async (id) => {
    if (!ID.test(id)) return null
    try { return JSON.parse(await fs.readFile(requestPath(id), 'utf8')) } catch { return null }
  }
  const loadAll = async () => {
    let names = []
    try { names = (await fs.readdir(join(root, 'requests'))).filter((name) => /^r[0-9a-f]{16}\.json$/u.test(name)) } catch { /* empty */ }
    const all = []
    for (const name of names) {
      const record = await load(name.slice(0, -5))
      if (record) all.push(record)
    }
    return all.sort((a, b) => a.createdAt - b.createdAt)
  }
  const readEvents = async (id, after = 0) => {
    let source = ''
    try { source = await fs.readFile(eventsPath(id), 'utf8') } catch { return [] }
    const events = []
    for (const line of source.split('\n')) {
      if (!line) continue
      try { const event = JSON.parse(line); if (event.seq > after) events.push(event) } catch { /* torn line */ }
    }
    return events
  }
  // Must run inside `locked`. Appends one event, bumps the counters and saves the record.
  const record = async (request, event) => {
    if (request.lastSeq >= REQUESTS_MAX_EVENTS_PER_REQUEST) fail(429, 'Zu viele Ereignisse für diese Anfrage.')
    request.lastSeq += 1
    request.updatedAt = now()
    const full = { seq: request.lastSeq, at: request.updatedAt, ...event }
    await fs.appendFile(eventsPath(request.id), `${JSON.stringify(full)}\n`, { encoding: 'utf8', mode: 0o600 })
    await writeAtomic(requestPath(request.id), JSON.stringify(request))
    bus.emit(request.id, full)
    return full
  }
  const move = async (request, to, extra = {}) => {
    if (!TRANSITIONS[request.status]?.includes(to)) fail(409, 'Dieser Statuswechsel ist nicht erlaubt.')
    const from = request.status
    request.status = to
    return record(request, { type: 'status', from, status: to, ...extra })
  }
  return {
    root,
    bus,
    load,
    readEvents,
    attachmentPath,
    async list(accountId) {
      return (await loadAll()).filter((item) => item.accountId === accountId).reverse()
    },
    async create(accountId, input) {
      await ensure()
      return locked(async () => {
        const all = await loadAll()
        if (all.length >= REQUESTS_MAX_TOTAL) fail(507, 'Speicher voll.')
        if (all.filter((item) => item.accountId === accountId && !TERMINAL.has(item.status)).length >= REQUESTS_MAX_OPEN_PER_ACCOUNT) fail(429, 'Es sind bereits zu viele Anfragen offen.')
        const id = `r${randomBytes(8).toString('hex')}`
        const request = {
          schemaVersion: 1, id, accountId, type: input.type, title: input.title, description: input.description, priority: input.priority,
          status: 'queued', percent: 0, step: '', pr: null, reason: '', approved: false, cancelled: false,
          screenshot: input.screenshot ? input.screenshot.mime : null, hasLogs: Boolean(input.logs),
          createdAt: now(), updatedAt: now(), lastSeq: 0,
        }
        if (input.screenshot || input.logs) await fs.mkdir(join(root, 'attachments', id), { recursive: true, mode: 0o700 })
        if (input.screenshot) await writeAtomic(attachmentPath(id, 'screenshot'), input.screenshot.bytes)
        if (input.logs) await writeAtomic(attachmentPath(id, 'logs'), input.logs)
        await record(request, { type: 'status', from: null, status: 'queued' })
        return request
      })
    },
    // Atomically claims the oldest queued request; only one request is in flight at a time.
    claim() {
      return locked(async () => {
        const all = await loadAll()
        if (all.some((item) => item.status === 'picked' || item.status === 'working')) return { request: null, busy: true }
        const next = all.find((item) => item.status === 'queued')
        if (!next) return { request: null, busy: false }
        await move(next, 'picked')
        return { request: next, busy: false }
      })
    },
    approve: (id, accountId) => locked(async () => {
      const request = await load(id)
      if (!request || request.accountId !== accountId) fail(404, 'Anfrage nicht gefunden.')
      if (request.status !== 'waiting_for_you') fail(409, 'Die Anfrage wartet nicht auf deine Freigabe.')
      if (request.approved) return request
      request.approved = true
      await record(request, { type: 'approved' })
      return request
    }),
    cancel: (id, accountId) => locked(async () => {
      const request = await load(id)
      if (!request || request.accountId !== accountId) fail(404, 'Anfrage nicht gefunden.')
      if (TERMINAL.has(request.status)) fail(409, 'Die Anfrage ist bereits abgeschlossen.')
      request.cancelled = true
      request.reason = 'Vom Besitzer abgebrochen.'
      await move(request, 'rejected', { reason: request.reason })
      return request
    }),
    message: (id, accountId, text) => locked(async () => {
      const request = await load(id)
      if (!request || request.accountId !== accountId) fail(404, 'Anfrage nicht gefunden.')
      if (TERMINAL.has(request.status)) fail(409, 'Die Anfrage ist bereits abgeschlossen.')
      return record(request, { type: 'message', from: 'owner', text })
    }),
    workerEvent: (id, input) => locked(async () => {
      const request = await load(id)
      if (!request) fail(404, 'Anfrage nicht gefunden.')
      if (request.status === 'queued' || TERMINAL.has(request.status)) fail(409, 'Die Anfrage nimmt keine Fortschrittsmeldungen an.')
      request.step = input.text
      if (input.percent !== null) request.percent = input.percent
      return record(request, { type: 'progress', text: input.text, percent: request.percent })
    }),
    workerStatus: (id, input) => locked(async () => {
      const request = await load(id)
      if (!request) fail(404, 'Anfrage nicht gefunden.')
      if (input.status === 'merged' && !request.approved) fail(409, 'Die Anfrage wurde noch nicht freigegeben.')
      if (input.pr) request.pr = { ...(request.pr ?? {}), ...input.pr }
      if (input.reason) request.reason = input.reason
      if (input.status === 'merged') request.percent = 100
      const event = await move(request, input.status, { reason: input.reason || undefined, pr: request.pr ?? undefined })
      // Auto-approve: once CI is green the worker may merge without waiting for the owner.
      if (input.status === 'waiting_for_you' && autoApprove && !request.approved) {
        request.approved = true
        await record(request, { type: 'approved', by: 'auto' })
      }
      return { request, event }
    }),
    // Operator repair: the PR was merged by hand after the worker gave up (timeout, lost
    // report). Moves an open or failed request with a PR to `merged`; nothing else may skip
    // the approval, so this stays a worker-token action that the owner cannot trigger.
    markMerged: (id, input = {}) => locked(async () => {
      const request = await load(id)
      if (!request) fail(404, 'Anfrage nicht gefunden.')
      if (request.status === 'merged') return request
      if (!['failed', 'pr_open', 'waiting_for_you'].includes(request.status) || request.cancelled) fail(409, 'Diese Anfrage kann nicht als übernommen markiert werden.')
      if (input.pr) request.pr = { ...(request.pr ?? {}), ...input.pr }
      if (!request.pr?.number) fail(400, 'Die PR-Nummer fehlt.')
      const from = request.status
      request.status = 'merged'
      request.percent = 100
      request.reason = ''
      await record(request, { type: 'status', from, status: 'merged', pr: request.pr, by: 'operator' })
      return request
    }),
    async workerMessages(id, after) {
      const request = await load(id)
      if (!request) fail(404, 'Anfrage nicht gefunden.')
      const messages = (await readEvents(id, after)).filter((event) => event.type === 'message').map(({ seq, at, text }) => ({ seq, at, text }))
      return { messages, status: request.status, approved: request.approved, cancelled: request.cancelled, lastSeq: request.lastSeq }
    },
  }
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-FaNotes-Account, Last-Event-ID',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
}
const writeJson = (response, status, value) => {
  const body = JSON.stringify(value)
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...CORS })
  response.end(body)
}
const readJson = async (request) => {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > REQUESTS_MAX_BODY_BYTES) throw Object.assign(new Error('Die Anfrage ist zu groß.'), { status: 413 })
    chunks.push(chunk)
  }
  try {
    const parsed = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('shape')
    return parsed
  } catch {
    throw Object.assign(new Error('Ungültiges JSON.'), { status: 400 })
  }
}
const clientAddress = (request) => {
  const forwarded = request.headers['x-real-ip']
  return typeof forwarded === 'string' && forwarded.length <= 64 ? forwarded : request.socket.remoteAddress || 'unknown'
}
const view = (request) => {
  const { accountId, ...rest } = request
  return rest
}

export const parseCreateBody = (body) => {
  const title = str(body.title, REQUESTS_MAX_TITLE + 1)
  if (!title) fail(400, 'Bitte gib einen Titel an.')
  if (title.length > REQUESTS_MAX_TITLE) fail(400, 'Der Titel ist zu lang.')
  const description = str(body.description, REQUESTS_MAX_DESCRIPTION + 1)
  if (!description) fail(400, 'Bitte beschreibe die Anfrage.')
  if (description.length > REQUESTS_MAX_DESCRIPTION) fail(400, 'Die Beschreibung ist zu lang.')
  if (!TYPES.includes(body.type)) fail(400, 'Ungültige Art der Anfrage.')
  const priority = body.priority === undefined ? 'normal' : body.priority
  if (!PRIORITIES.includes(priority)) fail(400, 'Ungültige Priorität.')
  let screenshot = null
  if (body.screenshot !== undefined && body.screenshot !== null) {
    if (typeof body.screenshot !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/u.test(body.screenshot)) fail(400, 'Ungültiger Screenshot.')
    if (body.screenshot.length > Math.ceil(REQUESTS_MAX_SCREENSHOT_BYTES / 3) * 4) fail(413, 'Der Screenshot ist zu groß.')
    const bytes = Buffer.from(body.screenshot, 'base64')
    if (bytes.length > REQUESTS_MAX_SCREENSHOT_BYTES) fail(413, 'Der Screenshot ist zu groß.')
    const kind = imageKind(bytes)
    if (!kind) fail(400, 'Der Screenshot muss PNG oder JPEG sein.')
    screenshot = { bytes, mime: kind.mime }
  }
  let logs = ''
  if (body.logs !== undefined && body.logs !== null) {
    if (typeof body.logs !== 'string') fail(400, 'Ungültige Protokolle.')
    if (Buffer.byteLength(body.logs) > REQUESTS_MAX_LOG_BYTES) fail(413, 'Die Protokolle sind zu groß.')
    logs = scrubLogs(body.logs)
  }
  return { type: body.type, title, description, priority, screenshot, logs }
}

export const createWorkRequestsHandler = (store, options = {}) => {
  const env = options.env ?? process.env
  const authenticate = options.authenticate ?? authenticateSyncRequest
  const now = options.now ?? (() => Date.now())
  const heartbeatMs = options.heartbeatMs ?? REQUESTS_HEARTBEAT_MS
  const windows = new Map()
  const limit = (key, maximum, windowMs) => {
    const at = now()
    const current = windows.get(key)
    if (!current || current.until <= at) {
      if (windows.size > 5_000) windows.clear()
      windows.set(key, { count: 1, until: at + windowMs })
      return true
    }
    if (current.count >= maximum) return false
    current.count += 1
    return true
  }
  const owners = () => new Set(String(env.FANOTES_REQUEST_OWNERS ?? '').split(',').map((entry) => entry.trim()).filter(Boolean))
  const sseByAccount = new Map()
  let sseTotal = 0

  // Returns the account id, or null when the session is valid but the account is no owner.
  const ownerAccount = async (request) => {
    let auth
    try { auth = await authenticate(request) } catch (error) { fail(Number(error?.status) || 401, error?.message || 'Bitte erneut anmelden.') }
    const id = auth?.account?.id
    return typeof id === 'string' && owners().has(id) ? id : null
  }
  const requireOwner = async (request) => {
    const id = await ownerAccount(request)
    if (!id) fail(403, 'Diese Funktion ist nicht verfügbar.')
    return id
  }
  const requireWorker = (request) => {
    const expected = String(env.FANOTES_AGENT_TOKEN ?? '')
    if (expected.length < 32) fail(503, 'Der Worker ist nicht eingerichtet.')
    const ip = clientAddress(request)
    const header = request.headers.authorization
    const token = typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7).trim() : ''
    if (!token || !safeEqual(token, expected)) {
      const attempts = windows.get(`wb:${ip}`)
      if (attempts && attempts.until > now() && attempts.count >= 20) fail(429, 'Zu viele Anfragen.')
      limit(`wb:${ip}`, 20, 60_000)
      fail(401, 'Nicht autorisiert.')
    }
  }
  const owned = async (id, accountId) => {
    const found = await store.load(id)
    if (!found || found.accountId !== accountId) fail(404, 'Anfrage nicht gefunden.')
    return found
  }
  const sendAttachment = async (response, id, name, request) => {
    if (name === 'screenshot' ? !request.screenshot : !request.hasLogs) fail(404, 'Anhang nicht gefunden.')
    const bytes = await fs.readFile(store.attachmentPath(id, name)).catch(() => fail(404, 'Anhang nicht gefunden.'))
    response.writeHead(200, { 'Content-Type': name === 'logs' ? 'text/plain; charset=utf-8' : request.screenshot, 'Content-Length': bytes.length, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Disposition': 'attachment', ...CORS })
    response.end(bytes)
  }

  const stream = async (request, response, id, accountId) => {
    await owned(id, accountId)
    if ((sseByAccount.get(accountId) ?? 0) >= REQUESTS_SSE_PER_ACCOUNT || sseTotal >= REQUESTS_SSE_TOTAL) fail(429, 'Zu viele offene Live-Verbindungen.')
    const url = new URL(request.url, 'http://x')
    const rawLast = request.headers['last-event-id'] ?? url.searchParams.get('lastEventId') ?? '0'
    const last = Math.max(0, Number.parseInt(String(rawLast), 10) || 0)
    sseByAccount.set(accountId, (sseByAccount.get(accountId) ?? 0) + 1)
    sseTotal += 1
    response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no', 'X-Content-Type-Options': 'nosniff', ...CORS })
    let sent = last
    let ended = false
    let replaying = true
    const buffered = []
    const finish = () => {
      if (ended) return
      ended = true
      clearInterval(timer)
      store.bus.off(id, onEvent)
      sseTotal -= 1
      sseByAccount.set(accountId, Math.max(0, (sseByAccount.get(accountId) ?? 1) - 1))
      if (!response.writableEnded) response.end()
    }
    const write = (event) => {
      if (ended || event.seq <= sent) return
      sent = event.seq
      response.write(`id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
      if (event.type === 'status' && TERMINAL.has(event.status)) finish()
    }
    const onEvent = (event) => { if (replaying) buffered.push(event); else write(event) }
    const timer = setInterval(() => { if (!ended) response.write(`: heartbeat ${now()}\n\n`) }, heartbeatMs)
    timer.unref?.()
    store.bus.on(id, onEvent)
    request.on('close', finish)
    response.on('close', finish)
    response.write(`retry: 3000\n\n`)
    try {
      for (const event of await store.readEvents(id, last)) write(event)
      replaying = false
      for (const event of buffered.splice(0)) write(event)
    } catch {
      finish()
    }
  }

  return async (request, response, url) => {
    const match = /^\/api\/v1\/(requests|worker)(?:\/(.*))?$/u.exec(url.pathname)
    if (!match) return false
    if (request.method === 'OPTIONS') {
      response.writeHead(204, { ...CORS, 'Access-Control-Max-Age': '600' })
      response.end()
      return true
    }
    const segments = (match[2] ?? '').split('/').filter(Boolean)
    const method = request.method
    try {
      if (match[1] === 'worker') {
        requireWorker(request)
        if (method === 'POST' && segments.length === 1 && segments[0] === 'claim') {
          const { request: claimed, busy } = await store.claim()
          writeJson(response, 200, { request: claimed ? { ...claimed } : null, busy })
        } else if (segments[0] === 'requests' && ID.test(segments[1] ?? '')) {
          const id = segments[1]
          const tail = segments.slice(2).join('/')
          if (method === 'GET' && tail === 'messages') {
            const after = Math.max(0, Number.parseInt(url.searchParams.get('after') ?? '0', 10) || 0)
            writeJson(response, 200, await store.workerMessages(id, after))
          } else if (method === 'GET' && /^attachments\/(screenshot|logs)$/u.test(tail)) {
            const found = await store.load(id)
            if (!found) fail(404, 'Anfrage nicht gefunden.')
            await sendAttachment(response, id, segments[3], found)
          } else if (method === 'POST' && tail === 'merged') {
            const body = await readJson(request)
            const number = Number(body.prNumber)
            const pr = Number.isInteger(number) && number > 0 ? { number, url: typeof body.prUrl === 'string' && /^https:\/\/github\.com\//u.test(body.prUrl) ? body.prUrl.slice(0, 300) : undefined } : null
            writeJson(response, 200, { ok: true, request: await store.markMerged(id, { pr }) })
          } else if (method === 'POST' && tail === 'events') {
            const body = await readJson(request)
            const text = str(body.text, REQUESTS_MAX_PROGRESS_TEXT)
            if (!text) fail(400, 'Bitte gib einen Text an.')
            const percent = body.percent === undefined ? null : body.percent
            if (percent !== null && !(Number.isFinite(percent) && percent >= 0 && percent <= 100)) fail(400, 'Ungültiger Fortschritt.')
            const event = await store.workerEvent(id, { text, percent: percent === null ? null : Math.round(percent) })
            writeJson(response, 201, { ok: true, seq: event.seq })
          } else if (method === 'POST' && tail === 'status') {
            const body = await readJson(request)
            if (!WORKER_SETTABLE.has(body.status)) fail(400, 'Ungültiger Status.')
            const input = { status: body.status, reason: str(body.reason, 500), pr: null }
            if (body.prNumber !== undefined || body.prUrl !== undefined || body.ci !== undefined) {
              const pr = {}
              if (body.prNumber !== undefined) {
                if (!Number.isInteger(body.prNumber) || body.prNumber < 1) fail(400, 'Ungültige PR-Nummer.')
                pr.number = body.prNumber
              }
              if (body.prUrl !== undefined) {
                if (typeof body.prUrl !== 'string' || body.prUrl.length > 300 || !/^https:\/\/[^\s]+$/u.test(body.prUrl)) fail(400, 'Ungültige PR-Adresse.')
                pr.url = body.prUrl
              }
              if (body.ci !== undefined) {
                if (!CI_STATES.includes(body.ci)) fail(400, 'Ungültiger CI-Status.')
                pr.ci = body.ci
              }
              input.pr = pr
            }
            if (['pr_open', 'waiting_for_you'].includes(input.status)) {
              const current = await store.load(id)
              if (!current) fail(404, 'Anfrage nicht gefunden.')
              if (!input.pr?.number && !current.pr?.number) fail(400, 'Die PR-Nummer fehlt.')
            }
            if (['failed', 'rejected'].includes(input.status) && !input.reason) fail(400, 'Bitte gib einen Grund an.')
            const { request: updated } = await store.workerStatus(id, input)
            writeJson(response, 200, { ok: true, request: updated })
          } else fail(404, 'Nicht gefunden.')
        } else fail(404, 'Nicht gefunden.')
        return true
      }

      // Owner endpoints.
      if (method === 'GET' && segments.length === 1 && segments[0] === 'capabilities') {
        const account = await ownerAccount(request)
        writeJson(response, 200, account
          ? { enabled: true, maxScreenshotBytes: REQUESTS_MAX_SCREENSHOT_BYTES, maxLogBytes: REQUESTS_MAX_LOG_BYTES, maxTitle: REQUESTS_MAX_TITLE, maxDescription: REQUESTS_MAX_DESCRIPTION, maxMessage: REQUESTS_MAX_MESSAGE }
          : { enabled: false })
        return true
      }
      const accountId = await requireOwner(request)
      if (segments.length === 0 && method === 'POST') {
        if (!limit(`create:${accountId}`, REQUESTS_CREATE_PER_HOUR, 3_600_000)) fail(429, 'Zu viele Anfragen. Bitte warte etwas.')
        const created = await store.create(accountId, parseCreateBody(await readJson(request)))
        writeJson(response, 201, { request: view(created) })
      } else if (segments.length === 0 && method === 'GET') {
        writeJson(response, 200, { requests: (await store.list(accountId)).map(view) })
      } else if (ID.test(segments[0] ?? '')) {
        const id = segments[0]
        const tail = segments.slice(1).join('/')
        if (method === 'GET' && tail === '') writeJson(response, 200, { request: view(await owned(id, accountId)) })
        else if (method === 'GET' && tail === 'events') await stream(request, response, id, accountId)
        else if (method === 'GET' && /^attachments\/(screenshot|logs)$/u.test(tail)) await sendAttachment(response, id, segments[2], await owned(id, accountId))
        else if (method === 'POST' && tail === 'approve') writeJson(response, 200, { request: view(await store.approve(id, accountId)) })
        else if (method === 'POST' && tail === 'cancel') writeJson(response, 200, { request: view(await store.cancel(id, accountId)) })
        else if (method === 'POST' && tail === 'messages') {
          if (!limit(`msg:${accountId}`, REQUESTS_MESSAGES_PER_HOUR, 3_600_000)) fail(429, 'Zu viele Nachrichten. Bitte warte etwas.')
          const body = await readJson(request)
          const text = str(body.text, REQUESTS_MAX_MESSAGE + 1)
          if (!text) fail(400, 'Bitte gib eine Nachricht ein.')
          if (text.length > REQUESTS_MAX_MESSAGE) fail(400, 'Die Nachricht ist zu lang.')
          const event = await store.message(id, accountId, text)
          writeJson(response, 201, { ok: true, seq: event.seq })
        } else fail(404, 'Nicht gefunden.')
      } else fail(404, 'Nicht gefunden.')
    } catch (error) {
      if (response.headersSent) { response.end(); return true }
      writeJson(response, Number(error?.status) || 400, { error: error?.message || 'Ungültige Anfrage.' })
    }
    return true
  }
}

const defaultStore = createWorkRequestsStore(process.env.FANOTES_REQUESTS_DIR || '/var/lib/fanotes-requests', {
  autoApprove: process.env.FANOTES_REQUESTS_AUTO_APPROVE === '1',
})
export const handleWorkRequestsRequest = createWorkRequestsHandler(defaultStore)
