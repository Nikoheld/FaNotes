import {
  VIEW_ZOOM_MIN,
  clampViewZoom,
  defaultPaperView,
  normalizeRotation,
  readSharedZoomMax,
  type PaperViewSnapshot,
} from './paperView'
import { normalizeTextAnchor, type PaperTextAnchor } from './paperTextAnchor'

/**
 * Per-note camera memory: sheet zoom, rotation and the paper point under the
 * viewport centre. Stored in localStorage so a relaunch reopens the note at
 * the exact spot the user left, independent of window size or sidebar width
 * (the centre is a paper coordinate, not a scroll offset).
 *
 * Typed notes additionally remember the text under the viewport top edge
 * (`anchor`): the editor virtualises long documents and only estimates the
 * height of lines it has not rendered, so the pixel centre alone drifts.
 */
export const PAPER_VIEW_MEMORY_KEY = 'fanotes.paperView.v1'
/** Most recently used notes kept in memory; older cameras are dropped. */
export const PAPER_VIEW_MEMORY_MAX = 400
/** After a note opens, keep re-applying the remembered camera while layout settles. */
export const PAPER_VIEW_RESTORE_SETTLE_MS = 2200
/** Frames right after open on which the camera is re-applied unconditionally. */
export const PAPER_VIEW_RESTORE_WARM_FRAMES = 12
/** A programmatic scroll lands within this many px of the requested offset. */
export const PAPER_VIEW_PROGRAMMATIC_SCROLL_TOLERANCE = 1.5

export type PaperViewMemoryEntry = {
  zoom: number
  rotation: number
  /** Unzoomed write-page CSS px under the viewport centre. */
  centreX: number
  centreY: number
  /** Unzoomed write-page size when measured; lets a re-flowed page scale the centre. */
  pageWidth?: number
  pageHeight?: number
  /** Text under the viewport top edge (typed notes only). */
  anchor?: PaperTextAnchor
  at: number
}

export type PaperViewMemoryStore = Record<string, PaperViewMemoryEntry>

const finite = (value: unknown, fallback: number) => (
  typeof value === 'number' && Number.isFinite(value) ? value : fallback
)

export const normalizePaperViewMemoryEntry = (raw: unknown): PaperViewMemoryEntry | null => {
  if (!raw || typeof raw !== 'object') return null
  const record = raw as Record<string, unknown>
  const zoom = finite(record.zoom, Number.NaN)
  if (!Number.isFinite(zoom) || zoom <= 0) return null
  const entry: PaperViewMemoryEntry = {
    zoom: Math.min(readSharedZoomMax(), Math.max(VIEW_ZOOM_MIN, Math.round(zoom * 1000) / 1000)),
    rotation: normalizeRotation(finite(record.rotation, 0)),
    centreX: Math.max(0, finite(record.centreX, 0)),
    centreY: Math.max(0, finite(record.centreY, 0)),
    at: Math.max(0, finite(record.at, 0)),
  }
  const pageWidth = finite(record.pageWidth, 0)
  const pageHeight = finite(record.pageHeight, 0)
  if (pageWidth > 0) entry.pageWidth = Math.round(pageWidth * 100) / 100
  if (pageHeight > 0) entry.pageHeight = Math.round(pageHeight * 100) / 100
  const anchor = normalizeTextAnchor(record.anchor)
  if (anchor) entry.anchor = anchor
  return entry
}

export const parsePaperViewMemory = (raw: string | null | undefined): PaperViewMemoryStore => {
  if (typeof raw !== 'string' || !raw.trim()) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return {}
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
  const store: PaperViewMemoryStore = {}
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!key) continue
    const entry = normalizePaperViewMemoryEntry(value)
    if (entry) store[key] = entry
  }
  return store
}

