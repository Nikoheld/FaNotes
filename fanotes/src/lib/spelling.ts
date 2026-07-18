import type { DetectedTextLanguage, SpellingLanguage, SpellingResources } from '../types'
import { installNeuralWordContextCandidates } from './neuralWordContext'

export type SpellingSegment = { from: number; text: string }
export type SpellingIgnoredRange = { from: number; to: number }
export type SpellingError = {
  from: number
  to: number
  word: string
  language: SpellingLanguage
}
export type SpellingLine = {
  from: number
  to: number
  language: SpellingLanguage
}
export type SpellingCheckResult = {
  errors: SpellingError[]
  lines: SpellingLine[]
  detectedLanguage: DetectedTextLanguage
}

type LanguageEvidence = { de: number; en: number }
type FilterDescriptor = SpellingResources['manifest']['languages'][SpellingLanguage]

const WORD_PATTERN = /\p{L}[\p{L}\p{M}'’\-]*/gu
const TECHNICAL_WORDS = new Set([
  'ai', 'amat', 'anthropic', 'appimage', 'arch', 'browser', 'chromium', 'codemirror', 'codex',
  'electron', 'fanotes', 'gemini', 'glyphenwerk', 'github', 'google', 'html', 'hyprland',
  'javascript', 'katex', 'latex', 'linux', 'lm', 'markdown', 'nas', 'ollama', 'openai',
  'opencode', 'pdf', 'typescript', 'url', 'vulkan', 'wayland', 'web', 'windows',
])
const DE_STOPWORDS = new Set([
  'aber', 'als', 'auch', 'auf', 'aus', 'bei', 'das', 'dem', 'den', 'der', 'des', 'die',
  'ein', 'eine', 'einer', 'eines', 'für', 'hat', 'ich', 'im', 'in', 'ist', 'mit', 'nicht',
  'oder', 'sich', 'sie', 'sind', 'und', 'von', 'war', 'werden', 'wie', 'wir', 'zu', 'zum',
])
const EN_STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'has', 'he', 'in', 'is',
  'it', 'not', 'of', 'on', 'or', 'she', 'that', 'the', 'this', 'to', 'was', 'we', 'were',
  'will', 'with', 'you',
])

