// Integrity report and resumable uploads. Bodies are anonymous bytes.
import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { createServer, request as httpRequest } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { connect as connectTcp } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

const dataDirectory = mkdtempSync(join(tmpdir(), 'fanotes-sync-integrity-'))
process.env.FANOTES_SYNC_DIR = dataDirectory
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
const port = server.address().port

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
    response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks) }))
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
  return { status: response.status, json: JSON.parse(response.body.toString('utf8')), headers: response.headers }
}

const registered = await jsonCall('POST', '/api/v1/sync/register', {
  email: 'integrity@example.com',
  authKey,
  kdf: { algorithm: 'pbkdf2-sha256', iterations: 300000, salt: b64(16) },
  vaultKeyWrap: { iv: b64(12), data: b64(32) },
  device: { name: 'Check', platform: 'linux' },
})
assert.equal(registered.status, 201, JSON.stringify(registered.json))
const token = registered.json.token
const accountId = registered.json.accountId

const putFile = (id, bytes, base, headers = {}) => call('PUT', `/api/v1/sync/files/${id}`, {
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
    ...headers,
  },
})

const startUpload = async (id, bytes, base) => {
  const opened = await jsonCall('POST', `/api/v1/sync/files/${id}/uploads`, { size: bytes.length }, token, accountId, {
    'If-Match': String(base),
    'X-FaNotes-Meta': meta,
    'X-FaNotes-Sha256': sha256(bytes),
    'X-FaNotes-Blank': '0',
  })
  assert.equal(opened.status, 201, JSON.stringify(opened.json))
  return opened.json
}

const patchUpload = (id, uploadId, bytes, offset) => call('PATCH', `/api/v1/sync/files/${id}/uploads/${uploadId}`, {
  token,
  accountId,
  body: bytes,
  headers: {
    'Content-Type': 'application/octet-stream',
    'Content-Length': String(bytes.length),
    'Upload-Offset': String(offset),
  },
})

const finishUpload = (id, uploadId, bytes, base) => call('POST', `/api/v1/sync/files/${id}/uploads/${uploadId}/complete`, {
  token,
  accountId,
  headers: {
    'Content-Length': '0',
    'If-Match': String(base),
    'X-FaNotes-Meta': meta,
    'X-FaNotes-Sha256': sha256(bytes),
    'X-FaNotes-Blank': '0',
  },
})

test.after(() => new Promise((resolve) => {
  server.close(() => {
    rmSync(dataDirectory, { recursive: true, force: true })
    resolve()
  })
}))

