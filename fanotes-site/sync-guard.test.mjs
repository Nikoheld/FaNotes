// Server-side sync guard. Fixtures are anonymous: no real notes, names, or vault keys.
import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
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

test('a resurrection that reached the live slot is not replaced or published early', async () => {
  const id = randomBytes(32).toString('hex')
  const original = randomBytes(5000)
  const created = await putFile(id, original, 0, { 'X-FaNotes-Blank': '0' })
  assert.equal(created.status, 200, created.body.toString('utf8'))
  const removed = await call('DELETE', `/api/v1/sync/files/${id}`, {
    token,
    headers: { 'If-Match': String(revisionOf(created)), 'X-FaNotes-Delete': '1' },
  })
  assert.equal(removed.status, 200, removed.body.toString('utf8'))
  const tombstone = revisionOf(removed)
  const planted = randomBytes(4600)
  const blobPath = join(dataDirectory, 'accounts', accountId, 'blobs', id)
  const archive = join(dataDirectory, 'accounts', accountId, 'revisions', id)
  writeFileSync(blobPath, planted)
  const hidden = await readFile(id)
  assert.equal(hidden.status, 204)
  const blocked = await putFile(id, randomBytes(4200), tombstone, { 'X-FaNotes-Blank': '0' })
  assert.equal(blocked.status, 409, blocked.body.toString('utf8'))
  assert.equal(jsonOf(blocked).reason, 'stale')
  assert.deepEqual(readFileSync(blobPath), planted)
  const restored = await call('POST', `/api/v1/sync/files/${id}/restore`, {
    token,
    body: Buffer.from(JSON.stringify({ revision: revisionOf(created) })),
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': String(Buffer.from(JSON.stringify({ revision: revisionOf(created) })).length),
      'If-Match': String(tombstone),
    },
  })
  assert.equal(restored.status, 409, restored.body.toString('utf8'))
  assert.deepEqual(readFileSync(blobPath), planted)
  const removedAgain = await call('DELETE', `/api/v1/sync/files/${id}`, {
    token,
    headers: { 'If-Match': String(tombstone), 'X-FaNotes-Delete': '1' },
  })
  assert.equal(removedAgain.status, 409, removedAgain.body.toString('utf8'))
  assert.equal(jsonOf(removedAgain).reason, 'guard')
  assert.deepEqual(readFileSync(blobPath), planted)
  const stillHidden = await call('GET', '/api/v1/sync/changes?since=0', { token })
  const hiddenEntry = JSON.parse(stillHidden.body.toString('utf8')).entries.find((item) => item.id === id)
  assert.equal(hiddenEntry.deleted, true)
  assert.equal(hiddenEntry.revision, tombstone)
  const recorded = await putFile(id, planted, tombstone, { 'X-FaNotes-Blank': '0' })
  assert.equal(recorded.status, 200, recorded.body.toString('utf8'))
  assert.ok(revisionOf(recorded) > tombstone)
  const live = await readFile(id)
  assert.equal(live.status, 200)
  assert.deepEqual(live.body, planted)
  assert.equal(live.headers['x-fanotes-sha256'], sha256(planted))
  const archived = readdirSync(archive).map((name) => readFileSync(join(archive, name)))
  assert.ok(archived.some((bytes) => bytes.equals(original)))
})

