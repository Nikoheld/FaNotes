// Property checks for the sync write decision, then a seeded multi-device run
// against the real handler. Bodies are anonymous bytes. No notes, names, or keys.
import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { createServer, request as httpRequest } from 'node:http'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { connect as connectTcp } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

const dataDirectory = mkdtempSync(join(tmpdir(), 'fanotes-sync-fuzz-'))
process.env.FANOTES_SYNC_DIR = dataDirectory
process.env.FANOTES_PUBLIC_ORIGIN = 'http://127.0.0.1'
const { handleSyncRequest, evaluateSyncWrite } = await import('./sync-api.mjs')

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
const mulberry32 = (seed) => {
  let state = seed >>> 0
  return () => {
    state |= 0
    state = (state + 0x6D2B79F5) | 0
    let value = Math.imul(state ^ (state >>> 15), 1 | state)
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296
  }
}
const EMPTY = 28
const collapse = (previous, next) => previous >= 4096 && (next <= 1024 || next * 4 < previous)

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

const jsonCall = async (method, path, payload, token, accountId) => {
  const body = Buffer.from(JSON.stringify(payload))
  const response = await call(method, path, {
    token,
    accountId,
    body,
    headers: { 'Content-Type': 'application/json', 'Content-Length': body.length },
  })
  return { status: response.status, json: JSON.parse(response.body.toString('utf8')), headers: response.headers }
}

const authKey = b64(32)
const email = 'fuzz-devices@example.com'
const registered = await jsonCall('POST', '/api/v1/sync/register', {
  email,
  authKey,
  kdf: { algorithm: 'pbkdf2-sha256', iterations: 300000, salt: b64(16) },
  vaultKeyWrap: { iv: b64(12), data: b64(32) },
  device: { name: 'Laptop', platform: 'linux' },
})
assert.equal(registered.status, 201, JSON.stringify(registered.json))
const accountId = registered.json.accountId
const devices = [
  { name: 'Laptop', token: registered.json.token, offsetMs: 0, base: new Map() },
]
for (const device of [
  { name: 'Tablet', platform: 'android', offsetMs: 3 * 24 * 60 * 60 * 1000 },
  { name: 'Phone', platform: 'web', offsetMs: -400 * 24 * 60 * 60 * 1000 },
]) {
  const loggedIn = await jsonCall('POST', '/api/v1/sync/login', {
    email,
    authKey,
    device: { name: device.name, platform: device.platform },
  })
  assert.equal(loggedIn.status, 200, JSON.stringify(loggedIn.json))
  devices.push({ name: device.name, token: loggedIn.json.token, offsetMs: device.offsetMs, base: new Map() })
}

const metaFor = (device) => {
  const skewed = new Date(Date.now() + device.offsetMs).toISOString()
  return Buffer.concat([Buffer.from(JSON.stringify({ mtime: skewed })), Buffer.alloc(24)]).toString('base64')
}

const putFile = (device, id, bytes, base, headers = {}) => call('PUT', `/api/v1/sync/files/${id}`, {
  token: device.token,
  accountId,
  body: bytes,
  headers: {
    'Content-Type': 'application/octet-stream',
    'Content-Length': bytes.length,
    'If-Match': String(base),
    'X-FaNotes-Meta': metaFor(device),
    'X-FaNotes-Sha256': sha256(bytes),
    ...headers,
  },
})

const readLive = async (id) => {
  const response = await call('GET', `/api/v1/sync/files/${id}`, { token: devices[0].token, accountId })
  return {
    status: response.status,
    body: response.status === 200 ? response.body : Buffer.alloc(0),
    revision: Number(response.headers['x-fanotes-revision'] || 0),
  }
}

const archiveSizes = (id) => {
  const directory = join(dataDirectory, 'accounts', accountId, 'revisions', id)
  if (!existsSync(directory)) return []
  return readdirSync(directory)
    .filter((name) => /^(?:c-)?\d+$/u.test(name))
    .map((name) => statSync(join(directory, name)).size)
}

