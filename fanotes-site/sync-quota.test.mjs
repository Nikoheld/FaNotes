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
process.env.FANOTES_SYNC_FILE_CAP = '1'
process.env.FANOTES_PUBLIC_ORIGIN = 'http://127.0.0.1'
globalThis.FANOTES_SYNC_FILE_CAP = {}
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

test('a resumable upload does not reserve a note it will replace', async () => {
  const uploadEmail = `quota-upload-${randomBytes(4).toString('hex')}@example.com`
  const upload = await jsonCall('POST', '/api/v1/sync/register', {
    email: uploadEmail,
    authKey,
    kdf: { algorithm: 'pbkdf2-sha256', iterations: 300000, salt: b64(16) },
    vaultKeyWrap: { iv: b64(12), data: b64(32) },
    device: { name: 'Quota upload', platform: 'linux' },
  })
  assert.equal(upload.status, 201, JSON.stringify(upload.json))
  const uploadToken = upload.json.token
  const uploadAccount = upload.json.accountId
  const put = (id, bytes, base) => call('PUT', `/api/v1/sync/files/${id}`, {
    token: uploadToken,
    accountId: uploadAccount,
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
  const open = (id, size, digest, base, headers = {}) => jsonCall('POST', `/api/v1/sync/files/${id}/uploads`, { size }, uploadToken, uploadAccount, {
    'If-Match': String(base),
    'X-FaNotes-Meta': meta,
    'X-FaNotes-Sha256': digest,
    'X-FaNotes-Blank': '0',
    ...headers,
  })
  const id = randomBytes(32).toString('hex')
  const original = randomBytes(1500)
  const created = await put(id, original, 0)
  assert.equal(created.status, 200, created.body.toString('utf8'))
  const revision = JSON.parse(created.body.toString('utf8')).revision
  const blank = await open(id, 100, sha256(randomBytes(100)), revision, { 'X-FaNotes-Blank': '1' })
  assert.equal(blank.status, 201, JSON.stringify(blank.json))
  const otherId = randomBytes(32).toString('hex')
  const blocked = await open(otherId, 500, sha256(randomBytes(500)), 0)
  assert.equal(blocked.status, 507, JSON.stringify(blocked.json))
  const aborted = await call('DELETE', `/api/v1/sync/files/${id}/uploads/${blank.json.uploadId}`, { token: uploadToken, accountId: uploadAccount })
  assert.equal(aborted.status, 204)
  const same = await open(id, original.length, sha256(original), revision)
  assert.equal(same.status, 201, JSON.stringify(same.json))
  const dropped = await call('DELETE', `/api/v1/sync/files/${id}/uploads/${same.json.uploadId}`, { token: uploadToken, accountId: uploadAccount })
  assert.equal(dropped.status, 204)
  const grown = await open(id, original.length, sha256(randomBytes(original.length)), revision)
  assert.equal(grown.status, 507, JSON.stringify(grown.json))
  const live = await call('GET', `/api/v1/sync/files/${id}`, { token: uploadToken, accountId: uploadAccount })
  assert.equal(live.status, 200)
  assert.deepEqual(live.body, original)

  const windowEmail = `quota-window-${randomBytes(4).toString('hex')}@example.com`
  const windowAccount = await jsonCall('POST', '/api/v1/sync/register', {
    email: windowEmail,
    authKey,
    kdf: { algorithm: 'pbkdf2-sha256', iterations: 300000, salt: b64(16) },
    vaultKeyWrap: { iv: b64(12), data: b64(32) },
    device: { name: 'Quota window', platform: 'linux' },
  })
  assert.equal(windowAccount.status, 201, JSON.stringify(windowAccount.json))
  const windowToken = windowAccount.json.token
  const windowId = windowAccount.json.accountId
  const putWindow = (fileId, bytes, base) => call('PUT', `/api/v1/sync/files/${fileId}`, {
    token: windowToken,
    accountId: windowId,
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
  const openWindow = (fileId, size, digest, base) => jsonCall('POST', `/api/v1/sync/files/${fileId}/uploads`, { size }, windowToken, windowId, {
    'If-Match': String(base),
    'X-FaNotes-Meta': meta,
    'X-FaNotes-Sha256': digest,
    'X-FaNotes-Blank': '0',
  })
  const roomId = randomBytes(32).toString('hex')
  const first = randomBytes(210)
  const roomCreated = await putWindow(roomId, first, 0)
  assert.equal(roomCreated.status, 200, roomCreated.body.toString('utf8'))
  let roomRevision = JSON.parse(roomCreated.body.toString('utf8')).revision
  let roomBody = first
  for (let index = 0; index < 8; index += 1) {
    roomBody = randomBytes(210)
    const stored = await putWindow(roomId, roomBody, roomRevision)
    assert.equal(stored.status, 200, stored.body.toString('utf8'))
    roomRevision = JSON.parse(stored.body.toString('utf8')).revision
  }
  const resumed = await openWindow(roomId, 210, sha256(randomBytes(210)), roomRevision)
  assert.equal(resumed.status, 201, JSON.stringify(resumed.json))
  const resumedAbort = await call('DELETE', `/api/v1/sync/files/${roomId}/uploads/${resumed.json.uploadId}`, { token: windowToken, accountId: windowId })
  assert.equal(resumedAbort.status, 204)
  const tooBig = await openWindow(roomId, 400, sha256(randomBytes(400)), roomRevision)
  assert.equal(tooBig.status, 507, JSON.stringify(tooBig.json))
  const roomLive = await call('GET', `/api/v1/sync/files/${roomId}`, { token: windowToken, accountId: windowId })
  assert.equal(roomLive.status, 200)
  assert.deepEqual(roomLive.body, roomBody)
})

test('a resumable replace leaves room for another note that still fits', async () => {
  const creditEmail = `quota-credit-${randomBytes(4).toString('hex')}@example.com`
  const credit = await jsonCall('POST', '/api/v1/sync/register', {
    email: creditEmail,
    authKey,
    kdf: { algorithm: 'pbkdf2-sha256', iterations: 300000, salt: b64(16) },
    vaultKeyWrap: { iv: b64(12), data: b64(32) },
    device: { name: 'Quota credit', platform: 'linux' },
  })
  assert.equal(credit.status, 201, JSON.stringify(credit.json))
  const creditToken = credit.json.token
  const creditAccount = credit.json.accountId
  const put = (id, bytes, base) => call('PUT', `/api/v1/sync/files/${id}`, {
    token: creditToken,
    accountId: creditAccount,
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
  const open = (id, size, digest, base) => jsonCall('POST', `/api/v1/sync/files/${id}/uploads`, { size }, creditToken, creditAccount, {
    'If-Match': String(base),
    'X-FaNotes-Meta': meta,
    'X-FaNotes-Sha256': digest,
    'X-FaNotes-Blank': '0',
  })
  const id = randomBytes(32).toString('hex')
  const original = randomBytes(1500)
  const created = await put(id, original, 0)
  assert.equal(created.status, 200, created.body.toString('utf8'))
  const revision = JSON.parse(created.body.toString('utf8')).revision
  const same = await open(id, original.length, sha256(original), revision)
  assert.equal(same.status, 201, JSON.stringify(same.json))
  const otherId = randomBytes(32).toString('hex')
  const other = randomBytes(400)
  const stored = await put(otherId, other, 0)
  assert.equal(stored.status, 200, stored.body.toString('utf8'))
  const smallId = randomBytes(32).toString('hex')
  const small = await open(smallId, 50, sha256(randomBytes(50)), 0)
  assert.equal(small.status, 201, JSON.stringify(small.json))
  const crowded = await open(randomBytes(32).toString('hex'), 200, sha256(randomBytes(200)), 0)
  assert.equal(crowded.status, 507, JSON.stringify(crowded.json))
  assert.equal((await call('DELETE', `/api/v1/sync/files/${id}/uploads/${same.json.uploadId}`, { token: creditToken, accountId: creditAccount })).status, 204)
  assert.equal((await call('DELETE', `/api/v1/sync/files/${smallId}/uploads/${small.json.uploadId}`, { token: creditToken, accountId: creditAccount })).status, 204)
  assert.deepEqual((await call('GET', `/api/v1/sync/files/${id}`, { token: creditToken, accountId: creditAccount })).body, original)
  assert.deepEqual((await call('GET', `/api/v1/sync/files/${otherId}`, { token: creditToken, accountId: creditAccount })).body, other)

  const archiveEmail = `quota-archive-${randomBytes(4).toString('hex')}@example.com`
  const archive = await jsonCall('POST', '/api/v1/sync/register', {
    email: archiveEmail,
    authKey,
    kdf: { algorithm: 'pbkdf2-sha256', iterations: 300000, salt: b64(16) },
    vaultKeyWrap: { iv: b64(12), data: b64(32) },
    device: { name: 'Quota archive', platform: 'linux' },
  })
  assert.equal(archive.status, 201, JSON.stringify(archive.json))
  const archiveToken = archive.json.token
  const archiveAccount = archive.json.accountId
  const putArchive = (fileId, bytes, base) => call('PUT', `/api/v1/sync/files/${fileId}`, {
    token: archiveToken,
    accountId: archiveAccount,
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
  const openArchive = (fileId, size, digest, base) => jsonCall('POST', `/api/v1/sync/files/${fileId}/uploads`, { size }, archiveToken, archiveAccount, {
    'If-Match': String(base),
    'X-FaNotes-Meta': meta,
    'X-FaNotes-Sha256': digest,
    'X-FaNotes-Blank': '0',
  })
  const keptId = randomBytes(32).toString('hex')
  const keptBody = randomBytes(600)
  const keptPut = await putArchive(keptId, keptBody, 0)
  assert.equal(keptPut.status, 200, keptPut.body.toString('utf8'))
  const keptRevision = JSON.parse(keptPut.body.toString('utf8')).revision
  const replacing = await openArchive(keptId, keptBody.length, sha256(randomBytes(keptBody.length)), keptRevision)
  assert.equal(replacing.status, 201, JSON.stringify(replacing.json))
  const blockedId = randomBytes(32).toString('hex')
  const blocked = await putArchive(blockedId, randomBytes(900), 0)
  assert.equal(blocked.status, 507, blocked.body.toString('utf8'))
  assert.equal((await call('DELETE', `/api/v1/sync/files/${keptId}/uploads/${replacing.json.uploadId}`, { token: archiveToken, accountId: archiveAccount })).status, 204)
  const fits = randomBytes(900)
  const allowed = await putArchive(blockedId, fits, 0)
  assert.equal(allowed.status, 200, allowed.body.toString('utf8'))
  assert.deepEqual((await call('GET', `/api/v1/sync/files/${keptId}`, { token: archiveToken, accountId: archiveAccount })).body, keptBody)
  assert.deepEqual((await call('GET', `/api/v1/sync/files/${blockedId}`, { token: archiveToken, accountId: archiveAccount })).body, fits)
})

test('a new upload does not take the last file slot from an existing note', async () => {
  const slotEmail = `quota-slot-${randomBytes(4).toString('hex')}@example.com`
  const slot = await jsonCall('POST', '/api/v1/sync/register', {
    email: slotEmail,
    authKey,
    kdf: { algorithm: 'pbkdf2-sha256', iterations: 300000, salt: b64(16) },
    vaultKeyWrap: { iv: b64(12), data: b64(32) },
    device: { name: 'Quota slot', platform: 'linux' },
  })
  assert.equal(slot.status, 201, JSON.stringify(slot.json))
  const slotToken = slot.json.token
  const slotAccount = slot.json.accountId
  globalThis.FANOTES_SYNC_FILE_CAP[slotAccount] = 1
  try {
    const put = (id, bytes, base) => call('PUT', `/api/v1/sync/files/${id}`, {
      token: slotToken,
      accountId: slotAccount,
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
    const original = randomBytes(1500)
    const created = await put(id, original, 0)
    assert.equal(created.status, 200, created.body.toString('utf8'))
    const revision = JSON.parse(created.body.toString('utf8')).revision
    const otherId = randomBytes(32).toString('hex')
    const opened = await jsonCall('POST', `/api/v1/sync/files/${otherId}/uploads`, { size: 400 }, slotToken, slotAccount, {
      'If-Match': '0',
      'X-FaNotes-Meta': meta,
      'X-FaNotes-Sha256': sha256(randomBytes(400)),
      'X-FaNotes-Blank': '0',
    })
    assert.equal(opened.status, 507, JSON.stringify(opened.json))
    const next = randomBytes(200)
    const replaced = await put(id, next, revision)
    assert.equal(replaced.status, 200, replaced.body.toString('utf8'))
    const third = await put(randomBytes(32).toString('hex'), randomBytes(100), 0)
    assert.equal(third.status, 507, third.body.toString('utf8'))
    const same = await jsonCall('POST', `/api/v1/sync/files/${id}/uploads`, { size: next.length }, slotToken, slotAccount, {
      'If-Match': String(JSON.parse(replaced.body.toString('utf8')).revision),
      'X-FaNotes-Meta': meta,
      'X-FaNotes-Sha256': sha256(randomBytes(next.length)),
      'X-FaNotes-Blank': '0',
    })
    assert.equal(same.status, 201, JSON.stringify(same.json))
    assert.equal((await call('DELETE', `/api/v1/sync/files/${id}/uploads/${same.json.uploadId}`, { token: slotToken, accountId: slotAccount })).status, 204)
    assert.deepEqual((await call('GET', `/api/v1/sync/files/${id}`, { token: slotToken, accountId: slotAccount })).body, next)
    assert.equal((await call('GET', `/api/v1/sync/files/${otherId}`, { token: slotToken, accountId: slotAccount })).status, 404)
  } finally {
    delete globalThis.FANOTES_SYNC_FILE_CAP[slotAccount]
  }
})

test('an open upload keeps the file slot it will fill', async () => {
  const holdEmail = `quota-hold-${randomBytes(4).toString('hex')}@example.com`
  const hold = await jsonCall('POST', '/api/v1/sync/register', {
    email: holdEmail,
    authKey,
    kdf: { algorithm: 'pbkdf2-sha256', iterations: 300000, salt: b64(16) },
    vaultKeyWrap: { iv: b64(12), data: b64(32) },
    device: { name: 'Quota hold', platform: 'linux' },
  })
  assert.equal(hold.status, 201, JSON.stringify(hold.json))
  const holdToken = hold.json.token
  const holdAccount = hold.json.accountId
  globalThis.FANOTES_SYNC_FILE_CAP[holdAccount] = 2
  try {
    const put = (id, bytes, base) => call('PUT', `/api/v1/sync/files/${id}`, {
      token: holdToken,
      accountId: holdAccount,
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
    const firstId = randomBytes(32).toString('hex')
    const first = randomBytes(200)
    const created = await put(firstId, first, 0)
    assert.equal(created.status, 200, created.body.toString('utf8'))
    const secondId = randomBytes(32).toString('hex')
    const second = randomBytes(200)
    const opened = await jsonCall('POST', `/api/v1/sync/files/${secondId}/uploads`, { size: second.length }, holdToken, holdAccount, {
      'If-Match': '0',
      'X-FaNotes-Meta': meta,
      'X-FaNotes-Sha256': sha256(second),
      'X-FaNotes-Blank': '0',
    })
    assert.equal(opened.status, 201, JSON.stringify(opened.json))
    const thirdId = randomBytes(32).toString('hex')
    const blocked = await put(thirdId, randomBytes(200), 0)
    assert.equal(blocked.status, 507, blocked.body.toString('utf8'))
    const patched = await call('PATCH', `/api/v1/sync/files/${secondId}/uploads/${opened.json.uploadId}`, {
      token: holdToken,
      accountId: holdAccount,
      body: second,
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(second.length),
        'Upload-Offset': '0',
      },
    })
    assert.equal(patched.status, 200, patched.body.toString('utf8'))
    const finished = await call('POST', `/api/v1/sync/files/${secondId}/uploads/${opened.json.uploadId}/complete`, {
      token: holdToken,
      accountId: holdAccount,
      headers: {
        'Content-Length': '0',
        'If-Match': '0',
        'X-FaNotes-Meta': meta,
        'X-FaNotes-Sha256': sha256(second),
        'X-FaNotes-Blank': '0',
      },
    })
    assert.equal(finished.status, 200, finished.body.toString('utf8'))
    const again = await put(thirdId, randomBytes(200), 0)
    assert.equal(again.status, 507, again.body.toString('utf8'))
    assert.deepEqual((await call('GET', `/api/v1/sync/files/${firstId}`, { token: holdToken, accountId: holdAccount })).body, first)
    assert.deepEqual((await call('GET', `/api/v1/sync/files/${secondId}`, { token: holdToken, accountId: holdAccount })).body, second)
    assert.equal((await call('GET', `/api/v1/sync/files/${thirdId}`, { token: holdToken, accountId: holdAccount })).status, 404)
  } finally {
    delete globalThis.FANOTES_SYNC_FILE_CAP[holdAccount]
  }
})

test.after(() => new Promise((resolve) => {
  server.close(() => {
    rmSync(dataDirectory, { recursive: true, force: true })
    resolve()
  })
}))
