import type { PDFPageProxy, RenderTask } from 'pdfjs-dist'
import {
  enqueuePdfRender,
  pdfPaintBoxIsFullPage,
  planPdfPagePaint,
  type PdfPaintBox,
  type PdfPaintJob,
} from './pdfDocument'
import { layoutOffsetInScroller, readUsedSheetZoom, resolvePaperZoomScroller } from './paperView'

/**
 * Flicker-free PDF page painter.
 *
 * pdf.js paints asynchronously into a canvas, and assigning `canvas.width`
 * wipes the bitmap first — the old code did that on every scroll stop, so the
 * page went white until the worker finished. Here every layer owns two
 * canvases: the next bitmap is painted into the hidden one and swapped in
 * the same synchronous step that hides the old one. The base layer (whole
 * page at screen density) is never touched by scrolling or camera zoom; the
 * detail layer (camera zoom > 1, possibly a window of the page) sits on top
 * and re-renders only once the viewport leaves the painted window.
 */
export type PdfPageLayerCanvases = readonly [HTMLCanvasElement, HTMLCanvasElement]

type Layer = {
  canvases: PdfPageLayerCanvases
  front: 0 | 1
  key: string
  box: PdfPaintBox | null
  /** Key of the paint currently in flight; a plan for the same key is a no-op. */
  pending: string
  token: number
  task: RenderTask | null
}

export type PdfBasePaintInfo = {
  page: PDFPageProxy
  cssWidth: number
  cssHeight: number
  naturalWidth: number
  rotation: number
}

export type PdfPagePainterOptions = {
  host: HTMLElement
  base: PdfPageLayerCanvases
  detail: PdfPageLayerCanvases
  label: string
  /** After a base paint has been swapped in (text layer). Awaited in the render queue slot. */
  onBasePainted?: (info: PdfBasePaintInfo) => void | Promise<void>
  onFirstPaint?: () => void
}

export type PdfPagePainter = {
  setPage: (page: PDFPageProxy | null, rotation: number) => void
  paint: () => Promise<void>
  dispose: () => void
}

/**
 * A full-page bitmap fills the host (its aspect *is* the page aspect), so
 * 100%/100% keeps it flush with the page edge even when zoomed layout snaps
 * the host a device pixel wider or narrower than the planned width. A window
 * is placed in the plan's CSS px, like the transform that painted it.
 */
export const placePdfCanvas = (
  canvas: HTMLCanvasElement,
  box: PdfPaintBox,
  page?: { cssWidth: number; cssHeight: number },
) => {
  canvas.style.position = 'absolute'
  if (page && pdfPaintBoxIsFullPage(box, page.cssWidth, page.cssHeight)) {
    canvas.style.left = '0px'
    canvas.style.top = '0px'
    canvas.style.width = '100%'
    canvas.style.height = '100%'
    return
  }
  canvas.style.left = `${box.cssLeft.toFixed(2)}px`
  canvas.style.top = `${box.cssTop.toFixed(2)}px`
  canvas.style.width = `${box.cssWidth.toFixed(2)}px`
  canvas.style.height = `${box.cssHeight.toFixed(2)}px`
}

/**
 * Layout width of the page in CSS px. Under camera zoom `clientWidth` snaps
 * to device pixels and flips ±1 between zoom steps; that must not re-key the
 * bitmap, so a one-pixel change keeps the previous width.
 */
export const stablePageCssWidth = (measured: number, previous: number) => {
  const next = Math.max(1, Math.round(measured))
  return previous > 0 && Math.abs(next - previous) <= 1 ? previous : next
}

/** Free the backing store; a 0×0 canvas keeps its element and context. */
const releaseCanvas = (canvas: HTMLCanvasElement) => {
  canvas.style.visibility = 'hidden'
  if (canvas.width !== 0) canvas.width = 0
  if (canvas.height !== 0) canvas.height = 0
}

const isCancel = (error: unknown) => error instanceof Error && error.name === 'RenderingCancelledException'

