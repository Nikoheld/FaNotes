/**
 * Text folding, query parsing and snippets for document search.
 *
 * The folding rules are part of the `fanotes-page-text-v1` contract and are
 * the same as Kanti+ (`DocSearchText.kt`): "Straße" = "STRASSE" = "strasse",
 * "Übung" = "Uebung" = "ubung", ligatures and diacritics fold to their base
 * letters, a word hyphenated across a line break is joined, punctuation is a
 * space. Snippets are cut from the original text through `origin`.
 */

export type FoldedText = {
  /** Folded text: lowercase a–z, 0–9, other letters without marks, single spaces. */
  text: string
  /** For every folded char, the index of the original char it came from. */
  origin: number[]
}

const foldCache = new Map<string, string>()
const COMBINING = /\p{M}/u
const LETTER_OR_DIGIT = /[\p{L}\p{N}]/u

const foldChar = (char: string): string => {
  const code = char.charCodeAt(0)
  if ((code >= 97 && code <= 122) || (code >= 48 && code <= 57)) return char
  if (code >= 65 && code <= 90) return String.fromCharCode(code + 32)
  if (char === 'ß' || char === 'ẞ') return 'ss'
  if (code < 128) return ' '
  const cached = foldCache.get(char)
  if (cached !== undefined) return cached
  let kept = ''
  for (const part of char.normalize('NFKD')) {
    if (COMBINING.test(part)) continue
    if (part === 'ß') kept += 'ss'
    else if (LETTER_OR_DIGIT.test(part)) kept += part.toLocaleLowerCase('de-DE')
    else kept += ' '
  }
  const result = kept || ' '
  if (foldCache.size < 4096) foldCache.set(char, result)
  return result
}

const isLowerLetter = (char: string | undefined) => Boolean(char && char !== char.toLocaleUpperCase('de-DE') && char === char.toLocaleLowerCase('de-DE'))
const isLetter = (char: string | undefined) => Boolean(char && /\p{L}/u.test(char))

export const foldSearch = (raw: string, limit = Number.MAX_SAFE_INTEGER): FoldedText => {
  const end = Math.min(raw.length, limit)
  const out: string[] = []
  const origin: number[] = []
  let last = ''
  const push = (char: string, from: number) => {
    if (char === ' ' && (out.length === 0 || last === ' ')) return
    // German digraphs: the "e" of ae/oe/ue is dropped on both sides of a match.
    if (char === 'e' && (last === 'a' || last === 'o' || last === 'u') && from > 0) {
      const previous = raw.charCodeAt(from - 1) | 32
      if (previous === 97 || previous === 111 || previous === 117) return
    }
    out.push(char)
    origin.push(from)
    last = char
  }
  let index = 0
  while (index < end) {
    const code = raw.charCodeAt(index)
    // Fast path: ASCII letters and digits.
    if ((code >= 97 && code <= 122) || (code >= 48 && code <= 57)) { push(raw[index]!, index); index += 1; continue }
    if (code >= 65 && code <= 90) { push(String.fromCharCode(code + 32), index); index += 1; continue }
    const char = raw[index] ?? ''
    if (char === '\u00ad') { index += 1; continue }
    if (char === '-' && index > 0 && isLetter(raw[index - 1])) {
      let next = index + 1
      while (next < end && (raw[next] === ' ' || raw[next] === '\t' || raw[next] === '\r')) next += 1
      if (next < end && raw[next] === '\n') {
        let after = next + 1
        while (after < end && (raw[after] === ' ' || raw[after] === '\t')) after += 1
        if (after < end && isLowerLetter(raw[after])) { index = after; continue }
      }
    }
    if (code < 128) { push(' ', index); index += 1; continue }
    // Astral characters (emoji, rare scripts) are one code point but two UTF-16 units.
    const codePoint = raw.codePointAt(index) ?? 0
    const width = codePoint > 0xffff ? 2 : 1
    const folded = foldChar(raw.slice(index, index + width))
    for (let part = 0; part < folded.length; part += 1) push(folded[part]!, index)
    index += width
  }
  while (out.length && out[out.length - 1] === ' ') {
    out.pop()
    origin.pop()
  }
  return { text: out.join(''), origin }
}

export const foldPlain = (raw: string) => foldSearch(raw).text

export type DocQuery = { raw: string; terms: string[] }

