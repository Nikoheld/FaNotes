import type { SpellingLanguage } from '../types'

/**
 * Correction candidates for a misspelled word, checked against an exact word
 * list (the Bloom filter alone would let ~0.3 % random edits through), ranked
 * by how likely the typo is, and the rule that decides when a candidate is
 * sure enough to be applied while typing.
 */

export type SpellingSuggestion = {
  /** Replacement with the casing of the typed word restored. */
  word: string
  distance: 1 | 2
  /** Lower is likelier. */
  score: number
  language: SpellingLanguage
}

export type SuggestionLexicon = {
  hasWord: (language: SpellingLanguage, normalizedWord: string) => boolean
  /** Extra score for a word `hasWord` accepted less than certainly (e.g. only as a compound of parts); 0 for listed words. */
  candidatePenalty?: (language: SpellingLanguage, normalizedWord: string) => number
}

const ALPHABETS: Record<SpellingLanguage, string> = {
  de: 'abcdefghijklmnopqrstuvwxyzäöü',
  en: 'abcdefghijklmnopqrstuvwxyz',
}

// Swiss/German QWERTZ rows; y/z are also treated as neighbours so a QWERTY
// habit does not count as a far miss.
const KEY_ROWS = ['qwertzuiopü', 'asdfghjklöä', 'yxcvbnm']
const KEY_ROW_OFFSETS = [0, 0.5, 1.5]
const keyNeighbours = (() => {
  const positions = new Map<string, { row: number; column: number }>()
  KEY_ROWS.forEach((row, rowIndex) => {
    [...row].forEach((key, column) => positions.set(key, { row: rowIndex, column: column + KEY_ROW_OFFSETS[rowIndex] }))
  })
  const neighbours = new Map<string, Set<string>>()
  for (const [key, position] of positions) {
    const near = new Set<string>()
    for (const [other, otherPosition] of positions) {
      if (other === key) continue
      if (Math.abs(position.row - otherPosition.row) <= 1 && Math.abs(position.column - otherPosition.column) <= 1) near.add(other)
    }
    neighbours.set(key, near)
  }
  neighbours.get('y')?.add('z')
  neighbours.get('z')?.add('y')
  return neighbours
})()

const UMLAUT_PAIRS: Record<string, string> = { a: 'ä', ä: 'a', o: 'ö', ö: 'o', u: 'ü', ü: 'u' }

// The word lists carry no frequencies. These everyday words win ties against
// rare dictionary entries ("the" over "eth", "nicht" over "nichte").
const COMMON_WORDS: Record<SpellingLanguage, Set<string>> = {
  de: new Set(('der die das und ist in den von zu mit sich des auf für nicht ein eine einer eines einem einen als auch es an werden aus er hat dass sie nach wird bei noch wie einem über einen so zum war haben nur oder aber vor zur bis mehr durch man sein wurde sei wenn ich wir ihr euch uns mir mich dir dich kann können muss müssen soll sollen will wollen darf dürfen mag mögen heute morgen gestern dann denn doch schon sehr viel viele wenig mal jetzt hier dort immer nie wieder alle alles etwas nichts keine kein was wer wo wann warum welche welcher welches dieser diese dieses jener seine ihre unser unsere ihrer seiner haus hause schule schüler lehrer aufgabe aufgaben stunde stunden woche wochen tag tage jahr jahre zeit mensch menschen leben arbeit text buch seite frage antwort beispiel wichtig gut schlecht neu alt gross klein lang kurz').split(' ')),
  en: new Set(('the of and to in a is that for it as was with be by on not he i this are or his from at which but have an had they you were their one all we can her has there been if more when will would who so no she about their them than then some into only other could time these two may first any my now such like our over man me even most made after also did many before must through back years where much your way well down should because each just those people how too little state good very make world still own see men work long get here between both life being under never day same another know while last might us great old year off come since against go came right used take three').split(' ')),
}
const COMMON_WORD_BONUS = 25

