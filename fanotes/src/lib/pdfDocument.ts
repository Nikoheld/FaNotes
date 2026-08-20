import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import type { PDFDocumentLoadingTask, PDFDocumentProxy } from 'pdfjs-dist'

export const MAX_PDF_NOTE_PAGES = 2_000

/** Page to open after a document identity change. Same path returns null — do not reload from lastPage. */
export const pdfStartPageForLoad = (path: unknown, previousPath: unknown, requestedPage: unknown) => {
  const next = typeof path === 'string' ? path : ''
  const previous = typeof previousPath === 'string' ? previousPath : ''
  if (!next || next === previous) return null
  const page = Math.round(Number(requestedPage) || 1)
  return Number.isSafeInteger(page) && page >= 1 ? page : 1
}
export const DEFAULT_PDF_PAGE_RATIO = 297 / 210
export const MAX_PDF_DPR = 1.75
export const MAX_PDF_EDGE = 2_048
export const MAX_PDF_PIXELS = 2_400_000

const asUint8Array = (value: ArrayBuffer | Uint8Array | ArrayBufferView): Uint8Array => {
  if (value instanceof Uint8Array) return value
  if (value instanceof ArrayBuffer) return new Uint8Array(value)
  return new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
}

const yieldToUi = () => new Promise<void>((resolve) => {
  window.setTimeout(resolve, 0)
})

const decodeBase64ToBytes = async (body: string): Promise<Uint8Array> => {
  const chunkChars = 256 * 1024
  const bytes = new Uint8Array(Math.floor(body.length * 0.75) + 4)
  let offset = 0
  for (let index = 0; index < body.length; index += chunkChars) {
    const binary = atob(body.slice(index, chunkChars + index))
    for (let char = 0; char < binary.length; char += 1) bytes[offset++] = binary.charCodeAt(char)
    if (index + chunkChars < body.length) await yieldToUi()
  }
  return bytes.subarray(0, offset)
}

const loadPdfBytes = async (source: string): Promise<Uint8Array> => {
  if (!source) throw new Error('Die PDF-Datei ist leer oder fehlt im Vault.')
  if (source.startsWith('data:')) {
    const comma = source.indexOf(',')
    if (comma < 0) throw new Error('Ungültige PDF-Daten (Data-URL).')
    const header = source.slice(0, comma)
    const body = source.slice(comma + 1)
    if (/;base64/iu.test(header)) return decodeBase64ToBytes(body)
    return new TextEncoder().encode(decodeURIComponent(body))
  }
  const response = await fetch(source)
  if (!response.ok) throw new Error(`PDF konnte nicht geladen werden (HTTP ${response.status}).`)
  return new Uint8Array(await response.arrayBuffer())
}

export const loadVaultPdfBytes = async (relativePath: string): Promise<Uint8Array> => {
  const api = window.fanotes
  if (typeof api.readAssetBytes === 'function') {
    const bytes = asUint8Array(await api.readAssetBytes(relativePath))
    if (!bytes.byteLength) throw new Error('Die PDF-Datei ist leer oder fehlt im Vault.')
    return bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
      ? bytes
      : bytes.slice()
  }
  return loadPdfBytes(await api.readAssetDataUrl(relativePath))
}

let pdfRenderTail: Promise<void> = Promise.resolve()
export const enqueuePdfRender = <T,>(job: () => Promise<T>): Promise<T> => {
  const run = pdfRenderTail.then(job, job)
  pdfRenderTail = run.then(() => undefined, () => undefined)
  return run
}

/** CSS max width of a PDF page column — the write-column, not the grown plane. */
export const PDF_PAGE_COLUMN_MAX = 900

/**
 * Painted CSS width of the PDF page stack. Ink-extent / one-canvas can make
 * the paper wider than A4; glyphs must still use this column so they do not
 * rescale when the overlay source grows.
 */
export const pdfPageColumnCssWidth = (paperClientWidth: number, columnMax = PDF_PAGE_COLUMN_MAX) => {
  const paper = Number.isFinite(paperClientWidth) && paperClientWidth > 0 ? paperClientWidth : columnMax
  const max = Number.isFinite(columnMax) && columnMax > 0 ? columnMax : PDF_PAGE_COLUMN_MAX
  return Math.min(paper, max)
}

