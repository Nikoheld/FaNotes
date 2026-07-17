import { ENGLISH_COMMON_WORDS } from '../../../src/data/englishLanguage'
import { GERMAN_COMMON_WORDS } from '../../../src/data/germanLanguage'
import { normalizeGermanSharpS } from '../../../src/lib/orthography'
import type { RecognitionLanguage } from '../../../src/lib/recognition'

const LANGUAGE_WORDS = {
  de: GERMAN_COMMON_WORDS,
  en: ENGLISH_COMMON_WORDS,
}
const LANGUAGE_WORD_LISTS = {
  de: [...GERMAN_COMMON_WORDS],
  en: [...ENGLISH_COMMON_WORDS],
}
const LANGUAGE_WORD_RANKS = {
  de: new Map(LANGUAGE_WORD_LISTS.de.map((word, index) => [word, index])),
  en: new Map(LANGUAGE_WORD_LISTS.en.map((word, index) => [word, index])),
}

type ExtendedWordIndex = Map<number, readonly string[]>
const EXTENDED_WORDS: Partial<Record<RecognitionLanguage, ExtendedWordIndex>> = {}

export type NeuralWordContextCandidate = {
  candidate: string
  distance: number
}

export const installNeuralWordContextCandidates = (
  language: RecognitionLanguage,
  words: readonly string[],
) => {
  const byLength: ExtendedWordIndex = new Map()
  words.forEach((word) => {
    const length = Array.from(word).length
    const bucket = byLength.get(length)
    if (bucket) (bucket as string[]).push(word)
    else byLength.set(length, [word])
  })
  byLength.forEach((bucket) => {
    (bucket as string[]).sort((first, second) => first.localeCompare(second, language))
  })
  EXTENDED_WORDS[language] = byLength
}

const sortedIncludes = (words: readonly string[], source: string, language: RecognitionLanguage) => {
  let low = 0
  let high = words.length - 1
  while (low <= high) {
    const middle = (low + high) >>> 1
    const value = words[middle]
    if (value === source) return true
    if (value.localeCompare(source, language) < 0) low = middle + 1
    else high = middle - 1
  }
  return false
}

export const isExtendedNeuralContextWord = (
  source: string,
  language: RecognitionLanguage,
) => {
  const words = EXTENDED_WORDS[language]?.get(Array.from(source).length)
  return Boolean(words && sortedIncludes(words, source, language))
}

export const nearestNeuralWordContextCandidates = (
  source: string,
  language: RecognitionLanguage,
  maximumDistance = 1,
  sameLengthOnly = false,
): NeuralWordContextCandidate[] => {
  const index = EXTENDED_WORDS[language]
  if (!index) return []
  const sourceLength = Array.from(source).length
  const candidates: NeuralWordContextCandidate[] = []
  const minimumLength = sameLengthOnly ? sourceLength : Math.max(3, sourceLength - maximumDistance)
  const maximumLength = sameLengthOnly ? sourceLength : sourceLength + maximumDistance
  for (let length = minimumLength; length <= maximumLength; length += 1) {
    const words = index.get(length) ?? []
    words.forEach((candidate) => {
      const distance = wordDistance(source, candidate)
      if (distance <= maximumDistance) candidates.push({ candidate, distance })
    })
  }
  return candidates.sort((first, second) => (
    first.distance - second.distance || first.candidate.localeCompare(second.candidate, language)
  ))
}

export const wordDistance = (first: string, second: string) => {
  const previous = Array.from({ length: second.length + 1 }, (_, index) => index)
  const current = new Array<number>(second.length + 1)
  for (let firstIndex = 1; firstIndex <= first.length; firstIndex += 1) {
    current[0] = firstIndex
    for (let secondIndex = 1; secondIndex <= second.length; secondIndex += 1) {
      const substitution = previous[secondIndex - 1] + Number(first[firstIndex - 1] !== second[secondIndex - 1])
      current[secondIndex] = Math.min(
        previous[secondIndex] + 1,
        current[secondIndex - 1] + 1,
        substitution,
      )
    }
    previous.splice(0, previous.length, ...current)
  }
  return previous[second.length]
}

export const preserveWordCase = (source: string, replacement: string, locale: RecognitionLanguage) => {
  if (source === source.toLocaleUpperCase(locale)) return replacement.toLocaleUpperCase(locale)
  if (source[0] === source[0]?.toLocaleUpperCase(locale)) {
    return replacement[0]?.toLocaleUpperCase(locale) + replacement.slice(1)
  }
  return replacement
}

