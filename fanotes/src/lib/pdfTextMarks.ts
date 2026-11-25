/** Highlights anchored to a PDF text quote and page, stored in the note. */

import { locateEmbeddedJsonComment } from './embeddedJsonComment'

export const PDF_MARKS_START = '<!-- fanotes-pdf-marks-v1'
export const PDF_MARKS_END = '-->'

export type PdfTextMark = {
  id: string
  page: number
  quote: string
  kind: 'highlight' | 'underline'
  /**
   * Only this occurrence of the quote on the page (0-based, counted at every
   * start). Absent: every occurrence, as marks were stored before. Erasing
   * part of a highlight writes the remaining parts with it, so a remnant does
   * not light up the same words elsewhere on the page.
   */
  nth?: number
}

/** A quote as the text layer paints it. */
export type PdfQuoteRef = { quote: string; nth?: number }

const QUOTE_MAX = 400

const cleanQuote = (value: string) => value.replace(/\s+/gu, ' ').trim().slice(0, QUOTE_MAX)

export const readPdfMarks = (markdown: string): PdfTextMark[] => {
  const block = locateEmbeddedJsonComment(markdown, PDF_MARKS_START)
  if (!block) return []
  try {
    const parsed = JSON.parse(markdown.slice(block.jsonStart, block.jsonEnd)) as { marks?: unknown }
    if (!Array.isArray(parsed.marks)) return []
    return parsed.marks.flatMap((entry) => {
      if (!entry || typeof entry !== 'object') return []
      const mark = entry as Partial<PdfTextMark>
      const quote = typeof mark.quote === 'string' ? cleanQuote(mark.quote) : ''
      const page = Number(mark.page)
      if (!quote || !Number.isInteger(page) || page < 1 || page > 5_000) return []
      const nth = Number(mark.nth)
      return [{
        id: typeof mark.id === 'string' && mark.id.length < 80 ? mark.id : `mark-${page}-${quote.slice(0, 12)}`,
        page,
        quote,
        kind: mark.kind === 'underline' ? 'underline' as const : 'highlight' as const,
        ...(mark.nth !== undefined && Number.isInteger(nth) && nth >= 0 && nth < 100_000 ? { nth } : {}),
      }]
    }).slice(0, 200)
  } catch {
    return []
  }
}

