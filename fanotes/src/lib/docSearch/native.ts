/**
 * Optional desktop capability: the native vault index of the Tauri host
 * (`crates/fanotes-index`, commands `fanotes-native:search-*`). Only that
 * bridge provides `window.fanotes.nativeSearch`; Electron, the web app and
 * Android do not, and keep the TypeScript index unchanged.
 */
import type { SearchResult } from './docIndex'
import type { IndexerProgress } from './indexer'

export type NativeSearchStatus = IndexerProgress & {
  generation: number
  cache?: 'loaded' | 'rebuilt' | 'none'
  problems?: Array<{ path: string; title: string; status: string; reason?: string | null; issues: string[] }>
}

export type NativeSearchApi = {
  /** Same result shape and order as `DocIndex.search`. */
  query: (query: string, limit?: number) => Promise<{ results: SearchResult[]; generation: number; state: string }>
  status: () => Promise<NativeSearchStatus>
  /** Something in the vault changed; the index re-checks (debounced). */
  notify: () => Promise<unknown>
  rebuild: () => Promise<unknown>
}

export const nativeSearchOf = (api: unknown): NativeSearchApi | null => {
  const candidate = (api as { nativeSearch?: Partial<NativeSearchApi> } | null | undefined)?.nativeSearch
  return candidate && typeof candidate.query === 'function' && typeof candidate.status === 'function'
    && typeof candidate.notify === 'function' && typeof candidate.rebuild === 'function'
    ? candidate as NativeSearchApi
    : null
}
