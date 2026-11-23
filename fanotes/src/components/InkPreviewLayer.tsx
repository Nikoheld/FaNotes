import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createMarkerCoverage, drawInkStroke, type InkPaintStroke } from '../lib/inkStrokePaint'
import { expandPackedStroke, frameBudgetOpen, INK_OPEN_ONE_PASS_POINTS, packedInkPoints } from '../lib/packedInk'
import { readFunctionGraphStamp } from '../lib/functionGraph'
import { clampFigureLineWidth, clampFigureParams, figureLineWidthForSize, isMathFigureId, mathFigurePaths } from '../lib/mathFigures'
import { textOriginCssPx } from '../lib/noteCanvas'
import type { PackedInk } from '../types'
import { usePaperViewController } from './PaperView'

/**
 * Read-only handwriting for the second split pane.
 *
 * The full DrawingBoard owns saving, recognition and the pen; mounting a second
 * one for the same vault would race its writes. This layer only paints: it
 * reads the saved page once, sizes the paper to the page the strokes are 0–1
 * of, and draws the ink at that exact size so nothing stretches when the pane
 * is narrower or wider than the sheet was.
 */

const PREVIEW_MAX_PIXELS = 24_000_000
/** Sheet zoom above this no longer raises the bitmap; the budget caps tall pages anyway. */
const PREVIEW_MAX_SCALE = 4
/** Wait for a wheel/pinch burst to end before rasterising at the new zoom. */
const PREVIEW_ZOOM_SETTLE_MS = 160

export type InkPreviewDocument = { drawingJson: string; packedInk?: PackedInk | null }

type ParsedInkPage = {
  strokes: InkPaintStroke[]
  width: number
  height: number
  /** Origin pad (CSS px) the typed text moved by when the page grew at the top/left. */
  originX: number
  originY: number
  /** Heavy pages keep samples in columns and paint a slice per frame. */
  packedStrokes?: unknown[]
  packedInk?: PackedInk | null
}

const isFiniteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)

const previewStroke = (stroke: Partial<InkPaintStroke> & {
  figureId?: unknown
  figureParams?: unknown
  figureLineWidth?: unknown
  graphExpression?: unknown
  graphXMin?: unknown
  graphXMax?: unknown
  graphPaths?: unknown
  symbolRotation?: unknown
}): InkPaintStroke | null => {
  if (!Array.isArray(stroke.points) || typeof stroke.color !== 'string') return null
  const points = stroke.points.filter((point): point is { x: number; y: number; pressure?: number } => (
    Boolean(point) && typeof point === 'object' && isFiniteNumber(point.x) && isFiniteNumber(point.y)
  ))
  if (!points.length) return null
  const figureId = isMathFigureId(stroke.figureId) ? stroke.figureId : undefined
  const figurePaths = figureId ? mathFigurePaths(figureId, clampFigureParams(figureId, stroke.figureParams)) : []
  const graph = figurePaths.length ? null : readFunctionGraphStamp(stroke)
  const stampWidth = isFiniteNumber(stroke.baseWidth) ? stroke.baseWidth : 4
  return {
    points,
    baseWidth: stampWidth,
    pressureEnabled: stroke.pressureEnabled !== false,
    color: stroke.color,
    purpose: stroke.purpose === 'art' ? 'art' : 'handwriting',
    brush: typeof stroke.brush === 'string' ? stroke.brush : undefined,
    colorEffect: typeof stroke.colorEffect === 'string' ? stroke.colorEffect : undefined,
    opacity: isFiniteNumber(stroke.opacity) ? stroke.opacity : undefined,
    textureSeed: isFiniteNumber(stroke.textureSeed) ? stroke.textureSeed : undefined,
    symbolRotation: figureId
      ? (isFiniteNumber(stroke.symbolRotation) ? stroke.symbolRotation : 0)
      : graph
        ? 0
        : isFiniteNumber(stroke.symbolRotation) ? stroke.symbolRotation : undefined,
    figureLineWidth: figureId || graph
      ? clampFigureLineWidth(stroke.figureLineWidth, figureLineWidthForSize(stampWidth))
      : undefined,
    symbolPaths: figurePaths.length ? figurePaths : graph?.paths,
    keepColor: stroke.keepColor === true ? true : undefined,
  }
}

