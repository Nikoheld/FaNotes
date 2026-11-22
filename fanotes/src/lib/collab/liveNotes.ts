// A shared note opened for live co-editing: the encrypted channel, the ink CRDT,
// and the people who are in the note right now. Loaded on demand (Yjs and
// y-codemirror.next stay out of the main bundle until a shared note is opened).
import type { LiveNoteInfo, LiveOpenOutcome } from '../sync/userShares'
import type { SyncKeys } from '../sync/crypto'
import { LiveChannel, type LivePort, type LiveStatus, type LiveStore } from './liveChannel'
import { liveUserFor, type LivePen } from './liveAwareness'
import { LiveInk, type InkLike, type InkRemoteChange } from './liveInk'

export type LivePerson = { id: number; name: string; color: string; pen: LivePen | null }

export class LiveNote {
  readonly channel: LiveChannel
  ink: LiveInk<InkLike> | null = null
  /** The local text could not be taken over by the live state (it was kept as a copy by the caller). */
  diverged: string | null = null
  text = ''
  private readonly peopleListeners = new Set<() => void>()
  private readonly closedListeners = new Set<() => void>()
  private cachedPeople: LivePerson[] = []
  private readonly watch: () => void

  constructor(readonly info: LiveNoteInfo, channel: LiveChannel) {
    this.channel = channel
    this.watch = () => {
      this.cachedPeople = this.computePeople()
      for (const listener of [...this.peopleListeners]) listener()
    }
    channel.awareness.on('change', this.watch)
    // The channel also closes without the note's own close(): a rotated room key, a removed share, withdrawn access.
    channel.onClosed(() => { void this.close() })
  }

  get status(): LiveStatus { return this.channel.status }
  get canWrite() { return this.info.canWrite }
  get awareness() { return this.channel.awareness }
  get ytext() { return this.channel.text }

  private computePeople(): LivePerson[] {
    const people: LivePerson[] = []
    for (const [id, state] of this.channel.awareness.getStates()) {
      if (id === this.channel.doc.clientID || !state.user) continue
      people.push({ id, name: state.user.name, color: state.user.color, pen: state.pen ?? null })
    }
    return people.sort((a, b) => a.name.localeCompare(b.name))
  }

  /** Other people in the note (stable array between changes, for useSyncExternalStore). */
  people = () => this.cachedPeople

  onPeople(listener: () => void) {
    this.peopleListeners.add(listener)
    return () => { this.peopleListeners.delete(listener) }
  }

  onClosed(listener: () => void) {
    this.closedListeners.add(listener)
  }

  /** The pen position in page coordinates, or null when the pen is up and away. */
  setPen(pen: LivePen | null) {
    this.channel.awareness.setLocalStateField('pen', pen)
  }

  /** Binds the ink of the open page. Remote changes arrive through `onRemote`. */
  attachInk<S extends InkLike>(onRemote: (change: InkRemoteChange<S>) => void, revive?: (value: Record<string, unknown>) => S): LiveInk<S> {
    this.ink?.destroy()
    const ink = new LiveInk<S>(this.channel.doc, onRemote, revive)
    this.ink = ink as unknown as LiveInk<InkLike>
    return ink
  }

  private closing: Promise<void> | null = null

  close(): Promise<void> {
    this.closing ??= this.shutDown()
    return this.closing
  }

  private async shutDown() {
    this.channel.awareness.off('change', this.watch)
    this.ink?.destroy()
    this.ink = null
    await this.channel.close()
    for (const listener of [...this.closedListeners]) listener()
    this.closedListeners.clear()
    this.peopleListeners.clear()
  }
}

export type OpenLiveNoteDeps = { info: LiveNoteInfo; port: LivePort; keys: SyncKeys; channelId: string; store: LiveStore }

export const openLiveNote = async (deps: OpenLiveNoteDeps, localText: string, localModified: boolean): Promise<LiveOpenOutcome> => {
  const channel = new LiveChannel({ port: deps.port, keys: deps.keys, channel: deps.channelId, deviceId: deps.info.deviceId, canWrite: deps.info.canWrite, store: deps.store })
  channel.awareness.setLocalState({ user: liveUserFor(deps.info.username), cursor: null, pen: null })
  const result = await channel.open(localText, localModified)
  if (!result.ok) {
    await channel.close()
    return { note: null, reason: result.reason }
  }
  const note = new LiveNote(deps.info, channel)
  note.text = result.text
  note.diverged = result.diverged
  return { note }
}
