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
  /**
   * A space at the end of a line: at a soft wrap, before a forced break or at
   * the end of the paragraph. It hangs past the text: alignment and
   * justification ignore it and nothing is drawn, but the caret can sit after
   * it, so a typed space moves the caret right away. At a soft wrap the spaces
   * belong to the line they end (the next line starts with its word), so the
   * caret has a place at the end of that line.
   */
  hang?: true
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
  const baseHyphenWidth = measurer.width(HYPHEN, baseFont)

  const finish = (lineTokens: Token[], forced: boolean, endsParagraph: boolean, hyphen: boolean) => {
    // A forced break stays the last piece of its line; the spaces before it hang like any trailing spaces.
    const breakToken = lineTokens.length && lineTokens[lineTokens.length - 1].kind === 'newline' ? lineTokens.pop()! : null
    // Trailing spaces hang outside the line (see `Piece.hang`).
    const hanging: Token[] = []
    while (lineTokens.length && lineTokens[lineTokens.length - 1].kind === 'space') hanging.unshift(lineTokens.pop()!)
    const index = lines.length
    const width = available(index)
    const pieces = lineTokens.flatMap((token) => token.pieces)
    // Set on the piece itself: the x positions below are written to these same objects.
    const lastPiece = pieces[pieces.length - 1]
    // The hyphen is drawn in the font of the piece it ends, so it is measured in that font.
    const hyphenWidth = hyphen && lastPiece ? measurer.width(HYPHEN, lastPiece.font) : 0
    if (hyphen && lastPiece) lastPiece.hyphen = true
    const natural = lineTokens.reduce((sum, token) => sum + token.width, 0) + hyphenWidth
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
    let hangX = x
    for (const token of hanging) {
      for (const piece of token.pieces) {
        piece.x = hangX
        piece.hang = true
        hangX += piece.width
        pieces.push(piece)
      }
    }
    if (breakToken) {
      // A caret before the break sits after the hanging spaces.
      breakToken.pieces[0].x = hangX
      pieces.push(breakToken.pieces[0])
    }
    const largest = pieces.reduce((max, piece) => Math.max(max, piece.marks?.size ? ptToPx(piece.marks.size) : 0), style.size)
    const height = largest * style.lineHeight
    const metrics = largest === style.size ? baseMetrics : measurer.metrics({ ...baseFont, size: largest })
    const baseline = (height - (metrics.ascent + metrics.descent)) / 2 + metrics.ascent
    // An empty line (an empty paragraph, the line after a trailing break) starts and ends at the cursor.
    const from = (lineTokens[0] ?? hanging[0] ?? breakToken)?.from ?? cursor
    const to = (breakToken ?? hanging[hanging.length - 1] ?? lineTokens[lineTokens.length - 1])?.to ?? cursor
    for (const piece of pieces) if (piece.kind === 'anchor' && piece.marks?.fn) footnotes.push({ id: piece.marks.fn, line: index })
    lines.push({ from: index === 0 ? 0 : from, to, pieces, x: lineStart(index), available: width, width: x + hyphenWidth, height, baseline, last })
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
      // Spaces wait for the next word. If it fits they sit before it; if the line wraps they hang at the end of
      // this line (a wrapped line never starts with a space). After a forced break and at the start of the
      // paragraph they are typed text (verse, an address block) and stay.
      pending.push(token)
      pendingSpace += token.width
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
    const space = limit - lineWidth - pendingSpace
    if (input.hyphenate && input.hyphenator && space - baseHyphenWidth > style.size) {
      const text = wordText(token)
      const letters = text.replace(/[^\p{L}]/gu, '')
      if (letters.length >= 5 && /^[\p{L}\-’']+[.,;:!?»«“”„"’)]*$/u.test(text)) {
        const core = text.replace(/[.,;:!?»«“”„"’)]+$/u, '')
        const points = input.hyphenator(core).filter((point) => point >= 2 && core.length - point >= 2)
        for (let pointIndex = points.length - 1; pointIndex >= 0; pointIndex -= 1) {
          const at = token.from + points[pointIndex]
          const [head, tail] = splitToken(token, at, fragments, measurer)
          const headEnd = head.pieces[head.pieces.length - 1]
          // The hyphen is drawn in the font of the piece before it.
          if (head.width + (headEnd ? measurer.width(HYPHEN, headEnd.font) : baseHyphenWidth) <= space) {
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
    if (lineTokens.length === 0 && pending.length) {
      // Typed spaces at the start of a line and a word that does not fit after them: the spaces hang on a line
      // of their own and the word starts the next one (it may still fit there, or be broken).
      lineTokens.push(...pending)
      pending.length = 0
      pendingSpace = 0
      finish(lineTokens, false, false, false)
      cursor = token.from
      lineTokens = []
      lineWidth = 0
      continue
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
    // The line wraps before this word. The spaces between the lines hang at the end of this one, so the caret
    // can sit after its last word and the next line starts with its word.
    lineTokens.push(...pending)
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
//
// A caret is an offset into the paragraph. At a soft wrap, one offset can sit in
// two places: after the last word of a line and before the first word of the
// next. When spaces separate the lines they hang at the end of the first line
// (see `Piece.hang`), so each place has its own offset: the one before the
// spaces ends the first line, the one after them starts the second. When nothing
// separates the lines (a break after a hyphen or inside a word) both places share
// one offset; `lineAt` then needs to know which one is meant (`forward`, drawn at
// the start of the next line, or not, drawn at the end of this one).

/**
 * The line index holding an offset. An offset that ends a line belongs to that
 * line unless `forward`: then it is the start of the next one (how a caret is
 * drawn and moved, unless it was put at the end of the line on purpose).
 */
export const lineAt = (layout: ParagraphLayout, offset: number, forward = false) => {
  for (let index = 0; index < layout.lines.length; index += 1) {
    const line = layout.lines[index]
    if (offset < line.to || (offset === line.to && (!forward || index === layout.lines.length - 1))) return index
  }
  return layout.lines.length - 1
}

/**
 * Where the caret goes at the end of a line (End key, a click right of the text).
 * Spaces that hang at a soft wrap are left out so the caret stays on the line;
 * spaces typed at the end of the paragraph or before a forced break are text
 * and come first. `upstream` is set when the offset also starts the next line
 * (a break after a hyphen or inside a word): the caret is then drawn at the end
 * of this line (`lineAt(..., false)`), not at the start of the next one.
 */
export const lineEnd = (layout: ParagraphLayout, lineIndex: number): { offset: number; upstream: boolean } => {
  const line = layout.lines[lineIndex]
  const last = line.pieces[line.pieces.length - 1]
  if (last?.kind === 'newline') return { offset: last.from, upstream: false }
  if (lineIndex === layout.lines.length - 1) return { offset: line.to, upstream: false }
  const hanging = line.pieces.find((piece) => piece.hang)
  return hanging ? { offset: hanging.from, upstream: false } : { offset: line.to, upstream: true }
}

/** x of a caret between the letters of the drop cap: left of the line start, which is where the cap ends. */
const capX = (cap: DropCap, offset: number, measurer: TextMeasurer) => -cap.width + measurer.width(cap.text.slice(0, offset), cap.font)

/** x of a caret at `offset` inside a piece, relative to the line start. */
const pieceX = (piece: Piece, offset: number, measurer: TextMeasurer) => {
  const inside = piece.kind === 'space'
    ? piece.width * ((offset - piece.from) / Math.max(1, piece.to - piece.from))
    : measurer.width(piece.display.slice(0, offset - piece.from), piece.font)
  // At the end of a line that breaks inside a word the caret sits after the hyphen.
  return piece.x + inside + (piece.hyphen && offset === piece.to ? measurer.width(HYPHEN, piece.font) : 0)
}

/**
 * x of a caret at `offset` within its line, relative to the line start. It never
 * leaves the line's box: spaces hanging past the margin do not push it out.
 */
export const caretX = (layout: ParagraphLayout, lineIndex: number, offset: number, measurer: TextMeasurer) => {
  const line = layout.lines[lineIndex]
  const cap = layout.dropCap
  if (cap && lineIndex === 0 && offset < cap.text.length) return capX(cap, Math.max(0, offset), measurer)
  if (!line.pieces.some((piece) => piece.kind !== 'marker')) {
    if (layout.style.align === 'center') return line.available / 2
    if (layout.style.align === 'right') return line.available
    return 0
  }
  const lastPiece = line.pieces[line.pieces.length - 1]
  for (const piece of line.pieces) {
    if (piece.kind === 'marker') continue
    if (offset <= piece.from) return Math.min(piece.x, line.available)
    if (offset < piece.to || (offset === piece.to && piece === lastPiece)) return Math.min(pieceX(piece, offset, measurer), line.available)
  }
  return Math.min(lastPiece.x + lastPiece.width, line.available)
}

/**
 * The caret nearest to x (relative to the line start): its offset, and whether it
 * belongs at the end of the line rather than at the start of the next one. It
 * never lies beyond `lineEnd`, so a click right of a wrapped line ends that line.
 */
export const caretAtX = (layout: ParagraphLayout, lineIndex: number, x: number, measurer: TextMeasurer) => {
  const line = layout.lines[lineIndex]
  const end = lineEnd(layout, lineIndex)
  let best = line.from
  let bestDistance = Number.POSITIVE_INFINITY
  // On a tie the later offset wins: spaces hanging past the margin share one x, and a click there ends the line.
  const consider = (offset: number, position: number) => {
    const distance = Math.abs(position - x)
    if (distance <= bestDistance) {
      bestDistance = distance
      best = offset
    }
  }
  const cap = layout.dropCap
  if (cap && lineIndex === 0) for (let offset = 0; offset < cap.text.length; offset += 1) consider(offset, capX(cap, offset, measurer))
  let visited = false
  for (const piece of line.pieces) {
    if (piece.kind === 'newline' || piece.kind === 'anchor' || piece.kind === 'marker') continue
    if (visited && x < piece.x - 1) break
    for (let offset = piece.from; offset <= piece.to && offset <= end.offset; offset += 1) consider(offset, Math.min(pieceX(piece, offset, measurer), line.available))
    visited = true
  }
  // The end of the line is a stop of its own: an empty line, or one that only a break follows, has no piece to stop at.
  consider(end.offset, caretX(layout, lineIndex, end.offset, measurer))
  return { offset: best, upstream: end.upstream && best === end.offset }
}

/** The offset nearest to x (relative to the line start). */
export const offsetAtX = (layout: ParagraphLayout, lineIndex: number, x: number, measurer: TextMeasurer) => caretAtX(layout, lineIndex, x, measurer).offset