/** Corrects only close dictionary neighbours; unknown names and technical terms remain untouched. */
export const applyNeuralWordContext = (text: string, language: RecognitionLanguage) => {
  const locale = language === 'de' ? 'de' : 'en'
  const lexicon = LANGUAGE_WORDS[language]
  const words = LANGUAGE_WORD_LISTS[language]
  const ranks = LANGUAGE_WORD_RANKS[language]
  const pattern = language === 'de' ? /[A-Za-zÄÖÜäöü]{2,}/gu : /[A-Za-z]{2,}/gu
  let corrected = normalizeGermanSharpS(text)
  for (let pass = 0; pass < 2; pass += 1) {
    let changed = false
    corrected = corrected.replace(pattern, (source, offset: number, complete: string) => {
      const lower = source.toLocaleLowerCase(locale)
      if (
        lexicon.has(lower) ||
        lower.length < 3 ||
        /\p{Ll}\p{Lu}/u.test(source)
      ) return source
      const prefix = complete.slice(0, offset)
      const beginsSentence = !/\p{L}/u.test(prefix) || /[.!?]\s*$/u.test(prefix)
      const titleCase = source[0] === source[0]?.toLocaleUpperCase(locale)
        && source.slice(1) === source.slice(1).toLocaleLowerCase(locale)
      if (titleCase && !beginsSentence) return source

      const maximumDistance = lower.length >= 5 ? 2 : 1
      const ranked = words
        .filter((candidate) => Math.abs(candidate.length - lower.length) <= maximumDistance)
        .map((candidate) => ({
          candidate,
          distance: wordDistance(lower, candidate),
          lengthDifference: Math.abs(candidate.length - lower.length),
          rank: ranks.get(candidate) ?? words.length,
        }))
        .filter(({ distance }) => distance <= maximumDistance)
        .sort((first, second) => (
          first.distance - second.distance
          || first.lengthDifference - second.lengthDifference
          || first.rank - second.rank
        ))
      const best = ranked[0]
      const runnerUp = ranked[1]
      if (!best) return source
      const unambiguousDistance = !runnerUp || runnerUp.distance > best.distance
      const rankLead = runnerUp
        ? (runnerUp.rank - best.rank) / Math.max(1, words.length)
        : 1
      const safeSingleEdit = best.distance === 1 && (unambiguousDistance || rankLead >= 0.012)
      const safeLongRepair = (
        best.distance === 2
        && lower.length >= 7
        && (unambiguousDistance || rankLead >= 0.035)
      )
      // Short line-model insertions such as “unathe” → “mathe” need two
      // edits even though the intended word is only five characters long.
      // Permit that case only when the compact language model has exactly one
      // nearest neighbour and the candidate differs in length by at most one;
      // ambiguous names and technical terms remain untouched.
      const safeShortUnambiguousRepair = (
        best.distance === 2
        && lower.length >= 5
        && best.lengthDifference <= 1
        && unambiguousDistance
      )
      if (titleCase && best.distance >= 2) return source
      if (safeSingleEdit || safeLongRepair || safeShortUnambiguousRepair) {
        changed = true
        return preserveWordCase(source, best.candidate, language)
      }

      return source
    })
    if (!changed) break
  }
  return corrected
}

/** Applies exhaustive-dictionary substitutions only after all visual models
 * have been compared. Running this during model assessment would turn a bad
 * raw hypothesis into a plausible word and suppress a better fallback. */