const remembered = new Map()

const remember = (id, bytes) => {
  const row = remembered.get(id) || { max: 0 }
  row.max = Math.max(row.max, bytes.length)
  remembered.set(id, row)
}

const assertKept = (id, liveSize) => {
  const row = remembered.get(id)
  if (!row || row.max <= liveSize) return
  assert.ok(archiveSizes(id).includes(row.max), `${id} lost its largest blob (${row.max} > live ${liveSize})`)
}

const serverYear = String(new Date().getFullYear())

const assertClockIgnored = async (id) => {
  const response = await call('GET', `/api/v1/sync/changes?since=0`, { token: devices[0].token, accountId })
  const payload = JSON.parse(response.body.toString('utf8'))
  const entry = payload.entries.find((item) => item.id === id)
  assert.ok(entry?.updatedAt, 'missing updatedAt')
  assert.equal(entry.updatedAt.slice(0, 4), serverYear)
  assert.ok(Math.abs(Date.parse(entry.updatedAt) - Date.now()) < 60_000)
}

test.after(() => new Promise((resolve) => {
  server.close(() => {
    rmSync(dataDirectory, { recursive: true, force: true })
    resolve()
  })
}))

test('a write decision never lets a stale base or an empty body replace newer content', () => {
  const rng = mulberry32(20261115)
  const sizes = [0, 28, 40, 200, 600, 1500, 4096, 5000, 20000]
  const nextSizes = [28, 29, 200, 600, 1000, 1024, 4096, 5000, 19000]
  for (let step = 0; step < 3000; step += 1) {
    const exists = rng() < 0.85
    const deleted = rng() < 0.35
    const size = sizes[Math.floor(rng() * sizes.length)]
    const revision = Math.floor(rng() * 8)
    const current = exists ? { deleted, size, revision } : null
    const base = Math.floor(rng() * 8)
    const nextSize = nextSizes[Math.floor(rng() * nextSizes.length)]
    const blankRoll = rng()
    const blank = blankRoll < 0.2 ? true : blankRoll < 0.4 ? null : false
    const clear = rng() < 0.1
    const archivedSize = sizes[Math.floor(rng() * sizes.length)]
    const input = { current, base, nextSize, blank, clear, archivedSize }
    const decision = evaluateSyncWrite(input)
    assert.ok(decision === 'accept' || decision === 'stale' || decision === 'guard', JSON.stringify(input))
    assert.equal(evaluateSyncWrite(input), decision)

    if (!current && base !== 0) assert.equal(decision, 'stale')
    if (!current && base === 0) assert.equal(decision, 'accept')
    if (current && !current.deleted && base !== current.revision) assert.equal(decision, 'stale')
    if (clear) assert.notEqual(decision, 'guard')

    if (current && !current.deleted && base === current.revision && !clear && current.size > EMPTY) {
      const blocked = blank === true || nextSize <= EMPTY || collapse(current.size, nextSize)
      assert.equal(decision, blocked ? 'guard' : 'accept', JSON.stringify(input))
    }
    if (current?.deleted && !clear && (blank === true || nextSize <= EMPTY)) assert.equal(decision, 'guard')
    if (current?.deleted && !clear && blank !== true && nextSize > EMPTY) {
      const blocked = collapse(archivedSize, nextSize)
      if (blocked) assert.equal(decision, 'guard', JSON.stringify(input))
      else if (base === current.revision || base < current.revision) assert.equal(decision, 'accept')
      else assert.equal(decision, 'stale')
    }
  }
})

