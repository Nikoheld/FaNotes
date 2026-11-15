// Server-side sync guard. Fixtures are anonymous: no real notes, names, or vault keys.
import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
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

test('a replaced note is flushed to the archive before the live blob changes', async () => {
  const id = randomBytes(32).toString('hex')
  const original = randomBytes(5000)
  const created = await putFile(id, original, 0, { 'X-FaNotes-Blank': '0' })
  assert.equal(created.status, 200, created.body.toString('utf8'))
  const revision = JSON.parse(created.body.toString('utf8')).revision
  const next = randomBytes(5000)
  const replaced = await putFile(id, next, revision, { 'X-FaNotes-Blank': '0' })
  assert.equal(replaced.status, 200, replaced.body.toString('utf8'))
  const archived = readFileSync(join(dataDirectory, 'accounts', accountId, 'revisions', id, String(revision)))
  assert.deepEqual(archived, original)
  assert.deepEqual((await readFile(id)).body, next)
})

test('a retry keeps the archived revision when the live blob was already replaced', async () => {
  const id = randomBytes(32).toString('hex')
  const original = randomBytes(5000)
  const created = await putFile(id, original, 0, { 'X-FaNotes-Blank': '0' })
  assert.equal(created.status, 200, created.body.toString('utf8'))
  const revision = JSON.parse(created.body.toString('utf8')).revision
  const next = randomBytes(5000)
  const directory = join(dataDirectory, 'accounts', accountId, 'revisions', id)
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, String(revision)), original)
  writeFileSync(join(dataDirectory, 'accounts', accountId, 'blobs', id), next)
  const replaced = await putFile(id, next, revision, { 'X-FaNotes-Blank': '0' })
  assert.equal(replaced.status, 200, replaced.body.toString('utf8'))
  assert.deepEqual(readFileSync(join(directory, String(revision))), original)
  assert.deepEqual((await readFile(id)).body, next)
})

test('a retry keeps a collapsed archive when the live blob was already replaced', async () => {
  const id = randomBytes(32).toString('hex')
  const original = randomBytes(5000)
  const created = await putFile(id, original, 0, { 'X-FaNotes-Blank': '0' })
  assert.equal(created.status, 200, created.body.toString('utf8'))
  const revision = JSON.parse(created.body.toString('utf8')).revision
  const next = randomBytes(200)
  const directory = join(dataDirectory, 'accounts', accountId, 'revisions', id)
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, `c-${revision}`), original)
  writeFileSync(join(dataDirectory, 'accounts', accountId, 'blobs', id), next)
  const replaced = await putFile(id, next, revision, { 'X-FaNotes-Blank': '1', 'X-FaNotes-Clear': '1' })
  assert.equal(replaced.status, 200, replaced.body.toString('utf8'))
  assert.deepEqual(readFileSync(join(directory, `c-${revision}`)), original)
  assert.deepEqual((await readFile(id)).body, next)
})

test('a truncated archive copy is repaired from the live note before it changes', async () => {
  const id = randomBytes(32).toString('hex')
  const original = randomBytes(5000)
  const created = await putFile(id, original, 0, { 'X-FaNotes-Blank': '0' })
  assert.equal(created.status, 200, created.body.toString('utf8'))
  const revision = JSON.parse(created.body.toString('utf8')).revision
  const directory = join(dataDirectory, 'accounts', accountId, 'revisions', id)
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, String(revision)), original.subarray(0, 64))
  const next = randomBytes(5000)
  const replaced = await putFile(id, next, revision, { 'X-FaNotes-Blank': '0' })
  assert.equal(replaced.status, 200, replaced.body.toString('utf8'))
  assert.deepEqual(readFileSync(join(directory, String(revision))), original)
  assert.deepEqual((await readFile(id)).body, next)
})

