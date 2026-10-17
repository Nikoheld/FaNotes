// OAuth grants and device-reader credentials for the MCP connector.
// Note plaintext is never written here. A grant only names the account,
// the Grok client, and hashes of tokens the client already holds.
import { createHash, createHmac, randomBytes, scrypt, timingSafeEqual } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { resolve, sep } from 'node:path'
import { classifyRedirect, clientNameAllowed, redirectsMatch, scopeAllowed } from './mcp-policy.mjs'

const ROOT = resolve(process.env.FANOTES_MCP_DIR || '/var/lib/fanotes-mcp')
const MAX_CLIENTS = 2_000
const MAX_GRANTS = 8
const MAX_READERS = 5
const CODE_TTL_MS = 60_000
const PENDING_TTL_MS = 10 * 60_000
const ACCESS_TTL_MS = 15 * 60_000
const REFRESH_TTL_MS = 30 * 24 * 60 * 60_000
const READER_CACHE_MS = 12 * 60 * 60_000
const JOB_TTL_MS = 60_000

const clients = new Map()
const accounts = new Map()
const pending = new Map()
const codes = new Map()
const jobs = new Map()
const readerCache = new Map()
const seenReaders = new Map()
let secretPromise = null
let clientsLoaded = false

const sha256 = (value) => createHash('sha256').update(value).digest('hex')
const b64url = (bytes) => Buffer.from(bytes).toString('base64url')
const safeEqual = (left, right) => left.length === right.length && timingSafeEqual(left, right)

const scryptHash = (secret, salt) => new Promise((resolveHash, rejectHash) => {
  scrypt(secret, salt, 32, { N: 16_384, r: 8, p: 1, maxmem: 32 * 1024 * 1024 }, (error, key) => {
    if (error) rejectHash(error)
    else resolveHash(key)
  })
})

const safeJoin = (root, ...segments) => {
  const target = resolve(root, ...segments)
  if (target !== root && !target.startsWith(`${root}${sep}`)) throw new Error('Ungültiger Pfad.')
  return target
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

const ensureRoot = async () => {
  await fs.mkdir(safeJoin(ROOT, 'clients'), { recursive: true, mode: 0o700 })
  await fs.mkdir(safeJoin(ROOT, 'accounts'), { recursive: true, mode: 0o700 })
}

const serverSecret = () => {
  secretPromise ??= (async () => {
    await ensureRoot()
    const target = safeJoin(ROOT, 'server-secret')
    try {
      return await fs.readFile(target)
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
      const secret = randomBytes(32)
      await atomicWrite(target, secret)
      return secret
    }
  })()
  return secretPromise
}

const clientPath = (id) => safeJoin(ROOT, 'clients', `${id}.json`)
const accountPath = (id) => safeJoin(ROOT, 'accounts', `${id}.json`)

const readJson = async (target) => {
  try {
    return JSON.parse(await fs.readFile(target, 'utf8'))
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
}

const emptyAccount = (accountId) => ({ version: 1, accountId, readers: {}, grants: {} })

const loadAccount = async (accountId) => {
  if (!/^[a-f0-9]{32}$/u.test(accountId)) return null
  if (accounts.has(accountId)) return accounts.get(accountId)
  const stored = await readJson(accountPath(accountId))
  const record = stored?.accountId === accountId ? stored : emptyAccount(accountId)
  record.readers ??= {}
  record.grants ??= {}
  accounts.set(accountId, record)
  return record
}

const saveAccount = async (record) => {
  await ensureRoot()
  accounts.set(record.accountId, record)
  await atomicWrite(accountPath(record.accountId), JSON.stringify(record))
}

const loadClients = async () => {
  if (clientsLoaded) return
  await ensureRoot()
  const names = await fs.readdir(safeJoin(ROOT, 'clients')).catch(() => [])
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    const stored = await readJson(safeJoin(ROOT, 'clients', name))
    if (stored?.id) clients.set(stored.id, stored)
  }
  clientsLoaded = true
}

const saveClient = async (client) => {
  await ensureRoot()
  clients.set(client.id, client)
  await atomicWrite(clientPath(client.id), JSON.stringify(client))
  if (clients.size <= MAX_CLIENTS) return
  const oldest = [...clients.values()].sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt))
  for (const stale of oldest.slice(0, clients.size - MAX_CLIENTS)) {
    clients.delete(stale.id)
    await fs.rm(clientPath(stale.id), { force: true })
  }
}

