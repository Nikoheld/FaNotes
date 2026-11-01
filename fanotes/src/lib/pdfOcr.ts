/**
 * Decide which PDF pages still need a local model, and turn a page bitmap
 * into line images that model can read. The PDF file itself is not rewritten.
 */

export const PDF_OCR_FORMAT = 'fanotes-pdf-ocr-v1' as const
/** Same bar the AI highlighter uses before it treats a page as text. */
export const PDF_OCR_MIN_TEXT = 20
export const PDF_OCR_MAX_PAGES = 60
export const PDF_OCR_MAX_PAGE_CHARS = 6_000
export const PDF_OCR_MAX_LINES = 40
const MAX_PDF_BYTES = 96 * 1024 * 1024
const MAX_TOTAL_CHARS = PDF_OCR_MAX_PAGES * PDF_OCR_MAX_PAGE_CHARS
const STAMP_PATTERN = /^[a-f0-9]{8}$/u

export type PdfOcrPageRecord = { page: number; text: string }

export type PdfOcrCache = {
  format: typeof PDF_OCR_FORMAT
  path: string
  size: number
  mtimeMs: number
  stamp: string
  pages: PdfOcrPageRecord[]
}

export type PdfOcrWrite = {
  path: string
  size: number
  stamp: string
  pages: PdfOcrPageRecord[]
}

export type PdfOcrLine = {
  pixels: Uint8ClampedArray
  width: number
  height: number
}

export type PdfTextSearchHit = {
  page: number
  index: number
  excerpt: string
}

export const collapsedPdfText = (text: string) => text.replace(/\s+/gu, ' ').trim()

export const pdfPagePlainText = (items: readonly unknown[]) => collapsedPdfText(items.map((item) => (
  item && typeof item === 'object' && 'str' in item && typeof item.str === 'string' ? item.str : ''
)).join(' '))

/** A page already has OCR text when its extracted letters are long enough to search. */
export const pageNeedsLocalOcr = (text: string) => collapsedPdfText(text).length < PDF_OCR_MIN_TEXT

/** Pages whose extracted text is below the bar, capped so one open cannot queue the whole library. */
export const pdfPagesNeedingOcr = (pages: readonly { page: number; text: string }[]) => {
  const needed: number[] = []
  for (const page of pages) {
    if (!Number.isInteger(page.page) || page.page < 1 || page.page > 2000) continue
    if (!pageNeedsLocalOcr(page.text)) continue
    needed.push(page.page)
    if (needed.length >= PDF_OCR_MAX_PAGES) break
  }
  return needed
}

/** Sampled fingerprint of the bytes that were recognized. Web vaults have no file mtime. */
export const pdfByteStamp = (bytes: Uint8Array) => {
  let hash = 0x811c9dc5
  const mix = (value: number) => {
    hash ^= value & 0xff
    hash = Math.imul(hash, 0x01000193)
  }
  const length = bytes.length >>> 0
  mix(length)
  mix(length >>> 8)
  mix(length >>> 16)
  mix(length >>> 24)
  const step = Math.max(1, Math.floor(length / 4096))
  for (let index = 0; index < length; index += step) mix(bytes[index] ?? 0)
  if (length > 0) mix(bytes[length - 1] ?? 0)
  return (hash >>> 0).toString(16).padStart(8, '0')
}

export const sanitizePdfOcrPages = (value: unknown): PdfOcrPageRecord[] | null => {
  if (!Array.isArray(value) || value.length > PDF_OCR_MAX_PAGES) return null
  const pages: PdfOcrPageRecord[] = []
  const seen = new Set<number>()
  let total = 0
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') return null
    const page = (entry as { page?: unknown }).page
    const text = (entry as { text?: unknown }).text
    if (!Number.isInteger(page) || (page as number) < 1 || (page as number) > 2000) return null
    if (typeof text !== 'string' || text.length > PDF_OCR_MAX_PAGE_CHARS) return null
    if (seen.has(page as number)) return null
    seen.add(page as number)
    total += text.length
    if (total > MAX_TOTAL_CHARS) return null
    pages.push({ page: page as number, text })
  }
  return pages
}

export const sanitizePdfOcrCache = (value: unknown): PdfOcrCache | null => {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  if (record.format !== PDF_OCR_FORMAT) return null
  if (typeof record.path !== 'string' || record.path.length < 1 || record.path.length > 4096) return null
  if (record.path.includes('\0') || record.path.split('/').some((segment) => !segment || segment === '.' || segment === '..')) return null
  if (!Number.isSafeInteger(record.size) || (record.size as number) < 1 || (record.size as number) > MAX_PDF_BYTES) return null
  if (!Number.isSafeInteger(record.mtimeMs) || (record.mtimeMs as number) < 0) return null
  if (typeof record.stamp !== 'string' || !STAMP_PATTERN.test(record.stamp)) return null
  const pages = sanitizePdfOcrPages(record.pages)
  if (!pages) return null
  return {
    format: PDF_OCR_FORMAT,
    path: record.path,
    size: record.size as number,
    mtimeMs: record.mtimeMs as number,
    stamp: record.stamp,
    pages,
  }
}

/** The host already checked the path. The bytes must still be the ones that were read. */
export const pdfOcrCacheUsable = (
  cache: PdfOcrCache | null,
  input: { size: number; stamp: string },
) => Boolean(cache && cache.size === input.size && cache.stamp === input.stamp)

