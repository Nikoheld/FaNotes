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
const EXTENDED_CHARACTER_NGRAMS: Partial<Record<RecognitionLanguage, {
  bigrams: Map<string, number>
  trigrams: Map<string, number>
  prefixgrams: Set<string>
  suffixgrams: Set<string>
}>> = {}
const NEAREST_CONTEXT_CACHE = new Map<string, readonly NeuralWordContextCandidate[]>()

export type NeuralWordContextCandidate = {
  candidate: string
  distance: number
}

export type NeuralWordContextOptions = {
  /** Preserve every literal word accepted by the exhaustive OCR dictionary. */
  preserveExtendedWords?: boolean
  /** Require independent character/subword evidence before a lexical rewrite. */
  requirePlausibilityLead?: boolean
}

export const installNeuralWordContextCandidates = (
  language: RecognitionLanguage,
  words: readonly string[],
) => {
  for (const key of NEAREST_CONTEXT_CACHE.keys()) {
    if (key.startsWith(`${language}:`)) NEAREST_CONTEXT_CACHE.delete(key)
  }
  const byLength: ExtendedWordIndex = new Map()
  const bigrams = new Map<string, number>()
  const trigrams = new Map<string, number>()
  const prefixgrams = new Set<string>()
  const suffixgrams = new Set<string>()
  words.forEach((word) => {
    const length = Array.from(word).length
    const bucket = byLength.get(length)
    if (bucket) (bucket as string[]).push(word)
    else byLength.set(length, [word])
    const padded = `^${word}$`
    for (let index = 1; index < padded.length; index += 1) {
      const gram = padded.slice(index - 1, index + 1)
      bigrams.set(gram, (bigrams.get(gram) ?? 0) + 1)
    }
    for (let index = 2; index < padded.length; index += 1) {
      const gram = padded.slice(index - 2, index + 1)
      trigrams.set(gram, (trigrams.get(gram) ?? 0) + 1)
    }
    for (const size of [4, 5]) {
      if (word.length < size) continue
      prefixgrams.add(word.slice(0, size))
      suffixgrams.add(word.slice(-size))
    }
  })
  byLength.forEach((bucket) => {
    // `sortedIncludes` below performs a code-unit binary search. Keep the
    // index in that exact order; locale collation (notably around umlauts)
    // produces a different sequence and makes valid dictionary entries
    // intermittently unreachable.
    (bucket as string[]).sort((first, second) => first < second ? -1 : first > second ? 1 : 0)
  })
  EXTENDED_WORDS[language] = byLength
  EXTENDED_CHARACTER_NGRAMS[language] = { bigrams, trigrams, prefixgrams, suffixgrams }
}

const sortedIncludes = (words: readonly string[], source: string) => {
  let low = 0
  let high = words.length - 1
  while (low <= high) {
    const middle = (low + high) >>> 1
    const value = words[middle]
    if (value === source) return true
    // The candidate resource is validated and stored in JavaScript's stable
    // code-unit order. A locale-aware comparison uses a different collation
    // (especially around umlauts) and therefore invalidates binary search for
    // otherwise ordinary words elsewhere in the list.
    if (value < source) low = middle + 1
    else high = middle - 1
  }
  return false
}

export const isExtendedNeuralContextWord = (
  source: string,
  language: RecognitionLanguage,
) => {
  const words = EXTENDED_WORDS[language]?.get(Array.from(source).length)
  return Boolean(words && sortedIncludes(words, source))
}

/** Read-only, length-bounded lexicon access for visual sequence decoders.
 * Callers still have to score every returned word against independent glyph
 * evidence; this function does not rank or inject an expected transcription. */
export const neuralWordContextWordsOfLength = (
  language: RecognitionLanguage,
  length: number,
) => EXTENDED_WORDS[language]?.get(length) ?? []

/** Language score for a literal character sequence. It is trained only from
 * the shipped spelling vocabulary and therefore also supports plausible
 * unseen names, compounds and specialist spellings instead of forcing every
 * input to an existing dictionary word. */
