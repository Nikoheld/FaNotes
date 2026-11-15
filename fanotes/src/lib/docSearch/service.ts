/**
 * Wires the document index into the running app: one indexer per open vault,
 * persisted in IndexedDB, extraction in the background whenever the user is
 * not typing or writing, and a small event bus for progress and page reveals.
 */
import { recognizeTrocrLine } from '../trocrClient'
import type { DocIndex, DocStatus as DocRecordStatus, SearchResult, UnitIssue } from './docIndex'
import { createBrowserExtractor, listSearchDocuments, type DocSearchHostApi } from './extract'
import { DocIndexer, type IndexerProgress } from './indexer'
import { nativeSearchOf, type NativeSearchApi, type NativeSearchStatus } from './native'
import { openDocSearchStore, vaultKeyFor } from './store'

/** Input this recent means "the user is working"; indexing waits. */
const QUIET_MS = 1500
const CHANGE_DEBOUNCE_MS = 1500

type Listener = (progress: IndexerProgress) => void

let lastInput = 0
let activityInstalled = false
const installActivityTracking = () => {
  if (activityInstalled || typeof window === 'undefined') return
  activityInstalled = true
  const mark = () => { lastInput = performance.now() }
  for (const type of ['keydown', 'pointerdown', 'wheel', 'touchstart'] as const) window.addEventListener(type, mark, { capture: true, passive: true })
  // A pen or a pressed mouse moving across a page is writing.
  window.addEventListener('pointermove', (event) => { if (event.buttons || event.pointerType === 'pen') mark() }, { capture: true, passive: true })
}

const sleep = (ms: number) => new Promise<void>((resolve) => { window.setTimeout(resolve, ms) })

const idle = () => new Promise<void>((resolve) => {
  if (typeof window.requestIdleCallback === 'function') window.requestIdleCallback(() => resolve(), { timeout: 1000 })
  else window.setTimeout(resolve, 50)
})

/** Changes on every app start, so each story is read once per session even if it changed while the app was closed. */
const SESSION = Math.random().toString(36).slice(2, 10)

class DocSearchService {
  private indexer: DocIndexer | null = null
  private storyVersions = new Map<string, number>()
  private closeStore: (() => void) | null = null
  private vaultKey = ''
  private listeners = new Set<Listener>()
  private changeTimer: number | null = null
  private generation = 0
  private latest: IndexerProgress | null = null
  // Desktop (Tauri) only: the native index answers queries; the TS indexer
  // then only reads PDFs (text layer, OCR) and shares that text through the
  // page-text sidecar the native index reads.
  private native: NativeSearchApi | null = null
  private nativeStatus: NativeSearchStatus | null = null
  private nativeResults = new Map<string, { generation: number; results: SearchResult[] }>()
  private nativePending = new Set<string>()
  private nativeTimer: number | null = null
  private resultListeners = new Set<() => void>()

  get ready() { return Boolean(this.indexer) }
  get index(): DocIndex | null { return this.indexer?.index ?? null }

  /** Opens (or switches to) the index of one vault and starts a pass. */
  async start(input: { api: DocSearchHostApi; platform: string; vaultPath: string; version?: string }) {
    const native = nativeSearchOf(input.api)
    if (native && native !== this.native) this.startNative(native)
    if (typeof indexedDB === 'undefined') return
    installActivityTracking()
    const key = await vaultKeyFor(input.platform, input.vaultPath)
    if (key === this.vaultKey && this.indexer) { this.scheduleSoon(0); return }
    this.stop()
    const generation = ++this.generation
    const store = await openDocSearchStore(key)
    if (generation !== this.generation) { store.close(); return }
    this.vaultKey = key
    this.closeStore = store.close
    const api = input.api
    this.indexer = new DocIndexer({
      store,
      list: async () => listSearchDocuments(await api.getTree(), (path) => `${SESSION}:${this.storyVersions.get(path) ?? 0}`).filter((source) => !this.native || source.kind === 'pdf'),
      extractor: createBrowserExtractor({
        api,
        recognize: (pixels, width, height) => recognizeTrocrLine(pixels, width, height),
        producer: `fanotes-${input.platform}/${input.version ?? 'dev'} doc-search/1`,
      }),
      gate: async () => {
        // Background work only while the user is not typing or writing.
        for (;;) {
          if (generation !== this.generation) return
          const quietFor = performance.now() - lastInput
          if (quietFor >= QUIET_MS || document.hidden) break
          await sleep(QUIET_MS - quietFor + 50)
        }
        await idle()
      },
      onProgress: (progress) => {
        if (generation !== this.generation) return
        this.latest = progress
        if (this.native) return
        for (const listener of this.listeners) listener(progress)
      },
    })
    await this.indexer.load()
    this.scheduleSoon(2500)
  }