type EditKind = 'transpose' | 'double' | 'near' | 'umlaut' | 'delete' | 'insert' | 'replace'
const EDIT_COST: Record<EditKind, number> = {
  transpose: 0,
  double: 1,
  near: 1,
  umlaut: 1,
  delete: 2,
  insert: 2,
  replace: 3,
}

type Edit = { word: string; kind: EditKind }

/**
 * Every string one edit away from `word` (lowercase letters only), tagged with
 * the kind of slip. `likelyOnly` keeps just the slips a hand makes (dropped,
 * doubled or swapped letters, a neighbouring key, a missing umlaut) and skips
 * the full-alphabet replacements and insertions.
 */
export const editsAtDistanceOne = (word: string, alphabet: string, likelyOnly = false): Edit[] => {
  const letters = [...word]
  const edits: Edit[] = []
  for (let index = 0; index < letters.length; index += 1) {
    const before = letters.slice(0, index).join('')
    const after = letters.slice(index + 1).join('')
    const removed = letters[index]
    const doubled = letters[index - 1] === removed || letters[index + 1] === removed
    edits.push({ word: before + after, kind: doubled ? 'double' : 'delete' })
    if (index + 1 < letters.length && letters[index] !== letters[index + 1]) {
      edits.push({ word: before + letters[index + 1] + letters[index] + letters.slice(index + 2).join(''), kind: 'transpose' })
    }
    edits.push({ word: before + removed + removed + after, kind: 'double' })
    const umlaut = UMLAUT_PAIRS[removed]
    if (umlaut && alphabet.includes(umlaut)) edits.push({ word: before + umlaut + after, kind: 'umlaut' })
    for (const near of keyNeighbours.get(removed) ?? []) {
      if (alphabet.includes(near) && UMLAUT_PAIRS[removed] !== near) edits.push({ word: before + near + after, kind: 'near' })
    }
    if (likelyOnly) continue
    for (const letter of alphabet) {
      if (letter === removed || UMLAUT_PAIRS[removed] === letter || keyNeighbours.get(removed)?.has(letter)) continue
      edits.push({ word: before + letter + after, kind: 'replace' })
    }
  }
  if (likelyOnly) return edits
  for (let index = 0; index <= letters.length; index += 1) {
    const before = letters.slice(0, index).join('')
    const after = letters.slice(index).join('')
    for (const letter of alphabet) {
      if (letters[index - 1] === letter || letters[index] === letter) continue // already listed as 'double'
      edits.push({ word: before + letter + after, kind: 'insert' })
    }
  }
  return edits
}

const MAX_DISTANCE_TWO_PROBES = 60_000

export const restoreWordCase = (typed: string, replacement: string, language: SpellingLanguage) => {
  const locale = language === 'de' ? 'de-CH' : 'en-US'
  const letters = [...typed].filter((character) => /\p{L}/u.test(character))
  if (letters.length > 1 && letters.every((character) => character === character.toLocaleUpperCase(locale) && character !== character.toLocaleLowerCase(locale))) {
    return replacement.toLocaleUpperCase(locale)
  }
  const first = letters[0]
  if (first && first === first.toLocaleUpperCase(locale) && first !== first.toLocaleLowerCase(locale)) {
    return replacement.charAt(0).toLocaleUpperCase(locale) + replacement.slice(1)
  }
  return replacement
}

const normalizedForm = (word: string, language: SpellingLanguage) => {
  const lower = word.normalize('NFC').toLocaleLowerCase(language === 'de' ? 'de-CH' : 'en-US')
  return language === 'de' ? lower.replaceAll('ß', 'ss') : lower
}

/**
 * Ranked corrections for `typed`, verified against `lexicon`. Distance-two
 * candidates are only explored when the word is long enough and one edit
 * found little, and the probe count is capped so a long garbage word stays cheap.
 */
