// One live shared note: a Yjs document (text and ink), its presence, and the
// end-to-end encrypted link to the other people in the note.
//
// Every update and every presence message is encrypted with the note's share key
// (AES-GCM, see crypto.ts) before it leaves this device; the server relays and
// buffers ciphertext only (fanotes-site/live-relay.mjs). The channel
//   - batches local updates per animation frame and sends nothing while idle
//     (presence refreshes every 30 s at most),
//   - keeps unsent updates while offline and sends them on reconnect (Yjs updates
//     are idempotent, so duplicates and reordering are harmless),
//   - fetches what it missed after a gap or a reconnect,
//   - compacts the server buffer with an encrypted snapshot now and then,
//   - caches the document on this device so a later offline edit merges instead of
//     overwriting.
// The merged text is persisted by the app through the normal share file path.
import * as Y from 'yjs'
import { decryptBytes, encryptBytes, fromBase64, toBase64, type SyncKeys } from '../sync/crypto'
import { minimalReplacement } from '../textReplacement'
import { LiveAwareness, type LivePresenceState } from './liveAwareness'

export type LiveSendBody = { k: 'u' | 'p' | 'i' | 's'; d: string; upTo?: number }
export type LivePort = {
  send(body: LiveSendBody): Promise<{ q?: number; seq?: number; stale?: boolean }>
  fetch(since: number): Promise<{ seq: number; snapshot: { q: number; d: string } | null; updates: Array<{ q: number; d: string }> }>
}
export type LiveStoreRecord = { state: Uint8Array; pending: Uint8Array | null; seq: number }
export type LiveStore = {
  load(): Promise<LiveStoreRecord | null>
  save(record: LiveStoreRecord): Promise<void>
}
export type LiveStatus = 'connecting' | 'live' | 'offline' | 'closed'

export type LiveChannelOptions = {
  port: LivePort
  keys: SyncKeys
  channel: string
  /** This device's id: the server echoes it back so a device ignores its own messages. */
  deviceId: string
  canWrite: boolean
  store?: LiveStore
  /** Wait at most this long for the first catch-up before working from the cache. */
  openTimeoutMs?: number
}

export type LiveOpenResult =
  | { ok: true; text: string; /** The local file had changes the live state could not take over. Keep them as a copy. */ diverged: string | null }
  | { ok: false; reason: 'offline' | 'denied' | 'idle' }

export const LOCAL_ORIGIN = 'live-local'
const REMOTE_ORIGIN = 'live-remote'
const SEED_ORIGIN = 'live-seed'

const BATCH_FALLBACK_MS = 16
const PRESENCE_MIN_GAP_MS = 80
const PRESENCE_REFRESH_MS = 30_000
const RETRY_MIN_MS = 1_000
const RETRY_MAX_MS = 30_000
const COMPACT_AFTER_UPDATES = 80
const COMPACT_AFTER_BYTES = 200 * 1024
const COMPACT_IDLE_MS = 4_000
const SNAPSHOT_INSTEAD_OF_UPDATE_BYTES = 180 * 1024
const SAVE_DEBOUNCE_MS = 1_000

const aad = (channel: string, kind: 'u' | 'p') => `live:${channel}:${kind}`
const nextFrame = (task: () => void) => {
  const raf = (globalThis as { requestAnimationFrame?: (cb: () => void) => number }).requestAnimationFrame
  // A hidden window does not run animation frames; the timeout keeps updates moving.
  let done = false
  const run = () => { if (!done) { done = true; task() } }
  if (typeof raf === 'function') raf(run)
  setTimeout(run, BATCH_FALLBACK_MS * 2)
}

const statusOf = (error: unknown) => (error && typeof error === 'object' && 'status' in error ? Number((error as { status: unknown }).status) : -1)

