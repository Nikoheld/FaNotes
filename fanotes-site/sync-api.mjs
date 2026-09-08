// FaNotes Sync – accounts, device sessions and an end-to-end encrypted file
// store. The server never sees a password, a plaintext note, a file name or a
// vault key: clients derive an authentication key from the password (PBKDF2),
// encrypt every file and its metadata with a vault key that only they hold,
// and address files by an HMAC of their path. What is stored here per account
// is a scrypt hash of the authentication key, the wrapped vault key (opaque),
// and opaque blobs with a monotonically increasing revision so that devices
// can fetch "everything since revision N" and detect concurrent edits.
//
// Layout under FANOTES_SYNC_DIR:
//   emails/<sha256(email)>            -> accountId
//   accounts/<id>/account.json        -> credentials, kdf, wrapped key, devices, sessions
//   accounts/<id>/index.json          -> snapshot of the file table { revision, entries }
//   accounts/<id>/changes.jsonl       -> appended mutations since the snapshot
//   accounts/<id>/blobs/<fileId>      -> ciphertext
import { createHash, createHmac, randomBytes, scrypt, timingSafeEqual } from 'node:crypto'
import { createReadStream, promises as fs } from 'node:fs'
import { resolve, sep } from 'node:path'

const SYNC_ROOT = resolve(process.env.FANOTES_SYNC_DIR || '/var/lib/fanotes-sync')
const PUBLIC_ORIGIN = process.env.FANOTES_PUBLIC_ORIGIN || 'https://fanotes.fasrv.ch'
const API_PREFIX = '/api/v1/sync'
const MAX_JSON_BYTES = 64 * 1024
const MAX_BLOB_BYTES = Number(process.env.FANOTES_SYNC_MAX_FILE_BYTES || 100 * 1024 * 1024)
const QUOTA_BYTES = Number(process.env.FANOTES_SYNC_QUOTA_BYTES || 4 * 1024 * 1024 * 1024)
const MAX_FILES = Number(process.env.FANOTES_SYNC_MAX_FILES || 50_000)
const MAX_DEVICES = 20
const MAX_SESSIONS = 40
const SESSION_TTL_MS = 90 * 24 * 60 * 60 * 1000
const SESSION_TOUCH_MS = 6 * 60 * 60 * 1000
const CHANGES_PAGE = 500
const COMPACT_LOG_BYTES = 4 * 1024 * 1024
const MIN_KDF_ITERATIONS = 300_000
const MAX_KDF_ITERATIONS = 5_000_000
const FILE_ID_PATTERN = /^[a-f0-9]{64}$/u
const ACCOUNT_ID_PATTERN = /^[a-f0-9]{32}$/u
const DEVICE_ID_PATTERN = /^[a-f0-9]{24}$/u
const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/u
const EMAIL_PATTERN = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,24}$/u
const MAX_META_BYTES = 8 * 1024

class SyncApiError extends Error {
  constructor(status, publicMessage, extra = {}) {
    super(publicMessage)
    this.status = status
    this.publicMessage = publicMessage
    this.extra = extra
  }
}

const fail = (status, message, extra) => { throw new SyncApiError(status, message, extra) }

// ── Small utilities ─────────────────────────────────────────────────────────

const clientAddress = (request) => {
  const forwarded = request.headers['x-real-ip']
  return typeof forwarded === 'string' && forwarded.length <= 64 ? forwarded : request.socket?.remoteAddress || 'unknown'
}

const rateWindows = new Map()
const rateLimit = (key, maximum, windowMs) => {
  const now = Date.now()
  if (rateWindows.size > 50_000) {
    for (const [candidate, window] of rateWindows) if (window.until <= now) rateWindows.delete(candidate)
  }
  const current = rateWindows.get(key)
  if (!current || current.until <= now) {
    rateWindows.set(key, { count: 1, until: now + windowMs })
    return
  }
  if (current.count >= maximum) fail(429, 'Zu viele Anfragen. Bitte später erneut versuchen.')
  current.count += 1
}