export const neuralCharacterSequenceScore = (
  source: string,
  language: RecognitionLanguage,
) => {
  const grams = EXTENDED_CHARACTER_NGRAMS[language]
  if (!grams || !source) return 0
  const locale = language === 'de' ? 'de-CH' : 'en-US'
  const value = `^${source.toLocaleLowerCase(locale)}`
  let score = 0
  for (let index = 1; index < value.length; index += 1) {
    const bigram = value.slice(index - 1, index + 1)
    const bigramCount = grams.bigrams.get(bigram) ?? 0
    score += bigramCount ? Math.min(1, Math.log1p(bigramCount) / 3) : -2.5
    if (index >= 2) {
      const trigram = value.slice(index - 2, index + 1)
      const trigramCount = grams.trigrams.get(trigram) ?? 0
      score += trigramCount ? Math.min(1.6, Math.log1p(trigramCount) / 2.5) : -6
    }
  }
  return score
}

export const neuralCharacterSubwordScore = (
  source: string,
  language: RecognitionLanguage,
) => {
  const grams = EXTENDED_CHARACTER_NGRAMS[language]
  if (!grams) return 0
  const locale = language === 'de' ? 'de-CH' : 'en-US'
  const value = source.toLocaleLowerCase(locale)
  let prefixScore = 0
  let suffixScore = 0
  for (const size of [4, 5]) {
    if (value.length < size) continue
    const prefix = value.slice(0, size)
    const suffix = value.slice(-size)
    if (grams.prefixgrams.has(prefix)) prefixScore += size === 5 ? 1.25 : 1
    if (suffix !== prefix && grams.suffixgrams.has(suffix)) suffixScore += size === 5 ? 2.5 : 2
  }
  return prefixScore > 0 && suffixScore > 0 ? prefixScore + suffixScore : 0
}

const boundedWordDistance = (first: string, second: string, maximumDistance: number) => {
  if (Math.abs(first.length - second.length) > maximumDistance) return maximumDistance + 1
  const unreachable = maximumDistance + 1
  let previous = Array.from({ length: second.length + 1 }, (_, index) => (
    index <= maximumDistance ? index : unreachable
  ))
  let current = new Array<number>(second.length + 1).fill(unreachable)
  for (let firstIndex = 1; firstIndex <= first.length; firstIndex += 1) {
    current.fill(unreachable)
    if (firstIndex <= maximumDistance) current[0] = firstIndex
    const from = Math.max(1, firstIndex - maximumDistance)
    const to = Math.min(second.length, firstIndex + maximumDistance)
    let rowMinimum = unreachable
    for (let secondIndex = from; secondIndex <= to; secondIndex += 1) {
      current[secondIndex] = Math.min(
        previous[secondIndex] + 1,
        current[secondIndex - 1] + 1,
        previous[secondIndex - 1] + Number(first[firstIndex - 1] !== second[secondIndex - 1]),
      )
      rowMinimum = Math.min(rowMinimum, current[secondIndex])
    }
    if (rowMinimum > maximumDistance) return unreachable
    ;[previous, current] = [current, previous]
  }
  return previous[second.length]
}