export const MAX_QUERY_TERMS = 8

/** Folded, distinct terms. Every term must match; each also matches as a word prefix. */
export const parseDocQuery = (raw: string): DocQuery => {
  const terms = [...new Set(foldPlain(String(raw ?? '').slice(0, 200)).split(' ').filter(Boolean))].slice(0, MAX_QUERY_TERMS)
  return { raw: String(raw ?? ''), terms }
}

export const tokenize = (folded: string) => folded.split(' ').filter(Boolean)

export type Snippet = {
  text: string
  /** Number of matched words in the whole text. */
  matched?: number
  /** [start, end) offsets into `text` of matched words. */
  highlights: Array<[number, number]>
}

/** Ranges of whole folded words that start with a query term, in folded offsets. */
export const matchRanges = (folded: string, terms: readonly string[], max = 64): Array<[number, number]> => {
  const ranges: Array<[number, number]> = []
  for (const term of terms) {
    let from = 0
    while (ranges.length < max) {
      const at = folded.indexOf(term, from)
      if (at < 0) break
      if (at === 0 || folded[at - 1] === ' ') {
        let end = at + term.length
        while (end < folded.length && folded[end] !== ' ') end += 1
        ranges.push([at, end])
      }
      from = at + 1
    }
  }
  return ranges.sort((left, right) => left[0] - right[0])
}

/**
 * At most `width` original characters around the first match, whitespace
 * collapsed, with highlight ranges relative to the snippet text.
 */
export const makeSnippet = (original: string, terms: readonly string[], width = 160, prefolded?: FoldedText): Snippet => {
  const folded = prefolded ?? foldSearch(original)
  const ranges = matchRanges(folded.text, terms, 256)
  const collapse = (start: number, end: number) => {
    const source = original.slice(start, end)
    let text = ''
    const map: number[] = []
    let space = false
    for (let index = 0; index < source.length; index += 1) {
      const char = source[index] ?? ''
      if (/\s/u.test(char)) {
        if (!space && text.length) { text += ' '; map.push(start + index) }
        space = true
        continue
      }
      space = false
      text += char
      map.push(start + index)
    }
    return { text: text.trimEnd(), map }
  }
  if (!ranges.length) {
    const { text } = collapse(0, Math.min(original.length, width * 2))
    return { text: text.slice(0, width), highlights: [], matched: 0 }
  }
  const firstStart = folded.origin[ranges[0]![0]] ?? 0
  let start = Math.max(0, firstStart - Math.floor(width / 3))
  // Start on a word boundary when possible.
  if (start > 0) {
    const space = original.lastIndexOf(' ', firstStart)
    if (space >= start) start = space + 1
    else {
      const nextSpace = original.indexOf(' ', start)
      if (nextSpace >= 0 && nextSpace < firstStart) start = nextSpace + 1
    }
  }
  const end = Math.min(original.length, start + width * 2)
  const collapsed = collapse(start, end)
  const text = collapsed.text.slice(0, width)
  const highlights: Array<[number, number]> = []
  for (const [foldStart, foldEnd] of ranges) {
    const origStart = folded.origin[foldStart]
    const origEnd = (folded.origin[foldEnd - 1] ?? origStart ?? 0) + 1
    if (origStart === undefined) continue
    const from = collapsed.map.findIndex((value) => value >= origStart)
    if (from < 0 || from >= text.length) continue
    let to = collapsed.map.findIndex((value) => value >= origEnd)
    if (to < 0) to = collapsed.map.length
    to = Math.min(to, text.length)
    if (to > from && !highlights.some(([a, b]) => from < b && to > a)) highlights.push([from, to])
  }
  const prefix = start > 0 ? '… ' : ''
  return {
    text: prefix + text + (start + width < original.length ? ' …' : ''),
    highlights: highlights.map(([a, b]) => [a + prefix.length, b + prefix.length]),
    matched: ranges.length,
  }
}

/** Handwriting transcripts are "y\tword" lines; search uses the words. */
export const readableTranscript = (raw: string) => String(raw ?? '')
  .split('\n')
  .map((line) => {
    const tab = line.indexOf('\t')
    return tab >= 0 && /^\d+(?:\.\d+)?$/u.test(line.slice(0, tab).trim()) ? line.slice(tab + 1) : line
  })
  .join(' ')
  .replace(/\s+/gu, ' ')
  .trim()