test('a symlink in the revision archive does not count as stored notes', async () => {
  const authKey = b64(32)
  const registered = await jsonCall('POST', '/api/v1/sync/register', {
    email: `archive-link-${randomBytes(4).toString('hex')}@example.com`,
    authKey,
    kdf: { algorithm: 'pbkdf2-sha256', iterations: 300000, salt: b64(16) },
    vaultKeyWrap: { iv: b64(12), data: b64(32) },
    device: { name: 'Link', platform: 'linux' },
  })
  assert.equal(registered.status, 201)
  const linkAccount = registered.json.accountId
  const linkToken = registered.json.token
  const fileId = randomBytes(32).toString('hex')
  const outside = join(dataDirectory, `outside-${fileId.slice(0, 8)}`)
  writeFileSync(outside, randomBytes(200_000))
  const directory = join(dataDirectory, 'accounts', linkAccount, 'revisions', fileId)
  mkdirSync(directory, { recursive: true })
  symlinkSync(outside, join(directory, '1'))
  const account = await call('GET', '/api/v1/sync/account', {
    token: linkToken,
    headers: { 'X-FaNotes-Account': linkAccount },
  })
  assert.equal(account.status, 200, account.body.toString('utf8'))
  assert.equal(JSON.parse(account.body.toString('utf8')).usage.bytes, 0)
})

test('a download serves one inode and does not follow a symlink', async () => {
  const id = randomBytes(32).toString('hex')
  const original = randomBytes(80)
  const created = await putFile(id, original, 0, { 'X-FaNotes-Blank': '0' })
  assert.equal(created.status, 200, created.body.toString('utf8'))
  const live = await readFile(id)
  assert.equal(live.status, 200)
  assert.equal(Number(live.headers['content-length']), original.length)
  assert.deepEqual(live.body, original)
  const head = await call('HEAD', `/api/v1/sync/files/${id}`, { token })
  assert.equal(head.status, 200)
  assert.equal(Number(head.headers['content-length']), original.length)
  assert.equal(head.body.length, 0)
  const blob = join(dataDirectory, 'accounts', accountId, 'blobs', id)
  const outside = join(dataDirectory, 'outside-marker')
  const marker = Buffer.from('SYMLINK-MARKER-should-not-leak')
  writeFileSync(outside, marker)
  rmSync(blob)
  symlinkSync(outside, blob)
  const blocked = await readFile(id)
  assert.equal(blocked.status, 404)
  assert.equal(blocked.body.includes(marker), false)
})

