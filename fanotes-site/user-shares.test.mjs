// Accounts without e-mail or password, device-key login, username shares, revoke and the push channel.
import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { createServer, request as httpRequest } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
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

test.after(() => { server.closeAllConnections?.(); server.close(); rmSync(dataDirectory, { recursive: true, force: true }) })

test('an account needs only a username: no e-mail, device-key credential, case-insensitive uniqueness', async () => {
  const alice = await register('Alice_Notes')
  assert.equal(alice.result.status, 201)
  assert.equal(alice.result.json.username, 'Alice_Notes')
  assert.equal(alice.result.json.email, null)
  assert.equal(alice.result.json.credential, 'device-key')

  const clash = await register('alice_NOTES')
  assert.equal(clash.result.status, 409)
  assert.ok(!clash.result.json.token)

  for (const bad of ['ab', 'x'.repeat(33), 'has space', 'a@b.ch', '-start', 'dou..ble', 'admin', 'ümlaut']) {
    const response = await register(bad)
    assert.equal(response.result.status, 400, `${bad} must be rejected`)
  }
  const neither = await call('POST', '/api/v1/sync/register', { body: { authKey: b64(32), kdf: kdf(), vaultKeyWrap: { iv: b64(12), data: b64(48) }, device } })
  assert.equal(neither.status, 400)
})

test('device-key login by username, wrong key fails, unknown names look like wrong keys', async () => {
  const { authKey, keys } = await register('login_user')
  const pre = await call('POST', '/api/v1/sync/prelogin', { body: { username: 'LOGIN_USER' } })
  assert.equal(pre.status, 200)
  const ok = await call('POST', '/api/v1/sync/login', { body: { username: 'Login_User', authKey, device } })
  assert.equal(ok.status, 200)
  assert.equal(ok.json.credential, 'device-key')
  assert.equal(ok.json.userKey.publicKey, keys.publicKey)
  assert.ok(ok.json.vaultKeyWrap)
  const wrong = await call('POST', '/api/v1/sync/login', { body: { username: 'login_user', authKey: b64(32), device } })
  const unknown = await call('POST', '/api/v1/sync/login', { body: { username: 'nobody_here', authKey: b64(32), device } })
  assert.equal(wrong.status, 401)
  assert.equal(unknown.status, 401)
  assert.equal(wrong.json.error, unknown.json.error)
  // Unknown and known names get the same shape of prelogin answer.
  const preUnknown = await call('POST', '/api/v1/sync/prelogin', { body: { username: 'nobody_here' } })
  assert.equal(preUnknown.status, 200)
  assert.equal(preUnknown.json.kdf.algorithm, pre.json.kdf.algorithm)
})

