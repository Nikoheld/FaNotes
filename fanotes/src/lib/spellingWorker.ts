/// <reference lib="webworker" />
import { createSpellWasm, type SpellWasm } from './spellingWasmCore'
import type { SpellingLanguage } from '../types'
import type { SpellingWorkerInput } from './spelling'

/**
 * Spelling worker: validates the exact OCR word lists, builds the lexicon and answers correction
 * and word context queries with the Rust wasm, so none of it runs on the main thread.
 */

export type SpellingWorkerRequest =
  | { id: number; op: 'install'; input: SpellingWorkerInput; personalWords: string[] }
  | { id: number; op: 'userWords'; words: string[] }
  | { id: number; op: 'suggest'; typed: string; languages: SpellingLanguage[]; limit: number; maxDistance: 1 | 2 }
  | {
    id: number
    op: 'autocorrect'
    typed: string
    languages: SpellingLanguage[]
    language: SpellingLanguage | null
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

const handle = async (request: SpellingWorkerRequest): Promise<unknown> => {
  const spell = requireWasm()
  switch (request.op) {
    case 'install':
      await spell.install(request.input, request.personalWords)
      return spell.languages()
    case 'userWords':
      spell.setUserWords(request.words)
      return null
    case 'suggest':
      return spell.suggest(request.typed, request.languages, request.limit, request.maxDistance)
    case 'autocorrect':
      return spell.planAutocorrect(request.typed, request.languages, request)
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
