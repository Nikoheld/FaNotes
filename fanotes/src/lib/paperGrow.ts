import { isInkCorridorLeap, mapClientToPaperPoint, type InkPointerLike, type MappedInkPoint, type PaperSurfaceBox } from './inkSampleMap'

export const PAPER_SOURCE_WIDTH = 900
export const PAPER_SOURCE_HEIGHT = 1273

/** Empty paper kept below the pen — about half an A4, so growth starts earlier. */
export const WRITE_SLACK_HEIGHT = Math.round(PAPER_SOURCE_HEIGHT * 0.52)
/** Empty paper kept to the right of the pen. */
export const WRITE_SLACK_WIDTH = Math.round(PAPER_SOURCE_WIDTH * 0.4)
/** Grow in half-page chunks so the ruling is not resized every sample. */
export const PAGE_GROW_STEP_HEIGHT = Math.round(PAPER_SOURCE_HEIGHT * 0.5)
export const PAGE_GROW_STEP_WIDTH = Math.round(PAPER_SOURCE_WIDTH * 0.5)

export const paperPixelY = (normalizedY: number, sourceHeight: number) => normalizedY * sourceHeight

export const layoutGrewEnough = (prevLayout: number, nextLayout: number) => nextLayout > prevLayout + 1

/** Only shrink 0–1 space when the painted sheet actually got taller.
 *  Map and paint use layout pixels, so scale by that box — not source extent. */
export const liveGrowScale = (prevLayout: number, nextLayout: number, _prevSource = 0, _nextSource = 0) => {
  if (!layoutGrewEnough(prevLayout, nextLayout) || !(nextLayout > 0)) return 1
  return prevLayout / nextLayout
}

export const applyLiveHandwritingGrow = (
  point: { x: number; y: number },
  prev: { sourceW: number; sourceH: number; layoutW: number; layoutH: number },
  next: { sourceW: number; sourceH: number; layoutW: number; layoutH: number },
) => {
  const pixelX = paperPixelY(point.x, prev.layoutW)
  const pixelY = paperPixelY(point.y, prev.layoutH)
  const scaleX = liveGrowScale(prev.layoutW, next.layoutW, prev.sourceW, next.sourceW)
  const scaleY = liveGrowScale(prev.layoutH, next.layoutH, prev.sourceH, next.sourceH)
  const x = point.x * scaleX
  const y = point.y * scaleY
  return {
    x,
    y,
    pixelX,
    pixelY,
    nextPixelX: x * (scaleX === 1 ? prev.layoutW : next.layoutW),
    nextPixelY: y * (scaleY === 1 ? prev.layoutH : next.layoutH),
    remapped: scaleX !== 1 || scaleY !== 1,
  }
}

export const remapNormalizedAfterGrow = (
  point: { x: number; y: number },
  prevWidth: number,
  nextWidth: number,
  prevHeight: number,
  nextHeight: number,
) => {
  const grown = applyLiveHandwritingGrow(
    point,
    { sourceW: prevWidth, sourceH: prevHeight, layoutW: prevWidth, layoutH: prevHeight },
    { sourceW: nextWidth, sourceH: nextHeight, layoutW: nextWidth, layoutH: nextHeight },
  )
  return { x: grown.x, y: grown.y }
}

export type PendingGrowRemap = {
  prevH: number
  nextH: number
  prevW: number
  nextW: number
  prevLayoutH: number
  prevLayoutW: number
}

/** Scale to apply once the painted box has actually grown. */
export const pendingGrowScale = (
  pending: PendingGrowRemap | null,
  layoutW: number,
  layoutH: number,
) => {
  if (!pending) return { scaleX: 1, scaleY: 1, ready: false }
  const scaleX = liveGrowScale(pending.prevLayoutW, layoutW, pending.prevW, pending.nextW)
  const scaleY = liveGrowScale(pending.prevLayoutH, layoutH, pending.prevH, pending.nextH)
  return { scaleX, scaleY, ready: scaleX !== 1 || scaleY !== 1 }
}

export const growLiveInkAndMapNext = (
  lastPoint: MappedInkPoint,
  prevHeight: number,
  nextHeight: number,
  event: InkPointerLike,
  surfaceAfterLayout: PaperSurfaceBox | null,
  rotation = 0,
  prevLayoutH = prevHeight,
  nextLayoutH = nextHeight,
  prevWidth = 1,
  nextWidth = 1,
  prevLayoutW = prevWidth,
  nextLayoutW = nextWidth,
) => {
  const last = {
    ...lastPoint,
    ...applyLiveHandwritingGrow(
      lastPoint,
      { sourceW: prevWidth, sourceH: prevHeight, layoutW: prevLayoutW, layoutH: prevLayoutH },
      { sourceW: nextWidth, sourceH: nextHeight, layoutW: nextLayoutW, layoutH: nextLayoutH },
    ),
  }
  const mapped = mapClientToPaperPoint(event, surfaceAfterLayout, rotation)
  if (!mapped) return { last, next: null, jumped: false }
  const jumped = isInkCorridorLeap(last, mapped)
  return {
    last,
    next: jumped ? last : mapped,
    jumped,
  }
}

export const neededWriteExtent = (
  normalized: number | undefined,
  current: number,
  slack: number,
  step: number,
) => {
  if (typeof normalized !== 'number' || !Number.isFinite(normalized)) return current
  if (!Number.isFinite(current) || current < 1) return current
  if (!Number.isFinite(slack) || !Number.isFinite(step) || step < 1) return current
  const needed = normalized * current + slack
  if (!(needed > current)) return current
  return Math.max(current, Math.ceil(needed / step) * step)
}
