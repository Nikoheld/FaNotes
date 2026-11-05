// Server-side sync guard. Fixtures are anonymous: no real notes, names, or vault keys.
import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

const dataDirectory = mkdtempSync(join(tmpdir(), 'fanotes-sync-guard-'))
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

const b64 = (size) => randomBytes(size).toString('base64')
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')

const call = (method, path, { token, headers = {}, body } = {}) => new Promise((resolve, reject) => {
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
    response.on('end', () => resolve({
      status: response.statusCode,
      headers: response.headers,
      body: Buffer.concat(chunks),
    }))
  })
  req.on('error', reject)
  if (body) req.end(body)
  else req.end()
})

const jsonCall = async (method, path, payload, token) => {
  const body = Buffer.from(JSON.stringify(payload))
  const response = await call(method, path, {
    token,
    body,
    headers: { 'Content-Type': 'application/json', 'Content-Length': body.length },
  })
  return { status: response.status, json: JSON.parse(response.body.toString('utf8')) }
}

const registered = await jsonCall('POST', '/api/v1/sync/register', {
  email: 'notes@example.com',
  authKey: b64(32),
  kdf: { algorithm: 'pbkdf2-sha256', iterations: 300000, salt: b64(16) },
  vaultKeyWrap: { iv: b64(12), data: b64(32) },
  device: { name: 'Check', platform: 'linux' },
})
assert.equal(registered.status, 201, JSON.stringify(registered.json))
const token = registered.json.token
const accountId = registered.json.accountId
const meta = b64(32)

const putFile = (id, bytes, base, headers) => call('PUT', `/api/v1/sync/files/${id}`, {
  token,
  body: bytes,
  headers: {
    'Content-Type': 'application/octet-stream',
    'Content-Length': bytes.length,
    'If-Match': String(base),
    'X-FaNotes-Meta': meta,
    'X-FaNotes-Sha256': sha256(bytes),
    ...headers,
  },
})

const readFile = async (id) => {
  const response = await call('GET', `/api/v1/sync/files/${id}`, { token })
  return response
}

test.after(() => new Promise((resolve) => {
  server.close(() => {
    rmSync(dataDirectory, { recursive: true, force: true })
    resolve()
  })
}))

test('a blank upload does not replace a note unless the editor cleared it', async () => {
  const id = randomBytes(32).toString('hex')
  const original = randomBytes(5000)
  const created = await putFile(id, original, 0, { 'X-FaNotes-Blank': '0' })
  assert.equal(created.status, 200, created.body.toString('utf8'))
  const revision = JSON.parse(created.body.toString('utf8')).revision
  const tiny = randomBytes(200)
  const blocked = await putFile(id, tiny, revision, { 'X-FaNotes-Blank': '1' })
  assert.equal(blocked.status, 409)
  const live = await readFile(id)
  assert.equal(live.status, 200)
  assert.deepEqual(live.body, original)
})

test('an older client that shrinks a large note to a tiny body is rejected', async () => {
  const id = randomBytes(32).toString('hex')
  const original = randomBytes(5000)
  const created = await putFile(id, original, 0, {})
  assert.equal(created.status, 200, created.body.toString('utf8'))
  const revision = JSON.parse(created.body.toString('utf8')).revision
  const blocked = await putFile(id, randomBytes(200), revision, {})
  assert.equal(blocked.status, 409)
  assert.deepEqual((await readFile(id)).body, original)
})

test('a client that attests the short body still has content may replace a large note', async () => {
  const id = randomBytes(32).toString('hex')
  const original = randomBytes(5000)
  const created = await putFile(id, original, 0, { 'X-FaNotes-Blank': '0' })
  const revision = JSON.parse(created.body.toString('utf8')).revision
  const shortNote = randomBytes(200)
  const replaced = await putFile(id, shortNote, revision, { 'X-FaNotes-Blank': '0' })
  assert.equal(replaced.status, 200, replaced.body.toString('utf8'))
  assert.deepEqual((await readFile(id)).body, shortNote)
})

test('a stale base revision is rejected and the body stays', async () => {
  const id = randomBytes(32).toString('hex')
  const original = randomBytes(80)
  const created = await putFile(id, original, 0, { 'X-FaNotes-Blank': '0' })
  assert.equal(created.status, 200)
  const second = randomBytes(80)
  const stale = await putFile(id, second, 0, { 'X-FaNotes-Blank': '0' })
  assert.equal(stale.status, 409)
  assert.deepEqual((await readFile(id)).body, original)
})

test('an explicit clear keeps the previous blob in the revision archive', async () => {
  const id = randomBytes(32).toString('hex')
  const original = randomBytes(5000)
  const created = await putFile(id, original, 0, { 'X-FaNotes-Blank': '0' })
  const revision = JSON.parse(created.body.toString('utf8')).revision
  const blank = randomBytes(200)
  const cleared = await putFile(id, blank, revision, { 'X-FaNotes-Blank': '1', 'X-FaNotes-Clear': '1' })
  assert.equal(cleared.status, 200, cleared.body.toString('utf8'))
  assert.deepEqual((await readFile(id)).body, blank)
  const names = readdirSync(join(dataDirectory, 'accounts', accountId, 'revisions', id))
  assert.ok(names.some((name) => name.startsWith('c-')))
  const archived = names.map((name) => readFileSync(join(dataDirectory, 'accounts', accountId, 'revisions', id, name)))
  assert.ok(archived.some((bytes) => bytes.equals(original)))
})