test('a delete leftover that matches the archive is not turned back into the note', async () => {
  const id = randomBytes(32).toString('hex')
  const original = randomBytes(5000)
  const created = await putFile(id, original, 0, { 'X-FaNotes-Blank': '0' })
  const removed = await call('DELETE', `/api/v1/sync/files/${id}`, {
    token,
    headers: { 'If-Match': String(revisionOf(created)), 'X-FaNotes-Delete': '1' },
  })
  assert.equal(removed.status, 200, removed.body.toString('utf8'))
  const tombstone = revisionOf(removed)
  const blobPath = join(dataDirectory, 'accounts', accountId, 'blobs', id)
  writeFileSync(blobPath, original)
  assert.equal((await readFile(id)).status, 204)
  const blank = await putFile(id, randomBytes(200), tombstone, { 'X-FaNotes-Blank': '1' })
  assert.equal(blank.status, 409, blank.body.toString('utf8'))
  assert.equal(jsonOf(blank).reason, 'guard')
  assert.deepEqual(readFileSync(blobPath), original)
  const again = await call('DELETE', `/api/v1/sync/files/${id}`, {
    token,
    headers: { 'If-Match': String(tombstone), 'X-FaNotes-Delete': '1' },
  })
  assert.equal(again.status, 200, again.body.toString('utf8'))
  assert.equal(revisionOf(again), tombstone)
  assert.equal(existsSync(blobPath), false)
  const archive = join(dataDirectory, 'accounts', accountId, 'revisions', id)
  const archived = readdirSync(archive).map((name) => readFileSync(join(archive, name)))
  assert.ok(archived.some((bytes) => bytes.equals(original)))
  const repeated = await call('DELETE', `/api/v1/sync/files/${id}`, {
    token,
    headers: { 'If-Match': String(tombstone), 'X-FaNotes-Delete': '1' },
  })
  assert.equal(repeated.status, 200, repeated.body.toString('utf8'))
  assert.equal(revisionOf(repeated), tombstone)
  assert.equal(existsSync(blobPath), false)
  const changes = await call('GET', '/api/v1/sync/changes?since=0', { token })
  const entry = JSON.parse(changes.body.toString('utf8')).entries.find((item) => item.id === id)
  assert.equal(entry.deleted, true)
  assert.equal(entry.revision, tombstone)
  assert.equal((await readFile(id)).status, 204)
  const report = jsonOf(await call('GET', '/api/v1/sync/integrity', { token }))
  assert.equal(report.blobsOrphan.some((item) => item.id === id), false)
})

test('an idempotent delete leaves a short remnant on a tombstone', async () => {
  const id = randomBytes(32).toString('hex')
  const original = randomBytes(5000)
  const created = await putFile(id, original, 0, { 'X-FaNotes-Blank': '0' })
  const removed = await call('DELETE', `/api/v1/sync/files/${id}`, {
    token,
    headers: { 'If-Match': String(revisionOf(created)), 'X-FaNotes-Delete': '1' },
  })
  assert.equal(removed.status, 200, removed.body.toString('utf8'))
  const tombstone = revisionOf(removed)
  const blobPath = join(dataDirectory, 'accounts', accountId, 'blobs', id)
  const remnant = randomBytes(10)
  writeFileSync(blobPath, remnant)
  const again = await call('DELETE', `/api/v1/sync/files/${id}`, {
    token,
    headers: { 'If-Match': String(tombstone), 'X-FaNotes-Delete': '1' },
  })
  assert.equal(again.status, 200, again.body.toString('utf8'))
  assert.equal(revisionOf(again), tombstone)
  assert.deepEqual(readFileSync(blobPath), remnant)
  assert.equal((await readFile(id)).status, 204)
})

test('a matching delete leftover does not block putting the note back', async () => {
  const id = randomBytes(32).toString('hex')
  const original = randomBytes(5000)
  const created = await putFile(id, original, 0, { 'X-FaNotes-Blank': '0' })
  const removed = await call('DELETE', `/api/v1/sync/files/${id}`, {
    token,
    headers: { 'If-Match': String(revisionOf(created)), 'X-FaNotes-Delete': '1' },
  })
  assert.equal(removed.status, 200, removed.body.toString('utf8'))
  const tombstone = revisionOf(removed)
  const blobPath = join(dataDirectory, 'accounts', accountId, 'blobs', id)
  writeFileSync(blobPath, original)
  const kept = randomBytes(4200)
  const back = await putFile(id, kept, tombstone, { 'X-FaNotes-Blank': '0' })
  assert.equal(back.status, 200, back.body.toString('utf8'))
  assert.ok(revisionOf(back) > tombstone)
  assert.deepEqual(readFileSync(blobPath), kept)
  const live = await readFile(id)
  assert.equal(live.status, 200)
  assert.deepEqual(live.body, kept)
})

