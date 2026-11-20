/**
 * Wires the document index into the running app: one indexer per open vault,
 * persisted in IndexedDB, extraction in the background whenever the user is
 * not typing or writing, and a small event bus for progress and page reveals.
 */
import type { DocIndex, SearchResult } from './docIndex'
import { createBrowserExtractor, listSearchDocuments, type DocSearchHostApi } from './extract'
import { DocIndexer, type IndexerProgress } from './indexer'
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

const LOW_BATTERY_LEVEL = 0.2
const LOW_BATTERY_RECHECK_MS = 60_000
type BatteryLike = { charging: boolean; level: number }
const onLowBattery = async () => {
  try {
    const getBattery = (navigator as Navigator & { getBattery?: () => Promise<BatteryLike> }).getBattery
    if (typeof getBattery !== 'function') return false
    const battery = await getBattery.call(navigator)
    return !battery.charging && battery.level < LOW_BATTERY_LEVEL
  } catch {
    return false
  }
}

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

  get ready() { return Boolean(this.indexer) }
  get index(): DocIndex | null { return this.indexer?.index ?? null }

  /** Opens (or switches to) the index of one vault and starts a pass. */
  async start(input: { api: DocSearchHostApi; platform: string; vaultPath: string; version?: string }) {
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
      list: async () => listSearchDocuments(await api.getTree(), (path) => `${SESSION}:${this.storyVersions.get(path) ?? 0}`),
      extractor: createBrowserExtractor({
        api,
        // The TrOCR client (ONNX runtime glue) loads on the first scanned page, not at startup.
        recognize: async (pixels, width, height) => (await import('../trocrClient')).recognizeTrocrLine(pixels, width, height),
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
        // On a low battery, background OCR waits until the device is charging (or the level recovers).
        while (generation === this.generation && await onLowBattery()) await sleep(LOW_BATTERY_RECHECK_MS)
      },
      onProgress: (progress) => {
        if (generation !== this.generation) return
        this.latest = progress
        for (const listener of this.listeners) listener(progress)
      },
    })
    await this.indexer.load()
    this.scheduleSoon(2500)
  }

  /** Closes the current vault's index (vault switch, reset, sign-out of the app). */
  stop() {
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
  notifyChanged() { this.scheduleSoon(CHANGE_DEBOUNCE_MS) }

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
    return this.indexer?.index.search(query) ?? []
  }

  progress() { return this.latest ?? this.indexer?.progress() ?? null }

  subscribe(listener: Listener) {
    this.listeners.add(listener)
    const current = this.progress()
    if (current) listener(current)
    return () => { this.listeners.delete(listener) }
  }

  pause() { this.indexer?.pause() }
  resume() { void this.indexer?.resume() }
  retry() { void this.indexer?.retryFailed() }
  rebuild() { void this.indexer?.rebuild() }
  issues() {
    return (this.indexer?.index.listDocs() ?? [])
      .filter((doc) => doc.status === 'unsupported' || doc.status === 'failed' || doc.issues.length)
      .map((doc) => ({ path: doc.path, title: doc.title, status: doc.status, reason: doc.reason, issues: doc.issues }))
  }
}

export const docSearch = new DocSearchService()

export { requestPdfReveal } from './reveal'