export const pdfTextSearchHits = (
  page: number,
  text: string,
  needle: string,
  limit: number,
): PdfTextSearchHit[] => {
  const query = needle.trim()
  if (!query || limit < 1) return []
  const lower = query.toLocaleLowerCase('de-DE')
  const haystack = text.toLocaleLowerCase('de-DE')
  const hits: PdfTextSearchHit[] = []
  let cursor = 0
  let local = 0
  while (cursor < haystack.length && hits.length < limit) {
    const index = haystack.indexOf(lower, cursor)
    if (index < 0) break
    hits.push({
      page,
      index: local,
      excerpt: text.slice(Math.max(0, index - 28), Math.min(text.length, index + query.length + 42)).replace(/\s+/gu, ' ').trim(),
    })
    local += 1
    cursor = index + Math.max(query.length, 1)
  }
  return hits
}

const luminanceOf = (pixels: Uint8ClampedArray, index: number) => (
  (pixels[index] * 54 + pixels[index + 1] * 183 + pixels[index + 2] * 19) >> 8
)

const medianLuminance = (pixels: Uint8ClampedArray, width: number, height: number) => {
  const samples: number[] = []
  const stepX = Math.max(1, Math.floor(width / 24))
  const stepY = Math.max(1, Math.floor(height / 24))
  for (let y = 0; y < height; y += stepY) {
    for (let x = 0; x < width; x += stepX) samples.push(luminanceOf(pixels, (y * width + x) * 4))
  }
  samples.sort((left, right) => left - right)
  return samples[Math.floor(samples.length / 2)] ?? 255
}

const cropOcrLine = (
  pixels: Uint8ClampedArray,
  width: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): PdfOcrLine | null => {
  const cropW = x1 - x0
  const cropH = y1 - y0
  if (cropW < 8 || cropH < 4) return null
  let scale = 1
  if (cropH > 128) scale = Math.min(scale, 128 / cropH)
  if (cropW > 2048) scale = Math.min(scale, 2048 / cropW)
  const drawnW = Math.max(1, Math.min(2048, Math.round(cropW * scale)))
  const drawnH = Math.max(1, Math.min(128, Math.round(cropH * scale)))
  const outW = Math.max(8, drawnW)
  const outH = Math.max(8, drawnH)
  if (outW > 4096 || outH > 1024) return null
  const out = new Uint8ClampedArray(outW * outH * 4)
  out.fill(255)
  const offsetX = Math.floor((outW - drawnW) / 2)
  const offsetY = Math.floor((outH - drawnH) / 2)
  for (let y = 0; y < drawnH; y += 1) {
    const srcY = Math.min(cropH - 1, Math.floor((y * cropH) / drawnH))
    for (let x = 0; x < drawnW; x += 1) {
      const srcX = Math.min(cropW - 1, Math.floor((x * cropW) / drawnW))
      const src = ((y0 + srcY) * width + (x0 + srcX)) * 4
      const dst = ((offsetY + y) * outW + (offsetX + x)) * 4
      out[dst] = pixels[src] ?? 255
      out[dst + 1] = pixels[src + 1] ?? 255
      out[dst + 2] = pixels[src + 2] ?? 255
      out[dst + 3] = 255
    }
  }
  return { pixels: out, width: outW, height: outH }
}

/**
 * Horizontal ink bands on a page bitmap. A solid picture is not a line of text
 * and is left out. Each band is cropped to the ink and kept inside the local
 * line model's size limits.
 */
export const segmentPdfOcrLines = (
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
): PdfOcrLine[] => {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height)) return []
  if (width < 8 || height < 8 || width > 8192 || height > 8192) return []
  if (pixels.length !== width * height * 4) return []
  const paper = medianLuminance(pixels, width, height)
  const darkPaper = paper < 110
  const isInk = (lum: number) => (darkPaper ? lum > paper + 50 : lum < paper - 50)
  const rowInk = new Uint32Array(height)
  for (let y = 0; y < height; y += 1) {
    let ink = 0
    const row = y * width * 4
    for (let x = 0; x < width; x += 1) {
      if (isInk(luminanceOf(pixels, row + x * 4))) ink += 1
    }
    rowInk[y] = ink
  }
  const minInk = Math.max(6, Math.floor(width * 0.008))
  const bands: Array<{ top: number; bottom: number }> = []
  let start = -1
  let lastInk = -1
  const close = (bottom: number) => {
    if (start >= 0 && bottom - start >= 6) bands.push({ top: start, bottom })
    start = -1
    lastInk = -1
  }
  for (let y = 0; y < height; y += 1) {
    if ((rowInk[y] ?? 0) >= minInk) {
      if (start < 0) start = y
      lastInk = y
    } else if (start >= 0 && y - lastInk > 2) close(lastInk + 1)
  }
  if (start >= 0) close(lastInk + 1)

  const lines: PdfOcrLine[] = []
  for (const band of bands) {
    const bandHeight = band.bottom - band.top
    // A solid picture is one tall band. A line of text is not.
    if (bandHeight > 160) continue
    let left = width
    let right = 0
    for (let y = band.top; y < band.bottom; y += 1) {
      const row = y * width * 4
      for (let x = 0; x < width; x += 1) {
        if (!isInk(luminanceOf(pixels, row + x * 4))) continue
        if (x < left) left = x
        if (x > right) right = x
      }
    }
    if (right <= left) continue
    const line = cropOcrLine(
      pixels,
      width,
      Math.max(0, left - 6),
      Math.max(0, band.top - 3),
      Math.min(width, right + 7),
      Math.min(height, band.bottom + 3),
    )
    if (!line) continue
    lines.push(line)
    if (lines.length >= PDF_OCR_MAX_LINES) break
  }
  return lines
}
