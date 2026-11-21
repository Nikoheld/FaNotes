// Presence for one live note: who is here, where their cursor and selection are,
// and where their pen is. It has the small surface y-codemirror.next expects of an
// awareness object (getStates, getLocalState, setLocalStateField, on/off, doc), but
// it does not depend on y-protocols and it travels inside the end-to-end encrypted
// presence messages of liveChannel.ts, never as plaintext.
import type * as Y from 'yjs'

export type LivePen = { x: number; y: number; down: boolean }
export type LiveUser = { name: string; color: string; colorLight: string }
export type LivePresenceState = {
  user?: LiveUser
  /** Y.RelativePosition JSON pair, written by y-codemirror.next. */
  cursor?: { anchor: unknown; head: unknown } | null
  pen?: LivePen | null
}

type Change = { added: number[]; updated: number[]; removed: number[] }
type Listener = (change: Change, origin: unknown, transaction: unknown) => void

/** Presence older than this without a refresh is treated as left. Peers refresh every 30 s while the note is open. */
export const PRESENCE_TTL_MS = 75_000

export class LiveAwareness {
  private readonly states = new Map<number, LivePresenceState>()
  private readonly seen = new Map<number, number>()
  private readonly listeners = new Set<Listener>()
  private localKey = ''

  constructor(readonly doc: Pick<Y.Doc, 'clientID'>, private readonly onLocalChange: (state: LivePresenceState | null) => void = () => undefined) {
    this.states.set(doc.clientID, {})
  }

  getLocalState(): LivePresenceState | null {
    return this.states.get(this.doc.clientID) ?? null
  }

  getStates(): Map<number, LivePresenceState> {
    return this.states
  }

  setLocalState(state: LivePresenceState | null) {
    const id = this.doc.clientID
    const key = JSON.stringify(state)
    if (key === this.localKey) return
    this.localKey = key
    const existed = this.states.has(id)
    if (state === null) this.states.delete(id)
    else this.states.set(id, state)
    this.emit({ added: !existed && state ? [id] : [], updated: existed && state ? [id] : [], removed: existed && !state ? [id] : [] })
    this.onLocalChange(state)
  }

  setLocalStateField<K extends keyof LivePresenceState>(field: K, value: LivePresenceState[K]) {
    const state = this.getLocalState()
    if (!state) return
    this.setLocalState({ ...state, [field]: value })
  }

  /** A remote peer's presence (null = it left). `now` is the receive time. */
  applyRemote(clientId: number, state: LivePresenceState | null, now: number) {
    if (clientId === this.doc.clientID) return
    const existed = this.states.has(clientId)
    if (state === null) {
      this.seen.delete(clientId)
      if (existed) {
        this.states.delete(clientId)
        this.emit({ added: [], updated: [], removed: [clientId] })
      }
      return
    }
    this.seen.set(clientId, now)
    this.states.set(clientId, state)
    this.emit({ added: existed ? [] : [clientId], updated: existed ? [clientId] : [], removed: [] })
  }

  /** Drops peers that stopped refreshing. Returns how many remain, so the caller can stop its timer at zero. */
  expire(now: number): number {
    const gone: number[] = []
    for (const [id, at] of this.seen) if (now - at > PRESENCE_TTL_MS) gone.push(id)
    for (const id of gone) {
      this.seen.delete(id)
      this.states.delete(id)
    }
    if (gone.length) this.emit({ added: [], updated: [], removed: gone })
    return this.seen.size
  }

  remoteCount() {
    return this.seen.size
  }

  clearRemote() {
    const gone = [...this.seen.keys()]
    this.seen.clear()
    for (const id of gone) this.states.delete(id)
    if (gone.length) this.emit({ added: [], updated: [], removed: gone })
  }

  on(_event: 'change' | 'update', listener: Listener) {
    this.listeners.add(listener)
  }

  off(_event: 'change' | 'update', listener: Listener) {
    this.listeners.delete(listener)
  }

  private emit(change: Change) {
    for (const listener of [...this.listeners]) {
      try { listener(change, 'local', null) } catch (error) { console.error('[live] presence listener failed', error) }
    }
  }
}

/** Colours that read on the paper and the dark theme alike. */
export const LIVE_COLORS = ['#e4572e', '#2e86ab', '#17a398', '#a23b72', '#f18f01', '#6a4c93', '#3b8e3b', '#c0392b'] as const

export const liveUserFor = (name: string): LiveUser => {
  let hash = 5381
  for (let index = 0; index < name.length; index += 1) hash = ((hash * 33) ^ name.charCodeAt(index)) >>> 0
  const color = LIVE_COLORS[hash % LIVE_COLORS.length]
  return { name, color, colorLight: `${color}33` }
}

export const liveInitials = (name: string) => {
  const parts = name.split(/[\s._-]+/u).filter(Boolean)
  const letters = parts.length > 1 ? `${parts[0][0]}${parts[1][0]}` : name.slice(0, 2)
  return letters.toLocaleUpperCase('de-CH')
}