export class LiveChannel {
  doc = new Y.Doc()
  awareness!: LiveAwareness
  status: LiveStatus = 'connecting'
  private readonly statusListeners = new Set<(status: LiveStatus) => void>()
  private readonly docListeners = new Set<() => void>()
  private readonly closeListeners = new Set<() => void>()
  private lastSeq = 0
  private compactedTo = 0
  private uncompactedUpdates = 0
  private uncompactedBytes = 0
  private outbox: Uint8Array | null = null
  private sending = false
  private sendScheduled = false
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private retryDelay = RETRY_MIN_MS
  private compactTimer: ReturnType<typeof setTimeout> | null = null
  private saveTimer: ReturnType<typeof setTimeout> | null = null
  private presenceTimer: ReturnType<typeof setTimeout> | null = null
  private presenceRefresh: ReturnType<typeof setInterval> | null = null
  private expiryTimer: ReturnType<typeof setInterval> | null = null
  private presenceInFlight = false
  private presenceDirty = false
  private lastPresenceAt = 0
  private catchingUp: Promise<boolean> | null = null
  private lastFullFetch = 0
  private hadCache = false
  private opened = false
  private closed = false

  constructor(private readonly options: LiveChannelOptions) {
    this.build()
  }

  get text() { return this.doc.getText('text') }
  get canWrite() { return this.options.canWrite }

  onStatus(listener: (status: LiveStatus) => void) {
    this.statusListeners.add(listener)
    return () => { this.statusListeners.delete(listener) }
  }

  /** Fires once when the channel has closed, whoever closed it (the note, the share manager, a withdrawn permission). */
  onClosed(listener: () => void) {
    this.closeListeners.add(listener)
  }

  /** Fires after a remote change landed (people list, saved state). */
  onRemote(listener: () => void) {
    this.docListeners.add(listener)
    return () => { this.docListeners.delete(listener) }
  }

  private setStatus(status: LiveStatus) {
    if (this.status === status || this.closed) return
    this.status = status
    for (const listener of [...this.statusListeners]) listener(status)
  }

  private build() {
    this.doc.destroy()
    this.doc = new Y.Doc()
    this.doc.on('update', (update: Uint8Array, origin: unknown) => {
      if (origin === REMOTE_ORIGIN || origin === SEED_ORIGIN || !this.options.canWrite) return
      this.outbox = this.outbox ? Y.mergeUpdates([this.outbox, update]) : update
      this.scheduleSend()
      this.scheduleSave()
    })
    this.awareness = new LiveAwareness(this.doc, () => this.queuePresence())
  }

  // ── Opening ─────────────────────────────────────────────────────────────

