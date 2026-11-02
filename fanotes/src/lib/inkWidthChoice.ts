/** When the default pen leaves a long word unknown, another width may read it as a dictionary word. */

const WORD = /[A-Za-zÄÖÜäöüß]+/gu

/** Nearby renderings tried when a long word is still unknown. The default 2.6 px reading comes first. */
export const INK_RETRY_VARIANTS = [
  { penWidth: 1.8, scale: 1 },
  { penWidth: 3, scale: 1 },
  { penWidth: 3.5, scale: 1 },
  { penWidth: 2.6, scale: 0.92 },
  { penWidth: 2.6, scale: 0.85 },
] as const

/** Smaller rendering that can repair one short word or a whole line of known words. */
export const NARROW_SCALE = 0.85

/** A single unknown word turning into a dictionary word has to beat the default by this many nats. */
export const NARROW_WORD_MARGIN = 0.5

/** Capitalizing only the first letter has to beat the current reading by this many nats. */
export const FIRST_LETTER_MARGIN = 0.6

/** Horizontal stretch tried when a period sits just before a closing bracket. */
export const BRACKET_STRETCH = 0.94

/** That stretch has to beat the current reading by this many nats to turn the period into a comma. */
export const BRACKET_COMMA_MARGIN = 0.5

/** Narrower line tried when a long word is still unknown. */
export const NARROW_STRETCH = 0.82

/** That narrower line has to beat the default reading by this many nats. */
export const NARROW_STRETCH_MARGIN = 7

/** A one-letter change to a long unknown word has to sit within this many nats of the top reading. */
export const LONG_LETTER_MARGIN = 0.8

/** A final letter becomes an apostrophe when that alternative is at least this confident. */
export const APOSTROPHE_ALT_MIN = 0.35

/** An `r` becomes `n` when that alternative is at least this confident. */
export const R_TO_N_MIN = 0.5

/** A word-final `D` becomes `B` when that alternative is at least this confident. */
export const D_TO_B_MIN = 0.4

/** A capital `F` becomes `f` when that alternative is at least this confident. */
export const F_TO_F_MIN = 0.25

/** An `a` becomes `ä` when that alternative is at least this confident. */
export const A_TO_AE_MIN = 0.9

/**
 * A dictionary word may grow by one letter from the upright reading when another rendering
 * was kept (`Marie` → `Marine`). Farther than this, the shorter word stands.
 */
export const KNOWN_INSERT_MARGIN = 1

/**
 * An unknown word ending in `kraft` may take the dictionary plural `kräfte` when a reading
 * within this many nats already added the final e (`luftstreitkrafte` is not a word).
 */
export const KRAFT_PLURAL_MARGIN = 2.9

/** A larger rendering that can turn one short dictionary word into a longer one (`Grad` → `Grund`). */
export const LARGER_SCALE = 1.15

const ADJECTIVE_ENDING = /(?:ischen|lichen)$/iu

/** A smaller line that keeps every known word has to beat the default by this many nats. */
export const NARROW_LINE_MARGIN = 5

/** The unknown word has to be at least this long before a second rendering is worth the time. */
export const LONG_UNKNOWN_LETTERS = 10

/** The other rendering has to beat the default reading by this many nats. */
export const WIDTH_RETRY_MARGIN = 2

/** A two-word merge has to beat the default reading by this many nats. */
export const MERGE_SCORE_MARGIN = 4

/** A small back-slant tried when the upright pen leaves two neighboring words wrong. */
export const INK_SHEAR_RETRY = -0.08

/** That slanted rendering has to beat the upright reading by this many nats. */
export const SHEAR_SCORE_MARGIN = 0.4

/** Copying one long unknown word out of another rendering requires this much of a lead. */
export const SPLICE_SCORE_MARGIN = 5

const SPLICE_MIN_LETTERS = 12

export const foldInkWord = (word: string) => word.toLowerCase().replaceAll('ß', 'ss')

export const inkWords = (text: string) => text.match(WORD) ?? []

const wordEdits = (left: string, right: string) => {
  const a = [...left]
  const b = [...right]
  const previous = Array.from({ length: b.length + 1 }, (_, index) => index)
  for (let i = 1; i <= a.length; i += 1) {
    let corner = previous[0]
    previous[0] = i
    for (let j = 1; j <= b.length; j += 1) {
      const next = previous[j]
      previous[j] = a[i - 1] === b[j - 1] ? corner : Math.min(previous[j] + 1, previous[j - 1] + 1, corner + 1)
      corner = next
    }
  }
  return previous[b.length]
}

/**
 * True when `alternate` rewrites exactly one dictionary word into a dictionary word one letter
 * longer, at edit distance 2, and changes nothing else (`Grad` → `Grund`).
 */
export const largerScaleGrowsOneWord = (
  base: string,
  alternate: string,
  known: (word: string) => boolean,
) => {
  const left = inkWords(base)
  const right = inkWords(alternate)
  if (left.length !== right.length || !left.length) return false
  const diffs: number[] = []
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) diffs.push(index)
  }
  if (diffs.length !== 1) return false
  const from = left[diffs[0]]
  const to = right[diffs[0]]
  if ([...to].length !== [...from].length + 1 || wordEdits(from, to) !== 2) return false
  if (!known(from) || !known(to) || from.toLowerCase() === to.toLowerCase()) return false
  return textWithWordEdits(base, [{ index: diffs[0], from, to }]) === alternate
}

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
 * True when `alternate` changes exactly one unknown word into a dictionary word
 * of nearly the same length (`Aneren` → `inneren`).
 */
export const oneUnknownWordBecomesKnown = (
  base: string,
  alternate: string,
  known: (word: string) => boolean,
) => {
  const left = inkWords(base)
  const right = inkWords(alternate)
  if (left.length !== right.length) return false
  const diffs: number[] = []
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) diffs.push(index)
  }
  if (diffs.length !== 1) return false
  const before = foldInkWord(left[diffs[0]])
  const after = foldInkWord(right[diffs[0]])
  return before.length >= 4 && !known(left[diffs[0]]) && known(right[diffs[0]]) && Math.abs(before.length - after.length) <= 3
}

