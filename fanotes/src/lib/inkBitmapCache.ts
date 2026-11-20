/**
 * Committed ink bitmaps of the last few heavy pages (DrawingBoard).
 *
 * A note switch remounts the board, and a heavy page then repainted every
 * stroke (about 90 ms of main-thread paint per open of a 500-stroke note, more
 * on a slower CPU). When a board closes with its page fully painted and
 * nothing pending, it leaves a copy of the committed bitmap here. The next
 * board for the same drawing takes it back only when the page it is about to
 * paint is provably the same picture:
 *  - the same paint key (pixel size and density, paper, smoothing, layout
 *    width, inline, gradient height) and the same slice top;
 *  - the same ink, by a 64-bit signature over every stroke field and point;
 *  - the same environment (device pixel ratio, theme).
 * Anything else is a miss and the page is painted as before.
 *
 * A drawing keeps one page (its last layout). Memory is bounded by entry
 * count and bytes. Zoom and paper-style changes,
 * a device pixel ratio or a theme change drop everything.
 */

export const INK_BITMAP_CACHE_ENTRIES = 5
/** About four 1,000-stroke A4 pages at 1.75 px per layout px (24 MB each). */
export const INK_BITMAP_CACHE_BYTES = 96 * 1024 * 1024

export type InkBitmapLike = { width: number; height: number; close?: () => void }

export type InkBitmapEntry<Bitmap extends InkBitmapLike = ImageBitmap, Coverage = unknown> = {
  drawingId: string
  signature: string
  contentKey: string
  topPx: number
  bitmap: Bitmap
  /** The marker mask that goes with the bitmap (null when the page has no marker ink). */
  coverage: Coverage | null
  coverageBytes: number
}

const entryBytes = (entry: InkBitmapEntry<InkBitmapLike, unknown>) => entry.bitmap.width * entry.bitmap.height * 4 + entry.coverageBytes

const defaultEnvironment = () => {
  if (typeof window === 'undefined') return 'none'
  const theme = typeof document !== 'undefined' ? document.documentElement.dataset.theme ?? '' : ''
  return `${(window.devicePixelRatio || 1).toFixed(3)}:${theme}`
}

/** Kill switch: `localStorage['fanotes.ink-bitmap-cache'] = '0'` turns the cache off (read once). */
export const INK_BITMAP_CACHE_FLAG = 'fanotes.ink-bitmap-cache'

const cacheAllowed = () => {
  try {
    return typeof localStorage === 'undefined' || localStorage.getItem(INK_BITMAP_CACHE_FLAG) !== '0'
  } catch {
    return true
  }
}

