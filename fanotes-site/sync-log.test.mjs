// Sync access logs are one JSON line per request. They must not carry a note,
// a token, a cookie, an email, or encrypted metadata.
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { createServer, request as httpRequest } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

const dataDirectory = mkdtempSync(join(tmpdir(), 'fanotes-sync-log-'))
process.env.FANOTES_SYNC_DIR = dataDirectory
process.env.FANOTES_PUBLIC_ORIGIN = 'http://127.0.0.1'
const { handleSyncRequest, syncFailureCode, syncRequestId, syncRouteTemplate } = await import('./sync-api.mjs')

const captured = []
const originalLog = console.log
const originalError = console.error
const keepSyncLine = (args, original) => {
  const text = args.map((item) => (typeof item === 'string' ? item : JSON.stringify(item))).join(' ')
  if (text.includes('"msg":"sync"')) captured.push(text)
  else original(...args)
}
console.log = (...args) => keepSyncLine(args, originalLog)
console.error = (...args) => keepSyncLine(args, originalError)

const server = createServer(async (request, response) => {
  const url = new URL(request.url, 'http://127.0.0.1')
  if (await handleSyncRequest(request, response, url)) return
  response.writeHead(404)
  response.end()
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const origin = `http://127.0.0.1:${server.address().port}`

const b64 = (size) => randomBytes(size).toString('base64')
const email = 'log-secret@example.com'
const authKey = b64(32)
const meta = b64(48)
const noteMarker = 'NOTEBODYMARKER-secret-note'

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

const takeLogs = () => {
  const lines = captured.splice(0)
  return lines.map((line) => JSON.parse(line))
}

test('a route template drops ids and anything that is not a path', () => {
  const fileId = 'ab'.repeat(32)
  const uploadId = 'cd'.repeat(16)
  const deviceId = 'ef'.repeat(12)
  assert.equal(syncRouteTemplate(`/files/${fileId}/uploads/${uploadId}/complete`), '/files/:id/uploads/:uploadId/complete')
  assert.equal(syncRouteTemplate(`/devices/${deviceId}?token=secret`), '/devices/:deviceId')
  assert.equal(syncRouteTemplate(`/prelogin/${email}`), '/prelogin/log-secret_example.com')
  assert.equal(syncFailureCode({ code: 'ENOENT', message: `/var/lib/fanotes-sync/blobs/${fileId}` }), 'ENOENT')
  assert.equal(syncFailureCode({ message: `secret ${email}` }), 'INTERNAL')
  assert.equal(syncFailureCode({ code: 'has spaces and a note' }), 'INTERNAL')
  const token = 'BearerToken0123456789abcdef'
  assert.equal(syncRequestId({ headers: { 'x-request-id': 'req-safe-01', authorization: `Bearer ${token}` } }), 'req-safe-01')
  assert.notEqual(syncRequestId({ headers: { 'x-request-id': token, authorization: `Bearer ${token}` } }), token)
  assert.notEqual(syncRequestId({ headers: { 'x-request-id': 'short' } }), 'short')
})

test('a sync log names the route and never the note, token, cookie, or email', async () => {
  const prelogin = await jsonCall('POST', '/api/v1/sync/prelogin', { email })
  assert.equal(prelogin.status, 200, JSON.stringify(prelogin.json))
  const preloginLog = takeLogs()
  assert.equal(preloginLog.length, 1)
  assert.equal(preloginLog[0].route, '/prelogin')
  assert.equal(preloginLog[0].status, 200)
  assert.equal(JSON.stringify(preloginLog).includes(email), false)
  assert.equal(prelogin.headers['x-request-id']?.length >= 8, true)

  const registered = await jsonCall('POST', '/api/v1/sync/register', {
    email,
    authKey,
    kdf: { algorithm: 'pbkdf2-sha256', iterations: 300000, salt: b64(16) },
    vaultKeyWrap: { iv: b64(12), data: b64(32) },
    device: { name: 'Log', platform: 'linux' },
  })
  assert.equal(registered.status, 201, JSON.stringify(registered.json))
  const token = registered.json.token
  const accountId = registered.json.accountId
  const registerLog = JSON.stringify(takeLogs())
  assert.equal(registerLog.includes(email), false)
  assert.equal(registerLog.includes(authKey), false)
  assert.equal(registerLog.includes(token), false)

  const fileId = randomBytes(32).toString('hex')
  const note = Buffer.concat([Buffer.from(noteMarker), randomBytes(32)])
  const created = await call('PUT', `/api/v1/sync/files/${fileId}?leak=${email}`, {
    token,
    accountId,
    body: note,
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(note.length),
      'If-Match': '0',
      'X-FaNotes-Meta': meta,
      'X-FaNotes-Sha256': (await import('node:crypto')).createHash('sha256').update(note).digest('hex'),
      'X-FaNotes-Blank': '0',
      'X-Request-Id': 'req-log-test-0001',
      Cookie: `session=${token}`,
    },
  })
  assert.equal(created.status, 200, created.body.toString('utf8'))
  assert.equal(created.headers['x-request-id'], 'req-log-test-0001')
  const putLog = takeLogs()
  assert.equal(putLog.length, 1)
  assert.equal(putLog[0].requestId, 'req-log-test-0001')
  assert.equal(putLog[0].method, 'PUT')
  assert.equal(putLog[0].route, '/files/:id')
  assert.equal(putLog[0].status, 200)
  assert.equal(putLog[0].account, accountId)
  assert.equal(typeof putLog[0].durationMs, 'number')
  const putText = JSON.stringify(putLog)
  for (const secret of [email, authKey, token, meta, noteMarker, fileId]) {
    assert.equal(putText.includes(secret), false, secret)
  }

  const rejected = await call('GET', `/api/v1/sync/files/${fileId}`, {
    headers: { Authorization: `Bearer ${token}`, 'X-Request-Id': token, Cookie: `session=${token}` },
  })
  assert.notEqual(rejected.headers['x-request-id'], token)
  const rejectedText = JSON.stringify(takeLogs())
  assert.equal(rejectedText.includes(token), false)
  assert.equal(rejectedText.includes(fileId), false)
})

test.after(() => new Promise((resolve) => {
  console.log = originalLog
  console.error = originalError
  server.close(() => {
    rmSync(dataDirectory, { recursive: true, force: true })
    resolve()
  })
}))