/**
 * True when a smaller rendering keeps every known word, changes a long unknown word,
 * and moves any other unknown word by at most two letters
 * (`Nuklearenaie` → `Nuklearenergie`, `Erzeugge` → `Erzeugen`).
 */
export const narrowScaleKeepsKnownWords = (
  base: string,
  alternate: string,
  known: (word: string) => boolean,
) => {
  const left = inkWords(base)
  const right = inkWords(alternate)
  if (left.length !== right.length) return false
  let movedLong = false
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] === right[index]) continue
    if (known(left[index])) return false
    const before = foldInkWord(left[index])
    const after = foldInkWord(right[index])
    if (before.length >= LONG_UNKNOWN_LETTERS && Math.abs(before.length - after.length) <= 3) {
      movedLong = true
      continue
    }
    if (editDistance(before, after) <= 2) continue
    return false
  }
  return movedLong
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

const sameLetterThreeTimes = (word: string) => {
  const letters = [...word]
  return letters.length === 3 && letters[0] === letters[1] && letters[1] === letters[2]
}

/**
 * On a line of three-letter groups with one group that is not a repeated letter, the raw trace of
 * a smaller rendering replaces that group when it is three copies of one letter (`TAF` → `TTT`).
 * Groups that are already repeated must stay as they are.
 */
export const tripleLetterFromNarrowGreedy = (text: string, greedy: string): WordEdit | null => {
  const words = inkWords(text)
  const traced = inkWords(greedy)
  if (words.length < 3 || words.length !== traced.length) return null
  if (!words.every((word) => [...word].length === 3)) return null
  const odd: number[] = []
  for (let index = 0; index < words.length; index += 1) {
    if (!sameLetterThreeTimes(words[index])) odd.push(index)
  }
  if (odd.length !== 1) return null
  const index = odd[0]
  if (!sameLetterThreeTimes(traced[index]) || words[index] === traced[index]) return null
  for (let cursor = 0; cursor < words.length; cursor += 1) {
    if (cursor !== index && words[cursor] !== traced[cursor]) return null
  }
  return { index, from: words[index], to: traced[index] }
}

/** A line of three-letter groups with exactly one group that is not three copies of one letter. */
export const hasOneOddLetterGroup = (text: string) => {
  const words = inkWords(text)
  if (words.length < 3 || !words.every((word) => [...word].length === 3)) return false
  return words.filter((word) => !sameLetterThreeTimes(word)).length === 1
}

/**
 * The ink of one dictionary word, read on its own, replaces that word when the isolated reading
 * is a dictionary word exactly one letter longer (`Watched` → `Wretched`).
 */
export const longerKnownCropWord = (
  word: string,
  cropText: string,
  known: (word: string) => boolean,
): string | null => {
  const found = inkWords(cropText)
  if (found.length !== 1) return null
  const crop = found[0]
  if (!known(word) || !known(crop)) return null
  if ([...crop].length !== [...word].length + 1) return null
  if (wordEdits(word, crop) !== 2) return null
  return crop
}

/** `66 Erdkunde"` is the shape of two ticks read as digits in front of a word that already closes a quote. */
export const quotedWordAfterDoubleSix = (text: string) => /^66 [A-Za-zÄÖÜäöüß]+"/.test(text)

/**
 * The first two strokes are narrow tall ticks, with a wider gap before the next stroke.
 * A written 6 is wider than these ticks.
 */
export const leadingStrokesAreTicks = (packed: Float64Array) => {
  const strokes: Array<{ minX: number; maxX: number; minY: number; maxY: number }> = []
  for (let offset = 0; offset < packed.length;) {
    const count = packed[offset]
    let minX = Infinity
    let maxX = -Infinity
    let minY = Infinity
    let maxY = -Infinity
    for (let index = 0; index < count; index += 1) {
      const x = packed[offset + 1 + index * 2]
      const y = packed[offset + 2 + index * 2]
      minX = Math.min(minX, x)
      maxX = Math.max(maxX, x)
      minY = Math.min(minY, y)
      maxY = Math.max(maxY, y)
    }
    strokes.push({ minX, maxX, minY, maxY })
    offset += 1 + count * 2
  }
  strokes.sort((left, right) => left.minX - right.minX)
  if (strokes.length < 3) return false
  const tick = (stroke: { minX: number; maxX: number; minY: number; maxY: number }) => {
    const width = stroke.maxX - stroke.minX
    const height = stroke.maxY - stroke.minY
    return height >= 12 && width / Math.max(height, 1) <= 0.4
  }
  if (!tick(strokes[0]) || !tick(strokes[1])) return false
  const pairGap = strokes[1].minX - strokes[0].maxX
  const wordGap = strokes[2].minX - strokes[1].maxX
  return pairGap >= 0 && pairGap <= 24 && wordGap > pairGap
}

/** A later beam reading may lowercase one three-letter word when it is no worse than this. */
export const SHORT_CASE_MARGIN = 3

const letterSkeleton = (text: string) => text.replace(/[A-Za-zÄÖÜäöüß]+/gu, 'W')

/**
 * A non-initial three-letter word becomes lowercase when a close beam reading already has it
 * lowercase and the rest of the line matches (`Job` → `job`).
 */
export const lowercaseShortBeamWord = (
  text: string,
  readings: Array<{ text: string; score: number }>,
): WordEdit | null => {
  if (readings.length < 2) return null
  const top = readings[0]
  const words = inkWords(text)
  for (const reading of readings.slice(1)) {
    if (top.score - reading.score > SHORT_CASE_MARGIN) continue
    if (letterSkeleton(top.text) !== letterSkeleton(reading.text)) continue
    const left = inkWords(top.text)
    const right = inkWords(reading.text)
    if (left.length !== right.length || left.length !== words.length) continue
    const diffs: number[] = []
    for (let index = 0; index < left.length; index += 1) {
      if (left[index] !== right[index]) diffs.push(index)
    }
    if (diffs.length !== 1 || diffs[0] === 0) continue
    const index = diffs[0]
    const from = left[index]
    const to = right[index]
    if ([...from].length !== 3 || to !== from.toLowerCase() || from === to) continue
    if (from.slice(1) !== from.slice(1).toLowerCase()) continue
    if (words[index] !== from) continue
    return { index, from, to }
  }
  return null
}

