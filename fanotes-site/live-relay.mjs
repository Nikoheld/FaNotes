// Live collaboration relay for shared notes. The server only relays and buffers
// ciphertext: every message is encrypted on the sending device with a key
// derived from the share key (which the server never sees), so the server
// cannot read or alter note text, ink or cursors. Per share there is one
// ordered sequence; messages belong to an opaque "channel" (one per note, named
// by an HMAC the client computes).
//
//   POST /shares/:id/live/:channel   { k, d, upTo? }   send (edit permission)
//   GET  /shares/:id/live/:channel?since=N              catch up (any accepted party)
//   SSE  event "live" on GET /events                    push to the parties
//
// Kinds:
//   u  update    buffered, ordered, pushed
//   p  presence  relayed to open streams only, never stored
//   i  init      first writer wins: stored as the channel snapshot, 409 when state exists
//   s  snapshot  compaction: replaces the buffered updates up to `upTo`
//
// The merged text itself is persisted by the clients through the normal share
// file path (see user-shares.mjs), so the note also works for people who are not
// online at the same time. This buffer only has to bridge short gaps and let a
// joining client rebuild the live state, so it is bounded.
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'

const CHANNEL = /^[a-f0-9]{32}$/u
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/u
const KINDS = new Set(['u', 'p', 'i', 's'])
const num = (name, fallback) => {
  const value = Number(process.env[name])
  return Number.isFinite(value) && value > 0 ? value : fallback
}
const limits = () => ({
  update: num('FANOTES_LIVE_MAX_UPDATE_BYTES', 256 * 1024),
  presence: num('FANOTES_LIVE_MAX_PRESENCE_BYTES', 8 * 1024),
  snapshot: num('FANOTES_LIVE_MAX_SNAPSHOT_BYTES', 8 * 1024 * 1024),
  buffer: num('FANOTES_LIVE_MAX_BUFFER_BYTES', 16 * 1024 * 1024),
  updatesPerChannel: num('FANOTES_LIVE_MAX_UPDATES', 4000),
  channels: num('FANOTES_LIVE_MAX_CHANNELS', 32),
  /** Updates above this size are not inlined in the push event; the client fetches them. */
  inline: num('FANOTES_LIVE_INLINE_BYTES', 48 * 1024),
  updateRate: num('FANOTES_LIVE_UPDATES_PER_10S', 900),
  presenceRate: num('FANOTES_LIVE_PRESENCE_PER_10S', 300),
})

/** @type {Map<string, { seq: number, channels: Map<string, { snap: {q:number,d:string}|null, updates: Array<{q:number,d:string}>, bytes: number }>, dirty: boolean, timer: any, dir: string }>} */
const shares = new Map()

const approxBytes = (base64) => Math.floor((base64.length * 3) / 4)

const validData = (value, minBytes, maxBytes) => {
  if (typeof value !== 'string' || !value || value.length % 4 !== 0 || !BASE64.test(value)) return false
  const bytes = approxBytes(value)
  return bytes >= minBytes && bytes <= maxBytes
}

const liveFile = (dir) => join(dir, 'live.json')

const stateFor = async (dir, shareId) => {
  let state = shares.get(shareId)
  if (state && state.dir === dir) return state
  let stored = null
  try { stored = JSON.parse(await fs.readFile(liveFile(join(dir, shareId)), 'utf8')) } catch { stored = null }
  state = { seq: Number(stored?.seq) || 0, channels: new Map(), dirty: false, timer: null, dir }
  for (const [name, value] of Object.entries(stored?.channels ?? {})) {
    if (!CHANNEL.test(name) || !value || !Array.isArray(value.updates)) continue
    const bytes = value.updates.reduce((sum, item) => sum + approxBytes(item.d), 0) + (value.snap ? approxBytes(value.snap.d) : 0)
    state.channels.set(name, { snap: value.snap ?? null, updates: value.updates, bytes })
  }
  shares.set(shareId, state)
  return state
}

const persist = (state, shareId) => {
  state.dirty = true
  if (state.timer) return
  state.timer = setTimeout(async () => {
    state.timer = null
    if (!state.dirty) return
    state.dirty = false
    const channels = {}
    for (const [name, channel] of state.channels) channels[name] = { snap: channel.snap, updates: channel.updates }
    const target = liveFile(join(state.dir, shareId))
    const temporary = `${target}.${randomBytes(4).toString('hex')}.tmp`
    try {
      await fs.writeFile(temporary, `${JSON.stringify({ seq: state.seq, channels })}\n`, { mode: 0o600 })
      await fs.rename(temporary, target)
    } catch {
      // The share may have been revoked in the meantime (directory removed).
      await fs.rm(temporary, { force: true }).catch(() => {})
    }
  }, 750)
  state.timer.unref?.()
}

/** The share was revoked or deleted: drop everything buffered for it. */
export const forgetLiveShare = (shareId) => {
  const state = shares.get(shareId)
  if (state?.timer) clearTimeout(state.timer)
  shares.delete(shareId)
}

export const resetLiveForTests = () => {
  for (const state of shares.values()) if (state.timer) clearTimeout(state.timer)
  shares.clear()
}

const readBody = async (request, limit, fail) => {
  const declared = Number(request.headers['content-length'])
  if (Number.isFinite(declared) && declared > limit) fail(413, 'Die Nachricht ist zu groß.')
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > limit) fail(413, 'Die Nachricht ist zu groß.')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
}

const channelOf = (fail, raw) => {
  if (!CHANNEL.test(raw)) fail(404, 'Diesen Kanal gibt es nicht.')
  return raw
}

const parties = (share) => {
  const list = [share.ownerId]
  if (share.recipientId && share.status === 'accepted') list.push(share.recipientId)
  return list
}

