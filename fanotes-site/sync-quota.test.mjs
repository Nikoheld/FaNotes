// A direct PUT must count bytes already reserved by partial uploads.
import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { createServer, request as httpRequest } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

const dataDirectory = mkdtempSync(join(tmpdir(), 'fanotes-sync-quota-'))
process.env.FANOTES_SYNC_DIR = dataDirectory
process.env.FANOTES_SYNC_QUOTA_BYTES = '2000'
process.env.FANOTES_PUBLIC_ORIGIN = 'http://127.0.0.1'
const { handleSyncRequest } = await import('./sync-api.mjs')

const server = createServer(async (request, response) => {
  const url = new URL(request.url, 'http://127.0.0.1')
  if (await handleSyncRequest(request, response, url)) return
  response.writeHead(404)
  response.end()
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const origin = `http://127.0.0.1:${server.address().port}`

const b64 = (size) => randomBytes(size).toString('base64')
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')
const meta = b64(32)
const authKey = b64(32)

const call = (method, path, { token, accountId, headers = {}, body } = {}) => new Promise((resolve, reject) => {
  const url = new URL(path, origin)
  const req = httpRequest({
    hostname: url.hostname,
    port: url.port,
    path: `${url.pathname}${url.search}`,
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}`, 'X-FaNotes-Account': accountId } : {}),
      ...headers,
    },
  }, (response) => {
    const chunks = []
    response.on('data', (chunk) => chunks.push(chunk))
    response.on('end', () => resolve({ status: response.statusCode, body: Buffer.concat(chunks) }))
  })
  req.on('error', reject)
  if (body) req.end(body)
  else req.end()
})

const jsonCall = async (method, path, payload, token, accountId, headers = {}) => {
  const body = Buffer.from(JSON.stringify(payload ?? {}))
  const response = await call(method, path, {
    token,
    accountId,
    body,
    headers: { 'Content-Type': 'application/json', 'Content-Length': String(body.length), ...headers },
  })
  return { status: response.status, json: JSON.parse(response.body.toString('utf8')) }
}

const registered = await jsonCall('POST', '/api/v1/sync/register', {
  email: 'quota@example.com',
  authKey,
  kdf: { algorithm: 'pbkdf2-sha256', iterations: 300000, salt: b64(16) },
  vaultKeyWrap: { iv: b64(12), data: b64(32) },
  device: { name: 'Quota', platform: 'linux' },
})
assert.equal(registered.status, 201, JSON.stringify(registered.json))
const token = registered.json.token
const accountId = registered.json.accountId

const putFile = (id, bytes, base) => call('PUT', `/api/v1/sync/files/${id}`, {
  token,
  accountId,
  body: bytes,
  headers: {
    'Content-Type': 'application/octet-stream',
    'Content-Length': String(bytes.length),
    'If-Match': String(base),
    'X-FaNotes-Meta': meta,
    'X-FaNotes-Sha256': sha256(bytes),
    'X-FaNotes-Blank': '0',
  },
})

test('a put cannot use space a partial upload has already reserved', async () => {
  const firstId = randomBytes(32).toString('hex')
  const secondId = randomBytes(32).toString('hex')
  const first = randomBytes(800)
  const second = randomBytes(800)
  const created = await putFile(firstId, first, 0)
  assert.equal(created.status, 200, created.body.toString('utf8'))

  const tooBig = await jsonCall('POST', `/api/v1/sync/files/${secondId}/uploads`, { size: 1500 }, token, accountId, {
    'If-Match': '0',
    'X-FaNotes-Meta': meta,
    'X-FaNotes-Sha256': sha256(randomBytes(1500)),
    'X-FaNotes-Blank': '0',
  })
  assert.equal(tooBig.status, 507, JSON.stringify(tooBig.json))

  const reserved = await jsonCall('POST', `/api/v1/sync/files/${secondId}/uploads`, { size: 700 }, token, accountId, {
    'If-Match': '0',
    'X-FaNotes-Meta': meta,
    'X-FaNotes-Sha256': sha256(randomBytes(700)),
    'X-FaNotes-Blank': '0',
  })
  assert.equal(reserved.status, 201, JSON.stringify(reserved.json))
  const blocked = await putFile(secondId, second, 0)
  assert.equal(blocked.status, 507, blocked.body.toString('utf8'))
  assert.equal((await call('GET', `/api/v1/sync/files/${secondId}`, { token, accountId })).status, 404)
  assert.deepEqual((await call('GET', `/api/v1/sync/files/${firstId}`, { token, accountId })).body, first)

  const aborted = await call('DELETE', `/api/v1/sync/files/${secondId}/uploads/${reserved.json.uploadId}`, { token, accountId })
  assert.equal(aborted.status, 204)
  const stored = await putFile(secondId, second, 0)
  assert.equal(stored.status, 200, stored.body.toString('utf8'))
  assert.deepEqual((await call('GET', `/api/v1/sync/files/${secondId}`, { token, accountId })).body, second)
})

test('a retried replace does not count the archived note twice', async () => {
  const retryEmail = `quota-retry-${randomBytes(4).toString('hex')}@example.com`
  const retry = await jsonCall('POST', '/api/v1/sync/register', {
    email: retryEmail,
    authKey,
    kdf: { algorithm: 'pbkdf2-sha256', iterations: 300000, salt: b64(16) },
    vaultKeyWrap: { iv: b64(12), data: b64(32) },
    device: { name: 'Quota retry', platform: 'linux' },
  })
  assert.equal(retry.status, 201, JSON.stringify(retry.json))
  const retryToken = retry.json.token
  const retryAccount = retry.json.accountId
  const put = (id, bytes, base) => call('PUT', `/api/v1/sync/files/${id}`, {
    token: retryToken,
    accountId: retryAccount,
    body: bytes,
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(bytes.length),
      'If-Match': String(base),
      'X-FaNotes-Meta': meta,
      'X-FaNotes-Sha256': sha256(bytes),
      'X-FaNotes-Blank': '0',
    },
  })
  const id = randomBytes(32).toString('hex')
  const original = randomBytes(900)
  const created = await put(id, original, 0)
  assert.equal(created.status, 200, created.body.toString('utf8'))
  const revision = JSON.parse(created.body.toString('utf8')).revision
  const newer = randomBytes(900)
  process.env.FANOTES_SYNC_PLACE_FAIL = '1'
  try {
    const failed = await put(id, newer, revision)
    assert.equal(failed.status, 500, failed.body.toString('utf8'))
    const kept = await call('GET', `/api/v1/sync/files/${id}`, { token: retryToken, accountId: retryAccount })
    assert.equal(kept.status, 200)
    assert.deepEqual(kept.body, original)
  } finally {
    delete process.env.FANOTES_SYNC_PLACE_FAIL
  }
  const retried = await put(id, newer, revision)
  assert.equal(retried.status, 200, retried.body.toString('utf8'))
  const live = await call('GET', `/api/v1/sync/files/${id}`, { token: retryToken, accountId: retryAccount })
  assert.equal(live.status, 200)
  assert.deepEqual(live.body, newer)
})

test('a replace near the quota reuses the oldest archived note', async () => {
  const roomEmail = `quota-room-${randomBytes(4).toString('hex')}@example.com`
  const room = await jsonCall('POST', '/api/v1/sync/register', {
    email: roomEmail,
    authKey,
    kdf: { algorithm: 'pbkdf2-sha256', iterations: 300000, salt: b64(16) },
    vaultKeyWrap: { iv: b64(12), data: b64(32) },
    device: { name: 'Quota room', platform: 'linux' },
  })
  assert.equal(room.status, 201, JSON.stringify(room.json))
  const roomToken = room.json.token
  const roomAccount = room.json.accountId
  const put = (id, bytes, base) => call('PUT', `/api/v1/sync/files/${id}`, {
    token: roomToken,
    accountId: roomAccount,
    body: bytes,
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(bytes.length),
      'If-Match': String(base),
      'X-FaNotes-Meta': meta,
      'X-FaNotes-Sha256': sha256(bytes),
      'X-FaNotes-Blank': '0',
    },
  })
  const id = randomBytes(32).toString('hex')
  const original = randomBytes(210)
  const created = await put(id, original, 0)
  assert.equal(created.status, 200, created.body.toString('utf8'))
  let revision = JSON.parse(created.body.toString('utf8')).revision
  const firstRevision = revision
  for (let index = 0; index < 8; index += 1) {
    const next = randomBytes(210)
    const stored = await put(id, next, revision)
    assert.equal(stored.status, 200, stored.body.toString('utf8'))
    revision = JSON.parse(stored.body.toString('utf8')).revision
  }
  const newest = randomBytes(210)
  const reused = await put(id, newest, revision)
  assert.equal(reused.status, 200, reused.body.toString('utf8'))
  const reusedRevision = JSON.parse(reused.body.toString('utf8')).revision
  const listed = await jsonCall('GET', `/api/v1/sync/files/${id}/revisions`, null, roomToken, roomAccount)
  assert.equal(listed.status, 200, JSON.stringify(listed.json))
  assert.equal(listed.json.revisions.some((entry) => entry.revision === firstRevision), false)
  const live = await call('GET', `/api/v1/sync/files/${id}`, { token: roomToken, accountId: roomAccount })
  assert.equal(live.status, 200)
  assert.deepEqual(live.body, newest)
  const larger = randomBytes(400)
  const refused = await put(id, larger, reusedRevision)
  assert.equal(refused.status, 507, refused.body.toString('utf8'))
  const kept = await call('GET', `/api/v1/sync/files/${id}`, { token: roomToken, accountId: roomAccount })
  assert.equal(kept.status, 200)
  assert.deepEqual(kept.body, newest)
})

test.after(() => new Promise((resolve) => {
  server.close(() => {
    rmSync(dataDirectory, { recursive: true, force: true })
    resolve()
  })
}))