/**
 * An English line may lowercase its first letter when a beam reading of the same line
 * is no worse than this. `Upward!` sits 2.46 nats away, so the margin stays below that.
 */
export const INITIAL_CASE_MARGIN = 1.5

/**
 * The lowercase letter has to be this visible in the first character. `wretched` is 0.24;
 * the capital `Upward` line that the beam also nearly lowercases is 0.21.
 */
export const INITIAL_CASE_ALT = 0.23

/**
 * Lowercase the first letter when the beam's top reading still starts with that capital,
 * a close reading is the same line already lowercase, that lowercase letter is visible,
 * and the word is in the dictionary (`Wretched` → `wretched`). German is excluded.
 * A name the dictionary does not contain stays (`Chudleigh`). A one-letter word and an
 * all-capital word stay as written.
 */
export const lowercaseInitialFromBeam = (
  text: string,
  readings: Array<{ text: string; score: number }>,
  language: string,
  characters: ReadonlyArray<{ char: string; alternatives?: ReadonlyArray<{ char: string; confidence: number }> }>,
  known: (word: string) => boolean,
): WordEdit | null => {
  if (language !== 'en' || readings.length < 2) return null
  const best = readings[0]
  if (!best?.text) return null
  const line = [...text]
  const beam = [...best.text]
  if (!line.length || !beam.length || line[0] !== beam[0]) return null
  const first = beam[0]
  const lower = first.toLowerCase()
  if (lower === first || [...lower].length !== 1) return null
  const lowered = lower + beam.slice(1).join('')
  const close = readings.some((reading) => reading.text === lowered && best.score - reading.score <= INITIAL_CASE_MARGIN)
  if (!close) return null
  const from = inkWords(text)[0]
  if (!from || from[0] !== first || !known(from)) return null
  const letters = [...from]
  if (letters.length < 2 || letters.slice(1).some((letter) => letter !== letter.toLowerCase())) return null
  const head = characters[0]
  const visible = head?.char === first && head.alternatives?.some((alternative) => alternative.char === lower && alternative.confidence >= INITIAL_CASE_ALT)
  if (!visible) return null
  const to = lower + letters.slice(1).join('')
  if (to === from) return null
  return { index: 0, from, to }
}

/** A lone English `i`, including `i'm`, is the pronoun (`i know` → `I know`). */
export const capitalizeEnglishPronoun = (text: string, language: string): WordEdit | null => {
  if (language !== 'en') return null
  const words = inkWords(text)
  for (let index = 0; index < words.length; index += 1) {
    if (words[index] === 'i') return { index, from: 'i', to: 'I' }
  }
  return null
}

/**
 * A raw trace that is the chosen word plus one letter becomes the dictionary word formed by
 * swapping one adjacent pair (`in` with trace `ien` → `ein`).
 */
export const transposedTraceWord = (
  text: string,
  greedy: string,
  known: (word: string) => boolean,
): WordEdit | null => {
  const words = inkWords(text)
  const traced = inkWords(greedy)
  if (words.length !== traced.length) return null
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index]
    const token = traced[index]
    if (known(word) || !oneInsertedLetter(word, token)) continue
    const letters = [...token]
    const found = new Set<string>()
    for (let cursor = 0; cursor < letters.length - 1; cursor += 1) {
      const swapped = letters.slice()
      const temporary = swapped[cursor]
      swapped[cursor] = swapped[cursor + 1]
      swapped[cursor + 1] = temporary
      const spelling = swapped.join('')
      if (spelling !== word && known(spelling)) found.add(spelling)
    }
    if (found.size !== 1) continue
    const to = [...found][0]
    if (to.toLowerCase() === word.toLowerCase()) continue
    return { index, from: word, to }
  }
  return null
}

/**
 * An unknown word takes the one confirmed personal spelling within two edits
 * (`Chudleyh` → `Chudleigh` after that name was confirmed). A dictionary word is left alone.
 */
export const personalNeighborEdits = (
  text: string,
  personal: readonly string[],
  baseKnown: (word: string) => boolean,
): WordEdit[] => {
  if (!personal.length) return []
  const edits: WordEdit[] = []
  const words = inkWords(text)
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index]
    if ([...word].length < 6 || baseKnown(word)) continue
    const folded = foldInkWord(word)
    const hits: string[] = []
    for (const candidate of personal) {
      const target = foldInkWord(candidate)
      if ([...target].length < 6) continue
      const distance = wordEdits(folded, target)
      if (distance === 0 || distance > 2) continue
      hits.push(target)
      if (hits.length > 1) break
    }
    if (hits.length !== 1) continue
    const letters = [...hits[0]]
    const source = [...word]
    if (source[0] !== source[0].toLowerCase()) letters[0] = letters[0].toUpperCase()
    const to = letters.join('')
    if (to === word) continue
    edits.push({ index, from: word, to })
  }
  return edits
}

/**
 * An unknown word gains the one final letter the raw trace added (`Chudley` → `Chudleyh`).
 * A known word such as `Soc` does not grow into `Soci`.
 */
export const trailingTracedLetter = (
  text: string,
  greedy: string,
  known: (word: string) => boolean,
): WordEdit | null => {
  const traced = inkWords(greedy)
  const words = inkWords(text)
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index]
    const wordChars = [...word]
    if (wordChars.length < 5 || known(word)) continue
    for (const token of traced) {
      const tokenChars = [...token]
      if (tokenChars.length !== wordChars.length + 1) continue
      if (tokenChars.slice(0, wordChars.length).join('') !== word) continue
      if (known(token)) continue
      return { index, from: word, to: token }
    }
  }
  return null
}

/**
 * `einen` takes `der` before a long capital word (`einen des Landschaftsgeräte` → `einen der`).
 * `des` after another word, as in `Sinne des` or `Vorgaben des`, stays.
 */