export const suggestCorrections = (
  typed: string,
  languages: SpellingLanguage[],
  lexicon: SuggestionLexicon,
  { limit = 6, maxDistance = 2 }: { limit?: number; maxDistance?: 1 | 2 } = {},
): SpellingSuggestion[] => {
  const results = new Map<string, SpellingSuggestion>()
  const consider = (candidate: string, language: SpellingLanguage, distance: 1 | 2, cost: number, typedLower: string) => {
    if (!candidate || candidate === typedLower || !lexicon.hasWord(language, candidate)) return
    const firstLetterPenalty = candidate[0] === typedLower[0] ? 0 : 5
    const lengthPenalty = Math.abs(candidate.length - typedLower.length)
    const commonBonus = COMMON_WORDS[language].has(candidate) ? COMMON_WORD_BONUS : 0
    const uncertainty = lexicon.candidatePenalty?.(language, candidate) ?? 0
    const score = distance * 100 + cost * 10 + firstLetterPenalty + lengthPenalty - commonBonus + uncertainty
    const restored = restoreWordCase(typed, candidate, language)
    const existing = results.get(restored)
    if (!existing || existing.score > score) results.set(restored, { word: restored, distance, score, language })
  }
  for (const language of languages) {
    const lower = normalizedForm(typed, language)
    if (!/^\p{L}+$/u.test(lower)) continue
    const alphabet = ALPHABETS[language]
    const firstEdits = editsAtDistanceOne(lower, alphabet)
    for (const edit of firstEdits) consider(edit.word, language, 1, EDIT_COST[edit.kind], lower)
    // "auchdas" → "auch das": a missing space between two known words.
    for (let split = 2; split <= lower.length - 2; split += 1) {
      const head = lower.slice(0, split)
      const tail = lower.slice(split)
      const listed = (part: string) => lexicon.hasWord(language, part) && (lexicon.candidatePenalty?.(language, part) ?? 0) === 0
      if (listed(head) && listed(tail)) {
        const restored = `${restoreWordCase(typed, head, language)} ${tail}`
        // A missing space between two listed words is about as likely as a doubled letter.
        const common = Number(COMMON_WORDS[language].has(head)) + Number(COMMON_WORDS[language].has(tail))
        if (!results.has(restored)) results.set(restored, { word: restored, distance: 1, score: 100 + EDIT_COST.double * 10 + 2 - common * 4, language })
      }
    }
    const foundAtOne = [...results.values()].filter((suggestion) => suggestion.language === language && suggestion.distance === 1).length
    if (maxDistance >= 2 && lower.length >= 5 && foundAtOne < 2) {
      const seen = new Set<string>()
      let probes = 0
      // Likely slips first, so the probe cap trims the improbable pairs.
      const ordered = [...firstEdits].sort((left, right) => EDIT_COST[left.kind] - EDIT_COST[right.kind])
      outer: for (const first of ordered) {
        for (const second of editsAtDistanceOne(first.word, alphabet, true)) {
          if (seen.has(second.word)) continue
          seen.add(second.word)
          probes += 1
          if (probes > MAX_DISTANCE_TWO_PROBES) break outer
          consider(second.word, language, 2, EDIT_COST[first.kind] + EDIT_COST[second.kind], lower)
        }
      }
    }
  }
  return [...results.values()]
    .sort((left, right) => left.score - right.score || left.word.localeCompare(right.word, 'de'))
    .slice(0, limit)
}

export type AutocorrectContext = {
  /** Language the surrounding line was recognised as; null when unknown. */
  language: SpellingLanguage | null
  /** The word opens a sentence (start of line or after . ! ? : ). */
  sentenceStart: boolean
  /** Known proper names never get "corrected" into a dictionary word. */
  isProperName: (normalizedWord: string) => boolean
}

/**
 * The one replacement safe enough to apply without asking, or null. Conservative
 * on purpose: a wrong autocorrect is worse than a missed one.
 */
