/**
 * Reading spot of a PDF that is shown without the sheet camera (the subject
 * book pane): the page at the top edge and how far into it the user had
 * scrolled. The page number alone reopened a tall, zoomed page at its centre.
 */
export const PDF_READING_SPOT_KEY = 'fanotes.pdfReadingSpot.v1'
export const PDF_READING_SPOT_MAX = 200

export type PdfReadingSpot = { page: number; frac: number; at: number }
export type PdfReadingSpotStore = Record<string, PdfReadingSpot>

export const normalizePdfReadingSpot = (raw: unknown): PdfReadingSpot | null => {
  if (!raw || typeof raw !== 'object') return null
  const record = raw as Record<string, unknown>
  const page = Math.round(Number(record.page))
  const frac = Number(record.frac)
  if (!Number.isSafeInteger(page) || page < 1 || !Number.isFinite(frac)) return null
  const at = Number(record.at)
  return {
    page,
    frac: Math.min(1, Math.max(0, Math.round(frac * 1000) / 1000)),
    at: Number.isFinite(at) && at > 0 ? at : 0,
  }
}

export const parsePdfReadingSpots = (raw: string | null | undefined): PdfReadingSpotStore => {
  if (typeof raw !== 'string' || !raw.trim()) return {}
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch { return {} }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
  const store: PdfReadingSpotStore = {}
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    const spot = key ? normalizePdfReadingSpot(value) : null
    if (spot) store[key] = spot
  }
  return store
}

export const rememberPdfReadingSpot = (
  store: PdfReadingSpotStore,
  path: string,
  spot: { page: number; frac: number },
  now = Date.now(),
  max = PDF_READING_SPOT_MAX,
): PdfReadingSpotStore => {
  const normalized = path ? normalizePdfReadingSpot({ ...spot, at: now }) : null
  if (!normalized) return store
  const entries = Object.entries({ ...store, [path]: normalized })
  if (entries.length <= max) return Object.fromEntries(entries)
  entries.sort((a, b) => b[1].at - a[1].at)
  return Object.fromEntries(entries.slice(0, Math.max(1, max)))
}

export const loadPdfReadingSpot = (path: string): PdfReadingSpot | null => {
  try {
    return parsePdfReadingSpots(localStorage.getItem(PDF_READING_SPOT_KEY))[path] ?? null
  } catch {
    return null
  }
}

export const savePdfReadingSpot = (path: string, spot: { page: number; frac: number }) => {
  try {
    const store = parsePdfReadingSpots(localStorage.getItem(PDF_READING_SPOT_KEY))
    localStorage.setItem(PDF_READING_SPOT_KEY, JSON.stringify(rememberPdfReadingSpot(store, path, spot)))
  } catch {
    // Storage full or unavailable: the page number still comes back.
  }
}

type Box = { top: number; height: number }

/** Page under the scroller's top edge and the fraction of it already scrolled past. */
export const pdfSpotFromBoxes = (scrollerTop: number, pages: Array<Box & { page: number }>): { page: number; frac: number } | null => {
  for (const box of pages) {
    if (box.top + box.height > scrollerTop + 1) {
      const frac = box.height > 0 ? (scrollerTop - box.top) / box.height : 0
      return { page: box.page, frac: Math.min(1, Math.max(0, frac)) }
    }
  }
  return null
}

/** Scroll delta (added to scrollTop) that puts the spot back on the top edge. */
export const pdfScrollDeltaForSpot = (scrollerTop: number, pageBox: Box, frac: number) => (
  Math.round((pageBox.top + pageBox.height * Math.min(1, Math.max(0, frac)) - scrollerTop) * 100) / 100
)
