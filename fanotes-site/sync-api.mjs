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
//   accounts/<id>/revisions/<fileId>/ -> the last 8 blobs, and the largest
//     older blob, so a shrink or a bad overwrite can be restored
//   accounts/<id>/quarantine/<fileId>/ -> rejected empty or truncated uploads
//   accounts/<id>/partials/<uploadId>/ -> a resumable upload (meta.json, body.bin)
//     that is not a live note until its size and checksum match
import { createHash, createHmac, randomBytes, scrypt, timingSafeEqual } from 'node:crypto'
import { constants as fsConstants, promises as fs } from 'node:fs'
import { dirname, resolve, sep } from 'node:path'
import { languageForRequest, localizeText } from './i18n.mjs'
import { hashFile, inspectSyncAccount } from './sync-integrity.mjs'

const syncRoot = () => resolve(process.env.FANOTES_SYNC_DIR || '/var/lib/fanotes-sync')
let onAccountDeleted = async () => {}
export const setAccountDeletedHook = (hook) => {
  onAccountDeleted = typeof hook === 'function' ? hook : async () => {}
}
export const notifyAccountDeleted = async (accountId) => {
  await onAccountDeleted(accountId)
}
export const syncAccountExists = async (accountId) => {
  if (!ACCOUNT_ID_PATTERN.test(String(accountId || ''))) return false
  try {
    const stat = await fs.stat(safeJoin(syncRoot(), 'accounts', accountId, 'account.json'))
    return stat.isFile()
  } catch {
    return false
  }
}
const PUBLIC_ORIGIN = process.env.FANOTES_PUBLIC_ORIGIN || 'https://fanotes.fasrv.ch'
const API_PREFIX = '/api/v1/sync'
const MAX_JSON_BYTES = 64 * 1024
const MAX_BLOB_BYTES = Number(process.env.FANOTES_SYNC_MAX_FILE_BYTES || 100 * 1024 * 1024)
const QUOTA_BYTES = Number(process.env.FANOTES_SYNC_QUOTA_BYTES || 4 * 1024 * 1024 * 1024)
// A large note replaced by a few hundred bytes, or by under a quarter of its
// size, is what a failed load looks like. That net holds whatever the client
// claims about the body. Short notes are not judged by size: deleting a line
// from a 600-byte note is a normal edit, and the archive keeps the previous blob.
const COLLAPSE_OLD_BYTES = 4096
const COLLAPSE_NEW_BYTES = 1024
// AES-GCM adds a 12-byte IV and a 16-byte tag; a body of this size is an empty file.
const EMPTY_CIPHERTEXT_BYTES = 28
const MAX_REVISIONS_KEPT = 8

/** Newest revisions, plus an older blob that is still the largest. The highest revision is always kept. */
export const revisionNamesToKeep = (files, keep = MAX_REVISIONS_KEPT, nextSize = 0) => {
  const ranked = [...(files || [])].filter((file) => file && Number.isFinite(file.revision)).sort((left, right) => left.revision - right.revision || String(left.name).localeCompare(String(right.name)))
  const names = new Set(ranked.slice(-Math.max(1, keep)).map((file) => file.name))
  if (!ranked.length) return names
  const largest = ranked.reduce((best, file) => (file.size > best.size ? file : best), ranked[0])
  if (largest.size > nextSize) names.add(largest.name)
  return names
}
const MAX_FILES = Number(process.env.FANOTES_SYNC_MAX_FILES || 50_000)
const MAX_DEVICES = 20
const MAX_SESSIONS = 40
const SESSION_TTL_MS = 90 * 24 * 60 * 60 * 1000
const SESSION_TOUCH_MS = 6 * 60 * 60 * 1000
const CHANGES_PAGE = 500
const COMPACT_LOG_BYTES = Number(process.env.FANOTES_SYNC_COMPACT_BYTES || 4 * 1024 * 1024)
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
  // retryAfter (seconds) tells a syncing client when the window opens again, so it can wait instead of failing.
  if (current.count >= maximum) fail(429, 'Zu viele Anfragen. Bitte später erneut versuchen.', { retryAfter: Math.max(1, Math.ceil((current.until - now) / 1000)) })
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

// Desktop sends linux, win32, or darwin. The website sends web. The Android
// tablet client sends android. Any other short token is stored as given so a
// new client is not rejected; a missing or unsafe value becomes unknown.
export const normalizeSyncPlatform = (value) => {
  const platform = typeof value === 'string' ? value.trim().toLowerCase() : ''
  return /^[a-z0-9-]{1,24}$/u.test(platform) ? platform : 'unknown'
}

