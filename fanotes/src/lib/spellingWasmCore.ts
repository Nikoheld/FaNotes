import {
  buildContext,
  contextIsExtendedWord,
  contextNearest,
  contextSequenceScore,
  contextSubwordScore,
  contextWordsOfLength,
  decideAutocorrect,
  initSync,
  loadBloom,
  loadWords,
  normalizeWord,
  setUserWords,
  suggestAll,
} from './spellWasm/fanotes_spell_wasm.js'
import { SPELL_WASM_BASE64 } from './spellWasm/bytes'
import type { SpellingLanguage } from '../types'
import type { SpellingSuggestion } from './spellingSuggest'
import type { SpellingWorkerInput } from './spelling'

/**
 * The spelling wasm (`crates/fanotes-spell-wasm`) behind a plain object. It runs inside
 * `spellingWorker.ts`; the parity check drives it directly. Rust returns every candidate; ties
 * between equal scores are ordered here with `Intl` (`localeCompare`), exactly as
 * `suggestCorrections` in `spellingSuggest.ts` does, because Rust has no ICU collation.
 */

const wasmBytes = () => {
  const binary = atob(SPELL_WASM_BASE64)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes
}

let ready = false
const ensureWasm = () => {
  if (ready) return
  initSync({ module: wasmBytes() })
  ready = true
}

const sha256 = async (bytes: Uint8Array) => {
  if (!globalThis.crypto?.subtle) return null
  const source = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
  const digest = await globalThis.crypto.subtle.digest('SHA-256', source)
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

export type NearestCandidate = { candidate: string; distance: number }

export type SpellWasm = ReturnType<typeof createSpellWasm>

export const createSpellWasm = () => {
  ensureWasm()
  const languages: SpellingLanguage[] = []

  const sortedSuggestions = (typed: string, among: SpellingLanguage[], maxDistance: 1 | 2) => {
    const all = JSON.parse(suggestAll(typed, JSON.stringify(among), maxDistance)) as SpellingSuggestion[]
    return all.sort((left, right) => left.score - right.score || left.word.localeCompare(right.word, 'de'))
  }

  return {
    /** Validates both lists in Rust and installs them with the Bloom filters. */
    async install(input: SpellingWorkerInput, personalWords: string[]) {
      for (const language of ['de', 'en'] as const) {
        const bloom = input.bloom[language]
        loadBloom(language, bloom.bytes, bloom.bitCount, input.hashes)
        const list = input.words[language]
        const digest = await sha256(list.bytes)
        if (digest && digest !== list.sha256) throw new Error('Die OCR-Wortliste ist beschädigt.')
        loadWords(language, list.bytes, list.size, list.count)
        if (!languages.includes(language)) languages.push(language)
      }
      setUserWords(JSON.stringify(personalWords))
    },
    languages: () => [...languages],
    setUserWords: (words: string[]) => setUserWords(JSON.stringify(words)),
    normalizeWord,
    suggest(typed: string, among: SpellingLanguage[], limit = 6, maxDistance: 1 | 2 = 2): SpellingSuggestion[] {
      return sortedSuggestions(typed, among, maxDistance).slice(0, limit)
    },
    /** The one correction safe to apply without asking, or null (`decideAutocorrect`). */
    planAutocorrect(
      typed: string,
      among: SpellingLanguage[],
      context: { language: SpellingLanguage | null; sentenceStart: boolean; properName: boolean },
    ): SpellingSuggestion | null {
      const suggestions = sortedSuggestions(typed, among, 1).slice(0, 4)
      const index = decideAutocorrect(typed, JSON.stringify(suggestions), context.language ?? '', context.sentenceStart, context.properName)
      return index >= 0 ? suggestions[index] : null
    },
    /** n-gram index of `neuralWordContext.ts`; built on first use per language. */
    context: {
      build: (language: SpellingLanguage) => buildContext(language),
      isExtendedWord: (language: SpellingLanguage, word: string) => contextIsExtendedWord(language, word),
      sequenceScore: (language: SpellingLanguage, word: string) => contextSequenceScore(language, word),
      subwordScore: (language: SpellingLanguage, word: string) => contextSubwordScore(language, word),
      wordsOfLength: (language: SpellingLanguage, length: number) => JSON.parse(contextWordsOfLength(language, length)) as string[],
      nearest(
        language: SpellingLanguage,
        source: string,
        maximumDistance = 1,
        sameLengthOnly = false,
        maximumCandidates = Number.POSITIVE_INFINITY,
      ): NearestCandidate[] {
        const found = (JSON.parse(contextNearest(language, source, maximumDistance, sameLengthOnly)) as [string, number][])
          .map(([candidate, distance]) => ({ candidate, distance }))
        found.sort((first, second) => first.distance - second.distance || first.candidate.localeCompare(second.candidate, language))
        return Number.isFinite(maximumCandidates) ? found.slice(0, Math.max(0, Math.floor(maximumCandidates))) : found
      },
    },
  }
}
