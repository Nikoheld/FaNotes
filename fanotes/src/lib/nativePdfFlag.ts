/**
 * Desktop flag for native PDF page rasters (Tauri `fanotes-native:pdf-*`).
 * Off by default: pdf.js paints. On with `VITE_FANOTES_NATIVE_PDF=1` (build
 * or check run), or `localStorage['fanotes.native-pdf'] = '1'` and a reload.
 * Only a host with `window.fanotes.pdfNative` can use it; Electron, the web
 * app and Android never have that capability and are unaffected.
 */
export const NATIVE_PDF_STORAGE_KEY = 'fanotes.native-pdf'

export const nativePdfEnabled = (): boolean => {
  if (import.meta.env?.VITE_FANOTES_NATIVE_PDF === '1') return true
  try {
    return globalThis.localStorage?.getItem(NATIVE_PDF_STORAGE_KEY) === '1'
  } catch {
    return false
  }
}
