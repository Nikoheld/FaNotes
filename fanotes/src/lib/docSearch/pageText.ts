/**
 * `fanotes-page-text-v1`: the per-page text of one vault document, written by
 * FaNotes into `.fanotes/page-text/<sha256(path)[0:32]>.json` so other FaNotes
 * clients (Kanti+, another desktop) can reuse extracted and recognised text
 * instead of running OCR again. The full specification with examples is in
 * `docs/DOCUMENT_SEARCH.md`; this module is the reference reader and writer.
 *
 * A reader must only use a record when `path`, `size` and `stamp` match the
 * document it has. Unknown `format` values are ignored, never migrated.
 */

export const PAGE_TEXT_FORMAT = 'fanotes-page-text-v1' as const
export const PAGE_TEXT_DIRECTORY = '.fanotes/page-text'
export const PAGE_TEXT_MAX_PAGES = 2000
export const PAGE_TEXT_MAX_PAGE_CHARS = 6000
export const PAGE_TEXT_MAX_BYTES = 4 * 1024 * 1024
export const PAGE_TEXT_MAX_DOCUMENT_BYTES = 96 * 1024 * 1024

export type PageTextSource =
  /** Text the PDF itself contains. */
  | 'text-layer'
  /** Recognised from the rendered page by a local OCR engine. */
  | 'ocr'

export type PageTextStatus =
  | 'ok'
  /** OCR ran and found no letters (blank page, picture, unreadable scan). */
  | 'empty'
  /** OCR or extraction failed for this page; `reason` says why. */
  | 'failed'
  /** The page was not processed (page limit, unsupported content). */
  | 'skipped'

export type PageTextPage = {
  /** 1-based page number in the PDF. */
  page: number
  source: PageTextSource
  status: PageTextStatus
  text: string
  /** 0–1 engine confidence for OCR pages, when the engine reports one. */
  confidence?: number
  /** Clockwise degrees the page image was turned before OCR (0, 90, 180, 270). */
  rotation?: 0 | 90 | 180 | 270
  /** Short machine-readable reason for `failed`/`skipped`. */
  reason?: string
}

export type PageTextRecord = {
  format: typeof PAGE_TEXT_FORMAT
  /** Vault-relative POSIX path of the document. */
  path: string
  /** Byte size of the document that was read. */
  size: number
  /** `pdfByteStamp` of the bytes that were read (8 hex chars). */
  stamp: string
  /** Number of pages the document has. */
  pageCount: number
  /** Producer, e.g. "fanotes-desktop/2026.11.2 doc-search/1". Informational. */
  producer: string
  /** OCR engine id, e.g. "fanotes-trocr-v1". Informational; readers may prefer their own engine. */
  ocrEngine?: string
  /** ISO time the record was written. */
  createdAt: string
  pages: PageTextPage[]
}

const STAMP = /^[a-f0-9]{8}$/u
const SOURCES = new Set<PageTextSource>(['text-layer', 'ocr'])
const STATUSES = new Set<PageTextStatus>(['ok', 'empty', 'failed', 'skipped'])
const ROTATIONS = new Set([0, 90, 180, 270])

const validPath = (value: unknown): value is string => (
  typeof value === 'string'
  && value.length > 0
  && value.length <= 4096
  && !value.includes('\0')
  && !value.includes('\\')
  && value.split('/').every((segment) => segment && segment !== '.' && segment !== '..')
)