test('a download records a full live blob whose size differs and does not send a short one', async () => {
  const id = randomBytes(32).toString('hex')
  const original = randomBytes(80)
  const created = await putFile(id, original, 0, { 'X-FaNotes-Blank': '0' })
  assert.equal(created.status, 200, created.body.toString('utf8'))
  const revision = JSON.parse(created.body.toString('utf8')).revision
  const next = randomBytes(120)
  const blob = join(dataDirectory, 'accounts', accountId, 'blobs', id)
  writeFileSync(blob, next)
  const got = await readFile(id)
  assert.equal(got.status, 200, got.body.toString('utf8'))
  assert.deepEqual(got.body, next)
  assert.equal(got.headers['x-fanotes-sha256'], sha256(next))
  assert.notEqual(got.headers['x-fanotes-revision'], String(revision))
  const head = await call('HEAD', `/api/v1/sync/files/${id}`, { token })
  assert.equal(head.status, 200)
  assert.equal(Number(head.headers['content-length']), next.length)
  assert.equal(head.headers['x-fanotes-sha256'], sha256(next))
  assert.equal(head.body.length, 0)
  assert.deepEqual(readFileSync(blob), next)
  const changes = await call('GET', '/api/v1/sync/changes?since=0', { token })
  const entry = JSON.parse(changes.body.toString('utf8')).entries.find((item) => item.id === id)
  assert.equal(entry.deleted, false)
  assert.equal(entry.sha256, sha256(next))
  assert.equal(entry.size, next.length)
  assert.ok(entry.revision > revision)

  const tinyId = randomBytes(32).toString('hex')
  const tinyOriginal = randomBytes(80)
  const tinyCreated = await putFile(tinyId, tinyOriginal, 0, { 'X-FaNotes-Blank': '0' })
  const tinyRevision = JSON.parse(tinyCreated.body.toString('utf8')).revision
  const tinyBlob = join(dataDirectory, 'accounts', accountId, 'blobs', tinyId)
  const remnant = randomBytes(10)
  writeFileSync(tinyBlob, remnant)
  const refused = await readFile(tinyId)
  assert.equal(refused.status, 409, refused.body.toString('utf8'))
  assert.equal(JSON.parse(refused.body.toString('utf8')).reason, 'guard')
  assert.equal(refused.body.includes(remnant), false)
  const tinyHead = await call('HEAD', `/api/v1/sync/files/${tinyId}`, { token })
  assert.equal(tinyHead.status, 409)
  const tinyChanges = await call('GET', '/api/v1/sync/changes?since=0', { token })
  const tinyEntry = JSON.parse(tinyChanges.body.toString('utf8')).entries.find((item) => item.id === tinyId)
  assert.equal(tinyEntry.revision, tinyRevision)
  assert.equal(tinyEntry.size, tinyOriginal.length)
  assert.deepEqual(readFileSync(tinyBlob), remnant)
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

const revisionOf = (response) => JSON.parse(response.body.toString('utf8')).revision
const jsonOf = (response) => JSON.parse(response.body.toString('utf8'))

test('deleting a line from a short note is stored, from new and older clients', async () => {
  for (const headers of [{ 'X-FaNotes-Blank': '0' }, {}]) {
    const id = randomBytes(32).toString('hex')
    const created = await putFile(id, randomBytes(600), 0, headers)
    assert.equal(created.status, 200, created.body.toString('utf8'))
    const shorter = randomBytes(500)
    const edited = await putFile(id, shorter, revisionOf(created), headers)
    assert.equal(edited.status, 200, edited.body.toString('utf8'))
    assert.deepEqual((await readFile(id)).body, shorter)
  }
})

test('an empty file never replaces a short note without an explicit clear', async () => {
  const id = randomBytes(32).toString('hex')
  const original = randomBytes(300)
  const created = await putFile(id, original, 0, { 'X-FaNotes-Blank': '0' })
  const empty = randomBytes(28)
  for (const headers of [{ 'X-FaNotes-Blank': '0' }, {}]) {
    const blocked = await putFile(id, empty, revisionOf(created), headers)
    assert.equal(blocked.status, 409, blocked.body.toString('utf8'))
  }
  assert.deepEqual((await readFile(id)).body, original)
  const cleared = await putFile(id, empty, revisionOf(created), { 'X-FaNotes-Blank': '1', 'X-FaNotes-Clear': '1' })
  assert.equal(cleared.status, 200, cleared.body.toString('utf8'))
})

test('a guard rejection says so, and a stale rejection names the current entry', async () => {
  const id = randomBytes(32).toString('hex')
  const created = await putFile(id, randomBytes(5000), 0, { 'X-FaNotes-Blank': '0' })
  const revision = revisionOf(created)
  const guarded = await putFile(id, randomBytes(400), revision, { 'X-FaNotes-Blank': '0' })
  assert.equal(guarded.status, 409)
  assert.equal(guarded.headers['x-fanotes-rejected'], 'guard')
  assert.equal(jsonOf(guarded).reason, 'guard')
  assert.equal(jsonOf(guarded).entry.revision, revision)
  const stale = await putFile(id, randomBytes(5000), revision - 1, { 'X-FaNotes-Blank': '0' })
  assert.equal(stale.status, 409)
  assert.equal(stale.headers['x-fanotes-rejected'], undefined)
  assert.equal(jsonOf(stale).reason, 'stale')
  assert.equal(jsonOf(stale).entry.revision, revision)
})

test('a device that still has a deleted note can put it back over the tombstone', async () => {
  const id = randomBytes(32).toString('hex')
  const original = randomBytes(5000)
  const created = await putFile(id, original, 0, { 'X-FaNotes-Blank': '0' })
  const removed = await call('DELETE', `/api/v1/sync/files/${id}`, {
    token,
    headers: { 'If-Match': String(revisionOf(created)), 'X-FaNotes-Delete': '1' },
  })
  assert.equal(removed.status, 200, removed.body.toString('utf8'))
  // The deleted blob is archived, not dropped.
  const archived = readdirSync(join(dataDirectory, 'accounts', accountId, 'revisions', id))
    .map((name) => readFileSync(join(dataDirectory, 'accounts', accountId, 'revisions', id, name)))
  assert.ok(archived.some((bytes) => bytes.equals(original)))
  // A blank body cannot resurrect the note, from any base.
  const blankBack = await putFile(id, randomBytes(200), 0, { 'X-FaNotes-Blank': '1' })
  assert.equal(blankBack.status, 409)
  assert.equal((await readFile(id)).status, 204)
  // A device with an older base (here: none) puts its copy back.
  const kept = randomBytes(4000)
  const back = await putFile(id, kept, 0, { 'X-FaNotes-Blank': '0' })
  assert.equal(back.status, 200, back.body.toString('utf8'))
  assert.deepEqual((await readFile(id)).body, kept)
  // Once live again, a stale base is rejected as before.
  const stale = await putFile(id, randomBytes(4000), 0, { 'X-FaNotes-Blank': '0' })
  assert.equal(stale.status, 409)
  assert.deepEqual((await readFile(id)).body, kept)
})

test('an empty, blank, or truncated upload does not resurrect a deleted note', async () => {
  const id = randomBytes(32).toString('hex')
  const original = randomBytes(5000)
  const created = await putFile(id, original, 0, { 'X-FaNotes-Blank': '0' })
  const removed = await call('DELETE', `/api/v1/sync/files/${id}`, {
    token,
    headers: { 'If-Match': String(revisionOf(created)), 'X-FaNotes-Delete': '1' },
  })
  assert.equal(removed.status, 200, removed.body.toString('utf8'))
  const tombstone = revisionOf(removed)
  // The base matches the tombstone. A short body used to become the live note.
  const truncated = await putFile(id, randomBytes(200), tombstone, { 'X-FaNotes-Blank': '0' })
  assert.equal(truncated.status, 409, truncated.body.toString('utf8'))
  assert.equal(jsonOf(truncated).reason, 'guard')
  assert.equal((await readFile(id)).status, 204)
  const empty = await putFile(id, randomBytes(28), tombstone, {})
  assert.equal(empty.status, 409, empty.body.toString('utf8'))
  assert.equal((await readFile(id)).status, 204)
  const blank = await putFile(id, randomBytes(4500), tombstone, { 'X-FaNotes-Blank': '1' })
  assert.equal(blank.status, 409, blank.body.toString('utf8'))
  assert.equal((await readFile(id)).status, 204)
  const archived = readdirSync(join(dataDirectory, 'accounts', accountId, 'revisions', id))
    .map((name) => readFileSync(join(dataDirectory, 'accounts', accountId, 'revisions', id, name)))
  assert.ok(archived.some((bytes) => bytes.equals(original)))
  const kept = randomBytes(4800)
  const back = await putFile(id, kept, 0, { 'X-FaNotes-Blank': '0' })
  assert.equal(back.status, 200, back.body.toString('utf8'))
  assert.deepEqual((await readFile(id)).body, kept)
})

test('a second registration does not replace the account that already owns the address', async () => {
  const email = `twice-${randomBytes(4).toString('hex')}@example.com`
  const authKey = b64(32)
  const payload = {
    email,
    authKey,
    kdf: { algorithm: 'pbkdf2-sha256', iterations: 300000, salt: b64(16) },
    vaultKeyWrap: { iv: b64(12), data: b64(32) },
    device: { name: 'Check', platform: 'linux' },
  }
  const first = await jsonCall('POST', '/api/v1/sync/register', payload)
  assert.equal(first.status, 201)
  const second = await jsonCall('POST', '/api/v1/sync/register', payload)
  assert.equal(second.status, 401)
  const login = await jsonCall('POST', '/api/v1/sync/login', {
    email,
    authKey,
    device: { name: 'Other', platform: 'linux' },
  })
  assert.equal(login.status, 200)
  assert.equal(login.json.accountId, first.json.accountId)
})

test('a delete leaves a newer live blob in place', async () => {
  const id = randomBytes(32).toString('hex')
  const original = randomBytes(5000)
  const created = await putFile(id, original, 0, { 'X-FaNotes-Blank': '0' })
  assert.equal(created.status, 200, created.body.toString('utf8'))
  const revision = JSON.parse(created.body.toString('utf8')).revision
  const next = randomBytes(5000)
  writeFileSync(join(dataDirectory, 'accounts', accountId, 'blobs', id), next)
  const removed = await call('DELETE', `/api/v1/sync/files/${id}`, {
    token,
    headers: { 'If-Match': String(revision), 'X-FaNotes-Delete': '1' },
  })
  assert.equal(removed.status, 409, removed.body.toString('utf8'))
  assert.equal(JSON.parse(removed.body.toString('utf8')).reason, 'stale')
  assert.deepEqual(readFileSync(join(dataDirectory, 'accounts', accountId, 'blobs', id)), next)
  const live = await readFile(id)
  assert.equal(live.status, 200)
  assert.deepEqual(live.body, next)
  assert.equal(live.headers['x-fanotes-sha256'], sha256(next))
  const changes = await call('GET', '/api/v1/sync/changes?since=0', { token })
  const entry = JSON.parse(changes.body.toString('utf8')).entries.find((item) => item.id === id)
  assert.equal(entry.deleted, false)
  assert.equal(entry.sha256, sha256(next))
  assert.equal(entry.size, next.length)
  assert.ok(entry.revision > revision)

  const tinyId = randomBytes(32).toString('hex')
  const tinyOriginal = randomBytes(80)
  const tinyCreated = await putFile(tinyId, tinyOriginal, 0, { 'X-FaNotes-Blank': '0' })
  const tinyRevision = JSON.parse(tinyCreated.body.toString('utf8')).revision
  const tinyBlob = join(dataDirectory, 'accounts', accountId, 'blobs', tinyId)
  writeFileSync(tinyBlob, randomBytes(10))
  const tinyRemoved = await call('DELETE', `/api/v1/sync/files/${tinyId}`, {
    token,
    headers: { 'If-Match': String(tinyRevision), 'X-FaNotes-Delete': '1' },
  })
  assert.equal(tinyRemoved.status, 409, tinyRemoved.body.toString('utf8'))
  assert.equal(JSON.parse(tinyRemoved.body.toString('utf8')).reason, 'guard')
  assert.equal(readFileSync(tinyBlob).length, 10)
  const tinyChanges = await call('GET', '/api/v1/sync/changes?since=0', { token })
  const tinyEntry = JSON.parse(tinyChanges.body.toString('utf8')).entries.find((item) => item.id === tinyId)
  assert.equal(tinyEntry.deleted, false)
  assert.equal(tinyEntry.revision, tinyRevision)
})

test('a later upload does not replace a newer live blob the log has not recorded', async () => {
  const id = randomBytes(32).toString('hex')
  const original = randomBytes(5000)
  const created = await putFile(id, original, 0, { 'X-FaNotes-Blank': '0' })
  assert.equal(created.status, 200, created.body.toString('utf8'))
  const revision = JSON.parse(created.body.toString('utf8')).revision
  const newer = randomBytes(5000)
  const blobPath = join(dataDirectory, 'accounts', accountId, 'blobs', id)
  const archive = join(dataDirectory, 'accounts', accountId, 'revisions', id)
  mkdirSync(archive, { recursive: true })
  writeFileSync(join(archive, String(revision)), original)
  writeFileSync(blobPath, newer)
  const other = randomBytes(4200)
  const blocked = await putFile(id, other, revision, { 'X-FaNotes-Blank': '0' })
  assert.equal(blocked.status, 409, blocked.body.toString('utf8'))
  assert.equal(JSON.parse(blocked.body.toString('utf8')).reason, 'stale')
  assert.deepEqual(readFileSync(blobPath), newer)
  assert.deepEqual(readFileSync(join(archive, String(revision))), original)
  const live = await readFile(id)
  assert.equal(live.status, 200)
  assert.deepEqual(live.body, newer)
  assert.equal(live.headers['x-fanotes-sha256'], sha256(newer))
  const changes = await call('GET', '/api/v1/sync/changes?since=0', { token })
  const entry = JSON.parse(changes.body.toString('utf8')).entries.find((item) => item.id === id)
  assert.equal(entry.deleted, false)
  assert.equal(entry.sha256, sha256(newer))
  assert.equal(entry.size, newer.length)
  assert.ok(entry.revision > revision)
})

test('a retried upload records the newer live blob and leaves the archived revision', async () => {
  const id = randomBytes(32).toString('hex')
  const original = randomBytes(5000)
  const created = await putFile(id, original, 0, { 'X-FaNotes-Blank': '0' })
  assert.equal(created.status, 200, created.body.toString('utf8'))
  const revision = JSON.parse(created.body.toString('utf8')).revision
  const newer = randomBytes(4800)
  const blobPath = join(dataDirectory, 'accounts', accountId, 'blobs', id)
  const archive = join(dataDirectory, 'accounts', accountId, 'revisions', id)
  mkdirSync(archive, { recursive: true })
  writeFileSync(join(archive, String(revision)), original)
  writeFileSync(blobPath, newer)
  const retried = await putFile(id, newer, revision, { 'X-FaNotes-Blank': '0' })
  assert.equal(retried.status, 200, retried.body.toString('utf8'))
  const recorded = JSON.parse(retried.body.toString('utf8')).revision
  assert.ok(recorded > revision)
  assert.deepEqual(readFileSync(blobPath), newer)
  assert.deepEqual(readFileSync(join(archive, String(revision))), original)
  assert.deepEqual(readdirSync(archive), [String(revision)])
  assert.deepEqual((await readFile(id)).body, newer)
})

test('a restore does not replace a newer live blob the log has not recorded', async () => {
  const id = randomBytes(32).toString('hex')
  const original = randomBytes(5000)
  const created = await putFile(id, original, 0, { 'X-FaNotes-Blank': '0' })
  assert.equal(created.status, 200, created.body.toString('utf8'))
  const revision = JSON.parse(created.body.toString('utf8')).revision
  const newer = randomBytes(4600)
  const blobPath = join(dataDirectory, 'accounts', accountId, 'blobs', id)
  const archive = join(dataDirectory, 'accounts', accountId, 'revisions', id)
  mkdirSync(archive, { recursive: true })
  writeFileSync(join(archive, String(revision)), original)
  writeFileSync(blobPath, newer)
  const payload = Buffer.from(JSON.stringify({ revision }))
  const blocked = await call('POST', `/api/v1/sync/files/${id}/restore`, {
    token,
    body: payload,
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': String(payload.length),
      'If-Match': String(revision),
    },
  })
  assert.equal(blocked.status, 409, blocked.body.toString('utf8'))
  assert.equal(JSON.parse(blocked.body.toString('utf8')).reason, 'stale')
  assert.deepEqual(readFileSync(blobPath), newer)
  assert.deepEqual(readFileSync(join(archive, String(revision))), original)
  assert.deepEqual((await readFile(id)).body, newer)
})

test('a restore that already reached the live slot is recorded without touching the archive', async () => {
  const id = randomBytes(32).toString('hex')
  const original = randomBytes(5000)
  const created = await putFile(id, original, 0, { 'X-FaNotes-Blank': '0' })
  assert.equal(created.status, 200, created.body.toString('utf8'))
  const first = JSON.parse(created.body.toString('utf8')).revision
  const secondBody = randomBytes(4700)
  const updated = await putFile(id, secondBody, first, { 'X-FaNotes-Blank': '0' })
  assert.equal(updated.status, 200, updated.body.toString('utf8'))
  const second = JSON.parse(updated.body.toString('utf8')).revision
  const archive = join(dataDirectory, 'accounts', accountId, 'revisions', id)
  const blobPath = join(dataDirectory, 'accounts', accountId, 'blobs', id)
  writeFileSync(join(archive, String(second)), secondBody)
  writeFileSync(blobPath, original)
  const payload = Buffer.from(JSON.stringify({ revision: first }))
  const restored = await call('POST', `/api/v1/sync/files/${id}/restore`, {
    token,
    body: payload,
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': String(payload.length),
      'If-Match': String(second),
    },
  })
  assert.equal(restored.status, 200, restored.body.toString('utf8'))
  assert.deepEqual(readFileSync(blobPath), original)
  assert.deepEqual(readFileSync(join(archive, String(first))), original)
  assert.deepEqual(readFileSync(join(archive, String(second))), secondBody)
  assert.deepEqual((await readFile(id)).body, original)
})