test('a resumable upload survives a truncated patch and does not replace a note until it is complete', async () => {
  const id = randomBytes(32).toString('hex')
  const original = randomBytes(5000)
  const created = await putFile(id, original, 0)
  assert.equal(created.status, 200, created.body.toString('utf8'))
  const revision = JSON.parse(created.body.toString('utf8')).revision

  const next = randomBytes(9000)
  const upload = await startUpload(id, next, revision)
  const first = next.subarray(0, 3000)
  const second = next.subarray(3000, 6000)
  const third = next.subarray(6000)
  const part = await patchUpload(id, upload.uploadId, first, 0)
  assert.equal(part.status, 200, part.body.toString('utf8'))
  assert.equal(JSON.parse(part.body.toString('utf8')).offset, 3000)

  const truncated = await new Promise((resolve, reject) => {
    const socket = connectTcp(port, '127.0.0.1', () => {
      const head = Buffer.from(
        `PATCH /api/v1/sync/files/${id}/uploads/${upload.uploadId} HTTP/1.1\r\n` +
        `Host: 127.0.0.1\r\n` +
        `Authorization: Bearer ${token}\r\n` +
        `X-FaNotes-Account: ${accountId}\r\n` +
        `Content-Type: application/octet-stream\r\n` +
        `Content-Length: ${second.length + 50}\r\n` +
        `Upload-Offset: 3000\r\n` +
        `Connection: close\r\n\r\n`,
      )
      socket.end(Buffer.concat([head, second]))
    })
    const chunks = []
    const timer = setTimeout(() => {
      socket.destroy()
      reject(new Error('truncated patch timed out'))
    }, 2000)
    socket.on('data', (chunk) => {
      chunks.push(chunk)
      const match = /^HTTP\/1\.[01] (\d+)/u.exec(Buffer.concat(chunks).toString('utf8'))
      if (!match) return
      clearTimeout(timer)
      socket.end()
      resolve(Number(match[1]))
    })
    socket.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
  })
  assert.equal(truncated, 400)
  const status = await call('GET', `/api/v1/sync/files/${id}/uploads/${upload.uploadId}`, { token, accountId })
  assert.equal(JSON.parse(status.body.toString('utf8')).offset, 3000)
  const live = await call('GET', `/api/v1/sync/files/${id}`, { token, accountId })
  assert.deepEqual(live.body, original)

  const wrong = await patchUpload(id, upload.uploadId, second, 0)
  assert.equal(wrong.status, 409)
  assert.equal(JSON.parse(wrong.body.toString('utf8')).reason, 'offset')
  assert.equal(JSON.parse(wrong.body.toString('utf8')).offset, 3000)

  const early = await finishUpload(id, upload.uploadId, next, revision)
  assert.equal(early.status, 409)
  assert.equal(JSON.parse(early.body.toString('utf8')).reason, 'incomplete')
  assert.deepEqual((await call('GET', `/api/v1/sync/files/${id}`, { token, accountId })).body, original)

  assert.equal((await patchUpload(id, upload.uploadId, second, 3000)).status, 200)
  assert.equal((await patchUpload(id, upload.uploadId, third, 6000)).status, 200)
  const done = await finishUpload(id, upload.uploadId, next, revision)
  assert.equal(done.status, 200, done.body.toString('utf8'))
  assert.deepEqual((await call('GET', `/api/v1/sync/files/${id}`, { token, accountId })).body, next)
  const currentRevision = JSON.parse(done.body.toString('utf8')).revision

  const mismatched = randomBytes(9000)
  const badUpload = await startUpload(id, mismatched, currentRevision)
  assert.equal((await patchUpload(id, badUpload.uploadId, mismatched, 0)).status, 200)
  const partialBody = join(dataDirectory, 'accounts', accountId, 'partials', badUpload.uploadId, 'body.bin')
  const flipped = readFileSync(partialBody)
  flipped[0] ^= 0xff
  writeFileSync(partialBody, flipped)
  const damaged = await finishUpload(id, badUpload.uploadId, mismatched, currentRevision)
  assert.equal(damaged.status, 400, damaged.body.toString('utf8'))
  assert.deepEqual((await call('GET', `/api/v1/sync/files/${id}`, { token, accountId })).body, next)
  const stillThere = await call('GET', `/api/v1/sync/files/${id}/uploads/${badUpload.uploadId}`, { token, accountId })
  assert.equal(stillThere.status, 200)
  const aborted = await call('DELETE', `/api/v1/sync/files/${id}/uploads/${badUpload.uploadId}`, { token, accountId })
  assert.equal(aborted.status, 204)
  assert.equal((await call('GET', `/api/v1/sync/files/${id}/uploads/${badUpload.uploadId}`, { token, accountId })).status, 404)
  assert.deepEqual((await call('GET', `/api/v1/sync/files/${id}`, { token, accountId })).body, next)
  assert.equal(existsSync(partialBody), false)

  const raced = randomBytes(9000)
  const pending = await startUpload(id, raced, currentRevision)
  assert.equal((await patchUpload(id, pending.uploadId, raced, 0)).status, 200)
  const newer = randomBytes(9000)
  const overwrote = await putFile(id, newer, currentRevision)
  assert.equal(overwrote.status, 200, overwrote.body.toString('utf8'))
  const stale = await finishUpload(id, pending.uploadId, raced, currentRevision)
  assert.equal(stale.status, 409)
  assert.equal(JSON.parse(stale.body.toString('utf8')).reason, 'stale')
  assert.deepEqual((await call('GET', `/api/v1/sync/files/${id}`, { token, accountId })).body, newer)
  assert.equal((await call('GET', `/api/v1/sync/files/${id}/uploads/${pending.uploadId}`, { token, accountId })).status, 200)
  assert.equal((await call('DELETE', `/api/v1/sync/files/${id}/uploads/${pending.uploadId}`, { token, accountId })).status, 204)

  const bad = randomBytes(200)
  const rejected = await startUpload(id, bad, JSON.parse(overwrote.body.toString('utf8')).revision)
  assert.equal((await patchUpload(id, rejected.uploadId, bad, 0)).status, 200)
  const blocked = await finishUpload(id, rejected.uploadId, bad, JSON.parse(overwrote.body.toString('utf8')).revision)
  assert.equal(blocked.status, 409)
  assert.equal(JSON.parse(blocked.body.toString('utf8')).reason, 'guard')
  assert.deepEqual((await call('GET', `/api/v1/sync/files/${id}`, { token, accountId })).body, newer)
})

