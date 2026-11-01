/** When the default pen leaves a long word unknown, another width may read it as a dictionary word. */

const WORD = /[A-Za-zÄÖÜäöüß]+/gu

/** Nearby renderings tried when a long word is still unknown. The default 2.6 px reading comes first. */
export const INK_RETRY_VARIANTS = [
  { penWidth: 1.8, scale: 1 },
  { penWidth: 3, scale: 1 },
  { penWidth: 3.5, scale: 1 },
  { penWidth: 2.6, scale: 0.92 },
] as const

/** The unknown word has to be at least this long before a second rendering is worth the time. */
export const LONG_UNKNOWN_LETTERS = 10

/** The other rendering has to beat the default reading by this many nats. */
export const WIDTH_RETRY_MARGIN = 2

/** A two-word merge has to beat the default reading by this many nats. */
export const MERGE_SCORE_MARGIN = 4

/** Copying one long unknown word out of another rendering requires this much of a lead. */
export const SPLICE_SCORE_MARGIN = 5

const SPLICE_MIN_LETTERS = 12

export const foldInkWord = (word: string) => word.toLowerCase().replaceAll('ß', 'ss')

export const inkWords = (text: string) => text.match(WORD) ?? []

const editDistance = (left: string, right: string) => {
  const a = Array.from(left)
  const b = Array.from(right)
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index)
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i]
    for (let j = 1; j <= b.length; j += 1) {
      current.push(Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + Number(a[i - 1] !== b[j - 1])))
    }
    previous = current
  }
  return previous[b.length]
}

export const hasLongUnknownWord = (
  text: string,
  known: (word: string) => boolean,
  minLength = LONG_UNKNOWN_LETTERS,
) => inkWords(text).some((word) => foldInkWord(word).length >= minLength && !known(word))

/**
 * True when `alternate` turns one long unknown word into a dictionary word of nearly the same
 * length, leaves every known word as it was, and moves any other unknown word by at most two
 * letters (`Glückensisch` → `Glückwunsch`, while `Weiriell` may become `Muiriell`).
 */
export const widthReadingKeepsKnownWords = (
  base: string,
  alternate: string,
  known: (word: string) => boolean,
  minLength = LONG_UNKNOWN_LETTERS,
) => {
  const left = inkWords(base)
  const right = inkWords(alternate)
  if (left.length !== right.length) return false
  let replaced = false
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] === right[index]) continue
    if (known(left[index])) return false
    const before = foldInkWord(left[index])
    const after = foldInkWord(right[index])
    if (before.length >= minLength && known(right[index]) && Math.abs(before.length - after.length) <= 3) {
      replaced = true
      continue
    }
    if (editDistance(before, after) <= 2) continue
    return false
  }
  return replaced
}

/**
 * True when `alternate` replaces exactly two adjacent words with one longer word, that word
 * starts with the first of the two, and every other word is unchanged
 * (`luft statut` → `luftstreitkraft`).
 */
export const widthReadingMergesTwoWords = (base: string, alternate: string) => {
  const left = inkWords(base)
  const right = inkWords(alternate)
  if (left.length !== right.length + 1) return false
  let index = 0
  while (index < right.length && left[index] === right[index]) index += 1
  if (index >= right.length) return false
  const first = foldInkWord(left[index])
  const second = foldInkWord(left[index + 1] ?? '')
  const merged = foldInkWord(right[index])
  if (first.length < 4 || second.length < 4 || merged.length < 12 || !merged.startsWith(first)) return false
  return left.slice(index + 2).join('\0') === right.slice(index + 1).join('\0')
}

export type WordEdit = { index: number; from: string; to: string }

/**
 * Word positions where `alternate` rewrites a long unknown word and leaves every known word
 * to be kept from `base`. A known word that the other rendering changed is not an edit.
 * Returns null when the two readings do not have the same words.
 */
export const longUnknownWordEdits = (
  base: string,
  alternate: string,
  known: (word: string) => boolean,
): WordEdit[] | null => {
  const left = inkWords(base)
  const right = inkWords(alternate)
  if (left.length !== right.length) return null
  const edits: WordEdit[] = []
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] === right[index] || known(left[index])) continue
    const before = foldInkWord(left[index])
    const after = foldInkWord(right[index])
    if (before.length < SPLICE_MIN_LETTERS || Math.abs(before.length - after.length) > 3) continue
    edits.push({ index, from: left[index], to: right[index] })
  }
  return edits.length ? edits : null
}

