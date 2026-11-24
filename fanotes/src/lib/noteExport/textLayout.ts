/**
 * Markdown basics of a text box as positioned lines: headings, bold, italic,
 * inline code, strike-through, bullet / numbered / task lists, quotes, fenced
 * code, rules, and word wrapping inside a width. No DOM: a `measure` callback
 * supplies widths, so the same layout serves PDF and DOCX export and tests.
 */
import type { FontFace } from './pdfFonts'

export type TextMeasure = (text: string, face: FontFace, mono: boolean, size: number) => number

export type InlineRun = { text: string; bold: boolean; italic: boolean; mono: boolean; strike: boolean }

export type LaidRun = { x: number; text: string; face: FontFace; mono: boolean; size: number; strike: boolean; width: number }

export type LaidLine = {
  /** Distance of the line's top from the box's content top. */
  top: number
  height: number
  size: number
  runs: LaidRun[]
  /** A horizontal rule instead of text. */
  rule?: boolean
  /** A quote bar at the left. */
  quote?: boolean
}

export type LaidText = { lines: LaidLine[]; height: number; plain: string }

const faceOf = (bold: boolean, italic: boolean): FontFace => (bold ? (italic ? 'boldItalic' : 'bold') : italic ? 'italic' : 'regular')

const INLINE = /(\*\*\*|___)(.+?)\1|(\*\*|__)(.+?)\3|(\*|_)(?=\S)(.+?)(?<=\S)\5|(`+)(.+?)\7|~~(.+?)~~|\[([^\]]*)\]\(([^)]*)\)|<\/?(?:sub|sup|u|b|i|em|strong|br)\s*\/?>|\\([\\`*_{}[\]()#+\-.!~|<>])/gu

/** Splits one line of Markdown into styled runs. */
export const inlineRuns = (source: string, base: { bold?: boolean; italic?: boolean } = {}): InlineRun[] => {
  const runs: InlineRun[] = []
  const push = (text: string, flags: Partial<InlineRun>) => {
    if (!text) return
    runs.push({ text, bold: Boolean(base.bold), italic: Boolean(base.italic), mono: false, strike: false, ...flags })
  }
  const walk = (text: string, flags: Partial<InlineRun>) => {
    let last = 0
    for (const match of text.matchAll(INLINE)) {
      const at = match.index ?? 0
      push(text.slice(last, at), flags)
      last = at + match[0].length
      if (match[1]) {
        walk(match[2], { ...flags, bold: true, italic: true })
      } else if (match[3]) {
        walk(match[4], { ...flags, bold: true })
      } else if (match[5]) {
        walk(match[6], { ...flags, italic: true })
      } else if (match[7]) {
        push(match[8], { ...flags, mono: true })
      } else if (match[9] !== undefined) {
        walk(match[9], { ...flags, strike: true })
      } else if (match[10] !== undefined) {
        walk(match[10] || match[11], flags)
      } else if (match[12] !== undefined) {
        push(match[12], flags)
      }
    }
    push(text.slice(last), flags)
  }
  walk(source, {})
  return runs
}

export const plainTextOf = (source: string) => source
  .split('\n')
  .map((line) => inlineRuns(line.replace(/^(\s*)(?:#{1,6}\s+|>\s?)/u, '$1')).map((run) => run.text).join(''))
  .join('\n')

const HEADING_SCALE = [1.5, 1.28, 1.12, 1, 1, 1]
const LINE_HEIGHT = 1.35
const BLOCK_GAP = 0.45

type Block = { runs: InlineRun[]; indent: number; marker?: string; size: number; bold?: boolean; quote?: boolean; rule?: boolean; mono?: boolean; gapBefore: number }

const blocksOf = (text: string, baseSize: number, baseBold: boolean): Block[] => {
  const blocks: Block[] = []
  let fenced = false
  let gap = 0
  let ordinal = 0
  for (const line of text.replace(/\r\n?/gu, '\n').split('\n')) {
    if (/^\s*(```|~~~)/u.test(line)) {
      fenced = !fenced
      continue
    }
    if (fenced) {
      blocks.push({ runs: [{ text: line, bold: false, italic: false, mono: true, strike: false }], indent: 0.6, size: baseSize * 0.92, mono: true, gapBefore: 0 })
      continue
    }
    if (!line.trim()) {
      gap = BLOCK_GAP
      ordinal = 0
      continue
    }
    const gapBefore = blocks.length ? gap : 0
    gap = 0
    if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/u.test(line)) {
      blocks.push({ runs: [], indent: 0, size: baseSize, rule: true, gapBefore: gapBefore + 0.2 })
      continue
    }
    const heading = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/u.exec(line)
    if (heading) {
      const size = baseSize * HEADING_SCALE[heading[1].length - 1]
      blocks.push({ runs: inlineRuns(heading[2], { bold: true }), indent: 0, size, bold: true, gapBefore: Math.max(gapBefore, blocks.length ? 0.2 : 0) })
      continue
    }
    const quote = /^\s{0,3}>\s?(.*)$/u.exec(line)
    if (quote) {
      blocks.push({ runs: inlineRuns(quote[1], { italic: false }), indent: 0.9, size: baseSize, quote: true, gapBefore })
      continue
    }
    const bullet = /^(\s*)[-*+]\s+(?:\[([ xX])\]\s+)?(.*)$/u.exec(line)
    if (bullet) {
      const level = Math.floor(bullet[1].replace(/\t/gu, '  ').length / 2)
      const marker = bullet[2] === undefined ? '•' : bullet[2] === ' ' ? '[ ]' : '[x]'
      blocks.push({ runs: inlineRuns(bullet[3], { bold: baseBold }), indent: 1.2 + level * 1.2, marker, size: baseSize, gapBefore })
      continue
    }
    const numbered = /^(\s*)(\d+)[.)]\s+(.*)$/u.exec(line)
    if (numbered) {
      const level = Math.floor(numbered[1].replace(/\t/gu, '  ').length / 2)
      ordinal = Number(numbered[2])
      blocks.push({ runs: inlineRuns(numbered[3], { bold: baseBold }), indent: 1.4 + level * 1.2, marker: `${ordinal}.`, size: baseSize, gapBefore })
      continue
    }
    blocks.push({ runs: inlineRuns(line.replace(/^\s+/u, ''), { bold: baseBold }), indent: 0, size: baseSize, gapBefore })
  }
  return blocks
}

/**
 * Lays Markdown out in `width` (same unit as `baseSize`). The result's `top`
 * values are relative to the box's content top.
 */
export const layoutMarkdown = (
  text: string,
  width: number,
  baseSize: number,
  measure: TextMeasure,
  options: { bold?: boolean } = {},
): LaidText => {
  const lines: LaidLine[] = []
  let cursor = 0
  for (const block of blocksOf(text, baseSize, Boolean(options.bold))) {
    cursor += block.gapBefore * baseSize
    const lineHeight = block.size * LINE_HEIGHT
    if (block.rule) {
      lines.push({ top: cursor, height: lineHeight, size: block.size, runs: [], rule: true })
      cursor += lineHeight
      continue
    }
    const left = block.indent * baseSize
    const room = Math.max(baseSize * 2, width - left)
    const firstIndex = lines.length
    let line: LaidRun[] = []
    let x = 0
    const flush = (keepEmpty = false) => {
      while (line.length && line[line.length - 1].text.trim() === '') line.pop()
      if (line.length || keepEmpty) {
        lines.push({ top: cursor, height: lineHeight, size: block.size, runs: line.map((run) => ({ ...run, x: run.x + left })), quote: block.quote })
        cursor += lineHeight
      }
      line = []
      x = 0
    }
    const put = (token: { face: FontFace; mono: boolean; strike: boolean }, piece: string) => {
      const w = measure(piece, token.face, token.mono, block.size)
      line.push({ x, text: piece, face: token.face, mono: token.mono, size: block.size, strike: token.strike, width: w })
      x += w
    }
    let any = false
    for (const run of block.runs) {
      const token = { face: faceOf(run.bold, run.italic), mono: run.mono || Boolean(block.mono), strike: run.strike }
      for (const part of run.text.split(/( +)/u)) {
        if (!part) continue
        any = true
        if (part[0] === ' ') {
          if (x > 0) put(token, part)
          continue
        }
        const w = measure(part, token.face, token.mono, block.size)
        if (x + w > room && x > 0) flush()
        if (w > room) {
          // overflow-wrap: anywhere
          let chunk = ''
          for (const char of part) {
            if (chunk && measure(chunk + char, token.face, token.mono, block.size) > room) {
              put(token, chunk)
              flush()
              chunk = ''
            }
            chunk += char
          }
          if (chunk) put(token, chunk)
          continue
        }
        put(token, part)
      }
    }
    flush(!any)
    if (block.marker && lines.length > firstIndex) {
      const markerWidth = measure(block.marker, 'regular', false, block.size)
      lines[firstIndex].runs.unshift({
        x: Math.max(0, left - markerWidth - baseSize * 0.35),
        text: block.marker,
        face: 'regular',
        mono: false,
        size: block.size,
        strike: false,
        width: markerWidth,
      })
    }
  }
  return { lines, height: cursor, plain: plainTextOf(text) }
}
