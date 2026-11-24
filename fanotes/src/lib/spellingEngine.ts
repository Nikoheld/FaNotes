import type { TextLanguage } from '../types'
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
  language: TextLanguage | null
  /** The word opens a sentence (start of line or after . ! ? : ). */
  sentenceStart: boolean
  /** The normalised word is a known proper name, which autocorrect never rewrites. */
  properName: boolean
}

export type SpellingEngine = {
  readonly kind: 'wasm-worker' | 'typescript'
  readonly languages: TextLanguage[]
  /** True when the word is unknown to the given languages (German and English by default) and to the
   * user: the Bloom filters and the user's words, synchronous. */
  isMisspelled: (word: string, languages?: readonly TextLanguage[]) => boolean
  suggest: (
    word: string,
    languages: TextLanguage[] | null,
    options?: { limit?: number; maxDistance?: 1 | 2 },
  ) => Promise<SpellingSuggestion[]>
  /** The OCR word context index of one language, built by the Rust core in the worker. Only the
   * worker engine has it; the TypeScript engine leaves it out and recognition builds the index
   * itself. */
  contextSnapshot?: (language: 'de' | 'en') => Promise<NeuralWordContextSnapshot>
  /** Loads what suggestions in these languages need (the French word list), ahead of the first request. */
  prepare?: (languages: TextLanguage[]) => Promise<void>
  /** The one correction safe to apply while typing, or null. */
  planAutocorrect: (
    word: string,
    languages: TextLanguage[] | null,
    context: AutocorrectContext,
  ) => Promise<SpellingSuggestion | null>
}

type SpellingModule = typeof import('./spelling')
type SuggestModule = typeof import('./spellingSuggest')

/** French needs the exact word list (about 5 MB) to verify candidates. It is read the first time a
 * French passage asks for suggestions, never at startup. */
const createTypeScriptEngine = async (spelling: SpellingModule, suggest: SuggestModule): Promise<SpellingEngine> => {
  const lexicon = await spelling.loadSpellingLexicon()
  const prepare = async (languages: TextLanguage[] | null) => {
    if (languages?.includes('fr')) await spelling.loadFrenchCandidates().catch(() => null)
  }
  return {
    kind: 'typescript',
    languages: lexicon.languages,
    isMisspelled: (word, languages) => lexicon.isMisspelled(word, languages),
    prepare: (languages) => prepare(languages),
    suggest: async (word, languages, { limit = 6, maxDistance = 2 } = {}) => {
      await prepare(languages)
      return suggest.suggestCorrections(word, languages ?? lexicon.languages, lexicon, { limit, maxDistance })
    },
    planAutocorrect: async (word, languages, context) => {
      await prepare(languages)
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
    const languages = await call<TextLanguage[]>({ op: 'install', input, personalWords: [...suggest.personalWords()] }, transfer)
    // The French exact list goes to the worker once, the first time a French passage needs it.
    let frenchReady: Promise<boolean> | null = null
    const ensureFrench = (among: TextLanguage[] | null) => {
      if (!among?.includes('fr')) return Promise.resolve(false)
      frenchReady ??= (async () => {
        const list = await spelling.loadFrenchWordList()
        if (!list) return false
        await call({ op: 'frenchInstall', list: { ...list, bytes: list.bytes.slice() }, personalWords: [...suggest.personalWords()] })
        return true
      })().catch((error) => {
        console.warn('Das französische Wörterbuch konnte nicht geladen werden:', error)
        return false
      })
      return frenchReady
    }
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
      prepare: async (among) => { await ensureFrench(among) },
      suggest: async (word, among, options = {}) => {
        const french = await ensureFrench(among)
        return guarded(
          () => call<SpellingSuggestion[]>({
            op: 'suggest',
            typed: word,
            languages: (among ?? languages).filter((language) => french || language !== 'fr'),
            limit: options.limit ?? 6,
            maxDistance: options.maxDistance ?? 2,
          }),
          (engine) => engine.suggest(word, among, options),
        )
      },
      contextSnapshot: async (language) => JSON.parse(await call<string>({ op: 'context', call: 'snapshot', args: [language] })) as NeuralWordContextSnapshot,
      planAutocorrect: async (word, among, context) => {
        const french = await ensureFrench(among)
        // Without the French list there is nothing to correct a French word with.
        if (among?.includes('fr') && !french) return null
        return guarded(
          () => call<SpellingSuggestion | null>({ op: 'autocorrect', typed: word, languages: among ?? languages, ...context }),
          (engine) => engine.planAutocorrect(word, among, context),
        )
      },
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