/**
 * Overlay scale pdf.js TextLayer expects: CSS-pixel page width / unscaled
 * page width. Canvas bitmap may be DPR-capped; the selectable layer must
 * still match the painted CSS box, not the backing-store size.
 */
export const pdfTextOverlayScale = (cssWidth: number, pageWidth: number) => {
  if (!(cssWidth > 0) || !(pageWidth > 0)) return 1
  return cssWidth / pageWidth
}

/** Overlay scale from the paper’s client box, always via the stable page column. */
export const pdfTextOverlayScaleForPaper = (
  paperClientWidth: number,
  pageWidth: number,
  columnMax = PDF_PAGE_COLUMN_MAX,
) => pdfTextOverlayScale(pdfPageColumnCssWidth(paperClientWidth, columnMax), pageWidth)

export const PDF_TEXT_OVERLAY_USER_UNIT = 1

/** CSS variables pdf.js TextLayer reads when it sizes spans and the layer box. */
export const pdfTextOverlayCssVars = (scale: number) => {
  const safe = Number.isFinite(scale) && scale > 0 ? scale : 1
  return {
    '--scale-factor': String(safe),
    '--user-unit': String(PDF_TEXT_OVERLAY_USER_UNIT),
    '--total-scale-factor': String(safe * PDF_TEXT_OVERLAY_USER_UNIT),
    '--scale-round-x': '1px',
    '--scale-round-y': '1px',
  } as const
}

export const applyPdfTextOverlayScale = (
  layer: { style: { setProperty: (name: string, value: string) => void } },
  cssWidth: number,
  pageWidth: number,
) => {
  const scale = pdfTextOverlayScale(cssWidth, pageWidth)
  for (const [name, value] of Object.entries(pdfTextOverlayCssVars(scale))) {
    layer.style.setProperty(name, value)
  }
  return scale
}

export const paintSizeForPage = (cssWidth: number, cssHeight: number) => {
  let dpr = Math.min(Math.max(window.devicePixelRatio || 1, 1), MAX_PDF_DPR)
  let pixelWidth = Math.round(cssWidth * dpr)
  let pixelHeight = Math.round(cssHeight * dpr)
  const edge = Math.max(pixelWidth, pixelHeight)
  if (edge > MAX_PDF_EDGE) {
    const factor = MAX_PDF_EDGE / edge
    pixelWidth = Math.max(1, Math.round(pixelWidth * factor))
    pixelHeight = Math.max(1, Math.round(pixelHeight * factor))
  }
  const pixels = pixelWidth * pixelHeight
  if (pixels > MAX_PDF_PIXELS) {
    const factor = Math.sqrt(MAX_PDF_PIXELS / pixels)
    pixelWidth = Math.max(1, Math.round(pixelWidth * factor))
    pixelHeight = Math.max(1, Math.round(pixelHeight * factor))
  }
  return { pixelWidth, pixelHeight }
}

export const openPdfDocument = async (
  bytes: Uint8Array,
  password?: string,
): Promise<{ pdf: PDFDocumentProxy; task: PDFDocumentLoadingTask }> => {
  const { getDocument, GlobalWorkerOptions } = await import('pdfjs-dist')
  GlobalWorkerOptions.workerSrc = pdfWorkerUrl
  const copy = bytes.buffer.byteLength === bytes.byteLength ? bytes : bytes.slice()
  const task = getDocument({
    data: copy,
    password: password || undefined,
    useSystemFonts: true,
    disableAutoFetch: true,
    disableStream: true,
    disableRange: true,
  })
  const loaded = await task.promise
  if (loaded.numPages > MAX_PDF_NOTE_PAGES) {
    await task.destroy()
    throw new Error(`PDFs mit mehr als ${MAX_PDF_NOTE_PAGES} Seiten werden nicht geöffnet.`)
  }
  return { pdf: loaded, task }
}