test('a first upload that reached the live slot is not replaced by a different body', async () => {
  const id = randomBytes(32).toString('hex')
  const planted = randomBytes(4400)
  const blobPath = join(dataDirectory, 'accounts', accountId, 'blobs', id)
  mkdirSync(join(dataDirectory, 'accounts', accountId, 'blobs'), { recursive: true })
  writeFileSync(blobPath, planted)
  assert.equal((await readFile(id)).status, 404)
  const blocked = await putFile(id, randomBytes(3900), 0, { 'X-FaNotes-Blank': '0' })
  assert.equal(blocked.status, 409, blocked.body.toString('utf8'))
  assert.equal(jsonOf(blocked).reason, 'stale')
  assert.deepEqual(readFileSync(blobPath), planted)
  const absent = await call('GET', '/api/v1/sync/changes?since=0', { token })
  assert.equal(JSON.parse(absent.body.toString('utf8')).entries.some((item) => item.id === id), false)
  const recorded = await putFile(id, planted, 0, { 'X-FaNotes-Blank': '0' })
  assert.equal(recorded.status, 200, recorded.body.toString('utf8'))
  const live = await readFile(id)
  assert.equal(live.status, 200)
  assert.deepEqual(live.body, planted)
  assert.equal(live.headers['x-fanotes-sha256'], sha256(planted))
})

test('a missing live blob is copied back from the matching archive', async () => {
  const id = randomBytes(32).toString('hex')
  const original = randomBytes(5000)
  const created = await putFile(id, original, 0, { 'X-FaNotes-Blank': '0' })
  assert.equal(created.status, 200, created.body.toString('utf8'))
  const revision = revisionOf(created)
  const blobPath = join(dataDirectory, 'accounts', accountId, 'blobs', id)
  const archiveDir = join(dataDirectory, 'accounts', accountId, 'revisions', id)
  mkdirSync(archiveDir, { recursive: true })
  const archivePath = join(archiveDir, String(revision))
  writeFileSync(archivePath, original)
  const logPath = join(dataDirectory, 'accounts', accountId, 'changes.jsonl')
  const logBefore = readFileSync(logPath)
  rmSync(blobPath)
  const live = await readFile(id)
  assert.equal(live.status, 200, live.body.toString('utf8'))
  assert.deepEqual(live.body, original)
  assert.equal(live.headers['x-fanotes-sha256'], sha256(original))
  assert.equal(live.headers['x-fanotes-revision'], String(revision))
  assert.deepEqual(readFileSync(blobPath), original)
  assert.deepEqual(readFileSync(archivePath), original)
  assert.deepEqual(readFileSync(logPath), logBefore)
  const changes = jsonOf(await call('GET', '/api/v1/sync/changes?since=0', { token }))
  const entry = changes.entries.find((item) => item.id === id)
  assert.equal(entry.revision, revision)
  assert.equal(entry.deleted, false)
  const report = jsonOf(await call('GET', '/api/v1/sync/integrity', { token }))
  assert.equal(report.blobsMissing.some((item) => item.id === id), false)
})

test('a missing live blob stays missing when the archive is a different note', async () => {
  const id = randomBytes(32).toString('hex')
  const original = randomBytes(5000)
  const created = await putFile(id, original, 0, { 'X-FaNotes-Blank': '0' })
  assert.equal(created.status, 200, created.body.toString('utf8'))
  const revision = revisionOf(created)
  const blobPath = join(dataDirectory, 'accounts', accountId, 'blobs', id)
  const archiveDir = join(dataDirectory, 'accounts', accountId, 'revisions', id)
  mkdirSync(archiveDir, { recursive: true })
  const wrong = randomBytes(5000)
  const wrongPath = join(archiveDir, String(revision))
  writeFileSync(wrongPath, wrong)
  rmSync(blobPath)
  const live = await readFile(id)
  assert.equal(live.status, 404)
  assert.equal(existsSync(blobPath), false)
  assert.deepEqual(readFileSync(wrongPath), wrong)
})

