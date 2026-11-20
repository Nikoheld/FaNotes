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
// A note with several collaborators is one "room": the owner picks a room id and a
// random room key, wraps the key under each accepted share's key (the server only sees
// the wrapped bytes) and registers the mapping on every share of the note. Everyone who
// holds an accepted share of the note posts and fetches through their own share URL, but
// the messages land in the one room, and pushes go to every member. Revoking a member
// means the owner rotates: a new room and key for the remaining shares, so the removed
// member neither receives nor can decrypt anything sent afterwards.
//
//   GET /shares/:id/live-room?channel=C   -> { room, wrap, gen } | { room: null }
//   GET /shares/:id/live-rooms            -> every mapping of this share
//   PUT /shares/:id/live-room             { channel, room, wrap }  first writer wins, the owner may overwrite
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
      await fs.mkdir(join(state.dir, shareId), { recursive: true, mode: 0o700 })
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

const ROOM_ID = /^[a-f0-9]{32}$/u

const roomMapping = (share, channel) => {
  for (const mapping of Object.values(share.liveRooms ?? {})) if (mapping.room === channel) return mapping
  return null
}

/** Accounts that currently belong to a room: owner and recipient of every accepted share that maps it. */
const roomAccounts = async (host, room) => {
  const accounts = new Set()
  for (const share of await host.allShares()) {
    if (share.status !== 'accepted') continue
    if (!roomMapping(share, room)) continue
    accounts.add(share.ownerId)
    if (share.recipientId) accounts.add(share.recipientId)
  }
  return [...accounts]
}

/** Where a message for `channel` goes: the room it maps to, or the share's own channel (two people). */
const targetFor = async (host, share, channel) => {
  if (roomMapping(share, channel)) {
    return { key: channel, dir: host.roomDir(), lock: `live:room:${channel}`, accounts: await roomAccounts(host, channel) }
  }
  return { key: share.id, dir: host.dir(), lock: `live:${share.id}`, accounts: parties(share) }
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
  const target = await targetFor(host, share, channelName)
  if (kind === 'p') {
    const data = { id, c: channelName, k: 'p', d: body.d, f: from }
    let delivered = 0
    for (const account of target.accounts) delivered += host.pushToAccount(account, 'live', data)
    deps.sendJson(200, { ok: true, delivered })
    return
  }

  const result = await host.withLock(target.lock, async () => {
    // Permission is checked again inside the lock: a revoke or a downgrade wins over a queued message.
    const current = await host.authorize(deps, auth, id, true)
    if (target.key !== id && !roomMapping(current.share, channelName)) fail(404, 'Diesen Kanal gibt es nicht.')
    const state = await stateFor(target.dir, target.key)
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
      persist(state, target.key)
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
      persist(state, target.key)
      return { share: current.share, q: upTo, seq: state.seq, compacted: true }
    }
    if (channel.updates.length >= max.updatesPerChannel || channel.bytes + size > max.buffer) {
      // The sender must send a snapshot first; nothing is dropped silently.
      return { full: true, seq: state.seq }
    }
    state.seq += 1
    channel.updates.push({ q: state.seq, d: body.d })
    channel.bytes += size
    persist(state, target.key)
    return { share: current.share, q: state.seq, seq: state.seq }
  })
  if (result.exists) { deps.sendJson(409, { error: 'Für diese Notiz läuft bereits eine Sitzung.', exists: true, seq: result.seq }); return }
  if (result.full) { deps.sendJson(413, { error: 'Der Zwischenspeicher ist voll. Bitte zuerst verdichten.', compact: true, seq: result.seq }); return }
  if (kind !== 's') {
    const inline = approxBytes(body.d) <= max.inline
    const data = { id, c: channelName, k: kind, q: result.q, f: from, ...(inline ? { d: body.d } : { big: true }) }
    for (const account of target.accounts) host.pushToAccount(account, 'live', data)
  } else if (!result.stale) {
    const data = { id, c: channelName, k: 's', q: result.q, f: from, big: true }
    for (const account of target.accounts) host.pushToAccount(account, 'live', data)
  }
  deps.sendJson(200, { ok: true, q: result.q, seq: result.seq, ...(result.stale ? { stale: true } : {}) })
}