test('optional e-mail and password can be added later; legacy e-mail accounts keep working', async () => {
  const { authKey, session } = await register('later_email')
  const account = await call('GET', '/api/v1/sync/account', { session })
  assert.equal(account.json.email, null)
  const bad = await call('POST', '/api/v1/sync/email', { session, body: { email: 'x@example.org', authKey: b64(32) } })
  assert.equal(bad.status, 403)
  const added = await call('POST', '/api/v1/sync/email', { session, body: { email: 'Later@Example.org', authKey } })
  assert.equal(added.status, 200)
  assert.equal(added.json.email, 'later@example.org')
  const byEmail = await call('POST', '/api/v1/sync/login', { body: { email: 'later@example.org', authKey, device } })
  assert.equal(byEmail.status, 200)
  // The same address cannot be claimed twice.
  const other = await register('other_user')
  const taken = await call('POST', '/api/v1/sync/email', { session: other.session, body: { email: 'later@example.org', authKey: other.authKey } })
  assert.equal(taken.status, 409)
  // Adding a password turns it into a normal account.
  const newKey = b64(32)
  const changed = await call('POST', '/api/v1/sync/password', { session, body: { authKey, newAuthKey: newKey, kdf: kdf(), vaultKeyWrap: { iv: b64(12), data: b64(48) } } })
  assert.equal(changed.status, 204)
  const relog = await call('POST', '/api/v1/sync/login', { body: { username: 'later_email', authKey: newKey, device } })
  assert.equal(relog.json.credential, 'password')

  // A legacy account (e-mail and password, no username) registers and logs in as before, then claims a username.
  const legacyKey = b64(32)
  const legacy = await call('POST', '/api/v1/sync/register', { body: { email: 'legacy@example.org', authKey: legacyKey, kdf: kdf(), vaultKeyWrap: { iv: b64(12), data: b64(48) }, device } })
  assert.equal(legacy.status, 201)
  assert.equal(legacy.json.username, null)
  assert.equal(legacy.json.credential, 'password')
  const legacySession = { accountId: legacy.json.accountId, token: legacy.json.token }
  const claim = await call('POST', '/api/v1/sync/username', { session: legacySession, body: { username: 'Legacy_Lena', ...userKeyFields() } })
  assert.equal(claim.status, 200)
  const again = await call('POST', '/api/v1/sync/username', { session: legacySession, body: { username: 'another_one', ...userKeyFields() } })
  assert.equal(again.status, 409)
  const taken2 = await call('POST', '/api/v1/sync/username', { session: other.session, body: { username: 'legacy_lena', ...userKeyFields() } })
  assert.equal(taken2.status, 409)
})

test('username lookup answers only exact matches and is rate limited', async () => {
  const seeker = await register('seeker_one')
  await register('Target_Person')
  const hit = await call('POST', '/api/v1/sync/users/lookup', { session: seeker.session, body: { username: 'target_person' } })
  assert.equal(hit.status, 200)
  assert.equal(hit.json.username, 'Target_Person')
  assert.ok(hit.json.publicKey)
  for (const partial of ['target', 'Target_Pers', 'T', '']) {
    const miss = await call('POST', '/api/v1/sync/users/lookup', { session: seeker.session, body: { username: partial } })
    assert.equal(miss.status, 404, `partial "${partial}" must not match`)
  }
  const self = await call('POST', '/api/v1/sync/users/lookup', { session: seeker.session, body: { username: 'seeker_one' } })
  assert.equal(self.status, 404)
  const unauthenticated = await call('POST', '/api/v1/sync/users/lookup', { body: { username: 'target_person' } })
  assert.equal(unauthenticated.status, 401)
  // Misses are rationed: the 21st miss within the hour is throttled.
  let throttled = false
  for (let index = 0; index < 30 && !throttled; index += 1) {
    const miss = await call('POST', '/api/v1/sync/users/lookup', { session: seeker.session, body: { username: `ghost_${index}` } })
    if (miss.status === 429) throttled = true
  }
  assert.ok(throttled, 'repeated misses must be throttled')
})