test('a missing live blob is copied from the archive file whose hash matches', async () => {
  const id = randomBytes(32).toString('hex')
  const original = randomBytes(5000)
  const created = await putFile(id, original, 0, { 'X-FaNotes-Blank': '0' })
  assert.equal(created.status, 200, created.body.toString('utf8'))
  const revision = revisionOf(created)
  const blobPath = join(dataDirectory, 'accounts', accountId, 'blobs', id)
  const archiveDir = join(dataDirectory, 'accounts', accountId, 'revisions', id)
  mkdirSync(archiveDir, { recursive: true })
  const wrong = randomBytes(5000)
  const preferred = join(archiveDir, String(revision))
  const other = join(archiveDir, String(revision + 1))
  writeFileSync(preferred, wrong)
  writeFileSync(other, original)
  rmSync(blobPath)
  const live = await readFile(id)
  assert.equal(live.status, 200, live.body.toString('utf8'))
  assert.deepEqual(live.body, original)
  assert.deepEqual(readFileSync(preferred), wrong)
  assert.deepEqual(readFileSync(other), original)
})

test('a symlink in the archive does not refill a missing live blob', async () => {
  const id = randomBytes(32).toString('hex')
  const original = randomBytes(5000)
  const created = await putFile(id, original, 0, { 'X-FaNotes-Blank': '0' })
  assert.equal(created.status, 200, created.body.toString('utf8'))
  const revision = revisionOf(created)
  const blobPath = join(dataDirectory, 'accounts', accountId, 'blobs', id)
  const archiveDir = join(dataDirectory, 'accounts', accountId, 'revisions', id)
  mkdirSync(archiveDir, { recursive: true })
  const outside = join(archiveDir, 'outside-note')
  writeFileSync(outside, original)
  symlinkSync(outside, join(archiveDir, String(revision)))
  rmSync(blobPath)
  const live = await readFile(id)
  assert.equal(live.status, 404)
  assert.equal(existsSync(blobPath), false)
  assert.equal(lstatSync(join(archiveDir, String(revision))).isSymbolicLink(), true)
  assert.deepEqual(readFileSync(outside), original)
})

test('a symlink in the live slot is not replaced from the archive', async () => {
  const id = randomBytes(32).toString('hex')
  const original = randomBytes(5000)
  const created = await putFile(id, original, 0, { 'X-FaNotes-Blank': '0' })
  assert.equal(created.status, 200, created.body.toString('utf8'))
  const revision = revisionOf(created)
  const blobPath = join(dataDirectory, 'accounts', accountId, 'blobs', id)
  const archiveDir = join(dataDirectory, 'accounts', accountId, 'revisions', id)
  mkdirSync(archiveDir, { recursive: true })
  const archivePath = join(archiveDir, String(revision))
  writeFileSync(archivePath, original)
  rmSync(blobPath)
  symlinkSync(archivePath, blobPath)
  const live = await readFile(id)
  assert.equal(live.status, 404)
  assert.equal(lstatSync(blobPath).isSymbolicLink(), true)
  assert.deepEqual(readFileSync(archivePath), original)
})

test('a deleted note is not copied back from its archive', async () => {
  const id = randomBytes(32).toString('hex')
  const original = randomBytes(5000)
  const created = await putFile(id, original, 0, { 'X-FaNotes-Blank': '0' })
  assert.equal(created.status, 200, created.body.toString('utf8'))
  const removed = await call('DELETE', `/api/v1/sync/files/${id}`, {
    token,
    headers: { 'If-Match': String(revisionOf(created)), 'X-FaNotes-Delete': '1' },
  })
  assert.equal(removed.status, 200, removed.body.toString('utf8'))
  const blobPath = join(dataDirectory, 'accounts', accountId, 'blobs', id)
  const archiveDir = join(dataDirectory, 'accounts', accountId, 'revisions', id)
  assert.equal(existsSync(blobPath), false)
  const archived = readdirSync(archiveDir).map((name) => readFileSync(join(archiveDir, name)))
  assert.ok(archived.some((bytes) => bytes.equals(original)))
  const live = await readFile(id)
  assert.equal(live.status, 204)
  assert.equal(existsSync(blobPath), false)
  assert.equal(live.headers['x-fanotes-deleted'], '1')
})