export const getLive = async ({ auth, deps, id, channel: rawChannel, url }, host) => {
  const { fail, rateLimit } = deps
  const channelName = channelOf(fail, rawChannel)
  rateLimit(`live:get:${auth.account.id}`, 240, 60_000)
  const { share } = await host.authorize(deps, auth, id, false)
  const target = await targetFor(host, share, channelName)
  const state = await stateFor(target.dir, target.key)
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


// ── Rooms ───────────────────────────────────────────────────────────────────

const validWrap = (wrap) => wrap && typeof wrap === 'object' && validData(wrap.iv, 12, 16) && validData(wrap.data, 32, 256)

export const getLiveRoom = async ({ auth, deps, id, url }, host) => {
  deps.rateLimit(`live:room:${auth.account.id}`, 120, 60_000)
  const channel = url.searchParams.get('channel') ?? ''
  if (!CHANNEL.test(channel)) deps.fail(404, 'Diesen Kanal gibt es nicht.')
  const { share } = await host.authorize(deps, auth, id, false)
  const mapping = share.liveRooms?.[channel]
  deps.sendJson(200, mapping ? { room: mapping.room, wrap: mapping.wrap, gen: mapping.gen } : { room: null })
}

export const listLiveRooms = async ({ auth, deps, id }, host) => {
  deps.rateLimit(`live:room:${auth.account.id}`, 120, 60_000)
  const { share } = await host.authorize(deps, auth, id, false)
  deps.sendJson(200, { rooms: Object.entries(share.liveRooms ?? {}).map(([channel, mapping]) => ({ channel, room: mapping.room, wrap: mapping.wrap, gen: mapping.gen })) })
}

/** Removes a room's buffer when no share maps it any more. */
export const sweepLiveRoom = async (host, room) => {
  if (!ROOM_ID.test(room)) return
  for (const share of await host.allShares()) if (roomMapping(share, room)) return
  forgetLiveShare(room)
  await fs.rm(join(host.roomDir(), room), { recursive: true, force: true }).catch(() => {})
}

export const putLiveRoom = async ({ auth, deps, id, request }, host) => {
  const { fail, rateLimit } = deps
  rateLimit(`live:room:put:${auth.account.id}`, 60, 60_000)
  const text = await readBody(request, 4096, fail)
  let body
  try { body = JSON.parse(text) } catch { body = null }
  if (!body || !CHANNEL.test(body.channel) || !ROOM_ID.test(body.room) || !validWrap(body.wrap)) fail(400, 'Die Raum-Angaben sind ungültig.')
  const outcome = await host.withLock(`live:roomreg:${id}`, async () => {
    const { share, isOwner } = await host.authorize(deps, auth, id, true)
    const existing = share.liveRooms?.[body.channel]
    if (existing && !isOwner) return { conflict: true }
    if (existing && existing.room === body.room && JSON.stringify(existing.wrap) === JSON.stringify({ iv: body.wrap.iv, data: body.wrap.data })) return { share, same: true }
    if (!existing && Object.keys(share.liveRooms ?? {}).length >= limits().channels) fail(413, 'Diese Freigabe hat zu viele offene Notizen.')
    share.liveRooms = { ...(share.liveRooms ?? {}), [body.channel]: { room: body.room, wrap: { iv: body.wrap.iv, data: body.wrap.data }, gen: (existing?.gen ?? 0) + 1 } }
    await host.saveShare(share)
    return { share, previous: existing?.room }
  })
  if (outcome.conflict) { deps.sendJson(409, { error: 'Für diese Notiz gibt es schon einen Raum.', exists: true }); return }
  if (!outcome.same) {
    if (outcome.previous && outcome.previous !== body.room) await sweepLiveRoom(host, outcome.previous)
    const data = { id, c: body.channel, change: 'room', f: auth.deviceId ?? '' }
    for (const account of parties(outcome.share)) host.pushToAccount(account, 'live-room', data)
  }
  deps.sendJson(200, { ok: true })
}
