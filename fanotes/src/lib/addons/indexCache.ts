import { fetchAddonIndex, type AddonFetchText, type AddonIndex, type AddonSource } from './registry'

// Shared, subscribable cache of the registry index so the store modal, the
// startup update check and the palette all read one download.

export type AddonIndexCacheState = {
  index: AddonIndex | null
  loading: boolean
  error: string | null
  loadedAt: number | null
  sourceLabel: string | null
}

const STALE_MS = 10 * 60 * 1000

export class AddonIndexCache {
  private state: AddonIndexCacheState = { index: null, loading: false, error: null, loadedAt: null, sourceLabel: null }
  private listeners = new Set<() => void>()
  private inflight: Promise<AddonIndex | null> | null = null

  getState = () => this.state

  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  private set(patch: Partial<AddonIndexCacheState>) {
    this.state = { ...this.state, ...patch }
    for (const listener of [...this.listeners]) listener()
  }

  load(source: AddonSource, fetchText: AddonFetchText, options: { force?: boolean } = {}) {
    const fresh = this.state.index && this.state.sourceLabel === source.label && this.state.loadedAt && Date.now() - this.state.loadedAt < STALE_MS
    if (!options.force && fresh) return Promise.resolve(this.state.index)
    if (this.inflight && this.state.sourceLabel === source.label && !options.force) return this.inflight
    this.set({ loading: true, error: null, sourceLabel: source.label, index: this.state.sourceLabel === source.label ? this.state.index : null })
    const run = fetchAddonIndex(source, fetchText)
      .then((index) => {
        this.set({ index, loading: false, error: index.entries.length ? null : (index.problems[0] ?? null), loadedAt: Date.now() })
        return index
      })
      .catch((error: unknown) => {
        this.set({ loading: false, error: error instanceof Error ? error.message : String(error), loadedAt: Date.now() })
        return null
      })
      .finally(() => { if (this.inflight === run) this.inflight = null })
    this.inflight = run
    return run
  }

  reset() {
    this.set({ index: null, loading: false, error: null, loadedAt: null, sourceLabel: null })
  }
}

export const addonIndexCache = new AddonIndexCache()
