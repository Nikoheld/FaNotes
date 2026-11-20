// FaNotes user-to-user shares. A note or folder is shared with another account
// by FaNotes username. The server stores only ciphertext:
//   - every share has a random 32-byte share key K made on the owner's device;
//   - K is wrapped (ECDH P-256 + HKDF + AES-GCM) to the recipient's published
//     public key and, separately, to the owner's own public key so the owner's
//     other devices can open it. The server never sees K;
//   - file contents, file names and the share title are encrypted with keys
//     derived from K, exactly like vault sync (see fanotes/docs/SYNC.md);
//   - the server keeps revisions, sizes and who may read or write.
// Access is checked on every request against the in-memory record, so revoking
// a share or leaving it takes effect at once, and every change is pushed to the
// parties over a Server-Sent Events stream (GET /events) that the app keeps
// open. Live co-editing rides on the same stream: live-relay.mjs relays and
// buffers end-to-end encrypted CRDT updates and presence per shared note.
//
// Layout under FANOTES_SYNC_DIR:
//   user-shares/<shareId>/share.json   -> record (status, wraps, parties)
//   user-shares/<shareId>/files.json   -> file table { rev, entries }
//   user-shares/<shareId>/blobs/<id>   -> ciphertext
//   user-share-prefs/<accountId>.json  -> { trusted: [accountId], blocked: [accountId] }
import { createHash, randomBytes } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { join, resolve } from 'node:path'
import { forgetLiveShare, getLive, postLive, resetLiveForTests } from './live-relay.mjs'

const root = () => resolve(process.env.FANOTES_SYNC_DIR || '/var/lib/fanotes-sync')
const sharesDir = () => join(root(), 'user-shares')
const prefsDir = () => join(root(), 'user-share-prefs')

const SHARE_ID = /^[a-f0-9]{32}$/u
const FILE_ID = /^[a-f0-9]{64}$/u
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/u
const MAX_FILE_BYTES = Number(process.env.FANOTES_SHARE_MAX_FILE_BYTES || 50 * 1024 * 1024)
const MAX_SHARE_FILES = 3000
const MAX_SHARE_BYTES = Number(process.env.FANOTES_SHARE_MAX_BYTES || 512 * 1024 * 1024)
const MAX_META_BYTES = 8 * 1024
const MAX_OUTGOING = 200
const MAX_PENDING_PER_RECIPIENT = 50
const MAX_PER_PAIR = 100
const MAX_STREAMS_PER_ACCOUNT = 4
// Idle streams carry one keep-alive comment every 30 s and nothing else.
const HEARTBEAT_MS = 30_000
const SESSION_CHECK_MS = 60_000

const PERMISSIONS = new Set(['read', 'edit'])
const KINDS = new Set(['note', 'folder'])

const nowIso = () => new Date().toISOString()
const hex = (bytes) => randomBytes(bytes).toString('hex')

const isBase64 = (value, minBytes, maxBytes) => {
  if (typeof value !== 'string' || !value || value.length % 4 !== 0 || !BASE64.test(value)) return false
  const bytes = Buffer.from(value, 'base64').length
  return bytes >= minBytes && bytes <= maxBytes
}

// ── State ───────────────────────────────────────────────────────────────────

/** @type {{ root: string, shares: Map<string, any>, tables: Map<string, any>, prefs: Map<string, any> } | null} */
let state = null
const streams = new Map()
let heartbeat = null

const writeJsonAtomic = async (target, value) => {
  await fs.mkdir(join(target, '..'), { recursive: true, mode: 0o700 })
  const temporary = `${target}.${process.pid}.${hex(6)}.tmp`
  const handle = await fs.open(temporary, 'wx', 0o600)
  try {
    await handle.writeFile(`${JSON.stringify(value)}\n`)
    await handle.sync()
  } finally {
    await handle.close()
  }
  await fs.rename(temporary, target)
}

const readJson = async (target) => {
  try {
    return JSON.parse(await fs.readFile(target, 'utf8'))
  } catch {
    return null
  }
}