export const accusativeDer = (text: string): WordEdit | null => {
  const words = inkWords(text)
  for (let index = 1; index < words.length - 1; index += 1) {
    if (words[index] !== 'des' || words[index - 1] !== 'einen') continue
    const next = words[index + 1]
    const first = [...next][0]
    if (!first || [...next].length < 8) continue
    if (first !== first.toUpperCase() || first === first.toLowerCase()) continue
    return { index, from: 'des', to: 'der' }
  }
  return null
}

/** A heavier, slightly back-slanted rendering used on one separated group of a long unknown word. */
export const COMPOUND_PEN = 4.2
export const COMPOUND_SHEAR = -0.15
export const COMPOUND_SCALE = 0.75

/**
 * Two dictionary words joined in one unknown token, with the first at least eight letters
 * (`Landschaftsgeräte` → `landschafts` + `geräte`).
 */
export const dictionaryCompound = (
  word: string,
  known: (word: string) => boolean,
): { left: string; right: string } | null => {
  const letters = [...foldInkWord(word)]
  let best: { left: string; right: string } | null = null
  for (let index = 8; index <= letters.length - 3; index += 1) {
    const left = letters.slice(0, index).join('')
    const right = letters.slice(index).join('')
    if (!known(left) || !known(right)) continue
    if (!best || left.length > best.left.length) best = { left, right }
  }
  return best
}

/** Wide stroke groups separated by a gap, excluding a group that is almost the whole line. */
export const isolatedWideGroups = (packed: Float64Array): Float64Array[] => {
  const strokes: Array<{ start: number; end: number; minX: number; maxX: number; minY: number; maxY: number }> = []
  for (let offset = 0; offset < packed.length;) {
    const count = packed[offset]
    const end = offset + 1 + count * 2
    let minX = Infinity
    let maxX = -Infinity
    let minY = Infinity
    let maxY = -Infinity
    for (let index = 0; index < count; index += 1) {
      const x = packed[offset + 1 + index * 2]
      const y = packed[offset + 2 + index * 2]
      minX = Math.min(minX, x)
      maxX = Math.max(maxX, x)
      minY = Math.min(minY, y)
      maxY = Math.max(maxY, y)
    }
    strokes.push({ start: offset, end, minX, maxX, minY, maxY })
    offset = end
  }
  if (strokes.length < 4) return []
  const height = Math.max(1, Math.max(...strokes.map((stroke) => stroke.maxY)) - Math.min(...strokes.map((stroke) => stroke.minY)))
  const gap = Math.max(18, height * 0.55)
  const order = [...strokes].sort((left, right) => left.minX - right.minX)
  const groups: typeof strokes[] = []
  let current = [order[0]]
  for (let index = 1; index < order.length; index += 1) {
    if (order[index].minX - current[current.length - 1].maxX > gap) {
      groups.push(current)
      current = []
    }
    current.push(order[index])
  }
  groups.push(current)
  if (groups.length < 2) return []
  const chosen: Float64Array[] = []
  for (const group of groups) {
    const width = group[group.length - 1].maxX - group[0].minX
    if (group.length > strokes.length * 0.8 || width < 100) continue
    const total = group.reduce((sum, stroke) => sum + stroke.end - stroke.start, 0)
    const packedGroup = new Float64Array(total)
    let cursor = 0
    for (const stroke of group) {
      packedGroup.set(packed.subarray(stroke.start, stroke.end), cursor)
      cursor += stroke.end - stroke.start
    }
    chosen.push(packedGroup)
  }
  return chosen
}

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

/** Indexes of an `a` whose `ä` alternative is confident enough (`strasse` → `strässe`). */
export const aToAeIndexes = (
  characters: Array<{ char: string; alternatives?: Array<{ char: string; confidence: number }> }>,
): number[] => characters.flatMap((character, index) => {
  if (character.char !== 'a') return []
  const hit = character.alternatives?.some((alternative) => alternative.char === 'ä' && alternative.confidence >= A_TO_AE_MIN)
  return hit ? [index] : []
})

/** Indexes of a capital `F` whose lowercase alternative is confident enough (`Fifth` → `fifth`). */
export const fToLowerIndexes = (
  characters: Array<{ char: string; alternatives?: Array<{ char: string; confidence: number }> }>,
): number[] => characters.flatMap((character, index) => {
  if (character.char !== 'F') return []
  const hit = character.alternatives?.some((alternative) => alternative.char === 'f' && alternative.confidence >= F_TO_F_MIN)
  return hit ? [index] : []
})

const hasConfidentB = (
  character: { alternatives?: Array<{ char: string; confidence: number }> },
) => character.alternatives?.some((alternative) => alternative.char === 'B' && alternative.confidence >= D_TO_B_MIN) ?? false

const wordEndingAt = (
  characters: Array<{ char: string }>,
  index: number,
) => {
  let start = index
  while (start > 0 && /[A-Za-zÄÖÜäöüß]/u.test(characters[start - 1].char)) start -= 1
  return characters.slice(start, index + 1).map((character) => character.char).join('')
}

const mostlyCapitals = (word: string) => {
  const letters = [...word]
  if (letters.length < 6 || letters[0] === letters[0].toLowerCase()) return false
  let upper = 0
  for (const letter of letters) {
    if (letter === letter.toUpperCase() && letter !== letter.toLowerCase()) upper += 1
  }
  return upper >= 4
}

/**
 * A word-final `D` on a mostly capital word is a separate `B` (`JuDKIND` → `JuDKIN B`).
 */
export const separateFinalBIndexes = (
  characters: Array<{ char: string; alternatives?: Array<{ char: string; confidence: number }> }>,
): number[] => characters.flatMap((character, index) => {
  const next = characters[index + 1]?.char
  if (next && /[A-Za-zÄÖÜäöüß]/u.test(next)) return []
  if (character.char !== 'D' || !hasConfidentB(character)) return []
  return mostlyCapitals(wordEndingAt(characters, index)) ? [index] : []
})