export const nearestNeuralWordContextCandidates = (
  source: string,
  language: RecognitionLanguage,
  maximumDistance = 1,
  sameLengthOnly = false,
  maximumCandidates = Number.POSITIVE_INFINITY,
): NeuralWordContextCandidate[] => {
  const index = EXTENDED_WORDS[language]
  if (!index) return []
  const boundedLimit = Number.isFinite(maximumCandidates)
    ? Math.max(0, Math.floor(maximumCandidates))
    : Number.POSITIVE_INFINITY
  const cacheKey = Number.isFinite(boundedLimit)
    ? `${language}:${source}:${maximumDistance}:${Number(sameLengthOnly)}:${boundedLimit}`
    : ''
  const cached = cacheKey ? NEAREST_CONTEXT_CACHE.get(cacheKey) : undefined
  if (cached) return [...cached]
  const sourceLength = Array.from(source).length
  const candidates: NeuralWordContextCandidate[] = []
  const compareCandidates = (first: NeuralWordContextCandidate, second: NeuralWordContextCandidate) => (
    first.distance - second.distance || first.candidate.localeCompare(second.candidate, language)
  )
  const trimCandidates = () => {
    if (!Number.isFinite(maximumCandidates) || candidates.length <= maximumCandidates) return
    candidates.sort(compareCandidates)
    candidates.length = Math.max(0, Math.floor(maximumCandidates))
  }
  const minimumLength = sameLengthOnly ? sourceLength : Math.max(3, sourceLength - maximumDistance)
  const maximumLength = sameLengthOnly ? sourceLength : sourceLength + maximumDistance
  for (let length = minimumLength; length <= maximumLength; length += 1) {
    const words = index.get(length) ?? []
    for (const candidate of words) {
      const distance = boundedWordDistance(source, candidate, maximumDistance)
      if (distance <= maximumDistance) candidates.push({ candidate, distance })
      if (
        Number.isFinite(maximumCandidates)
        && candidates.length >= Math.max(2, Math.floor(maximumCandidates) * 2)
      ) trimCandidates()
    }
    trimCandidates()
  }
  candidates.sort(compareCandidates)
  if (cacheKey) {
    if (NEAREST_CONTEXT_CACHE.size >= 512) {
      const oldest = NEAREST_CONTEXT_CACHE.keys().next().value
      if (oldest) NEAREST_CONTEXT_CACHE.delete(oldest)
    }
    NEAREST_CONTEXT_CACHE.set(cacheKey, candidates)
  }
  return [...candidates]
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

/** CTC paths can emit two connected neighbours in reversed temporal order.
 * Treat exactly one adjacent swap as one visual edit without weakening the
 * ordinary Levenshtein metric used by model and geometry alignment. */
export const visualWordDistance = (first: string, second: string) => {
  const distance = wordDistance(first, second)
  if (distance !== 2 || first.length !== second.length) return distance
  const mismatches: number[] = []
  for (let index = 0; index < first.length; index += 1) {
    if (first[index] !== second[index]) mismatches.push(index)
    if (mismatches.length > 2) return distance
  }
  if (
    mismatches.length === 2 &&
    mismatches[1] === mismatches[0] + 1 &&
    first[mismatches[0]] === second[mismatches[1]] &&
    first[mismatches[1]] === second[mismatches[0]]
  ) return 1
  return distance
}

export const preserveWordCase = (source: string, replacement: string, locale: RecognitionLanguage) => {
  if (source === source.toLocaleUpperCase(locale)) return replacement.toLocaleUpperCase(locale)
  if (source[0] === source[0]?.toLocaleUpperCase(locale)) {
    return replacement[0]?.toLocaleUpperCase(locale) + replacement.slice(1)
  }
  return replacement
}

const normalizeKnownWordCase = (
  source: string,
  lower: string,
  language: RecognitionLanguage,
) => {
  const locale = language === 'de' ? 'de-CH' : 'en-US'
  const letters = Array.from(source).filter((character) => /^\p{L}$/u.test(character))
  const allUppercase = letters.length > 1 && letters.every((character) => (
    character === character.toLocaleUpperCase(locale) &&
    character !== character.toLocaleLowerCase(locale)
  ))
  if (allUppercase) return source
  const internalUppercase = letters.slice(1).some((character) => (
    character === character.toLocaleUpperCase(locale) &&
    character !== character.toLocaleLowerCase(locale)
  ))
  if (!internalUppercase) return source
  const startsUppercase = source[0] === source[0]?.toLocaleUpperCase(locale)
  return startsUppercase
    ? lower[0]?.toLocaleUpperCase(locale) + lower.slice(1)
    : lower
}

const allUppercaseWord = (source: string, language: RecognitionLanguage) => {
  const locale = language === 'de' ? 'de-CH' : 'en-US'
  const letters = Array.from(source).filter((character) => /^\p{L}$/u.test(character))
  return letters.length > 1 && letters.every((character) => (
    character === character.toLocaleUpperCase(locale) &&
    character !== character.toLocaleLowerCase(locale)
  ))
}

const titleCaseWord = (source: string, language: RecognitionLanguage) => {
  const locale = language === 'de' ? 'de-CH' : 'en-US'
  const letters = Array.from(source)
  return (
    letters.length >= 3 &&
    letters[0] === letters[0]?.toLocaleUpperCase(locale) &&
    letters[0] !== letters[0]?.toLocaleLowerCase(locale) &&
    letters.slice(1).every((character) => character === character.toLocaleLowerCase(locale))
  )
}

/** A title-cased unknown at sentence start is ambiguous on its own. An
 * adjacent title-cased token is independent structure for a personal name,
 * so dictionary frequency must not translate `Edward Regan` to `Eduard
 * Regan`. Ordinary sentence starts such as `Atteilung unterteilt` keep their
 * correction path because the following word is lower-case. */
const withinTitleNameSequence = (
  complete: string,
  offset: number,
  source: string,
  language: RecognitionLanguage,
) => {
  if (!titleCaseWord(source, language)) return false
  const titleToken = /\p{Lu}\p{Ll}{2,}/u
  const prefix = complete.slice(0, offset).replace(/["'’\])}]+\s*$/gu, '').trimEnd()
  const suffix = complete.slice(offset + source.length).replace(/^\s*["'’([{]+/gu, '').trimStart()
  const previous = prefix.match(/\p{L}+$/u)?.[0] ?? ''
  const next = suffix.match(/^\p{L}+/u)?.[0] ?? ''
  return (Boolean(previous) && titleToken.test(previous)) || (Boolean(next) && titleToken.test(next))
}

const followedByQuotedGloss = (complete: string, offset: number, source: string) => (
  /^\s*\(\s*["'’]/u.test(complete.slice(offset + source.length))
)

const knownContextWord = (word: string, language: RecognitionLanguage) => (
  LANGUAGE_WORDS[language].has(word) || isExtendedNeuralContextWord(word, language)
)

const touchesWordJoiner = (complete: string, offset: number, source: string) => (
  /['’\-]/u.test(complete[offset - 1] ?? '') ||
  /['’\-]/u.test(complete[offset + source.length] ?? '')
)

const beginsSentenceAt = (complete: string, offset: number) => {
  const prefix = complete.slice(0, offset).trimEnd().replace(/["'’\])}]+$/gu, '').trimEnd()
  return !prefix || /[.!?]$/u.test(prefix)
}

/** Repairs only provably false spaces. A boundary is removed when the joined
 * form is a known word and at least one separated fragment is not. Genuine
 * phrases such as “in form” therefore remain unchanged. */
export const repairNeuralWordSpacing = (text: string, language: RecognitionLanguage) => {
  const locale = language === 'de' ? 'de-CH' : 'en-US'
  const letters = language === 'de' ? 'A-Za-zÄÖÜäöü' : 'A-Za-z'
  const pattern = new RegExp(`(?<!['’\\-])([${letters}]+)([ \\t]+)([${letters}]+)(?!['’\\-])`, 'gu')
  let value = normalizeGermanSharpS(text)
  for (let pass = 0; pass < 3; pass += 1) {
    let changed = false
    value = value.replace(pattern, (complete, left: string, _space: string, right: string) => {
      // Capitalized tokens, acronyms and alphanumeric identifiers carry an
      // explicit word boundary. Without this gate `die SES` became `dieSES`
      // (`dieses`) and `Nummer N4` became `NummerN4` (`nummern` + `4`). The
      // lower-case OCR fragments repaired below (`Te st`) remain eligible.
      if (/^\p{Lu}/u.test(right)) return complete
      const joined = `${left}${right}`.toLocaleLowerCase(locale)
      const leftKnown = knownContextWord(left.toLocaleLowerCase(locale), language)
      const rightKnown = knownContextWord(right.toLocaleLowerCase(locale), language)
      if (!knownContextWord(joined, language) || (leftKnown && rightKnown)) return complete
      changed = true
      return `${left}${right}`
    })
    if (!changed) break
  }
  return value
}

/** Corrects only close dictionary neighbours; unknown names and technical terms remain untouched. */
export const applyNeuralWordContext = (
  text: string,
  language: RecognitionLanguage,
  options: NeuralWordContextOptions = {},
) => {
  const locale = language === 'de' ? 'de' : 'en'
  const lexicon = LANGUAGE_WORDS[language]
  const words = LANGUAGE_WORD_LISTS[language]
  const ranks = LANGUAGE_WORD_RANKS[language]
  const preserveExtendedWords = options.preserveExtendedWords ?? true
  const requirePlausibilityLead = options.requirePlausibilityLead ?? true
  const pattern = language === 'de' ? /[A-Za-zÄÖÜäöü]{2,}/gu : /[A-Za-z]{2,}/gu
  let corrected = normalizeGermanSharpS(text)
  for (let pass = 0; pass < 2; pass += 1) {
    let changed = false
    corrected = corrected.replace(pattern, (source, offset: number, complete: string) => {
      const lower = source.toLocaleLowerCase(locale)
      if (touchesWordJoiner(complete, offset, source)) return source
      if (
        allUppercaseWord(source, language) ||
        withinTitleNameSequence(complete, offset, source, language) ||
        followedByQuotedGloss(complete, offset, source)
      ) {
        return source
      }
      if (
        Array.from(source).length <= 3 &&
        complete[offset + source.length] === '.'
      ) return source
      // The exhaustive spelling vocabulary is loaded specifically for OCR.
      // Once it confirms the literal decoder output, a much smaller common-
      // word list must not rewrite that valid word merely because a more
      // frequent neighbour is one or two edits away (for example `gave` →
      // `give`). The final context stage already applies the same protection;
      // it has to be present here as well because this local stage runs first.
      if (lexicon.has(lower) || (preserveExtendedWords && isExtendedNeuralContextWord(lower, language))) {
        return normalizeKnownWordCase(source, lower, language)
      }
      if (lower.length < 3 || /\p{Ll}\p{Lu}/u.test(source)) return source
      const beginsSentence = beginsSentenceAt(complete, offset)
      const titleCase = source[0] === source[0]?.toLocaleUpperCase(locale)
        && source.slice(1) === source.slice(1).toLocaleLowerCase(locale)
      if (titleCase && !beginsSentence) return source

      const maximumDistance = lower.length >= 5 ? 2 : 1
      const ranked = words
        .filter((candidate) => Math.abs(candidate.length - lower.length) <= maximumDistance)
        .map((candidate) => {
          const ordinaryDistance = wordDistance(lower, candidate)
          const distance = visualWordDistance(lower, candidate)
          return {
            candidate,
            distance,
            adjacentTransposition: distance < ordinaryDistance,
            lengthDifference: Math.abs(candidate.length - lower.length),
            rank: ranks.get(candidate) ?? words.length,
          }
        })
        .filter(({ distance }) => distance <= maximumDistance)
        .sort((first, second) => (
          first.distance - second.distance
          || Number(second.adjacentTransposition) - Number(first.adjacentTransposition)
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
      const uniquelyStructuredTransposition = (
        best.adjacentTransposition &&
        !ranked.slice(1).some((candidate) => (
          candidate.distance === best.distance && candidate.adjacentTransposition
        ))
      )
      const safeSingleEdit = best.distance === 1 && (
        unambiguousDistance || rankLead >= 0.012 || uniquelyStructuredTransposition
      )
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
        // The compact frequency list must not hide a visually closer word in
        // the complete OCR spelling index. For example, `englsch` used to be
        // rewritten early to frequent `endlich` (two edits) even though
        // `englisch` is a one-edit exhaustive candidate. Keep the raw surface
        // here so the conservative final stage can resolve that strictly
        // closer candidate without making frequency the visual authority.
        const closerExtendedCandidate = nearestNeuralWordContextCandidates(
          lower,
          language,
          maximumDistance,
          false,
          32,
        ).some((candidate) => (
          candidate.candidate !== best.candidate &&
          visualWordDistance(lower, candidate.candidate) < best.distance
        ))
        if (closerExtendedCandidate) return source
        const sourceSequenceScore = neuralCharacterSequenceScore(lower, language)
        const replacementSequenceScore = neuralCharacterSequenceScore(best.candidate, language)
        const sourceSubwordScore = neuralCharacterSubwordScore(lower, language)
        const replacementSubwordScore = neuralCharacterSubwordScore(best.candidate, language)
        const hasPlausibilityLead = (
          replacementSequenceScore >= sourceSequenceScore + 0.2 ||
          (
            replacementSequenceScore >= sourceSequenceScore - 0.1 &&
            replacementSubwordScore >= sourceSubwordScore + 0.5
          )
        )
        const equalLengthCommonTie = (
          safeSingleEdit
          && best.lengthDifference === 0
          && lexicon.has(best.candidate)
          && replacementSequenceScore >= sourceSequenceScore - 0.05
          && replacementSubwordScore >= sourceSubwordScore - 0.05
        )
        if (
          requirePlausibilityLead
          && EXTENDED_CHARACTER_NGRAMS[language]
          && !hasPlausibilityLead
          && !equalLengthCommonTie
        ) return source
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
  const corrected = applyNeuralWordContext(protectedText, language).replace(pattern, (source, offset: number, complete: string) => {
    const lower = source.toLocaleLowerCase(locale)
    if (
      allUppercaseWord(source, language) ||
      withinTitleNameSequence(complete, offset, source, language) ||
      followedByQuotedGloss(complete, offset, source) ||
      lexicon.has(lower) ||
      isExtendedNeuralContextWord(lower, language) ||
      /\p{Ll}\p{Lu}/u.test(source) ||
      touchesWordJoiner(complete, offset, source)
    ) return source
    const maximumDistance = lower.length >= 7 ? 2 : 1
    const candidates = nearestNeuralWordContextCandidates(lower, language, maximumDistance, false)
    const singleEditCandidates = candidates.filter((entry) => entry.distance === 1)
    const singleEditSameLength = candidates.filter((entry) => (
      entry.distance === 1 && entry.candidate.length === lower.length
    ))
    const lengthHallucinations = candidates.filter((entry) => (
      entry.distance === 2 && Math.abs(entry.candidate.length - lower.length) >= 1
    ))
    // The measured decoder surface already fixes the character count. A rare
    // different-length dictionary neighbour may not block the only common,
    // equal-length substitution (`mallo` has both `hallo` and shorter `malo`;
    // only `hallo` explains all five visible positions). Keep this exception
    // to the compact common lexicon: two merely exhaustive inflection or
    // specialist candidates remain semantically ambiguous.
    const uniqueSingleEdit = singleEditSameLength.length === 1 && (
      singleEditCandidates.length === 1 || lexicon.has(singleEditSameLength[0].candidate)
    )
    // Repeated short fragments from a line decoder can add one or two
    // characters (for example “tableelle”). Repair that only for a long,
    // unknown word with one unambiguous full-dictionary neighbour. Existing
    // valid words, names and equal-length substitutions never enter here.
    const uniqueLengthHallucination = (
      lower.length >= 7 &&
      !candidates.some((entry) => entry.distance === 1) &&
      lengthHallucinations.length === 1 &&
      candidates.filter((entry) => entry.distance === 2).length === 1
    )
    if (!uniqueSingleEdit && !uniqueLengthHallucination) return source
    const replacement = uniqueSingleEdit ? singleEditSameLength[0] : lengthHallucinations[0]
    const sourceSequenceScore = neuralCharacterSequenceScore(lower, language)
    const replacementSequenceScore = neuralCharacterSequenceScore(replacement.candidate, language)
    const sourceSubwordScore = neuralCharacterSubwordScore(lower, language)
    const replacementSubwordScore = neuralCharacterSubwordScore(replacement.candidate, language)
    const hasPlausibilityLead = (
      replacementSequenceScore >= sourceSequenceScore + 0.45 ||
      (
        replacementSequenceScore >= sourceSequenceScore - 0.1 &&
        replacementSubwordScore >= sourceSubwordScore + 0.5
      )
    )
    const equalLengthCommonTie = (
      uniqueSingleEdit
      && replacement.candidate.length === lower.length
      && lexicon.has(replacement.candidate)
      && replacementSequenceScore >= sourceSequenceScore - 0.05
      && replacementSubwordScore >= sourceSubwordScore - 0.05
    )
    // A unique spelling neighbour is not sufficient visual evidence. British
    // variants, names and valid technical forms can be absent from the local
    // dictionary while still having completely plausible character edges.
    // Require an independent character/subword advantage so the last stage
    // repairs a malformed OCR sequence instead of merely normalising it.
    if (!hasPlausibilityLead && !equalLengthCommonTie) return source
    const titleCase = source[0] === source[0]?.toLocaleUpperCase(locale)
      && source.slice(1) === source.slice(1).toLocaleLowerCase(locale)
    if (titleCase && !beginsSentenceAt(complete, offset)) return source
    if (titleCase && replacement.distance >= 2) return source
    return preserveWordCase(source, replacement.candidate, language)
  })
  const restored = corrected.replace(/\uE000(\d+)\uE001/gu, (_marker, rawIndex: string) => (
    protectedWords[Number(rawIndex)] ?? ''
  ))
  return repairNeuralWordSpacing(restored, language)
}

/** Applies the exhaustive spelling stage to a complete recognized line.
 * English validation showed that unconstrained mid-line dictionary rewrites
 * lose more visible characters than they recover. A line-level English repair
 * therefore needs independent positional evidence: exactly one same-length,
 * one-edit replacement at the final lexical token. Seven-letter words are
 * sufficiently constrained; a shorter word remains eligible only when ink
 * segmentation independently measured one physical word. The generic word
 * function above stays available for isolated candidate comparison. */
export const applyFinalNeuralLineContext = (
  text: string,
  language: RecognitionLanguage,
  physicalWordCount?: number,
) => {
  const corrected = applyFinalNeuralWordContext(text, language)
  if (language !== 'en' || corrected === text) return corrected
  const sourceWords = [...text.matchAll(/[A-Za-z]+/gu)].map((match) => match[0])
  const targetWords = [...corrected.matchAll(/[A-Za-z]+/gu)].map((match) => match[0])
  if (
    !sourceWords.length ||
    sourceWords.length !== targetWords.length ||
    text.replace(/[A-Za-z]+/gu, '#') !== corrected.replace(/[A-Za-z]+/gu, '#') ||
    sourceWords.slice(0, -1).some((word, index) => word !== targetWords[index])
  ) return text
  const source = sourceWords.at(-1) ?? ''
  const target = targetWords.at(-1) ?? ''
  const safeIsolatedWord = physicalWordCount === 1 && sourceWords.length === 1
  if (
    source === target ||
    Array.from(source).length !== Array.from(target).length ||
    (!safeIsolatedWord && Array.from(source).length < 7) ||
    boundedWordDistance(source.toLocaleLowerCase('en-US'), target.toLocaleLowerCase('en-US'), 1) !== 1
  ) return text
  return corrected
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