/**
 * POST. `host` brings the share helpers of user-shares.mjs so this module does not import it.
 */
export const postLive = async ({ auth, deps, request, id, channel: rawChannel }, host) => {
  const { fail, rateLimit } = deps
  const channelName = channelOf(fail, rawChannel)
  const max = limits()
  // Cheap checks first: a flood is stopped before the body is read.
  const { share } = await host.authorize(deps, auth, id, true)
  const text = await readBody(request, Math.ceil((max.snapshot * 4) / 3) + 512, fail)
  let body
  try { body = JSON.parse(text) } catch { body = null }
  if (!body || typeof body !== 'object' || !KINDS.has(body.k)) fail(400, 'Die Nachricht ist ungültig.')
  const kind = body.k
  if (kind === 'p') rateLimit(`live:p:${auth.account.id}`, max.presenceRate, 10_000)
  else rateLimit(`live:u:${auth.account.id}`, max.updateRate, 10_000)
  const cap = kind === 'p' ? max.presence : (kind === 'u' ? max.update : max.snapshot)
  if (typeof body.d === 'string' && body.d.length > Math.ceil((cap * 4) / 3) + 4) fail(413, 'Die Nachricht ist zu groß.')
  if (!validData(body.d, 17, cap)) fail(400, 'Die Nachricht ist ungültig.')

  const from = auth.deviceId ?? ''
  if (kind === 'p') {
    const data = { id, c: channelName, k: 'p', d: body.d, f: from }
    let delivered = 0
    for (const account of parties(share)) delivered += host.pushToAccount(account, 'live', data)
    deps.sendJson(200, { ok: true, delivered })
    return
  }

  const result = await host.withLock(`live:${id}`, async () => {
    // Permission is checked again inside the lock: a revoke or a downgrade wins over a queued message.
    const current = await host.authorize(deps, auth, id, true)
    const state = await stateFor(host.dir(), id)
    let channel = state.channels.get(channelName)
    if (!channel) {
      if (state.channels.size >= max.channels) fail(413, 'Diese Freigabe hat zu viele offene Notizen.')
      channel = { snap: null, updates: [], bytes: 0 }
      state.channels.set(channelName, channel)
    }
    const size = approxBytes(body.d)
    if (kind === 'i') {
      if (channel.snap || channel.updates.length) return { exists: true, seq: state.seq }
      state.seq += 1
      channel.snap = { q: state.seq, d: body.d }
      channel.bytes = size
      persist(state, id)
      return { share: current.share, q: state.seq, seq: state.seq }
    }
    if (kind === 's') {
      const upTo = Number(body.upTo)
      if (!Number.isInteger(upTo) || upTo < 0 || upTo > state.seq) fail(400, 'Die Nachricht ist ungültig.')
      if (channel.snap && upTo < channel.snap.q) return { share: current.share, q: channel.snap.q, seq: state.seq, stale: true }
      state.seq += 1
      channel.snap = { q: upTo, d: body.d }
      channel.updates = channel.updates.filter((item) => item.q > upTo)
      channel.bytes = size + channel.updates.reduce((sum, item) => sum + approxBytes(item.d), 0)
      persist(state, id)
      return { share: current.share, q: upTo, seq: state.seq, compacted: true }
    }
    if (channel.updates.length >= max.updatesPerChannel || channel.bytes + size > max.buffer) {
      // The sender must send a snapshot first; nothing is dropped silently.
      return { full: true, seq: state.seq }
    }
    state.seq += 1
    channel.updates.push({ q: state.seq, d: body.d })
    channel.bytes += size
    persist(state, id)
    return { share: current.share, q: state.seq, seq: state.seq }
  })
  if (result.exists) { deps.sendJson(409, { error: 'Für diese Notiz läuft bereits eine Sitzung.', exists: true, seq: result.seq }); return }
  if (result.full) { deps.sendJson(413, { error: 'Der Zwischenspeicher ist voll. Bitte zuerst verdichten.', compact: true, seq: result.seq }); return }
  if (kind !== 's') {
    const inline = approxBytes(body.d) <= max.inline
    const data = { id, c: channelName, k: kind, q: result.q, f: from, ...(inline ? { d: body.d } : { big: true }) }
    for (const account of parties(result.share)) host.pushToAccount(account, 'live', data)
  } else if (!result.stale) {
    const data = { id, c: channelName, k: 's', q: result.q, f: from, big: true }
    for (const account of parties(result.share)) host.pushToAccount(account, 'live', data)
  }
  deps.sendJson(200, { ok: true, q: result.q, seq: result.seq, ...(result.stale ? { stale: true } : {}) })
}

export const getLive = async ({ auth, deps, id, channel: rawChannel, url }, host) => {
  const { fail, rateLimit } = deps
  const channelName = channelOf(fail, rawChannel)
  rateLimit(`live:get:${auth.account.id}`, 240, 60_000)
  const { share } = await host.authorize(deps, auth, id, false)
  const state = await stateFor(host.dir(), share.id)
  const channel = state.channels.get(channelName)
  const since = Math.max(0, Math.trunc(Number(url.searchParams.get('since') || 0)) || 0)
  if (!channel) {
    deps.sendJson(200, { seq: state.seq, snapshot: null, updates: [] })
    return
  }
  const snapshot = channel.snap && channel.snap.q >= since ? { q: channel.snap.q, d: channel.snap.d } : null
  deps.sendJson(200, {
    seq: state.seq,
    // The snapshot is only sent when the caller may be missing what it replaced.
    snapshot: snapshot && (since === 0 || since < channel.snap.q) ? snapshot : null,
    updates: channel.updates.filter((item) => item.q > since),
  })
}