/** Strokes and page box out of a saved drawing; malformed entries are dropped, never thrown. */
export const parseInkPreviewPage = (drawingJson: string, packedInk?: PackedInk | null): ParsedInkPage | null => {
  let raw: unknown
  try {
    raw = JSON.parse(drawingJson)
  } catch {
    return null
  }
  if (!raw || typeof raw !== 'object') return null
  const document = raw as { strokes?: unknown; sourceWidth?: unknown; sourceHeight?: unknown; sourceOriginX?: unknown; sourceOriginY?: unknown }
  if (!Array.isArray(document.strokes)) return null
  const width = isFiniteNumber(document.sourceWidth) && document.sourceWidth > 0 ? document.sourceWidth : 0
  const height = isFiniteNumber(document.sourceHeight) && document.sourceHeight > 0 ? document.sourceHeight : 0
  if (!width || !height) return null
  const originX = isFiniteNumber(document.sourceOriginX) && document.sourceOriginX > 0 ? document.sourceOriginX : 0
  const originY = isFiniteNumber(document.sourceOriginY) && document.sourceOriginY > 0 ? document.sourceOriginY : 0
  if (packedInk?.columns) {
    return { strokes: [], width, height, originX, originY, packedStrokes: document.strokes, packedInk }
  }
  const strokes: InkPaintStroke[] = []
  for (const entry of document.strokes) {
    if (!entry || typeof entry !== 'object') continue
    const stroke = previewStroke(entry as Partial<InkPaintStroke>)
    if (stroke) strokes.push(stroke)
  }
  return { strokes, width, height, originX, originY }
}

/**
 * Backing-store scale: device pixels times the sheet zoom, capped so a very
 * tall page stays affordable. Without the zoom the CSS camera stretched a
 * 1×-DPR bitmap and the handwriting in the second pane went soft.
 */
export const inkPreviewScale = (width: number, height: number, devicePixelRatio: number, zoom = 1) => {
  const wanted = Math.max(1, Math.min(PREVIEW_MAX_SCALE, (devicePixelRatio || 1) * Math.max(0.01, zoom || 1)))
  const affordable = Math.sqrt(PREVIEW_MAX_PIXELS / Math.max(1, width * height))
  return Math.max(0.25, Math.min(wanted, affordable))
}

const samePreviewDocument = (a: InkPreviewDocument | null, b: InkPreviewDocument | null) => {
  if (!a || !b) return a === b
  if (a.drawingJson !== b.drawingJson) return false
  const left = a.packedInk
  const right = b.packedInk
  if (!left?.columns || !right?.columns) return !left?.columns && !right?.columns
  if (left.stride !== right.stride || left.columns.length !== right.columns.length) return false
  for (let index = 0; index < left.columns.length; index += 1) if (left.columns[index] !== right.columns[index]) return false
  return true
}

/**
 * Mount it per note (a `key`): `initial` is the page read before the pane
 * showed, so the pane's first frame has its ink; a reload keeps the shown
 * page until the new one is read, and keeps it when nothing changed.
 */