  /** Closes the current vault's index (vault switch, reset, sign-out of the app). */
  stop() {
    this.stopNative()
    this.generation += 1
    this.indexer?.cancel()
    this.indexer = null
    this.closeStore?.()
    this.closeStore = null
    this.vaultKey = ''
    if (this.changeTimer !== null) window.clearTimeout(this.changeTimer)
    this.changeTimer = null
  }

  /** Call after saves, imports, renames, moves, deletes and sync. Coalesced. */
  notifyChanged() {
    if (this.native) { void this.native.notify().catch(() => undefined); this.pollNative(600) }
    this.scheduleSoon(CHANGE_DEBOUNCE_MS)
  }

  private startNative(native: NativeSearchApi) {
    this.stopNative()
    this.native = native
    this.pollNative(0)
  }

  private stopNative() {
    if (this.nativeTimer !== null) window.clearTimeout(this.nativeTimer)
    this.nativeTimer = null
    this.native = null
    this.nativeStatus = null
    this.nativeResults.clear()
    this.nativePending.clear()
  }

  /** Status while the native index works (1 s), then a slow check for watcher updates (4 s). */
  private pollNative(delay: number) {
    if (!this.native) return
    if (this.nativeTimer !== null) window.clearTimeout(this.nativeTimer)
    this.nativeTimer = window.setTimeout(async () => {
      this.nativeTimer = null
      const native = this.native
      if (!native) return
      let status: NativeSearchStatus | null = null
      try { status = await native.status() } catch { status = null }
      if (native !== this.native) return
      if (status) {
        const changed = status.generation !== this.nativeStatus?.generation
        this.nativeStatus = status
        if (changed) { this.nativeResults.clear(); for (const listener of this.resultListeners) listener() }
        for (const listener of this.listeners) listener(status)
      }
      this.pollNative(status && status.state === 'idle' ? 4000 : 1000)
    }, delay)
  }

  /** Called when native results arrive or the native index changed. */
  onResults(listener: () => void) {
    this.resultListeners.add(listener)
    return () => { this.resultListeners.delete(listener) }
  }

  private nativeSearch(query: string): SearchResult[] {
    const native = this.native!
    const cached = this.nativeResults.get(query)
    const generation = this.nativeStatus?.generation ?? -1
    if (cached && cached.generation === generation) return cached.results
    if (!this.nativePending.has(query)) {
      this.nativePending.add(query)
      void native.query(query).then((answer) => {
        if (native !== this.native) return
        this.nativeResults.set(query, { generation: this.nativeStatus?.generation ?? answer.generation, results: answer.results })
        if (this.nativeResults.size > 64) this.nativeResults.delete(this.nativeResults.keys().next().value!)
        for (const listener of this.resultListeners) listener()
      }).catch(() => undefined).finally(() => { this.nativePending.delete(query) })
    }
    return cached?.results ?? []
  }

  /** A story's files changed (writing-mode save, sync): it is read again on the next pass. */
  notifyStoryChanged(storyPath: string) {
    this.storyVersions.set(storyPath, (this.storyVersions.get(storyPath) ?? 0) + 1)
    this.notifyChanged()
  }

  private scheduleSoon(delay: number) {
    if (this.changeTimer !== null) window.clearTimeout(this.changeTimer)
    this.changeTimer = window.setTimeout(() => {
      this.changeTimer = null
      if (this.indexer && !this.indexer.isPaused) void this.indexer.schedule()
    }, delay)
  }

  search(query: string): SearchResult[] {
    if (this.native) return this.nativeSearch(query)
    return this.indexer?.index.search(query) ?? []
  }

  progress(): IndexerProgress | null {
    if (this.native) return this.nativeStatus
    return this.latest ?? this.indexer?.progress() ?? null
  }

  subscribe(listener: Listener) {
    this.listeners.add(listener)
    const current = this.progress()
    if (current) listener(current)
    return () => { this.listeners.delete(listener) }
  }

  pause() { this.indexer?.pause() }
  resume() { void this.indexer?.resume() }
  retry() { void this.indexer?.retryFailed() }
  rebuild() {
    if (this.native) { void this.native.rebuild().catch(() => undefined); this.pollNative(600) }
    void this.indexer?.rebuild()
  }
  issues() {
    const own = (this.indexer?.index.listDocs() ?? [])
      .filter((doc) => doc.status === 'unsupported' || doc.status === 'failed' || doc.issues.length)
      .map((doc) => ({ path: doc.path, title: doc.title, status: doc.status, reason: doc.reason, issues: doc.issues }))
    if (!this.native) return own
    const seen = new Set(own.map((entry) => entry.path))
    const native = (this.nativeStatus?.problems ?? [])
      .filter((entry) => !seen.has(entry.path) && entry.status !== 'partial')
      .map((entry) => ({ path: entry.path, title: entry.title, status: entry.status as DocRecordStatus, reason: entry.reason ?? undefined, issues: entry.issues.map((reason): UnitIssue => ({ kind: 'note', status: 'skipped', reason })) }))
    return [...own, ...native]
  }
}

export const docSearch = new DocSearchService()

export { requestPdfReveal } from './reveal'
