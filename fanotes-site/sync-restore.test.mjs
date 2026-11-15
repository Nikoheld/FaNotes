// A restore must count reserved partials and must not grow history when it is refused.
import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { createServer, request as httpRequest } from 'node:http'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

const dataDirectory = mkdtempSync(join(tmpdir(), 'fanotes-sync-restore-'))
process.env.FANOTES_SYNC_DIR = dataDirectory
process.env.FANOTES_SYNC_QUOTA_BYTES = '2500'
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
  email: 'restore-quota@example.com',
  authKey,
  kdf: { algorithm: 'pbkdf2-sha256', iterations: 300000, salt: b64(16) },
  vaultKeyWrap: { iv: b64(12), data: b64(32) },
  device: { name: 'Restore', platform: 'linux' },
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

const restore = (id, revision, base) => {
  const body = Buffer.from(JSON.stringify({ revision }))
  return call('POST', `/api/v1/sync/files/${id}/restore`, {
    token,
    accountId,
    body,
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': String(body.length),
      'If-Match': String(base),
    },
  })
}

test('a restore cannot spend space a partial upload has already reserved', async () => {
  const id = randomBytes(32).toString('hex')
  const otherId = randomBytes(32).toString('hex')
  const original = randomBytes(900)
  const shrunk = randomBytes(200)
  const created = await putFile(id, original, 0)
  assert.equal(created.status, 200, created.body.toString('utf8'))
  const archivedRevision = JSON.parse(created.body.toString('utf8')).revision
  const shrunkPut = await putFile(id, shrunk, archivedRevision)
  assert.equal(shrunkPut.status, 200, shrunkPut.body.toString('utf8'))
  const current = JSON.parse(shrunkPut.body.toString('utf8')).revision
  const archive = join(dataDirectory, 'accounts', accountId, 'revisions', id)
  const before = readdirSync(archive).sort()

  const reserved = await jsonCall('POST', `/api/v1/sync/files/${otherId}/uploads`, { size: 700 }, token, accountId, {
    'If-Match': '0',
    'X-FaNotes-Meta': meta,
    'X-FaNotes-Sha256': sha256(randomBytes(700)),
    'X-FaNotes-Blank': '0',
  })
  assert.equal(reserved.status, 201, JSON.stringify(reserved.json))

  const blocked = await restore(id, archivedRevision, current)
  assert.equal(blocked.status, 507, blocked.body.toString('utf8'))
  assert.deepEqual(readdirSync(archive).sort(), before)
  assert.deepEqual((await call('GET', `/api/v1/sync/files/${id}`, { token, accountId })).body, shrunk)

  const aborted = await call('DELETE', `/api/v1/sync/files/${otherId}/uploads/${reserved.json.uploadId}`, { token, accountId })
  assert.equal(aborted.status, 204, aborted.body.toString('utf8'))
  const restored = await restore(id, archivedRevision, current)
  assert.equal(restored.status, 200, restored.body.toString('utf8'))
  assert.deepEqual((await call('GET', `/api/v1/sync/files/${id}`, { token, accountId })).body, original)
  assert.ok(readdirSync(archive).length >= before.length)
})

test.after(() => new Promise((resolve) => {
  server.close(() => {
    rmSync(dataDirectory, { recursive: true, force: true })
    resolve()
  })
}))
