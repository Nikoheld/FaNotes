import { parseNoteOutline } from './noteOutline'

/**
 * Ink sections and Markdown headings share an order: the first handwriting
 * section folds the first heading, the second folds the second, and so on.
 */
export const headingLineForSection = (markdown: string, sectionIndex: number): number | null => {
  if (!Number.isInteger(sectionIndex) || sectionIndex < 0) return null
  const headings = parseNoteOutline(markdown)
  return headings[sectionIndex]?.line ?? null
}

export const sectionIndexForHeading = (markdown: string, line: number): number => {
  const headings = parseNoteOutline(markdown)
  return headings.findIndex((heading) => heading.line === line)
}