const load = async () => {
  if (state && state.root === root()) return state
  const fresh = { root: root(), shares: new Map(), tables: new Map(), prefs: new Map() }
  const names = await fs.readdir(sharesDir()).catch(() => [])
  for (const name of names) {
    if (!SHARE_ID.test(name)) continue
    const record = await readJson(join(sharesDir(), name, 'share.json'))
    if (record?.id === name) fresh.shares.set(name, record)
  }
  state = fresh
  return fresh
}

const tableFor = async (share) => {
  const current = await load()
  let table = current.tables.get(share.id)
  if (!table) {
    table = (await readJson(join(sharesDir(), share.id, 'files.json'))) ?? { rev: 0, entries: {} }
    current.tables.set(share.id, table)
  }
  return table
}

const saveShare = async (share) => writeJsonAtomic(join(sharesDir(), share.id, 'share.json'), share)
const saveTable = async (share, table) => writeJsonAtomic(join(sharesDir(), share.id, 'files.json'), table)

const prefsFor = async (accountId) => {
  const current = await load()
  let prefs = current.prefs.get(accountId)
  if (!prefs) {
    const stored = await readJson(join(prefsDir(), `${accountId}.json`))
    prefs = { trusted: Array.isArray(stored?.trusted) ? stored.trusted : [], blocked: Array.isArray(stored?.blocked) ? stored.blocked : [] }
    current.prefs.set(accountId, prefs)
  }
  return prefs
}

const savePrefs = (accountId, prefs) => writeJsonAtomic(join(prefsDir(), `${accountId}.json`), prefs)

const locks = new Map()
const withLock = (key, task) => {
  const previous = locks.get(key) ?? Promise.resolve()
  const run = previous.then(task, task)
  const settled = run.then(() => undefined, () => undefined)
  locks.set(key, settled)
  settled.then(() => { if (locks.get(key) === settled) locks.delete(key) })
  return run
}

// ── Push channel ────────────────────────────────────────────────────────────

