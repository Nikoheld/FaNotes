import type { PDFDocumentLoadingTask, PDFDocumentProxy } from 'pdfjs-dist'
import { loadVaultPdfBytes, openPdfDocument } from './pdfDocument'
import { pdfByteStamp } from './pdfOcr'

/**
 * A PDF opened before its view mounts. Opening a PDF tab used to swap the
 * previous note for a "PDF wird vorbereitet" box, then for empty page frames,
 * then for the pages: three paints and a layout jump. The app now reads and
 * parses the PDF while the previous document is still on screen and hands the
 * open document to the view, which lays out its pages in its first commit.
 */
export type PreparedPdf = {
  path: string
  pdf: PDFDocumentProxy
  task: PDFDocumentLoadingTask
  size: number
  stamp: string
  /** Height / width of page 1, rotation 0. */
  ratio: number | null
}

/** An unclaimed document is dropped after this; a later open reads the file again. */
export const PREPARED_PDF_TTL_MS = 8_000

/** A document handed back by a view that let go of it right after taking it. */
export const RETURNED_PDF_TTL_MS = 1_000

type Slot = { prepared: PreparedPdf; at: number; ttl: number; timer: ReturnType<typeof setTimeout> | null }

let slot: Slot | null = null
let inFlight: { path: string; token: object; promise: Promise<PreparedPdf | null> } | null = null

const release = (prepared: PreparedPdf) => {
  void prepared.task.destroy().catch(() => undefined)
}

const clearSlot = () => {
  if (!slot) return
  if (slot.timer !== null) clearTimeout(slot.timer)
  release(slot.prepared)
  slot = null
}

const store = (prepared: PreparedPdf, now: number, ttl = PREPARED_PDF_TTL_MS) => {
  if (slot?.prepared === prepared) return
  clearSlot()
  const timer = typeof setTimeout === 'function'
    ? setTimeout(() => { if (slot?.prepared === prepared) clearSlot() }, ttl)
    : null
  slot = { prepared, at: now, ttl, timer }
}

/**
 * Read and open `path` with the viewer's worker. Resolves `null` when the PDF
 * needs a password or cannot be read: the view then loads it itself and shows
 * its own password form or error.
 */
export const preparePdfDocument = (
  path: string,
  open: (bytes: Uint8Array) => Promise<{ pdf: PDFDocumentProxy; task: PDFDocumentLoadingTask }> = (bytes) => openPdfDocument(bytes, undefined, { viewer: true }),
  readBytes: (path: string) => Promise<Uint8Array> = loadVaultPdfBytes,
  now: () => number = Date.now,
): Promise<PreparedPdf | null> => {
  if (slot?.prepared.path === path) return Promise.resolve(slot.prepared)
  if (inFlight?.path === path) return inFlight.promise
  const token = {}
  const promise = (async () => {
    try {
      const bytes = await readBytes(path)
      if (!bytes.length) return null
      const size = bytes.byteLength
      const stamp = pdfByteStamp(bytes)
      const { pdf, task } = await open(bytes)
      let ratio: number | null = null
      try {
        const viewport = (await pdf.getPage(1)).getViewport({ scale: 1, rotation: 0 })
        ratio = viewport.height / Math.max(1, viewport.width)
      } catch {
        // The view keeps its A4 fallback.
      }
      const prepared: PreparedPdf = { path, pdf, task, size, stamp, ratio }
      // A newer prepare for another PDF owns the slot now.
      if (inFlight?.token !== token) {
        release(prepared)
        return null
      }
      store(prepared, now())
      return prepared
    } catch {
      return null
    } finally {
      if (inFlight?.token === token) inFlight = null
    }
  })()
  inFlight = { path, token, promise }
  return promise
}

/** Hand the prepared document for `path` to its view; the view owns (and destroys) it from here. */
export const takePreparedPdfDocument = (path: string, now: () => number = Date.now): PreparedPdf | null => {
  if (!slot || slot.prepared.path !== path) return null
  const { prepared, at, ttl, timer } = slot
  if (timer !== null) clearTimeout(timer)
  slot = null
  if (now() - at > ttl) {
    release(prepared)
    return null
  }
  return prepared
}

/**
 * The view mounted before the prepare finished (a large PDF outran the open
 * wait): claim that read instead of starting a second one. `null` when no
 * prepare for `path` is running or it failed; the view then reads the file.
 */
export const claimPreparingPdfDocument = async (path: string, now: () => number = Date.now): Promise<PreparedPdf | null> => {
  const running = inFlight?.path === path ? inFlight.promise : null
  if (!running) return null
  await running
  return takePreparedPdfDocument(path, now)
}

/**
 * A view that took a document and is torn down at once (React StrictMode
 * replays mount effects; a remount for the same path) hands it back briefly
 * instead of destroying it, so the replay adopts it again. Anything else
 * destroys it after RETURNED_PDF_TTL_MS.
 */
export const returnPreparedPdfDocument = (prepared: PreparedPdf, now: () => number = Date.now) => {
  store(prepared, now(), RETURNED_PDF_TTL_MS)
}

/** Drop whatever was prepared (vault switch, tests). */
export const discardPreparedPdfDocument = () => {
  inFlight = null
  clearSlot()
}