const scryptHash = (secret, salt) => new Promise((resolveHash, rejectHash) => {
  scrypt(secret, salt, 32, { N: 32_768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (error, key) => {
    if (error) rejectHash(error)
    else resolveHash(key)
  })
})

const sha256 = (value) => createHash('sha256').update(value).digest('hex')
const safeEqual = (left, right) => left.length === right.length && timingSafeEqual(left, right)
const nowIso = () => new Date().toISOString()

const isBase64 = (value, minBytes, maxBytes) => {
  if (typeof value !== 'string' || !value || value.length % 4 !== 0 || !BASE64_PATTERN.test(value)) return false
  const bytes = Buffer.from(value, 'base64').length
  return bytes >= minBytes && bytes <= maxBytes
}

const normalizeEmail = (raw) => {
  const email = String(raw ?? '').trim().toLowerCase()
  if (!EMAIL_PATTERN.test(email) || email.length > 254) fail(400, 'Bitte eine gültige E-Mail-Adresse angeben.')
  return email
}

const parseAuthKey = (raw) => {
  if (!isBase64(raw, 32, 64)) fail(400, 'Der Anmeldeschlüssel ist ungültig.')
  return Buffer.from(raw, 'base64')
}

const parseKdf = (raw) => {
  if (!raw || typeof raw !== 'object') fail(400, 'Die Schlüsselableitung fehlt.')
  const iterations = Number(raw.iterations)
  if (raw.algorithm !== 'pbkdf2-sha256' || !Number.isInteger(iterations) || iterations < MIN_KDF_ITERATIONS || iterations > MAX_KDF_ITERATIONS) {
    fail(400, 'Die Schlüsselableitung wird nicht unterstützt.')
  }
  if (!isBase64(raw.salt, 16, 64)) fail(400, 'Das Salt der Schlüsselableitung ist ungültig.')
  return { algorithm: 'pbkdf2-sha256', iterations, salt: raw.salt }
}

const parseKeyWrap = (raw) => {
  if (!raw || typeof raw !== 'object' || !isBase64(raw.iv, 12, 16) || !isBase64(raw.data, 32, 256)) fail(400, 'Der verpackte Vault-Schlüssel ist ungültig.')
  return { iv: raw.iv, data: raw.data }
}

const parseDevice = (raw) => {
  const name = typeof raw?.name === 'string' ? raw.name.trim().replace(/[\0-\x1f\x7f]/gu, '').slice(0, 80) : ''
  const platform = typeof raw?.platform === 'string' && /^[a-z0-9-]{1,24}$/u.test(raw.platform) ? raw.platform : 'unknown'
  return { name: name || 'Gerät', platform }
}

const safeJoin = (root, ...segments) => {
  const target = resolve(root, ...segments)
  if (target !== root && !target.startsWith(`${root}${sep}`)) fail(400, 'Ungültiger Pfad.')
  return target
}

const readJsonBody = async (request) => {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > MAX_JSON_BYTES) fail(413, 'Die Anfrage ist zu groß.')
    chunks.push(chunk)
  }
  if (!chunks.length) return {}
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    fail(400, 'Ungültiges JSON.')
  }
}

const readBinaryBody = async (request, limit) => {
  const declared = Number(request.headers['content-length'])
  if (Number.isFinite(declared) && declared > limit) fail(413, 'Die Datei ist zu groß für den Sync.')
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > limit) fail(413, 'Die Datei ist zu groß für den Sync.')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