const normalizeWord = (word: string, language: SpellingLanguage) => {
  const normalized = word
    .normalize('NFC')
    .toLocaleLowerCase(language === 'de' ? 'de-CH' : 'en-US')
    .replace(/^['’\-]+|['’\-]+$/gu, '')
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

  has(rawWord: string, language: SpellingLanguage) {
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

type Dictionaries = Record<SpellingLanguage, BloomFilter>
let dictionariesPromise: Promise<Dictionaries> | null = null
let warnedAboutResources = false

const sha256 = async (bytes: Uint8Array) => {
  if (!globalThis.crypto?.subtle) return null
  const source = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
  const digest = await globalThis.crypto.subtle.digest('SHA-256', source)
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

const loadDictionaries = async (): Promise<Dictionaries> => {
  dictionariesPromise ??= window.fanotes.loadSpellingResources().then(async (resources) => {
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
    return {
      de: new BloomFilter(de, resources.manifest.languages.de, hashes),
      en: new BloomFilter(en, resources.manifest.languages.en, hashes),
    }
  }).catch((error) => {
    dictionariesPromise = null
    throw error
  })
  return dictionariesPromise
}

const isGermanCompound = (rawWord: string, filter: BloomFilter) => {
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
      if (filter.has(part, 'de') && findParts(end, parts + 1)) {
        memo.set(key, true)
        return true
      }
    }
    memo.set(key, false)
    return false
  }
  return findParts(0, 0)
}

const wordMembership = (word: string, dictionaries: Dictionaries) => {
  const normalized = normalizeWord(word, 'de')
  if (!normalized) return { de: true, en: true }
  if (TECHNICAL_WORDS.has(normalized)) return { de: true, en: true }
  if (normalized.includes('-')) {
    const parts = normalized.split('-').filter(Boolean)
    if (parts.length > 1) {
      const membership = parts.map((part) => ({
        de: dictionaries.de.has(part, 'de') || isGermanCompound(part, dictionaries.de),
        en: dictionaries.en.has(part, 'en'),
      }))
      // Mixed school vocabulary such as “Inline-Mathematik” is valid when
      // every hyphen part exists in at least one active language.
      if (membership.every((part) => part.de || part.en)) return { de: true, en: true }
      return {
        de: membership.every((part) => part.de),
        en: membership.every((part) => part.en),
      }
    }
  }
  return {
    de: dictionaries.de.has(normalized, 'de') || isGermanCompound(normalized, dictionaries.de),
    en: dictionaries.en.has(normalized, 'en'),
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

const candidatePromises = new Map<SpellingLanguage, Promise<void>>()

const loadRecognitionCandidates = async (language: SpellingLanguage) => {
  let pending = candidatePromises.get(language)
  if (!pending) {
    pending = window.fanotes.loadSpellingWordCandidates(language).then(async (resource) => {
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
    }).catch((error) => {
      candidatePromises.delete(language)
      throw error
    })
    candidatePromises.set(language, pending)
  }
  return pending
}

/** Loads the exhaustive candidate vocabulary only for handwriting OCR. The
 * editor spellchecker keeps using the compact Bloom filter and therefore does
 * not pay the parsing or memory cost during normal application startup. */
export const loadSpellingWordContext = async (language: SpellingLanguage) => {
  const [membership] = await Promise.all([
    loadSpellingWordMembership(language),
    loadRecognitionCandidates(language),
  ])
  return membership
}

const evidenceLanguage = (evidence: LanguageEvidence): SpellingLanguage | null => {
  if (evidence.de === 0 && evidence.en === 0) return null
  if (evidence.de >= evidence.en * 1.35) return 'de'
  if (evidence.en >= evidence.de * 1.35) return 'en'
  return null
}

const intersects = (from: number, to: number, ranges: SpellingIgnoredRange[]) => ranges.some((range) => from < range.to && to > range.from)

const automaticIgnoredRanges = (segment: SpellingSegment): SpellingIgnoredRange[] => {
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

export async function checkSpelling({
  segments,
  ignoredRanges = [],
  cursorPositions = [],
}: {
  segments: SpellingSegment[]
  ignoredRanges?: SpellingIgnoredRange[]
  cursorPositions?: number[]
}): Promise<SpellingCheckResult> {
  if (!segments.length) return { errors: [], lines: [], detectedLanguage: 'unknown' }
  let dictionaries: Dictionaries
  try {
    dictionaries = await loadDictionaries()
  } catch (error) {
    if (!warnedAboutResources) {
      warnedAboutResources = true
      console.warn('FaNotes-Rechtschreibprüfung konnte nicht geladen werden:', error)
    }
    return { errors: [], lines: [], detectedLanguage: 'unknown' }
  }

  const segmentWords = segments.map((segment) => {
    const localIgnored = [...ignoredRanges, ...automaticIgnoredRanges(segment)]
    const words = [...segment.text.matchAll(WORD_PATTERN)].flatMap((match) => {
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
    const evidence = words.reduce<LanguageEvidence>((score, token) => {
      if (DE_STOPWORDS.has(token.normalized)) score.de += 3
      if (EN_STOPWORDS.has(token.normalized)) score.en += 3
      if (token.membership.de && !token.membership.en) score.de += 2
      if (token.membership.en && !token.membership.de) score.en += 2
      return score
    }, { de: 0, en: 0 })
    return { segment, words, evidence, language: evidenceLanguage(evidence) }
  })

  const documentEvidence = segmentWords.reduce<LanguageEvidence>((score, segment) => ({
    de: score.de + segment.evidence.de,
    en: score.en + segment.evidence.en,
  }), { de: 0, en: 0 })
  const documentLanguage = evidenceLanguage(documentEvidence) ?? (documentEvidence.en > documentEvidence.de ? 'en' : 'de')
  const explicitLanguages = new Set(segmentWords.map(({ language }) => language).filter(Boolean))
  const detectedLanguage: DetectedTextLanguage = explicitLanguages.size > 1
    ? 'mixed'
    : explicitLanguages.values().next().value ?? (documentEvidence.de || documentEvidence.en ? documentLanguage : 'unknown')

  const errors: SpellingError[] = []
  const lines: SpellingLine[] = []
  for (const { segment, words, language } of segmentWords) {
    const resolvedLanguage = language ?? documentLanguage
    if (segment.text.trim()) lines.push({ from: segment.from, to: segment.from + segment.text.length, language: resolvedLanguage })
    for (const token of words) {
      if (token.membership.de || token.membership.en) continue
      errors.push({ from: token.from, to: token.to, word: token.word, language: resolvedLanguage })
    }
  }
  return { errors, lines, detectedLanguage }
}
