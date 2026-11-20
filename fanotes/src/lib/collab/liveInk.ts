// Pen strokes as a CRDT. The strokes of a live note are a Y.Map keyed by stroke
// id; every entry is its own small Y.Map holding the stroke as JSON (`j`) and its
// z-order (`o`).
//   add    a new entry
//   erase  the entry is deleted and its id goes into the `dead` map
//   move   the entry's `j` is rewritten (last writer wins)
// Because a move writes into the entry's own map, an erase that races with it wins
// cleanly: Yjs drops writes into a deleted map, so no half-erased stroke comes back.
// The `dead` ids also stop a stale copy of the file from bringing an erased
// stroke back when a device joins late. A stroke that is still being drawn is not
// part of the document until the pen lifts, so erasing around it cannot touch it.
//
// Strokes in famd files carry no id. Ids are derived from the stroke's content
// when a note is loaded (so two devices that load the same file agree) and are
// random for strokes drawn afterwards; the id never reaches the file.
import * as Y from 'yjs'

export type InkPoint = { x: number; y: number }
export type InkLike = { points: InkPoint[] } & Record<string, unknown>

export type InkRemoteChange<S> = {
  added: S[]
  /** Strokes that disappeared (erased by the other person). */
  removed: S[]
  /** Strokes whose geometry changed (moved or scaled by the other person). */
  replaced: Array<{ from: S; to: S }>
}

export const INK_LOCAL = 'live-ink-local'

const fnv = (text: string) => {
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(36)
}

const round = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? Math.round(value * 10) / 10 : 0)

/** A stable id for a stroke that came from a file. */
export const contentIdOf = (stroke: InkLike) => {
  const points = Array.isArray(stroke.points) ? stroke.points : []
  const first = points[0]
  const last = points[points.length - 1]
  const mid = points[points.length >> 1]
  let sum = 0
  for (const point of points) sum += round(point.x) * 3.1 + round(point.y)
  return `f${fnv([points.length, round(first?.x), round(first?.y), round(mid?.x), round(mid?.y), round(last?.x), round(last?.y), round(sum), stroke.color ?? '', stroke.baseWidth ?? stroke.width ?? ''].join('|'))}`
}

const randomId = () => {
  const bytes = new Uint8Array(9)
  globalThis.crypto.getRandomValues(bytes)
  return `n${Array.from(bytes, (byte) => byte.toString(36).padStart(2, '0')).join('')}`
}

const shapeKey = (stroke: InkLike) => `${stroke.points.length}|${stroke.color ?? ''}|${stroke.baseWidth ?? stroke.width ?? ''}|${stroke.brush ?? ''}|${stroke.opacity ?? ''}`

/** Constant offset between two strokes with the same shape: a pure move. */
const translationOf = (from: InkLike, to: InkLike) => {
  if (from.points.length !== to.points.length || !from.points.length) return null
  const dx = to.points[0].x - from.points[0].x
  const dy = to.points[0].y - from.points[0].y
  for (let index = 1; index < from.points.length; index += 1) {
    if (Math.abs(to.points[index].x - from.points[index].x - dx) > 0.01 || Math.abs(to.points[index].y - from.points[index].y - dy) > 0.01) return null
  }
  return { dx, dy }
}

type Entry<S> = { id: string; stroke: S }

export class LiveInk<S extends InkLike> {
  private readonly strokes: Y.Map<Y.Map<unknown>>
  private readonly dead: Y.Map<boolean>
  private readonly ids = new WeakMap<object, string>()
  private known = new Map<string, S>()
  private lastArray: readonly S[] | null = null
  private order = 0
  private readonly listener: (events: Array<Y.YEvent<any>>, transaction: Y.Transaction) => void

  constructor(
    private readonly doc: Y.Doc,
    private readonly onRemote: (change: InkRemoteChange<S>) => void,
    /** Turns stored JSON into a stroke the board can use. */
    private readonly revive: (value: Record<string, unknown>) => S = (value) => value as S,
  ) {
    this.strokes = doc.getMap('strokes') as Y.Map<Y.Map<unknown>>
    this.dead = doc.getMap('dead') as Y.Map<boolean>
    this.listener = (events, transaction) => this.observe(events, transaction)
    this.strokes.observeDeep(this.listener)
  }

  destroy() {
    this.strokes.unobserveDeep(this.listener)
  }

  idOf(stroke: S) {
    return this.ids.get(stroke)
  }

  get size() {
    return this.strokes.size
  }

  /** The strokes in the document, in z-order. */
  current(): S[] {
    const list: Array<{ id: string; o: number; stroke: S }> = []
    this.strokes.forEach((entry, id) => {
      const stroke = this.read(id, entry)
      if (stroke) list.push({ id, o: Number(entry.get('o')) || 0, stroke })
    })
    list.sort((a, b) => a.o - b.o || (a.id < b.id ? -1 : 1))
    for (const item of list) this.known.set(item.id, item.stroke)
    return list.map((item) => item.stroke)
  }

  private read(id: string, entry: Y.Map<unknown>): S | null {
    const cached = this.known.get(id)
    const json = entry.get('j')
    if (typeof json !== 'string') return null
    if (cached && (cached as { __j?: string }).__j === json) return cached
    try {
      const stroke = this.revive(JSON.parse(json) as Record<string, unknown>)
      this.ids.set(stroke, id)
      Object.defineProperty(stroke, '__j', { value: json, enumerable: false, configurable: true })
      return stroke
    } catch {
      return null
    }
  }