/** Inserts a space and turns the chosen final `D` into `B`. Later indexes are applied first. */
export const charactersSeparatingFinalB = <T extends { char: string }>(
  characters: T[],
  indexes: number[],
): T[] => {
  let next = characters
  for (const index of [...indexes].sort((left, right) => right - left)) {
    const source = next[index]
    if (!source) continue
    next = [
      ...next.slice(0, index),
      { ...source, char: ' ' },
      { ...source, char: 'B' },
      ...next.slice(index + 1),
    ]
  }
  return next
}

/** Indexes of a word-final `D` whose `B` alternative is confident enough, outside a capital word. */
export const dToBIndexes = (
  characters: Array<{ char: string; alternatives?: Array<{ char: string; confidence: number }> }>,
): number[] => {
  const separated = new Set(separateFinalBIndexes(characters))
  return characters.flatMap((character, index) => {
    if (separated.has(index)) return []
    const next = characters[index + 1]?.char
    if (next && /[A-Za-zÄÖÜäöüß]/u.test(next)) return []
    if (character.char !== 'D' || !hasConfidentB(character)) return []
    return [index]
  })
}

/** Indexes of an `r` whose `n` alternative is confident enough (`Perdyce` → `Pendyce`). */
export const rToNIndexes = (
  characters: Array<{ char: string; alternatives?: Array<{ char: string; confidence: number }> }>,
): number[] => characters.flatMap((character, index) => {
  if (character.char !== 'r') return []
  const hit = character.alternatives?.some((alternative) => alternative.char === 'n' && alternative.confidence >= R_TO_N_MIN)
  return hit ? [index] : []
})

/**
 * Indexes of a word-final letter whose apostrophe alternative is confident enough
 * (`Soci` → `Soc'`).
 */
export const finalLetterApostropheIndexes = (
  characters: Array<{ char: string; alternatives?: Array<{ char: string; confidence: number }> }>,
): number[] => characters.flatMap((character, index) => {
  const next = characters[index + 1]?.char
  if (next && /[A-Za-zÄÖÜäöüß]/u.test(next)) return []
  if (!/[A-Za-zÄÖÜäöüß]/u.test(character.char)) return []
  const quote = character.alternatives?.some((alternative) => alternative.char === "'" && alternative.confidence >= APOSTROPHE_ALT_MIN)
  return quote ? [index] : []
})

/**
 * After an attributive adjective in `-ischen` or `-lichen`, an infinitive becomes the
 * `-ung` noun when both forms are in the dictionary (`großtechnischen Erzeugen` → `Erzeugung`).
 */
export const nounAfterAttributiveAdjective = (
  text: string,
  known: (word: string) => boolean,
): WordEdit | null => {
  const words = inkWords(text)
  for (let index = 1; index < words.length; index += 1) {
    if (!ADJECTIVE_ENDING.test(words[index - 1])) continue
    const word = words[index]
    if (word.length < 6 || !word.toLowerCase().endsWith('en')) continue
    const noun = `${word.slice(0, -2)}ung`
    if (!known(word) || !known(noun)) continue
    return { index, from: word, to: noun }
  }
  return null
}

const UMLAUTS: Record<string, string> = { a: 'ä', o: 'ö', u: 'ü', A: 'Ä', O: 'Ö', U: 'Ü' }
const SUBSTITUTES = 'abcdefghijklmnopqrstuvwxyzäöü'

/**
 * An unknown word with a capital after its first letter takes its one same-length dictionary
 * neighbor of two substitutions, keeping the case of every unchanged letter
 * (`EwtopEan` → `EuropEan`).
 */
export const interiorCapitalNeighbor = (
  text: string,
  known: (word: string) => boolean,
): WordEdit | null => {
  const words = inkWords(text)
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index]
    const letters = [...word]
    if (letters.length < 5 || known(word)) continue
    if (!letters.slice(1).some((letter) => letter === letter.toUpperCase() && letter !== letter.toLowerCase())) continue
    if (!letters.some((letter) => letter === letter.toLowerCase() && letter !== letter.toUpperCase())) continue
    const folded = [...foldInkWord(word)]
    if (folded.length !== letters.length) continue
    const hits: string[] = []
    let ambiguous = false
    scan: for (let left = 0; left < folded.length; left += 1) {
      for (let right = left + 1; right < folded.length; right += 1) {
        for (const first of SUBSTITUTES) {
          if (first === folded[left]) continue
          for (const second of SUBSTITUTES) {
            if (second === folded[right]) continue
            const candidate = folded.slice()
            candidate[left] = first
            candidate[right] = second
            const spelling = candidate.join('')
            if (!known(spelling)) continue
            hits.push(spelling)
            if (hits.length > 1) {
              ambiguous = true
              break scan
            }
          }
        }
      }
    }
    if (ambiguous || hits.length !== 1) continue
    const target = [...hits[0]]
    const next = letters.slice()
    for (let cursor = 0; cursor < folded.length; cursor += 1) {
      if (folded[cursor] === target[cursor]) continue
      const replacement = target[cursor]
      const capital = letters[cursor] === letters[cursor].toUpperCase() && letters[cursor] !== letters[cursor].toLowerCase()
      next[cursor] = capital ? replacement.toUpperCase() : replacement
    }
    const rewritten = next.join('')
    if ([...rewritten].length !== letters.length) continue
    return { index, from: word, to: rewritten }
  }
  return null
}

/**
 * An unknown word becomes the one dictionary spelling that adds an umlaut and changes one
 * other letter (`entlauscht` → `enttäuscht`). Any other pair of substitutions is left alone.
 */
export const umlautAndOneOtherLetter = (
  text: string,
  known: (word: string) => boolean,
): WordEdit | null => {
  const words = inkWords(text)
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index]
    const chars = [...word]
    if (chars.length < 6 || known(word)) continue
    const hits = new Set<string>()
    for (let vowel = 0; vowel < chars.length; vowel += 1) {
      const umlaut = UMLAUTS[chars[vowel]]
      if (!umlaut) continue
      for (let other = 0; other < chars.length; other += 1) {
        if (other === vowel) continue
        for (const letter of SUBSTITUTES) {
          if (letter === chars[other]) continue
          const next = chars.slice()
          next[vowel] = umlaut
          next[other] = letter
          const candidate = next.join('')
          if (known(candidate)) hits.add(candidate)
        }
      }
    }
    if (hits.size !== 1) continue
    return { index, from: word, to: [...hits][0] }
  }
  return null
}

