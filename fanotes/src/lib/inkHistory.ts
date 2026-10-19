/** How many undo or redo steps a page keeps, in memory and on disk. */
export const INK_HISTORY_LIMIT = 80

export type InkStrokeRef =
  | { readonly live: number }
  | { readonly extra: number }

export type EncodedInkHistory<T> = {
  extras: T[]
  undo: InkStrokeRef[][]
  redo: InkStrokeRef[][]
}

const isIndex = (value: unknown, length: number): value is number => (
  typeof value === 'number' && Number.isInteger(value) && value >= 0 && value < length
)

/**
 * Stroke snapshots share objects with the live page. Persist that sharing as
 * indexes so a closed app can undo without storing the whole page 80 times.
 * Strokes that exist only in history (erased or undone) are the extras.
 */
export const encodeInkHistory = <T extends object>(
  live: readonly T[],
  undo: readonly (readonly T[])[],
  redo: readonly (readonly T[])[],
): EncodedInkHistory<T> | null => {
  const undoStack = undo.slice(-INK_HISTORY_LIMIT)
  const redoStack = redo.slice(-INK_HISTORY_LIMIT)
  if (!undoStack.length && !redoStack.length) return null
  const liveIndex = new Map<T, number>()
  live.forEach((stroke, index) => {
    if (!liveIndex.has(stroke)) liveIndex.set(stroke, index)
  })
  const extras: T[] = []
  const extraIndex = new Map<T, number>()
  const refOf = (stroke: T): InkStrokeRef => {
    const liveAt = liveIndex.get(stroke)
    if (liveAt !== undefined) return { live: liveAt }
    let extraAt = extraIndex.get(stroke)
    if (extraAt === undefined) {
      extraAt = extras.length
      extras.push(stroke)
      extraIndex.set(stroke, extraAt)
    }
    return { extra: extraAt }
  }
  return {
    extras,
    undo: undoStack.map((snapshot) => snapshot.map(refOf)),
    redo: redoStack.map((snapshot) => snapshot.map(refOf)),
  }
}

const emptyHistory = <T>(): { undo: T[][]; redo: T[][] } => ({ undo: [], redo: [] })

/** Restore undo and redo. A broken history is dropped so the page itself still opens. */
export const decodeInkHistory = <T>(
  live: readonly T[],
  encoded: unknown,
  sanitizeExtra: (value: unknown) => T | null,
): { undo: T[][]; redo: T[][] } => {
  if (!encoded || typeof encoded !== 'object') return emptyHistory()
  const raw = encoded as { extras?: unknown; undo?: unknown; redo?: unknown }
  if (!Array.isArray(raw.extras) || !Array.isArray(raw.undo) || !Array.isArray(raw.redo)) return emptyHistory()
  if (raw.undo.length > INK_HISTORY_LIMIT || raw.redo.length > INK_HISTORY_LIMIT) return emptyHistory()
  const extras: T[] = []
  for (const entry of raw.extras) {
    const stroke = sanitizeExtra(entry)
    if (!stroke) return emptyHistory()
    extras.push(stroke)
  }
  const resolve = (ref: unknown): T | null => {
    if (!ref || typeof ref !== 'object') return null
    const record = ref as { live?: unknown; extra?: unknown }
    const hasLive = Object.prototype.hasOwnProperty.call(record, 'live')
    const hasExtra = Object.prototype.hasOwnProperty.call(record, 'extra')
    if (hasLive === hasExtra) return null
    if (hasLive) {
      const index = record.live
      if (!isIndex(index, live.length)) return null
      return live[index]
    }
    const index = record.extra
    if (!isIndex(index, extras.length)) return null
    return extras[index]
  }
  const stack = (value: unknown[]): T[][] | null => {
    const snapshots: T[][] = []
    for (const snapshot of value) {
      if (!Array.isArray(snapshot)) return null
      const strokes: T[] = []
      for (const ref of snapshot) {
        const stroke = resolve(ref)
        if (!stroke) return null
        strokes.push(stroke)
      }
      snapshots.push(strokes)
    }
    return snapshots
  }
  const undo = stack(raw.undo)
  const redo = stack(raw.redo)
  if (!undo || !redo) return emptyHistory()
  return { undo, redo }
}
