/// <reference lib="webworker" />
import { createSpellWasm, type SpellWasm } from './spellingWasmCore'
import type { SpellingLanguage, TextLanguage } from '../types'
import { decideAutocorrect, suggestCorrections, type SpellingSuggestion, type SuggestionLexicon } from './spellingSuggest'
import type { SpellingWorkerInput } from './spelling'

/**
 * Spelling worker: validates the exact OCR word lists, builds the lexicon and answers correction
 * and word context queries with the Rust wasm, so none of it runs on the main thread.
 */

export type SpellingWorkerRequest =
  | { id: number; op: 'install'; input: SpellingWorkerInput; personalWords: string[] }
  | { id: number; op: 'userWords'; words: string[] }
  | { id: number; op: 'frenchInstall'; list: { bytes: Uint8Array; size: number; count: number; sha256: string }; personalWords: string[] }
  | { id: number; op: 'suggest'; typed: string; languages: TextLanguage[]; limit: number; maxDistance: 1 | 2 }
  | {
    id: number
    op: 'autocorrect'
    typed: string
    languages: TextLanguage[]
    language: TextLanguage | null
    sentenceStart: boolean
    properName: boolean
  }
  | { id: number; op: 'context'; call: 'build' | 'snapshot' | 'isExtendedWord' | 'sequenceScore' | 'subwordScore' | 'wordsOfLength' | 'nearest'; args: unknown[] }

export type SpellingWorkerResponse = { id: number; ok: true; result: unknown } | { id: number; ok: false; error: string }

const scope = self as unknown as DedicatedWorkerGlobalScope
let wasm: SpellWasm | null = null
const requireWasm = () => {
  wasm ??= createSpellWasm()
  return wasm
}

/** French runs in TypeScript: the Rust core knows German and English only. The exact list stays in this worker. */
let frenchWords: Set<string> | null = null
let userWords = new Set<string>()
const frenchLexicon: SuggestionLexicon = {
  hasWord: (language, word) => language === 'fr' && Boolean(frenchWords?.has(word) || userWords.has(word)),
  candidatePenalty: () => 0,
}

const sha256Hex = async (bytes: Uint8Array) => {
  const source = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
  const digest = await crypto.subtle.digest('SHA-256', source)
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

const installFrench = async (list: { bytes: Uint8Array; size: number; count: number; sha256: string }) => {
  if (list.bytes.byteLength !== list.size) throw new Error('Die französische Wortliste besitzt eine ungültige Länge.')
  if (crypto.subtle && (await sha256Hex(list.bytes)) !== list.sha256) throw new Error('Die französische Wortliste ist beschädigt.')
  const decoded = new TextDecoder('utf-8', { fatal: true }).decode(list.bytes)
  if (!decoded.endsWith('\n')) throw new Error('Die französische Wortliste ist unvollständig.')
  const words = decoded.slice(0, -1).split('\n')
  if (words.length !== list.count) throw new Error('Die französische Wortlistenanzahl ist ungültig.')
  frenchWords = new Set(words)
}

const byScore = (left: SpellingSuggestion, right: SpellingSuggestion) => left.score - right.score || left.word.localeCompare(right.word, 'de')

const handle = async (request: SpellingWorkerRequest): Promise<unknown> => {
  const spell = requireWasm()
  switch (request.op) {
    case 'install':
      await spell.install(request.input, request.personalWords)
      return spell.languages()
    case 'userWords':
      spell.setUserWords(request.words)
      userWords = new Set(request.words)
      return null
    case 'frenchInstall':
      await installFrench(request.list)
      userWords = new Set(request.personalWords)
      return null
    case 'suggest': {
      const base = request.languages.filter((language): language is SpellingLanguage => language !== 'fr')
      const found = base.length ? spell.suggest(request.typed, base, request.limit, request.maxDistance) : []
      if (!request.languages.includes('fr') || !frenchWords) return found
      const french = suggestCorrections(request.typed, ['fr'], frenchLexicon, { limit: request.limit, maxDistance: request.maxDistance })
      return [...found, ...french].sort(byScore).slice(0, request.limit)
    }
    case 'autocorrect': {
      if (request.languages.includes('fr')) {
        // Only ever asked for the one language of the passage.
        if (!frenchWords || request.languages.some((language) => language !== 'fr')) return null
        const suggestions = suggestCorrections(request.typed, ['fr'], frenchLexicon, { limit: 4, maxDistance: 1 })
        return decideAutocorrect(request.typed, suggestions, {
          language: request.language,
          sentenceStart: request.sentenceStart,
          isProperName: () => request.properName,
        })
      }
      return spell.planAutocorrect(request.typed, request.languages as SpellingLanguage[], { ...request, language: request.language === 'fr' ? null : request.language })
    }
    case 'context': {
      const call = spell.context[request.call] as (...args: unknown[]) => unknown
      return call(...request.args)
    }
  }
}

scope.onmessage = (event: MessageEvent<SpellingWorkerRequest>) => {
  const request = event.data
  handle(request).then(
    (result) => scope.postMessage({ id: request.id, ok: true, result } satisfies SpellingWorkerResponse),
    (error: unknown) => scope.postMessage({
      id: request.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    } satisfies SpellingWorkerResponse),
  )
}
