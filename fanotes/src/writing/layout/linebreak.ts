// Breaks one paragraph into lines. Text offsets are UTF-16 offsets into the
// paragraph's text (the concatenated runs), so the editor can map a caret to
// a line and back. Each word or space is a piece with its own x position:
// the page view draws exactly where the layout measured.
import type { Align, FontFamilyId, Marks, ParagraphStyle, Run } from '../model/types'
import { mmToPx, ptToPx, type FontSpec, type Hyphenator, type TextMeasurer } from './measure'

export type ResolvedStyle = {
  font: FontFamilyId
  size: number
  lineHeight: number
  spaceBefore: number
  spaceAfter: number
  indentFirst: number
  indentLeft: number
  indentRight: number
  align: Align
  bold: boolean
  italic: boolean
  smallCaps: boolean
  uppercase: boolean
  color?: string
  keepWithNext: boolean
  pageBreakBefore: boolean
  dropCap: number
  listMarker?: string
}

export const resolveStyle = (style: ParagraphStyle, overrides?: { align?: Align; afterBreak?: boolean }): ResolvedStyle => ({
  font: style.font,
  size: ptToPx(style.size),
  lineHeight: style.lineHeight,
  spaceBefore: ptToPx(style.spaceBefore),
  spaceAfter: ptToPx(style.spaceAfter),
  indentFirst: overrides?.afterBreak && style.indentFirst > 0 ? 0 : mmToPx(style.indentFirst),
  indentLeft: mmToPx(style.indentLeft),
  indentRight: mmToPx(style.indentRight),
  align: overrides?.align ?? style.align,
  bold: Boolean(style.bold),
  italic: Boolean(style.italic),
  smallCaps: Boolean(style.smallCaps),
  uppercase: Boolean(style.uppercase),
  ...(style.color ? { color: style.color } : {}),
  keepWithNext: Boolean(style.keepWithNext),
  pageBreakBefore: Boolean(style.pageBreakBefore),
  dropCap: overrides?.afterBreak ? style.dropCap ?? 0 : 0,
  ...(style.listMarker ? { listMarker: style.listMarker } : {}),
})

export type PieceKind = 'word' | 'space' | 'newline' | 'anchor' | 'marker'

/** A measured piece of a line. `display` is what is drawn (may differ in case or be a footnote number). */
export type Piece = {
  kind: PieceKind
  from: number
  to: number
  text: string
  display: string
  font: FontSpec
  marks?: Marks
  /** Baseline shift in px (positive = up), for superscript and subscript. */
  shift: number
  width: number
  /** x relative to the line start, set when the line is finished. */
  x: number
  /** A hyphen drawn at the end of this piece (line ends inside a word). */
  hyphen?: boolean
}

export type LineBox = {
  from: number
  to: number
  pieces: Piece[]
  /** Offset of the line's start from the content box's left edge. */
  x: number
  /** Width available to the line. */
  available: number
  /** Width the pieces take (after justification). */
  width: number
  height: number
  /** Baseline from the line's top. */
  baseline: number
  /** The line ends the paragraph or a forced line break. */
  last: boolean
}

export type DropCap = { text: string; font: FontSpec; width: number; lines: number; x: number; baseline: number }

export type ParagraphLayout = {
  lines: LineBox[]
  style: ResolvedStyle
  dropCap?: DropCap
  /** Total height of the lines (without space before/after). */
  height: number
  /** Footnote ids referenced, in order, with the line index they sit on. */
  footnotes: Array<{ id: string; line: number }>
  textLength: number
}

export type LayoutInput = {
  runs: Run[]
  style: ResolvedStyle
  /** Width of the page's content box. */
  width: number
  measurer: TextMeasurer
  hyphenator?: Hyphenator | null
  hyphenate?: boolean
  /** Number shown for a footnote reference. */
  footnoteNumber?: (id: string) => string
}

const HYPHEN = '-'
const isSpace = (char: string) => char === ' ' || char === '\t' || char === ' '
const BREAK_AFTER = new Set(['-', '–', '—', '/'])

const upperChar = (char: string) => {
  if (char === 'ß') return 'ẞ'
  const upper = char.toLocaleUpperCase('de-DE')
  return upper.length === char.length ? upper : char
}
const upper = (text: string) => [...text].map(upperChar).join('')

type Fragment = { from: number; to: number; text: string; display: string; font: FontSpec; marks?: Marks; shift: number; anchor?: boolean }