const DETERMINERS = new Set(['das', 'der', 'die', 'den', 'dem', 'des', 'ein', 'eine', 'einem', 'einen', 'einer'])
const NOUN_SUFFIX = /(?:fon|ung|heit|keit|schaft|tum|nis|ion)$/iu

/**
 * A lowercase dictionary noun after a determiner takes a capital (`das mikrofon` → `Mikrofon`).
 * The ending has to be a noun suffix, so an adjective such as `das folgende` stays lowercase.
 */
export const capitalizedNounAfterDeterminer = (
  text: string,
  known: (word: string) => boolean,
): WordEdit | null => {
  const words = inkWords(text)
  for (let index = 1; index < words.length; index += 1) {
    if (!DETERMINERS.has(words[index - 1].toLowerCase())) continue
    const word = words[index]
    if ([...word].length < 6 || word !== word.toLowerCase() || !NOUN_SUFFIX.test(word) || !known(word)) continue
    const head = word[0].toUpperCase()
    if (head === word[0] || [...head].length !== 1) continue
    return { index, from: word, to: `${head}${word.slice(1)}` }
  }
  return null
}

const SENTENCE_ADVERBS = new Set([
  'manchmal', 'häufig', 'leider', 'gestern', 'heute', 'morgen', 'schließlich',
  'natürlich', 'eigentlich', 'trotzdem', 'dennoch', 'allerdings', 'außerdem',
  'zunächst', 'immerhin', 'jedenfalls',
])

/** A sentence adverb at the start of a line takes a capital (`manchmal` → `Manchmal`). */
export const capitalizedSentenceAdverb = (text: string): WordEdit | null => {
  const words = inkWords(text)
  const word = words[0]
  if (!word || !SENTENCE_ADVERBS.has(word)) return null
  const head = word[0].toUpperCase()
  if (head === word[0] || [...head].length !== 1) return null
  return { index: 0, from: word, to: `${head}${word.slice(1)}` }
}

/**
 * A word that is already almost all capitals loses its one lowercase letter
 * (`JuDKINB` → `JUDKINB`). A normal mixed-case word keeps its lowercase letters.
 */
export const capitalizeLoneLowercase = (text: string): WordEdit | null => {
  const words = inkWords(text)
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index]
    const letters = [...word]
    if (letters.length < 6 || letters[0] === letters[0].toLowerCase()) continue
    let lower = 0
    let upper = 0
    for (const letter of letters) {
      if (letter !== letter.toUpperCase() && letter === letter.toLowerCase()) lower += 1
      else if (letter === letter.toUpperCase() && letter !== letter.toLowerCase()) upper += 1
    }
    if (lower !== 1 || upper < 4) continue
    const changed = letters.map((letter) => letter.toUpperCase()).join('')
    if ([...changed].length !== letters.length) continue
    return { index, from: word, to: changed }
  }
  return null
}

/** Mid-sentence `Sein` is the verb, unless an article marks the noun (`das Sein`). */
export const lowercaseVerbSein = (text: string): WordEdit | null => {
  const words = inkWords(text)
  for (let index = 1; index < words.length; index += 1) {
    if (words[index] !== 'Sein' || DETERMINERS.has(words[index - 1].toLowerCase())) continue
    return { index, from: 'Sein', to: 'sein' }
  }
  return null
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

/**
 * True when `alternate` rewrites exactly two neighboring words of at least four letters
 * and leaves every other word as it was (`Waten tauscht` → `Welt entlauscht`).
 */
export const shearReadingRewritesTwoWords = (base: string, alternate: string) => {
  const left = inkWords(base)
  const right = inkWords(alternate)
  if (left.length !== right.length || left.length < 2) return false
  const diffs: number[] = []
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) diffs.push(index)
  }
  if (diffs.length !== 2 || diffs[1] !== diffs[0] + 1) return false
  const longEnough = (word: string) => word.length >= 4
  return longEnough(left[diffs[0]]) && longEnough(right[diffs[0]])
    && longEnough(left[diffs[1]]) && longEnough(right[diffs[1]])
}

/**
 * True when a known word changes only in case and every other change is an unknown word
 * (`Man` → `man`, `Landstatisters` → `Landschottenstrasse`).
 */
export const stretchedReadingKeepsKnownWords = (
  base: string,
  alternate: string,
  known: (word: string) => boolean,
) => {
  const left = inkWords(base)
  const right = inkWords(alternate)
  if (left.length !== right.length || left.join('\0') === right.join('\0')) return false
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] === right[index]) continue
    if (known(left[index]) && foldInkWord(left[index]) !== foldInkWord(right[index])) return false
  }
  return true
}

/**
 * The closest reading within {@link LONG_LETTER_MARGIN} that changes one letter of one
 * unknown word of at least 12 letters (`Kolbenningspannung` → `Kolbenringspannung`).
 * Other words in that reading are left as the chosen line has them.
 */
export const oneLetterInALongUnknownWord = (
  text: string,
  readings: Array<{ text: string; score: number }>,
  known: (word: string) => boolean,
): WordEdit | null => {
  const selected = inkWords(text)
  const top = readings[0]?.score
  if (top === undefined || !selected.length) return null
  let best: { gap: number; edit: WordEdit } | null = null
  for (const reading of readings) {
    const gap = top - reading.score
    if (gap <= 0 || gap > LONG_LETTER_MARGIN) continue
    const alternate = inkWords(reading.text)
    if (alternate.length !== selected.length) continue
    const hits: WordEdit[] = []
    for (let index = 0; index < selected.length; index += 1) {
      const left = selected[index]
      const right = alternate[index]
      if (left === right || left.length < 12 || left.length !== right.length || known(left)) continue
      let diffs = 0
      for (let cursor = 0; cursor < left.length; cursor += 1) if (left[cursor] !== right[cursor]) diffs += 1
      if (diffs === 1) hits.push({ index, from: left, to: right })
    }
    if (hits.length !== 1) continue
    if (!best || gap < best.gap) best = { gap, edit: hits[0] }
  }
  return best?.edit ?? null
}

