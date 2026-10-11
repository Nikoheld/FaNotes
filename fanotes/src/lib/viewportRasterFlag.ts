/**
 * Feature flag for the Rust viewport raster on the inline ink board. Off by
 * default: the slice bitmap stays the shipping path. On with
 * `VITE_FANOTES_VIEWPORT_RASTER=1` (build or check run), or with
 * `localStorage['fanotes.viewport-raster'] = '1'` and a reload.
 */
export const VIEWPORT_RASTER_STORAGE_KEY = 'fanotes.viewport-raster'

export const viewportRasterEnabled = (): boolean => {
  if (import.meta.env?.VITE_FANOTES_VIEWPORT_RASTER === '1') return true
  try {
    return globalThis.localStorage?.getItem(VIEWPORT_RASTER_STORAGE_KEY) === '1'
  } catch {
    return false
  }
}