/** Returns a clean record, or null for anything that is not a valid v1 record. */
export const sanitizePageTextRecord = (value: unknown): PageTextRecord | null => {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  if (record.format !== PAGE_TEXT_FORMAT) return null
  if (!validPath(record.path)) return null
  if (!Number.isSafeInteger(record.size) || (record.size as number) < 1 || (record.size as number) > PAGE_TEXT_MAX_DOCUMENT_BYTES) return null
  if (typeof record.stamp !== 'string' || !STAMP.test(record.stamp)) return null
  if (!Number.isSafeInteger(record.pageCount) || (record.pageCount as number) < 0 || (record.pageCount as number) > 100_000) return null
  if (typeof record.producer !== 'string' || record.producer.length > 200) return null
  if (record.ocrEngine !== undefined && (typeof record.ocrEngine !== 'string' || record.ocrEngine.length > 100)) return null
  if (typeof record.createdAt !== 'string' || !Number.isFinite(Date.parse(record.createdAt))) return null
  if (!Array.isArray(record.pages) || record.pages.length > PAGE_TEXT_MAX_PAGES) return null
  const pages: PageTextPage[] = []
  const seen = new Set<number>()
  for (const entry of record.pages) {
    if (!entry || typeof entry !== 'object') return null
    const page = entry as Record<string, unknown>
    if (!Number.isSafeInteger(page.page) || (page.page as number) < 1 || (page.page as number) > (record.pageCount as number)) return null
    if (seen.has(page.page as number)) return null
    seen.add(page.page as number)
    if (!SOURCES.has(page.source as PageTextSource) || !STATUSES.has(page.status as PageTextStatus)) return null
    if (typeof page.text !== 'string' || page.text.length > PAGE_TEXT_MAX_PAGE_CHARS) return null
    if (page.confidence !== undefined && (typeof page.confidence !== 'number' || !(page.confidence >= 0 && page.confidence <= 1))) return null
    if (page.rotation !== undefined && !ROTATIONS.has(page.rotation as number)) return null
    if (page.reason !== undefined && (typeof page.reason !== 'string' || page.reason.length > 120)) return null
    pages.push({
      page: page.page as number,
      source: page.source as PageTextSource,
      status: page.status as PageTextStatus,
      text: page.text,
      ...(page.confidence !== undefined ? { confidence: page.confidence as number } : {}),
      ...(page.rotation !== undefined ? { rotation: page.rotation as PageTextPage['rotation'] } : {}),
      ...(page.reason !== undefined ? { reason: page.reason as string } : {}),
    })
  }
  pages.sort((left, right) => left.page - right.page)
  return {
    format: PAGE_TEXT_FORMAT,
    path: record.path,
    size: record.size as number,
    stamp: record.stamp,
    pageCount: record.pageCount as number,
    producer: record.producer,
    ...(record.ocrEngine !== undefined ? { ocrEngine: record.ocrEngine as string } : {}),
    createdAt: record.createdAt,
    pages,
  }
}

/** A record is usable only for the same path and exactly the same bytes. */
export const pageTextRecordMatches = (record: PageTextRecord | null, document: { path: string; size: number; stamp: string }) => Boolean(
  record && record.path === document.path && record.size === document.size && record.stamp === document.stamp,
)

/** Builds a record, trimming page text to the limits instead of rejecting it. */
export const buildPageTextRecord = (input: {
  path: string
  size: number
  stamp: string
  pageCount: number
  producer: string
  ocrEngine?: string
  pages: PageTextPage[]
  now?: Date
}): PageTextRecord | null => {
  const pages = [...input.pages]
    .filter((page) => page.page >= 1 && page.page <= input.pageCount)
    .sort((left, right) => left.page - right.page)
    .slice(0, PAGE_TEXT_MAX_PAGES)
    .map((page) => ({ ...page, text: page.text.slice(0, PAGE_TEXT_MAX_PAGE_CHARS) }))
  const record = sanitizePageTextRecord({
    format: PAGE_TEXT_FORMAT,
    path: input.path,
    size: input.size,
    stamp: input.stamp,
    pageCount: input.pageCount,
    producer: input.producer.slice(0, 200),
    ...(input.ocrEngine ? { ocrEngine: input.ocrEngine.slice(0, 100) } : {}),
    createdAt: (input.now ?? new Date()).toISOString(),
    pages,
  })
  if (!record) return null
  return new TextEncoder().encode(JSON.stringify(record)).length <= PAGE_TEXT_MAX_BYTES ? record : null
}