const oneInsertedLetter = (shorter: string, longer: string) => {
  const left = [...shorter]
  const right = [...longer]
  if (right.length !== left.length + 1) return false
  let index = 0
  while (index < left.length && left[index] === right[index]) index += 1
  return right.slice(index + 1).join('') === left.slice(index).join('')
}

/**
 * When a later rendering replaced the upright line, keep a one-letter dictionary insertion
 * from a close upright reading (`Marie luft statut` kept beside `luftstreitkraft` → `Marine`).
 * The shorter word stays when the line did not change, or when either spelling is unknown.
 */
export const insertedLetterInOneKnownWord = (
  base: string,
  current: string,
  readings: Array<{ text: string; score: number }>,
  known: (word: string) => boolean,
): WordEdit | null => {
  if (current === base) return null
  const baseWords = inkWords(base)
  const currentWords = inkWords(current)
  const top = readings[0]?.score
  if (top === undefined || !baseWords.length) return null
  let best: { gap: number; edit: WordEdit } | null = null
  for (const reading of readings) {
    const gap = top - reading.score
    if (gap <= 0 || gap > KNOWN_INSERT_MARGIN) continue
    const alternate = inkWords(reading.text)
    if (alternate.length !== baseWords.length) continue
    const hits: WordEdit[] = []
    for (let index = 0; index < baseWords.length; index += 1) {
      const from = baseWords[index]
      const to = alternate[index]
      if (!oneInsertedLetter(from, to) || !known(from) || !known(to)) continue
      if (currentWords[index] !== from) continue
      hits.push({ index, from, to })
    }
    if (hits.length !== 1) continue
    if (!best || gap < best.gap) best = { gap, edit: hits[0] }
  }
  return best?.edit ?? null
}

/**
 * A capital dictionary word absorbs the next long lowercase unknown word
 * (`Marine luftstreitkraft` → `Marineluftstreitkraft`). A following capital stays
 * apart (`österreichischen Fußballnationalmannschaft`), and a shorter lowercase
 * word stays apart (`Welt entlauscht`).
 */
export const capitalCompoundIndex = (
  text: string,
  known: (word: string) => boolean,
): number | null => {
  const spans = [...text.matchAll(WORD)]
  for (let index = 0; index < spans.length - 1; index += 1) {
    const left = spans[index]
    const right = spans[index + 1]
    if (left.index === undefined || right.index === undefined) continue
    if (text.slice(left.index + left[0].length, right.index) !== ' ') continue
    const head = left[0]
    const tail = right[0]
    if (head[0] === head[0].toLowerCase() || tail[0] !== tail[0].toLowerCase()) continue
    if ([...head].length < 4 || [...tail].length < SPLICE_MIN_LETTERS) continue
    if (!known(head) || known(tail)) continue
    return index
  }
  return null
}

const KRAFT = 'kraft'
const KRAEFTE = 'kräfte'

/**
 * When a close reading adds a final e to an unknown word ending in `kraft`, spell that plural
 * as `kräfte`. The e may sit on the word alone or on a compound that absorbed it
 * (`Marineluftstreitkraft` → `Marineluftstreitkräfte`). A dictionary word stays singular.
 */
export const kraftPluralFromReading = (
  text: string,
  readings: Array<{ text: string; score: number }>,
  known: (word: string) => boolean,
): WordEdit | null => {
  const top = readings[0]
  if (!top) return null
  const topWords = inkWords(top.text)
  const current = inkWords(text)
  let best: { gap: number; edit: WordEdit } | null = null
  for (const reading of readings) {
    const gap = top.score - reading.score
    if (gap <= 0 || gap > KRAFT_PLURAL_MARGIN) continue
    const alternate = inkWords(reading.text)
    if (alternate.length !== topWords.length) continue
    const diffs: number[] = []
    for (let index = 0; index < topWords.length; index += 1) {
      if (topWords[index] !== alternate[index]) diffs.push(index)
    }
    if (diffs.length !== 1) continue
    const stem = topWords[diffs[0]]
    if ([...stem].length < 8 || !stem.endsWith(KRAFT) || known(stem) || alternate[diffs[0]] !== `${stem}e`) continue
    const hits: WordEdit[] = []
    for (let index = 0; index < current.length; index += 1) {
      const word = current[index]
      if (known(word) || !word.endsWith(stem)) continue
      hits.push({ index, from: word, to: `${word.slice(0, -KRAFT.length)}${KRAEFTE}` })
    }
    if (hits.length !== 1) continue
    if (!best || gap < best.gap) best = { gap, edit: hits[0] }
  }
  return best?.edit ?? null
}

/** Drops the single space between word `index` and the next word. */
export const charactersJoiningWords = <T extends { char: string }>(
  characters: T[],
  index: number,
): T[] | null => {
  const runs = letterRuns(characters)
  const left = runs[index]
  const right = runs[index + 1]
  if (!left || !right) return null
  const between = characters.slice(left.end, right.start)
  if (between.length !== 1 || between[0].char !== ' ') return null
  return [...characters.slice(0, left.end), ...characters.slice(right.start)]
}

/** Replaces one word inside `characters`. Extra letters reuse the last glyph of that word. */
export const rewriteWord = <T extends { char: string }>(
  characters: T[],
  index: number,
  to: string,
): T[] | null => {
  const runs: Array<{ start: number; end: number }> = []
  let cursor = 0
  while (cursor < characters.length) {
    if (!/[A-Za-zÄÖÜäöüß]/u.test(characters[cursor].char)) {
      cursor += 1
      continue
    }
    const start = cursor
    while (cursor < characters.length && /[A-Za-zÄÖÜäöüß]/u.test(characters[cursor].char)) cursor += 1
    runs.push({ start, end: cursor })
  }
  const run = runs[index]
  if (!run || run.end === run.start) return null
  const letters = [...to]
  const next = characters.slice(0, run.start)
  letters.forEach((char, offset) => {
    const source = characters[Math.min(run.start + offset, run.end - 1)]
    next.push({ ...source, char })
  })
  next.push(...characters.slice(run.end))
  return next
}