export const writePdfMarks = (markdown: string, marks: readonly PdfTextMark[]) => {
  const existing = locateEmbeddedJsonComment(markdown, PDF_MARKS_START)
  const without = existing
    ? `${markdown.slice(0, existing.start)}${markdown.slice(existing.end)}`
    : markdown
  const payload = {
    marks: marks.map((mark) => ({
      id: mark.id,
      page: mark.page,
      quote: cleanQuote(mark.quote),
      kind: mark.kind,
      ...(mark.nth !== undefined ? { nth: mark.nth } : {}),
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
  if (marks.some((mark) => mark.page === input.page && mark.quote === quote && mark.nth === undefined)) return [...marks]
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

/** Page text as the text layer joins it, and the leaf span of every character (-1: the joining space). */
const pageTextIndex = (spanTexts: readonly string[]) => {
  const spanAt: number[] = []
  /** UTF-16 offset of every character inside its span's raw text (-1: the joining space). */
  const rawAt: number[] = []
  let norm = ''
  spanTexts.forEach((raw, index) => {
    const text = raw.replace(/\s+/gu, ' ').trim()
    if (!text) return
    if (norm && !norm.endsWith(' ')) {
      norm += ' '
      spanAt.push(-1)
      rawAt.push(-1)
    }
    // Walk the raw text along the collapsed text to find each character's offset.
    let offset = raw.search(/\S/u)
    let previousSpace = false
    for (const char of text) {
      if (char === ' ' && !previousSpace && /\s/u.test(raw[offset] ?? '')) {
        // A collapsed whitespace run counts as one character.
        norm += char
        spanAt.push(index)
        rawAt.push(offset)
        while (offset < raw.length && /\s/u.test(raw[offset])) offset += 1
        previousSpace = true
        continue
      }
      previousSpace = false
      norm += char
      spanAt.push(index)
      rawAt.push(offset)
      offset += char.length
    }
  })
  return { norm, spanAt, rawAt }
}

const quoteRef = (quote: string | PdfQuoteRef): PdfQuoteRef => (typeof quote === 'string' ? { quote } : quote)

/** Every start of `needle` in `norm`, overlapping ones included. */
const quoteStarts = (norm: string, needle: string) => {
  const starts: number[] = []
  let at = norm.indexOf(needle)
  while (at >= 0) {
    starts.push(at)
    at = norm.indexOf(needle, at + 1)
  }
  return starts
}

/** Starts a mark paints: its one occurrence, or every non-overlapping one. */
const paintedStarts = (norm: string, ref: PdfQuoteRef) => {
  const needle = ref.quote.replace(/\s+/gu, ' ').trim()
  if (needle.length < 2) return { needle, starts: [] as number[] }
  if (ref.nth !== undefined) {
    const at = quoteStarts(norm, needle)[ref.nth]
    return { needle, starts: at === undefined ? [] : [at] }
  }
  const starts: number[] = []
  let from = 0
  while (from < norm.length) {
    const at = norm.indexOf(needle, from)
    if (at < 0) break
    starts.push(at)
    from = at + needle.length
  }
  return { needle, starts }
}

/**
 * Spans that cover a stored quote. The quote marks that passage.
 * A shorter span is not marked just because its text also occurs inside the quote.
 */
export const spanIndexesForQuotes = (spanTexts: readonly string[], quotes: ReadonlyArray<string | PdfQuoteRef>): number[] => {
  const { norm, spanAt } = pageTextIndex(spanTexts)
  const hit = new Set<number>()
  for (const quote of quotes) {
    const { needle, starts } = paintedStarts(norm, quoteRef(quote))
    for (const at of starts) {
      for (let cursor = at; cursor < at + needle.length; cursor += 1) {
        const span = spanAt[cursor]
        if (span >= 0) hit.add(span)
      }
    }
  }
  return [...hit].sort((left, right) => left - right)
}

/**
 * Where a quote covers each span: raw character range [from, to) per span
 * index. A span the quote only touches at one end gets a partial range, so the
 * text layer can paint just the selected words instead of the whole line.
 */
export const spanRangesForQuotes = (
  spanTexts: readonly string[],
  quotes: ReadonlyArray<string | PdfQuoteRef>,
): Map<number, { from: number; to: number }> => {
  const { norm, spanAt, rawAt } = pageTextIndex(spanTexts)
  const ranges = new Map<number, { from: number; to: number }>()
  for (const quote of quotes) {
    const { needle, starts } = paintedStarts(norm, quoteRef(quote))
    for (const at of starts) {
      for (let cursor = at; cursor < at + needle.length; cursor += 1) {
        const span = spanAt[cursor]
        if (span < 0) continue
        const from = rawAt[cursor]
        const to = from + (norm[cursor] === ' ' ? 1 : (String.fromCodePoint(norm.codePointAt(cursor) ?? 32).length))
        const known = ranges.get(span)
        if (!known) ranges.set(span, { from, to })
        else ranges.set(span, { from: Math.min(known.from, from), to: Math.max(known.to, to) })
      }
    }
  }
  return ranges
}

let pieceSerial = 0
const pieceId = () => {
  pieceSerial = (pieceSerial + 1) % 1_000_000
  return `mark-${Date.now().toString(36)}-${pieceSerial.toString(36)}`
}

/**
 * Takes the highlight off the leaf spans `erasedSpans` of `page` and nothing
 * else. A mark that only partly lies on them keeps the rest of its passage,
 * pinned to that occurrence. Returns `marks` itself when no mark lay on them.
 */
export const unmarkPdfSpans = (
  marks: readonly PdfTextMark[],
  page: number,
  spanTexts: readonly string[],
  erasedSpans: Iterable<number>,
): readonly PdfTextMark[] => {
  const erased = new Set(erasedSpans)
  if (!erased.size || !marks.some((mark) => mark.page === page)) return marks
  const { norm, spanAt } = pageTextIndex(spanTexts)
  let changed = false
  const next: PdfTextMark[] = []
  for (const mark of marks) {
    if (mark.page !== page) {
      next.push(mark)
      continue
    }
    const { needle, starts } = paintedStarts(norm, mark)
    const touched = (at: number) => {
      for (let cursor = at; cursor < at + needle.length; cursor += 1) {
        if (erased.has(spanAt[cursor])) return true
      }
      return false
    }
    if (!starts.some(touched)) {
      next.push(mark)
      continue
    }
    changed = true
    const keep = (start: number, end: number) => {
      while (start < end && norm[start] === ' ') start += 1
      while (end > start && norm[end - 1] === ' ') end -= 1
      const quote = norm.slice(start, end)
      if (quote.length < 2) return
      const nth = quoteStarts(norm, quote).indexOf(start)
      if (nth < 0) return
      next.push({ id: pieceId(), page, quote, kind: mark.kind, nth })
    }
    for (const at of starts) {
      if (!touched(at)) {
        // Another occurrence of the same words keeps its highlight.
        keep(at, at + needle.length)
        continue
      }
      let run = -1
      for (let cursor = at; cursor <= at + needle.length; cursor += 1) {
        const gone = cursor === at + needle.length || erased.has(spanAt[cursor])
        if (gone) {
          if (run >= 0) keep(run, cursor)
          run = -1
        } else if (run < 0) {
          run = cursor
        }
      }
    }
  }
  return changed ? next : marks
}