export const applyFinalNeuralWordContext = (text: string, language: RecognitionLanguage) => {
  const locale = language === 'de' ? 'de-CH' : 'en-US'
  const lexicon = LANGUAGE_WORDS[language]
  const pattern = language === 'de' ? /[A-Za-zÄÖÜäöü]{3,}/gu : /[A-Za-z]{3,}/gu
  const protectedWords: string[] = []
  const protectedText = normalizeGermanSharpS(text).replace(pattern, (source) => {
    const lower = source.toLocaleLowerCase(locale)
    if (!isExtendedNeuralContextWord(lower, language)) return source
    const index = protectedWords.push(source) - 1
    return `\uE000${index}\uE001`
  })
  const corrected = applyNeuralWordContext(protectedText, language).replace(pattern, (source) => {
    const lower = source.toLocaleLowerCase(locale)
    if (
      lexicon.has(lower) ||
      isExtendedNeuralContextWord(lower, language) ||
      /\p{Ll}\p{Lu}/u.test(source)
    ) return source
    const maximumDistance = lower.length >= 7 ? 2 : 1
    const candidates = nearestNeuralWordContextCandidates(lower, language, maximumDistance, false)
    const singleEditSameLength = candidates.filter((entry) => (
      entry.distance === 1 && entry.candidate.length === lower.length
    ))
    const lengthHallucinations = candidates.filter((entry) => (
      entry.distance === 2 && Math.abs(entry.candidate.length - lower.length) >= 1
    ))
    const uniqueSingleEdit = (
      singleEditSameLength.length === 1
    )
    // Repeated short fragments from a line decoder can add one or two
    // characters (for example “tableelle”). Repair that only for a long,
    // unknown word with one unambiguous full-dictionary neighbour. Existing
    // valid words, names and equal-length substitutions never enter here.
    const uniqueLengthHallucination = (
      lower.length >= 7 &&
      !candidates.some((entry) => entry.distance === 1) &&
      lengthHallucinations.length === 1
    )
    if (!uniqueSingleEdit && !uniqueLengthHallucination) return source
    const replacement = uniqueSingleEdit ? singleEditSameLength[0] : lengthHallucinations[0]
    const titleCase = source[0] === source[0]?.toLocaleUpperCase(locale)
      && source.slice(1) === source.slice(1).toLocaleLowerCase(locale)
    if (titleCase && replacement.distance >= 2) return source
    return preserveWordCase(source, replacement.candidate, language)
  })
  return corrected.replace(/\uE000(\d+)\uE001/gu, (_marker, rawIndex: string) => (
    protectedWords[Number(rawIndex)] ?? ''
  ))
}

/** Uses the independently measured number of handwritten characters to
 * remove a single line-decoder insertion. A three-edit repair is deliberately
 * limited to one long, common word of exactly the measured length; the full
 * spelling dictionary alone is not allowed to guess names or specialist
 * terms. */
export const applyMeasuredNeuralWordContext = (
  text: string,
  language: RecognitionLanguage,
  measuredCharacterCount?: number,
) => {
  const rawNormalized = normalizeGermanSharpS(text).trim()
  const wordParts = rawNormalized.split(/\s+/u)
  // A line decoder can insert one short pseudo-word at the end of a long
  // handwritten word (for example "korrekt vor"). Compact that boundary only
  // when the first fragment is already substantial; short genuine phrases
  // such as "das ist" retain their spacing.
  const normalized = (
    !/\r?\n/u.test(rawNormalized) &&
    wordParts.length === 2 &&
    Array.from(wordParts[0]).length >= 4
  )
    ? wordParts.join('')
    : rawNormalized
  const pattern = language === 'de' ? /^[A-Za-zÄÖÜäöü]+$/u : /^[A-Za-z]+$/u
  if (!measuredCharacterCount || measuredCharacterCount < 8 || !pattern.test(normalized)) return normalized
  const locale = language === 'de' ? 'de-CH' : 'en-US'
  const lower = normalized.toLocaleLowerCase(locale)
  const sourceLength = Array.from(lower).length
  if (
    Math.abs(sourceLength - measuredCharacterCount) !== 1 ||
    LANGUAGE_WORDS[language].has(lower) ||
    isExtendedNeuralContextWord(lower, language)
  ) return normalized

  const candidates = nearestNeuralWordContextCandidates(lower, language, 3, false)
    .filter((entry) => (
      Array.from(entry.candidate).length === measuredCharacterCount &&
      LANGUAGE_WORDS[language].has(entry.candidate)
    ))
  if (!candidates.length) return normalized
  const minimumDistance = candidates[0].distance
  const closest = candidates.filter((entry) => entry.distance === minimumDistance)
  if (
    closest.length !== 1 ||
    minimumDistance > 3 ||
    minimumDistance / measuredCharacterCount > 0.3
  ) return normalized
  const titleCase = normalized[0] === normalized[0]?.toLocaleUpperCase(locale)
    && normalized.slice(1) === normalized.slice(1).toLocaleLowerCase(locale)
  if (titleCase && minimumDistance >= 2) return normalized
  return preserveWordCase(normalized, closest[0].candidate, language)
}