test('completing a removed upload records the blob already in the live slot', async () => {
  const id = randomBytes(32).toString('hex')
  const original = randomBytes(5000)
  const created = await putFile(id, original, 0)
  assert.equal(created.status, 200, created.body.toString('utf8'))
  const revision = JSON.parse(created.body.toString('utf8')).revision
  const next = randomBytes(5000)
  const directory = join(dataDirectory, 'accounts', accountId, 'revisions', id)
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, String(revision)), original)
  writeFileSync(join(dataDirectory, 'accounts', accountId, 'blobs', id), next)
  const uploadId = randomBytes(16).toString('hex')
  const finished = await finishUpload(id, uploadId, next, revision)
  assert.equal(finished.status, 200, finished.body.toString('utf8'))
  const recorded = JSON.parse(finished.body.toString('utf8')).revision
  assert.ok(recorded > revision)
  assert.deepEqual(readFileSync(join(directory, String(revision))), original)
  assert.deepEqual((await call('GET', `/api/v1/sync/files/${id}`, { token, accountId })).body, next)
  const again = await finishUpload(id, uploadId, next, revision)
  assert.equal(again.status, 409, again.body.toString('utf8'))
  assert.equal(JSON.parse(again.body.toString('utf8')).reason, 'stale')
  assert.deepEqual(readFileSync(join(directory, String(revision))), original)
  const unknown = randomBytes(16).toString('hex')
  const missing = await finishUpload(id, unknown, randomBytes(5000), recorded)
  assert.equal(missing.status, 404, missing.body.toString('utf8'))
  assert.deepEqual((await call('GET', `/api/v1/sync/files/${id}`, { token, accountId })).body, next)
})

test('a complete does not replace a newer live blob the log has not recorded', async () => {
  const id = randomBytes(32).toString('hex')
  const original = randomBytes(5000)
  const created = await putFile(id, original, 0)
  assert.equal(created.status, 200, created.body.toString('utf8'))
  const revision = JSON.parse(created.body.toString('utf8')).revision
  const newer = randomBytes(5000)
  const other = randomBytes(4500)
  const upload = await startUpload(id, other, revision)
  assert.equal((await patchUpload(id, upload.uploadId, other, 0)).status, 200)
  const blobPath = join(dataDirectory, 'accounts', accountId, 'blobs', id)
  const archive = join(dataDirectory, 'accounts', accountId, 'revisions', id)
  mkdirSync(archive, { recursive: true })
  writeFileSync(join(archive, String(revision)), original)
  writeFileSync(blobPath, newer)
  const blocked = await finishUpload(id, upload.uploadId, other, revision)
  assert.equal(blocked.status, 409, blocked.body.toString('utf8'))
  assert.equal(JSON.parse(blocked.body.toString('utf8')).reason, 'stale')
  assert.deepEqual(readFileSync(blobPath), newer)
  assert.deepEqual(readFileSync(join(archive, String(revision))), original)
  assert.deepEqual((await call('GET', `/api/v1/sync/files/${id}`, { token, accountId })).body, newer)
  assert.equal((await call('GET', `/api/v1/sync/files/${id}/uploads/${upload.uploadId}`, { token, accountId })).status, 200)
})

test('a complete does not replace a resurrection the log has not recorded', async () => {
  const id = randomBytes(32).toString('hex')
  const original = randomBytes(5000)
  const created = await putFile(id, original, 0)
  assert.equal(created.status, 200, created.body.toString('utf8'))
  const removed = await call('DELETE', `/api/v1/sync/files/${id}`, {
    token,
    accountId,
    headers: { 'If-Match': String(JSON.parse(created.body.toString('utf8')).revision), 'X-FaNotes-Delete': '1' },
  })
  assert.equal(removed.status, 200, removed.body.toString('utf8'))
  const tombstone = JSON.parse(removed.body.toString('utf8')).revision
  const planted = randomBytes(4800)
  const blobPath = join(dataDirectory, 'accounts', accountId, 'blobs', id)
  writeFileSync(blobPath, planted)
  const other = randomBytes(4300)
  const upload = await startUpload(id, other, tombstone)
  assert.equal((await patchUpload(id, upload.uploadId, other, 0)).status, 200)
  const blocked = await finishUpload(id, upload.uploadId, other, tombstone)
  assert.equal(blocked.status, 409, blocked.body.toString('utf8'))
  assert.equal(JSON.parse(blocked.body.toString('utf8')).reason, 'stale')
  assert.deepEqual(readFileSync(blobPath), planted)
  assert.equal((await call('GET', `/api/v1/sync/files/${id}`, { token, accountId })).status, 204)
  assert.equal((await call('GET', `/api/v1/sync/files/${id}/uploads/${upload.uploadId}`, { token, accountId })).status, 200)
  const recorded = await putFile(id, planted, tombstone)
  assert.equal(recorded.status, 200, recorded.body.toString('utf8'))
  assert.deepEqual((await call('GET', `/api/v1/sync/files/${id}`, { token, accountId })).body, planted)
  assert.equal((await call('DELETE', `/api/v1/sync/files/${id}/uploads/${upload.uploadId}`, { token, accountId })).status, 204)
})