const dropExpiredMemory = (now = Date.now()) => {
  for (const [id, entry] of pending) if (entry.expiresAt <= now) pending.delete(id)
  for (const [hash, entry] of codes) if (entry.expiresAt <= now) codes.delete(hash)
  for (const [id, job] of jobs) {
    if (job.expiresAt > now) continue
    job.settle?.(null)
    jobs.delete(id)
  }
  for (const [digest, entry] of readerCache) if (entry.until <= now) readerCache.delete(digest)
}

export const resetMcpMemoryForTests = () => {
  clients.clear()
  accounts.clear()
  pending.clear()
  codes.clear()
  jobs.clear()
  readerCache.clear()
  seenReaders.clear()
  clientsLoaded = false
  secretPromise = null
}

export const registerOauthClient = async ({ name, redirectUris }) => {
  const clientName = clientNameAllowed(name)
  if (!clientName) return { error: 'invalid_client_metadata' }
  if (!Array.isArray(redirectUris) || redirectUris.length < 1 || redirectUris.length > 4) return { error: 'invalid_redirect_uri' }
  const classified = redirectUris.map((uri) => classifyRedirect(uri))
  if (classified.some((entry) => !entry)) return { error: 'invalid_redirect_uri' }
  await loadClients()
  const id = `fn_${randomBytes(18).toString('hex')}`
  const client = { id, name: clientName, redirectUris, createdAt: new Date().toISOString(), lastUsedAt: null }
  await saveClient(client)
  return { client }
}

export const getOauthClient = async (id) => {
  if (typeof id !== 'string' || !/^fn_[a-f0-9]{36}$/u.test(id)) return null
  await loadClients()
  return clients.get(id) ?? null
}

const locks = new Map()
const withLock = async (accountId, task) => {
  const previous = locks.get(accountId) ?? Promise.resolve()
  let release
  const current = new Promise((resolveLock) => { release = resolveLock })
  locks.set(accountId, previous.then(() => current, () => current))
  await previous.catch(() => undefined)
  try {
    return await task()
  } finally {
    release()
    if (locks.get(accountId) === current) locks.delete(accountId)
  }
}

export const beginAuthorization = ({ client, redirectUri, state, codeChallenge, scope, resource }) => {
  dropExpiredMemory()
  if (!client || !client.redirectUris.some((uri) => redirectsMatch(uri, redirectUri))) return { error: 'invalid_redirect_uri' }
  if (typeof state !== 'string' || !/^[A-Za-z0-9._~-]{8,160}$/u.test(state)) return { error: 'invalid_request' }
  if (typeof codeChallenge !== 'string' || !/^[A-Za-z0-9_-]{43,128}$/u.test(codeChallenge)) return { error: 'invalid_request' }
  const granted = scopeAllowed(scope)
  if (!granted) return { error: 'invalid_scope' }
  const id = randomBytes(18).toString('base64url')
  pending.set(id, {
    id,
    clientId: client.id,
    clientName: client.name,
    redirectUri,
    state,
    codeChallenge,
    scope: granted,
    resource,
    accountId: null,
    csrf: null,
    expiresAt: Date.now() + PENDING_TTL_MS,
  })
  return { request: pending.get(id) }
}

export const proveConsent = async (requestId, account) => {
  dropExpiredMemory()
  const request = pending.get(requestId)
  if (!request || request.expiresAt <= Date.now()) return null
  request.accountId = account.id
  request.email = account.email
  request.csrf = randomBytes(18).toString('base64url')
  return request
}

export const consentCookie = async (request) => {
  const secret = await serverSecret()
  const exp = Date.now() + PENDING_TTL_MS
  const body = b64url(JSON.stringify({ accountId: request.accountId, requestId: request.id, exp }))
  const sig = createHmac('sha256', secret).update(body).digest('base64url')
  return { value: `${body}.${sig}`, exp }
}

export const readConsentCookie = async (raw) => {
  if (typeof raw !== 'string' || !raw.includes('.')) return null
  const [body, sig] = raw.split('.')
  if (!body || !sig) return null
  const secret = await serverSecret()
  const expected = createHmac('sha256', secret).update(body).digest('base64url')
  const left = Buffer.from(sig)
  const right = Buffer.from(expected)
  if (!safeEqual(left, right)) return null
  try {
    const parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'))
    if (!parsed?.accountId || !parsed.requestId || Number(parsed.exp) <= Date.now()) return null
    return parsed
  } catch {
    return null
  }
}