export const decideAutocorrect = (
  typed: string,
  suggestions: SpellingSuggestion[],
  context: AutocorrectContext,
): SpellingSuggestion | null => {
  if (typed.length < 3 || typed.length > 24 || !/^\p{L}+$/u.test(typed)) return null
  const letters = [...typed]
  const upper = letters.filter((letter) => letter !== letter.toLocaleLowerCase() && letter === letter.toLocaleUpperCase())
  // Acronyms and camelCase are deliberate spellings.
  if (upper.length > 1) return null
  const capitalised = upper.length === 1 && letters[0] === upper[0]
  if (upper.length === 1 && !capitalised) return null
  if (context.isProperName(normalizedForm(typed, 'en'))) return null
  // A capitalised word inside an English sentence is most likely a name.
  if (capitalised && context.language === 'en' && !context.sentenceStart) return null
  const nearest = suggestions.filter((suggestion) => suggestion.distance === 1 && !suggestion.word.includes(' '))
  if (!nearest.length) return null
  const [best, runnerUp] = nearest
  if (best.score >= 100 + EDIT_COST.replace * 10) return null
  if (runnerUp && runnerUp.score - best.score < 20) return null
  return best
}

/* ---------- personal dictionary and session ignores ---------- */

export const PERSONAL_DICTIONARY_STORAGE_KEY = 'fanotes.spelling.personal.v1'
const PERSONAL_DICTIONARY_LIMIT = 5_000

let personalWordsCache: Set<string> | null = null
const sessionIgnoredWords = new Set<string>()
const autocorrectDeclinedWords = new Set<string>()

const safeStorage = (): Pick<Storage, 'getItem' | 'setItem'> | null => {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

export const normalizeForDictionary = (word: string) => normalizedForm(word.trim(), 'de').replace(/^['’\-]+|['’\-]+$/gu, '')

export const personalWords = (storage = safeStorage()): Set<string> => {
  if (personalWordsCache) return personalWordsCache
  let words: string[] = []
  try {
    const raw = storage?.getItem(PERSONAL_DICTIONARY_STORAGE_KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : []
    if (Array.isArray(parsed)) words = parsed.filter((entry): entry is string => typeof entry === 'string')
  } catch {
    words = []
  }
  personalWordsCache = new Set(words.map(normalizeForDictionary).filter(Boolean))
  return personalWordsCache
}

export const addPersonalWord = (word: string, storage = safeStorage()) => {
  const normalized = normalizeForDictionary(word)
  if (!normalized) return false
  const words = personalWords(storage)
  if (words.has(normalized)) return true
  words.add(normalized)
  if (words.size > PERSONAL_DICTIONARY_LIMIT) words.delete(words.values().next().value as string)
  try {
    storage?.setItem(PERSONAL_DICTIONARY_STORAGE_KEY, JSON.stringify([...words]))
  } catch {
    // Storage full or unavailable: the word still counts for this session.
  }
  return true
}

export const removePersonalWord = (word: string, storage = safeStorage()) => {
  const words = personalWords(storage)
  if (!words.delete(normalizeForDictionary(word))) return false
  try {
    storage?.setItem(PERSONAL_DICTIONARY_STORAGE_KEY, JSON.stringify([...words]))
  } catch {
    // See addPersonalWord.
  }
  return true
}

export const ignoreWordForSession = (word: string) => {
  const normalized = normalizeForDictionary(word)
  if (normalized) sessionIgnoredWords.add(normalized)
}

/** Reverting an autocorrect means: this is how I want it spelled, stop fixing it. */
export const declineAutocorrect = (word: string) => {
  const normalized = normalizeForDictionary(word)
  if (normalized) autocorrectDeclinedWords.add(normalized)
}

export const isAutocorrectDeclined = (word: string) => autocorrectDeclinedWords.has(normalizeForDictionary(word))

/** Words the user vouched for, in this session or permanently. */
export const isUserAcceptedWord = (word: string, storage = safeStorage()) => {
  const normalized = normalizeForDictionary(word)
  return Boolean(normalized) && (sessionIgnoredWords.has(normalized) || personalWords(storage).has(normalized))
}

/** Test hook: forgets cached personal words so a different storage can be read. */
export const resetPersonalDictionaryCache = () => {
  personalWordsCache = null
  sessionIgnoredWords.clear()
  autocorrectDeclinedWords.clear()
}