export const createInkBitmapCache = <Bitmap extends InkBitmapLike = ImageBitmap, Coverage = unknown>(options: {
  maxEntries?: number
  maxBytes?: number
  environment?: () => string
  enabled?: boolean
} = {}) => {
  const enabled = options.enabled ?? cacheAllowed()
  const maxEntries = options.maxEntries ?? INK_BITMAP_CACHE_ENTRIES
  const maxBytes = options.maxBytes ?? INK_BITMAP_CACHE_BYTES
  const environment = options.environment ?? defaultEnvironment
  // Most recently used last.
  let entries: InkBitmapEntry<Bitmap, Coverage>[] = []
  let env = ''
  /** Bumped by every clear: a snapshot that was still being made for an older state is not stored. */
  let generation = 0
  const release = (entry: InkBitmapEntry<Bitmap, Coverage>) => {
    try {
      entry.bitmap.close?.()
    } catch {
      // A closed bitmap is already free.
    }
  }
  const clear = () => {
    for (const entry of entries) release(entry)
    entries = []
    generation += 1
  }
  const checkEnvironment = () => {
    const now = environment()
    if (now !== env) {
      if (entries.length) clear()
      env = now
    }
  }
  const bytes = () => entries.reduce((sum, entry) => sum + entryBytes(entry), 0)
  return {
    /** The generation a snapshot starts in; pass it to `put` so a clear in between wins. */
    generation: () => {
      checkEnvironment()
      return generation
    },
    put(entry: InkBitmapEntry<Bitmap, Coverage>, startedIn = generation): boolean {
      checkEnvironment()
      if (!enabled || startedIn !== generation || !entry.drawingId || entryBytes(entry) > maxBytes / 2) {
        release(entry)
        return false
      }
      // One page per drawing: two layouts of every note would halve how many
      // notes fit, and a cycle through a few notes would evict each page just
      // before it is needed again.
      entries = entries.filter((held) => {
        if (held.drawingId !== entry.drawingId) return true
        release(held)
        return false
      })
      entries.push(entry)
      while (entries.length > maxEntries || bytes() > maxBytes) {
        const oldest = entries.shift()
        if (oldest) release(oldest)
      }
      return true
    },
    /** The entry of this drawing painted for this key and slice, left in place. */
    peek(drawingId: string | null | undefined, contentKey: string, topPx: number): InkBitmapEntry<Bitmap, Coverage> | null {
      checkEnvironment()
      if (!drawingId) return null
      return entries.find((entry) => entry.drawingId === drawingId && entry.contentKey === contentKey && entry.topPx === topPx) ?? null
    },
    has: (drawingId: string | null | undefined) => Boolean(drawingId) && entries.some((entry) => entry.drawingId === drawingId),
    /** Removes the entry; the caller now owns its bitmap and mask. */
    take(entry: InkBitmapEntry<Bitmap, Coverage>): InkBitmapEntry<Bitmap, Coverage> | null {
      const index = entries.indexOf(entry)
      if (index < 0) return null
      entries.splice(index, 1)
      return entry
    },
    drop(drawingId: string | null | undefined) {
      if (!drawingId) return
      entries = entries.filter((entry) => {
        if (entry.drawingId !== drawingId) return true
        release(entry)
        return false
      })
    },
    clear,
    stats: () => ({ entries: entries.length, bytes: bytes(), generation }),
  }
}

/** The one cache the boards share. */
export const inkBitmapCache = createInkBitmapCache<ImageBitmap, unknown>()

type SignatureStroke = { points: readonly { x: number; y: number; t?: number; pressure?: number; tiltX?: number; tiltY?: number }[] }

/**
 * 64-bit signature of the ink a page paints: every own field of every stroke
 * (sorted by name, undefined skipped, nested values by JSON) and the numeric
 * fields of every point, by their exact float bits. A stroke from another code
 * path with the same content has the same signature; any change of a value is
 * a different one.
 */
export const inkModelSignature = (strokes: readonly SignatureStroke[]) => {
  const view = new DataView(new ArrayBuffer(8))
  let h1 = 0x811c9dc5
  let h2 = 0x01000193 ^ strokes.length
  let points = 0
  const mixWord = (word: number) => {
    h1 = Math.imul(h1 ^ word, 0x01000193) >>> 0
    h2 = Math.imul(h2 ^ word, 0x5bd1e995) >>> 0
    h2 = (h2 ^ (h2 >>> 15)) >>> 0
  }
  const mixNumber = (value: number | undefined) => {
    if (value === undefined) {
      mixWord(0x9e3779b9)
      return
    }
    view.setFloat64(0, value)
    mixWord(view.getUint32(0))
    mixWord(view.getUint32(4))
  }
  const mixString = (value: string) => {
    mixWord(value.length)
    for (let index = 0; index < value.length; index += 1) mixWord(value.charCodeAt(index))
  }
  for (const stroke of strokes) {
    const record = stroke as unknown as Record<string, unknown>
    for (const key of Object.keys(record).sort()) {
      if (key === 'points') continue
      const value = record[key]
      if (value === undefined) continue
      mixString(key)
      if (typeof value === 'number') mixNumber(value)
      else if (typeof value === 'string') mixString(value)
      else if (typeof value === 'boolean') mixWord(value ? 1 : 2)
      else mixString(JSON.stringify(value) ?? '')
    }
    mixWord(stroke.points.length)
    for (const point of stroke.points) {
      mixNumber(point.x)
      mixNumber(point.y)
      mixNumber(point.pressure)
      mixNumber(point.t)
      mixNumber(point.tiltX)
      mixNumber(point.tiltY)
    }
    points += stroke.points.length
  }
  return `${strokes.length}:${points}:${h1.toString(16)}:${h2.toString(16)}`
}
