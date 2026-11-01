/**
 * Run the bundled local line model over PDF pages that have no extractable text.
 * Pages that already have text are skipped. The PDF bytes are not rewritten.
 */

import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist'
import { enqueuePdfRender } from './pdfDocument'
import {
  PDF_OCR_MAX_PAGE_CHARS,
  pdfOcrCacheUsable,
  pdfPagePlainText,
  pdfPagesNeedingOcr,
  sanitizePdfOcrCache,
  segmentPdfOcrLines,
  type PdfOcrPageRecord,
} from './pdfOcr'

const OCR_TARGET_WIDTH = 1400
const OCR_MAX_PIXELS = 4_000_000

export type PdfOcrSignal = { cancelled: () => boolean }

export const renderPdfPageForOcr = async (page: PDFPageProxy) => {
  const base = page.getViewport({ scale: 1 })
  let scale = Math.min(2.4, OCR_TARGET_WIDTH / Math.max(1, base.width))
  let viewport = page.getViewport({ scale })
  let width = Math.max(1, Math.round(viewport.width))
  let height = Math.max(1, Math.round(viewport.height))
  if (width * height > OCR_MAX_PIXELS) {
    scale *= Math.sqrt(OCR_MAX_PIXELS / (width * height))
    viewport = page.getViewport({ scale })
    width = Math.max(1, Math.round(viewport.width))
    height = Math.max(1, Math.round(viewport.height))
  }
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d', { alpha: false, willReadFrequently: true })
  if (!context) return null
  context.fillStyle = '#ffffff'
  context.fillRect(0, 0, width, height)
  await page.render({ canvas, canvasContext: context, viewport, intent: 'print' }).promise
  const image = context.getImageData(0, 0, width, height)
  return { pixels: image.data, width, height }
}

export const transcribePdfOcrBitmap = async (
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  recognize: (pixels: Uint8ClampedArray, width: number, height: number) => Promise<string>,
) => {
  const parts: string[] = []
  for (const line of segmentPdfOcrLines(pixels, width, height)) {
    const text = (await recognize(line.pixels, line.width, line.height)).replace(/\s+/gu, ' ').trim()
    if (text) parts.push(text.slice(0, 500))
  }
  return parts.join('\n').slice(0, PDF_OCR_MAX_PAGE_CHARS)
}

const recognizeLocalLine = async (pixels: Uint8ClampedArray, width: number, height: number) => {
  const { recognizeTrocrLine } = await import('./trocrClient')
  return recognizeTrocrLine(pixels, width, height)
}

/**
 * Recognize pages that fail the text-layer test and remember the transcript
 * for this file size and byte stamp. A later open of the same bytes does not
 * run the model again.
 */
export const runLocalPdfOcr = async (input: {
  path: string
  pdf: PDFDocumentProxy
  size: number
  stamp: string
  signal: PdfOcrSignal
  onPages: (pages: ReadonlyMap<number, string>) => void
  onState?: (running: boolean) => void
}) => {
  const collected: Array<{ page: number; text: string }> = []
  const last = Math.min(input.pdf.numPages, 2000)
  for (let page = 1; page <= last; page += 1) {
    if (input.signal.cancelled()) return new Map<number, string>()
    let pdfPage: PDFPageProxy | null = null
    try {
      pdfPage = await input.pdf.getPage(page)
      const content = await pdfPage.getTextContent({ includeMarkedContent: true, disableNormalization: true })
      collected.push({ page, text: pdfPagePlainText(content.items) })
    } catch {
      collected.push({ page, text: '' })
    } finally {
      pdfPage?.cleanup?.()
    }
  }
  const needed = pdfPagesNeedingOcr(collected)
  if (input.signal.cancelled() || needed.length === 0) return new Map<number, string>()

  let known = new Map<number, string>()
  try {
    const read = window.fanotes.readPdfOcr
    const loaded = typeof read === 'function' ? sanitizePdfOcrCache(await read(input.path)) : null
    if (pdfOcrCacheUsable(loaded, { size: input.size, stamp: input.stamp })) {
      known = new Map(loaded!.pages.map((page) => [page.page, page.text]))
    }
  } catch {
    known = new Map()
  }
  input.onPages(known)
  const missing = needed.filter((page) => !known.has(page))
  if (missing.length === 0 || input.signal.cancelled()) return known
  input.onState?.(true)

  let added = false
  for (const pageNumber of missing) {
    if (input.signal.cancelled()) break
    let bitmap: Awaited<ReturnType<typeof renderPdfPageForOcr>> = null
    try {
      bitmap = await enqueuePdfRender(async () => {
        const pdfPage = await input.pdf.getPage(pageNumber)
        try {
          return await renderPdfPageForOcr(pdfPage)
        } finally {
          pdfPage.cleanup?.()
        }
      })
    } catch {
      known.set(pageNumber, '')
      added = true
      continue
    }
    if (input.signal.cancelled()) break
    if (!bitmap) {
      known.set(pageNumber, '')
      added = true
      continue
    }
    try {
      const text = await transcribePdfOcrBitmap(bitmap.pixels, bitmap.width, bitmap.height, recognizeLocalLine)
      if (input.signal.cancelled()) break
      known.set(pageNumber, text)
      added = true
      input.onPages(new Map(known))
    } catch {
      // The local model is unavailable. Pages already read stay cached; this page is tried again later.
      break
    }
  }
  input.onState?.(false)

  if (added && known.size > 0) {
    const pages: PdfOcrPageRecord[] = [...known.entries()]
      .sort((left, right) => left[0] - right[0])
      .map(([page, text]) => ({ page, text }))
    try {
      await window.fanotes.writePdfOcr?.({
        path: input.path,
        size: input.size,
        stamp: input.stamp,
        pages,
      })
    } catch {
      // Search can still use the transcript for this open.
    }
  }
  return known
}