/** Newest `max` entries survive; the note that was just left is always kept. */
export const prunePaperViewMemory = (store: PaperViewMemoryStore, max = PAPER_VIEW_MEMORY_MAX): PaperViewMemoryStore => {
  const entries = Object.entries(store)
  if (entries.length <= max) return store
  entries.sort((a, b) => b[1].at - a[1].at)
  return Object.fromEntries(entries.slice(0, Math.max(1, max)))
}

export const serializePaperViewMemory = (store: PaperViewMemoryStore, max = PAPER_VIEW_MEMORY_MAX) => (
  JSON.stringify(prunePaperViewMemory(store, max))
)

export const rememberPaperView = (
  store: PaperViewMemoryStore,
  key: string,
  entry: Omit<PaperViewMemoryEntry, 'at'> & { at?: number },
  max = PAPER_VIEW_MEMORY_MAX,
): PaperViewMemoryStore => {
  if (!key) return store
  const normalized = normalizePaperViewMemoryEntry({ ...entry, at: entry.at ?? Date.now() })
  if (!normalized) return store
  return prunePaperViewMemory({ ...store, [key]: normalized }, max)
}

export const recallPaperView = (store: PaperViewMemoryStore, key: string | null | undefined): PaperViewMemoryEntry | null => (
  key ? store[key] ?? null : null
)

export const forgetPaperView = (store: PaperViewMemoryStore, key: string): PaperViewMemoryStore => {
  if (!(key in store)) return store
  const next = { ...store }
  delete next[key]
  return next
}

/** Snapshot the camera applies to the sheet plane for a remembered entry. */
export const paperViewFromMemory = (entry: PaperViewMemoryEntry | null): PaperViewSnapshot => (
  entry
    ? { zoom: clampViewZoom(entry.zoom), rotation: normalizeRotation(entry.rotation), pan: { x: 0, y: 0 } }
    : defaultPaperView()
)

/** Split panes share the identity of the note they mirror. */
export const paperViewMemoryKey = (viewKey: string | null | undefined) => {
  if (typeof viewKey !== 'string' || !viewKey) return ''
  return viewKey.startsWith('split:') ? viewKey.slice('split:'.length) : viewKey
}

type StorageLike = {
  getItem: (key: string) => string | null
  setItem: (key: string, value: string) => void
}

