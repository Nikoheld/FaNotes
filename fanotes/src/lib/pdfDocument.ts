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
/** HiDPI tablets (Hyprland 2× / 3×) must keep glyphs at device pixels. */
export const MAX_PDF_DPR = 3
export const MAX_PDF_EDGE = 16_384
export const MAX_PDF_PIXELS = 48_000_000
/** Match sheet zoom through 600% so 500% is not a 3× bitmap stretched by CSS. */
export const MAX_PDF_VIEW_QUALITY_ZOOM = 6

export type PdfPaintOptions = {
  dpr?: number
  viewZoom?: number
  visibleLeft?: number
  visibleTop?: number
  visibleCssWidth?: number
  visibleCssHeight?: number
}

export type PdfPaintBox = {
  pixelWidth: number
  pixelHeight: number
  cssLeft: number
  cssTop: number
  cssWidth: number
  cssHeight: number
}

/** Backing-store scale: screen DPR times a bounded sheet-zoom boost. */
export const pdfPaintDeviceScale = (dpr: number, viewZoom = 1) => {
  const screen = Math.min(Math.max(Number(dpr) || 1, 1), MAX_PDF_DPR)
  const zoomBoost = Math.max(1, Math.min(MAX_PDF_VIEW_QUALITY_ZOOM, viewZoom > 1.02 ? viewZoom : 1))
  return screen * zoomBoost
}

const clampPageCss = (value: number, max: number) => Math.max(0, Math.min(max, Number.isFinite(value) ? value : 0))

/** Visible page rectangle in unzoomed CSS pixels (scroll is visual, like layoutInkWindow). */
export const visiblePageCssWindow = (input: {
  pageWidth: number
  pageHeight: number
  viewWidth: number
  viewHeight: number
  viewZoom: number
  scrollLeft?: number
  scrollTop?: number
  pageOffsetLeft?: number
  pageOffsetTop?: number
  padRatio?: number
}) => {
  const pageWidth = Math.max(1, Number(input.pageWidth) || 1)
  const pageHeight = Math.max(1, Number(input.pageHeight) || 1)
  const zoom = Math.max(0.01, Number(input.viewZoom) || 1)
  const viewWidth = Math.max(1, Number(input.viewWidth) || 1)
  const viewHeight = Math.max(1, Number(input.viewHeight) || 1)
  const padRatio = Number.isFinite(input.padRatio) ? Math.max(0, Number(input.padRatio)) : 0.35
  const visualLeft = (Number(input.pageOffsetLeft) || 0) * zoom
  const visualTop = (Number(input.pageOffsetTop) || 0) * zoom
  const layoutLeft = ((Number(input.scrollLeft) || 0) - visualLeft) / zoom
  const layoutTop = ((Number(input.scrollTop) || 0) - visualTop) / zoom
  const visW = viewWidth / zoom
  const visH = viewHeight / zoom
  const padX = visW * padRatio
  const padY = visH * padRatio
  const left = clampPageCss(layoutLeft - padX, pageWidth)
  const top = clampPageCss(layoutTop - padY, pageHeight)
  const right = clampPageCss(layoutLeft + visW + padX, pageWidth)
  const bottom = clampPageCss(layoutTop + visH + padY, pageHeight)
  return {
    left,
    top,
    width: Math.max(1, right - left),
    height: Math.max(1, bottom - top),
  }
}

const fitPaintBitmap = (width: number, height: number) => {
  let pixelWidth = Math.max(1, Math.round(width))
  let pixelHeight = Math.max(1, Math.round(height))
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

/**
 * PDF backing box. A full A4 at 5× DPR 2 does not fit the pixel budget — then
 * the bitmap covers only the visible CSS window at device-pixel density.
 */
export const paintBoxForPage = (cssWidth: number, cssHeight: number, options: PdfPaintOptions = {}): PdfPaintBox => {
  const dpr = options.dpr ?? (typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1)
  const viewZoom = options.viewZoom ?? 1
  const scale = pdfPaintDeviceScale(dpr, viewZoom)
  const pageWidth = Math.max(1, cssWidth)
  const pageHeight = Math.max(1, cssHeight)
  const desiredWidth = pageWidth * scale
  const desiredHeight = pageHeight * scale
  const full = fitPaintBitmap(desiredWidth, desiredHeight)
  const fullKeepsDensity = full.pixelWidth >= desiredWidth * 0.92 && full.pixelHeight >= desiredHeight * 0.92
  const visW = Number(options.visibleCssWidth)
  const visH = Number(options.visibleCssHeight)
  const hasVisible = Number.isFinite(visW) && visW > 0 && Number.isFinite(visH) && visH > 0
  if (fullKeepsDensity || !hasVisible) {
    return {
      ...full,
      cssLeft: 0,
      cssTop: 0,
      cssWidth: pageWidth,
      cssHeight: pageHeight,
    }
  }
  const left = clampPageCss(Number(options.visibleLeft) || 0, pageWidth)
  const top = clampPageCss(Number(options.visibleTop) || 0, pageHeight)
  const width = Math.max(1, Math.min(pageWidth - left, visW))
  const height = Math.max(1, Math.min(pageHeight - top, visH))
  const windowed = fitPaintBitmap(width * scale, height * scale)
  return {
    ...windowed,
    cssLeft: left,
    cssTop: top,
    cssWidth: width,
    cssHeight: height,
  }
}

export const paintSizeForPage = (cssWidth: number, cssHeight: number, options: PdfPaintOptions = {}) => {
  const box = paintBoxForPage(cssWidth, cssHeight, options)
  return { pixelWidth: box.pixelWidth, pixelHeight: box.pixelHeight }
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
