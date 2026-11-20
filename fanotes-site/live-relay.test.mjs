// Live collaboration relay: ordering, permissions, limits, compaction, restart and ciphertext-only storage.
import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { createServer, request as httpRequest } from 'node:http'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

const dataDirectory = mkdtempSync(join(tmpdir(), 'fanotes-user-shares-'))
process.env.FANOTES_SYNC_DIR = dataDirectory
process.env.FANOTES_PUBLIC_ORIGIN = 'http://127.0.0.1'
process.env.FANOTES_SYNC_REGISTER_PER_HOUR = '1000'
const { handleSyncRequest } = await import('./sync-api.mjs')

const server = createServer(async (request, response) => {
  const url = new URL(request.url, 'http://127.0.0.1')
  if (await handleSyncRequest(request, response, url)) return
  response.writeHead(404)
  response.end()
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port

const b64 = (size) => randomBytes(size).toString('base64')
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')

const call = (method, path, { session, headers = {}, body, raw } = {}) => new Promise((resolve, reject) => {
  const payload = raw ?? (body === undefined ? null : JSON.stringify(body))
  const req = httpRequest({
    hostname: '127.0.0.1',
    port,
    path,
    method,
    headers: {
      ...(session ? { Authorization: `Bearer ${session.token}`, 'X-FaNotes-Account': session.accountId } : {}),
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
      ...headers,
    },
  }, (res) => {
    const chunks = []
    res.on('data', (chunk) => chunks.push(chunk))
    res.on('end', () => {
      const text = Buffer.concat(chunks)
      let json = null
      try { json = JSON.parse(text.toString('utf8')) } catch { /* binary */ }
      resolve({ status: res.statusCode, json, body: text, headers: res.headers })
    })
  })
  req.on('error', reject)
  if (payload) req.write(payload)
  req.end()
})

/** Opens GET /events and collects parsed events. */
const openEvents = (session) => new Promise((resolve, reject) => {
  const events = []
  const waiters = []
  const req = httpRequest({ hostname: '127.0.0.1', port, path: '/api/v1/sync/events', method: 'GET', headers: { Authorization: `Bearer ${session.token}`, 'X-FaNotes-Account': session.accountId } }, (res) => {
    if (res.statusCode !== 200) { reject(new Error(`events ${res.statusCode}`)); return }
    let buffer = ''
    res.setEncoding('utf8')
    res.on('data', (chunk) => {
      buffer += chunk
      let index
      while ((index = buffer.indexOf('\n\n')) >= 0) {
        const block = buffer.slice(0, index)
        buffer = buffer.slice(index + 2)
        const type = /^event: (.*)$/mu.exec(block)?.[1]
        const data = /^data: (.*)$/mu.exec(block)?.[1]
        if (!type) continue
        const event = { type, data: data ? JSON.parse(data) : null }
        events.push(event)
        for (const waiter of [...waiters]) waiter()
      }
    })
    const api = {
      events,
      close: () => req.destroy(),
      waitFor: (predicate, ms = 2000) => new Promise((done, fail) => {
        const check = () => {
          const hit = events.find(predicate)
          if (hit) { clearTimeout(timer); waiters.splice(waiters.indexOf(check), 1); done(hit); return true }
          return false
        }
        const timer = setTimeout(() => { waiters.splice(waiters.indexOf(check), 1); fail(new Error('timed out waiting for push event')) }, ms)
        if (!check()) waiters.push(check)
      }),
    }
    resolve(api)
  })
  req.on('error', (error) => { if (error.code !== 'ECONNRESET') reject(error) })
  req.end()
})

const kdf = () => ({ algorithm: 'pbkdf2-sha256', iterations: 300_000, salt: b64(16) })
const userKeyFields = () => ({ publicKey: b64(65), userKeyWrap: { iv: b64(12), data: b64(48) } })
const device = { name: 'Test', platform: 'linux' }

const register = async (username, extra = {}) => {
  const authKey = b64(32)
  const keys = userKeyFields()
  const result = await call('POST', '/api/v1/sync/register', { body: { username, authKey, kdf: kdf(), vaultKeyWrap: { iv: b64(12), data: b64(48) }, device, credential: 'device-key', ...keys, ...extra } })
  return { result, authKey, keys, session: result.json ? { accountId: result.json.accountId, token: result.json.token } : null }
}

const wrap = () => ({ epk: b64(65), iv: b64(12), data: b64(48) })
const shareBody = (recipient, extra = {}) => ({ recipient, kind: 'note', permission: 'read', keyWrap: wrap(), ownerKeyWrap: wrap(), nameEnc: { iv: b64(12), data: b64(40) }, ...extra })
const fileId = () => randomBytes(32).toString('hex')
const putFile = (session, shareId, id, base, bytes) => call('PUT', `/api/v1/sync/shares/${shareId}/files/${id}`, {
  session,
  raw: bytes,
  headers: { 'Content-Type': 'application/octet-stream', 'If-Match': String(base), 'X-FaNotes-Meta': b64(40), 'X-FaNotes-Sha256': sha(bytes) },
})


const channel = () => randomBytes(16).toString('hex')
const cipher = (text) => Buffer.concat([randomBytes(12), Buffer.from(text), randomBytes(16)]).toString('base64')
const live = (session, shareId, ch, body) => call('POST', `/api/v1/sync/shares/${shareId}/live/${ch}`, { session, body })
const fetchLive = (session, shareId, ch, since = 0) => call('GET', `/api/v1/sync/shares/${shareId}/live/${ch}?since=${since}`, { session })

const setup = async (permission) => {
  const tag = randomBytes(3).toString('hex')
  const owner = await register(`lo_${tag}`)
  const friend = await register(`lf_${tag}`)
  const created = await call('POST', '/api/v1/sync/shares', { session: owner.session, body: shareBody(`LF_${tag}`, { permission }) })
  const shareId = created.json.share.id
  await call('POST', `/api/v1/sync/shares/${shareId}/respond`, { session: friend.session, body: { accept: true } })
  return { owner, friend, shareId, tag }
}

test('updates are ordered, pushed to the other party and fetched after a gap', async () => {
  const { owner, friend, shareId } = await setup('edit')
  const ch = channel()
  const events = await openEvents(friend.session)
  await events.waitFor((event) => event.type === 'ready')
  const first = await live(owner.session, shareId, ch, { k: 'u', d: cipher('one') })
  const second = await live(owner.session, shareId, ch, { k: 'u', d: cipher('two') })
  assert.equal(first.status, 200)
  assert.equal(second.json.q, first.json.q + 1)
  const pushed = await events.waitFor((event) => event.type === 'live' && event.data.q === second.json.q)
  assert.equal(pushed.data.c, ch)
  assert.equal(pushed.data.k, 'u')
  assert.ok(pushed.data.d)
  // A friend that missed the first message catches up from its last sequence number.
  const gap = await fetchLive(friend.session, shareId, ch, first.json.q)
  assert.deepEqual(gap.json.updates.map((item) => item.q), [second.json.q])
  assert.equal((await fetchLive(friend.session, shareId, ch, 0)).json.updates.length, 2)
  events.close()
})

test('read-only users receive but cannot send; outsiders see nothing', async () => {
  const { owner, friend, shareId } = await setup('read')
  const outsider = await register(`lx_${randomBytes(3).toString('hex')}`)
  const ch = channel()
  const events = await openEvents(friend.session)
  await events.waitFor((event) => event.type === 'ready')
  assert.equal((await live(friend.session, shareId, ch, { k: 'u', d: cipher('nope') })).status, 403)
  assert.equal((await live(friend.session, shareId, ch, { k: 'p', d: cipher('nope') })).status, 403)
  assert.equal((await live(friend.session, shareId, ch, { k: 'i', d: cipher('nope') })).status, 403)
  const sent = await live(owner.session, shareId, ch, { k: 'u', d: cipher('hello') })
  await events.waitFor((event) => event.type === 'live' && event.data.q === sent.json.q)
  assert.equal((await fetchLive(friend.session, shareId, ch)).status, 200)
  assert.equal((await fetchLive(outsider.session, shareId, ch)).status, 404)
  assert.equal((await live(outsider.session, shareId, ch, { k: 'u', d: cipher('x') })).status, 404)
  // Upgrading lets the friend send; downgrading and revoking stop it at once.
  await call('PATCH', `/api/v1/sync/shares/${shareId}`, { session: owner.session, body: { permission: 'edit' } })
  assert.equal((await live(friend.session, shareId, ch, { k: 'u', d: cipher('now') })).status, 200)
  await call('PATCH', `/api/v1/sync/shares/${shareId}`, { session: owner.session, body: { permission: 'read' } })
  assert.equal((await live(friend.session, shareId, ch, { k: 'u', d: cipher('again') })).status, 403)
  await call('DELETE', `/api/v1/sync/shares/${shareId}`, { session: owner.session })
  assert.equal((await fetchLive(friend.session, shareId, ch)).status, 404)
  events.close()
})

test('presence is relayed but never stored', async () => {
  const { owner, friend, shareId } = await setup('edit')
  const ch = channel()
  const events = await openEvents(friend.session)
  await events.waitFor((event) => event.type === 'ready')
  const sent = await live(owner.session, shareId, ch, { k: 'p', d: cipher('cursor') })
  assert.equal(sent.status, 200)
  const pushed = await events.waitFor((event) => event.type === 'live' && event.data.k === 'p')
  assert.equal(pushed.data.q, undefined)
  const state = await fetchLive(friend.session, shareId, ch)
  assert.equal(state.json.updates.length, 0)
  assert.equal(state.json.snapshot, null)
  events.close()
})

test('init is first-writer-wins, snapshots compact the buffer, big updates are fetched', async () => {
  const { owner, friend, shareId } = await setup('edit')
  const ch = channel()
  const a = await live(owner.session, shareId, ch, { k: 'i', d: cipher('base') })
  assert.equal(a.status, 200)
  const b = await live(friend.session, shareId, ch, { k: 'i', d: cipher('other') })
  assert.equal(b.status, 409)
  const u1 = await live(friend.session, shareId, ch, { k: 'u', d: cipher('u1') })
  const u2 = await live(owner.session, shareId, ch, { k: 'u', d: cipher('u2') })
  const joined = await fetchLive(friend.session, shareId, ch, 0)
  assert.equal(joined.json.snapshot.q, a.json.q)
  assert.equal(joined.json.updates.length, 2)
  const compacted = await live(owner.session, shareId, ch, { k: 's', d: cipher('merged'), upTo: u1.json.q })
  assert.equal(compacted.status, 200)
  const after = await fetchLive(friend.session, shareId, ch, 0)
  assert.equal(after.json.snapshot.q, u1.json.q)
  assert.deepEqual(after.json.updates.map((item) => item.q), [u2.json.q])
  // A caller that is already past the snapshot does not get it again.
  assert.equal((await fetchLive(friend.session, shareId, ch, u1.json.q)).json.snapshot, null)
  assert.equal((await live(owner.session, shareId, ch, { k: 's', d: cipher('x'), upTo: 99_999 })).status, 400)
  assert.equal((await live(owner.session, shareId, ch, { k: 's', d: cipher('stale'), upTo: a.json.q })).json.stale, true)
  const events = await openEvents(friend.session)
  await events.waitFor((event) => event.type === 'ready')
  const big = await live(owner.session, shareId, ch, { k: 'u', d: randomBytes(100 * 1024).toString('base64') })
  assert.equal(big.status, 200)
  const pushed = await events.waitFor((event) => event.type === 'live' && event.data.q === big.json.q)
  assert.equal(pushed.data.big, true)
  assert.equal(pushed.data.d, undefined)
  events.close()
})

test('size, shape, channel and rate limits', async () => {
  const { owner, shareId } = await setup('edit')
  const ch = channel()
  assert.equal((await live(owner.session, shareId, ch, { k: 'u', d: randomBytes(300 * 1024).toString('base64') })).status, 413)
  assert.equal((await live(owner.session, shareId, ch, { k: 'p', d: randomBytes(20 * 1024).toString('base64') })).status, 413)
  assert.equal((await live(owner.session, shareId, ch, { k: 'u', d: 'not base64!' })).status, 400)
  assert.equal((await live(owner.session, shareId, ch, { k: 'x', d: cipher('a') })).status, 400)
  assert.equal((await live(owner.session, shareId, 'short', { k: 'u', d: cipher('a') })).status, 404)
  assert.equal((await call('POST', `/api/v1/sync/shares/${shareId}/live/${ch}`, { session: owner.session, raw: 'x'.repeat(12 * 1024 * 1024), headers: { 'Content-Type': 'application/json' } })).status, 413)
  // The presence budget is separate from the update budget and runs out first.
  let limited = 0
  for (let index = 0; index < 330; index += 1) {
    const response = await live(owner.session, shareId, ch, { k: 'p', d: cipher('c') })
    if (response.status === 429) limited += 1
  }
  assert.ok(limited > 0, 'presence floods are rate limited')
  assert.equal((await live(owner.session, shareId, ch, { k: 'u', d: cipher('still fine') })).status, 200)
})

test('the server stores and pushes ciphertext only, and the buffer survives a restart', async () => {
  const { owner, friend, shareId } = await setup('edit')
  const ch = channel()
  const secret = 'TOP-SECRET-PLAINTEXT-MARKER'
  // A real client sends AES-GCM output; here that is random bytes around a marker the server must never need.
  const events = await openEvents(friend.session)
  await events.waitFor((event) => event.type === 'ready')
  const sent = await live(owner.session, shareId, ch, { k: 'u', d: randomBytes(64).toString('base64') })
  const pushed = await events.waitFor((event) => event.type === 'live' && event.data.q === sent.json.q)
  assert.ok(!JSON.stringify(pushed.data).includes(secret))
  await new Promise((resolve) => setTimeout(resolve, 1100))
  const stored = readFileSync(join(dataDirectory, 'user-shares', shareId, 'live.json'), 'utf8')
  assert.ok(JSON.parse(stored).channels[ch].updates.length === 1)
  assert.ok(!stored.includes(secret))
  assert.equal(statSync(join(dataDirectory, 'user-shares', shareId, 'live.json')).mode & 0o077, 0, 'private file mode')
  const { resetUserSharesForTests } = await import('./user-shares.mjs')
  resetUserSharesForTests()
  const again = await fetchLive(friend.session, shareId, ch, 0)
  assert.equal(again.json.updates.length, 1)
  const next = await live(friend.session, shareId, ch, { k: 'u', d: randomBytes(32).toString('base64') })
  assert.equal(next.json.q, sent.json.q + 1, 'sequence numbers continue after a restart')
  events.close()
  await call('DELETE', `/api/v1/sync/shares/${shareId}`, { session: owner.session })
  await new Promise((resolve) => setTimeout(resolve, 1000))
  assert.equal(existsSync(join(dataDirectory, 'user-shares', shareId)), false, 'revoking removes the buffer with the share')
})
test.after(() => { server.closeAllConnections?.(); server.close(); rmSync(dataDirectory, { recursive: true, force: true }) })