/** Send one event to every open stream of an account. Never throws. */
export const pushToAccount = (accountId, type, data = {}) => {
  const set = streams.get(accountId)
  if (!set) return 0
  const payload = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`
  let delivered = 0
  for (const stream of set) {
    try {
      stream.response.write(payload)
      delivered += 1
    } catch {
      closeStream(stream)
    }
  }
  return delivered
}

const closeStream = (stream) => {
  const set = streams.get(stream.accountId)
  if (set) {
    set.delete(stream)
    if (!set.size) streams.delete(stream.accountId)
  }
  try { stream.response.end() } catch { /* already closed */ }
}

export const openStreamCount = (accountId) => streams.get(accountId)?.size ?? 0

const startHeartbeat = (loadAccountById) => {
  if (heartbeat) return
  let tick = 0
  heartbeat = setInterval(() => {
    tick += 1
    for (const set of streams.values()) {
      for (const stream of [...set]) {
        try { stream.response.write(': keep-alive\n\n') } catch { closeStream(stream); continue }
        if (tick % Math.max(1, Math.round(SESSION_CHECK_MS / HEARTBEAT_MS)) === 0) {
          // A signed-out session must not keep receiving events.
          loadAccountById(stream.accountId).then((account) => {
            const session = account?.sessions?.[stream.tokenHash]
            if (!session || Date.parse(session.expiresAt) <= Date.now()) closeStream(stream)
          }).catch(() => {})
        }
      }
    }
    if (!streams.size) { clearInterval(heartbeat); heartbeat = null }
  }, HEARTBEAT_MS)
  heartbeat.unref?.()
}

const handleEvents = async ({ request, response, auth, deps }) => {
  deps.rateLimit(`share:events:${auth.account.id}`, 60, 60_000)
  const set = streams.get(auth.account.id) ?? new Set()
  streams.set(auth.account.id, set)
  while (set.size >= MAX_STREAMS_PER_ACCOUNT) closeStream([...set][0])
  response.writeHead(200, {
    ...deps.baseHeaders(),
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  })
  const stream = { accountId: auth.account.id, tokenHash: auth.tokenHash, deviceId: auth.deviceId, response }
  set.add(stream)
  response.write(`retry: 5000\nevent: ready\ndata: ${JSON.stringify({ at: nowIso() })}\n\n`)
  request.on('close', () => closeStream(stream))
  response.on('close', () => closeStream(stream))
  startHeartbeat(deps.loadAccountById)
}

// ── Views ───────────────────────────────────────────────────────────────────

const ownerView = (share) => ({
  id: share.id,
  role: 'owner',
  kind: share.kind,
  permission: share.permission,
  status: share.status,
  recipient: { username: share.recipientName },
  nameEnc: share.nameEnc,
  ownerKeyWrap: share.ownerKeyWrap,
  createdAt: share.createdAt,
  updatedAt: share.updatedAt,
  rev: share.rev,
})

const recipientView = (share, ownerKey) => ({
  id: share.id,
  role: 'recipient',
  kind: share.kind,
  permission: share.permission,
  status: share.status,
  owner: { username: share.ownerName, publicKey: ownerKey ?? null },
  nameEnc: share.nameEnc,
  keyWrap: share.keyWrap,
  createdAt: share.createdAt,
  updatedAt: share.updatedAt,
  rev: share.rev,
})

const touch = (share) => {
  share.rev = (share.rev ?? 0) + 1
  share.updatedAt = nowIso()
}

const OWNER_VISIBLE = new Set(['pending', 'accepted', 'declined', 'left'])
const RECIPIENT_VISIBLE = new Set(['pending', 'accepted'])

// ── Parsing ─────────────────────────────────────────────────────────────────

const parseWrap = (fail, raw, withEpk) => {
  if (!raw || typeof raw !== 'object' || !isBase64(raw.iv, 12, 16) || !isBase64(raw.data, 32, 256) || (withEpk && !isBase64(raw.epk, 65, 65))) {
    fail(400, 'Der Freigabe-Schlüssel ist ungültig.')
  }
  return withEpk ? { epk: raw.epk, iv: raw.iv, data: raw.data } : { iv: raw.iv, data: raw.data }
}

const parseShareId = (fail, raw) => {
  if (!SHARE_ID.test(raw)) fail(404, 'Diese Freigabe gibt es nicht.')
  return raw
}

const bodyBuffer = async (request, limit, fail) => {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > limit) fail(413, 'Die Datei ist zu groß für die Freigabe.')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

// ── Handlers ────────────────────────────────────────────────────────────────

const requireIdentity = (fail, account) => {
  if (!account.username || !account.userKey) fail(409, 'Für Freigaben braucht dein Konto einen Benutzernamen.')
}

const lookup = async ({ auth, deps }) => {
  const { fail, rateLimit } = deps
  const body = await deps.readJsonBody()
  rateLimit(`share:lookup:${auth.account.id}`, 30, 60_000)
  rateLimit(`share:lookup-hour:${auth.account.id}`, 120, 60 * 60_000)
  const found = typeof body.username === 'string' ? await deps.loadAccountByUsername(body.username) : null
  // Only an exact, complete username matches. There is no prefix search and no list, and misses are rationed
  // harder than hits, so the endpoint cannot be used to enumerate accounts.
  if (!found || !found.userKey || found.id === auth.account.id) {
    rateLimit(`share:lookup-miss:${auth.account.id}`, 20, 60 * 60_000)
    fail(404, 'Diesen FaNotes-Benutzernamen gibt es nicht.')
  }
  deps.sendJson(200, { username: found.username, publicKey: found.userKey.publicKey })
}

const listShares = async ({ auth, deps }) => {
  const current = await load()
  const incoming = []
  const outgoing = []
  for (const share of current.shares.values()) {
    if (share.ownerId === auth.account.id && OWNER_VISIBLE.has(share.status)) outgoing.push(ownerView(share))
    else if (share.recipientId === auth.account.id && RECIPIENT_VISIBLE.has(share.status)) {
      const owner = await deps.loadAccountById(share.ownerId)
      incoming.push(recipientView(share, owner?.userKey?.publicKey))
    }
  }
  const prefs = await prefsFor(auth.account.id)
  const blocked = []
  for (const id of prefs.blocked) {
    const account = await deps.loadAccountById(id)
    if (account?.username) blocked.push({ username: account.username })
  }
  deps.sendJson(200, { incoming, outgoing, blocked })
}

const createShare = async ({ auth, deps }) => {
  const { fail, rateLimit } = deps
  const account = auth.account
  requireIdentity(fail, account)
  rateLimit(`share:create:${account.id}`, 40, 60 * 60_000)
  const body = await deps.readJsonBody()
  const kind = KINDS.has(body.kind) ? body.kind : fail(400, 'Die Art der Freigabe ist ungültig.')
  const permission = PERMISSIONS.has(body.permission) ? body.permission : fail(400, 'Die Berechtigung ist ungültig.')
  const keyWrap = parseWrap(fail, body.keyWrap, true)
  const ownerKeyWrap = parseWrap(fail, body.ownerKeyWrap, true)
  if (!body.nameEnc || !isBase64(body.nameEnc.iv, 12, 16) || !isBase64(body.nameEnc.data, 17, 2048)) fail(400, 'Der Titel der Freigabe ist ungültig.')
  const nameEnc = { iv: body.nameEnc.iv, data: body.nameEnc.data }
  const recipient = typeof body.recipient === 'string' ? await deps.loadAccountByUsername(body.recipient) : null
  if (!recipient || !recipient.userKey || recipient.id === account.id) fail(404, 'Diesen FaNotes-Benutzernamen gibt es nicht.')
  rateLimit(`share:pair:${account.id}:${recipient.id}`, 15, 60 * 60_000)

  const share = await withLock('index', async () => {
    const current = await load()
    let outgoing = 0
    let pending = 0
    let pair = 0
    for (const item of current.shares.values()) {
      if (item.recipientId === recipient.id && item.status === 'pending') pending += 1
      if (item.ownerId !== account.id) continue
      if (item.status !== 'revoked') outgoing += 1
      if (item.recipientId === recipient.id) pair += 1
    }
    if (outgoing >= MAX_OUTGOING || pair >= MAX_PER_PAIR) fail(429, 'Du hast zu viele Freigaben angelegt.')
    const recipientPrefs = await prefsFor(recipient.id)
    const senderPrefs = await prefsFor(account.id)
    // A recipient who blocked the sender sees nothing and the sender gets no hint: the share just stays "declined".
    const blocked = recipientPrefs.blocked.includes(account.id)
    // First-time senders need approval. A recipient trusts people whose shares they accepted before and people they shared with themselves.
    const trusted = recipientPrefs.trusted.includes(account.id)
    if (!blocked && !trusted && pending >= MAX_PENDING_PER_RECIPIENT) fail(429, 'Diese Person hat schon zu viele offene Freigaben.')
    const created = nowIso()
    const record = {
      id: hex(16),
      version: 1,
      kind,
      permission,
      ownerId: account.id,
      ownerName: account.username,
      recipientId: recipient.id,
      recipientName: recipient.username,
      status: blocked ? 'declined' : trusted ? 'accepted' : 'pending',
      createdAt: created,
      updatedAt: created,
      rev: 1,
      keyWrap,
      ownerKeyWrap,
      nameEnc,
    }
    await saveShare(record)
    current.shares.set(record.id, record)
    // Sharing with someone also means the owner will accept shares back from them.
    if (!senderPrefs.trusted.includes(recipient.id) && !blocked) {
      senderPrefs.trusted.push(recipient.id)
      await savePrefs(account.id, senderPrefs)
    }
    return record
  })
  if (!(await prefsFor(recipient.id)).blocked.includes(account.id)) {
    pushToAccount(recipient.id, 'shares', { id: share.id, change: 'created', status: share.status })
  }
  pushToAccount(account.id, 'shares', { id: share.id, change: 'created', status: share.status })
  deps.sendJson(201, { share: ownerView(share) })
}

const getShareFor = async (deps, auth, rawId) => {
  const id = parseShareId(deps.fail, rawId)
  const current = await load()
  const share = current.shares.get(id)
  const account = auth.account.id
  if (!share || (share.ownerId !== account && share.recipientId !== account)) deps.fail(404, 'Diese Freigabe gibt es nicht.')
  return { share, isOwner: share.ownerId === account }
}

const notifyBoth = (share, change, skip = '') => {
  const data = { id: share.id, change, status: share.status, rev: share.rev }
  if (share.ownerId !== skip) pushToAccount(share.ownerId, 'shares', data)
  if (share.recipientId !== skip) pushToAccount(share.recipientId, 'shares', data)
}

const destroyShare = async (share) => {
  const current = await load()
  current.shares.delete(share.id)
  current.tables.delete(share.id)
  forgetLiveShare(share.id)
  await fs.rm(join(sharesDir(), share.id), { recursive: true, force: true })
}

const respond = async ({ auth, deps, id }) => {
  const { fail, rateLimit } = deps
  rateLimit(`share:respond:${auth.account.id}`, 120, 60 * 60_000)
  const body = await deps.readJsonBody()
  const accept = body.accept === true
  const block = body.block === true
  const result = await withLock('index', async () => {
    const { share, isOwner } = await getShareFor(deps, auth, id)
    if (isOwner || !RECIPIENT_VISIBLE.has(share.status)) fail(404, 'Diese Freigabe gibt es nicht.')
    const prefs = await prefsFor(share.recipientId)
    if (accept) {
      if (share.status === 'pending') {
        share.status = 'accepted'
        touch(share)
        await saveShare(share)
      }
      if (!prefs.trusted.includes(share.ownerId)) {
        prefs.trusted.push(share.ownerId)
        prefs.blocked = prefs.blocked.filter((entry) => entry !== share.ownerId)
        await savePrefs(share.recipientId, prefs)
      }
      return { share, change: 'accepted' }
    }
    share.status = share.status === 'accepted' ? 'left' : 'declined'
    touch(share)
    await saveShare(share)
    const changed = [share]
    if (block) {
      if (!prefs.blocked.includes(share.ownerId)) prefs.blocked.push(share.ownerId)
      prefs.trusted = prefs.trusted.filter((entry) => entry !== share.ownerId)
      await savePrefs(share.recipientId, prefs)
      const current = await load()
      for (const other of current.shares.values()) {
        if (other.id !== share.id && other.ownerId === share.ownerId && other.recipientId === share.recipientId && RECIPIENT_VISIBLE.has(other.status)) {
          other.status = other.status === 'accepted' ? 'left' : 'declined'
          touch(other)
          await saveShare(other)
          changed.push(other)
        }
      }
    }
    return { share, change: share.status, changed }
  })
  for (const item of result.changed ?? [result.share]) notifyBoth(item, result.change)
  deps.sendJson(200, { share: recipientView(result.share) })
}

const updateShare = async ({ auth, deps, id }) => {
  const { fail, rateLimit } = deps
  rateLimit(`share:update:${auth.account.id}`, 120, 60 * 60_000)
  const body = await deps.readJsonBody()
  const permission = PERMISSIONS.has(body.permission) ? body.permission : fail(400, 'Die Berechtigung ist ungültig.')
  const share = await withLock('index', async () => {
    const found = await getShareFor(deps, auth, id)
    if (!found.isOwner || !OWNER_VISIBLE.has(found.share.status)) fail(404, 'Diese Freigabe gibt es nicht.')
    if (found.share.permission !== permission) {
      found.share.permission = permission
      touch(found.share)
      await saveShare(found.share)
    }
    return found.share
  })
  notifyBoth(share, 'permission')
  deps.sendJson(200, { share: ownerView(share) })
}

const removeShare = async ({ auth, deps, id }) => {
  deps.rateLimit(`share:remove:${auth.account.id}`, 200, 60 * 60_000)
  const result = await withLock('index', async () => {
    const { share, isOwner } = await getShareFor(deps, auth, id)
    if (isOwner) {
      // Revoking deletes the ciphertext too: the recipient's next request is a 404 and their app drops its copy.
      await destroyShare(share)
      return { share, change: 'revoked' }
    }
    if (!RECIPIENT_VISIBLE.has(share.status)) deps.fail(404, 'Diese Freigabe gibt es nicht.')
    share.status = share.status === 'accepted' ? 'left' : 'declined'
    touch(share)
    await saveShare(share)
    return { share, change: share.status }
  })
  notifyBoth(result.share, result.change)
  deps.sendJson(200, { ok: true })
}

const setBlock = async ({ auth, deps, username, unblock }) => {
  deps.rateLimit(`share:block:${auth.account.id}`, 60, 60 * 60_000)
  const target = await deps.loadAccountByUsername(username)
  if (!target || target.id === auth.account.id) deps.fail(404, 'Diesen FaNotes-Benutzernamen gibt es nicht.')
  const changed = await withLock('index', async () => {
    const prefs = await prefsFor(auth.account.id)
    const list = []
    if (unblock) {
      prefs.blocked = prefs.blocked.filter((entry) => entry !== target.id)
    } else {
      if (!prefs.blocked.includes(target.id)) prefs.blocked.push(target.id)
      prefs.trusted = prefs.trusted.filter((entry) => entry !== target.id)
      const current = await load()
      for (const share of current.shares.values()) {
        if (share.ownerId === target.id && share.recipientId === auth.account.id && RECIPIENT_VISIBLE.has(share.status)) {
          share.status = share.status === 'accepted' ? 'left' : 'declined'
          touch(share)
          await saveShare(share)
          list.push(share)
        }
      }
    }
    await savePrefs(auth.account.id, prefs)
    return list
  })
  for (const share of changed) notifyBoth(share, share.status)
  pushToAccount(auth.account.id, 'shares', { change: 'blocks' })
  deps.sendJson(200, { ok: true })
}

// ── Share contents ──────────────────────────────────────────────────────────

const publicEntry = (id, entry) => ({
  id,
  revision: entry.revision,
  deleted: Boolean(entry.deleted),
  size: entry.size,
  sha256: entry.sha256 ?? null,
  meta: entry.meta ?? null,
  updatedAt: entry.updatedAt ?? null,
  seq: entry.seq,
})

/** Owner: always. Recipient: only after accepting, and for writes only with edit permission. */
const authorize = async (deps, auth, rawId, write) => {
  const { share, isOwner } = await getShareFor(deps, auth, rawId)
  if (isOwner) {
    if (share.status === 'revoked') deps.fail(404, 'Diese Freigabe gibt es nicht.')
    return { share, isOwner }
  }
  if (share.status !== 'accepted') deps.fail(403, 'Diese Freigabe ist nicht angenommen.')
  if (write && share.permission !== 'edit') deps.fail(403, 'Diese Freigabe ist nur zum Lesen.')
  return { share, isOwner }
}

const blobPath = (shareId, fileId) => join(sharesDir(), shareId, 'blobs', fileId)

const changesFeed = async ({ auth, deps, id, url }) => {
  deps.rateLimit(`share:changes:${auth.account.id}`, 600, 60_000)
  const { share } = await authorize(deps, auth, id, false)
  const table = await tableFor(share)
  const since = Number(url.searchParams.get('since') || 0)
  const entries = Object.entries(table.entries).filter(([, entry]) => entry.seq > (Number.isFinite(since) ? since : 0)).sort((a, b) => a[1].seq - b[1].seq).map(([fileId, entry]) => publicEntry(fileId, entry))
  deps.sendJson(200, { rev: table.rev, entries })
}

const getFile = async ({ auth, deps, id, fileId, response }) => {
  deps.rateLimit(`share:get:${auth.account.id}`, 1200, 60_000)
  const { share } = await authorize(deps, auth, id, false)
  const table = await tableFor(share)
  const entry = table.entries[fileId]
  if (!entry) deps.fail(404, 'Diese Datei gibt es nicht.')
  const headers = { ...deps.baseHeaders(), 'X-FaNotes-Revision': String(entry.revision), 'X-FaNotes-Meta': entry.meta ?? '', 'X-FaNotes-Sha256': entry.sha256 ?? '' }
  if (entry.deleted) {
    response.writeHead(204, { ...headers, 'X-FaNotes-Deleted': '1' })
    response.end()
    return
  }
  const blob = await fs.readFile(blobPath(share.id, fileId)).catch(() => null)
  if (!blob) deps.fail(404, 'Diese Datei gibt es nicht.')
  response.writeHead(200, { ...headers, 'Content-Type': 'application/octet-stream', 'Content-Length': blob.length })
  response.end(blob)
}

const parseIfMatch = (fail, request) => {
  const header = request.headers['if-match']
  const value = typeof header === 'string' ? Number(header.replace(/"/gu, '')) : NaN
  if (!Number.isInteger(value) || value < 0) fail(428, 'Die Basisversion fehlt.')
  return value
}

const putFile = async ({ auth, deps, id, fileId, request }) => {
  const { fail } = deps
  deps.rateLimit(`share:put:${auth.account.id}`, 1200, 60_000)
  const base = parseIfMatch(fail, request)
  const meta = request.headers['x-fanotes-meta']
  const sha = request.headers['x-fanotes-sha256']
  if (typeof meta !== 'string' || !meta || Buffer.byteLength(meta) > MAX_META_BYTES || !BASE64.test(meta)) fail(400, 'Die Metadaten der Datei sind ungültig.')
  if (typeof sha !== 'string' || !/^[a-f0-9]{64}$/u.test(sha)) fail(400, 'Die Prüfsumme der Datei fehlt.')
  const declared = Number(request.headers['content-length'])
  if (Number.isFinite(declared) && declared > MAX_FILE_BYTES) fail(413, 'Die Datei ist zu groß für die Freigabe.')
  const blob = await bodyBuffer(request, MAX_FILE_BYTES, fail)
  if (blob.length < 28) fail(400, 'Der verschlüsselte Inhalt ist ungültig.')
  const result = await withLock(`share:${id}`, async () => {
    const { share } = await authorize(deps, auth, id, true)
    const table = await tableFor(share)
    const current = table.entries[fileId]
    const currentRevision = current?.revision ?? 0
    if (currentRevision !== base) return { conflict: publicEntry(fileId, current ?? { revision: 0, size: 0, seq: 0 }) }
    const live = Object.values(table.entries).filter((entry) => !entry.deleted)
    if (!current && live.length >= MAX_SHARE_FILES) fail(413, 'Diese Freigabe enthält zu viele Dateien.')
    const used = live.reduce((sum, entry) => sum + entry.size, 0) - (current && !current.deleted ? current.size : 0)
    if (used + blob.length > MAX_SHARE_BYTES) fail(413, 'Diese Freigabe ist zu groß.')
    await fs.mkdir(join(sharesDir(), share.id, 'blobs'), { recursive: true, mode: 0o700 })
    const target = blobPath(share.id, fileId)
    const temporary = `${target}.${hex(6)}.tmp`
    await fs.writeFile(temporary, blob, { mode: 0o600 })
    await fs.rename(temporary, target)
    table.rev += 1
    table.entries[fileId] = { revision: currentRevision + 1, size: blob.length, sha256: sha, meta, deleted: false, updatedAt: nowIso(), seq: table.rev, by: auth.account.id }
    await saveTable(share, table)
    return { share, revision: currentRevision + 1, rev: table.rev }
  })
  if (result.conflict) {
    deps.sendJson(409, { error: 'Die Datei wurde inzwischen geändert.', entry: result.conflict })
    return
  }
  const other = result.share.ownerId === auth.account.id ? result.share.recipientId : result.share.ownerId
  pushToAccount(other, 'files', { id, rev: result.rev })
  deps.sendJson(200, { revision: result.revision, rev: result.rev })
}

const deleteFile = async ({ auth, deps, id, fileId, request }) => {
  deps.rateLimit(`share:del:${auth.account.id}`, 1200, 60_000)
  const base = parseIfMatch(deps.fail, request)
  const result = await withLock(`share:${id}`, async () => {
    const { share } = await authorize(deps, auth, id, true)
    const table = await tableFor(share)
    const current = table.entries[fileId]
    if (!current) deps.fail(404, 'Diese Datei gibt es nicht.')
    if (current.revision !== base) return { conflict: publicEntry(fileId, current) }
    if (!current.deleted) {
      await fs.rm(blobPath(share.id, fileId), { force: true })
      table.rev += 1
      table.entries[fileId] = { ...current, revision: current.revision + 1, size: 0, deleted: true, updatedAt: nowIso(), seq: table.rev, by: auth.account.id }
      await saveTable(share, table)
    }
    return { share, revision: table.entries[fileId].revision, rev: table.rev }
  })
  if (result.conflict) {
    deps.sendJson(409, { error: 'Die Datei wurde inzwischen geändert.', entry: result.conflict })
    return
  }
  const other = result.share.ownerId === auth.account.id ? result.share.recipientId : result.share.ownerId
  pushToAccount(other, 'files', { id, rev: result.rev })
  deps.sendJson(200, { revision: result.revision, rev: result.rev })
}

const liveHost = { authorize, pushToAccount, withLock, dir: sharesDir }

// ── Router ──────────────────────────────────────────────────────────────────

/**
 * Called by sync-api for /events, /users/*, /shares* and /blocks* after the session was checked.
 * `deps` brings the account store and response helpers so this module does not import sync-api.
 */
export const handleUserShareRoute = async (context) => {
  const { request, response, route, method, auth, url } = context
  const deps = { ...context.deps, readJsonBody: () => context.deps.readJsonBody(request) }
  const ctx = { auth, deps, request, response, url }
  if (route === '/events' && method === 'GET') return handleEvents(ctx)
  if (route === '/users/lookup' && method === 'POST') return lookup(ctx)
  if (route === '/shares' && method === 'GET') return listShares(ctx)
  if (route === '/shares' && method === 'POST') return createShare(ctx)
  if (route === '/blocks' && method === 'POST') {
    const body = await deps.readJsonBody()
    return setBlock({ ...ctx, username: String(body.username ?? ''), unblock: false })
  }
  const blockMatch = /^\/blocks\/([^/]{1,64})$/u.exec(route)
  if (blockMatch && method === 'DELETE') return setBlock({ ...ctx, username: decodeURIComponent(blockMatch[1]), unblock: true })
  const shareMatch = /^\/shares\/([a-f0-9]{32})(?:\/(respond|changes))?$/u.exec(route)
  if (shareMatch) {
    const id = shareMatch[1]
    if (shareMatch[2] === 'respond' && method === 'POST') return respond({ ...ctx, id })
    if (shareMatch[2] === 'changes' && method === 'GET') return changesFeed({ ...ctx, id })
    if (!shareMatch[2] && method === 'PATCH') return updateShare({ ...ctx, id })
    if (!shareMatch[2] && method === 'DELETE') return removeShare({ ...ctx, id })
  }
  const liveMatch = /^\/shares\/([a-f0-9]{32})\/live\/([^/]{1,64})$/u.exec(route)
  if (liveMatch) {
    const sub = { ...ctx, id: liveMatch[1], channel: liveMatch[2] }
    if (method === 'POST') return postLive(sub, liveHost)
    if (method === 'GET') return getLive(sub, liveHost)
  }
  const fileMatch = /^\/shares\/([a-f0-9]{32})\/files\/([a-f0-9]{64})$/u.exec(route)
  if (fileMatch) {
    const sub = { ...ctx, id: fileMatch[1], fileId: fileMatch[2] }
    if (method === 'GET') return getFile(sub)
    if (method === 'PUT') return putFile(sub)
    if (method === 'DELETE') return deleteFile(sub)
  }
  return deps.fail(404, 'Diesen Freigabe-Endpunkt gibt es nicht.')
}

/** Account deletion: owned shares are revoked, shares the account received are left. */
export const removeAccountShares = async (accountId) => {
  const touched = await withLock('index', async () => {
    const current = await load()
    const events = []
    for (const share of [...current.shares.values()]) {
      if (share.ownerId === accountId) {
        await destroyShare(share)
        events.push([share.recipientId, share, 'revoked'])
      } else if (share.recipientId === accountId) {
        share.status = 'left'
        touch(share)
        await saveShare(share)
        events.push([share.ownerId, share, 'left'])
      }
    }
    current.prefs.delete(accountId)
    await fs.rm(join(prefsDir(), `${accountId}.json`), { force: true })
    return events
  })
  for (const [target, share, change] of touched) pushToAccount(target, 'shares', { id: share.id, change, status: share.status })
  for (const stream of [...(streams.get(accountId) ?? [])]) closeStream(stream)
}

/** Test helper: forget cached state so a fresh FANOTES_SYNC_DIR is read. */
export const resetUserSharesForTests = () => {
  state = null
  resetLiveForTests()
  for (const set of streams.values()) for (const stream of [...set]) closeStream(stream)
  if (heartbeat) { clearInterval(heartbeat); heartbeat = null }
}

export const shareFingerprint = (publicKeyBase64) => createHash('sha256').update(Buffer.from(publicKeyBase64, 'base64')).digest('hex').slice(0, 16)