const signAccessToken = async (payload) => {
  const secret = await serverSecret()
  const body = b64url(JSON.stringify(payload))
  const sig = createHmac('sha256', secret).update(`fn1.${body}`).digest('base64url')
  return `fn1.${body}.${sig}`
}

export const verifyAccessToken = async (token, resource) => {
  if (typeof token !== 'string' || !token.startsWith('fn1.')) return null
  const [, body, sig] = token.split('.')
  if (!body || !sig) return null
  const secret = await serverSecret()
  const expected = createHmac('sha256', secret).update(`fn1.${body}`).digest('base64url')
  const left = Buffer.from(sig)
  const right = Buffer.from(expected)
  if (!safeEqual(left, right)) return null
  let payload
  try { payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) } catch { return null }
  if (!payload || payload.typ !== 'access' || payload.scope !== 'vault:read') return null
  if (payload.aud !== resource || Number(payload.exp) <= Date.now()) return null
  const record = await loadAccount(payload.accountId)
  const grant = record?.grants?.[payload.grantId]
  if (!grant || grant.clientId !== payload.clientId) return null
  return { accountId: payload.accountId, clientId: payload.clientId, grantId: payload.grantId, scope: payload.scope }
}

const issueTokenPair = async (record, grant) => {
  const refresh = `fnr_${randomBytes(32).toString('base64url')}`
  grant.previousRefreshHash = grant.refreshHash ?? null
  grant.refreshHash = sha256(refresh)
  grant.refreshExpiresAt = new Date(Date.now() + REFRESH_TTL_MS).toISOString()
  await saveAccount(record)
  const access = await signAccessToken({
    typ: 'access',
    accountId: record.accountId,
    clientId: grant.clientId,
    grantId: grant.id,
    scope: 'vault:read',
    aud: grant.resource,
    iat: Date.now(),
    exp: Date.now() + ACCESS_TTL_MS,
  })
  return { access_token: access, token_type: 'Bearer', expires_in: Math.floor(ACCESS_TTL_MS / 1000), refresh_token: refresh, scope: 'vault:read' }
}

export const exchangeAuthorizationCode = async ({ code, clientId, redirectUri, verifier, resource }) => {
  dropExpiredMemory()
  if (typeof code !== 'string' || !/^[A-Za-z0-9._~-]{43,128}$/u.test(verifier)) return { error: 'invalid_grant' }
  const hash = sha256(code)
  const entry = codes.get(hash)
  if (!entry || entry.expiresAt <= Date.now()) return { error: 'invalid_grant' }
  codes.delete(hash)
  if (entry.clientId !== clientId || !redirectsMatch(entry.redirectUri, redirectUri)) return { error: 'invalid_grant' }
  if (resource && entry.resource && resource !== entry.resource) return { error: 'invalid_target' }
  const digest = createHash('sha256').update(verifier).digest('base64url')
  if (!safeEqual(Buffer.from(digest), Buffer.from(entry.codeChallenge))) return { error: 'invalid_grant' }
  const client = await getOauthClient(clientId)
  if (!client) return { error: 'invalid_client' }
  return withLock(entry.accountId, async () => {
    const record = await loadAccount(entry.accountId)
    if (!record) return { error: 'invalid_grant' }
    if (Object.keys(record.grants).length >= MAX_GRANTS) return { error: 'access_denied' }
    const grantId = randomBytes(12).toString('hex')
    let host = 'grok'
    try { host = new URL(entry.redirectUri).host } catch { host = 'grok' }
    record.grants[grantId] = {
      id: grantId,
      clientId,
      clientName: client.name,
      redirectHost: host,
      scope: 'vault:read',
      resource: entry.resource,
      refreshHash: null,
      previousRefreshHash: null,
      createdAt: new Date().toISOString(),
      lastUsedAt: null,
    }
    const tokens = await issueTokenPair(record, record.grants[grantId])
    return { tokens }
  })
}