test('a restored note does not leave a temporary file beside it', async () => {
  const id = randomBytes(32).toString('hex')
  const original = randomBytes(5000)
  const created = await putFile(id, original, 0, { 'X-FaNotes-Blank': '0' })
  assert.equal(created.status, 200, created.body.toString('utf8'))
  const revision = revisionOf(created)
  const accountDir = join(dataDirectory, 'accounts', accountId)
  const blobPath = join(accountDir, 'blobs', id)
  const archiveDir = join(accountDir, 'revisions', id)
  mkdirSync(archiveDir, { recursive: true })
  writeFileSync(join(archiveDir, String(revision)), original)
  rmSync(blobPath)
  const live = await readFile(id)
  assert.equal(live.status, 200)
  assert.deepEqual(live.body, original)
  const temps = []
  const walk = (directory) => {
    for (const name of readdirSync(directory)) {
      const path = join(directory, name)
      if (lstatSync(path).isDirectory()) walk(path)
      else if (name.includes('.tmp')) temps.push(name)
    }
  }
  walk(accountDir)
  assert.deepEqual(temps, [])
  assert.deepEqual(readFileSync(blobPath), original)
})

test('putting the same bytes keeps the live inode and stores the new metadata', async () => {
  const id = randomBytes(32).toString('hex')
  const original = randomBytes(5000)
  const created = await putFile(id, original, 0, { 'X-FaNotes-Blank': '0' })
  assert.equal(created.status, 200, created.body.toString('utf8'))
  const revision = revisionOf(created)
  const blobPath = join(dataDirectory, 'accounts', accountId, 'blobs', id)
  const before = statSync(blobPath)
  const incomingDir = join(dataDirectory, 'accounts', accountId, 'incoming')
  const partsBefore = existsSync(incomingDir) ? readdirSync(incomingDir).filter((name) => name.endsWith('.part')) : []
  const nextMeta = b64(32)
  const again = await putFile(id, original, revision, { 'X-FaNotes-Blank': '0', 'X-FaNotes-Meta': nextMeta })
  assert.equal(again.status, 200, again.body.toString('utf8'))
  assert.ok(revisionOf(again) > revision)
  const after = statSync(blobPath)
  assert.equal(after.dev, before.dev)
  assert.equal(after.ino, before.ino)
  assert.deepEqual(readFileSync(blobPath), original)
  const live = await readFile(id)
  assert.equal(live.status, 200)
  assert.equal(live.headers['x-fanotes-meta'], nextMeta)
  assert.equal(live.headers['x-fanotes-sha256'], sha256(original))
  const partsAfter = existsSync(incomingDir) ? readdirSync(incomingDir).filter((name) => name.endsWith('.part')) : []
  assert.deepEqual(partsAfter.sort(), partsBefore.sort())
})

test('putting different bytes still replaces the live note', async () => {
  const id = randomBytes(32).toString('hex')
  const original = randomBytes(5000)
  const created = await putFile(id, original, 0, { 'X-FaNotes-Blank': '0' })
  assert.equal(created.status, 200, created.body.toString('utf8'))
  const revision = revisionOf(created)
  const blobPath = join(dataDirectory, 'accounts', accountId, 'blobs', id)
  const before = statSync(blobPath)
  const next = randomBytes(4800)
  const replaced = await putFile(id, next, revision, { 'X-FaNotes-Blank': '0' })
  assert.equal(replaced.status, 200, replaced.body.toString('utf8'))
  const after = statSync(blobPath)
  assert.notEqual(after.ino, before.ino)
  assert.deepEqual(readFileSync(blobPath), next)
  assert.deepEqual(readFileSync(join(dataDirectory, 'accounts', accountId, 'revisions', id, String(revision))), original)
})

test('putting the same bytes recreates a missing live blob', async () => {
  const id = randomBytes(32).toString('hex')
  const original = randomBytes(5000)
  const created = await putFile(id, original, 0, { 'X-FaNotes-Blank': '0' })
  assert.equal(created.status, 200, created.body.toString('utf8'))
  const revision = revisionOf(created)
  const blobPath = join(dataDirectory, 'accounts', accountId, 'blobs', id)
  rmSync(blobPath)
  const again = await putFile(id, original, revision, { 'X-FaNotes-Blank': '0' })
  assert.equal(again.status, 200, again.body.toString('utf8'))
  assert.ok(revisionOf(again) > revision)
  assert.deepEqual(readFileSync(blobPath), original)
  const live = await readFile(id)
  assert.equal(live.status, 200)
  assert.deepEqual(live.body, original)
})