/** Splits runs into fragments that share one font (small caps split by letter case). */
const fragmentsOf = (input: LayoutInput): Fragment[] => {
  const { style } = input
  const out: Fragment[] = []
  let offset = 0
  for (const run of input.runs) {
    const marks = run.m
    const size = (marks?.size ? ptToPx(marks.size) : style.size)
    const scripted = marks?.sup || marks?.sub || marks?.fn
    const font: FontSpec = {
      family: marks?.font ?? style.font,
      bold: Boolean(marks?.b) || style.bold,
      italic: Boolean(marks?.i) !== style.italic,
      size: scripted ? size * 0.65 : size,
    }
    const shift = marks?.sup || marks?.fn ? size * 0.35 : marks?.sub ? -size * 0.15 : 0
    if (marks?.fn && !run.text) {
      const display = input.footnoteNumber?.(marks.fn) ?? '*'
      out.push({ from: offset, to: offset, text: '', display, font, marks, shift, anchor: true })
      continue
    }
    const text = run.text
    const smallCaps = Boolean(marks?.sc) || style.smallCaps
    if (smallCaps) {
      // Lower-case letters are drawn as capitals at 78 %.
      let index = 0
      while (index < text.length) {
        const lower = text[index] !== upperChar(text[index])
        let end = index + 1
        while (end < text.length && (text[end] !== upperChar(text[end])) === lower) end += 1
        const part = text.slice(index, end)
        out.push({ from: offset + index, to: offset + end, text: part, display: upper(part), font: lower ? { ...font, size: font.size * 0.78 } : font, marks, shift })
        index = end
      }
    } else {
      out.push({ from: offset, to: offset + text.length, text, display: style.uppercase ? upper(text) : text, font, marks, shift })
    }
    offset += text.length
  }
  return out
}

type Token = { kind: PieceKind; pieces: Piece[]; width: number; from: number; to: number; breakAfter: boolean }

const pieceOf = (fragment: Fragment, from: number, to: number, kind: PieceKind, measurer: TextMeasurer): Piece => {
  const start = from - fragment.from
  const end = to - fragment.from
  const text = fragment.text.slice(start, end)
  const display = fragment.anchor ? fragment.display : fragment.display.slice(start, end)
  return {
    kind,
    from,
    to,
    text,
    display,
    font: fragment.font,
    ...(fragment.marks ? { marks: fragment.marks } : {}),
    shift: fragment.shift,
    width: kind === 'newline' ? 0 : measurer.width(kind === 'space' ? ' '.repeat(Math.max(1, display.length)) : display, fragment.font),
    x: 0,
  }
}

/** Words, spaces and forced breaks; a word may span several fragments. */
const tokenize = (fragments: Fragment[], measurer: TextMeasurer): Token[] => {
  const tokens: Token[] = []
  let word: Token | null = null
  const closeWord = () => {
    if (word) tokens.push(word)
    word = null
  }
  for (const fragment of fragments) {
    if (fragment.anchor) {
      const piece = pieceOf(fragment, fragment.from, fragment.to, 'anchor', measurer)
      if (!word) word = { kind: 'word', pieces: [], width: 0, from: fragment.from, to: fragment.to, breakAfter: false }
      word.pieces.push(piece)
      word.width += piece.width
      continue
    }
    let index = 0
    const text = fragment.text
    while (index < text.length) {
      const char = text[index]
      if (char === '\n') {
        closeWord()
        tokens.push({ kind: 'newline', pieces: [pieceOf(fragment, fragment.from + index, fragment.from + index + 1, 'newline', measurer)], width: 0, from: fragment.from + index, to: fragment.from + index + 1, breakAfter: true })
        index += 1
        continue
      }
      if (isSpace(char) && char !== ' ') {
        closeWord()
        let end = index + 1
        while (end < text.length && isSpace(text[end]) && text[end] !== ' ') end += 1
        const piece = pieceOf(fragment, fragment.from + index, fragment.from + end, 'space', measurer)
        tokens.push({ kind: 'space', pieces: [piece], width: piece.width, from: piece.from, to: piece.to, breakAfter: true })
        index = end
        continue
      }
      let end = index
      while (end < text.length && text[end] !== '\n' && !(isSpace(text[end]) && text[end] !== ' ')) {
        end += 1
        if (BREAK_AFTER.has(text[end - 1]) && end - index > 1) break
      }
      const piece = pieceOf(fragment, fragment.from + index, fragment.from + end, 'word', measurer)
      if (!word) word = { kind: 'word', pieces: [], width: 0, from: piece.from, to: piece.to, breakAfter: false }
      word.pieces.push(piece)
      word.width += piece.width
      word.to = piece.to
      if (BREAK_AFTER.has(text[end - 1]) && end < text.length && !isSpace(text[end])) {
        word.breakAfter = true
        closeWord()
      }
      index = end
    }
  }
  closeWord()
  return tokens
}