export const createPdfPagePainter = (options: PdfPagePainterOptions): PdfPagePainter => {
  const { host, label } = options
  const makeLayer = (canvases: PdfPageLayerCanvases): Layer => (
    { canvases, front: 0, key: '', box: null, pending: '', token: 0, task: null }
  )
  const base = makeLayer(options.base)
  const detail = makeLayer(options.detail)
  let page: PDFPageProxy | null = null
  let rotation = 0
  let disposed = false
  let firstPaintSent = false
  for (const canvas of [...options.base, ...options.detail]) releaseCanvas(canvas)

  const cancelLayer = (layer: Layer) => {
    layer.token += 1
    layer.pending = ''
    try { layer.task?.cancel() } catch { /* ignore */ }
    layer.task = null
  }

  const dropLayer = (layer: Layer) => {
    cancelLayer(layer)
    layer.key = ''
    layer.box = null
    for (const canvas of layer.canvases) releaseCanvas(canvas)
  }

  const paintLayer = (
    layer: Layer,
    job: PdfPaintJob,
    livePage: PDFPageProxy,
    cssWidth: number,
    cssHeight: number,
    naturalWidth: number,
    afterSwap?: () => void | Promise<void>,
  ) => {
    if (layer.pending === job.key) return
    cancelLayer(layer)
    const token = layer.token
    const usedRotation = rotation
    layer.pending = job.key
    void enqueuePdfRender(async () => {
      if (disposed || token !== layer.token || page !== livePage) return
      const back = layer.canvases[layer.front ^ 1]
      const { box } = job
      const backingPerCss = box.pixelWidth / Math.max(1, box.cssWidth)
      const scale = backingPerCss * (cssWidth / Math.max(1, naturalWidth))
      const viewport = livePage.getViewport({ scale, rotation: usedRotation })
      back.width = box.pixelWidth
      back.height = box.pixelHeight
      const context = back.getContext('2d', { alpha: false })
      if (!context) return
      const integerScale = Math.abs(scale - Math.round(scale)) < 0.02
      context.imageSmoothingEnabled = !integerScale
      context.imageSmoothingQuality = 'high'
      context.setTransform(1, 0, 0, 1, 0, 0)
      context.fillStyle = '#ffffff'
      context.fillRect(0, 0, box.pixelWidth, box.pixelHeight)
      const task = livePage.render({
        canvas: back,
        canvasContext: context,
        viewport,
        intent: 'display',
        transform: [1, 0, 0, 1, -box.cssLeft * backingPerCss, -box.cssTop * (box.pixelHeight / Math.max(1, box.cssHeight))],
      })
      layer.task = task
      try {
        await task.promise
        if (disposed || token !== layer.token) return
        // One synchronous step: the new bitmap shows in the frame the old one hides.
        const front = layer.canvases[layer.front]
        placePdfCanvas(back, box, { cssWidth, cssHeight })
        back.style.visibility = 'visible'
        if (front !== back) releaseCanvas(front)
        layer.front = layer.front === 0 ? 1 : 0
        layer.key = job.key
        layer.box = box
        layer.pending = ''
        if (afterSwap) await afterSwap()
        if (layer === base && !firstPaintSent) {
          firstPaintSent = true
          options.onFirstPaint?.()
        }
      } catch (error: unknown) {
        if (token === layer.token) layer.pending = ''
        if (!isCancel(error)) console.error(`${label} konnte nicht gerendert werden.`, error)
      } finally {
        if (layer.task === task) layer.task = null
      }
    })
  }

  const paint = async () => {
    if (disposed || !page) return
    const livePage = page
    const cssWidth = stablePageCssWidth(host.clientWidth, base.box?.cssWidth ?? 0)
    if (cssWidth < 8) return
    const natural = livePage.getViewport({ scale: 1, rotation })
    const cssHeight = Math.max(1, Math.round(cssWidth * (natural.height / Math.max(1, natural.width))))
    const scroller = resolvePaperZoomScroller(host)
    const offset = layoutOffsetInScroller(host, scroller)
    const plan = planPdfPagePaint({
      cssWidth,
      cssHeight,
      rotation,
      dpr: window.devicePixelRatio || 1,
      viewZoom: readUsedSheetZoom(host),
      view: scroller
        ? {
          viewWidth: scroller.clientWidth,
          viewHeight: scroller.clientHeight,
          scrollLeft: scroller.scrollLeft,
          scrollTop: scroller.scrollTop,
          pageOffsetLeft: offset.left,
          pageOffsetTop: offset.top,
        }
        : null,
    }, {
      baseKey: base.key,
      detail: detail.key && detail.box ? { key: detail.key, box: detail.box } : null,
    })

    if (plan.base) {
      // The page box changed (resize, rotation): the old bitmap is stretched
      // over the new box right away so the page never blanks; a detail window
      // painted for the old box no longer lines up and goes.
      if (base.box) placePdfCanvas(base.canvases[base.front], plan.base.box, { cssWidth, cssHeight })
      dropLayer(detail)
      const job = plan.base
      paintLayer(base, job, livePage, cssWidth, cssHeight, natural.width, () => options.onBasePainted?.({
        page: livePage,
        cssWidth,
        cssHeight,
        naturalWidth: natural.width,
        rotation,
      }))
    }
    if (plan.detail === 'drop') {
      dropLayer(detail)
      return
    }
    if (plan.detail === 'keep') return
    paintLayer(detail, plan.detail, livePage, cssWidth, cssHeight, natural.width)
  }

  const setPage = (next: PDFPageProxy | null, nextRotation: number) => {
    if (next !== page) {
      dropLayer(base)
      dropLayer(detail)
    }
    page = next
    rotation = nextRotation
  }

  const dispose = () => {
    disposed = true
    dropLayer(base)
    dropLayer(detail)
    page = null
  }

  return { setPage, paint, dispose }
}