test('completing an upload of the same bytes keeps the live inode', async () => {
  const id = randomBytes(32).toString('hex')
  const original = randomBytes(5000)
  const created = await putFile(id, original, 0, { 'X-FaNotes-Blank': '0' })
  assert.equal(created.status, 200, created.body.toString('utf8'))
  const revision = revisionOf(created)
  const blobPath = join(dataDirectory, 'accounts', accountId, 'blobs', id)
  const before = statSync(blobPath)
  const nextMeta = b64(32)
  const openBody = Buffer.from(JSON.stringify({ size: original.length }))
  const opened = await call('POST', `/api/v1/sync/files/${id}/uploads`, {
    token,
    body: openBody,
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': String(openBody.length),
      'If-Match': String(revision),
      'X-FaNotes-Meta': nextMeta,
      'X-FaNotes-Sha256': sha256(original),
      'X-FaNotes-Blank': '0',
    },
  })
  assert.equal(opened.status, 201, opened.body.toString('utf8'))
  const uploadId = jsonOf(opened).uploadId
  const patched = await call('PATCH', `/api/v1/sync/files/${id}/uploads/${uploadId}`, {
    token,
    body: original,
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(original.length),
      'Upload-Offset': '0',
    },
  })
  assert.equal(patched.status, 200, patched.body.toString('utf8'))
  const finished = await call('POST', `/api/v1/sync/files/${id}/uploads/${uploadId}/complete`, {
    token,
    headers: {
      'Content-Length': '0',
      'If-Match': String(revision),
      'X-FaNotes-Meta': nextMeta,
      'X-FaNotes-Sha256': sha256(original),
      'X-FaNotes-Blank': '0',
    },
  })
  assert.equal(finished.status, 200, finished.body.toString('utf8'))
  assert.ok(revisionOf(finished) > revision)
  const after = statSync(blobPath)
  assert.equal(after.dev, before.dev)
  assert.equal(after.ino, before.ino)
  assert.deepEqual(readFileSync(blobPath), original)
  const live = await readFile(id)
  assert.equal(live.status, 200)
  assert.equal(live.headers['x-fanotes-meta'], nextMeta)
  assert.equal((await call('GET', `/api/v1/sync/files/${id}/uploads/${uploadId}`, { token })).status, 404)
})

