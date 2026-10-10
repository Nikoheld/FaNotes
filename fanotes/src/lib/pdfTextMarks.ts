/** Highlights anchored to a PDF text quote and page, stored in the note. */

export const PDF_MARKS_START = '<!-- fanotes-pdf-marks-v1'
export const PDF_MARKS_END = '-->'

export type PdfTextMark = {
  id: string
  page: number
  quote: string
  kind: 'highlight' | 'underline'
}

const QUOTE_MAX = 400

const cleanQuote = (value: string) => value.replace(/\s+/gu, ' ').trim().slice(0, QUOTE_MAX)

export const readPdfMarks = (markdown: string): PdfTextMark[] => {
  const start = markdown.indexOf(PDF_MARKS_START)
  if (start < 0) return []
  const end = markdown.indexOf(PDF_MARKS_END, start + PDF_MARKS_START.length)
  if (end < 0) return []
  try {
    const parsed = JSON.parse(markdown.slice(start + PDF_MARKS_START.length, end)) as { marks?: unknown }
    if (!Array.isArray(parsed.marks)) return []
    return parsed.marks.flatMap((entry) => {
      if (!entry || typeof entry !== 'object') return []
      const mark = entry as Partial<PdfTextMark>
      const quote = typeof mark.quote === 'string' ? cleanQuote(mark.quote) : ''
      const page = Number(mark.page)
      if (!quote || !Number.isInteger(page) || page < 1 || page > 5_000) return []
      return [{
        id: typeof mark.id === 'string' && mark.id.length < 80 ? mark.id : `mark-${page}-${quote.slice(0, 12)}`,
        page,
        quote,
        kind: mark.kind === 'underline' ? 'underline' as const : 'highlight' as const,
      }]
    }).slice(0, 200)
  } catch {
    return []
  }
}

export const writePdfMarks = (markdown: string, marks: readonly PdfTextMark[]) => {
  const start = markdown.indexOf(PDF_MARKS_START)
  const end = start >= 0 ? markdown.indexOf(PDF_MARKS_END, start) : -1
  const without = start >= 0 && end >= 0
    ? `${markdown.slice(0, start)}${markdown.slice(end + PDF_MARKS_END.length)}`
    : markdown
  const payload = {
    marks: marks.map((mark) => ({
      id: mark.id,
      page: mark.page,
      quote: cleanQuote(mark.quote),
      kind: mark.kind,
    })).filter((mark) => mark.quote),
  }
  if (!payload.marks.length) return without.replace(/\n{3,}/gu, '\n\n')
  const block = `\n${PDF_MARKS_START}\n${JSON.stringify(payload, null, 2)}\n${PDF_MARKS_END}\n`
  return `${without.replace(/\s*$/u, '')}${block}`
}

export const addPdfMark = (
  marks: readonly PdfTextMark[],
  input: { page: number; quote: string; kind?: PdfTextMark['kind'] },
): PdfTextMark[] => {
  const quote = cleanQuote(input.quote)
  if (!quote || input.page < 1) return [...marks]
  if (marks.some((mark) => mark.page === input.page && mark.quote === quote)) return [...marks]
  return [...marks, {
    id: `mark-${Date.now().toString(36)}`,
    page: input.page,
    quote,
    kind: input.kind ?? 'highlight',
  }].slice(-200)
}

/** Quotes on a page, used to paint the text layer and to keep search working. */
export const quotesOnPage = (marks: readonly PdfTextMark[], page: number) => (
  marks.filter((mark) => mark.page === page).map((mark) => mark.quote)
)