export function InkPreviewLayer({ load, smoothing, reloadKey, initial }: {
  load: () => Promise<InkPreviewDocument | null>
  smoothing: number
  /** Changing this re-reads the page (the note's ink was saved elsewhere). */
  reloadKey?: string | number
  /** The note's page as read before the pane mounted (undefined: not read yet). */
  initial?: InkPreviewDocument | null
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [page, setPage] = useState<ParsedInkPage | null>(() => (
    initial ? parseInkPreviewPage(initial.drawingJson, initial.packedInk) : null
  ))
  const shownRef = useRef<InkPreviewDocument | null | undefined>(initial)
  const paperView = usePaperViewController()

  useEffect(() => {
    let alive = true
    void load().then((document) => {
      if (!alive) return
      if (shownRef.current !== undefined && samePreviewDocument(shownRef.current, document)) return
      shownRef.current = document
      setPage(document ? parseInkPreviewPage(document.drawingJson, document.packedInk) : null)
    }).catch(() => {
      if (!alive) return
      shownRef.current = null
      setPage(null)
    })
    return () => { alive = false }
  }, [load, reloadKey])

  // The paper grows to the saved page so the ink below the text stays reachable
  // by scrolling, and the text sits at the same origin pad as under the live
  // board: a page that grew at the top keeps its text next to the ink here too.
  // Before paint, so the first frame with the page has its size.
  useLayoutEffect(() => {
    const paper = canvasRef.current?.parentElement
    if (!paper || !page) return
    const origin = textOriginCssPx(page.originX, page.originY)
    const plane = paper.closest('.paper-sheet-plane') as HTMLElement | null
    paper.classList.add('has-ink-extent')
    paper.style.setProperty('--ink-page-width', `${Math.round(page.width)}px`)
    paper.style.setProperty('--ink-page-height', `${Math.round(page.height)}px`)
    paper.style.setProperty('--text-origin-x', origin.x)
    paper.style.setProperty('--text-origin-y', origin.y)
    plane?.style.setProperty('--text-origin-x', origin.x)
    plane?.style.setProperty('--text-origin-y', origin.y)
    return () => {
      paper.classList.remove('has-ink-extent')
      for (const name of ['--ink-page-width', '--ink-page-height', '--text-origin-x', '--text-origin-y']) paper.style.removeProperty(name)
      plane?.style.removeProperty('--text-origin-x')
      plane?.style.removeProperty('--text-origin-y')
    }
  }, [page])

  // Painted before the frame that shows the canvas: no blank or half-drawn frame.
  useLayoutEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !page) return
    let paintedScale = 0
    let alive = true
    const paint = () => {
      const zoom = paperView?.getView().zoom ?? 1
      const scale = inkPreviewScale(page.width, page.height, window.devicePixelRatio || 1, zoom)
      const width = Math.max(1, Math.round(page.width * scale))
      const height = Math.max(1, Math.round(page.height * scale))
      if (canvas.width === width && canvas.height === height && paintedScale === scale) return
      paintedScale = scale
      if (canvas.width !== width) canvas.width = width
      if (canvas.height !== height) canvas.height = height
      const context = canvas.getContext('2d')
      if (!context) return
      context.setTransform(1, 0, 0, 1, 0, 0)
      context.clearRect(0, 0, width, height)
      const coverage = createMarkerCoverage(width, height)
      const packed = page.packedInk?.columns ? page.packedStrokes : null
      if (packed && page.packedInk) {
        const columns = page.packedInk
        // A page of usual size is painted whole now; only a huge one goes a slice per frame.
        const onePass = packedInkPoints(columns) <= INK_OPEN_ONE_PASS_POINTS
        const paintPacked = (from: number) => {
          if (!alive || paintedScale !== scale) return
          const started = performance.now()
          let painted = 0
          let cursor = from
          while (cursor < packed.length && (onePass || frameBudgetOpen(started, performance.now(), painted))) {
            const entry = packed[cursor]
            cursor += 1
            painted += 1
            if (!entry || typeof entry !== 'object') continue
            const stroke = previewStroke(expandPackedStroke(entry, columns) as Partial<InkPaintStroke>)
            if (!stroke) continue
            drawInkStroke(context, stroke, width, height, smoothing, 1, page.width, 0, stroke.points.length, { coverage, stamp: true })
          }
          if (cursor < packed.length) requestAnimationFrame(() => paintPacked(cursor))
        }
        paintPacked(0)
        return
      }
      for (const stroke of page.strokes) {
        drawInkStroke(context, stroke, width, height, smoothing, 1, page.width, 0, stroke.points.length, { coverage, stamp: true })
      }
    }
    const repaint = () => {
      paintedScale = 0
      paint()
    }
    paint()
    // During a zoom gesture the CSS camera scales the existing bitmap; the
    // sharp re-raster happens once the wheel/pinch burst has settled. The
    // pane's own open zoom (its fit) lands in the commit that mounts this
    // layer: painted at it right away, the first frame is the final picture.
    let settleTimer = 0
    let mounting = true
    queueMicrotask(() => { mounting = false })
    const unsubscribeZoom = paperView?.subscribe(() => {
      if (mounting) {
        paint()
        return
      }
      if (settleTimer) window.clearTimeout(settleTimer)
      settleTimer = window.setTimeout(() => {
        settleTimer = 0
        paint()
      }, PREVIEW_ZOOM_SETTLE_MS)
    })
    const media = window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`)
    media.addEventListener('change', repaint)
    canvas.addEventListener('contextrestored', repaint)
    return () => {
      alive = false
      if (settleTimer) window.clearTimeout(settleTimer)
      unsubscribeZoom?.()
      media.removeEventListener('change', repaint)
      canvas.removeEventListener('contextrestored', repaint)
    }
  }, [page, paperView, smoothing])

  if (!page) return null
  return (
    <canvas
      ref={canvasRef}
      className="ink-preview-layer"
      aria-hidden="true"
      style={{ width: `${Math.round(page.width)}px`, height: `${Math.round(page.height)}px` }}
    />
  )
}

export default InkPreviewLayer
