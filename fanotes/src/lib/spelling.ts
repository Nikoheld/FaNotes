import type { DetectedTextLanguage, SpellingLanguage, SpellingResources, TextLanguage } from '../types'
import { ENGLISH_CANONICAL_PROPER_NAMES } from '../../../src/data/englishProperNames'
import { SUPPLEMENTAL_CANONICAL_PROPER_NAMES } from '../../../src/data/supplementalProperNames'
import {
  installRecognitionProperNameMembership,
  installRecognitionWordCandidateProvider,
  installRecognitionWordMembership,
} from '../../../src/lib/recognition'
import {
  installNeuralWordContextCandidates,
  installNeuralWordContextSnapshot,
  isExtendedNeuralContextWord,
  neuralWordContextWordsOfLength,
} from './neuralWordContext'
import { isUserAcceptedWord, personalWords, type SuggestionLexicon } from './spellingSuggest'
import { frenchDescriptor, loadBrowserSpellingResources, loadBrowserSpellingWordCandidates } from './spellingResources'
import { isFrenchWord } from './frenchLexicon'
import {
  addEvidence,
  decideLanguage,
  detectedLanguageOf,
  emptyEvidence,
  isUnsupported,
  mergeScores,
  presentLanguages,
  profilePrior,
  proseLineFilter,
  resolvePassage,
  scoreTokens,
  splitPassages,
  type EvidenceToken,
  type LanguageEvidence,
  type PassageLanguage,
  type PassageRange,
  UNKNOWN_PASSAGE,
  type PassageScore,
  type WordLanguages,
} from './languageDetect'

export type SpellingSegment = { from: number; text: string }
export type SpellingIgnoredRange = { from: number; to: number }
export type SpellingError = {
  from: number
  to: number
  word: string
  language: TextLanguage
}
export type SpellingLine = {
  from: number
  to: number
  /** The line's main language: its first confident passage, else the best guess, else the note's main language. */
  language: TextLanguage
  confident: boolean
}
/** One passage of a line (sentence, list item, table cell, side of a vocabulary pair, quotation) and its language. */
export type SpellingPassage = PassageLanguage & {
  from: number
  to: number
  kind: PassageRange['kind']
}
export type SpellingCheckResult = {
  errors: SpellingError[]
  lines: SpellingLine[]
  passages: SpellingPassage[]
  detectedLanguage: DetectedTextLanguage
  /** Languages the note uses, most used first. */
  languages: TextLanguage[]
  /** The language evidence of the whole note (the profile). `complete` is false while a long note is still being read. */
  profile: LanguageEvidence
  profileComplete: boolean
}

const EMPTY_RESULT = (): SpellingCheckResult => ({
  errors: [], lines: [], passages: [], detectedLanguage: 'unknown', languages: [], profile: emptyEvidence(), profileComplete: true,
})

type FilterDescriptor = SpellingResources['manifest']['languages'][SpellingLanguage]

