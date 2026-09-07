import { useEffect, useRef, useState } from 'react'
import { drawInkStroke, type InkPaintStroke } from '../lib/inkStrokePaint'
import { textOriginCssPx } from '../lib/noteCanvas'

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

export type InkPreviewDocument = { drawingJson: string }

type ParsedInkPage = {
  strokes: InkPaintStroke[]
  width: number
  height: number
  /** Origin pad (CSS px) the typed text moved by when the page grew at the top/left. */
  originX: number
  originY: number
}

const isFiniteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)

/** Strokes and page box out of a saved drawing; malformed entries are dropped, never thrown. */
export const parseInkPreviewPage = (drawingJson: string): ParsedInkPage | null => {
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
  const strokes: InkPaintStroke[] = []
  for (const entry of document.strokes) {
    if (!entry || typeof entry !== 'object') continue
    const stroke = entry as Partial<InkPaintStroke>
    if (!Array.isArray(stroke.points) || typeof stroke.color !== 'string') continue
    const points = stroke.points.filter((point): point is { x: number; y: number; pressure?: number } => (
      Boolean(point) && typeof point === 'object' && isFiniteNumber(point.x) && isFiniteNumber(point.y)
    ))
    if (!points.length) continue
    strokes.push({
      points,
      baseWidth: isFiniteNumber(stroke.baseWidth) ? stroke.baseWidth : 4,
      pressureEnabled: stroke.pressureEnabled !== false,
      color: stroke.color,
      purpose: stroke.purpose === 'art' ? 'art' : 'handwriting',
      brush: typeof stroke.brush === 'string' ? stroke.brush : undefined,
      colorEffect: typeof stroke.colorEffect === 'string' ? stroke.colorEffect : undefined,
      opacity: isFiniteNumber(stroke.opacity) ? stroke.opacity : undefined,
      textureSeed: isFiniteNumber(stroke.textureSeed) ? stroke.textureSeed : undefined,
      symbolRotation: isFiniteNumber(stroke.symbolRotation) ? stroke.symbolRotation : undefined,
    })
  }
  return { strokes, width, height, originX, originY }
}

/** Backing-store scale: device pixels, capped so a very tall page stays affordable. */
export const inkPreviewScale = (width: number, height: number, devicePixelRatio: number) => {
  const wanted = Math.max(1, Math.min(3, devicePixelRatio || 1))
  const affordable = Math.sqrt(PREVIEW_MAX_PIXELS / Math.max(1, width * height))
  return Math.max(0.25, Math.min(wanted, affordable))
}

export function InkPreviewLayer({ load, smoothing, reloadKey }: {
  load: () => Promise<InkPreviewDocument | null>
  smoothing: number
  /** Changing this re-reads the page (the note's ink was saved elsewhere). */
  reloadKey?: string | number
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [page, setPage] = useState<ParsedInkPage | null>(null)

  useEffect(() => {
    let alive = true
    setPage(null)
    void load().then((document) => {
      if (!alive) return
      setPage(document ? parseInkPreviewPage(document.drawingJson) : null)
    }).catch(() => {
      if (alive) setPage(null)
    })
    return () => { alive = false }
  }, [load, reloadKey])

  // The paper grows to the saved page so the ink below the text stays reachable
  // by scrolling, and the text sits at the same origin pad as under the live
  // board: a page that grew at the top keeps its text next to the ink here too.
  useEffect(() => {
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

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !page) return
    const paint = () => {
      const scale = inkPreviewScale(page.width, page.height, window.devicePixelRatio || 1)
      const width = Math.max(1, Math.round(page.width * scale))
      const height = Math.max(1, Math.round(page.height * scale))
      if (canvas.width !== width) canvas.width = width
      if (canvas.height !== height) canvas.height = height
      const context = canvas.getContext('2d')
      if (!context) return
      context.setTransform(1, 0, 0, 1, 0, 0)
      context.clearRect(0, 0, width, height)
      for (const stroke of page.strokes) drawInkStroke(context, stroke, width, height, smoothing, 1, page.width)
    }
    paint()
    const media = window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`)
    media.addEventListener('change', paint)
    canvas.addEventListener('contextrestored', paint)
    return () => {
      media.removeEventListener('change', paint)
      canvas.removeEventListener('contextrestored', paint)
    }
  }, [page, smoothing])

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