test('a resumed upload of the same bytes stores the new metadata', async () => {
  const id = randomBytes(32).toString('hex')
  const original = randomBytes(5000)
  const created = await putFile(id, original, 0, { 'X-FaNotes-Blank': '0' })
  assert.equal(created.status, 200, created.body.toString('utf8'))
  const revision = revisionOf(created)
  const blobPath = join(dataDirectory, 'accounts', accountId, 'blobs', id)
  const nextMeta = b64(32)
  assert.notEqual(nextMeta, meta)
  const openBody = Buffer.from(JSON.stringify({ size: original.length }))
  const opened = await call('POST', `/api/v1/sync/files/${id}/uploads`, {
    token,
    body: openBody,
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': String(openBody.length),
      'If-Match': String(revision),
      'X-FaNotes-Meta': nextMeta,
      'X-FaNotes-Sha256': sha256(original),
      'X-FaNotes-Blank': '0',
    },
  })
  assert.equal(opened.status, 201, opened.body.toString('utf8'))
  const uploadId = jsonOf(opened).uploadId
  const patched = await call('PATCH', `/api/v1/sync/files/${id}/uploads/${uploadId}`, {
    token,
    body: original,
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(original.length),
      'Upload-Offset': '0',
    },
  })
  assert.equal(patched.status, 200, patched.body.toString('utf8'))
  const partialBody = join(dataDirectory, 'accounts', accountId, 'partials', uploadId, 'body.bin')
  renameSync(partialBody, blobPath)
  const renamed = statSync(blobPath)
  const completeHeaders = {
    'Content-Length': '0',
    'If-Match': String(revision),
    'X-FaNotes-Meta': nextMeta,
    'X-FaNotes-Sha256': sha256(original),
    'X-FaNotes-Blank': '0',
  }
  const finished = await call('POST', `/api/v1/sync/files/${id}/uploads/${uploadId}/complete`, {
    token,
    headers: completeHeaders,
  })
  assert.equal(finished.status, 200, finished.body.toString('utf8'))
  const stored = revisionOf(finished)
  assert.ok(stored > revision)
  const after = statSync(blobPath)
  assert.equal(after.dev, renamed.dev)
  assert.equal(after.ino, renamed.ino)
  assert.deepEqual(readFileSync(blobPath), original)
  const live = await readFile(id)
  assert.equal(live.status, 200)
  assert.equal(live.headers['x-fanotes-meta'], nextMeta)
  assert.equal(live.headers['x-fanotes-sha256'], sha256(original))
  assert.equal(existsSync(join(dataDirectory, 'accounts', accountId, 'partials', uploadId)), false)
  assert.equal(existsSync(join(dataDirectory, 'accounts', accountId, 'revisions', id)), false)
  const repeated = await call('POST', `/api/v1/sync/files/${id}/uploads/${uploadId}/complete`, {
    token,
    headers: { ...completeHeaders, 'If-Match': String(stored) },
  })
  assert.equal(repeated.status, 200, repeated.body.toString('utf8'))
  assert.equal(revisionOf(repeated), stored)
  assert.equal(statSync(blobPath).ino, renamed.ino)
  const stale = await call('POST', `/api/v1/sync/files/${id}/uploads/${uploadId}/complete`, {
    token,
    headers: completeHeaders,
  })
  assert.equal(stale.status, 409, stale.body.toString('utf8'))
  const conflict = jsonOf(stale)
  assert.equal(conflict.reason, 'stale')
  assert.equal(conflict.entry.meta, nextMeta)
  assert.equal(conflict.entry.revision, stored)
  assert.deepEqual(readFileSync(blobPath), original)
  assert.equal((await readFile(id)).headers['x-fanotes-meta'], nextMeta)
})

test('a rejected spool is removed and a stored note leaves no spool name', async () => {
  const id = randomBytes(32).toString('hex')
  const incomingDir = join(dataDirectory, 'accounts', accountId, 'incoming')
  const partNames = () => (existsSync(incomingDir) ? readdirSync(incomingDir).filter((name) => name.endsWith('.part')) : [])
  const before = partNames()
  const tiny = randomBytes(10)
  const rejected = await putFile(id, tiny, 0, { 'X-FaNotes-Blank': '0' })
  assert.equal(rejected.status, 400)
  assert.deepEqual(partNames().sort(), before.sort())
  const original = randomBytes(80)
  const created = await putFile(id, original, 0, { 'X-FaNotes-Blank': '0' })
  assert.equal(created.status, 200, created.body.toString('utf8'))
  assert.deepEqual(partNames().sort(), before.sort())
  assert.deepEqual((await readFile(id)).body, original)
  const revision = revisionOf(created)
  const openBody = Buffer.from(JSON.stringify({ size: original.length }))
  const opened = await call('POST', `/api/v1/sync/files/${id}/uploads`, {
    token,
    body: openBody,
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': String(openBody.length),
      'If-Match': String(revision),
      'X-FaNotes-Meta': meta,
      'X-FaNotes-Sha256': sha256(original),
      'X-FaNotes-Blank': '0',
    },
  })
  assert.equal(opened.status, 201, opened.body.toString('utf8'))
  const uploadId = jsonOf(opened).uploadId
  const patched = await call('PATCH', `/api/v1/sync/files/${id}/uploads/${uploadId}`, {
    token,
    body: original,
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(original.length),
      'Upload-Offset': '5',
    },
  })
  assert.equal(patched.status, 409)
  assert.deepEqual(partNames().sort(), before.sort())
  assert.deepEqual((await readFile(id)).body, original)
  const next = randomBytes(90)
  const replaced = await putFile(id, next, revision, { 'X-FaNotes-Blank': '0' })
  assert.equal(replaced.status, 200, replaced.body.toString('utf8'))
  assert.deepEqual(partNames().sort(), before.sort())
  assert.deepEqual((await readFile(id)).body, next)
})

