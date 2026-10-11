import type { PdfiumRasterRequest, PdfiumRasterResult } from '../types'

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
  const tight = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
    ? bytes
    : bytes.slice()
  // ImageData accepts only a Uint8ClampedArray backed by a plain ArrayBuffer.
  const pixels = new Uint8ClampedArray(tight.byteLength)
  pixels.set(tight)
  return pixels
}

/**
 * Ask the desktop host to rasterize one camera window with PDFium.
 * Returns null when the host has no PDFium sidecar, so the painter keeps pdf.js.
 */
export const rasterizePdfPage = async (
  request: PdfiumRasterRequest,
): Promise<Uint8ClampedArray<ArrayBuffer> | null> => {
  if (unavailable) return null
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
