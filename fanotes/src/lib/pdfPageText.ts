/** Page text for the AI highlighter. The PDF file itself is not rewritten. */

import type { PDFPageProxy } from 'pdfjs-dist'
import { loadVaultPdfBytes, openPdfDocument } from './pdfDocument'
import type { PdfPageText } from './pdfImportantMarks'
import {
  pageNeedsLocalOcr,
  pdfByteStamp,
  pdfOcrCacheUsable,
  pdfPagePlainText,
  sanitizePdfOcrCache,
  PDF_OCR_MIN_TEXT,
  type PdfOcrCache,
} from './pdfOcr'

export const PDF_IMPORTANT_CHAR_BUDGET = 48_000
export const PDF_IMPORTANT_PAGE_BUDGET = 60
const MIN_PAGE_TEXT = PDF_OCR_MIN_TEXT

const storedOcr = async (relativePath: string, bytes: Uint8Array): Promise<PdfOcrCache | null> => {
  const read = window.fanotes.readPdfOcr
  if (typeof read !== 'function') return null
  try {
    const cache = sanitizePdfOcrCache(await read(relativePath))
    return pdfOcrCacheUsable(cache, { size: bytes.byteLength, stamp: pdfByteStamp(bytes) }) ? cache : null
  } catch {
    return null
  }
}

/** Extractable text, capped so a long PDF still fits one model request. */
export const readPdfPageTexts = async (relativePath: string): Promise<{ pages: PdfPageText[]; truncated: boolean }> => {
  const bytes = await loadVaultPdfBytes(relativePath)
  const { pdf, task } = await openPdfDocument(bytes)
  try {
    const cache = await storedOcr(relativePath, bytes)
    const pages: PdfPageText[] = []
    let used = 0
    let truncated = pdf.numPages > PDF_IMPORTANT_PAGE_BUDGET
    const last = Math.min(pdf.numPages, PDF_IMPORTANT_PAGE_BUDGET)
    for (let page = 1; page <= last; page += 1) {
      let pdfPage: PDFPageProxy | null = null
      try {
        pdfPage = await pdf.getPage(page)
        const content = await pdfPage.getTextContent({ includeMarkedContent: true, disableNormalization: true })
        const extracted = pdfPagePlainText(content.items)
        const recognized = cache?.pages.find((entry) => entry.page === page)?.text ?? ''
        const text = pageNeedsLocalOcr(extracted) && !pageNeedsLocalOcr(recognized) ? recognized : extracted
        if (!text) continue
        if (used >= PDF_IMPORTANT_CHAR_BUDGET) {
          truncated = true
          break
        }
        const room = PDF_IMPORTANT_CHAR_BUDGET - used
        if (text.length > room) {
          if (room >= MIN_PAGE_TEXT) pages.push({ page, text: text.slice(0, room) })
          truncated = true
          break
        }
        pages.push({ page, text })
        used += text.length
      } catch {
        // A damaged page is skipped. The other pages can still be marked.
      } finally {
        pdfPage?.cleanup?.()
      }
    }
    const readable = pages.reduce((sum, page) => sum + page.text.length, 0)
    if (readable < MIN_PAGE_TEXT) return { pages: [], truncated: false }
    return { pages, truncated }
  } finally {
    await task.destroy().catch(() => undefined)
  }
}