const parseDevice = (raw) => {
  const name = typeof raw?.name === 'string' ? raw.name.trim().replace(/[\0-\x1f\x7f]/gu, '').slice(0, 80) : ''
  return { name: name || 'Gerät', platform: normalizeSyncPlatform(raw?.platform) }
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

// The body is hashed and written as it arrives. A 100 MB note must not sit in
// the heap, and a short or extra-long body is deleted before it can replace one.
const spoolUpload = async (directory, request, limit) => {
  const declared = Number(request.headers['content-length'])
  if (!Number.isInteger(declared) || declared < 0) fail(400, 'Die Datei kam unvollständig an.')
  if (declared > limit) fail(413, 'Die Datei ist zu groß für den Sync.')
  const existing = await fs.lstat(directory).catch((error) => (error?.code === 'ENOENT' ? null : Promise.reject(error)))
  await fs.mkdir(directory, { recursive: true, mode: 0o700 })
  if (!existing) {
    // Link the new incoming directory before a spool is created in it. A crash
    // must not drop the directory that holds this upload.
    await syncDirectory(dirname(directory))
  }
  const target = safeJoin(directory, `${process.pid}.${randomBytes(6).toString('hex')}.part`)
  const handle = await fs.open(target, 'wx', 0o600)
  const hash = createHash('sha256')
  let size = 0
  try {
    for await (const chunk of request) {
      size += chunk.length
      if (size > declared) fail(400, 'Die Datei kam unvollständig an.')
      hash.update(chunk)
      let offset = 0
      while (offset < chunk.length) {
        const result = await handle.write(chunk.subarray(offset))
        if (!result.bytesWritten) fail(400, 'Die Datei kam unvollständig an.')
        offset += result.bytesWritten
      }
    }
    if (size !== declared) fail(400, 'Die Datei kam unvollständig an.')
    await handle.sync()
  } catch (error) {
    await handle.close().catch(() => {})
    await fs.rm(target, { force: true })
    // A rejected spool name has to be durable. A crash must not bring that
    // file back beside the notes.
    await syncDirectory(directory)
    if (error instanceof SyncApiError) throw error
    fail(400, 'Die Datei kam unvollständig an.')
  }
  await handle.close()
  // The spool name has to be durable before the caller renames it onto a note.
  await syncDirectory(directory)
  return { path: target, size, sha256: hash.digest('hex') }
}

const atomicWrite = async (target, data) => {
  const temporary = `${target}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
  const handle = await fs.open(temporary, 'wx', 0o600)
  try {
    await handle.writeFile(data)
    await handle.sync()
  } catch (error) {
    await handle.close().catch(() => {})
    await fs.rm(temporary, { force: true })
    // A failed write must not leave its temporary name beside the real file.
    await syncDirectory(dirname(target))
    throw error
  }
  await handle.close()
  await fs.rename(temporary, target)
  // The new directory entry has to be durable. A crash after the rename and
  // before this sync can lose the file the caller just replaced.
  await syncDirectory(dirname(target))
}

const syncDirectory = async (directory) => {
  const handle = await fs.open(directory, 'r')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

// Copy a durable archive onto a blob without holding the ciphertext in the heap.
// The temporary file is renamed only after fsync, so a crash keeps the live note.
const copyDurable = async (source, destination) => {
  const temporary = `${destination}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
  const input = await fs.open(source, 'r')
  let output
  try {
    output = await fs.open(temporary, 'wx', 0o600)
  } catch (error) {
    await input.close().catch(() => {})
    throw error
  }
  const buffer = Buffer.alloc(64 * 1024)
  try {
    let position = 0
    while (true) {
      const { bytesRead } = await input.read(buffer, 0, buffer.length, position)
      if (!bytesRead) break
      let written = 0
      while (written < bytesRead) {
        const result = await output.write(buffer, written, bytesRead - written, position + written)
        if (!result.bytesWritten) fail(400, 'Die Datei kam unvollständig an.')
        written += result.bytesWritten
      }
      position += bytesRead
    }
    await output.sync()
  } catch (error) {
    await output.close().catch(() => {})
    await input.close().catch(() => {})
    await fs.rm(temporary, { force: true })
    // A failed copy must not leave its temporary name beside the live note.
    await syncDirectory(dirname(destination))
    throw error
  }
  await output.close()
  await input.close()
  await fs.rename(temporary, destination)
  await syncDirectory(dirname(destination))
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

const accountDirectory = (accountId) => safeJoin(syncRoot(), 'accounts', accountId)
const emailIndexPath = (email) => safeJoin(syncRoot(), 'emails', sha256(email))

let serverSecretPromise = null
/** Random per-installation secret used to answer pre-login requests for unknown e-mails with a stable, fake salt. */
const serverSecret = () => {
  serverSecretPromise ??= (async () => {
    await fs.mkdir(syncRoot(), { recursive: true, mode: 0o700 })
    const target = safeJoin(syncRoot(), 'server-secret')
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
  table.historyBytes = await measureHistory(accountId)
  tables.set(accountId, table)
  return table
}

const revisionsDirectory = (accountId, fileId) => safeJoin(accountDirectory(accountId), 'revisions', fileId)

const measureHistory = async (accountId) => {
  const root = safeJoin(accountDirectory(accountId), 'revisions')
  let total = 0
  let fileIds
  try {
    fileIds = await fs.readdir(root)
  } catch (error) {
    if (error?.code === 'ENOENT') return 0
    throw error
  }
  for (const fileId of fileIds) {
    if (!FILE_ID_PATTERN.test(fileId)) continue
    let names
    try {
      names = await fs.readdir(revisionsDirectory(accountId, fileId))
    } catch (error) {
      if (error?.code === 'ENOENT') continue
      throw error
    }
    for (const name of names) {
      if (!/^(?:c-)?\d+$/u.test(name)) continue
      const stat = await fs.lstat(safeJoin(revisionsDirectory(accountId, fileId), name)).catch(() => null)
      if (stat?.isFile()) total += stat.size
    }
  }
  return total
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
  // The first append creates the log. The file sync does not make that new
  // name durable, and the response is sent only after this returns.
  await syncDirectory(directory)
  table.logBytes += Buffer.byteLength(line)
  if (table.logBytes > COMPACT_LOG_BYTES) await compactTable(accountId, table)
}

const compactTable = async (accountId, table) => {
  const directory = accountDirectory(accountId)
  await atomicWrite(safeJoin(directory, 'index.json'), JSON.stringify({ revision: table.revision, entries: Object.fromEntries(table.entries) }))
  // The index rename has to be durable before the log is replaced. A crash
  // that kept the new index and lost the log would drop every revision that
  // lived only in the log.
  const directoryHandle = await fs.open(directory, 'r')
  try {
    await directoryHandle.sync()
  } finally {
    await directoryHandle.close()
  }
  // Replace the log by rename. A crash must not tear the log in place after
  // the index is saved.
  await atomicWrite(safeJoin(directory, 'changes.jsonl'), '')
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
  // The object from authenticate can be older than a password change or a
  // logout that already saved. Writing that object back would drop the new
  // vault wrap or bring a signed-out session back. Reload under the lock and
  // update only the current record.
  await withAccountLock(account.id, async () => {
    const fresh = await loadAccountById(account.id)
    const current = fresh?.sessions?.[tokenHash]
    if (!current || Date.parse(current.expiresAt) <= now) return
    const device = fresh.devices?.[current.deviceId]
    if (!device) return
    if (now - Date.parse(current.lastSeenAt) < SESSION_TOUCH_MS) return
    const seen = new Date(now).toISOString()
    current.lastSeenAt = seen
    current.expiresAt = new Date(now + SESSION_TTL_MS).toISOString()
    device.lastSeenAt = seen
    await saveAccount(fresh)
  })
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
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, If-Match, Upload-Offset, X-Request-Id, X-FaNotes-Account, X-Kanti-Guest, X-FaNotes-Meta, X-FaNotes-Sha256, X-FaNotes-Blank, X-FaNotes-Clear, X-FaNotes-Delete',
    'Access-Control-Expose-Headers': 'ETag, Upload-Offset, X-Request-Id, X-FaNotes-Meta, X-FaNotes-Revision, X-FaNotes-Deleted, X-FaNotes-Rejected',
    'Access-Control-Max-Age': '600',
  }
}

const baseHeaders = (request) => ({
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  ...(request.syncRequestId ? { 'X-Request-Id': request.syncRequestId } : {}),
  ...corsHeaders(request),
})

const sendJson = (request, response, status, body, extra = {}) => {
  // Only the human-readable error text is localised; ids, base64 and revisions pass through untouched.
  const localized = typeof body?.error === 'string' ? { ...body, error: localizeText(body.error, languageForRequest(request)) } : body
  const payload = JSON.stringify(localized)
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
  sendJson(request, response, 200, { kdf: await preloginKdf(normalizeEmail(body.email)) })
}

const preloginKdf = async (email) => {
  const account = await loadAccountByEmail(email)
  if (account) return account.kdf
  // Unknown addresses get a deterministic salt so the response does not reveal whether an account exists.
  const fakeSalt = createHmac('sha256', await serverSecret()).update(`salt:${email}`).digest().subarray(0, 16).toString('base64')
  return { algorithm: 'pbkdf2-sha256', iterations: 600_000, salt: fakeSalt }
}

const handleRegister = async (request, response) => {
  rateLimit(`sync:register:${clientAddress(request)}`, 10, 60 * 60 * 1000)
  const body = await readJsonBody(request)
  const email = normalizeEmail(body.email)
  rateLimit(`sync:register-email:${sha256(email)}`, 8, 60 * 60 * 1000)
  const authKey = parseAuthKey(body.authKey)
  const kdf = parseKdf(body.kdf)
  const vaultKeyWrap = parseKeyWrap(body.vaultKeyWrap)
  const device = parseDevice(body.device)
  await serverSecret()
  await fs.mkdir(safeJoin(syncRoot(), 'emails'), { recursive: true, mode: 0o700 })
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
  // Link the new account before the e-mail index points at it. A crash must
  // not reserve the address with no account behind it.
  await syncDirectory(syncRoot())
  await syncDirectory(dirname(accountDirectory(id)))
  await syncDirectory(accountDirectory(id))
  const emailPath = emailIndexPath(email)
  const temporary = `${emailPath}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
  let emailCreated = false
  try {
    // 'wx' makes the e-mail index the uniqueness check; two racing registrations cannot both win.
    // The account record is saved first. A failed attempt removes the index
    // entry this attempt created, then its own account directory.
    await saveAccount(account)
    const emailHandle = await fs.open(temporary, 'wx', 0o600)
    try {
      await emailHandle.writeFile(id)
      await emailHandle.sync()
    } finally {
      await emailHandle.close()
    }
    // Publish the finished file under the address. A crash must not leave an
    // empty index name, or this address can no longer open the account.
    await fs.link(temporary, emailPath)
    emailCreated = true
    await fs.rm(temporary, { force: true })
    await syncDirectory(dirname(emailPath))
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => {})
    if (emailCreated) {
      await fs.rm(emailPath, { force: true })
      await syncDirectory(dirname(emailPath))
    }
    await fs.rm(accountDirectory(id), { recursive: true, force: true })
    await syncDirectory(dirname(accountDirectory(id)))
    if (error?.code === 'EEXIST') {
      const existing = await loadAccountByEmail(email)
      if (existing?.auth?.hash && existing?.auth?.salt) {
        const expected = Buffer.from(existing.auth.hash, 'base64')
        const actual = await scryptHash(authKey, Buffer.from(existing.auth.salt, 'base64'))
        if (expected.length === actual.length) safeEqual(expected, actual)
      } else {
        await scryptHash(authKey, randomBytes(16))
      }
      fail(401, 'E-Mail-Adresse oder Passwort stimmen nicht.')
    }
    throw error
  }
  await scryptHash(authKey, randomBytes(16))
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
    // The key was checked on the account from before this lock. A password
    // change can save a new hash in between. Signing that stale check in
    // would open a session for the old key.
    if (!fresh?.auth?.hash || !fresh?.auth?.salt) fail(401, 'E-Mail-Adresse oder Passwort stimmen nicht.')
    const unchanged = fresh.auth.salt === account.auth.salt && fresh.auth.hash === account.auth.hash
    if (!unchanged && !await verify(fresh)) fail(401, 'E-Mail-Adresse oder Passwort stimmen nicht.')
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
    usage: { files, bytes: table.bytes + (table.historyBytes || 0), quotaBytes: QUOTA_BYTES, maxFiles: MAX_FILES, maxFileBytes: MAX_BLOB_BYTES },
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
    const { revokeAccountAccess } = await import('./mcp-grants.mjs')
    await revokeAccountAccess(account.id)
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
    await notifyAccountDeleted(account.id)
    const { revokeAccountAccess } = await import('./mcp-grants.mjs')
    await revokeAccountAccess(account.id)
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
  const blobPath = safeJoin(accountDirectory(auth.account.id), 'blobs', fileId)
  // Open the inode while the account lock is held, then stream it after the
  // lock is released. A replace renames a new inode into place, so this
  // descriptor keeps the revision named in the headers, and Content-Length
  // is the size of that same inode. O_NOFOLLOW refuses a symlink.
  const opened = await withAccountLock(auth.account.id, async () => {
    const table = await loadTable(auth.account.id)
    const entry = table.entries.get(fileId)
    if (!entry) fail(404, 'Diese Datei gibt es im Sync nicht.')
    if (entry.deleted) return { entry, handle: null, size: 0 }
    let handle
    try {
      handle = await fs.open(blobPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
    } catch (error) {
      // The live name can be lost after the note was archived and before the
      // replacement was durable. Copy the matching archive back. A symlink
      // stays where it is and is not followed.
      if (error?.code === 'ENOENT' && await restoreLiveBlob(auth.account.id, fileId, entry)) {
        try {
          handle = await fs.open(blobPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
        } catch (openError) {
          if (openError?.code === 'ENOENT' || openError?.code === 'ELOOP') fail(404, 'Die Datei ist auf dem Server nicht mehr vorhanden.')
          throw openError
        }
      } else if (error?.code === 'ENOENT' || error?.code === 'ELOOP') {
        fail(404, 'Die Datei ist auf dem Server nicht mehr vorhanden.')
      } else {
        throw error
      }
    }
    try {
      const info = await handle.stat()
      if (!info.isFile()) fail(404, 'Die Datei ist auf dem Server nicht mehr vorhanden.')
      // The headers would name this revision's checksum. A different size is
      // not sent under that checksum. A full ciphertext is recorded first, so
      // the download names the body that is actually on disk.
      if (info.size !== (Number(entry.size) || 0)) {
        await handle.close()
        if (info.size >= EMPTY_CIPHERTEXT_BYTES) {
          const settled = await settleDivergentLiveBlob(auth.account.id, table, fileId, entry, null)
          if (settled) {
            const reopened = await fs.open(blobPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
            try {
              const again = await reopened.stat()
              if (!again.isFile() || again.size !== settled.entry.size) {
                await reopened.close()
                return { entry: settled.entry, handle: null, size: again.size, mismatch: true }
              }
              return { entry: settled.entry, handle: reopened, size: again.size }
            } catch (error) {
              await reopened.close()
              throw error
            }
          }
        }
        return { entry, handle: null, size: info.size, mismatch: true }
      }
      return { entry, handle, size: info.size }
    } catch (error) {
      await handle.close()
      throw error
    }
  })
  if (opened.entry.deleted) {
    sendEmpty(request, response, 204, { 'X-FaNotes-Revision': String(opened.entry.revision), 'X-FaNotes-Deleted': '1', ETag: `"${opened.entry.revision}"` })
    return
  }
  if (opened.mismatch) {
    sendJson(request, response, 409, {
      error: 'Die gespeicherte Datei stimmt nicht mit dieser Fassung überein.',
      entry: publicEntry(opened.entry),
      reason: 'guard',
    }, { 'X-FaNotes-Rejected': 'guard' })
    return
  }
  const { entry, handle, size } = opened
  let handedOff = false
  const closeHandle = () => {
    if (handedOff) return
    handedOff = true
    handle.close().catch(() => {})
  }
  try {
    response.writeHead(200, {
      ...baseHeaders(request),
      'Content-Type': 'application/octet-stream',
      'Content-Length': size,
      ETag: `"${entry.revision}"`,
      'X-FaNotes-Revision': String(entry.revision),
      'X-FaNotes-Meta': entry.meta,
      'X-FaNotes-Sha256': entry.sha256,
    })
    if (request.method === 'HEAD' || size === 0) {
      response.end()
      return
    }
    const stream = handle.createReadStream({ start: 0, end: size - 1 })
    handedOff = true
    stream.on('error', () => { if (!response.destroyed) response.destroy() })
    stream.pipe(response)
  } finally {
    closeHandle()
  }
}

// `reason` tells a client which 409 this is. "stale": the base is not the current
// revision, so apply `entry` (it may be older than the client's pull cursor).
// "guard": the base was current but the body was refused as empty or collapsed,
// so keep the local file beside the note instead of sending it again.
const conflict = (request, response, entry) => {
  sendJson(request, response, 409, { error: 'Die Datei wurde inzwischen von einem anderen Gerät geändert.', entry: publicEntry(entry), reason: 'stale' })
}

// The live blob stays, and the caller must not replace it. A missing row is
// reported as a tombstone so the client keeps its copy and retries.
const preservedConflict = (request, response, fileId, current) => conflict(
  request,
  response,
  current ?? { id: fileId, revision: 0, deleted: true, updatedAt: null, deviceId: null },
)

const guardRejected = (request, response, entry) => {
  sendJson(request, response, 409, { error: 'Die leere oder stark gekürzte Fassung wurde nicht über die vorhandene Notiz gelegt.', entry: publicEntry(entry), reason: 'guard' }, { 'X-FaNotes-Rejected': 'guard' })
}

// '1' / '0' are the new client. No header means an older client.
const headerFlag = (value) => (value === '1' ? true : value === '0' ? false : null)

/**
 * Empty, blank, or severely truncated ciphertext must not replace a note that
 * still has content. X-FaNotes-Clear is the only bypass. A client that claims
 * the short body still has content (`X-FaNotes-Blank: 0`) is not trusted:
 * a failed load can look like a tiny note. The previous blob stays, and the
 * response is the same 409 the client already treats as "keep the server copy".
 */
export const rejectsBlankOverwrite = (current, nextSize, blank, clear) => {
  if (clear || !current || current.deleted) return false
  const previous = Number(current.size) || 0
  if (previous <= EMPTY_CIPHERTEXT_BYTES) return false
  // The client parsed the note and found no strokes and no text.
  if (blank === true) return true
  // A zero-byte file never replaces content without an explicit clear.
  if (nextSize <= EMPTY_CIPHERTEXT_BYTES) return true
  const collapse = previous >= COLLAPSE_OLD_BYTES && (nextSize <= COLLAPSE_NEW_BYTES || nextSize * 4 < previous)
  return collapse
}

/** Byte size of the newest archived blob. A tombstone's live size is 0, so this is the content a resurrection must not shrink away. */
export const newestArchivedBytes = (files) => {
  const list = (files || []).filter((file) => file && Number.isFinite(file.revision) && Number.isFinite(file.size))
  if (!list.length) return 0
  const newestRevision = list.reduce((max, file) => Math.max(max, file.revision), 0)
  return list.filter((file) => file.revision === newestRevision).reduce((max, file) => Math.max(max, file.size), 0)
}

/**
 * Whether a PUT may become the live blob.
 * `stale`: the base revision is not current, and this body is not a real note
 * being put back over a tombstone. `guard`: the body is empty, blank, or a
 * collapse of the live note — or of the archived note a tombstone still points
 * at. Client clocks never enter this decision; only the revision and the sizes do.
 * `archivedSize` is the newest archived blob and is consulted only for a tombstone.
 */
export const evaluateSyncWrite = ({ current, base, nextSize, blank, clear, archivedSize = 0 }) => {
  const currentRevision = current ? Number(current.revision) || 0 : 0
  if (current?.deleted) {
    const protectedSize = Number(archivedSize) || 0
    // An empty or blank body must not turn a deletion back into a live note.
    if (!clear && (blank === true || nextSize <= EMPTY_CIPHERTEXT_BYTES)) return 'guard'
    if (rejectsBlankOverwrite({ deleted: false, size: protectedSize }, nextSize, blank, clear)) return 'guard'
    const recreates = base < currentRevision && nextSize > EMPTY_CIPHERTEXT_BYTES && blank !== true
    if (currentRevision !== base && !recreates) return 'stale'
    return 'accept'
  }
  if (currentRevision !== base) return 'stale'
  if (rejectsBlankOverwrite(current, nextSize, blank, clear)) return 'guard'
  return 'accept'
}

const listRevisionFiles = async (directory) => {
  let names
  try {
    names = await fs.readdir(directory)
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw error
  }
  const files = []
  for (const name of names) {
    if (!/^(?:c-)?\d+$/u.test(name)) continue
    const stat = await fs.lstat(safeJoin(directory, name)).catch(() => null)
    if (!stat?.isFile()) continue
    files.push({ name, size: stat.size, revision: Number(name.slice(name.startsWith('c-') ? 2 : 0)) })
  }
  return files
}

// A revision can have a plain name and a collapse name. A short torn copy
// must not be published while a larger sibling of that revision is still there.
const archivedRevisionFile = (files, revision) => {
  const matches = (files || []).filter((file) => file.revision === revision)
  matches.sort((left, right) => right.size - left.size || Number(left.name.startsWith('c-')) - Number(right.name.startsWith('c-')))
  return matches[0] ?? null
}

// Register creates this directory. A later write can still find it gone.
const ensureBlobDirectory = async (accountId) => {
  const blobDirectory = safeJoin(accountDirectory(accountId), 'blobs')
  const existing = await fs.lstat(blobDirectory).catch((error) => (error?.code === 'ENOENT' ? null : Promise.reject(error)))
  await fs.mkdir(blobDirectory, { recursive: true, mode: 0o700 })
  if (!existing) {
    // Link the blobs directory before a note is written into it. A crash must
    // not drop the directory that holds the live note.
    await syncDirectory(accountDirectory(accountId))
  }
  return blobDirectory
}

// The live name can disappear after this revision was copied into the archive.
// Copy that body back when its size and checksum match the table. The archive
// stays, a tombstone is not revived, and the change log is not rewritten.
const restoreLiveBlob = async (accountId, fileId, entry) => {
  if (!entry || entry.deleted) return false
  const expectedSize = Number(entry.size) || 0
  const expectedSha = entry.sha256
  if (typeof expectedSha !== 'string' || !expectedSha || expectedSize < EMPTY_CIPHERTEXT_BYTES) return false
  const blobDirectory = safeJoin(accountDirectory(accountId), 'blobs')
  const blobPath = safeJoin(blobDirectory, fileId)
  const live = await fs.lstat(blobPath).catch((error) => (error?.code === 'ENOENT' ? null : Promise.reject(error)))
  if (live) return false
  const directory = revisionsDirectory(accountId, fileId)
  const candidates = (await listRevisionFiles(directory)).filter((file) => file.size === expectedSize)
  const revision = Number(entry.revision)
  const preferred = candidates.find((file) => file.revision === revision && !file.name.startsWith('c-'))
    ?? candidates.find((file) => file.revision === revision)
  const ordered = preferred ? [preferred, ...candidates.filter((file) => file.name !== preferred.name)] : candidates
  let source = null
  for (const file of ordered) {
    const path = safeJoin(directory, file.name)
    if (await hashFile(path) === expectedSha) {
      source = path
      break
    }
  }
  if (!source) return false
  // Link the blobs directory before the archived note is copied back into it.
  await ensureBlobDirectory(accountId)
  await copyDurable(source, blobPath)
  return true
}

/** Copy the live blob aside before it is replaced. Returns the byte delta of the archive. */
const retainPreviousBlob = async (accountId, fileId, current, nextSize, move) => {
  if (!current || current.deleted) return 0
  const blobPath = safeJoin(accountDirectory(accountId), 'blobs', fileId)
  const stat = await fs.lstat(blobPath).catch((error) => (error?.code === 'ENOENT' ? null : Promise.reject(error)))
  if (!stat?.isFile()) return 0
  // Name the slot from the table's size, not the live file. After a crash the
  // live file can already be the newer body, and the archived name must stay
  // the one written on the first attempt.
  const currentSize = Number(current.size) || 0
  const collapse = currentSize >= COLLAPSE_OLD_BYTES && (nextSize <= COLLAPSE_NEW_BYTES || nextSize * 4 < currentSize)
  const directory = revisionsDirectory(accountId, fileId)
  await fs.mkdir(directory, { recursive: true, mode: 0o700 })
  // Link the new archive directory before the previous note is copied into it.
  // A crash after the live blob is replaced must not drop that directory.
  await syncDirectory(dirname(dirname(directory)))
  await syncDirectory(dirname(directory))
  const before = (await listRevisionFiles(directory)).reduce((sum, file) => sum + file.size, 0)
  const name = `${collapse ? 'c-' : ''}${current.revision}`
  const dest = safeJoin(directory, name)
  const holdsCurrent = async (path, size) => size === currentSize && await hashFile(path) === current.sha256
  // A crash can replace the live blob before the change log records it. The
  // retry still believes this revision is current, so copying the live blob
  // again would overwrite the archived copy with the newer body.
  if (move) {
    await fs.rename(blobPath, dest)
  } else {
    const existing = await fs.lstat(dest).catch((error) => (error?.code === 'ENOENT' ? null : Promise.reject(error)))
    // Copy into a temporary name and rename it. A crash must not leave a torn
    // file under the revision name, or a later restore would publish that copy.
    if (!existing) {
      await copyDurable(blobPath, dest)
    } else if (existing.isFile()) {
      if (!await holdsCurrent(dest, existing.size) && await holdsCurrent(blobPath, stat.size)) await copyDurable(blobPath, dest)
    } else if (await holdsCurrent(blobPath, stat.size)) {
      await fs.unlink(dest)
      await copyDurable(blobPath, dest)
    }
  }
  // The caller replaces the live blob after this returns. The copy has to be
  // on disk first, or a crash loses the only copy of the note. A non-file
  // left in the slot is not opened, so a symlink is not followed.
  const archivedStat = await fs.lstat(dest).catch((error) => (error?.code === 'ENOENT' ? null : Promise.reject(error)))
  if (archivedStat?.isFile()) {
    const archived = await fs.open(dest, 'r+')
    try {
      await archived.sync()
    } finally {
      await archived.close()
    }
    const directoryHandle = await fs.open(directory, 'r')
    try {
      await directoryHandle.sync()
    } finally {
      await directoryHandle.close()
    }
  }
  const files = await listRevisionFiles(directory)
  const keep = revisionNamesToKeep(files, MAX_REVISIONS_KEPT, nextSize)
  for (const file of files) {
    if (!keep.has(file.name)) await fs.rm(safeJoin(directory, file.name), { force: true })
  }
  // Dropped archive names have to be durable before historyBytes is recorded.
  // A crash that brings those files back would count them again after restart.
  await syncDirectory(directory)
  const after = (await listRevisionFiles(directory)).reduce((sum, file) => sum + file.size, 0)
  return after - before
}

// A crash can rename the live blob and stop before that directory entry is
// durable. The change log names the file only after the directory is synced.
const recordLiveBlob = async (accountId, table, entry) => {
  await syncDirectory(safeJoin(accountDirectory(accountId), 'blobs'))
  await appendChange(accountId, table, entry)
}

/** Hash of the newest archived blob for this note, or null when the archive is empty. */
const newestArchivedIdentity = async (accountId, fileId) => {
  const directory = revisionsDirectory(accountId, fileId)
  const files = await listRevisionFiles(directory)
  if (!files.length) return null
  const newestRevision = files.reduce((max, file) => Math.max(max, file.revision), 0)
  const exact = files.find((file) => file.revision === newestRevision && !file.name.startsWith('c-'))
    ?? files.find((file) => file.revision === newestRevision)
  if (!exact) return null
  return { size: exact.size, sha256: await hashFile(safeJoin(directory, exact.name)) }
}

/**
 * A crash after the live blob is replaced, and before the change log records
 * it, leaves a newer body in the live slot. Copying that slot onto the archive
 * name of the old revision, or replacing it, would drop the only copy.
 * The bytes are already on disk, so this records them and does not copy them.
 * Returns null when the live file matches the table entry. A tombstone whose
 * live file still matches the archived delete is a duplicate of that delete,
 * not a new note. Only the idempotent delete removes the duplicate.
 * A full ciphertext with no logged row is recorded only when this request's
 * bytes and metadata are that file; anything else is left in place.
 */
const settleDivergentLiveBlob = async (accountId, table, fileId, current, incoming) => {
  const blobPath = safeJoin(accountDirectory(accountId), 'blobs', fileId)
  const stat = await fs.lstat(blobPath).catch((error) => (error?.code === 'ENOENT' ? null : Promise.reject(error)))
  if (!stat?.isFile()) return null
  if (!current || current.deleted) {
    // A short remnant is not a ciphertext. A logged delete can also leave the
    // archived body in the live slot; publishing that would undo the delete.
    if (stat.size < EMPTY_CIPHERTEXT_BYTES) return null
    const liveSha = await hashFile(blobPath)
    if (current?.deleted) {
      const archived = await newestArchivedIdentity(accountId, fileId)
      // Same bytes as the archived delete. Callers must not publish them, and
      // only the idempotent delete may remove this copy.
      if (archived && archived.size === stat.size && archived.sha256 === liveSha) return { duplicate: true }
    }
    const matchesRequest = Boolean(incoming)
      && incoming.size === stat.size
      && incoming.sha256 === liveSha
      && typeof incoming.meta === 'string'
      && incoming.meta
    // The previous meta describes the deleted note, not these bytes. Keep the
    // file until a request that actually wrote it arrives with its own meta.
    if (!matchesRequest) return { preserved: true }
    const entry = {
      id: fileId,
      revision: table.revision + 1,
      deleted: false,
      size: stat.size,
      sha256: liveSha,
      meta: incoming.meta,
      updatedAt: nowIso(),
      deviceId: incoming.deviceId,
    }
    table.revision = entry.revision
    table.entries.set(fileId, entry)
    table.bytes += stat.size
    await recordLiveBlob(accountId, table, entry)
    return { matchesRequest: true, entry }
  }
  const currentSize = Number(current.size) || 0
  const liveSha = await hashFile(blobPath)
  if (stat.size === currentSize && liveSha === current.sha256) return null
  const matchesRequest = Boolean(incoming) && incoming.size === stat.size && incoming.sha256 === liveSha
  const entry = {
    id: fileId,
    revision: table.revision + 1,
    deleted: false,
    size: stat.size,
    sha256: liveSha,
    meta: matchesRequest ? incoming.meta : current.meta,
    updatedAt: nowIso(),
    deviceId: matchesRequest ? incoming.deviceId : current.deviceId,
  }
  table.revision = entry.revision
  table.entries.set(fileId, entry)
  table.bytes += stat.size - currentSize
  await recordLiveBlob(accountId, table, entry)
  return { matchesRequest, entry }
}

// True when the live file is already the body this request would write.
// Replacing that inode can drop the only copy: a same-byte update does not
// archive the note first. A missing file, a symlink, or a different body is
// not a match, so those still go through the normal write.
const liveBlobMatches = async (accountId, fileId, current, size, sha) => {
  if (!current || current.deleted || current.sha256 !== sha || (Number(current.size) || 0) !== size) return false
  const info = await fs.lstat(safeJoin(accountDirectory(accountId), 'blobs', fileId)).catch((error) => (error?.code === 'ENOENT' ? null : Promise.reject(error)))
  return Boolean(info?.isFile() && info.size === size)
}

const handlePutFile = async (request, response, auth, fileId) => {
  const base = parseIfMatch(request)
  const meta = parseMeta(request)
  const declaredSha = request.headers['x-fanotes-sha256']
  if (typeof declaredSha !== 'string' || !FILE_ID_PATTERN.test(declaredSha)) fail(400, 'Die Prüfsumme der Datei fehlt.')
  const incoming = await spoolUpload(safeJoin(accountDirectory(auth.account.id), 'incoming'), request, MAX_BLOB_BYTES)
  let committed = false
  try {
    if (incoming.size < 28) fail(400, 'Der verschlüsselte Inhalt ist zu kurz.')
    if (incoming.sha256 !== declaredSha) fail(400, 'Die Datei kam beschädigt an. Bitte erneut versuchen.')
    const blank = headerFlag(request.headers['x-fanotes-blank'])
    const clear = request.headers['x-fanotes-clear'] === '1'
    await withAccountLock(auth.account.id, async () => {
    const table = await loadTable(auth.account.id)
    const current = table.entries.get(fileId)
    const settled = await settleDivergentLiveBlob(auth.account.id, table, fileId, current, {
      size: incoming.size,
      sha256: declaredSha,
      meta,
      deviceId: auth.deviceId,
    })
    if (settled?.matchesRequest) {
      sendJson(request, response, 200, { revision: settled.entry.revision, tableRevision: table.revision }, { ETag: `"${settled.entry.revision}"` })
      return
    }
    if (settled?.entry) return conflict(request, response, settled.entry)
    if (settled?.preserved) return preservedConflict(request, response, fileId, current)
    // A tombstone's live size is zero. The blob that was deleted is the newest
    // file in the revision archive; a short or empty upload must not become the
    // live note in its place. A device that still has the note puts that copy
    // back from any older base. Client clocks are not part of the decision.
    const archivedSize = current?.deleted
      ? newestArchivedBytes(await listRevisionFiles(revisionsDirectory(auth.account.id, fileId)))
      : 0
    const decision = evaluateSyncWrite({ current: current ?? null, base, nextSize: incoming.size, blank, clear, archivedSize })
    if (decision === 'stale') return conflict(request, response, current ?? { id: fileId, revision: 0, deleted: true, updatedAt: null, deviceId: null })
    if (decision === 'guard') {
      committed = await moveToQuarantine(auth.account.id, fileId, base, incoming.path)
      return guardRejected(request, response, current)
    }
    const previousBytes = current && !current.deleted ? Number(current.size) || 0 : 0
    const historyDelta = current && !current.deleted && (current.sha256 !== declaredSha) ? (Number(current.size) || 0) : 0
    // Partials already reserved their declared size. A direct PUT must not
    // spend that space a second time.
    const reserved = await reservedPartialBytes(auth.account.id)
    if (table.bytes - previousBytes + incoming.size + (table.historyBytes || 0) + historyDelta + reserved > QUOTA_BYTES) fail(507, 'Der Speicherplatz dieses Kontos ist voll.')
    const liveFiles = [...table.entries.values()].filter((entry) => !entry.deleted).length
    if ((!current || current.deleted) && liveFiles >= MAX_FILES) fail(507, 'Dieses Konto hat die maximale Anzahl an Dateien erreicht.')
    if (current && !current.deleted && current.sha256 !== declaredSha) {
      table.historyBytes = (table.historyBytes || 0) + await retainPreviousBlob(auth.account.id, fileId, current, incoming.size, false)
    }
    const blobDirectory = safeJoin(accountDirectory(auth.account.id), 'blobs')
    const blobPath = safeJoin(blobDirectory, fileId)
    if (await liveBlobMatches(auth.account.id, fileId, current, incoming.size, declaredSha)) {
      // The live file is already this body. Leave that inode in place and
      // drop the spool. The new revision still records a metadata change.
      await fs.rm(incoming.path, { force: true })
      await syncDirectory(dirname(incoming.path))
    } else {
      await ensureBlobDirectory(auth.account.id)
      await fs.rename(incoming.path, blobPath)
      // The new name has to be durable before the change log records it.
      await syncDirectory(blobDirectory)
      // The old spool name has to be gone too. A crash must not bring it back
      // as a second link to this note.
      await syncDirectory(dirname(incoming.path))
    }
    committed = true
    const entry = { id: fileId, revision: table.revision + 1, deleted: false, size: incoming.size, sha256: declaredSha, meta, updatedAt: nowIso(), deviceId: auth.deviceId }
    table.revision = entry.revision
    table.entries.set(fileId, entry)
    table.bytes += incoming.size - previousBytes
    await appendChange(auth.account.id, table, entry)
    sendJson(request, response, 200, { revision: entry.revision, tableRevision: table.revision }, { ETag: `"${entry.revision}"` })
  })
  } finally {
    if (!committed) {
      await fs.rm(incoming.path, { force: true })
      // The spool was not stored as the note. Dropping the name has to be
      // durable, or a crash brings that file back.
      await syncDirectory(dirname(incoming.path))
    }
  }
}

/** Move a rejected spool aside. The live blob is never replaced. Returns false when the copy could not be kept. */
const moveToQuarantine = async (accountId, fileId, base, sourcePath) => {
  try {
    const directory = safeJoin(accountDirectory(accountId), 'quarantine', fileId)
    const existing = await fs.lstat(directory).catch((error) => (error?.code === 'ENOENT' ? null : Promise.reject(error)))
    await fs.mkdir(directory, { recursive: true, mode: 0o700 })
    if (!existing) {
      // Link the quarantine directory before the rejected body is renamed into
      // it. A crash must not drop the only server copy of that upload.
      await syncDirectory(dirname(dirname(directory)))
      await syncDirectory(dirname(directory))
    }
    await fs.rename(sourcePath, safeJoin(directory, String(base)))
    await syncDirectory(directory)
    await syncDirectory(dirname(sourcePath))
    const names = (await fs.readdir(directory)).filter((name) => /^\d+$/u.test(name)).sort((left, right) => Number(left) - Number(right))
    for (const name of names.slice(0, Math.max(0, names.length - MAX_REVISIONS_KEPT))) {
      await fs.rm(safeJoin(directory, name), { force: true })
    }
    // Dropped quarantine names have to be durable. A crash must not bring an
    // older rejected body back under this note.
    await syncDirectory(directory)
    return true
  } catch (error) {
    if (error instanceof SyncApiError) throw error
    return false
  }
}

const metaForRestore = async (accountId, fileId, current) => {
  // Compaction drops the log. The table row has to keep the meta, including
  // on a tombstone, or the archived note can no longer be restored.
  if (typeof current?.meta === 'string' && current.meta) return current.meta
  let text = ''
  try {
    text = await fs.readFile(safeJoin(accountDirectory(accountId), 'changes.jsonl'), 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
  const lines = text.split('\n')
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (!lines[index]) continue
    try {
      const entry = JSON.parse(lines[index])
      if (entry.id === fileId && !entry.deleted && typeof entry.meta === 'string' && entry.meta) return entry.meta
    } catch {
      // A damaged history line cannot name the file. Keep looking.
    }
  }
  return null
}

const handleListRevisions = async (request, response, auth, fileId) => {
  const directory = revisionsDirectory(auth.account.id, fileId)
  const files = await listRevisionFiles(directory)
  sendJson(request, response, 200, {
    revisions: files
      .sort((left, right) => left.revision - right.revision)
      .map((file) => ({ revision: file.revision, size: file.size, collapse: file.name.startsWith('c-') })),
  })
}

const handleRestoreFile = async (request, response, auth, fileId) => {
  const base = parseIfMatch(request)
  const payload = await readJsonBody(request)
  const archivedRevision = Number(payload.revision)
  if (!Number.isInteger(archivedRevision) || archivedRevision < 0) fail(400, 'Diese Fassung liegt nicht im Archiv.')
  await withAccountLock(auth.account.id, async () => {
    const table = await loadTable(auth.account.id)
    const current = table.entries.get(fileId)
    const currentRevision = current ? current.revision : 0
    if (currentRevision !== base) return conflict(request, response, current ?? { id: fileId, revision: 0, deleted: true, updatedAt: null, deviceId: null })
    const directory = revisionsDirectory(auth.account.id, fileId)
    const archived = archivedRevisionFile(await listRevisionFiles(directory), archivedRevision)
    if (!archived) fail(404, 'Diese Fassung liegt nicht im Archiv.')
    const source = safeJoin(directory, archived.name)
    const info = await fs.lstat(source).catch(() => null)
    if (!info?.isFile()) fail(404, 'Diese Fassung liegt nicht im Archiv.')
    if (info.size > MAX_BLOB_BYTES) fail(413, 'Die Datei ist zu groß für den Sync.')
    if (info.size < 28) fail(400, 'Der verschlüsselte Inhalt ist zu kurz.')
    const digest = await hashFile(source)
    const meta = await metaForRestore(auth.account.id, fileId, current)
    if (!meta) fail(404, 'Diese Fassung liegt nicht im Archiv.')
    const settled = await settleDivergentLiveBlob(auth.account.id, table, fileId, current, {
      size: info.size,
      sha256: digest,
      meta,
      deviceId: auth.deviceId,
    })
    if (settled?.matchesRequest) {
      sendJson(request, response, 200, { revision: settled.entry.revision, tableRevision: table.revision, size: info.size }, { ETag: `"${settled.entry.revision}"` })
      return
    }
    if (settled?.entry) return conflict(request, response, settled.entry)
    if (settled?.preserved) return preservedConflict(request, response, fileId, current)
    const previousBytes = current && !current.deleted ? Number(current.size) || 0 : 0
    const replaces = Boolean(current && !current.deleted && current.sha256 !== digest)
    const historyDelta = replaces ? previousBytes : 0
    const reserved = await reservedPartialBytes(auth.account.id)
    if (table.bytes - previousBytes + info.size + (table.historyBytes || 0) + historyDelta + reserved > QUOTA_BYTES) fail(507, 'Der Speicherplatz dieses Kontos ist voll.')
    const liveFiles = [...table.entries.values()].filter((entry) => !entry.deleted).length
    if ((!current || current.deleted) && liveFiles >= MAX_FILES) fail(507, 'Dieses Konto hat die maximale Anzahl an Dateien erreicht.')
    if (replaces) {
      table.historyBytes = (table.historyBytes || 0) + await retainPreviousBlob(auth.account.id, fileId, current, info.size, false)
    }
    await ensureBlobDirectory(auth.account.id)
    await copyDurable(source, safeJoin(accountDirectory(auth.account.id), 'blobs', fileId))
    const entry = { id: fileId, revision: table.revision + 1, deleted: false, size: info.size, sha256: digest, meta, updatedAt: nowIso(), deviceId: auth.deviceId }
    table.revision = entry.revision
    table.entries.set(fileId, entry)
    table.bytes += info.size - previousBytes
    await appendChange(auth.account.id, table, entry)
    sendJson(request, response, 200, { revision: entry.revision, tableRevision: table.revision, size: info.size }, { ETag: `"${entry.revision}"` })
  })
}

const handleDeleteFile = async (request, response, auth, fileId) => {
  if (request.headers['x-fanotes-delete'] !== '1') fail(428, 'Eine Löschung braucht eine ausdrückliche Bestätigung.')
  const base = parseIfMatch(request)
  await withAccountLock(auth.account.id, async () => {
    const table = await loadTable(auth.account.id)
    const current = table.entries.get(fileId)
    const currentRevision = current ? current.revision : 0
    if (currentRevision !== base) return conflict(request, response, current ?? { id: fileId, revision: 0, deleted: true, updatedAt: null, deviceId: null })
    if (!current || current.deleted) {
      // A resurrection can be renamed into place before its log line. Leave
      // that body where it is, and do not report the delete as already done.
      const settled = await settleDivergentLiveBlob(auth.account.id, table, fileId, current ?? null, null)
      if (settled?.entry) return conflict(request, response, settled.entry)
      if (settled?.preserved) {
        sendJson(request, response, 409, {
          error: 'Die gespeicherte Datei gehört zu einer neueren Fassung und wurde nicht gelöscht.',
          entry: publicEntry(current ?? { id: fileId, revision: 0, deleted: true, updatedAt: null, deviceId: null }),
          reason: 'guard',
        }, { 'X-FaNotes-Rejected': 'guard' })
        return
      }
      // The archive was synced before the tombstone. Removing this duplicate
      // finishes that delete. A different body is left in place above.
      if (settled?.duplicate) {
        const blobPath = safeJoin(accountDirectory(auth.account.id), 'blobs', fileId)
        const info = await fs.lstat(blobPath).catch((error) => (error?.code === 'ENOENT' ? null : Promise.reject(error)))
        if (info?.isFile()) {
          await fs.rm(blobPath)
          await syncDirectory(safeJoin(accountDirectory(auth.account.id), 'blobs'))
        }
      }
      sendJson(request, response, 200, { revision: currentRevision, tableRevision: table.revision })
      return
    }
    // A crash can leave a newer body in the live slot before the change log
    // records it. Deleting that file would drop the only copy of the newer note.
    const blobPath = safeJoin(accountDirectory(auth.account.id), 'blobs', fileId)
    const liveStat = await fs.lstat(blobPath).catch((error) => (error?.code === 'ENOENT' ? null : Promise.reject(error)))
    const currentSize = Number(current.size) || 0
    if (liveStat?.isFile() && (liveStat.size !== currentSize || await hashFile(blobPath) !== current.sha256)) {
      // A full ciphertext is the newer note. Record it and leave it in place.
      // A shorter remnant is not published and is not deleted.
      if (liveStat.size >= EMPTY_CIPHERTEXT_BYTES) {
        const settled = await settleDivergentLiveBlob(auth.account.id, table, fileId, current, null)
        if (settled) return conflict(request, response, settled.entry)
      }
      sendJson(request, response, 409, {
        error: 'Die gespeicherte Datei gehört zu einer neueren Fassung und wurde nicht gelöscht.',
        entry: publicEntry(current),
        reason: 'guard',
      }, { 'X-FaNotes-Rejected': 'guard' })
      return
    }
    // Copy first. The live blob is removed only after the tombstone is durable,
    // so a crash leaves the note in the archive and still in the live slot.
    table.historyBytes = (table.historyBytes || 0) + await retainPreviousBlob(auth.account.id, fileId, current, 0, false)
    const entry = { id: fileId, revision: table.revision + 1, deleted: true, size: 0, sha256: null, meta: typeof current.meta === 'string' && current.meta ? current.meta : null, updatedAt: nowIso(), deviceId: auth.deviceId }
    table.revision = entry.revision
    table.entries.set(fileId, entry)
    table.bytes -= Number(current.size) || 0
    await appendChange(auth.account.id, table, entry)
    await fs.rm(blobPath, { force: true })
    await syncDirectory(safeJoin(accountDirectory(auth.account.id), 'blobs'))
    sendJson(request, response, 200, { revision: entry.revision, tableRevision: table.revision })
  })
}

const UPLOAD_ID_PATTERN = /^[a-f0-9]{32}$/u
const MAX_PARTIALS = 32

const partialDirectory = (accountId, uploadId) => safeJoin(accountDirectory(accountId), 'partials', uploadId)

// Drop a resumable upload and make that removal durable before the caller
// logs a revision or answers the client. A crash must not bring the partial
// back and reserve its bytes again.
const removePartial = async (accountId, uploadId) => {
  await fs.rm(partialDirectory(accountId, uploadId), { recursive: true, force: true })
  await syncDirectory(safeJoin(accountDirectory(accountId), 'partials'))
}

const readPartial = async (accountId, uploadId) => readJsonFile(safeJoin(partialDirectory(accountId, uploadId), 'meta.json'))

const writePartial = async (accountId, uploadId, meta) => {
  const directory = partialDirectory(accountId, uploadId)
  const existing = await fs.lstat(directory).catch((error) => (error?.code === 'ENOENT' ? null : Promise.reject(error)))
  await fs.mkdir(directory, { recursive: true, mode: 0o700 })
  if (!existing) {
    // Link the new upload directory before its metadata is written. A crash
    // must not drop a resumable upload the client will retry by id.
    await syncDirectory(dirname(dirname(directory)))
    await syncDirectory(dirname(directory))
  }
  await atomicWrite(safeJoin(directory, 'meta.json'), `${JSON.stringify(meta)}\n`)
}

const listPartialMetas = async (accountId) => {
  const root = safeJoin(accountDirectory(accountId), 'partials')
  let names
  try {
    names = await fs.readdir(root)
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw error
  }
  const metas = []
  for (const uploadId of names) {
    if (!UPLOAD_ID_PATTERN.test(uploadId)) continue
    const meta = await readPartial(accountId, uploadId)
    if (meta && meta.fileId) metas.push({ uploadId, ...meta })
  }
  return metas
}

const reservedPartialBytes = async (accountId, exceptUploadId = '') => {
  const metas = await listPartialMetas(accountId)
  return metas.reduce((sum, meta) => sum + (meta.uploadId === exceptUploadId ? 0 : (Number(meta.size) || 0)), 0)
}

const copyOnto = async (destination, source, start) => {
  // 'r+' does not create the file. A missing body.bin (a crashed create) is
  // opened with 'wx' so the next patch can still resume. Append mode would
  // ignore the write position.
  let output
  let created = false
  try {
    output = await fs.open(destination, 'r+')
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
    output = await fs.open(destination, 'wx', 0o600)
    created = true
  }
  const input = await fs.open(source, 'r')
  const buffer = Buffer.alloc(64 * 1024)
  try {
    await output.truncate(start)
    let position = start
    let readAt = 0
    while (true) {
      const { bytesRead } = await input.read(buffer, 0, buffer.length, readAt)
      if (!bytesRead) break
      let written = 0
      while (written < bytesRead) {
        const result = await output.write(buffer, written, bytesRead - written, position + written)
        if (!result.bytesWritten) fail(400, 'Die Datei kam unvollständig an.')
        written += result.bytesWritten
      }
      position += bytesRead
      readAt += bytesRead
    }
    await output.sync()
    // A recreated body.bin has to be linked before the client is told the
    // bytes were stored. The original create already synced this directory.
    if (created) await syncDirectory(dirname(destination))
  } finally {
    await input.close()
    await output.close()
  }
}

const publicUpload = (uploadId, meta) => ({
  uploadId,
  fileId: meta.fileId,
  offset: Number(meta.received) || 0,
  size: Number(meta.size) || 0,
})

const handleIntegrity = async (request, response, auth) => {
  const report = await inspectSyncAccount(syncRoot(), auth.account.id)
  sendJson(request, response, 200, report)
}

const handleCreateUpload = async (request, response, auth, fileId) => {
  const base = parseIfMatch(request)
  const metaHeader = parseMeta(request)
  const declaredSha = request.headers['x-fanotes-sha256']
  if (typeof declaredSha !== 'string' || !FILE_ID_PATTERN.test(declaredSha)) fail(400, 'Die Prüfsumme der Datei fehlt.')
  const payload = await readJsonBody(request)
  const size = Number(payload.size)
  if (!Number.isInteger(size) || size < 28) fail(400, 'Der verschlüsselte Inhalt ist zu kurz.')
  if (size > MAX_BLOB_BYTES) fail(413, 'Die Datei ist zu groß für den Sync.')
  const blank = headerFlag(request.headers['x-fanotes-blank'])
  const clear = request.headers['x-fanotes-clear'] === '1'
  await withAccountLock(auth.account.id, async () => {
    const table = await loadTable(auth.account.id)
    const existing = await listPartialMetas(auth.account.id)
    if (existing.length >= MAX_PARTIALS) fail(507, 'Dieses Konto hat die maximale Anzahl an Dateien erreicht.')
    const reserved = existing.reduce((sum, meta) => sum + (Number(meta.size) || 0), 0)
    if (table.bytes + (table.historyBytes || 0) + reserved + size > QUOTA_BYTES) fail(507, 'Der Speicherplatz dieses Kontos ist voll.')
    const uploadId = randomBytes(16).toString('hex')
    const meta = {
      fileId,
      size,
      sha256: declaredSha,
      base,
      blank,
      clear,
      meta: metaHeader,
      received: 0,
      deviceId: auth.deviceId,
      createdAt: nowIso(),
    }
    await writePartial(auth.account.id, uploadId, meta)
    await atomicWrite(safeJoin(partialDirectory(auth.account.id, uploadId), 'body.bin'), Buffer.alloc(0))
    sendJson(request, response, 201, publicUpload(uploadId, meta))
  })
}

const handleUploadStatus = async (request, response, auth, fileId, uploadId) => {
  const meta = await readPartial(auth.account.id, uploadId)
  if (!meta || meta.fileId !== fileId) fail(404, 'Dieser Upload ist nicht bekannt.')
  sendJson(request, response, 200, publicUpload(uploadId, meta))
}

// Drops only the partial. The live note and the revision archive stay.
const handleUploadAbort = async (request, response, auth, fileId, uploadId) => {
  await withAccountLock(auth.account.id, async () => {
    const meta = await readPartial(auth.account.id, uploadId)
    if (!meta || meta.fileId !== fileId) fail(404, 'Dieser Upload ist nicht bekannt.')
    await removePartial(auth.account.id, uploadId)
    sendEmpty(request, response, 204)
  })
}

const handleUploadPatch = async (request, response, auth, fileId, uploadId) => {
  const offsetHeader = request.headers['upload-offset']
  const offset = Number(offsetHeader)
  if (!Number.isInteger(offset) || offset < 0) fail(400, 'Der Upload setzt an der falschen Stelle fort.')
  const patch = await spoolUpload(safeJoin(accountDirectory(auth.account.id), 'incoming'), request, MAX_BLOB_BYTES)
  try {
    await withAccountLock(auth.account.id, async () => {
      const meta = await readPartial(auth.account.id, uploadId)
      if (!meta || meta.fileId !== fileId) fail(404, 'Dieser Upload ist nicht bekannt.')
      if (offset !== meta.received) {
        fail(409, 'Der Upload setzt an der falschen Stelle fort.', { offset: meta.received, size: meta.size, reason: 'offset' })
      }
      if (meta.received + patch.size > meta.size) fail(400, 'Die Datei ist zu groß für den Sync.')
      const bodyPath = safeJoin(partialDirectory(auth.account.id, uploadId), 'body.bin')
      await copyOnto(bodyPath, patch.path, meta.received)
      meta.received += patch.size
      await writePartial(auth.account.id, uploadId, meta)
      sendJson(request, response, 200, publicUpload(uploadId, meta), { 'Upload-Offset': String(meta.received) })
    })
  } finally {
    await fs.rm(patch.path, { force: true })
    // The patch spool was copied onto the partial. Dropping its name has to
    // be durable, or a crash brings that file back.
    await syncDirectory(dirname(patch.path))
  }
}

// The partial is already gone and the live blob is the uploaded body. Record
// the revision without copying that body onto the archive slot.
const finishRenamedUpload = async (request, response, auth, fileId, uploadId, base, metaHeader, declaredSha, blank, clear) => {
  const table = await loadTable(auth.account.id)
  const current = table.entries.get(fileId) ?? null
  const blobPath = safeJoin(accountDirectory(auth.account.id), 'blobs', fileId)
  const stat = await fs.lstat(blobPath).catch((error) => (error?.code === 'ENOENT' ? null : Promise.reject(error)))
  if (!stat?.isFile()) fail(404, 'Dieser Upload ist nicht bekannt.')
  if (await hashFile(blobPath) !== declaredSha) fail(404, 'Dieser Upload ist nicht bekannt.')
  const archivedSize = current?.deleted
    ? newestArchivedBytes(await listRevisionFiles(revisionsDirectory(auth.account.id, fileId)))
    : 0
  const decision = evaluateSyncWrite({ current, base, nextSize: stat.size, blank, clear, archivedSize })
  if (decision === 'stale') return conflict(request, response, current ?? { id: fileId, revision: 0, deleted: true, updatedAt: null, deviceId: null })
  if (decision === 'guard') return guardRejected(request, response, current)
  if (current && !current.deleted && current.sha256 === declaredSha && Number(current.size) === stat.size) {
    // Same bytes are already the live note. A repeated complete keeps this
    // revision. New metadata still has to be stored: the rename can finish
    // before the log, and replacing this inode is not archived first.
    if (current.meta !== metaHeader) {
      const reserved = await reservedPartialBytes(auth.account.id)
      if (table.bytes + (table.historyBytes || 0) + reserved > QUOTA_BYTES) fail(507, 'Der Speicherplatz dieses Kontos ist voll.')
      const entry = { id: fileId, revision: table.revision + 1, deleted: false, size: stat.size, sha256: declaredSha, meta: metaHeader, updatedAt: nowIso(), deviceId: auth.deviceId }
      table.revision = entry.revision
      table.entries.set(fileId, entry)
      await recordLiveBlob(auth.account.id, table, entry)
      sendJson(request, response, 200, { revision: entry.revision, tableRevision: table.revision, uploadId }, { ETag: `"${entry.revision}"` })
      return
    }
    sendJson(request, response, 200, { revision: current.revision, tableRevision: table.revision, uploadId }, { ETag: `"${current.revision}"` })
    return
  }
  const previousBytes = current && !current.deleted ? Number(current.size) || 0 : 0
  // The archive copy was counted when the table was loaded. Adding it again
  // would reserve the previous note twice.
  const reserved = await reservedPartialBytes(auth.account.id)
  if (table.bytes - previousBytes + stat.size + (table.historyBytes || 0) + reserved > QUOTA_BYTES) fail(507, 'Der Speicherplatz dieses Kontos ist voll.')
  const liveFiles = [...table.entries.values()].filter((entry) => !entry.deleted).length
  if ((!current || current.deleted) && liveFiles >= MAX_FILES) fail(507, 'Dieses Konto hat die maximale Anzahl an Dateien erreicht.')
  const entry = { id: fileId, revision: table.revision + 1, deleted: false, size: stat.size, sha256: declaredSha, meta: metaHeader, updatedAt: nowIso(), deviceId: auth.deviceId }
  table.revision = entry.revision
  table.entries.set(fileId, entry)
  table.bytes += stat.size - previousBytes
  await recordLiveBlob(auth.account.id, table, entry)
  sendJson(request, response, 200, { revision: entry.revision, tableRevision: table.revision, uploadId }, { ETag: `"${entry.revision}"` })
}

const handleUploadComplete = async (request, response, auth, fileId, uploadId) => {
  const base = parseIfMatch(request)
  const metaHeader = parseMeta(request)
  const declaredSha = request.headers['x-fanotes-sha256']
  if (typeof declaredSha !== 'string' || !FILE_ID_PATTERN.test(declaredSha)) fail(400, 'Die Prüfsumme der Datei fehlt.')
  const blank = headerFlag(request.headers['x-fanotes-blank'])
  const clear = request.headers['x-fanotes-clear'] === '1'
  await withAccountLock(auth.account.id, async () => {
    const meta = await readPartial(auth.account.id, uploadId)
    if (!meta || meta.fileId !== fileId) {
      await finishRenamedUpload(request, response, auth, fileId, uploadId, base, metaHeader, declaredSha, blank, clear)
      return
    }
    if (meta.received !== meta.size) fail(409, 'Der Upload ist noch nicht vollständig.', { offset: meta.received, size: meta.size, reason: 'incomplete' })
    if (declaredSha !== meta.sha256) fail(400, 'Die Datei kam beschädigt an. Bitte erneut versuchen.')
    const bodyPath = safeJoin(partialDirectory(auth.account.id, uploadId), 'body.bin')
    const bodyStat = await fs.lstat(bodyPath).catch((error) => (error?.code === 'ENOENT' ? null : Promise.reject(error)))
    if (!bodyStat?.isFile()) {
      // The body was already renamed onto the live blob. Drop the partial
      // before the response so a retry cannot reserve its bytes again, then
      // record the revision from the live file.
      await removePartial(auth.account.id, uploadId)
      await finishRenamedUpload(request, response, auth, fileId, uploadId, base, metaHeader, declaredSha, blank, clear)
      return
    }
    const actual = await hashFile(bodyPath)
    if (actual !== declaredSha) fail(400, 'Die Datei kam beschädigt an. Bitte erneut versuchen.')
    const table = await loadTable(auth.account.id)
    const current = table.entries.get(fileId)
    const settled = await settleDivergentLiveBlob(auth.account.id, table, fileId, current, {
      size: Number(meta.size) || 0,
      sha256: declaredSha,
      meta: metaHeader,
      deviceId: auth.deviceId,
    })
    if (settled?.matchesRequest) {
      await removePartial(auth.account.id, uploadId)
      sendJson(request, response, 200, { revision: settled.entry.revision, tableRevision: table.revision, uploadId }, { ETag: `"${settled.entry.revision}"` })
      return
    }
    if (settled?.entry) return conflict(request, response, settled.entry)
    if (settled?.preserved) return preservedConflict(request, response, fileId, current)
    const archivedSize = current?.deleted
      ? newestArchivedBytes(await listRevisionFiles(revisionsDirectory(auth.account.id, fileId)))
      : 0
    const decision = evaluateSyncWrite({ current: current ?? null, base, nextSize: meta.size, blank, clear, archivedSize })
    if (decision === 'stale') return conflict(request, response, current ?? { id: fileId, revision: 0, deleted: true, updatedAt: null, deviceId: null })
    if (decision === 'guard') {
      // The live blob stays. Drop the partial only after the rejected body is
      // in quarantine, so a failed move can be retried.
      const kept = await moveToQuarantine(auth.account.id, fileId, base, bodyPath)
      if (kept) await removePartial(auth.account.id, uploadId)
      return guardRejected(request, response, current)
    }
    const previousBytes = current && !current.deleted ? Number(current.size) || 0 : 0
    const historyDelta = current && !current.deleted && current.sha256 !== declaredSha ? (Number(current.size) || 0) : 0
    const reserved = await reservedPartialBytes(auth.account.id, uploadId)
    if (table.bytes - previousBytes + meta.size + (table.historyBytes || 0) + historyDelta + reserved > QUOTA_BYTES) fail(507, 'Der Speicherplatz dieses Kontos ist voll.')
    const liveFiles = [...table.entries.values()].filter((entry) => !entry.deleted).length
    if ((!current || current.deleted) && liveFiles >= MAX_FILES) fail(507, 'Dieses Konto hat die maximale Anzahl an Dateien erreicht.')
    if (current && !current.deleted && current.sha256 !== declaredSha) {
      table.historyBytes = (table.historyBytes || 0) + await retainPreviousBlob(auth.account.id, fileId, current, meta.size, false)
    }
    const blobDirectory = safeJoin(accountDirectory(auth.account.id), 'blobs')
    const blobPath = safeJoin(blobDirectory, fileId)
    if (!await liveBlobMatches(auth.account.id, fileId, current, Number(meta.size) || 0, declaredSha)) {
      await ensureBlobDirectory(auth.account.id)
      await fs.rename(bodyPath, blobPath)
      await syncDirectory(blobDirectory)
      // The partial name has to be gone too. A crash must not bring that file
      // back as a second link to this note.
      await syncDirectory(dirname(bodyPath))
    }
    await removePartial(auth.account.id, uploadId)
    const entry = { id: fileId, revision: table.revision + 1, deleted: false, size: meta.size, sha256: declaredSha, meta: metaHeader, updatedAt: nowIso(), deviceId: auth.deviceId }
    table.revision = entry.revision
    table.entries.set(fileId, entry)
    table.bytes += meta.size - previousBytes
    await appendChange(auth.account.id, table, entry)
    sendJson(request, response, 200, { revision: entry.revision, tableRevision: table.revision, uploadId }, { ETag: `"${entry.revision}"` })
  })
}

// ── Router ──────────────────────────────────────────────────────────────────

export const authenticateSyncRequest = (request) => authenticate(request)

export const loadSyncAccountByEmail = async (email) => {
  try {
    return await loadAccountByEmail(normalizeEmail(email))
  } catch {
    return null
  }
}

/** True when `authKey` is the account's current authentication key. Never throws. */
/** Re-read the account under its lock and run `task` only if `authKey` is still current. */
export const withVerifiedSyncAuth = async (accountId, authKey, task) => withAccountLock(accountId, async () => {
  const account = await loadAccountById(accountId)
  if (!account || !await accountAcceptsAuthKey(account, authKey)) return { ok: false }
  return { ok: true, value: await task(account) }
})

/** The /prelogin answer for an e-mail (a stable fake one for unknown addresses), or null when the address is invalid. */
export const syncPreloginKdf = async (email) => {
  let normalized
  try { normalized = normalizeEmail(email) } catch { return null }
  return preloginKdf(normalized)
}

/**
 * A fingerprint of the account's current authentication key, or '' when the account is gone.
 * Sessions outside the sync API (the Kanti+ web app) keep it and end when it changes, the same way
 * a password change signs every other sync session out.
 */
export const syncAuthStamp = async (accountId) => {
  const account = await loadAccountById(String(accountId || ''))
  if (!account?.auth?.hash) return ''
  return sha256(`kanti-web:${account.auth.salt}:${account.auth.hash}`)
}

export const accountAcceptsAuthKey = async (account, authKey) => {
  let key
  try { key = parseAuthKey(authKey) } catch { return false }
  if (!account?.auth?.hash || !account?.auth?.salt) return false
  try {
    const expected = Buffer.from(account.auth.hash, 'base64')
    const actual = await scryptHash(key, Buffer.from(account.auth.salt, 'base64'))
    if (expected.length !== actual.length) return false
    return safeEqual(expected, actual)
  } catch {
    return false
  }
}

const REQUEST_ID_PATTERN = /^[A-Za-z0-9._-]{8,64}$/u
const SAFE_ERROR_CODE = /^[A-Z][A-Z0-9_]{0,40}$/u
const SAFE_METHOD = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'])

/** Path only, with file, upload, and device ids replaced. No query string. */
export const syncRouteTemplate = (route) => {
  const path = String(route || '/').split('?')[0].split('#')[0]
  const templated = path
    .replace(/[a-f0-9]{64}/giu, ':id')
    .replace(/[a-f0-9]{32}/giu, ':uploadId')
    .replace(/[a-f0-9]{24}/giu, ':deviceId')
  const safe = templated.replace(/[^A-Za-z0-9._:/-]/gu, '_').slice(0, 160)
  return safe.startsWith('/') ? safe : `/${safe}`
}

/** A client id is kept only when it cannot be a token, cookie, or metadata value. */
export const syncRequestId = (request) => {
  const incoming = request.headers['x-request-id']
  const hidden = [
    request.headers.authorization,
    request.headers.cookie,
    request.headers['x-fanotes-meta'],
    request.headers['x-fanotes-account'],
  ].filter((value) => typeof value === 'string').join('\n')
  if (typeof incoming === 'string' && REQUEST_ID_PATTERN.test(incoming) && !hidden.includes(incoming)) return incoming
  return randomBytes(16).toString('hex')
}

export const syncFailureCode = (error) => (SAFE_ERROR_CODE.test(error?.code) ? error.code : 'INTERNAL')

export const handleSyncRequest = async (request, response, url) => {
  if (url.pathname !== API_PREFIX && !url.pathname.startsWith(`${API_PREFIX}/`)) return false
  const route = url.pathname.slice(API_PREFIX.length).replace(/\/+$/u, '') || '/'
  const method = request.method || 'GET'
  const requestId = syncRequestId(request)
  request.syncRequestId = requestId
  const started = process.hrtime.bigint()
  let logged = false
  let accountId = ''
  let failureCode = ''
  // One JSON line per sync request. The object is built from fixed fields so a
  // note, token, cookie, email, or metadata value cannot fall into the log.
  const logRequest = () => {
    if (logged) return
    logged = true
    const status = Number(response.statusCode) || 0
    const durationMs = Math.max(0, Math.round(Number(process.hrtime.bigint() - started) / 1e5) / 10)
    const entry = {
      time: new Date().toISOString(),
      level: failureCode ? 'error' : 'info',
      msg: 'sync',
      requestId,
      method: SAFE_METHOD.has(method) ? method : 'OTHER',
      route: syncRouteTemplate(route),
      status,
      durationMs,
    }
    if (/^[a-f0-9]{32}$/u.test(accountId)) entry.account = accountId
    if (failureCode) entry.code = failureCode
    const line = JSON.stringify(entry)
    if (entry.level === 'error') console.error(line)
    else console.log(line)
  }
  // 'close' can run before writeHead, while statusCode is still the default 200.
  response.on('finish', logRequest)
  try {
    if (method === 'OPTIONS') {
      sendEmpty(request, response, 204)
      return true
    }
    if (route === '/prelogin' && method === 'POST') { await handlePrelogin(request, response); return true }
    if (route === '/register' && method === 'POST') { await handleRegister(request, response); return true }
    if (route === '/login' && method === 'POST') { await handleLogin(request, response); return true }

    const auth = await authenticate(request)
    accountId = auth.account.id
    rateLimit(`sync:account:${auth.account.id}`, 1200, 60 * 1000)
    await touchSession(auth.account, auth.tokenHash)

    if (route === '/account' && method === 'GET') { await handleAccount(request, response, auth); return true }
    if (route === '/account' && method === 'DELETE') { await handleDeleteAccount(request, response, auth); return true }
    if (route === '/logout' && method === 'POST') { await handleLogout(request, response, auth); return true }
    if (route === '/password' && method === 'POST') { await handlePassword(request, response, auth); return true }
    if (route === '/changes' && method === 'GET') { await handleChanges(request, response, auth, url); return true }
    if (route === '/integrity' && method === 'GET') { await handleIntegrity(request, response, auth); return true }
    const deviceMatch = /^\/devices\/([a-f0-9]{24})$/u.exec(route)
    if (deviceMatch && method === 'DELETE') { await handleRemoveDevice(request, response, auth, deviceMatch[1]); return true }
    const revisionsMatch = /^\/files\/([a-f0-9]{64})\/revisions$/u.exec(route)
    if (revisionsMatch && method === 'GET') {
      await handleListRevisions(request, response, auth, parseFileId(revisionsMatch[1]))
      return true
    }
    const restoreMatch = /^\/files\/([a-f0-9]{64})\/restore$/u.exec(route)
    if (restoreMatch && method === 'POST') {
      await handleRestoreFile(request, response, auth, parseFileId(restoreMatch[1]))
      return true
    }
    const uploadComplete = /^\/files\/([a-f0-9]{64})\/uploads\/([a-f0-9]{32})\/complete$/u.exec(route)
    if (uploadComplete && method === 'POST') {
      await handleUploadComplete(request, response, auth, parseFileId(uploadComplete[1]), uploadComplete[2])
      return true
    }
    const uploadOne = /^\/files\/([a-f0-9]{64})\/uploads\/([a-f0-9]{32})$/u.exec(route)
    if (uploadOne && method === 'GET') {
      await handleUploadStatus(request, response, auth, parseFileId(uploadOne[1]), uploadOne[2])
      return true
    }
    if (uploadOne && method === 'PATCH') {
      await handleUploadPatch(request, response, auth, parseFileId(uploadOne[1]), uploadOne[2])
      return true
    }
    if (uploadOne && method === 'DELETE') {
      await handleUploadAbort(request, response, auth, parseFileId(uploadOne[1]), uploadOne[2])
      return true
    }
    const uploadCreate = /^\/files\/([a-f0-9]{64})\/uploads$/u.exec(route)
    if (uploadCreate && method === 'POST') {
      await handleCreateUpload(request, response, auth, parseFileId(uploadCreate[1]))
      return true
    }
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
      sendJson(request, response, error.status, { error: error.publicMessage, ...error.extra }, error.status === 429 && error.extra?.retryAfter ? { 'Retry-After': String(error.extra.retryAfter) } : {})
    } else {
      failureCode = syncFailureCode(error)
      sendJson(request, response, 500, { error: 'Der Sync-Server hat einen internen Fehler.' })
    }
  }
  return true
}

export const syncLimits = Object.freeze({ maxBlobBytes: MAX_BLOB_BYTES, quotaBytes: QUOTA_BYTES, maxFiles: MAX_FILES, sessionTtlMs: SESSION_TTL_MS, minKdfIterations: MIN_KDF_ITERATIONS })
