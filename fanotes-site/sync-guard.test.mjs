// Server-side sync guard. Fixtures are anonymous: no real notes, names, or vault keys.
import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { connect as connectTcp } from 'node:net'
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

test('a client that attests a tiny body still has content cannot replace a large note', async () => {
  const id = randomBytes(32).toString('hex')
  const original = randomBytes(5000)
  const created = await putFile(id, original, 0, { 'X-FaNotes-Blank': '0' })
  const revision = JSON.parse(created.body.toString('utf8')).revision
  const shortNote = randomBytes(200)
  const replaced = await putFile(id, shortNote, revision, { 'X-FaNotes-Blank': '0' })
  assert.equal(replaced.status, 409, replaced.body.toString('utf8'))
  assert.deepEqual((await readFile(id)).body, original)
  const quarantined = readdirSync(join(dataDirectory, 'accounts', accountId, 'quarantine', id))
  assert.ok(quarantined.includes(String(revision)))
})

test('a modest shrink of a note is still stored', async () => {
  const id = randomBytes(32).toString('hex')
  const original = randomBytes(8000)
  const created = await putFile(id, original, 0, { 'X-FaNotes-Blank': '0' })
  const revision = JSON.parse(created.body.toString('utf8')).revision
  const edited = randomBytes(5000)
  const replaced = await putFile(id, edited, revision, { 'X-FaNotes-Blank': '0' })
  assert.equal(replaced.status, 200, replaced.body.toString('utf8'))
  assert.deepEqual((await readFile(id)).body, edited)
})

test('a checksum or a short body does not replace the stored note', async () => {
  const id = randomBytes(32).toString('hex')
  const original = randomBytes(80)
  const created = await putFile(id, original, 0, { 'X-FaNotes-Blank': '0' })
  const revision = JSON.parse(created.body.toString('utf8')).revision
  const other = randomBytes(80)
  const badSum = await putFile(id, other, revision, { 'X-FaNotes-Blank': '0', 'X-FaNotes-Sha256': sha256(original) })
  assert.equal(badSum.status, 400)
  // Node's HTTP client adds Content-Length by itself. A raw request is the
  // only way to prove a body with no declared length, or a short body, is refused.
  const rawPut = (head, payload, closeWrite = false) => new Promise((resolve, reject) => {
    const socket = connectTcp(server.address().port, '127.0.0.1', () => {
      const bytes = Buffer.concat([head, payload])
      if (closeWrite) socket.end(bytes)
      else socket.write(bytes)
    })
    const chunks = []
    const timer = setTimeout(() => {
      socket.destroy()
      reject(new Error('raw sync upload timed out'))
    }, 2000)
    socket.on('data', (chunk) => {
      chunks.push(chunk)
      const raw = Buffer.concat(chunks).toString('utf8')
      const match = /^HTTP\/1\.[01] (\d+)/u.exec(raw)
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
  const undeclaredHead = Buffer.from(
    `PUT /api/v1/sync/files/${id} HTTP/1.1\r\n` +
    `Host: 127.0.0.1\r\n` +
    `Authorization: Bearer ${token}\r\n` +
    `X-FaNotes-Account: ${accountId}\r\n` +
    `Content-Type: application/octet-stream\r\n` +
    `Transfer-Encoding: chunked\r\n` +
    `If-Match: ${revision}\r\n` +
    `X-FaNotes-Meta: ${meta}\r\n` +
    `X-FaNotes-Sha256: ${sha256(other)}\r\n` +
    `X-FaNotes-Blank: 0\r\n` +
    `\r\n`,
  )
  const chunked = Buffer.concat([
    Buffer.from(`${other.length.toString(16)}\r\n`),
    other,
    Buffer.from('\r\n0\r\n\r\n'),
  ])
  assert.equal(await rawPut(undeclaredHead, chunked), 400)
  const shortHead = Buffer.from(
    `PUT /api/v1/sync/files/${id} HTTP/1.1\r\n` +
    `Host: 127.0.0.1\r\n` +
    `Authorization: Bearer ${token}\r\n` +
    `X-FaNotes-Account: ${accountId}\r\n` +
    `Content-Type: application/octet-stream\r\n` +
    `Content-Length: ${other.length + 40}\r\n` +
    `If-Match: ${revision}\r\n` +
    `X-FaNotes-Meta: ${meta}\r\n` +
    `X-FaNotes-Sha256: ${sha256(other)}\r\n` +
    `X-FaNotes-Blank: 0\r\n` +
    `Connection: close\r\n\r\n`,
  )
  assert.equal(await rawPut(shortHead, other, true), 400)
  assert.deepEqual((await readFile(id)).body, original)
})

test('a delete without the explicit header does not tombstone the note', async () => {
  const id = randomBytes(32).toString('hex')
  const original = randomBytes(80)
  const created = await putFile(id, original, 0, { 'X-FaNotes-Blank': '0' })
  const revision = JSON.parse(created.body.toString('utf8')).revision
  const blocked = await call('DELETE', `/api/v1/sync/files/${id}`, {
    token,
    headers: { 'If-Match': String(revision) },
  })
  assert.equal(blocked.status, 428)
  assert.deepEqual((await readFile(id)).body, original)
  const removed = await call('DELETE', `/api/v1/sync/files/${id}`, {
    token,
    headers: { 'If-Match': String(revision), 'X-FaNotes-Delete': '1' },
  })
  assert.equal(removed.status, 200, removed.body.toString('utf8'))
  const tombstone = await readFile(id)
  assert.equal(tombstone.status, 204)
})

test('an archived revision can be restored without dropping the bad copy', async () => {
  const id = randomBytes(32).toString('hex')
  const original = randomBytes(5000)
  const created = await putFile(id, original, 0, { 'X-FaNotes-Blank': '0' })
  const revision = JSON.parse(created.body.toString('utf8')).revision
  const blank = randomBytes(200)
  const cleared = await putFile(id, blank, revision, { 'X-FaNotes-Blank': '1', 'X-FaNotes-Clear': '1' })
  assert.equal(cleared.status, 200, cleared.body.toString('utf8'))
  const current = JSON.parse(cleared.body.toString('utf8')).revision
  const names = readdirSync(join(dataDirectory, 'accounts', accountId, 'revisions', id))
  const archived = names.map((name) => Number(name.replace(/^c-/u, ''))).find((value) => value === revision)
  assert.equal(archived, revision)
  const body = Buffer.from(JSON.stringify({ revision }))
  const restored = await call('POST', `/api/v1/sync/files/${id}/restore`, {
    token,
    body,
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': body.length,
      'If-Match': String(current),
    },
  })
  assert.equal(restored.status, 200, restored.body.toString('utf8'))
  assert.deepEqual((await readFile(id)).body, original)
  const kept = readdirSync(join(dataDirectory, 'accounts', accountId, 'revisions', id))
  assert.ok(kept.length >= 1)
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