test('a session touch does not replace a newer account or its note', async () => {
  const authKey = b64(32)
  const email = `touch-${randomBytes(4).toString('hex')}@example.com`
  const registered = await jsonCall('POST', '/api/v1/sync/register', {
    email,
    authKey,
    kdf: { algorithm: 'pbkdf2-sha256', iterations: 300000, salt: b64(16) },
    vaultKeyWrap: { iv: b64(12), data: b64(32) },
    device: { name: 'Check', platform: 'linux' },
  })
  assert.equal(registered.status, 201, JSON.stringify(registered.json))
  const localToken = registered.json.token
  const localAccount = registered.json.accountId
  const asAccount = (method, path, { headers = {}, body } = {}) => call(method, path, {
    token: localToken,
    body,
    headers: { ...headers, 'X-FaNotes-Account': localAccount },
  })
  const id = randomBytes(32).toString('hex')
  const original = randomBytes(5000)
  const created = await asAccount('PUT', `/api/v1/sync/files/${id}`, {
    body: original,
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(original.length),
      'If-Match': '0',
      'X-FaNotes-Meta': meta,
      'X-FaNotes-Sha256': sha256(original),
      'X-FaNotes-Blank': '0',
    },
  })
  assert.equal(created.status, 200, created.body.toString('utf8'))
  const accountPath = join(dataDirectory, 'accounts', localAccount, 'account.json')
  const blobPath = join(dataDirectory, 'accounts', localAccount, 'blobs', id)
  const backdate = () => {
    const record = JSON.parse(readFileSync(accountPath, 'utf8'))
    const old = new Date(Date.now() - 7 * 60 * 60 * 1000).toISOString()
    for (const session of Object.values(record.sessions)) session.lastSeenAt = old
    for (const device of Object.values(record.devices)) device.lastSeenAt = old
    writeFileSync(accountPath, `${JSON.stringify(record, null, 2)}\n`)
  }
  let currentKey = authKey
  for (let round = 0; round < 3; round += 1) {
    backdate()
    const nextKey = b64(32)
    const nextWrap = { iv: b64(12), data: b64(32) }
    const nextKdf = { algorithm: 'pbkdf2-sha256', iterations: 300000 + round, salt: b64(16) }
    const body = Buffer.from(JSON.stringify({
      authKey: currentKey,
      newAuthKey: nextKey,
      kdf: nextKdf,
      vaultKeyWrap: nextWrap,
    }))
    const results = await Promise.all([
      ...Array.from({ length: 6 }, () => asAccount('GET', `/api/v1/sync/files/${id}`)),
      asAccount('POST', '/api/v1/sync/password', {
        body,
        headers: { 'Content-Type': 'application/json', 'Content-Length': String(body.length) },
      }),
    ])
    const changed = results[results.length - 1]
    assert.equal(changed.status, 204, changed.body.toString('utf8'))
    const stored = JSON.parse(readFileSync(accountPath, 'utf8'))
    assert.equal(stored.vaultKeyWrap.data, nextWrap.data)
    assert.equal(stored.vaultKeyWrap.iv, nextWrap.iv)
    assert.equal(stored.kdf.iterations, nextKdf.iterations)
    const live = await asAccount('GET', `/api/v1/sync/files/${id}`)
    assert.equal(live.status, 200)
    assert.deepEqual(live.body, original)
    currentKey = nextKey
  }
  backdate()
  const leaving = await Promise.all([
    ...Array.from({ length: 6 }, () => asAccount('GET', `/api/v1/sync/files/${id}`)),
    asAccount('POST', '/api/v1/sync/logout'),
  ])
  assert.equal(leaving[leaving.length - 1].status, 204, leaving[leaving.length - 1].body.toString('utf8'))
  const signedOut = await asAccount('GET', `/api/v1/sync/files/${id}`)
  assert.equal(signedOut.status, 401)
  assert.deepEqual(readFileSync(blobPath), original)
  const stored = JSON.parse(readFileSync(accountPath, 'utf8'))
  const tokenHash = createHash('sha256').update(localToken).digest('hex')
  assert.equal(stored.sessions[tokenHash], undefined)
  assert.equal(stored.vaultKeyWrap.data.length > 0, true)
})
