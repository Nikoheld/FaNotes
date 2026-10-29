/** Page text for the AI highlighter. The PDF file itself is not rewritten. */

import type { PDFPageProxy } from 'pdfjs-dist'
import { loadVaultPdfBytes, openPdfDocument } from './pdfDocument'
import type { PdfPageText } from './pdfImportantMarks'

export const PDF_IMPORTANT_CHAR_BUDGET = 48_000
export const PDF_IMPORTANT_PAGE_BUDGET = 60
const MIN_PAGE_TEXT = 20

const pageText = (items: readonly unknown[]) => items
  .map((item) => item && typeof item === 'object' && 'str' in item && typeof item.str === 'string' ? item.str : '')
  .join(' ')
  .replace(/\s+/gu, ' ')
  .trim()

/** Extractable text, capped so a long PDF still fits one model request. */
export const readPdfPageTexts = async (relativePath: string): Promise<{ pages: PdfPageText[]; truncated: boolean }> => {
  const bytes = await loadVaultPdfBytes(relativePath)
  const { pdf, task } = await openPdfDocument(bytes)
  try {
    const pages: PdfPageText[] = []
    let used = 0
    let truncated = pdf.numPages > PDF_IMPORTANT_PAGE_BUDGET
    const last = Math.min(pdf.numPages, PDF_IMPORTANT_PAGE_BUDGET)
    for (let page = 1; page <= last; page += 1) {
      let pdfPage: PDFPageProxy | null = null
      try {
        pdfPage = await pdf.getPage(page)
        const content = await pdfPage.getTextContent({ includeMarkedContent: true, disableNormalization: true })
        const text = pageText(content.items)
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
