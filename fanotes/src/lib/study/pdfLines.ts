/** Reads a vault PDF's text layer as lines per page (the search extractor flattens line breaks). */

import { loadVaultPdfBytes, openPdfDocument } from '../pdfDocument'
import type { PageLines } from './tasks'

type TextItem = { str?: unknown; hasEOL?: unknown; transform?: unknown }

/** Groups text items into lines using the end-of-line flag, falling back to vertical movement. */
export const itemsToLines = (items: readonly unknown[]): string[] => {
  const lines: string[] = []
  let current = ''
  let lastY: number | null = null
  const flush = () => {
    const line = current.replace(/\s+/gu, ' ').trim()
    if (line) lines.push(line)
    current = ''
  }
  for (const raw of items) {
    if (!raw || typeof raw !== 'object') continue
    const item = raw as TextItem
    if (typeof item.str !== 'string') continue
    const y = Array.isArray(item.transform) && typeof item.transform[5] === 'number' ? item.transform[5] : null
    if (lastY !== null && y !== null && Math.abs(y - lastY) > 3 && current) flush()
    current += item.str
    if (y !== null) lastY = y
    if (item.hasEOL === true) flush()
  }
  flush()
  return lines
}

export const MAX_TASK_SCAN_PAGES = 120

export const readPdfPageLines = async (relativePath: string): Promise<PageLines[]> => {
  const bytes = await loadVaultPdfBytes(relativePath)
  const { pdf, task } = await openPdfDocument(bytes)
  try {
    const pages: PageLines[] = []
    for (let page = 1; page <= Math.min(pdf.numPages, MAX_TASK_SCAN_PAGES); page += 1) {
      try {
        const pdfPage = await pdf.getPage(page)
        const content = await pdfPage.getTextContent({ includeMarkedContent: false, disableNormalization: false })
        pages.push({ page, lines: itemsToLines(content.items) })
        pdfPage.cleanup?.()
      } catch {
        pages.push({ page, lines: [] })
      }
    }
    return pages
  } finally {
    await task.destroy().catch(() => undefined)
  }
}
