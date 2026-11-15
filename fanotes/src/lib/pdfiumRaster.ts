import type { NativePdfApi, PdfiumRasterRequest, PdfiumRasterResult } from '../types'
import { nativePdfEnabled } from './nativePdfFlag'

let unavailable = false
let reported = false

const decodeBase64 = (body: string): Uint8Array => {
  const bytes = new Uint8Array(Math.floor(body.length * 0.75))
  let offset = 0
  const chunkChars = 256 * 1024
  for (let index = 0; index < body.length; index += chunkChars) {
    const binary = atob(body.slice(index, index + chunkChars))
    for (let char = 0; char < binary.length; char += 1) bytes[offset++] = binary.charCodeAt(char)
  }
  return bytes.subarray(0, offset)
}

const asBytes = (result: PdfiumRasterResult): Uint8ClampedArray<ArrayBuffer> | null => {
  const width = result.width ?? 0
  const height = result.height ?? 0
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) return null
  let bytes: Uint8Array | null = null
  if (result.rgba instanceof Uint8Array) bytes = result.rgba
  else if (typeof result.rgbaBase64 === 'string' && result.rgbaBase64.length > 0) bytes = decodeBase64(result.rgbaBase64)
  if (!bytes || bytes.byteLength !== width * height * 4) return null
  // ImageData accepts only a Uint8ClampedArray backed by a plain ArrayBuffer.
  // Bytes that already own one are viewed in place: copying them again cost
  // the page's thread one more pass over up to 73 MB per zoom window.
  if (bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength && bytes.buffer instanceof ArrayBuffer) {
    return new Uint8ClampedArray(bytes.buffer, 0, bytes.byteLength)
  }
  const pixels = new Uint8ClampedArray(bytes.byteLength)
  pixels.set(bytes)
  return pixels
}

// --- Tauri `pdfNative` (WP8) -------------------------------------------------
// A host with the capability opens each vault PDF once on its PDFium worker
// and answers a window as raw RGBA. With the flag off it paints with pdf.js.

const nativeDocs = new Map<string, Promise<number>>()
let nativeUnavailable = false

const nativeApi = (): NativePdfApi | null => {
  const api = (globalThis as { window?: Window }).window?.fanotes?.pdfNative
  return api && typeof api.render === 'function' && typeof api.open === 'function' ? api : null
}

const errorText = (error: unknown) => String(error instanceof Error ? error.message : error)

const nativeDoc = (api: NativePdfApi, path: string, password: string | undefined) => {
  const key = `${path}\u0000${password ?? ''}`
  let doc = nativeDocs.get(key)
  if (!doc) {
    doc = api.open({ path, password }).then((opened) => opened.doc)
    nativeDocs.set(key, doc)
    doc.catch(() => { if (nativeDocs.get(key) === doc) nativeDocs.delete(key) })
  }
  return { key, doc }
}

const rasterizeNative = async (
  api: NativePdfApi,
  request: PdfiumRasterRequest,
): Promise<Uint8ClampedArray<ArrayBuffer> | null> => {
  if (nativeUnavailable) return null
  const { path, password, ...window } = request
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const { key, doc } = nativeDoc(api, path, password)
    try {
      const bytes = await api.render({ ...window, doc: await doc })
      const result = asBytes({ width: request.pixelWidth, height: request.pixelHeight, rgba: new Uint8Array(bytes) })
      return result
    } catch (error: unknown) {
      const message = errorText(error)
      // The worker let the document go (its cache is full): open it again once.
      if (/nicht geöffnet/u.test(message) && attempt === 0) {
        nativeDocs.delete(key)
        continue
      }
      if (/abgebrochen/u.test(message)) return null
      if (/nicht verfügbar/u.test(message)) nativeUnavailable = true
      if (!reported) {
        reported = true
        console.info('PDFium im Host konnte nicht zeichnen; pdf.js zeichnet die Seite.', error)
      }
      return null
    }
  }
  return null
}

/** Drop queued native windows of a painter layer that went away. */
export const cancelPdfRaster = (slot: string) => {
  const api = nativeApi()
  if (!api || !nativePdfEnabled()) return
  void api.cancel({ slot }).catch(() => undefined)
}

/**
 * Ask the desktop host to rasterize one camera window with PDFium.
 * Returns null when the host has no PDFium sidecar, so the painter keeps pdf.js.
 */
export const rasterizePdfPage = async (
  request: PdfiumRasterRequest,
): Promise<Uint8ClampedArray<ArrayBuffer> | null> => {
  const native = nativeApi()
  if (native) {
    // Tauri: native rasters only behind the flag; otherwise pdf.js paints.
    return nativePdfEnabled() ? rasterizeNative(native, request) : null
  }
  if (unavailable) return null
  const { slot: _slot, ...legacy } = request
  request = legacy
  const render = window.fanotes.renderPdfPage
  if (typeof render !== 'function') return null
  try {
    const result = await render(request)
    if (result?.unavailable) {
      unavailable = true
      if (!reported) {
        reported = true
        console.info('PDFium ist nicht geladen; pdf.js zeichnet die Seite.')
      }
      return null
    }
    return result ? asBytes(result) : null
  } catch (error: unknown) {
    if (!reported) {
      reported = true
      console.info('PDFium ist nicht geladen; pdf.js zeichnet die Seite.', error)
    }
    return null
  }
}