const atomicWrite = async (target, data) => {
  const temporary = `${target}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
  const handle = await fs.open(temporary, 'wx', 0o600)
  try {
    await handle.writeFile(data)
    await handle.sync()
  } finally {
    await handle.close()
  }
  await fs.rename(temporary, target)
}

const readJsonFile = async (target, fallback = null) => {
  try {
    return JSON.parse(await fs.readFile(target, 'utf8'))
  } catch (error) {
    if (error?.code === 'ENOENT') return fallback
    throw error
  }
}

// Per-account serialisation: every mutation of one account runs alone.
const locks = new Map()
const withAccountLock = async (accountId, task) => {
  const previous = locks.get(accountId) ?? Promise.resolve()
  let release
  const current = new Promise((resolveLock) => { release = resolveLock })
  locks.set(accountId, previous.then(() => current))
  await previous
  try {
    return await task()
  } finally {
    release()
    if (locks.get(accountId) === current) locks.delete(accountId)
  }
}

// ── Storage ─────────────────────────────────────────────────────────────────

const accountDirectory = (accountId) => safeJoin(SYNC_ROOT, 'accounts', accountId)
const emailIndexPath = (email) => safeJoin(SYNC_ROOT, 'emails', sha256(email))

let serverSecretPromise = null
/** Random per-installation secret used to answer pre-login requests for unknown e-mails with a stable, fake salt. */
const serverSecret = () => {
  serverSecretPromise ??= (async () => {
    await fs.mkdir(SYNC_ROOT, { recursive: true, mode: 0o700 })
    const target = safeJoin(SYNC_ROOT, 'server-secret')
    try {
      return await fs.readFile(target)
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
      const secret = randomBytes(32)
      await atomicWrite(target, secret)
      return secret
    }
  })()
  return serverSecretPromise
}

const loadAccountById = async (accountId) => {
  if (!ACCOUNT_ID_PATTERN.test(accountId)) return null
  return readJsonFile(safeJoin(accountDirectory(accountId), 'account.json'))
}

const loadAccountByEmail = async (email) => {
  const accountId = (await fs.readFile(emailIndexPath(email), 'utf8').catch(() => '')).trim()
  return accountId ? loadAccountById(accountId) : null
}

const saveAccount = async (account) => {
  await atomicWrite(safeJoin(accountDirectory(account.id), 'account.json'), `${JSON.stringify(account, null, 2)}\n`)
}

// The file table lives in memory per account (loaded lazily): a JSON snapshot
// plus an append-only log of mutations, compacted once the log grows.
const tables = new Map()

const loadTable = async (accountId) => {
  const cached = tables.get(accountId)
  if (cached) return cached
  const directory = accountDirectory(accountId)
  const snapshot = await readJsonFile(safeJoin(directory, 'index.json'), { revision: 0, entries: {} })
  const table = { revision: Number(snapshot.revision) || 0, entries: new Map(Object.entries(snapshot.entries ?? {})), bytes: 0, logBytes: 0 }
  const logPath = safeJoin(directory, 'changes.jsonl')
  try {
    const log = await fs.readFile(logPath, 'utf8')
    table.logBytes = Buffer.byteLength(log)
    for (const line of log.split('\n')) {
      if (!line.trim()) continue
      let entry
      try { entry = JSON.parse(line) } catch { continue }
      if (!entry || typeof entry.id !== 'string' || !(Number(entry.revision) > table.revision)) continue
      table.entries.set(entry.id, entry)
      table.revision = Number(entry.revision)
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  for (const entry of table.entries.values()) if (!entry.deleted) table.bytes += Number(entry.size) || 0
  tables.set(accountId, table)
  return table
}

const appendChange = async (accountId, table, entry) => {
  const directory = accountDirectory(accountId)
  const line = `${JSON.stringify(entry)}\n`
  const handle = await fs.open(safeJoin(directory, 'changes.jsonl'), 'a', 0o600)
  try {
    await handle.writeFile(line)
    await handle.sync()
  } finally {
    await handle.close()
  }
  table.logBytes += Buffer.byteLength(line)
  if (table.logBytes > COMPACT_LOG_BYTES) await compactTable(accountId, table)
}

const compactTable = async (accountId, table) => {
  const directory = accountDirectory(accountId)
  await atomicWrite(safeJoin(directory, 'index.json'), JSON.stringify({ revision: table.revision, entries: Object.fromEntries(table.entries) }))
  await fs.writeFile(safeJoin(directory, 'changes.jsonl'), '', { mode: 0o600 })
  table.logBytes = 0
}

const publicEntry = (entry) => ({
  id: entry.id,
  revision: entry.revision,
  deleted: Boolean(entry.deleted),
  size: entry.deleted ? 0 : entry.size,
  sha256: entry.deleted ? null : entry.sha256,
  meta: entry.deleted ? null : entry.meta,
  updatedAt: entry.updatedAt,
  deviceId: entry.deviceId,
})

// ── Sessions ────────────────────────────────────────────────────────────────

const issueSession = (account, deviceId) => {
  const token = randomBytes(32).toString('base64url')
  const now = Date.now()
  account.sessions[sha256(token)] = { deviceId, createdAt: new Date(now).toISOString(), lastSeenAt: new Date(now).toISOString(), expiresAt: new Date(now + SESSION_TTL_MS).toISOString() }
  // Oldest sessions fall off; a device list that grows without bound is a smell.
  const ordered = Object.entries(account.sessions).sort(([, a], [, b]) => Date.parse(a.lastSeenAt) - Date.parse(b.lastSeenAt))
  for (const [hash] of ordered.slice(0, Math.max(0, ordered.length - MAX_SESSIONS))) delete account.sessions[hash]
  return { token, expiresAt: account.sessions[sha256(token)].expiresAt }
}

const registerDevice = (account, device) => {
  const existing = Object.values(account.devices)
  if (existing.length >= MAX_DEVICES) {
    const stale = existing.sort((a, b) => Date.parse(a.lastSeenAt) - Date.parse(b.lastSeenAt))[0]
    for (const [hash, session] of Object.entries(account.sessions)) if (session.deviceId === stale.id) delete account.sessions[hash]
    delete account.devices[stale.id]
  }
  const id = randomBytes(12).toString('hex')
  account.devices[id] = { id, name: device.name, platform: device.platform, createdAt: nowIso(), lastSeenAt: nowIso() }
  return id
}

const authenticate = async (request) => {
  const header = request.headers.authorization
  const token = typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7).trim() : ''
  if (!/^[A-Za-z0-9_-]{40,50}$/u.test(token)) fail(401, 'Bitte erneut anmelden.')
  const accountHeader = request.headers['x-fanotes-account']
  if (typeof accountHeader !== 'string' || !ACCOUNT_ID_PATTERN.test(accountHeader)) fail(401, 'Bitte erneut anmelden.')
  const account = await loadAccountById(accountHeader)
  if (!account) fail(401, 'Bitte erneut anmelden.')
  const tokenHash = sha256(token)
  const session = account.sessions[tokenHash]
  if (!session || Date.parse(session.expiresAt) <= Date.now() || !account.devices[session.deviceId]) fail(401, 'Die Anmeldung ist abgelaufen. Bitte erneut anmelden.')
  return { account, session, tokenHash, deviceId: session.deviceId }
}

const touchSession = async (account, tokenHash) => {
  const session = account.sessions[tokenHash]
  const now = Date.now()
  if (!session || now - Date.parse(session.lastSeenAt) < SESSION_TOUCH_MS) return
  session.lastSeenAt = new Date(now).toISOString()
  session.expiresAt = new Date(now + SESSION_TTL_MS).toISOString()
  account.devices[session.deviceId].lastSeenAt = session.lastSeenAt
  await saveAccount(account)
}

// ── Responses ───────────────────────────────────────────────────────────────

const corsHeaders = (request) => {
  // Bearer tokens carry the authorisation, so CORS only decides which browser
  // contexts may talk to the API at all: the web app's own origin and the
  // desktop renderer (file://, which Chromium reports as "null").
  const origin = request.headers.origin
  const allowed = origin === 'null' || origin === PUBLIC_ORIGIN
  return {
    ...(allowed ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' } : {}),
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, If-Match, X-FaNotes-Account, X-FaNotes-Meta, X-FaNotes-Sha256',
    'Access-Control-Expose-Headers': 'ETag, X-FaNotes-Meta, X-FaNotes-Revision, X-FaNotes-Deleted',
    'Access-Control-Max-Age': '600',
  }
}

const baseHeaders = (request) => ({
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  ...corsHeaders(request),
})

const sendJson = (request, response, status, body, extra = {}) => {
  const payload = JSON.stringify(body)
  response.writeHead(status, { ...baseHeaders(request), 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(payload), ...extra })
  response.end(payload)
}

const sendEmpty = (request, response, status, extra = {}) => {
  response.writeHead(status, { ...baseHeaders(request), ...extra })
  response.end()
}

// ── Handlers ────────────────────────────────────────────────────────────────

const handlePrelogin = async (request, response) => {
  rateLimit(`sync:prelogin:${clientAddress(request)}`, 60, 15 * 60 * 1000)
  const body = await readJsonBody(request)
  const email = normalizeEmail(body.email)
  const account = await loadAccountByEmail(email)
  if (account) {
    sendJson(request, response, 200, { kdf: account.kdf })
    return
  }
  // Unknown addresses get a deterministic salt so the response does not reveal whether an account exists.
  const fakeSalt = createHmac('sha256', await serverSecret()).update(`salt:${email}`).digest().subarray(0, 16).toString('base64')
  sendJson(request, response, 200, { kdf: { algorithm: 'pbkdf2-sha256', iterations: 600_000, salt: fakeSalt } })
}

const handleRegister = async (request, response) => {
  rateLimit(`sync:register:${clientAddress(request)}`, 10, 60 * 60 * 1000)
  const body = await readJsonBody(request)
  const email = normalizeEmail(body.email)
  const authKey = parseAuthKey(body.authKey)
  const kdf = parseKdf(body.kdf)
  const vaultKeyWrap = parseKeyWrap(body.vaultKeyWrap)
  const device = parseDevice(body.device)
  await serverSecret()
  await fs.mkdir(safeJoin(SYNC_ROOT, 'emails'), { recursive: true, mode: 0o700 })
  const id = randomBytes(16).toString('hex')
  const salt = randomBytes(16)
  const account = {
    version: 1,
    id,
    email,
    createdAt: nowIso(),
    auth: { salt: salt.toString('base64'), hash: (await scryptHash(authKey, salt)).toString('base64') },
    kdf,
    vaultKeyWrap,
    devices: {},
    sessions: {},
  }
  const deviceId = registerDevice(account, device)
  const session = issueSession(account, deviceId)
  await fs.mkdir(safeJoin(accountDirectory(id), 'blobs'), { recursive: true, mode: 0o700 })
  try {
    // 'wx' makes the e-mail index the uniqueness check; two racing registrations cannot both win.
    await fs.writeFile(emailIndexPath(email), id, { flag: 'wx', mode: 0o600 })
  } catch (error) {
    await fs.rm(accountDirectory(id), { recursive: true, force: true })
    if (error?.code === 'EEXIST') fail(409, 'Für diese E-Mail-Adresse gibt es bereits ein Konto. Bitte anmelden.')
    throw error
  }
  await saveAccount(account)
  sendJson(request, response, 201, { accountId: id, deviceId, token: session.token, expiresAt: session.expiresAt, revision: 0 })
}

const handleLogin = async (request, response) => {
  const address = clientAddress(request)
  rateLimit(`sync:login:${address}`, 30, 15 * 60 * 1000)
  const body = await readJsonBody(request)
  const email = normalizeEmail(body.email)
  rateLimit(`sync:login:${sha256(email)}`, 12, 15 * 60 * 1000)
  const authKey = parseAuthKey(body.authKey)
  const device = parseDevice(body.device)
  const account = await loadAccountByEmail(email)
  const verify = async (record) => {
    const expected = Buffer.from(record.auth.hash, 'base64')
    const actual = await scryptHash(authKey, Buffer.from(record.auth.salt, 'base64'))
    return safeEqual(expected, actual)
  }
  if (!account) {
    // Burn the same time as a real check so timing does not reveal unknown e-mails.
    await scryptHash(authKey, randomBytes(16))
    fail(401, 'E-Mail-Adresse oder Passwort stimmen nicht.')
  }
  if (!await verify(account)) fail(401, 'E-Mail-Adresse oder Passwort stimmen nicht.')
  await withAccountLock(account.id, async () => {
    const fresh = await loadAccountById(account.id)
    const deviceId = registerDevice(fresh, device)
    const session = issueSession(fresh, deviceId)
    await saveAccount(fresh)
    const table = await loadTable(fresh.id)
    sendJson(request, response, 200, { accountId: fresh.id, deviceId, token: session.token, expiresAt: session.expiresAt, kdf: fresh.kdf, vaultKeyWrap: fresh.vaultKeyWrap, revision: table.revision })
  })
}

const handleAccount = async (request, response, auth) => {
  const table = await loadTable(auth.account.id)
  const files = [...table.entries.values()].filter((entry) => !entry.deleted).length
  sendJson(request, response, 200, {
    accountId: auth.account.id,
    email: auth.account.email,
    createdAt: auth.account.createdAt,
    revision: table.revision,
    usage: { files, bytes: table.bytes, quotaBytes: QUOTA_BYTES, maxFiles: MAX_FILES, maxFileBytes: MAX_BLOB_BYTES },
    devices: Object.values(auth.account.devices).map((device) => ({ ...device, current: device.id === auth.deviceId })),
  })
}

const handleLogout = async (request, response, auth) => {
  await withAccountLock(auth.account.id, async () => {
    const account = await loadAccountById(auth.account.id)
    delete account.sessions[auth.tokenHash]
    if (!Object.values(account.sessions).some((session) => session.deviceId === auth.deviceId)) delete account.devices[auth.deviceId]
    await saveAccount(account)
  })
  sendEmpty(request, response, 204)
}

const handleRemoveDevice = async (request, response, auth, deviceId) => {
  if (!DEVICE_ID_PATTERN.test(deviceId)) fail(404, 'Dieses Gerät ist nicht bekannt.')
  await withAccountLock(auth.account.id, async () => {
    const account = await loadAccountById(auth.account.id)
    if (!account.devices[deviceId]) fail(404, 'Dieses Gerät ist nicht bekannt.')
    delete account.devices[deviceId]
    for (const [hash, session] of Object.entries(account.sessions)) if (session.deviceId === deviceId) delete account.sessions[hash]
    await saveAccount(account)
  })
  sendEmpty(request, response, 204)
}

/** Password change: new auth key, new KDF parameters and the vault key re-wrapped by the client; every other session is signed out. */
const handlePassword = async (request, response, auth) => {
  rateLimit(`sync:password:${auth.account.id}`, 10, 60 * 60 * 1000)
  const body = await readJsonBody(request)
  const currentKey = parseAuthKey(body.authKey)
  const nextKey = parseAuthKey(body.newAuthKey)
  const kdf = parseKdf(body.kdf)
  const vaultKeyWrap = parseKeyWrap(body.vaultKeyWrap)
  await withAccountLock(auth.account.id, async () => {
    const account = await loadAccountById(auth.account.id)
    const expected = Buffer.from(account.auth.hash, 'base64')
    if (!safeEqual(expected, await scryptHash(currentKey, Buffer.from(account.auth.salt, 'base64')))) fail(403, 'Das aktuelle Passwort stimmt nicht.')
    const salt = randomBytes(16)
    account.auth = { salt: salt.toString('base64'), hash: (await scryptHash(nextKey, salt)).toString('base64') }
    account.kdf = kdf
    account.vaultKeyWrap = vaultKeyWrap
    account.sessions = { [auth.tokenHash]: account.sessions[auth.tokenHash] }
    for (const id of Object.keys(account.devices)) if (id !== auth.deviceId) delete account.devices[id]
    await saveAccount(account)
  })
  sendEmpty(request, response, 204)
}

const handleDeleteAccount = async (request, response, auth) => {
  rateLimit(`sync:delete:${auth.account.id}`, 5, 60 * 60 * 1000)
  const body = await readJsonBody(request)
  const authKey = parseAuthKey(body.authKey)
  await withAccountLock(auth.account.id, async () => {
    const account = await loadAccountById(auth.account.id)
    const expected = Buffer.from(account.auth.hash, 'base64')
    if (!safeEqual(expected, await scryptHash(authKey, Buffer.from(account.auth.salt, 'base64')))) fail(403, 'Das Passwort stimmt nicht.')
    await fs.rm(emailIndexPath(account.email), { force: true })
    await fs.rm(accountDirectory(account.id), { recursive: true, force: true })
    tables.delete(account.id)
  })
  sendEmpty(request, response, 204)
}

const handleChanges = async (request, response, auth, url) => {
  const table = await loadTable(auth.account.id)
  const since = Number(url.searchParams.get('since') || 0)
  if (!Number.isInteger(since) || since < 0) fail(400, 'Der Parameter „since“ muss eine Revisionsnummer sein.')
  const entries = [...table.entries.values()].filter((entry) => entry.revision > since).sort((a, b) => a.revision - b.revision)
  const page = entries.slice(0, CHANGES_PAGE)
  sendJson(request, response, 200, {
    revision: table.revision,
    entries: page.map(publicEntry),
    more: entries.length > page.length,
    nextSince: page.length ? page[page.length - 1].revision : table.revision,
  })
}

const parseFileId = (raw) => {
  if (!FILE_ID_PATTERN.test(raw)) fail(400, 'Die Datei-ID ist ungültig.')
  return raw
}

const parseIfMatch = (request) => {
  const raw = request.headers['if-match']
  if (typeof raw !== 'string') fail(428, 'Die Anfrage braucht die Basis-Revision im If-Match-Header.')
  const value = Number(raw.replaceAll('"', '').trim())
  if (!Number.isInteger(value) || value < 0) fail(400, 'If-Match muss eine Revisionsnummer sein.')
  return value
}

const parseMeta = (request) => {
  const raw = request.headers['x-fanotes-meta']
  if (!isBase64(raw, 28, MAX_META_BYTES)) fail(400, 'Die verschlüsselten Metadaten fehlen oder sind ungültig.')
  return raw
}

const handleGetFile = async (request, response, auth, fileId) => {
  const table = await loadTable(auth.account.id)
  const entry = table.entries.get(fileId)
  if (!entry) fail(404, 'Diese Datei gibt es im Sync nicht.')
  if (entry.deleted) {
    sendEmpty(request, response, 204, { 'X-FaNotes-Revision': String(entry.revision), 'X-FaNotes-Deleted': '1', ETag: `"${entry.revision}"` })
    return
  }
  const blobPath = safeJoin(accountDirectory(auth.account.id), 'blobs', fileId)
  const stat = await fs.stat(blobPath).catch(() => null)
  if (!stat) fail(404, 'Die Datei ist auf dem Server nicht mehr vorhanden.')
  response.writeHead(200, {
    ...baseHeaders(request),
    'Content-Type': 'application/octet-stream',
    'Content-Length': stat.size,
    ETag: `"${entry.revision}"`,
    'X-FaNotes-Revision': String(entry.revision),
    'X-FaNotes-Meta': entry.meta,
    'X-FaNotes-Sha256': entry.sha256,
  })
  if (request.method === 'HEAD') {
    response.end()
    return
  }
  const stream = createReadStream(blobPath)
  stream.on('error', () => { if (!response.destroyed) response.destroy() })
  stream.pipe(response)
}

const conflict = (request, response, entry) => {
  sendJson(request, response, 409, { error: 'Die Datei wurde inzwischen von einem anderen Gerät geändert.', entry: publicEntry(entry) })
}

const handlePutFile = async (request, response, auth, fileId) => {
  const base = parseIfMatch(request)
  const meta = parseMeta(request)
  const declaredSha = request.headers['x-fanotes-sha256']
  if (typeof declaredSha !== 'string' || !FILE_ID_PATTERN.test(declaredSha)) fail(400, 'Die Prüfsumme der Datei fehlt.')
  const body = await readBinaryBody(request, MAX_BLOB_BYTES)
  if (body.length < 28) fail(400, 'Der verschlüsselte Inhalt ist zu kurz.')
  if (sha256(body) !== declaredSha) fail(400, 'Die Datei kam beschädigt an. Bitte erneut versuchen.')
  await withAccountLock(auth.account.id, async () => {
    const table = await loadTable(auth.account.id)
    const current = table.entries.get(fileId)
    const currentRevision = current ? current.revision : 0
    if (currentRevision !== base) return conflict(request, response, current ?? { id: fileId, revision: 0, deleted: true, updatedAt: null, deviceId: null })
    const previousBytes = current && !current.deleted ? Number(current.size) || 0 : 0
    if (table.bytes - previousBytes + body.length > QUOTA_BYTES) fail(507, 'Der Speicherplatz dieses Kontos ist voll.')
    const liveFiles = [...table.entries.values()].filter((entry) => !entry.deleted).length
    if ((!current || current.deleted) && liveFiles >= MAX_FILES) fail(507, 'Dieses Konto hat die maximale Anzahl an Dateien erreicht.')
    const blobPath = safeJoin(accountDirectory(auth.account.id), 'blobs', fileId)
    await atomicWrite(blobPath, body)
    const entry = { id: fileId, revision: table.revision + 1, deleted: false, size: body.length, sha256: declaredSha, meta, updatedAt: nowIso(), deviceId: auth.deviceId }
    table.revision = entry.revision
    table.entries.set(fileId, entry)
    table.bytes += body.length - previousBytes
    await appendChange(auth.account.id, table, entry)
    sendJson(request, response, 200, { revision: entry.revision, tableRevision: table.revision }, { ETag: `"${entry.revision}"` })
  })
}

const handleDeleteFile = async (request, response, auth, fileId) => {
  const base = parseIfMatch(request)
  await withAccountLock(auth.account.id, async () => {
    const table = await loadTable(auth.account.id)
    const current = table.entries.get(fileId)
    const currentRevision = current ? current.revision : 0
    if (currentRevision !== base) return conflict(request, response, current ?? { id: fileId, revision: 0, deleted: true, updatedAt: null, deviceId: null })
    if (!current || current.deleted) {
      sendJson(request, response, 200, { revision: currentRevision, tableRevision: table.revision })
      return
    }
    await fs.rm(safeJoin(accountDirectory(auth.account.id), 'blobs', fileId), { force: true })
    const entry = { id: fileId, revision: table.revision + 1, deleted: true, size: 0, sha256: null, meta: null, updatedAt: nowIso(), deviceId: auth.deviceId }
    table.revision = entry.revision
    table.entries.set(fileId, entry)
    table.bytes -= Number(current.size) || 0
    await appendChange(auth.account.id, table, entry)
    sendJson(request, response, 200, { revision: entry.revision, tableRevision: table.revision })
  })
}

// ── Router ──────────────────────────────────────────────────────────────────

export const handleSyncRequest = async (request, response, url) => {
  if (url.pathname !== API_PREFIX && !url.pathname.startsWith(`${API_PREFIX}/`)) return false
  const route = url.pathname.slice(API_PREFIX.length).replace(/\/+$/u, '') || '/'
  const method = request.method || 'GET'
  try {
    if (method === 'OPTIONS') {
      sendEmpty(request, response, 204)
      return true
    }
    if (route === '/prelogin' && method === 'POST') { await handlePrelogin(request, response); return true }
    if (route === '/register' && method === 'POST') { await handleRegister(request, response); return true }
    if (route === '/login' && method === 'POST') { await handleLogin(request, response); return true }

    const auth = await authenticate(request)
    rateLimit(`sync:account:${auth.account.id}`, 1200, 60 * 1000)
    await touchSession(auth.account, auth.tokenHash)

    if (route === '/account' && method === 'GET') { await handleAccount(request, response, auth); return true }
    if (route === '/account' && method === 'DELETE') { await handleDeleteAccount(request, response, auth); return true }
    if (route === '/logout' && method === 'POST') { await handleLogout(request, response, auth); return true }
    if (route === '/password' && method === 'POST') { await handlePassword(request, response, auth); return true }
    if (route === '/changes' && method === 'GET') { await handleChanges(request, response, auth, url); return true }
    const deviceMatch = /^\/devices\/([a-f0-9]{24})$/u.exec(route)
    if (deviceMatch && method === 'DELETE') { await handleRemoveDevice(request, response, auth, deviceMatch[1]); return true }
    const fileMatch = /^\/files\/([a-f0-9]{64})$/u.exec(route)
    if (fileMatch) {
      const fileId = parseFileId(fileMatch[1])
      if (method === 'GET' || method === 'HEAD') { await handleGetFile(request, response, auth, fileId); return true }
      if (method === 'PUT') { await handlePutFile(request, response, auth, fileId); return true }
      if (method === 'DELETE') { await handleDeleteFile(request, response, auth, fileId); return true }
    }
    fail(404, 'Diesen Sync-Endpunkt gibt es nicht.')
  } catch (error) {
    if (error instanceof SyncApiError) {
      sendJson(request, response, error.status, { error: error.publicMessage, ...error.extra })
    } else {
      console.error(new Date().toISOString(), 'sync', method, route, error?.code || error?.message)
      sendJson(request, response, 500, { error: 'Der Sync-Server hat einen internen Fehler.' })
    }
  }
  return true
}

export const syncLimits = Object.freeze({ maxBlobBytes: MAX_BLOB_BYTES, quotaBytes: QUOTA_BYTES, maxFiles: MAX_FILES, sessionTtlMs: SESSION_TTL_MS, minKdfIterations: MIN_KDF_ITERATIONS })
