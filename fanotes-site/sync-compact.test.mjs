// Compaction must keep every note after the change log is truncated.
import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { createServer, request as httpRequest } from 'node:http'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

const dataDirectory = mkdtempSync(join(tmpdir(), 'fanotes-sync-compact-'))
process.env.FANOTES_SYNC_DIR = dataDirectory
process.env.FANOTES_SYNC_COMPACT_BYTES = '200'
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
  return { status: response.status, json: JSON.parse(response.body.toString('utf8')) }
}

const registered = await jsonCall('POST', '/api/v1/sync/register', {
  email: 'compact@example.com',
  authKey,
  kdf: { algorithm: 'pbkdf2-sha256', iterations: 300000, salt: b64(16) },
  vaultKeyWrap: { iv: b64(12), data: b64(32) },
  device: { name: 'Compact', platform: 'linux' },
})
assert.equal(registered.status, 201)
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

test('compacting the change log keeps the notes that were in it', async () => {
  const firstId = randomBytes(32).toString('hex')
  const secondId = randomBytes(32).toString('hex')
  const first = randomBytes(80)
  const second = randomBytes(90)
  const created = await putFile(firstId, first, 0)
  assert.equal(created.status, 200, created.body.toString('utf8'))
  const again = await putFile(secondId, second, 0)
  assert.equal(again.status, 200, again.body.toString('utf8'))
  const log = readFileSync(join(dataDirectory, 'accounts', accountId, 'changes.jsonl'))
  assert.equal(log.length, 0)
  assert.equal(readdirSync(join(dataDirectory, 'accounts', accountId)).some((name) => name.endsWith('.tmp')), false)
  const index = JSON.parse(readFileSync(join(dataDirectory, 'accounts', accountId, 'index.json'), 'utf8'))
  assert.equal(index.entries[firstId].deleted, false)
  assert.equal(index.entries[secondId].deleted, false)
  assert.deepEqual((await call('GET', `/api/v1/sync/files/${firstId}`, { token, accountId })).body, first)
  assert.deepEqual((await call('GET', `/api/v1/sync/files/${secondId}`, { token, accountId })).body, second)
})

test('a deleted note can be restored after the change log is compacted', async () => {
  const id = randomBytes(32).toString('hex')
  const original = randomBytes(5000)
  const created = await putFile(id, original, 0)
  assert.equal(created.status, 200, created.body.toString('utf8'))
  const firstRevision = JSON.parse(created.body.toString('utf8')).revision
  const replaced = await putFile(id, randomBytes(4800), firstRevision)
  assert.equal(replaced.status, 200, replaced.body.toString('utf8'))
  const secondRevision = JSON.parse(replaced.body.toString('utf8')).revision
  const removed = await call('DELETE', `/api/v1/sync/files/${id}`, {
    token,
    accountId,
    headers: { 'If-Match': String(secondRevision), 'X-FaNotes-Delete': '1' },
  })
  assert.equal(removed.status, 200, removed.body.toString('utf8'))
  const deletedRevision = JSON.parse(removed.body.toString('utf8')).revision
  const log = readFileSync(join(dataDirectory, 'accounts', accountId, 'changes.jsonl'))
  assert.equal(log.length, 0)
  assert.equal(readdirSync(join(dataDirectory, 'accounts', accountId)).some((name) => name.endsWith('.tmp')), false)
  const index = JSON.parse(readFileSync(join(dataDirectory, 'accounts', accountId, 'index.json'), 'utf8'))
  assert.equal(index.entries[id].deleted, true)
  assert.equal(index.entries[id].meta, meta)
  const feed = JSON.parse((await call('GET', '/api/v1/sync/changes?since=0', { token, accountId })).body.toString('utf8'))
  const listed = feed.entries.find((entry) => entry.id === id)
  assert.equal(listed.deleted, true)
  assert.equal(listed.meta, null)
  const restored = await jsonCall('POST', `/api/v1/sync/files/${id}/restore`, { revision: firstRevision }, token, accountId, { 'If-Match': String(deletedRevision) })
  assert.equal(restored.status, 200, JSON.stringify(restored.json))
  const live = await call('GET', `/api/v1/sync/files/${id}`, { token, accountId })
  assert.equal(live.status, 200)
  assert.equal(live.headers['x-fanotes-meta'], meta)
  assert.deepEqual(live.body, original)
})

test('a failed log write does not publish the revision', async () => {
  const id = randomBytes(32).toString('hex')
  const original = randomBytes(120)
  const created = await putFile(id, original, 0)
  assert.equal(created.status, 200, created.body.toString('utf8'))
  const createdJson = JSON.parse(created.body.toString('utf8'))
  const revision = createdJson.revision
  const newer = randomBytes(180)
  process.env.FANOTES_SYNC_APPEND_FAIL = '1'
  try {
    const failed = await putFile(id, newer, revision)
    assert.equal(failed.status, 500)
    const feed = JSON.parse((await call('GET', '/api/v1/sync/changes?since=0', { token, accountId })).body.toString('utf8'))
    const listed = feed.entries.find((entry) => entry.id === id)
    assert.equal(listed.revision, revision)
    assert.equal(listed.sha256, sha256(original))
    assert.equal(feed.revision, createdJson.tableRevision)
    let logText = ''
    try {
      logText = readFileSync(join(dataDirectory, 'accounts', accountId, 'changes.jsonl'), 'utf8')
    } catch {
      logText = ''
    }
    assert.equal(logText.includes(sha256(newer)), false)
  } finally {
    delete process.env.FANOTES_SYNC_APPEND_FAIL
  }
  const retried = await putFile(id, newer, revision)
  assert.equal(retried.status, 200, retried.body.toString('utf8'))
  const saved = JSON.parse(retried.body.toString('utf8'))
  assert.ok(saved.revision > revision)
  const live = await call('GET', `/api/v1/sync/files/${id}`, { token, accountId })
  assert.equal(live.status, 200)
  assert.deepEqual(live.body, newer)
  const after = JSON.parse((await call('GET', '/api/v1/sync/changes?since=0', { token, accountId })).body.toString('utf8'))
  const published = after.entries.find((entry) => entry.id === id)
  assert.equal(published.revision, saved.revision)
  assert.equal(published.sha256, sha256(newer))
})

test.after(() => new Promise((resolve) => {
  server.close(() => {
    rmSync(dataDirectory, { recursive: true, force: true })
    resolve()
  })
}))