test('completing an upload whose body was already renamed records that live blob', async () => {
  const id = randomBytes(32).toString('hex')
  const original = randomBytes(5000)
  const created = await putFile(id, original, 0)
  assert.equal(created.status, 200, created.body.toString('utf8'))
  const revision = JSON.parse(created.body.toString('utf8')).revision
  const newer = randomBytes(5200)
  const upload = await startUpload(id, newer, revision)
  assert.equal((await patchUpload(id, upload.uploadId, newer, 0)).status, 200)
  const blobPath = join(dataDirectory, 'accounts', accountId, 'blobs', id)
  const archive = join(dataDirectory, 'accounts', accountId, 'revisions', id)
  const partialBody = join(dataDirectory, 'accounts', accountId, 'partials', upload.uploadId, 'body.bin')
  mkdirSync(archive, { recursive: true })
  writeFileSync(join(archive, String(revision)), original)
  renameSync(partialBody, blobPath)
  const finished = await finishUpload(id, upload.uploadId, newer, revision)
  assert.equal(finished.status, 200, finished.body.toString('utf8'))
  assert.ok(JSON.parse(finished.body.toString('utf8')).revision > revision)
  assert.deepEqual(readFileSync(blobPath), newer)
  assert.deepEqual(readFileSync(join(archive, String(revision))), original)
  assert.equal(existsSync(join(dataDirectory, 'accounts', accountId, 'partials', upload.uploadId)), false)
  assert.deepEqual((await call('GET', `/api/v1/sync/files/${id}`, { token, accountId })).body, newer)
})

test('the integrity report names damaged and orphaned blobs and deletes nothing', async () => {
  const id = randomBytes(32).toString('hex')
  const original = randomBytes(400)
  const created = await putFile(id, original, 0)
  assert.equal(created.status, 200, created.body.toString('utf8'))
  const before = await jsonCall('GET', '/api/v1/sync/integrity', {}, token, accountId)
  assert.equal(before.status, 200)
  assert.equal(before.json.ok, true, JSON.stringify(before.json))
  assert.equal(JSON.stringify(before.json).includes(meta), false)

  const blobPath = join(dataDirectory, 'accounts', accountId, 'blobs', id)
  const bytes = readFileSync(blobPath)
  bytes[bytes.length - 1] ^= 0xff
  writeFileSync(blobPath, bytes)
  const orphanId = 'ab'.repeat(32)
  const orphanPath = join(dataDirectory, 'accounts', accountId, 'blobs', orphanId)
  writeFileSync(orphanPath, randomBytes(40))
  const namesBefore = readdirSync(join(dataDirectory, 'accounts', accountId, 'blobs')).sort()

  const damaged = await jsonCall('GET', '/api/v1/sync/integrity', {}, token, accountId)
  assert.equal(damaged.json.ok, false)
  assert.ok(damaged.json.hashMismatch.some((item) => item.id === id))
  assert.ok(damaged.json.blobsOrphan.some((item) => item.id === orphanId))
  assert.deepEqual(readdirSync(join(dataDirectory, 'accounts', accountId, 'blobs')).sort(), namesBefore)
  assert.ok(existsSync(blobPath))
  assert.ok(existsSync(orphanPath))
  const fetched = await call('GET', `/api/v1/sync/files/${id}`, { token, accountId })
  assert.deepEqual(fetched.body, bytes)

  rmSync(blobPath)
  const missing = await jsonCall('GET', '/api/v1/sync/integrity', {}, token, accountId)
  assert.ok(missing.json.blobsMissing.some((item) => item.id === id))
  assert.equal(existsSync(blobPath), false)
  const changes = await jsonCall('GET', '/api/v1/sync/changes?since=0', {}, token, accountId)
  assert.ok(changes.json.entries.some((entry) => entry.id === id && entry.deleted === false))

  const doomed = randomBytes(32).toString('hex')
  const kept = randomBytes(300)
  const stored = await putFile(doomed, kept, 0)
  assert.equal(stored.status, 200, stored.body.toString('utf8'))
  const doomedRevision = JSON.parse(stored.body.toString('utf8')).revision
  const removed = await call('DELETE', `/api/v1/sync/files/${doomed}`, {
    token,
    accountId,
    headers: { 'If-Match': String(doomedRevision), 'X-FaNotes-Delete': '1' },
  })
  assert.equal(removed.status, 200, removed.body.toString('utf8'))
  const tombstoneBlob = join(dataDirectory, 'accounts', accountId, 'blobs', doomed)
  writeFileSync(tombstoneBlob, kept)
  const leftover = await jsonCall('GET', '/api/v1/sync/integrity', {}, token, accountId)
  assert.ok(leftover.json.blobsOrphan.some((item) => item.id === doomed && item.deleted === true))
  assert.equal(existsSync(tombstoneBlob), true)
  const tombstone = await call('GET', `/api/v1/sync/files/${doomed}`, { token, accountId })
  assert.equal(tombstone.status, 204)
  assert.equal(tombstone.headers['x-fanotes-deleted'], '1')
})