export const approveAuthorization = async ({ requestId, csrf, cookie }) => {
  dropExpiredMemory()
  const request = pending.get(requestId)
  const cookiePayload = await readConsentCookie(cookie)
  if (!request || !cookiePayload || !request.csrf || request.csrf !== csrf) return { error: 'access_denied' }
  if (cookiePayload.requestId !== request.id || cookiePayload.accountId !== request.accountId) return { error: 'access_denied' }
  pending.delete(requestId)
  const code = randomBytes(32).toString('base64url')
  codes.set(sha256(code), {
    clientId: request.clientId,
    redirectUri: request.redirectUri,
    codeChallenge: request.codeChallenge,
    accountId: request.accountId,
    resource: request.resource,
    expiresAt: Date.now() + CODE_TTL_MS,
  })
  return { request, code }
}

export const refreshOauthToken = async ({ refreshToken, clientId, resource }) => {
  if (typeof refreshToken !== 'string' || !refreshToken.startsWith('fnr_')) return { error: 'invalid_grant' }
  const hash = sha256(refreshToken)
  const names = await fs.readdir(safeJoin(ROOT, 'accounts')).catch(() => [])
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    const accountId = name.slice(0, -5)
    const record = await loadAccount(accountId)
    if (!record) continue
    for (const grant of Object.values(record.grants)) {
      if (grant.clientId !== clientId) continue
      if (grant.previousRefreshHash === hash) {
        delete record.grants[grant.id]
        await saveAccount(record)
        return { error: 'invalid_grant' }
      }
      if (grant.refreshHash !== hash) continue
      if (Date.parse(grant.refreshExpiresAt) <= Date.now()) {
        delete record.grants[grant.id]
        await saveAccount(record)
        return { error: 'invalid_grant' }
      }
      if (resource && grant.resource && resource !== grant.resource) return { error: 'invalid_target' }
      grant.lastUsedAt = new Date().toISOString()
      const tokens = await issueTokenPair(record, grant)
      return { tokens }
    }
  }
  return { error: 'invalid_grant' }
}

export const revokeOauthToken = async ({ token, clientId }) => {
  if (typeof token !== 'string') return
  if (token.startsWith('fn1.')) {
    const secret = await serverSecret()
    const [, body, sig] = token.split('.')
    if (!body || !sig) return
    const expected = createHmac('sha256', secret).update(`fn1.${body}`).digest('base64url')
    if (!safeEqual(Buffer.from(sig), Buffer.from(expected))) return
    let payload
    try { payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) } catch { return }
    if (payload?.clientId !== clientId) return
    const record = await loadAccount(payload.accountId)
    if (record?.grants?.[payload.grantId]) {
      delete record.grants[payload.grantId]
      await saveAccount(record)
    }
    return
  }
  const hash = sha256(token)
  const names = await fs.readdir(safeJoin(ROOT, 'accounts')).catch(() => [])
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    const record = await loadAccount(name.slice(0, -5))
    if (!record) continue
    for (const grant of Object.values(record.grants)) {
      if (grant.clientId === clientId && (grant.refreshHash === hash || grant.previousRefreshHash === hash)) {
        delete record.grants[grant.id]
        await saveAccount(record)
        return
      }
    }
  }
}

const clearReaderCache = (accountId) => {
  for (const [digest, entry] of readerCache) if (entry.accountId === accountId) readerCache.delete(digest)
  seenReaders.delete(accountId)
}

export const enableReader = async (accountId, deviceId, readerKey) => {
  if (typeof readerKey !== 'string' || !/^[A-Za-z0-9_-]{43,80}$/u.test(readerKey)) return false
  if (typeof deviceId !== 'string' || !/^[a-f0-9]{24}$/u.test(deviceId)) return false
  return withLock(accountId, async () => {
    const record = await loadAccount(accountId)
    if (!record) return false
    if (!record.readers[deviceId] && Object.keys(record.readers).length >= MAX_READERS) {
      const oldest = Object.entries(record.readers).sort(([, left], [, right]) => Date.parse(left.updatedAt) - Date.parse(right.updatedAt))[0]
      if (oldest) delete record.readers[oldest[0]]
    }
    const salt = randomBytes(16)
    const hash = await scryptHash(readerKey, salt)
    record.readers[deviceId] = { salt: salt.toString('base64'), hash: hash.toString('base64'), updatedAt: new Date().toISOString() }
    clearReaderCache(accountId)
    await saveAccount(record)
    return true
  })
}

const dropAccountJobs = (accountId) => {
  for (const [id, job] of jobs) {
    if (job.accountId !== accountId) continue
    job.settle?.(null)
    jobs.delete(id)
  }
}