/** Splits a word token at a text offset into two tokens (re-measured). */
const splitToken = (token: Token, at: number, fragments: Fragment[], measurer: TextMeasurer): [Token, Token] => {
  const left: Piece[] = []
  const right: Piece[] = []
  for (const piece of token.pieces) {
    if (piece.to <= at) left.push(piece)
    else if (piece.from >= at) right.push(piece)
    else {
      const fragment = fragments.find((candidate) => candidate.from <= piece.from && candidate.to >= piece.to)!
      left.push(pieceOf(fragment, piece.from, at, 'word', measurer))
      right.push(pieceOf(fragment, at, piece.to, 'word', measurer))
    }
  }
  const sum = (pieces: Piece[]) => pieces.reduce((total, piece) => total + piece.width, 0)
  return [
    { kind: 'word', pieces: left, width: sum(left), from: token.from, to: at, breakAfter: true },
    { kind: 'word', pieces: right, width: sum(right), from: at, to: token.to, breakAfter: token.breakAfter },
  ]
}

const wordText = (token: Token) => token.pieces.map((piece) => piece.text).join('')

export const layoutParagraph = (input: LayoutInput): ParagraphLayout => {
  const { style, measurer } = input
  const fragments = fragmentsOf(input)
  const textLength = input.runs.reduce((sum, run) => sum + run.text.length, 0)
  const baseFont: FontSpec = { family: style.font, bold: style.bold, italic: style.italic, size: style.size }
  const baseMetrics = measurer.metrics(baseFont)
  const lineAdvance = style.size * style.lineHeight

  // Drop cap: the first letter (with an opening quote) spans `dropCap` lines.
  let dropCap: DropCap | undefined
  let tokens: Token[]
  let startOffset = 0
  const plain = input.runs.map((run) => run.text).join('')
  const dropMatch = style.dropCap > 1 ? /^[„“"«‹‚'(]*[\p{L}\p{N}]/u.exec(plain) : null
  if (dropMatch) {
    const capText = dropMatch[0]
    const capSize = (lineAdvance * (style.dropCap - 1) + baseMetrics.ascent * 0.72) / 0.72
    const capFont: FontSpec = { ...baseFont, size: capSize, bold: false }
    const capMetrics = measurer.metrics(capFont)
    dropCap = { text: style.uppercase ? upper(capText) : capText, font: capFont, width: measurer.width(capText, capFont) + style.size * 0.15, lines: style.dropCap, x: 0, baseline: 0 }
    startOffset = capText.length
    dropCap.baseline = (lineAdvance - (baseMetrics.ascent + baseMetrics.descent)) / 2 + baseMetrics.ascent + lineAdvance * (style.dropCap - 1)
    void capMetrics
  }
  tokens = tokenize(fragments.flatMap((fragment) => {
    if (fragment.to <= startOffset && !fragment.anchor) return []
    if (fragment.from < startOffset) {
      const cut = startOffset - fragment.from
      return [{ ...fragment, from: startOffset, text: fragment.text.slice(cut), display: fragment.display.slice(cut) }]
    }
    return [fragment]
  }), measurer)

  const contentWidth = Math.max(20, input.width - style.indentLeft - style.indentRight)
  const lineStart = (index: number) => {
    // A list's first-line indent is the hanging space for its marker; the text aligns with the rest.
    let x = style.indentLeft + (index === 0 && !style.listMarker ? style.indentFirst : 0)
    if (dropCap && index < dropCap.lines) x = style.indentLeft + dropCap.width
    return Math.max(0, x)
  }
  const available = (index: number) => Math.max(20, input.width - style.indentRight - lineStart(index))

  const lines: LineBox[] = []
  const footnotes: ParagraphLayout['footnotes'] = []
  let cursor = 0
  const hyphenWidth = measurer.width(HYPHEN, baseFont)

  const finish = (lineTokens: Token[], forced: boolean, endsParagraph: boolean, hyphen: boolean) => {
    // Trailing spaces hang outside the line.
    while (lineTokens.length && lineTokens[lineTokens.length - 1].kind === 'space') lineTokens.pop()
    const index = lines.length
    const width = available(index)
    const pieces = lineTokens.flatMap((token) => token.pieces)
    // Set on the piece itself: the x positions below are written to these same objects.
    if (hyphen && pieces.length) pieces[pieces.length - 1].hyphen = true
    const natural = lineTokens.reduce((sum, token) => sum + token.width, 0) + (hyphen ? hyphenWidth : 0)
    const last = forced || endsParagraph
    const spaces = lineTokens.filter((token) => token.kind === 'space').length
    let extra = 0
    let offsetX = 0
    if (style.align === 'justify' && !last && spaces > 0) extra = Math.max(0, width - natural) / spaces
    else if (style.align === 'center') offsetX = Math.max(0, (width - natural) / 2)
    else if (style.align === 'right') offsetX = Math.max(0, width - natural)
    let x = offsetX
    for (const token of lineTokens) {
      for (const piece of token.pieces) {
        piece.x = x
        x += piece.width
      }
      if (token.kind === 'space' && extra) {
        const piece = token.pieces[token.pieces.length - 1]
        piece.width += extra
        x += extra
      }
    }
    const largest = pieces.reduce((max, piece) => Math.max(max, piece.marks?.size ? ptToPx(piece.marks.size) : 0), style.size)
    const height = largest * style.lineHeight
    const metrics = largest === style.size ? baseMetrics : measurer.metrics({ ...baseFont, size: largest })
    const baseline = (height - (metrics.ascent + metrics.descent)) / 2 + metrics.ascent
    const from = lineTokens[0]?.from ?? cursor
    const to = lineTokens.length ? lineTokens[lineTokens.length - 1].to : cursor
    for (const piece of pieces) if (piece.kind === 'anchor' && piece.marks?.fn) footnotes.push({ id: piece.marks.fn, line: index })
    lines.push({ from: index === 0 ? 0 : from, to, pieces, x: lineStart(index), available: width, width: hyphen ? x + hyphenWidth : x, height, baseline, last })
  }

  let lineTokens: Token[] = []
  let lineWidth = 0
  let pendingSpace = 0
  let index = 0
  const pending: Token[] = []
  while (index < tokens.length) {
    const token = tokens[index]
    const limit = available(lines.length)
    if (token.kind === 'newline') {
      lineTokens.push(...pending)
      pending.length = 0
      lineTokens.push(token)
      cursor = token.to
      finish(lineTokens, true, false, false)
      lineTokens = []
      lineWidth = 0
      pendingSpace = 0
      index += 1
      continue
    }
    if (token.kind === 'space') {
      if (lineTokens.length) {
        pending.push(token)
        pendingSpace += token.width
      }
      index += 1
      continue
    }
    if (lineWidth + pendingSpace + token.width <= limit + 0.01) {
      lineTokens.push(...pending, token)
      lineWidth += pendingSpace + token.width
      pending.length = 0
      pendingSpace = 0
      index += 1
      continue
    }
    // The word does not fit. Try a hyphenation point, then break before it.
    const room = limit - lineWidth - pendingSpace - hyphenWidth
    if (input.hyphenate && input.hyphenator && room > style.size) {
      const text = wordText(token)
      const letters = text.replace(/[^\p{L}]/gu, '')
      if (letters.length >= 5 && /^[\p{L}\-’']+[.,;:!?»«“”„"’)]*$/u.test(text)) {
        const core = text.replace(/[.,;:!?»«“”„"’)]+$/u, '')
        const points = input.hyphenator(core).filter((point) => point >= 2 && core.length - point >= 2)
        for (let pointIndex = points.length - 1; pointIndex >= 0; pointIndex -= 1) {
          const at = token.from + points[pointIndex]
          const [head, tail] = splitToken(token, at, fragments, measurer)
          if (head.width <= room) {
            lineTokens.push(...pending, head)
            pending.length = 0
            pendingSpace = 0
            finish(lineTokens, false, false, true)
            cursor = at
            tokens[index] = tail
            lineTokens = []
            lineWidth = 0
            break
          }
        }
        if (lineTokens.length === 0 && tokens[index] !== token) continue
      }
    }
    if (lineTokens.length === 0) {
      // A single word wider than the line: break it by characters.
      const text = wordText(token)
      let cut = text.length - 1
      while (cut > 1) {
        const [head] = splitToken(token, token.from + cut, fragments, measurer)
        if (head.width <= limit) break
        cut -= 1
      }
      const [head, tail] = splitToken(token, token.from + Math.max(1, cut), fragments, measurer)
      finish([head], false, false, false)
      cursor = head.to
      tokens[index] = tail
      continue
    }
    pending.length = 0
    pendingSpace = 0
    finish(lineTokens, false, false, false)
    cursor = token.from
    lineTokens = []
    lineWidth = 0
  }
  lineTokens.push(...pending)
  finish(lineTokens, false, true, false)
  // Lines cover the whole text: each starts where the previous ended.
  for (let line = 1; line < lines.length; line += 1) lines[line].from = lines[line - 1].to
  lines[lines.length - 1].to = textLength
  if (style.listMarker) {
    // The marker hangs in the first-line indent, left of where the text starts.
    const width = measurer.width(style.listMarker, baseFont)
    const gap = style.size * 0.4
    lines[0].pieces.unshift({ kind: 'marker', from: 0, to: 0, text: '', display: style.listMarker, font: baseFont, shift: 0, width, x: Math.min(-gap - width, style.indentFirst) })
  }
  if (dropCap) {
    lines[0].from = 0
    dropCap.x = style.indentLeft
  }
  void contentWidth
  return { lines, style, ...(dropCap ? { dropCap } : {}), height: lines.reduce((sum, line) => sum + line.height, 0), footnotes, textLength }
}

// ── Caret geometry ─────────────────────────────────────────────────────────

/** The line index holding an offset (a caret at a line end belongs to that line unless `forward`). */
export const lineAt = (layout: ParagraphLayout, offset: number, forward = false) => {
  for (let index = 0; index < layout.lines.length; index += 1) {
    const line = layout.lines[index]
    if (offset < line.to || (offset === line.to && (!forward || index === layout.lines.length - 1))) return index
  }
  return layout.lines.length - 1
}

/** x of a caret at `offset` within its line, relative to the line start. */
export const caretX = (layout: ParagraphLayout, lineIndex: number, offset: number, measurer: TextMeasurer) => {
  const line = layout.lines[lineIndex]
  if (!line.pieces.some((piece) => piece.kind !== 'marker')) {
    if (layout.style.align === 'center') return line.available / 2
    if (layout.style.align === 'right') return line.available
    return 0
  }
  for (const piece of line.pieces) {
    if (piece.kind === 'marker') continue
    if (offset <= piece.from) return piece.x
    if (offset < piece.to || (offset === piece.to && piece === line.pieces[line.pieces.length - 1])) {
      if (piece.kind === 'space') return piece.x + piece.width * ((offset - piece.from) / Math.max(1, piece.to - piece.from))
      return piece.x + measurer.width(piece.display.slice(0, offset - piece.from), piece.font)
    }
  }
  const lastPiece = line.pieces[line.pieces.length - 1]
  return lastPiece.x + lastPiece.width
}

/** The offset nearest to x (relative to the line start). */
export const offsetAtX = (layout: ParagraphLayout, lineIndex: number, x: number, measurer: TextMeasurer) => {
  const line = layout.lines[lineIndex]
  if (!line.pieces.length) return line.from
  let best = line.from
  let bestDistance = Number.POSITIVE_INFINITY
  for (const piece of line.pieces) {
    if (piece.kind === 'newline' || piece.kind === 'anchor' || piece.kind === 'marker') continue
    if (x < piece.x - 1 && best !== line.from) break
    for (let offset = piece.from; offset <= piece.to; offset += 1) {
      const position = piece.kind === 'space'
        ? piece.x + piece.width * ((offset - piece.from) / Math.max(1, piece.to - piece.from))
        : piece.x + measurer.width(piece.display.slice(0, offset - piece.from), piece.font)
      const distance = Math.abs(position - x)
      if (distance < bestDistance) {
        bestDistance = distance
        best = offset
      }
    }
  }
  // A caret never sits after a line's trailing break.
  const lastPiece = line.pieces[line.pieces.length - 1]
  if (lastPiece.kind === 'newline' && best > lastPiece.from) best = lastPiece.from
  return best
}