  /**
   * Joins the note. `localText` is the note's text on this device and `localModified`
   * says whether the file changed here since it was last synced (so it may hold edits the
   * live state has not seen). Resolves when the document is ready to be bound to an editor.
   */
  async open(localText: string, localModified: boolean): Promise<LiveOpenResult> {
    if (this.opened) throw new Error('live channel opened twice')
    this.opened = true
    const store = this.options.store
    const cached = store ? await store.load().catch(() => null) : null
    let baseDocText: string | null = null
    let baseVector: Uint8Array | null = null
    let baseState: Uint8Array | null = null
    if (cached) {
      this.hadCache = true
      Y.applyUpdate(this.doc, cached.state, REMOTE_ORIGIN)
      baseState = cached.state
      baseVector = Y.encodeStateVector(this.doc)
      baseDocText = this.text.toString()
      if (cached.pending) this.outbox = cached.pending
    }

    let online = true
    let serverEmpty = false
    try {
      const timeout = this.options.openTimeoutMs ?? 4_000
      const result = await Promise.race([
        this.fetchState(0),
        new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), this.hadCache ? Math.min(timeout, 1_500) : timeout)),
      ])
      if (result === 'timeout') throw new Error('timeout')
      serverEmpty = result.empty
    } catch (error) {
      if (statusOf(error) === 403 || statusOf(error) === 404) return { ok: false, reason: 'denied' }
      online = false
    }

    if (!online && !this.hadCache) {
      // Nothing to join and no history to build on: seeding here could duplicate the text once the
      // other side is reachable. The note stays a plain file until the connection is back.
      this.status = 'offline'
      return { ok: false, reason: 'offline' }
    }

    if (online && !this.options.canWrite && this.serverEmptyAtOpen && Y.encodeStateVector(this.doc).length <= 1) {
      // A reader cannot start a session. Nobody has yet, so the note stays a plain file until somebody edits it.
      this.status = 'connecting'
      return { ok: false, reason: 'idle' }
    }
    let diverged: string | null = null
    const noHistory = Y.encodeStateVector(this.doc).length <= 1
    if (noHistory) {
      if (localText) this.doc.transact(() => { this.text.insert(0, localText) }, SEED_ORIGIN)
      if (online && this.options.canWrite) {
        const settled = await this.initServer()
        if (settled === 'lost') {
          // Somebody else started the session first. Join theirs from a clean document.
          this.build()
          await this.fetchState(0)
          if (localModified && localText && this.text.toString() !== localText) diverged = localText
        }
      }
    } else if (localModified && localText !== (baseDocText ?? this.text.toString())) {
      if (baseState && baseVector && baseDocText !== null) {
        // Offline edits on top of the cached lineage, merged with whatever arrived since.
        const base = new Y.Doc()
        Y.applyUpdate(base, baseState)
        const span = minimalReplacement(baseDocText, localText)
        base.transact(() => {
          const ytext = base.getText('text')
          if (span.to > span.from) ytext.delete(span.from, span.to - span.from)
          if (span.insert) ytext.insert(span.from, span.insert)
        })
        const edit = Y.encodeStateAsUpdate(base, baseVector)
        base.destroy()
        if (this.options.canWrite) Y.applyUpdate(this.doc, edit, LOCAL_ORIGIN)
        else diverged = localText
      } else {
        diverged = localText
      }
    }
    if (diverged !== null && localText === this.text.toString()) diverged = null
    if (online && this.hadCache && this.serverEmptyAtOpen && this.options.canWrite) await this.initServer()

    this.afterOpen(online)
    return { ok: true, text: this.text.toString(), diverged }
  }

  private afterOpen(online: boolean) {
    if (this.closed) return
    this.setStatus(online ? 'live' : 'offline')
    if (online) {
      if (this.outbox) this.scheduleSend()
    } else {
      this.armRetry()
    }
    this.presenceRefresh = setInterval(() => {
      const visible = typeof document === 'undefined' || document.visibilityState !== 'hidden'
      if (visible && this.status === 'live') this.queuePresence(true)
    }, PRESENCE_REFRESH_MS)
    this.presenceRefresh.unref?.()
    this.scheduleSave()
  }

  /** First writer wins. Returns 'lost' when another device had already started the session. */
  private async initServer(): Promise<'won' | 'lost' | 'skipped'> {
    const full = await this.seal(Y.encodeStateAsUpdate(this.doc))
    if (!this.serverEmptyAtOpen) {
      // The server already holds state (an empty document, or ours is a cached lineage): add ours.
      await this.options.port.send({ k: 'u', d: full }).catch(() => this.armRetry())
      return 'won'
    }
    try {
      const sent = await this.options.port.send({ k: 'i', d: full })
      if (typeof sent.q === 'number') this.lastSeq = Math.max(this.lastSeq, sent.q)
      this.compactedTo = this.lastSeq
      return 'won'
    } catch (error) {
      if (statusOf(error) === 409) {
        if (this.hadCache) {
          // Same lineage as the other device's cache: just send everything, merging is idempotent.
          await this.options.port.send({ k: 'u', d: await this.seal(Y.encodeStateAsUpdate(this.doc)) }).catch(() => undefined)
          return 'won'
        }
        return 'lost'
      }
      this.armRetry()
      return 'skipped'
    }
  }

  private serverEmptyAtOpen = false

  private async fetchState(since: number): Promise<{ empty: boolean }> {
    const response = await this.options.port.fetch(since)
    let top = this.lastSeq
    if (response.snapshot) {
      await this.applySealed(response.snapshot.d)
      top = Math.max(top, response.snapshot.q)
    }
    for (const item of response.updates) {
      await this.applySealed(item.d)
      top = Math.max(top, item.q)
    }
    this.lastSeq = top
    if (since === 0) {
      this.serverEmptyAtOpen = !response.snapshot && response.updates.length === 0
      this.compactedTo = response.snapshot?.q ?? 0
    }
    return { empty: since === 0 && this.serverEmptyAtOpen }
  }

  // ── Crypto ──────────────────────────────────────────────────────────────

  private async seal(bytes: Uint8Array, kind: 'u' | 'p' = 'u') {
    return toBase64(await encryptBytes(this.options.keys, aad(this.options.channel, kind), bytes))
  }

  private async unseal(data: string, kind: 'u' | 'p' = 'u') {
    return decryptBytes(this.options.keys, aad(this.options.channel, kind), fromBase64(data))
  }

  private async applySealed(data: string) {
    try {
      Y.applyUpdate(this.doc, await this.unseal(data), REMOTE_ORIGIN)
    } catch (error) {
      console.warn('[live] a message could not be opened', error instanceof Error ? error.message : error)
    }
  }

  // ── Receiving ───────────────────────────────────────────────────────────

  /** A "live" event of the push stream, for this share. */
  async handlePush(event: { c: string; k: string; q?: number; f?: string; d?: string; big?: boolean }) {
    if (this.closed || event.c !== this.options.channel) return
    const own = Boolean(event.f) && event.f === this.options.deviceId
    if (event.k === 'p') {
      if (own || !event.d) return
      try {
        const message = JSON.parse(new TextDecoder().decode(await this.unseal(event.d, 'p'))) as { c: number; s: LivePresenceState | null }
        if (typeof message.c !== 'number') return
        const known = this.awareness.getStates().has(message.c)
        this.awareness.applyRemote(message.c, message.s ?? null, Date.now())
        this.armExpiry()
        // A newcomer learns who is here from the answers to its own first message.
        if (!known && message.s) this.queuePresence()
      } catch { /* a presence message that cannot be opened is dropped */ }
      return
    }
    if (event.k === 's') return
    // Our own messages never advance the cursor: the sequence is shared by all notes and devices, so a
    // number past the cursor does not mean everything before it was seen. Only a fetch (or a received update) does.
    if (own) return
    if (!event.d || event.big) {
      void this.catchUp()
      return
    }
    await this.applySealed(event.d)
    if (typeof event.q === 'number') this.lastSeq = Math.max(this.lastSeq, event.q)
    this.afterRemote()
  }

  private afterRemote() {
    // An update that depends on one we never saw waits in Yjs; fetch the full history once.
    const store = this.doc.store as unknown as { pendingStructs: unknown; pendingDs: unknown }
    if (store.pendingStructs || store.pendingDs) void this.catchUp(true)
    this.uncompactedUpdates += 1
    for (const listener of [...this.docListeners]) listener()
    this.scheduleCompaction()
    this.scheduleSave()
  }

  /** Fetches and applies what was missed. `full` starts from the beginning. Returns whether the server answered. */
  catchUp(full = false): Promise<boolean> {
    if (this.closed) return Promise.resolve(false)
    if (this.catchingUp) return this.catchingUp
    if (full && Date.now() - this.lastFullFetch < 5_000) full = false
    if (full) this.lastFullFetch = Date.now()
    this.catchingUp = (async () => {
      try {
        const before = this.lastSeq
        await this.fetchState(full ? 0 : this.lastSeq)
        if (this.lastSeq !== before || full) this.afterRemote()
        return true
      } catch (error) {
        if (statusOf(error) === 403 || statusOf(error) === 404) this.close()
        return false
      } finally {
        this.catchingUp = null
      }
    })()
    return this.catchingUp
  }

  /** The push stream reconnected (or the network came back): pick up what was missed and send what is waiting. */
  async resync() {
    if (this.closed || !this.opened) return
    const ok = await this.catchUp()
    if (ok) {
      if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = null }
      this.retryDelay = RETRY_MIN_MS
      this.setStatus('live')
      if (this.outbox) this.scheduleSend()
      this.queuePresence(true)
    } else {
      this.setStatus('offline')
      this.armRetry()
    }
  }

  // ── Sending ─────────────────────────────────────────────────────────────

  private scheduleSend() {
    if (this.sendScheduled || this.closed || this.sending || this.retryTimer) return
    this.sendScheduled = true
    nextFrame(() => { this.sendScheduled = false; void this.flush() })
  }

  private armRetry() {
    if (this.retryTimer || this.closed) return
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      void this.resync()
    }, this.retryDelay)
    this.retryTimer.unref?.()
    this.retryDelay = Math.min(RETRY_MAX_MS, this.retryDelay * 2)
  }

  /** Sends everything waiting as one encrypted update. */
  async flush() {
    if (this.sending || this.closed || !this.outbox || !this.options.canWrite) return
    this.sending = true
    const update = this.outbox
    this.outbox = null
    try {
      if (update.length > SNAPSHOT_INSTEAD_OF_UPDATE_BYTES) {
        await this.compact(true)
      } else {
        await this.options.port.send({ k: 'u', d: await this.seal(update) })
        this.uncompactedUpdates += 1
        this.uncompactedBytes += update.length
        this.setStatus('live')
        this.retryDelay = RETRY_MIN_MS
        this.scheduleCompaction()
      }
      this.scheduleSave()
    } catch (error) {
      this.outbox = this.outbox ? Y.mergeUpdates([update, this.outbox]) : update
      const status = statusOf(error)
      if (status === 413) {
        await this.compact(true).catch(() => this.armRetry())
      } else if (status === 403 || status === 404) {
        // Permission was withdrawn (or the share is gone). The edits stay in the outbox: dropping them would leave
        // later updates depending on history the others never got. They go out if the permission comes back.
        this.setStatus('offline')
        this.armRetry()
      } else {
        this.setStatus('offline')
        this.armRetry()
      }
    } finally {
      this.sending = false
      if (this.outbox && !this.retryTimer) this.scheduleSend()
    }
  }

  // ── Compaction ──────────────────────────────────────────────────────────

  private scheduleCompaction() {
    if (!this.options.canWrite || this.closed || this.compactTimer) return
    if (this.uncompactedUpdates < COMPACT_AFTER_UPDATES && this.uncompactedBytes < COMPACT_AFTER_BYTES) return
    this.compactTimer = setTimeout(() => {
      this.compactTimer = null
      void this.compact().catch(() => undefined)
    }, COMPACT_IDLE_MS)
    this.compactTimer.unref?.()
  }

  /**
   * Replaces the server's buffered updates with one encrypted snapshot. It first applies
   * everything the server holds, so the snapshot never claims more than this device has seen.
   */
  async compact(force = false) {
    if (!this.options.canWrite || (!force && !this.uncompactedUpdates)) return
    const response = await this.options.port.fetch(this.compactedTo)
    let upTo = this.compactedTo
    if (response.snapshot) { await this.applySealed(response.snapshot.d); upTo = Math.max(upTo, response.snapshot.q) }
    for (const item of response.updates) { await this.applySealed(item.d); upTo = Math.max(upTo, item.q) }
    this.lastSeq = Math.max(this.lastSeq, upTo)
    // Encoded and taken in one step: an edit made while the snapshot is in flight stays in the outbox.
    const state = Y.encodeStateAsUpdate(this.doc)
    const taken = this.outbox
    this.outbox = null
    try {
      const sent = await this.options.port.send({ k: 's', d: await this.seal(state), upTo })
      this.compactedTo = sent.stale ? this.compactedTo : upTo
      this.uncompactedUpdates = 0
      this.uncompactedBytes = 0
    } catch (error) {
      if (taken) this.outbox = this.outbox ? Y.mergeUpdates([taken, this.outbox]) : taken
      throw error
    }
  }

  // ── Presence ────────────────────────────────────────────────────────────

  /** Local presence changed (cursor, pen, name). Sent at most every 80 ms, only the newest state. */
  private queuePresence(refresh = false) {
    if (!this.options.canWrite || this.closed || this.status === 'connecting') return
    void refresh
    this.presenceDirty = true
    if (this.presenceTimer || this.presenceInFlight) return
    const wait = Math.max(0, PRESENCE_MIN_GAP_MS - (Date.now() - this.lastPresenceAt))
    this.presenceTimer = setTimeout(() => { this.presenceTimer = null; void this.sendPresence() }, wait)
    this.presenceTimer.unref?.()
  }

  private async sendPresence(leave = false) {
    if (!this.presenceDirty && !leave) return
    this.presenceDirty = false
    this.presenceInFlight = true
    this.lastPresenceAt = Date.now()
    try {
      const message = { c: this.doc.clientID, s: leave ? null : this.awareness.getLocalState(), t: Date.now() }
      await this.options.port.send({ k: 'p', d: await this.seal(new TextEncoder().encode(JSON.stringify(message)), 'p') })
    } catch { /* presence is best effort */ } finally {
      this.presenceInFlight = false
      if (this.presenceDirty && !this.presenceTimer && !this.closed) this.queuePresence()
    }
  }

  private armExpiry() {
    if (this.expiryTimer) return
    this.expiryTimer = setInterval(() => {
      if (this.awareness.expire(Date.now()) === 0 && this.expiryTimer) {
        clearInterval(this.expiryTimer)
        this.expiryTimer = null
      }
    }, 10_000)
    this.expiryTimer.unref?.()
  }

  // ── Local cache ─────────────────────────────────────────────────────────

  private scheduleSave() {
    if (!this.options.store || this.saveTimer || this.closed) return
    this.saveTimer = setTimeout(() => { this.saveTimer = null; void this.saveNow() }, SAVE_DEBOUNCE_MS)
    this.saveTimer.unref?.()
  }

  private async saveNow() {
    const store = this.options.store
    if (!store) return
    await store.save({ state: Y.encodeStateAsUpdate(this.doc), pending: this.outbox, seq: this.lastSeq }).catch(() => undefined)
  }

  // ── Closing ─────────────────────────────────────────────────────────────

  /** Leaves the note: tells the others, sends what is waiting, saves the cache. */
  async close() {
    if (this.closed) return
    if (this.opened && this.status !== 'offline') {
      await this.sendPresence(true).catch(() => undefined)
      this.sending = false
      await this.flush().catch(() => undefined)
      if (this.uncompactedUpdates > 0 && this.options.canWrite) await this.compact().catch(() => undefined)
    }
    await this.saveNow()
    this.closed = true
    for (const timer of [this.retryTimer, this.compactTimer, this.saveTimer, this.presenceTimer]) if (timer) clearTimeout(timer)
    if (this.presenceRefresh) clearInterval(this.presenceRefresh)
    if (this.expiryTimer) clearInterval(this.expiryTimer)
    this.status = 'closed'
    for (const listener of [...this.statusListeners]) listener('closed')
    this.statusListeners.clear()
    this.docListeners.clear()
    this.awareness.clearRemote()
    this.doc.destroy()
    const closeListeners = [...this.closeListeners]
    this.closeListeners.clear()
    for (const listener of closeListeners) listener()
  }
}