test('share to a username: pending, instant push, accept, read, edit permission, revoke', async () => {
  const owner = await register('share_owner')
  const friend = await register('share_friend')
  const events = await openEvents(friend.session)
  await events.waitFor((event) => event.type === 'ready')
  const ownerEvents = await openEvents(owner.session)

  const created = await call('POST', '/api/v1/sync/shares', { session: owner.session, body: shareBody('SHARE_FRIEND') })
  assert.equal(created.status, 201)
  const shareId = created.json.share.id
  assert.equal(created.json.share.status, 'pending')
  // It appears on the recipient's open stream at once, without polling.
  const pushed = await events.waitFor((event) => event.type === 'shares' && event.data.id === shareId)
  assert.equal(pushed.data.change, 'created')

  const list = await call('GET', '/api/v1/sync/shares', { session: friend.session })
  assert.equal(list.json.incoming.length, 1)
  assert.equal(list.json.incoming[0].owner.username, 'share_owner')
  assert.ok(list.json.incoming[0].keyWrap.epk)
  assert.equal(list.json.incoming[0].ownerKeyWrap, undefined, 'the recipient never gets the owner wrap')

  // A pending share exposes no contents.
  const id = fileId()
  assert.equal((await putFile(owner.session, shareId, id, 0, randomBytes(64))).status, 200)
  assert.equal((await call('GET', `/api/v1/sync/shares/${shareId}/changes?since=0`, { session: friend.session })).status, 403)

  const accepted = await call('POST', `/api/v1/sync/shares/${shareId}/respond`, { session: friend.session, body: { accept: true } })
  assert.equal(accepted.status, 200)
  await ownerEvents.waitFor((event) => event.type === 'shares' && event.data.change === 'accepted')

  const feed = await call('GET', `/api/v1/sync/shares/${shareId}/changes?since=0`, { session: friend.session })
  assert.equal(feed.json.entries.length, 1)
  const download = await call('GET', `/api/v1/sync/shares/${shareId}/files/${id}`, { session: friend.session })
  assert.equal(download.status, 200)
  assert.equal(download.headers['x-fanotes-revision'], '1')

  // Read-only: the recipient cannot write. After upgrading to edit they can, and the owner is told.
  assert.equal((await putFile(friend.session, shareId, id, 1, randomBytes(64))).status, 403)
  const upgrade = await call('PATCH', `/api/v1/sync/shares/${shareId}`, { session: owner.session, body: { permission: 'edit' } })
  assert.equal(upgrade.status, 200)
  await events.waitFor((event) => event.type === 'shares' && event.data.change === 'permission')
  const edit = await putFile(friend.session, shareId, id, 1, randomBytes(80))
  assert.equal(edit.status, 200)
  await ownerEvents.waitFor((event) => event.type === 'files' && event.data.id === shareId)
  const stale = await putFile(owner.session, shareId, id, 1, randomBytes(70))
  assert.equal(stale.status, 409)
  assert.equal(stale.json.entry.revision, 2)

  // Revoking takes effect at once: push, then 404 everywhere.
  const mark = events.events.length
  const revoke = await call('DELETE', `/api/v1/sync/shares/${shareId}`, { session: owner.session })
  assert.equal(revoke.status, 200)
  await events.waitFor((event) => events.events.indexOf(event) >= mark && event.type === 'shares' && event.data.change === 'revoked')
  assert.equal((await call('GET', `/api/v1/sync/shares/${shareId}/files/${id}`, { session: friend.session })).status, 404)
  assert.equal((await putFile(friend.session, shareId, id, 2, randomBytes(64))).status, 404)
  assert.equal((await call('GET', '/api/v1/sync/shares', { session: friend.session })).json.incoming.length, 0)
  events.close()
  ownerEvents.close()
})

test('only the two parties can see or touch a share', async () => {
  const owner = await register('priv_owner')
  await register('priv_friend')
  const stranger = await register('priv_stranger')
  const created = await call('POST', '/api/v1/sync/shares', { session: owner.session, body: shareBody('priv_friend', { permission: 'edit' }) })
  const shareId = created.json.share.id
  assert.equal((await call('GET', `/api/v1/sync/shares/${shareId}/changes`, { session: stranger.session })).status, 404)
  assert.equal((await call('DELETE', `/api/v1/sync/shares/${shareId}`, { session: stranger.session })).status, 404)
  assert.equal((await call('POST', `/api/v1/sync/shares/${shareId}/respond`, { session: stranger.session, body: { accept: true } })).status, 404)
  assert.equal((await call('POST', `/api/v1/sync/shares/${shareId}/respond`, { session: owner.session, body: { accept: true } })).status, 404, 'the owner cannot accept for the recipient')
  assert.equal((await call('GET', '/api/v1/sync/shares', { session: stranger.session })).json.incoming.length, 0)
  const nobody = await call('POST', '/api/v1/sync/shares', { session: owner.session, body: shareBody('no_such_user') })
  assert.equal(nobody.status, 404)
  const toSelf = await call('POST', '/api/v1/sync/shares', { session: owner.session, body: shareBody('priv_owner') })
  assert.equal(toSelf.status, 404)
})