/** Replaces one same-length word inside `characters`, leaving every other glyph as it was. */
export const rewriteSameLengthWord = <T extends { char: string }>(
  characters: T[],
  index: number,
  to: string,
): T[] | null => {
  const runs: Array<{ start: number; end: number }> = []
  let cursor = 0
  while (cursor < characters.length) {
    if (!/[A-Za-zÄÖÜäöüß]/u.test(characters[cursor].char)) {
      cursor += 1
      continue
    }
    const start = cursor
    while (cursor < characters.length && /[A-Za-zÄÖÜäöüß]/u.test(characters[cursor].char)) cursor += 1
    runs.push({ start, end: cursor })
  }
  const run = runs[index]
  if (!run || run.end - run.start !== [...to].length) return null
  const next = characters.slice()
  ;[...to].forEach((char, offset) => {
    next[run.start + offset] = { ...next[run.start + offset], char }
  })
  return next
}

/** True when `alternate` turns a period directly before `]` into a comma and changes nothing else (`[Kidney.]` → `[Kidney,]`). */
export const replacesBracketPeriodWithComma = (base: string, alternate: string) => {
  const left = [...base]
  const right = [...alternate]
  if (left.length < 2 || left.length !== right.length) return false
  let changed = false
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] === right[index]) continue
    if (left[index] === '.' && right[index] === ',' && left[index + 1] === ']') {
      changed = true
      continue
    }
    return false
  }
  return changed
}

/** True when `alternate` capitalizes the first letter and leaves every other character as it was (`dumdum` → `Dumdum`). */
export const capitalizesOnlyTheFirstLetter = (base: string, alternate: string) => {
  const left = [...base]
  const right = [...alternate]
  if (left.length < 2 || left.length !== right.length || left[0] === right[0]) return false
  if (left[0] === left[0].toUpperCase() || left[0].toUpperCase() !== right[0]) return false
  return left.slice(1).every((character, index) => character === right[index + 1])
}

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

type CorrectedChar = { char: string }

const withWord = <T extends CorrectedChar>(
  characters: T[],
  text: string,
  edit: WordEdit,
  rewrite: (characters: T[], index: number, to: string) => T[] | null,
) => {
  const rewritten = rewrite(characters, edit.index, edit.to)
  const nextText = textWithWordEdits(text, [edit])
  if (!rewritten || nextText === text) return null
  return { characters: rewritten, text: nextText }
}

/**
 * Text corrections that follow one decode: character alternatives, trace repairs, and personal
 * spellings. Style fitting scores this text, the same corrections a finished line keeps.
 */
export const finalizeInkLineText = <T extends CorrectedChar>(
  decoded: {
    text: string
    greedyText: string
    characters: T[]
    readings: Array<{ text: string; score: number }>
  },
  known: (word: string) => boolean,
  options: { personal?: readonly string[]; baseKnown?: (word: string) => boolean; language?: string } = {},
) => {
  let text = decoded.text
  let characters = decoded.characters
  const take = (edit: WordEdit | null, rewrite: (characters: T[], index: number, to: string) => T[] | null) => {
    if (!edit) return
    const next = withWord(characters, text, edit, rewrite)
    if (!next) return
    text = next.text
    characters = next.characters
  }
  take(oneLetterInALongUnknownWord(text, decoded.readings, known), rewriteSameLengthWord)
  for (const index of aToAeIndexes(characters)) {
    characters = characters.map((character, cursor) => cursor === index ? { ...character, char: 'ä' } : character)
    text = characters.map((character) => character.char).join('')
  }
  for (const index of fToLowerIndexes(characters)) {
    characters = characters.map((character, cursor) => cursor === index ? { ...character, char: 'f' } : character)
    text = characters.map((character) => character.char).join('')
  }
  const separated = separateFinalBIndexes(characters)
  if (separated.length) {
    const next = charactersSeparatingFinalB(characters, separated)
    if (next) {
      characters = next
      text = characters.map((character) => character.char).join('')
    }
  }
  for (const index of dToBIndexes(characters)) {
    characters = characters.map((character, cursor) => cursor === index ? { ...character, char: 'B' } : character)
    text = characters.map((character) => character.char).join('')
  }
  for (const index of rToNIndexes(characters)) {
    characters = characters.map((character, cursor) => cursor === index ? { ...character, char: 'n' } : character)
    text = characters.map((character) => character.char).join('')
  }
  for (const index of finalLetterApostropheIndexes(characters)) {
    characters = characters.map((character, cursor) => cursor === index ? { ...character, char: "'" } : character)
    text = characters.map((character) => character.char).join('')
  }
  take(capitalizedSentenceAdverb(text), rewriteSameLengthWord)
  take(capitalizeLoneLowercase(text), rewriteSameLengthWord)
  take(lowercaseVerbSein(text), rewriteSameLengthWord)
  take(interiorCapitalNeighbor(text, known), rewriteSameLengthWord)
  take(umlautAndOneOtherLetter(text, known), rewriteSameLengthWord)
  take(capitalizedNounAfterDeterminer(text, known), rewriteSameLengthWord)
  take(nounAfterAttributiveAdjective(text, known), rewriteWord)
  const baseKnown = options.baseKnown ?? known
  for (const edit of personalNeighborEdits(text, options.personal ?? [], baseKnown)) take(edit, rewriteWord)
  take(transposedTraceWord(text, decoded.greedyText, known), rewriteWord)
  take(trailingTracedLetter(text, decoded.greedyText, known), rewriteWord)
  take(accusativeDer(text), rewriteSameLengthWord)
  take(lowercaseShortBeamWord(text, decoded.readings), rewriteSameLengthWord)
  take(lowercaseInitialFromBeam(text, decoded.readings, options.language ?? '', characters, baseKnown), rewriteSameLengthWord)
  take(capitalizeEnglishPronoun(text, options.language ?? ''), rewriteSameLengthWord)
  return { text, characters }
}
