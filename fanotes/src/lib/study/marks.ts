/** Summary of the highlights the user made on a PDF, grouped by page. */

import type { PdfTextMark } from '../pdfTextMarks'

export type MarkPage = { page: number; marks: PdfTextMark[] }

export const groupMarksByPage = (marks: readonly PdfTextMark[]): MarkPage[] => {
  const pages = new Map<number, PdfTextMark[]>()
  for (const mark of marks) pages.set(mark.page, [...(pages.get(mark.page) ?? []), mark])
  return [...pages.entries()].sort((a, b) => a[0] - b[0]).map(([page, list]) => ({ page, marks: list }))
}

/** Marks as a Markdown note: one heading per page, one quote per highlight. */
export const marksToMarkdown = (title: string, marks: readonly PdfTextMark[]): string => {
  const out = [`# Markierungen: ${title}`, '']
  for (const group of groupMarksByPage(marks)) {
    out.push(`## Seite ${group.page}`, '')
    for (const mark of group.marks) out.push(`- ${mark.kind === 'underline' ? '__' : '=='}${mark.quote}${mark.kind === 'underline' ? '__' : '=='} (S. ${mark.page})`)
    out.push('')
  }
  return `${out.join('\n').trim()}\n`
}