export const disableReader = async (accountId, deviceId, { revokeGrants = false } = {}) => withLock(accountId, async () => {
  const record = await loadAccount(accountId)
  if (!record) return
  if (deviceId) delete record.readers[deviceId]
  else record.readers = {}
  if (revokeGrants || Object.keys(record.readers).length === 0) record.grants = {}
  clearReaderCache(accountId)
  dropAccountJobs(accountId)
  await saveAccount(record)
})

export const revokeAccountAccess = async (accountId) => {
  if (!/^[a-f0-9]{32}$/u.test(accountId)) return
  await withLock(accountId, async () => {
    accounts.delete(accountId)
    clearReaderCache(accountId)
    dropAccountJobs(accountId)
    await fs.rm(accountPath(accountId), { force: true }).catch(() => undefined)
  })
}

export const matchReader = async (accountId, readerKey) => {
  if (typeof readerKey !== 'string' || !/^[A-Za-z0-9_-]{43,80}$/u.test(readerKey)) return null
  const digest = sha256(readerKey)
  const cached = readerCache.get(digest)
  if (cached && cached.accountId === accountId && cached.until > Date.now()) return cached.deviceId
  const record = await loadAccount(accountId)
  if (!record) return null
  for (const [deviceId, reader] of Object.entries(record.readers)) {
    try {
      const expected = Buffer.from(reader.hash, 'base64')
      const actual = await scryptHash(readerKey, Buffer.from(reader.salt, 'base64'))
      if (safeEqual(expected, actual)) {
        readerCache.set(digest, { accountId, deviceId, until: Date.now() + READER_CACHE_MS })
        return deviceId
      }
    } catch {
      return null
    }
  }
  return null
}

export const listGrants = async (accountId) => {
  const record = await loadAccount(accountId)
  if (!record) return []
  return Object.values(record.grants).map((grant) => ({
    id: grant.id,
    clientName: grant.clientName,
    redirectHost: grant.redirectHost,
    createdAt: grant.createdAt,
    lastUsedAt: grant.lastUsedAt,
  }))
}

export const revokeGrant = async (accountId, grantId) => {
  const record = await loadAccount(accountId)
  if (!record?.grants?.[grantId]) return false
  delete record.grants[grantId]
  await saveAccount(record)
  return true
}

export const noteReaderSeen = (accountId) => {
  seenReaders.set(accountId, Date.now())
}

export const readerSeenRecently = (accountId, withinMs) => {
  const seen = seenReaders.get(accountId)
  return typeof seen === 'number' && Date.now() - seen <= withinMs
}

export const readerEnabled = async (accountId) => {
  const record = await loadAccount(accountId)
  return Boolean(record && Object.keys(record.readers).length > 0)
}

export const enqueueVaultJob = ({ accountId, clientId, tool, args, waitMs }) => {
  dropExpiredMemory()
  const id = randomBytes(12).toString('hex')
  let settle
  const done = new Promise((resolve) => { settle = resolve })
  const job = {
    id,
    accountId,
    clientId,
    tool,
    arguments: args,
    status: 'queued',
    claimUntil: 0,
    expiresAt: Date.now() + Math.min(JOB_TTL_MS, waitMs + 5_000),
    settle,
  }
  jobs.set(id, job)
  return { id, done }
}

export const claimVaultJob = (accountId) => {
  dropExpiredMemory()
  const now = Date.now()
  for (const job of jobs.values()) {
    if (job.accountId !== accountId || job.status === 'done') continue
    if (job.status === 'claimed' && job.claimUntil > now) continue
    job.status = 'claimed'
    job.claimUntil = now + 25_000
    return { id: job.id, tool: job.tool, arguments: job.arguments }
  }
  return null
}

export const completeVaultJob = (accountId, jobId, result) => {
  const job = jobs.get(jobId)
  if (!job || job.accountId !== accountId || job.status === 'done') return false
  job.status = 'done'
  job.settle(result)
  jobs.delete(jobId)
  return true
}

export const cancelVaultJob = (jobId) => {
  const job = jobs.get(jobId)
  if (!job || job.status === 'done') return
  job.status = 'done'
  job.settle(null)
  jobs.delete(jobId)
}

export const accessTtlSeconds = Math.floor(ACCESS_TTL_MS / 1000)

export const discardPending = (requestId) => {
  pending.delete(requestId)
}

export const pendingAuthorization = (requestId) => pending.get(requestId) ?? null