test('first-time senders need approval; accepted senders are trusted; decline and block stop spam', async () => {
  const sender = await register('spam_sender')
  const target = await register('spam_target')
  const targetEvents = await openEvents(target.session)

  const first = await call('POST', '/api/v1/sync/shares', { session: sender.session, body: shareBody('spam_target') })
  assert.equal(first.json.share.status, 'pending')
  // Decline and block in one step.
  const declined = await call('POST', `/api/v1/sync/shares/${first.json.share.id}/respond`, { session: target.session, body: { accept: false, block: true } })
  assert.equal(declined.status, 200)
  assert.equal((await call('GET', '/api/v1/sync/shares', { session: target.session })).json.blocked[0].username, 'spam_sender')

  const mark = targetEvents.events.length
  const second = await call('POST', '/api/v1/sync/shares', { session: sender.session, body: shareBody('spam_target') })
  assert.equal(second.status, 201, 'the sender gets no hint about the block')
  assert.equal(second.json.share.status, 'declined')
  await new Promise((resolve) => setTimeout(resolve, 100))
  assert.equal(targetEvents.events.slice(mark).filter((event) => event.type === 'shares').length, 0, 'a blocked sender causes no notification')
  assert.equal((await call('GET', '/api/v1/sync/shares', { session: target.session })).json.incoming.length, 0)

  // Unblock; accept one share; later shares from the same person arrive accepted without a prompt.
  await call('DELETE', '/api/v1/sync/blocks/spam_sender', { session: target.session })
  const third = await call('POST', '/api/v1/sync/shares', { session: sender.session, body: shareBody('spam_target') })
  assert.equal(third.json.share.status, 'pending')
  await call('POST', `/api/v1/sync/shares/${third.json.share.id}/respond`, { session: target.session, body: { accept: true } })
  const fourth = await call('POST', '/api/v1/sync/shares', { session: sender.session, body: shareBody('spam_target', { kind: 'folder' }) })
  assert.equal(fourth.json.share.status, 'accepted')

  // The recipient can leave an accepted share; the owner sees it.
  const leave = await call('DELETE', `/api/v1/sync/shares/${fourth.json.share.id}`, { session: target.session })
  assert.equal(leave.status, 200)
  const mine = await call('GET', '/api/v1/sync/shares', { session: sender.session })
  assert.equal(mine.json.outgoing.find((share) => share.id === fourth.json.share.id).status, 'left')
  targetEvents.close()
})

test('share creation is rate limited per sender', async () => {
  const sender = await register('flood_sender')
  const targets = []
  for (let index = 0; index < 3; index += 1) targets.push(`flood_target_${index}`)
  for (const name of targets) await register(name)
  let limited = false
  for (let index = 0; index < 20 && !limited; index += 1) {
    const response = await call('POST', '/api/v1/sync/shares', { session: sender.session, body: shareBody(targets[0]) })
    if (response.status === 429) limited = true
  }
  assert.ok(limited, 'the per-pair limit must stop a flood')
})

test('deleting an account revokes its shares at once and frees the username', async () => {
  const owner = await register('gone_owner')
  const friend = await register('gone_friend')
  const created = await call('POST', '/api/v1/sync/shares', { session: owner.session, body: shareBody('gone_friend') })
  await call('POST', `/api/v1/sync/shares/${created.json.share.id}/respond`, { session: friend.session, body: { accept: true } })
  const events = await openEvents(friend.session)
  await events.waitFor((event) => event.type === 'ready')
  const removed = await call('DELETE', '/api/v1/sync/account', { session: owner.session, body: { authKey: owner.authKey } })
  assert.equal(removed.status, 204)
  await events.waitFor((event) => event.type === 'shares' && event.data.change === 'revoked')
  assert.equal((await call('GET', '/api/v1/sync/shares', { session: friend.session })).json.incoming.length, 0)
  // The freed username can be taken again.
  assert.equal((await register('gone_owner')).result.status, 201)
  events.close()
})