  private assign(strokes: readonly S[], fromFile: boolean) {
    const taken = new Map<string, number>()
    const list: Array<Entry<S>> = []
    for (const stroke of strokes) {
      let id = this.ids.get(stroke)
      if (!id) {
        if (fromFile) {
          const base = contentIdOf(stroke)
          const count = (taken.get(base) ?? 0) + 1
          taken.set(base, count)
          id = count === 1 ? base : `${base}-${count}`
        } else {
          id = randomId()
        }
        this.ids.set(stroke, id)
      }
      list.push({ id, stroke })
    }
    return list
  }

  /**
   * First attach: the strokes this device has (from its file) are added unless the document
   * already knows them or they were erased. Strokes that exist only in the document are returned
   * so the board can show them.
   */
  attach(local: readonly S[]): S[] {
    const entries = this.assign(local, true)
    const present = new Set(entries.map((entry) => entry.id))
    this.doc.transact(() => {
      for (const { id, stroke } of entries) {
        if (this.strokes.has(id) || this.dead.has(id)) continue
        this.put(id, stroke, this.order += 1)
      }
    }, INK_LOCAL)
    const merged = this.current()
    // Strokes the file had and the document erased are dropped from the board's view as well.
    const result = merged
    this.known = new Map(merged.map((stroke) => [this.ids.get(stroke) as string, stroke]))
    void present
    this.lastArray = null
    return result
  }

  private put(id: string, stroke: S, order: number) {
    const entry = new Y.Map<unknown>()
    entry.set('j', JSON.stringify(stroke))
    entry.set('o', order)
    this.strokes.set(id, entry)
  }

  /**
   * The board's committed strokes changed. The difference to what the document holds becomes
   * adds, erases and moves. Cheap when nothing changed: the same array is skipped, and committed
   * strokes are compared by identity.
   */
  push(strokes: readonly S[]) {
    if (strokes === this.lastArray) return
    this.lastArray = strokes
    const entries = this.assign(strokes, false)
    const now = new Map<string, S>()
    const added: Array<Entry<S>> = []
    for (const entry of entries) {
      now.set(entry.id, entry.stroke)
      const before = this.known.get(entry.id)
      if (!before) added.push(entry)
      else if (before !== entry.stroke) added.push(entry)
    }
    const removed: Array<Entry<S>> = []
    for (const [id, stroke] of this.known) if (!now.has(id)) removed.push({ id, stroke })
    if (!added.length && !removed.length) return

    // A removed stroke and an added stroke that are the same shape shifted by a constant are a move.
    const moves: Array<{ id: string; stroke: S }> = []
    const freshAdds: Array<Entry<S>> = []
    const unmatched = new Map<string, Entry<S>[]>()
    const removedById = new Map(removed.map((entry) => [entry.id, entry]))
    for (const entry of removed) {
      const key = shapeKey(entry.stroke)
      unmatched.set(key, [...(unmatched.get(key) ?? []), entry])
    }
    for (const entry of added) {
      if (this.known.has(entry.id)) {
        // Same id, new object: the board replaced the stroke in place (resized, recoloured).
        moves.push({ id: entry.id, stroke: entry.stroke })
        continue
      }
      const candidates = unmatched.get(shapeKey(entry.stroke))
      const index = candidates ? candidates.findIndex((candidate) => translationOf(candidate.stroke, entry.stroke)) : -1
      if (candidates && index >= 0) {
        const [match] = candidates.splice(index, 1)
        removedById.delete(match.id)
        this.ids.set(entry.stroke, match.id)
        moves.push({ id: match.id, stroke: entry.stroke })
      } else {
        freshAdds.push(entry)
      }
    }

    this.doc.transact(() => {
      for (const { id } of removedById.values()) {
        this.strokes.delete(id)
        this.dead.set(id, true)
      }
      for (const { id, stroke } of moves) {
        const entry = this.strokes.get(id)
        const json = JSON.stringify(stroke)
        if (entry && entry.get('j') !== json) entry.set('j', json)
      }
      for (const { id, stroke } of freshAdds) this.put(id, stroke, Date.now() * 1000 + (this.order = (this.order + 1) % 1000))
    }, INK_LOCAL)
    // Ids may have been re-pointed by move matching, so the map is rebuilt from the objects.
    this.known = new Map()
    for (const stroke of strokes) this.known.set(this.ids.get(stroke) as string, stroke)
    void now
  }

  private observe(events: Array<Y.YEvent<any>>, transaction: Y.Transaction) {
    if (transaction.origin === INK_LOCAL) return
    const added: S[] = []
    const removed: S[] = []
    const replaced: Array<{ from: S; to: S }> = []
    const touched = new Set<string>()
    for (const event of events) {
      if (event.target === this.strokes) {
        for (const [id, change] of event.keys) {
          if (change.action === 'delete') {
            const old = this.known.get(id)
            this.known.delete(id)
            if (old) removed.push(old)
          } else {
            touched.add(id)
          }
        }
      } else if (event.path.length === 1) {
        touched.add(String(event.path[0]))
      }
    }
    for (const id of touched) {
      const entry = this.strokes.get(id)
      if (!entry) continue
      const before = this.known.get(id)
      const stroke = this.read(id, entry)
      if (!stroke || stroke === before) continue
      this.known.set(id, stroke)
      if (before) replaced.push({ from: before, to: stroke })
      else added.push(stroke)
    }
    if (added.length || removed.length || replaced.length) this.onRemote({ added, removed, replaced })
  }

  /** Called by the board after it applied a remote change, so its next push does not echo it back. */
  acknowledge(strokes: readonly S[]) {
    this.known = new Map()
    for (const stroke of strokes) {
      const id = this.ids.get(stroke)
      if (id) this.known.set(id, stroke)
    }
    this.lastArray = strokes
  }
}
