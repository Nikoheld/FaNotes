import type { SpellingLanguage } from '../types'
import type { SpellingSuggestion } from './spellingSuggest'
import type { NeuralWordContextSnapshot } from './neuralWordContext'
import type { SpellingWorkerRequest, SpellingWorkerResponse } from './spellingWorker'

/**
 * Asynchronous spelling corrections for the editor. The exact word lists (about 4.5 MB) are
 * validated and indexed in a Web Worker running the Rust wasm, so opening a note never blocks
 * the main thread. If the worker or the wasm cannot start, the TypeScript implementation runs on
 * the main thread as before; callers see the same interface either way.
 */

export type AutocorrectContext = {
  /** Language the surrounding line was recognised as; null when unknown. */
  language: SpellingLanguage | null
  /** The word opens a sentence (start of line or after . ! ? : ). */
  sentenceStart: boolean
  /** The normalised word is a known proper name, which autocorrect never rewrites. */
  properName: boolean
}

export type SpellingEngine = {
  readonly kind: 'wasm-worker' | 'typescript'
  readonly languages: SpellingLanguage[]
  /** True when the word would be underlined (Bloom filters and the user's words; synchronous). */
  isMisspelled: (word: string) => boolean
  suggest: (
    word: string,
    languages: SpellingLanguage[] | null,
    options?: { limit?: number; maxDistance?: 1 | 2 },
  ) => Promise<SpellingSuggestion[]>
  /** The OCR word context index of one language, built by the Rust core in the worker. Only the
   * worker engine has it; the TypeScript engine leaves it out and recognition builds the index
   * itself. */
  contextSnapshot?: (language: SpellingLanguage) => Promise<NeuralWordContextSnapshot>
  /** The one correction safe to apply while typing, or null. */
  planAutocorrect: (
    word: string,
    languages: SpellingLanguage[] | null,
    context: AutocorrectContext,
  ) => Promise<SpellingSuggestion | null>
}

type SpellingModule = typeof import('./spelling')
type SuggestModule = typeof import('./spellingSuggest')

const createTypeScriptEngine = async (spelling: SpellingModule, suggest: SuggestModule): Promise<SpellingEngine> => {
  const lexicon = await spelling.loadSpellingLexicon()
  return {
    kind: 'typescript',
    languages: lexicon.languages,
    isMisspelled: (word) => lexicon.isMisspelled(word),
    suggest: async (word, languages, { limit = 6, maxDistance = 2 } = {}) => (
      suggest.suggestCorrections(word, languages ?? lexicon.languages, lexicon, { limit, maxDistance })
    ),
    planAutocorrect: async (word, languages, context) => {
      const suggestions = suggest.suggestCorrections(word, languages ?? lexicon.languages, lexicon, { limit: 4, maxDistance: 1 })
      return suggest.decideAutocorrect(word, suggestions, {
        language: context.language,
        sentenceStart: context.sentenceStart,
        isProperName: () => context.properName,
      })
    },
  }
}

type DistributiveOmit<T, K extends keyof never> = T extends unknown ? Omit<T, K> : never

const createWorkerEngine = async (
  spelling: SpellingModule,
  suggest: SuggestModule,
  isMisspelled: (word: string) => boolean,
): Promise<SpellingEngine> => {
  if (typeof Worker === 'undefined') throw new Error('Web Worker nicht verfügbar.')
  const worker = new Worker(new URL('./spellingWorker.ts', import.meta.url), { type: 'module' })
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()
  let nextId = 1
  let failure: Error | null = null
  const fail = (error: Error) => {
    failure ??= error
    for (const entry of pending.values()) entry.reject(error)
    pending.clear()
    worker.terminate()
  }
  worker.onmessage = (event: MessageEvent<SpellingWorkerResponse>) => {
    const entry = pending.get(event.data.id)
    if (!entry) return
    pending.delete(event.data.id)
    if (event.data.ok) entry.resolve(event.data.result)
    else entry.reject(new Error(event.data.error))
  }
  worker.onerror = (event) => fail(new Error(event.message || 'Der Rechtschreib-Worker ist abgestürzt.'))
  worker.onmessageerror = () => fail(new Error('Der Rechtschreib-Worker lieferte eine ungültige Antwort.'))
  const call = <T>(request: DistributiveOmit<SpellingWorkerRequest, 'id'>, transfer: Transferable[] = []) => (
    new Promise<T>((resolve, reject) => {
      if (failure) {
        reject(failure)
        return
      }
      const id = nextId
      nextId += 1
      pending.set(id, { resolve: resolve as (value: unknown) => void, reject })
      worker.postMessage({ ...request, id }, transfer)
    })
  )

  try {
    const input = await spelling.loadSpellingWorkerInput()
    const transfer = [
      input.bloom.de.bytes.buffer, input.bloom.en.bytes.buffer, input.words.de.bytes.buffer, input.words.en.bytes.buffer,
    ].filter((buffer, index, all) => all.indexOf(buffer) === index)
    const languages = await call<SpellingLanguage[]>({ op: 'install', input, personalWords: [...suggest.personalWords()] }, transfer)
    suggest.onPersonalWordsChanged(() => { void call({ op: 'userWords', words: [...suggest.personalWords()] }).catch(() => undefined) })

    let fallback: Promise<SpellingEngine> | null = null
    // A worker that dies later hands every request to the TypeScript engine.
    const guarded = async <T>(run: () => Promise<T>, backup: (engine: SpellingEngine) => Promise<T>) => {
      try {
        return await run()
      } catch (error) {
        if (!failure) throw error
        fallback ??= createTypeScriptEngine(spelling, suggest)
        return backup(await fallback)
      }
    }
    return {
      kind: 'wasm-worker',
      languages,
      isMisspelled,
      suggest: (word, among, options = {}) => guarded(
        () => call<SpellingSuggestion[]>({
          op: 'suggest', typed: word, languages: among ?? languages, limit: options.limit ?? 6, maxDistance: options.maxDistance ?? 2,
        }),
        (engine) => engine.suggest(word, among, options),
      ),
      contextSnapshot: async (language) => JSON.parse(await call<string>({ op: 'context', call: 'snapshot', args: [language] })) as NeuralWordContextSnapshot,
      planAutocorrect: (word, among, context) => guarded(
        () => call<SpellingSuggestion | null>({ op: 'autocorrect', typed: word, languages: among ?? languages, ...context }),
        (engine) => engine.planAutocorrect(word, among, context),
      ),
    }
  } catch (error) {
    fail(error instanceof Error ? error : new Error(String(error)))
    throw error
  }
}

let enginePromise: Promise<SpellingEngine> | null = null
let loadedEngine: SpellingEngine | null = null

/** What corrections can use right now without awaiting; null until `loadSpellingEngine` resolved. */
export const loadedSpellingEngine = () => loadedEngine

export const loadSpellingEngine = (): Promise<SpellingEngine> => {
  enginePromise ??= (async () => {
    const [spelling, suggest] = await Promise.all([import('./spelling'), import('./spellingSuggest')])
    const isMisspelled = await spelling.loadMisspellingCheck()
    let engine: SpellingEngine
    try {
      engine = await createWorkerEngine(spelling, suggest, isMisspelled)
    } catch (error) {
      console.warn('Rechtschreib-Worker (wasm) nicht verfügbar, die TypeScript-Variante wird verwendet:', error)
      engine = await createTypeScriptEngine(spelling, suggest)
    }
    loadedEngine = engine
    return engine
  })().catch((error) => {
    enginePromise = null
    throw error
  })
  return enginePromise
}