const WORD_PATTERN = /\p{L}[\p{L}\p{M}'’\-]*/gu
const TECHNICAL_WORDS = new Set([
  'ai', 'amat', 'anthropic', 'appimage', 'arch', 'browser', 'chromium', 'codemirror', 'codex',
  'electron', 'fanotes', 'gemini', 'glyphenwerk', 'github', 'google', 'grok', 'html', 'hyprland',
  'javascript', 'katex', 'latex', 'linux', 'lm', 'markdown', 'nas', 'ollama', 'openai',
  'opencode', 'pdf', 'typescript', 'url', 'vulkan', 'wayland', 'web', 'windows',
])
const canonicalProperName = (word: string) => (
  ENGLISH_CANONICAL_PROPER_NAMES.has(word) || SUPPLEMENTAL_CANONICAL_PROPER_NAMES.has(word)
)
installRecognitionProperNameMembership('de', canonicalProperName)
installRecognitionProperNameMembership('en', canonicalProperName)

const normalizeWord = (word: string, language: TextLanguage) => {
  const normalized = word
    .normalize('NFC')
    .toLocaleLowerCase(language === 'de' ? 'de-CH' : language === 'fr' ? 'fr-FR' : 'en-US')
    .replace(/^['’\-]+|['’\-]+$/gu, '')
  // French typography uses the curly apostrophe; the filter holds the plain one.
  if (language === 'fr') return normalized.replaceAll('’', "'")
  return language === 'de' ? normalized.replaceAll('ß', 'ss') : normalized
}

const hashWord = (word: string, seed: number) => {
  let hash = seed >>> 0
  for (let index = 0; index < word.length; index += 1) {
    hash ^= word.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

class BloomFilter {
  constructor(
    private readonly bytes: Uint8Array,
    private readonly descriptor: FilterDescriptor,
    private readonly hashes: number,
  ) {}

  has(rawWord: string, language: TextLanguage) {
    const word = normalizeWord(rawWord, language)
    if (!word) return false
    const first = hashWord(word, 0x811c9dc5)
    const second = (hashWord(word, 0x9e3779b1) | 1) >>> 0
    for (let index = 0; index < this.hashes; index += 1) {
      const bit = ((first + Math.imul(index, second)) >>> 0) % this.descriptor.bitCount
      if ((this.bytes[bit >>> 3] & (1 << (bit & 7))) === 0) return false
    }
    return true
  }
}

type Dictionaries = Record<SpellingLanguage, BloomFilter> & { fr?: BloomFilter }
let dictionariesPromise: Promise<Dictionaries> | null = null
let loadedResources: SpellingResources | null = null
let warnedAboutResources = false
/** Bumped whenever the dictionaries change, so cached evidence of lines is read again. */
let lexiconVersion = 0

const sha256 = async (bytes: Uint8Array) => {
  if (!globalThis.crypto?.subtle) return null
  const source = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
  const digest = await globalThis.crypto.subtle.digest('SHA-256', source)
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

const loadDictionaries = async (): Promise<Dictionaries> => {
  dictionariesPromise ??= Promise.resolve()
    .then(() => window.fanotes.loadSpellingResources())
    .catch((hostError: unknown) => (
      loadBrowserSpellingResources().catch(() => {
        throw hostError
      })
    )).then(async (resources) => {
    const hashes = resources.manifest.hashes
    if (resources.manifest.format !== 'fanotes-spelling-bloom-v2' || hashes !== 8) throw new Error('Unbekanntes Rechtschreibformat.')
    const de = new Uint8Array(resources.de)
    const en = new Uint8Array(resources.en)
    const [deDigest, enDigest] = await Promise.all([sha256(de), sha256(en)])
    if ((deDigest && deDigest !== resources.manifest.languages.de.sha256) || (enDigest && enDigest !== resources.manifest.languages.en.sha256)) {
      throw new Error('Die lokalen Rechtschreibdaten sind beschädigt.')
    }
    if (de.byteLength * 8 !== resources.manifest.languages.de.bitCount || en.byteLength * 8 !== resources.manifest.languages.en.bitCount) {
      throw new Error('Die lokalen Rechtschreibdaten besitzen eine ungültige Länge.')
    }
    loadedResources = resources
    let fr: BloomFilter | undefined
    const frenchFilter = frenchDescriptor(resources.manifest)
    if (resources.fr && frenchFilter) {
      const frBytes = new Uint8Array(resources.fr)
      const frDigest = await sha256(frBytes)
      if ((!frDigest || frDigest === frenchFilter.sha256) && frBytes.byteLength * 8 === frenchFilter.bitCount) {
        fr = new BloomFilter(frBytes, frenchFilter, hashes)
      } else console.warn('Das französische Wörterbuch ist beschädigt und wird nicht verwendet.')
    }
    lexiconVersion += 1
    loadedDictionaries = {
      de: new BloomFilter(de, resources.manifest.languages.de, hashes),
      en: new BloomFilter(en, resources.manifest.languages.en, hashes),
      ...(fr ? { fr } : {}),
    }
    return loadedDictionaries
  }).catch((error) => {
    dictionariesPromise = null
    throw error
  })
  return dictionariesPromise
}

const isGermanCompound = (rawWord: string, filter: BloomFilter) => splitsIntoGermanParts(rawWord, (part) => filter.has(part, 'de'))

const splitsIntoGermanParts = (rawWord: string, hasPart: (part: string) => boolean) => {
  const word = normalizeWord(rawWord, 'de')
  if (word.length < 8 || word.length > 64 || !/^\p{L}+$/u.test(word)) return false
  const memo = new Map<string, boolean>()
  const findParts = (offset: number, parts: number): boolean => {
    if (offset === word.length) return parts >= 2
    if (parts >= 6 || word.length - offset < 3) return false
    const key = `${offset}:${parts}`
    const cached = memo.get(key)
    if (cached !== undefined) return cached
    const maximum = Math.min(word.length, offset + 24)
    for (let end = offset + 3; end <= maximum; end += 1) {
      if (end < word.length && word.length - end < 3) continue
      const part = word.slice(offset, end)
      if (hasPart(part) && findParts(end, parts + 1)) {
        memo.set(key, true)
        return true
      }
    }
    memo.set(key, false)
    return false
  }
  return findParts(0, 0)
}

const FRENCH_ELISION_PREFIX = /^(?:[cdjlmnst]|qu|jusqu|lorsqu|puisqu|quoiqu)'(.+)$/u

/** A French word the filter knows: whole, or after an elision prefix ("l'homme", "qu'il"). The filter
 * holds no elided or inverted forms, only the dictionary's own stems. */
const frenchKnown = (normalized: string, filter: BloomFilter | undefined) => {
  if (!filter || !normalized) return false
  if (filter.has(normalized, 'fr')) return true
  const rest = FRENCH_ELISION_PREFIX.exec(normalized)?.[1]
  return Boolean(rest && filter.has(rest, 'fr'))
}

const wordMembership = (word: string, dictionaries: Dictionaries): WordLanguages => {
  const normalized = normalizeWord(word, 'de')
  if (!normalized) return { de: true, en: true, fr: true }
  if (TECHNICAL_WORDS.has(normalized) || isUserAcceptedWord(normalized)) return { de: true, en: true, fr: true }
  const french = normalizeWord(word, 'fr')
  // Without the French dictionary only the small school lexicon can vouch for a French word.
  const frenchWord = (part: string) => (dictionaries.fr ? frenchKnown(part, dictionaries.fr) : isFrenchWord(part))
  if (normalized.includes('-')) {
    const parts = normalized.split('-').filter(Boolean)
    if (parts.length > 1) {
      const membership = parts.map((part) => ({
        de: dictionaries.de.has(part, 'de') || isGermanCompound(part, dictionaries.de),
        en: dictionaries.en.has(part, 'en'),
        // The "-t-" of "a-t-il" is no word of its own.
        fr: part === 't' || frenchWord(normalizeWord(part, 'fr')),
      }))
      const common = {
        de: membership.every((part) => part.de),
        en: membership.every((part) => part.en),
        fr: frenchWord(french) || membership.every((part) => part.fr),
      }
      if (common.de || common.en || common.fr) return common
      // Mixed school vocabulary such as “Inline-Mathematik” is valid when
      // every hyphen part exists in at least one active language.
      if (membership.every((part) => part.de || part.en || part.fr)) return { de: true, en: true, fr: true }
      return common
    }
  }
  return {
    de: dictionaries.de.has(normalized, 'de') || isGermanCompound(normalized, dictionaries.de),
    en: dictionaries.en.has(normalized, 'en'),
    fr: frenchWord(french),
  }
}

/** Loads the compact local dictionary once and returns a synchronous lookup
 * used by CTC beam decoding. No word list or note content leaves the device. */
export const loadSpellingWordMembership = async (language: SpellingLanguage) => {
  const dictionaries = await loadDictionaries()
  return (word: string) => {
    const membership = wordMembership(word, dictionaries)
    return membership[language]
  }
}

const candidatePromises = new Map<SpellingLanguage, Promise<Set<string>>>()

const fetchCandidateResource = (language: TextLanguage) => (
  Promise.resolve()
    .then(() => window.fanotes.loadSpellingWordCandidates(language))
    .catch((hostError: unknown) => (
      loadBrowserSpellingWordCandidates(language).catch(() => {
        throw hostError
      })
    ))
)

export type SpellingWorkerInput = {
  bloom: Record<SpellingLanguage, { bytes: Uint8Array; bitCount: number }>
  hashes: number
  words: Record<SpellingLanguage, { bytes: Uint8Array; size: number; count: number; sha256: string }>
}

/** The raw bytes the spelling worker validates and indexes off the main thread. The Bloom filters
 * were already hash-checked here; the exact word lists are only fetched, never parsed. */
export const loadSpellingWorkerInput = async (): Promise<SpellingWorkerInput> => {
  await loadDictionaries()
  const resources = loadedResources
  if (!resources) throw new Error('Die Rechtschreibdaten sind nicht geladen.')
  const [de, en] = await Promise.all([fetchCandidateResource('de'), fetchCandidateResource('en')])
  const word = (language: SpellingLanguage, resource: typeof de) => {
    if (resource.language !== language) throw new Error('Die OCR-Wortliste gehört zur falschen Sprache.')
    return {
      bytes: new Uint8Array(resource.bytes),
      size: resource.descriptor.size,
      count: resource.descriptor.wordCount,
      sha256: resource.descriptor.sha256,
    }
  }
  const bloom = (language: SpellingLanguage) => ({
    // A copy: the worker gets the buffer transferred, this thread keeps its own filter.
    bytes: new Uint8Array(resources[language]).slice(),
    bitCount: resources.manifest.languages[language].bitCount,
  })
  return {
    bloom: { de: bloom('de'), en: bloom('en') },
    hashes: resources.manifest.hashes,
    words: { de: word('de', de), en: word('en', en) },
  }
}

/** True when the word would be underlined, using only the compact Bloom filters. Resolves after
 * the filters loaded; false for a word that cannot be judged yet. */
export const loadMisspellingCheck = async () => {
  const dictionaries = await loadDictionaries()
  /** `languages` are the ones the word may be valid in; German and English by default. */
  return (word: string, languages: readonly TextLanguage[] = ['de', 'en']) => {
    const membership = wordMembership(word, dictionaries)
    return !languages.some((language) => membership[language])
  }
}

export const loadRecognitionCandidates = async (language: SpellingLanguage) => {
  let pending = candidatePromises.get(language)
  if (!pending) {
    pending = fetchCandidateResource(language).then(async (resource) => {
      if (resource.language !== language) throw new Error('Die OCR-Wortliste gehört zur falschen Sprache.')
      const bytes = new Uint8Array(resource.bytes)
      if (bytes.byteLength !== resource.descriptor.size || bytes.byteLength > 8 * 1024 * 1024) {
        throw new Error('Die OCR-Wortliste besitzt eine ungültige Länge.')
      }
      const digest = await sha256(bytes)
      if (digest && digest !== resource.descriptor.sha256) throw new Error('Die OCR-Wortliste ist beschädigt.')
      const decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
      if (!decoded.endsWith('\n')) throw new Error('Die OCR-Wortliste ist unvollständig.')
      const words = decoded.slice(0, -1).split('\n')
      if (words.length !== resource.descriptor.wordCount) throw new Error('Die OCR-Wortlistenanzahl ist ungültig.')
      let previous = ''
      words.forEach((word) => {
        if (
          word <= previous ||
          word !== normalizeWord(word, language) ||
          !/^\p{L}{3,32}$/u.test(word)
        ) throw new Error('Die OCR-Wortliste enthält einen ungültigen Eintrag.')
        previous = word
      })
      installNeuralWordContextCandidates(language, words)
      installRecognitionWordCandidateProvider(
        language,
        (length) => neuralWordContextWordsOfLength(language, length),
      )
      const candidates = new Set(words)
      // Share the already allocated set with the classical glyph beam. The
      // callback adds no second word-list copy and is installed only on the
      // first handwriting-OCR request, so normal application startup stays
      // unchanged.
      installRecognitionWordMembership(language, (word) => candidates.has(word))
      loadedCandidates[language] = candidates
      return candidates
    }).catch((error) => {
      candidatePromises.delete(language)
      throw error
    })
    candidatePromises.set(language, pending)
  }
  return pending
}

type RecognitionContext = { has: (normalized: string) => boolean; words: () => string[] }
const contextPromises = new Map<SpellingLanguage, Promise<RecognitionContext | null>>()

/** The OCR word context index from the spelling worker (Rust validates the exact list and builds
 * the n-gram index there). The main thread only adopts the result, so the first handwriting
 * recognition does not freeze it. Null when the worker engine is unavailable; the caller then
 * builds the index itself (`loadRecognitionCandidates`). */
const loadWorkerRecognitionContext = (language: SpellingLanguage) => {
  let pending = contextPromises.get(language)
  if (!pending) {
    pending = (async () => {
      if (candidatePromises.has(language)) return null // already built on this thread
      const { loadSpellingEngine } = await import('./spellingEngine')
      const engine = await loadSpellingEngine()
      if (!engine.contextSnapshot) return null
      const snapshot = await engine.contextSnapshot(language)
      installNeuralWordContextSnapshot(language, snapshot)
      installRecognitionWordCandidateProvider(language, (length) => neuralWordContextWordsOfLength(language, length))
      const has = (word: string) => isExtendedNeuralContextWord(word, language)
      installRecognitionWordMembership(language, has)
      return {
        has,
        words: () => Object.values(snapshot.buckets).flatMap((bucket) => bucket.split('\n')),
      }
    })().catch((error) => {
      console.warn('OCR-Wortkontext aus dem Worker nicht verfügbar, er wird im Hauptthread aufgebaut:', error)
      return null
    })
    contextPromises.set(language, pending)
  }
  return pending
}

const loadRecognitionContext = async (language: SpellingLanguage): Promise<RecognitionContext> => {
  const fromWorker = await loadWorkerRecognitionContext(language)
  if (fromWorker) return fromWorker
  const candidates = await loadRecognitionCandidates(language)
  return { has: (word) => candidates.has(word), words: () => [...candidates] }
}

/** Every word of the exhaustive OCR list (any order), for the recognition decoder. */
export const loadRecognitionWordList = async (language: SpellingLanguage) => (await loadRecognitionContext(language)).words()

/** Loads the exhaustive candidate vocabulary only for handwriting OCR. The
 * editor spellchecker keeps using the compact Bloom filter and therefore does
 * not pay the parsing or memory cost during normal application startup. */
export const loadSpellingWordContext = async (language: SpellingLanguage) => {
  const [membership, context] = await Promise.all([
    loadSpellingWordMembership(language),
    loadRecognitionContext(language),
  ])
  return (word: string) => {
    const normalized = normalizeWord(word, language)
    // The sorted OCR list is intentionally stricter than the spelling Bloom
    // filter: valid but corpus-unsupported supplementary entries remain
    // accepted in typed notes without becoming a reason to override the visual
    // handwriting winner. Short words and compounds keep the Bloom path.
    if (/^\p{L}{3,32}$/u.test(normalized)) return context.has(normalized)
    return membership(word)
  }
}

/* ---------- corrections: synchronous view of what is already loaded ---------- */

export type SpellingLexicon = SuggestionLexicon & {
  /** True when the word would be underlined: unknown to the given dictionaries (German and English by default) and to the user. */
  isMisspelled: (word: string, languages?: readonly TextLanguage[]) => boolean
  languages: TextLanguage[]
}

let loadedDictionaries: Dictionaries | null = null
const loadedCandidates: Partial<Record<TextLanguage, Set<string>>> = {}

const lexiconFrom = (dictionaries: Dictionaries, languages: TextLanguage[]): SpellingLexicon => {
  // A candidate is a word when the exact list (or the user) has it. The Bloom
  // filter alone must not admit one: at 0.3 % false positives, a thousand
  // one-edit candidates yield a few junk “words”. German compounds count when
  // every part is an exact list word — Bloom-verified three-letter parts let
  // junk like “Rechtschreibfehlrg” through — and rank below listed words; a
  // compound the dictionary filter also knows as a whole (“Rechtschreibfehler”)
  // ranks above one it does not (“Rechtschreibfehlt”).
  const listed = (language: TextLanguage, normalized: string) => (
    Boolean(loadedCandidates[language]?.has(normalized)) || personalWords().has(normalized)
  )
  const exactPart = (part: string) => Boolean(loadedCandidates.de?.has(part))
  const compound = (language: TextLanguage, normalized: string) => language === 'de' && splitsIntoGermanParts(normalized, exactPart)
  return {
    languages,
    hasWord: (language, normalized) => listed(language, normalized) || compound(language, normalized),
    candidatePenalty: (language, normalized) => {
      if (listed(language, normalized)) return 0
      return dictionaries[language]?.has(normalized, language) ? 4 : 15
    },
    isMisspelled: (word, among = ['de', 'en']) => {
      const membership = wordMembership(word, dictionaries)
      return !among.some((language) => membership[language])
    },
  }
}

/** What autocorrect can use right now without awaiting anything; null until primed. */
export const loadedSpellingLexicon = (): SpellingLexicon | null => {
  if (!loadedDictionaries) return null
  const languages = (['de', 'en', 'fr'] as TextLanguage[]).filter((language) => loadedCandidates[language])
  return languages.length ? lexiconFrom(loadedDictionaries, languages) : null
}

/** Loads the Bloom filters and both exact word lists (≈4.5 MB, parsed once per session). */
export const loadSpellingLexicon = async (): Promise<SpellingLexicon> => {
  const [dictionaries] = await Promise.all([
    loadDictionaries(),
    loadRecognitionCandidates('de'),
    loadRecognitionCandidates('en'),
  ])
  return lexiconFrom(dictionaries, ['de', 'en', ...(loadedCandidates.fr ? ['fr' as const] : [])])
}

/** True when the French dictionary is part of this build and passed validation. */
export const hasFrenchDictionary = async () => Boolean((await loadDictionaries()).fr)

const frenchPromise: { current: Promise<{ bytes: Uint8Array; size: number; count: number; sha256: string } | null> | null } = { current: null }

/** The exact French word list (about 5 MB), fetched once and only when a French passage needs
 * suggestions. Null when this build has no French dictionary. The bytes are validated against the manifest. */
export const loadFrenchWordList = () => {
  frenchPromise.current ??= (async () => {
    if (!(await hasFrenchDictionary())) return null
    const resource = await fetchCandidateResource('fr')
    if (resource.language !== 'fr') throw new Error('Die Wortliste gehört zur falschen Sprache.')
    const bytes = new Uint8Array(resource.bytes)
    if (bytes.byteLength !== resource.descriptor.size || bytes.byteLength > 8 * 1024 * 1024) throw new Error('Die französische Wortliste besitzt eine ungültige Länge.')
    const digest = await sha256(bytes)
    if (digest && digest !== resource.descriptor.sha256) throw new Error('Die französische Wortliste ist beschädigt.')
    return { bytes, size: resource.descriptor.size, count: resource.descriptor.wordCount, sha256: resource.descriptor.sha256 }
  })().catch((error) => {
    frenchPromise.current = null
    throw error
  })
  return frenchPromise.current
}

/** Parses the French word list for the TypeScript engine (the worker parses its own copy). */
export const parseFrenchWordList = (bytes: Uint8Array, count: number) => {
  const decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  if (!decoded.endsWith('\n')) throw new Error('Die französische Wortliste ist unvollständig.')
  const list = decoded.slice(0, -1).split('\n')
  if (list.length !== count) throw new Error('Die französische Wortlistenanzahl ist ungültig.')
  return new Set(list)
}

/** Installs the French exact list for `loadedSpellingLexicon` (TypeScript engine only). */
export const loadFrenchCandidates = async () => {
  if (loadedCandidates.fr) return loadedCandidates.fr
  const list = await loadFrenchWordList()
  if (!list) return null
  loadedCandidates.fr = parseFrenchWordList(list.bytes, list.count)
  return loadedCandidates.fr
}

export const isCanonicalProperName = (normalizedWord: string) => canonicalProperName(normalizedWord)

export const spellingWordPattern = () => new RegExp(WORD_PATTERN.source, 'gu')

const intersects = (from: number, to: number, ranges: SpellingIgnoredRange[]) => ranges.some((range) => from < range.to && to > range.from)

export const automaticIgnoredRanges = (segment: SpellingSegment): SpellingIgnoredRange[] => {
  const ranges: SpellingIgnoredRange[] = []
  const patterns = [
    /`[^`]*`/gu,
    /\$\$[^$]*\$\$|\$[^$\n]+\$/gu,
    /https?:\/\/[^\s)>]+|www\.[^\s)>]+|[\p{L}\d._%+-]+@[\p{L}\d.-]+\.[\p{L}]{2,}/giu,
    /<[^>]+>/gu,
    /\]\([^)]*\)/gu,
  ]
  for (const pattern of patterns) {
    for (const match of segment.text.matchAll(pattern)) {
      const from = segment.from + (match.index ?? 0)
      ranges.push({ from, to: from + match[0].length })
    }
  }
  return ranges
}

type SegmentToken = EvidenceToken & { from: number; to: number }

/** The words of a segment that count for evidence and for underlining: no code, links, math,
 * the word under the caret, acronyms or camelCase. */
const collectTokens = (
  segment: SpellingSegment,
  ignoredRanges: SpellingIgnoredRange[],
  cursorPositions: number[],
  dictionaries: Dictionaries,
): SegmentToken[] => {
  const localIgnored = [...ignoredRanges, ...automaticIgnoredRanges(segment)]
  return [...segment.text.matchAll(WORD_PATTERN)].flatMap((match) => {
    const word = match[0]
    const from = segment.from + (match.index ?? 0)
    const to = from + word.length
    const normalized = normalizeWord(word, 'de')
    if (
      normalized.length < 2
      || intersects(from, to, localIgnored)
      || cursorPositions.some((cursor) => cursor >= from && cursor <= to)
      || segment.text[Math.max(0, (match.index ?? 0) - 1)] === '#'
      || (/^[A-ZÄÖÜ]{2,}$/u.test(word) && word.length <= 16)
      || /\p{Ll}\p{Lu}/u.test(word)
    ) return []
    return [{ word, from, to, normalized, membership: wordMembership(word, dictionaries) }]
  })
}

/* ---------- evidence of lines and of the whole note ---------- */

const LINE_EVIDENCE_LIMIT = 60_000
const MAX_EVIDENCE_LINE_LENGTH = 800
let lineEvidenceCache = new Map<string, { version: number; evidence: LanguageEvidence }>()

/** The language evidence of one line of prose, remembered by its text: an unchanged line is never read twice. */
const lineEvidence = (text: string, dictionaries: Dictionaries): LanguageEvidence => {
  const cached = lineEvidenceCache.get(text)
  if (cached && cached.version === lexiconVersion) return cached.evidence
  const trimmed = text.length > MAX_EVIDENCE_LINE_LENGTH ? text.slice(0, MAX_EVIDENCE_LINE_LENGTH) : text
  const evidence = /\p{L}/u.test(trimmed)
    ? scoreTokens(collectTokens({ from: 0, text: trimmed }, [], [], dictionaries)).evidence
    : emptyEvidence()
  if (lineEvidenceCache.size >= LINE_EVIDENCE_LIMIT) lineEvidenceCache = new Map()
  lineEvidenceCache.set(text, { version: lexiconVersion, evidence })
  return evidence
}

/** A note as the profile reads it: `iterLines(from)` yields the lines starting at the 1-based line `from`
 * (CodeMirror's `Text`). */
export type TextSource = { iterLines: (from?: number) => Iterable<string> }
type ProfileResult = { evidence: LanguageEvidence; complete: boolean }
type ProfileProgress = { version: number; nextLine: number; evidence: LanguageEvidence; isProse: (line: string) => boolean; complete: boolean }
const PROFILE_BUDGET_MS = 6
const profileProgress = new WeakMap<object, ProfileProgress>()

/** The language profile of a whole note. Lines already seen cost one map lookup; new lines are
 * read until `budgetMs` is used up, and `complete` says whether the whole note is in. A caller
 * that gets `false` asks again a moment later with the same `document` and the work continues where
 * it stopped. A changed note is a new object and is read again, from the cached lines. */
const documentProfile = (document: TextSource, dictionaries: Dictionaries, budgetMs = PROFILE_BUDGET_MS): ProfileResult => {
  let progress = profileProgress.get(document)
  if (!progress || progress.version !== lexiconVersion) {
    progress = { version: lexiconVersion, nextLine: 1, evidence: emptyEvidence(), isProse: proseLineFilter(), complete: false }
    profileProgress.set(document, progress)
  }
  if (progress.complete) return { evidence: { ...progress.evidence }, complete: true }
  const started = performance.now()
  let uncached = 0
  let lineNumber = progress.nextLine
  let finished = true
  for (const line of document.iterLines(progress.nextLine)) {
    if (!progress.isProse(line) || !/\p{L}/u.test(line)) {
      lineNumber += 1
      continue
    }
    const known = lineEvidenceCache.get(line)
    if (!known || known.version !== lexiconVersion) {
      uncached += 1
      if ((uncached & 15) === 0 && performance.now() - started > budgetMs) {
        finished = false
        break
      }
    }
    addEvidence(progress.evidence, known && known.version === lexiconVersion ? known.evidence : lineEvidence(line, dictionaries))
    lineNumber += 1
  }
  progress.nextLine = lineNumber
  progress.complete = finished
  return { evidence: { ...progress.evidence }, complete: finished }
}

/* ---------- passages ---------- */

type PreparedPassage = PassageRange & { score: PassageScore; resolution: PassageLanguage; tokens: SegmentToken[] }
type PreparedSegment = {
  segment: SpellingSegment
  tokens: SegmentToken[]
  passages: PreparedPassage[]
  lineEvidence: LanguageEvidence
  blank: boolean
}

const passageIndexOf = (passages: PassageRange[], offset: number) => {
  const inside = passages.findIndex((passage) => offset >= passage.from && offset < passage.to)
  if (inside >= 0) return inside
  let before = -1
  passages.forEach((passage, index) => { if (passage.from <= offset) before = index })
  return Math.max(0, before)
}

const NEIGHBOUR_WEIGHTS_BEFORE = [0.5, 0.3, 0.15]
const NEIGHBOUR_WEIGHTS_AFTER = [0.5, 0.25]

/** Weighted evidence of the nearest lines of the same paragraph. Both lists start at the closest line;
 * a null entry (a blank or missing line) ends the paragraph in that direction. */
const neighbourEvidence = (before: ReadonlyArray<LanguageEvidence | null>, after: ReadonlyArray<LanguageEvidence | null>) => {
  const total = emptyEvidence()
  for (const [lines, weights] of [[before, NEIGHBOUR_WEIGHTS_BEFORE], [after, NEIGHBOUR_WEIGHTS_AFTER]] as const) {
    for (let distance = 0; distance < weights.length; distance += 1) {
      const line = lines[distance]
      if (!line) break
      addEvidence(total, line, weights[distance])
    }
  }
  return total
}

const preparePassages = (
  segment: SpellingSegment,
  tokens: SegmentToken[],
  neighbours: LanguageEvidence,
  prior: LanguageEvidence,
): PreparedPassage[] => {
  const ranges = splitPassages(segment.text)
  if (!ranges.length) return []
  const bucket = ranges.map((): SegmentToken[] => [])
  for (const token of tokens) bucket[passageIndexOf(ranges, token.from - segment.from)].push(token)
  const scores = bucket.map((list) => scoreTokens(list))
  // Sentences of an Italian line are Italian even when one of them carries few telltale words.
  const lineScore = scores.reduce((sum, score) => mergeScores(sum, score), scoreTokens([]))
  const wholeLineUnsupported = ranges.every((range) => range.kind !== 'vocabulary' && range.kind !== 'cell' && range.kind !== 'column') && isUnsupported(lineScore)
  const sentenceLike = ranges.every((range) => range.kind === 'sentence' || range.kind === 'quote' || range.kind === 'line')
  const first = ranges.map((range, index) => {
    // Sentences of one line often share a language; the sides of a vocabulary pair never do.
    const siblings = emptyEvidence()
    if (sentenceLike) scores.forEach((score, other) => { if (other !== index) addEvidence(siblings, score.evidence) })
    if (wholeLineUnsupported) return { ...UNKNOWN_PASSAGE, unsupported: true, foreign: true, source: 'local' as const }
    return resolvePassage(scores[index], { neighbours, prior, siblings })
  })
  return ranges.map((range, index) => {
    const own = first[index]
    const pair = !sentenceLike
    // A weak side of a pair is not the language of its confident partner.
    const partners = pair
      ? first.flatMap((other, otherIndex) => (otherIndex !== index && other.confident && other.language ? [other.language] : []))
      : []
    const resolution = pair && !own.confident && partners.length
      ? resolvePassage(scores[index], { neighbours, prior, partnerLanguages: partners })
      : own
    return { ...range, score: scores[index], resolution, tokens: bucket[index] }
  })
}

/** The language a word may be written in, besides German and English: French once the note or the passage uses it. */
export const allowedLanguages = (present: readonly TextLanguage[], passageLanguage: TextLanguage | null): TextLanguage[] => {
  const allowed: TextLanguage[] = ['de', 'en']
  if (present.includes('fr') || passageLanguage === 'fr') allowed.push('fr')
  return allowed
}

export type PassageAtInput = {
  /** Text of the line the caret is in. */
  text: string
  /** Offset of the word in `text`. */
  offset: number
  /** The lines before (nearest first) and after, from the same paragraph. */
  previous?: string[]
  next?: string[]
  /** The profile of the note from the last spelling pass. */
  profile?: LanguageEvidence | null
}
export type PassageAt = { passage: PassageLanguage; present: TextLanguage[]; allowed: TextLanguage[] }

/** The language of the passage around `offset`, computed on the spot from what is loaded. This is
 * what autocorrect asks, so a line typed a moment ago is already understood. Null until the dictionaries are loaded. */
export const resolvePassageAt = ({ text, offset, previous = [], next = [], profile = null }: PassageAtInput): PassageAt | null => {
  const dictionaries = loadedDictionaries
  if (!dictionaries) return null
  const tokens = collectTokens({ from: 0, text }, [], [], dictionaries)
  const evidenceOfLine = (line: string) => (line.trim() ? lineEvidence(line, dictionaries) : null)
  const neighbours = neighbourEvidence(previous.map(evidenceOfLine), next.map(evidenceOfLine))
  const present = profile ? presentLanguages(profile) : []
  const prior = profile ? profilePrior(profile) : emptyEvidence()
  const passages = preparePassages({ from: 0, text }, tokens, neighbours, prior)
  if (!passages.length) return { passage: { language: null, confident: false, unsupported: false, foreign: false, source: 'none' }, present, allowed: allowedLanguages(present, null) }
  const passage = passages[passageIndexOf(passages, offset)]
  return { passage: passage.resolution, present, allowed: allowedLanguages(present, passage.resolution.language) }
}

export async function checkSpelling({
  segments,
  ignoredRanges = [],
  cursorPositions = [],
  document,
}: {
  segments: SpellingSegment[]
  ignoredRanges?: SpellingIgnoredRange[]
  cursorPositions?: number[]
  /** The whole note, for its language profile. Without it the profile is read from the segments. */
  document?: TextSource
}): Promise<SpellingCheckResult> {
  if (!segments.length) return EMPTY_RESULT()
  let dictionaries: Dictionaries
  try {
    dictionaries = await loadDictionaries()
  } catch (error) {
    if (!warnedAboutResources) {
      warnedAboutResources = true
      console.warn('FaNotes-Rechtschreibprüfung konnte nicht geladen werden:', error)
    }
    return EMPTY_RESULT()
  }

  const tokenLists = segments.map((segment) => collectTokens(segment, ignoredRanges, cursorPositions, dictionaries))
  const ownEvidence = segments.map((segment, index) => (
    segment.text.trim() ? scoreTokens(tokenLists[index]).evidence : null
  ))
  // The note's profile: the whole text when the editor hands it over, otherwise just these lines.
  let profileResult: ProfileResult
  if (document) profileResult = documentProfile(document, dictionaries)
  else {
    const evidence = emptyEvidence()
    ownEvidence.forEach((line) => { if (line) addEvidence(evidence, line) })
    profileResult = { evidence, complete: true }
  }
  const profile = profileResult.evidence
  const present = presentLanguages(profile)
  const prior = profilePrior(profile)

  // Neighbours only count across directly following lines of the same paragraph.
  const follows = (index: number) => index > 0 && index < segments.length && segments[index - 1].from + segments[index - 1].text.length + 1 === segments[index].from
  const reach = (index: number, step: -1 | 1, count: number) => {
    const found: Array<LanguageEvidence | null> = []
    for (let distance = 1; distance <= count; distance += 1) {
      const at = index + step * distance
      const joined = step === -1 ? follows(at + 1) : follows(at)
      found.push(at >= 0 && at < segments.length && joined ? ownEvidence[at] : null)
    }
    return found
  }
  const prepared: PreparedSegment[] = segments.map((segment, index) => ({
    segment,
    tokens: tokenLists[index],
    passages: preparePassages(
      segment,
      tokenLists[index],
      neighbourEvidence(reach(index, -1, NEIGHBOUR_WEIGHTS_BEFORE.length), reach(index, 1, NEIGHBOUR_WEIGHTS_AFTER.length)),
      prior,
    ),
    lineEvidence: ownEvidence[index] ?? emptyEvidence(),
    blank: !segment.text.trim(),
  }))

  const documentDecision = decideLanguage(profile)
  const documentLanguage: TextLanguage = present[0] ?? documentDecision.language ?? 'de'
  const errors: SpellingError[] = []
  const lines: SpellingLine[] = []
  const passages: SpellingPassage[] = []
  for (const item of prepared) {
    if (item.blank) continue
    const confidentPassage = item.passages.find((passage) => passage.resolution.confident && passage.resolution.language)
    const guess = item.passages.find((passage) => passage.resolution.language)
    lines.push({
      from: item.segment.from,
      to: item.segment.from + item.segment.text.length,
      language: (confidentPassage ?? guess)?.resolution.language ?? documentLanguage,
      confident: Boolean(confidentPassage),
    })
    for (const passage of item.passages) {
      passages.push({ ...passage.resolution, from: item.segment.from + passage.from, to: item.segment.from + passage.to, kind: passage.kind })
      if (passage.resolution.unsupported) continue
      const allowed = allowedLanguages(present, passage.resolution.language)
      const language = passage.resolution.language ?? documentLanguage
      for (const token of passage.tokens) {
        if (allowed.some((candidate) => token.membership[candidate])) continue
        errors.push({ from: token.from, to: token.to, word: token.word, language })
      }
    }
    // Words that fell outside every passage (nothing to read around them) are still checked.
    if (!item.passages.length) {
      for (const token of item.tokens) {
        if (allowedLanguages(present, null).some((candidate) => token.membership[candidate])) continue
        errors.push({ from: token.from, to: token.to, word: token.word, language: documentLanguage })
      }
    }
  }
  return {
    errors,
    lines,
    passages,
    detectedLanguage: detectedLanguageOf(present),
    languages: present,
    profile,
    profileComplete: profileResult.complete,
  }
}