const resolveStorage = (storage?: StorageLike | null): StorageLike | null => {
  if (storage) return storage
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

export const loadPaperViewMemory = (storage?: StorageLike | null): PaperViewMemoryStore => {
  const target = resolveStorage(storage)
  if (!target) return {}
  try {
    return parsePaperViewMemory(target.getItem(PAPER_VIEW_MEMORY_KEY))
  } catch {
    return {}
  }
}

export const savePaperViewMemory = (store: PaperViewMemoryStore, storage?: StorageLike | null) => {
  const target = resolveStorage(storage)
  if (!target) return false
  try {
    target.setItem(PAPER_VIEW_MEMORY_KEY, serializePaperViewMemory(store))
    return true
  } catch {
    return false
  }
}

type RectLike = { left: number; top: number; width: number; height: number }
type ScrollerLike = {
  clientWidth: number
  clientHeight: number
  scrollLeft: number
  scrollTop: number
}

/**
 * Write-page point (unzoomed CSS px) under the viewport centre. The page rect
 * comes from getBoundingClientRect, so it already includes the camera zoom.
 */
export const paperCentreFromCamera = (
  scroller: ScrollerLike,
  scrollerRect: RectLike,
  pageRect: RectLike,
  zoom: number,
) => {
  const used = Math.max(0.01, Number.isFinite(zoom) && zoom > 0 ? zoom : 1)
  const viewCentreX = scrollerRect.left + scroller.clientWidth / 2
  const viewCentreY = scrollerRect.top + scroller.clientHeight / 2
  return {
    centreX: Math.max(0, Math.round(((viewCentreX - pageRect.left) / used) * 100) / 100),
    centreY: Math.max(0, Math.round(((viewCentreY - pageRect.top) / used) * 100) / 100),
  }
}

/** Scroll offsets that put a remembered page point back under the viewport centre. */
export const cameraForPaperCentre = (
  scroller: ScrollerLike,
  scrollerRect: RectLike,
  pageRect: RectLike,
  zoom: number,
  centre: { centreX: number; centreY: number },
) => {
  const used = Math.max(0.01, Number.isFinite(zoom) && zoom > 0 ? zoom : 1)
  const pointX = pageRect.left + centre.centreX * used
  const pointY = pageRect.top + centre.centreY * used
  const viewCentreX = scrollerRect.left + scroller.clientWidth / 2
  const viewCentreY = scrollerRect.top + scroller.clientHeight / 2
  return {
    scrollLeft: Math.max(0, Math.round((scroller.scrollLeft + pointX - viewCentreX) * 100) / 100),
    scrollTop: Math.max(0, Math.round((scroller.scrollTop + pointY - viewCentreY) * 100) / 100),
  }
}

/**
 * Remembered centre mapped onto the page as it is laid out now. A page that
 * re-flowed to another width (window resized, sidebar toggled) keeps the same
 * relative horizontal spot; proportional content (PDF pages) also scales
 * vertically with the width, typed text re-wraps and relies on `anchor`.
 */
export const scaledPaperCentre = (
  entry: Pick<PaperViewMemoryEntry, 'centreX' | 'centreY' | 'pageWidth'>,
  pageWidthNow: number,
  proportional: boolean,
) => {
  const saved = entry.pageWidth ?? 0
  if (!(saved > 0) || !(pageWidthNow > 0) || Math.abs(saved - pageWidthNow) <= 0.5) {
    return { centreX: entry.centreX, centreY: entry.centreY }
  }
  const ratio = pageWidthNow / saved
  return {
    centreX: Math.round(entry.centreX * ratio * 100) / 100,
    centreY: proportional ? Math.round(entry.centreY * ratio * 100) / 100 : entry.centreY,
  }
}

/** Scroll top that puts the anchored text's client y back on the viewport top edge. */
export const scrollTopForAnchorClientY = (
  scroller: Pick<ScrollerLike, 'scrollTop'>,
  scrollerRect: Pick<RectLike, 'top'>,
  anchorClientY: number,
) => Math.max(0, Math.round((scroller.scrollTop + anchorClientY - scrollerRect.top) * 100) / 100)

/** A scroll event that lands on the last programmatic target is not the user's. */
export const isProgrammaticScroll = (
  current: { scrollLeft: number; scrollTop: number },
  requested: { scrollLeft: number; scrollTop: number } | null,
  tolerance = PAPER_VIEW_PROGRAMMATIC_SCROLL_TOLERANCE,
) => (
  requested !== null
  && Math.abs(current.scrollLeft - requested.scrollLeft) <= tolerance
  && Math.abs(current.scrollTop - requested.scrollTop) <= tolerance
)

/**
 * Restore keeps re-applying while the page is still laying out (lazy editor,
 * PDF pages measuring their ratio) and stops at the first user input or once
 * the settle window is over.
 */
export const shouldKeepRestoringPaperView = (input: {
  startedAt: number
  now: number
  userInteracted: boolean
  settleMs?: number
}) => (
  !input.userInteracted && input.now - input.startedAt <= (input.settleMs ?? PAPER_VIEW_RESTORE_SETTLE_MS)
)

const MODIFIER_KEYS = new Set(['Alt', 'AltGraph', 'Control', 'Meta', 'Shift', 'CapsLock', 'NumLock', 'ScrollLock', 'Fn', 'Hyper', 'Super', 'OS'])

/**
 * A key press anywhere hands the camera to the user (outline jump, search hit,
 * caret move). Not the keys still in flight from the note switch itself: held
 * repeats of Ctrl+Tab / Ctrl+PageDown and bare modifiers.
 */
export const isPaperViewTakeoverKey = (event: { key: string; repeat?: boolean }) => (
  !event.repeat && !MODIFIER_KEYS.has(event.key)
)