test('three devices keep the newer note across clock skew, offline replay, empty writes, and truncated uploads', async () => {
  const id = randomBytes(32).toString('hex')
  const laptop = devices[0]
  const tablet = devices[1]
  const phone = devices[2]
  const original = Buffer.alloc(8000, 7)
  const created = await putFile(phone, id, original, 0, { 'X-FaNotes-Blank': '0' })
  assert.equal(created.status, 200, created.body.toString('utf8'))
  const revision = JSON.parse(created.body.toString('utf8')).revision
  remember(id, original)
  phone.base.set(id, revision)
  // The phone's clock is hundreds of days behind. The stored time is the server's.
  await assertClockIgnored(id)

  // The tablet's clock is days ahead and its base is stale. The future mtime is inside the meta header.
  const ahead = Buffer.alloc(8000, 9)
  const skewed = await putFile(tablet, id, ahead, 0, { 'X-FaNotes-Blank': '0' })
  assert.equal(skewed.status, 409)
  assert.equal(JSON.parse(skewed.body.toString('utf8')).reason, 'stale')
  assert.deepEqual((await readLive(id)).body, original)

  // Offline, the phone queues an older short edit and an empty file, then replays both after the laptop has moved on.
  const phoneQueue = [
    { bytes: Buffer.alloc(600, 3), headers: { 'X-FaNotes-Blank': '0' }, base: 0 },
    { bytes: Buffer.alloc(EMPTY, 1), headers: { 'X-FaNotes-Blank': '0' }, base: 0 },
  ]
  const edited = Buffer.alloc(7000, 4)
  const second = await putFile(laptop, id, edited, revision, { 'X-FaNotes-Blank': '0' })
  assert.equal(second.status, 200, second.body.toString('utf8'))
  remember(id, edited)
  for (const queued of phoneQueue) {
    const replayed = await putFile(phone, id, queued.bytes, queued.base, queued.headers)
    assert.equal(replayed.status, 409, replayed.body.toString('utf8'))
    assert.deepEqual((await readLive(id)).body, edited)
  }

  const removed = await call('DELETE', `/api/v1/sync/files/${id}`, {
    token: laptop.token,
    accountId,
    headers: { 'If-Match': String(JSON.parse(second.body.toString('utf8')).revision), 'X-FaNotes-Delete': '1' },
  })
  assert.equal(removed.status, 200, removed.body.toString('utf8'))
  assert.equal(existsSync(join(dataDirectory, 'accounts', accountId, 'blobs', id)), false)
  assert.ok(archiveSizes(id).includes(edited.length))

  const tombstone = JSON.parse(removed.body.toString('utf8')).revision
  const truncated = await putFile(phone, id, Buffer.alloc(180, 2), tombstone, { 'X-FaNotes-Blank': '0' })
  assert.equal(truncated.status, 409)
  assert.equal(JSON.parse(truncated.body.toString('utf8')).reason, 'guard')
  assert.equal((await readLive(id)).status, 204)
  const empty = await putFile(tablet, id, Buffer.alloc(EMPTY, 5), 0, {})
  assert.equal(empty.status, 409)
  assert.equal((await readLive(id)).status, 204)

  const restored = Buffer.alloc(7600, 6)
  const back = await putFile(tablet, id, restored, 0, { 'X-FaNotes-Blank': '0' })
  assert.equal(back.status, 200, back.body.toString('utf8'))
  assert.deepEqual((await readLive(id)).body, restored)
  remember(id, restored)
  assertKept(id, restored.length)

  // A raw upload that claims more bytes than it sends must not replace the note.
  const other = Buffer.alloc(7600, 8)
  const status = await new Promise((resolve, reject) => {
    const socket = connectTcp(port, '127.0.0.1', () => {
      const head = Buffer.from(
        `PUT /api/v1/sync/files/${id} HTTP/1.1\r\n` +
        `Host: 127.0.0.1\r\n` +
        `Authorization: Bearer ${phone.token}\r\n` +
        `X-FaNotes-Account: ${accountId}\r\n` +
        `Content-Type: application/octet-stream\r\n` +
        `Content-Length: ${other.length + 80}\r\n` +
        `If-Match: ${JSON.parse(back.body.toString('utf8')).revision}\r\n` +
        `X-FaNotes-Meta: ${metaFor(phone)}\r\n` +
        `X-FaNotes-Sha256: ${sha256(other)}\r\n` +
        `X-FaNotes-Blank: 0\r\n` +
        `Connection: close\r\n\r\n`,
      )
      socket.end(Buffer.concat([head, other]))
    })
    const chunks = []
    const timer = setTimeout(() => {
      socket.destroy()
      reject(new Error('truncated upload timed out'))
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
  assert.equal(status, 400)
  assert.deepEqual((await readLive(id)).body, restored)
})

test('concurrent devices leave exactly one body, and a random walk never drops the largest note', async () => {
  const id = randomBytes(32).toString('hex')
  const seedBody = Buffer.alloc(5000, 11)
  const created = await putFile(devices[0], id, seedBody, 0, { 'X-FaNotes-Blank': '0' })
  assert.equal(created.status, 200, created.body.toString('utf8'))
  const base = JSON.parse(created.body.toString('utf8')).revision
  remember(id, seedBody)
  const contenders = devices.map((device, index) => Buffer.alloc(5200 + index, 20 + index))
  const raced = await Promise.all(contenders.map((bytes, index) => putFile(devices[index], id, bytes, base, { 'X-FaNotes-Blank': '0' })))
  const winners = raced.filter((response) => response.status === 200)
  assert.equal(winners.length, 1, raced.map((response) => response.status).join(','))
  const winner = contenders[raced.findIndex((response) => response.status === 200)]
  assert.deepEqual((await readLive(id)).body, winner)
  remember(id, winner)

  const rng = mulberry32(20261115)
  const sizes = [EMPTY, 40, 200, 500, 600, 1500, 3000, 5000, 9000]
  const ids = [id, randomBytes(32).toString('hex'), randomBytes(32).toString('hex')]
  for (const fileId of ids) devices.forEach((device) => device.base.set(fileId, device.base.get(fileId) || 0))
  devices[0].base.set(id, JSON.parse(winners[0].body.toString('utf8')).revision)

  for (let step = 0; step < 36; step += 1) {
    const device = devices[Math.floor(rng() * devices.length)]
    const fileId = ids[Math.floor(rng() * ids.length)]
    const before = await readLive(fileId)
    const useStale = rng() < 0.35
    if (!useStale && before.revision) device.base.set(fileId, before.revision)
    const writeBase = useStale || before.status === 404 ? 0 : (device.base.get(fileId) || 0)
    const bytes = Buffer.alloc(sizes[Math.floor(rng() * sizes.length)], 1 + Math.floor(rng() * 250))
    const blank = rng() < 0.15 ? '1' : '0'
    const clear = rng() < 0.08
    const headers = { 'X-FaNotes-Blank': blank, ...(clear ? { 'X-FaNotes-Clear': '1' } : {}) }
    const response = await putFile(device, fileId, bytes, writeBase, headers)
    const after = await readLive(fileId)
    const previousSize = before.status === 200 ? before.body.length : (before.status === 204 ? Math.max(0, ...archiveSizes(fileId), 0) : 0)
    const destructive = before.status === 204
      ? (!clear && (blank === '1' || bytes.length <= EMPTY || collapse(previousSize, bytes.length)))
      : (before.status === 200 && !clear && previousSize > EMPTY && (blank === '1' || bytes.length <= EMPTY || collapse(previousSize, bytes.length)))
    if (destructive) assert.notEqual(response.status, 200, `step ${step} stored a destructive body`)
    if (before.status === 200 && writeBase !== before.revision) {
      assert.notEqual(response.status, 200, `step ${step} stored a stale body over a live note`)
    }
    if (response.status === 200) {
      assert.deepEqual(after.body, bytes, `step ${step}`)
      remember(fileId, bytes)
      device.base.set(fileId, JSON.parse(response.body.toString('utf8')).revision)
    } else {
      assert.equal(after.status, before.status, `step ${step} status ${response.status}`)
      assert.deepEqual(after.body, before.body, `step ${step}`)
      if (response.status === 409) {
        const payload = JSON.parse(response.body.toString('utf8'))
        if (payload.entry?.revision) device.base.set(fileId, payload.entry.revision)
      }
    }
    assertKept(fileId, after.status === 200 ? after.body.length : 0)
  }
})