/** Replaces the edited words inside `base`, including the punctuation around them. */
export const textWithWordEdits = (base: string, edits: WordEdit[]) => {
  const spans = [...base.matchAll(WORD)]
  let result = base
  for (const edit of [...edits].sort((left, right) => right.index - left.index)) {
    const span = spans[edit.index]
    if (!span || span[0] !== edit.from || span.index === undefined) return base
    result = result.slice(0, span.index) + edit.to + result.slice(span.index + edit.from.length)
  }
  return result
}

const letterRuns = <T extends { char: string }>(characters: T[]) => {
  const runs: Array<{ start: number; end: number; word: string }> = []
  let index = 0
  while (index < characters.length) {
    if (!/[A-Za-zÄÖÜäöüß]/u.test(characters[index].char)) {
      index += 1
      continue
    }
    const start = index
    let word = ''
    while (index < characters.length && /[A-Za-zÄÖÜäöüß]/u.test(characters[index].char)) {
      word += characters[index].char
      index += 1
    }
    runs.push({ start, end: index, word })
  }
  return runs
}

/**
 * Characters of `base`, with each edited word's glyphs taken from `alternate`.
 * `source` names the rendering and the character index the glyph was taken from.
 */
export const charactersWithWordEdits = <T extends { char: string }>(
  base: T[],
  alternate: T[],
  edits: WordEdit[],
): { characters: T[]; source: Array<{ alt: boolean; index: number }> } | null => {
  const left = letterRuns(base)
  const right = letterRuns(alternate)
  if (left.length !== right.length) return null
  const replacement = new Map(edits.map((edit) => [edit.index, edit.to]))
  const characters: T[] = []
  const source: Array<{ alt: boolean; index: number }> = []
  let cursor = 0
  for (let index = 0; index < left.length; index += 1) {
    for (let from = cursor; from < left[index].start; from += 1) {
      characters.push(base[from])
      source.push({ alt: false, index: from })
    }
    const next = replacement.get(index)
    if (next !== undefined) {
      if (right[index].word !== next) return null
      for (let from = right[index].start; from < right[index].end; from += 1) {
        characters.push(alternate[from])
        source.push({ alt: true, index: from })
      }
    } else {
      for (let from = left[index].start; from < left[index].end; from += 1) {
        characters.push(base[from])
        source.push({ alt: false, index: from })
      }
    }
    cursor = left[index].end
  }
  for (let from = cursor; from < base.length; from += 1) {
    characters.push(base[from])
    source.push({ alt: false, index: from })
  }
  return { characters, source }
}

/** A slightly smaller rendering used when a word mixes capitals into its lowercase letters. */
export const MIXED_CASE_SCALE = 0.92

/** True when some word has a capital after its first letter and also a lowercase letter (`PEcK`). */
export const hasMixedInteriorCase = (text: string) => inkWords(text).some((word) => {
  const letters = [...word]
  if (letters.length < 3) return false
  const upper = (character: string) => character !== character.toLowerCase() && character === character.toUpperCase()
  const lower = (character: string) => character !== character.toUpperCase() && character === character.toLowerCase()
  return letters.slice(1).some(upper) && letters.some(lower)
})

/** True when the strings use the same letters and differ only in case. */
export const differsOnlyInCase = (left: string, right: string) => left !== right && left.toLowerCase() === right.toLowerCase()

const asciiUpperRun = (chars: string[], start: number, step: 1 | -1) => {
  let length = 0
  for (let index = start; index >= 0 && index < chars.length; index += step) {
    const character = chars[index]
    if (character < 'A' || character > 'Z') break
    length += 1
  }
  return length
}

/**
 * True when `alternate` uses the same letters as `base` and differs only in case,
 * apart from spaces that closed up between capital words of at least four letters
 * (`PEcK SNIFF` → `PECKSNIFF`). Ordinary spaces (`schlafen gehen`) stay put.
 */
export const sameLettersAllowingCapsJoin = (base: string, alternate: string) => {
  if (base === alternate) return false
  if (differsOnlyInCase(base, alternate)) return true
  const left = [...base]
  const right = [...alternate]
  let i = 0
  let j = 0
  while (i < left.length && j < right.length) {
    if (left[i].toLowerCase() === right[j].toLowerCase()) {
      i += 1
      j += 1
      continue
    }
    if (left[i] === ' ' && asciiUpperRun(right, j - 1, -1) >= 4 && asciiUpperRun(right, j, 1) >= 4) {
      i += 1
      continue
    }
    return false
  }
  return i === left.length && j === right.length
}
