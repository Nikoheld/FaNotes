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

/** A missing or 0×0 first layout must not count as “the sheet grew”. */
export const paintedBoxIsUsable = (size: number) => Number.isFinite(size) && size > 1

export const layoutGrewEnough = (prevLayout: number, nextLayout: number) => (
  paintedBoxIsUsable(prevLayout)
  && Number.isFinite(nextLayout)
  && nextLayout > prevLayout + 1
)

/** Only shrink 0–1 on an axis after that axis’s source *and* painted box grew.
 *  A width-only grow must not rescale Y (and the reverse). prev=0 would be scale 0. */
export const liveGrowScale = (prevLayout: number, nextLayout: number, prevSource = 0, nextSource = 0) => {
  if (Number.isFinite(prevSource) && prevSource > 0 && Number.isFinite(nextSource) && !(nextSource > prevSource)) {
    return 1
  }
  if (!layoutGrewEnough(prevLayout, nextLayout) || !paintedBoxIsUsable(nextLayout)) return 1
  return prevLayout / nextLayout
}

/** CSS width factor: 1 = A4 column, >1 grows to the right. */
export const inkWidthExtentFactor = (sourceWidth: number) => (
  Math.max(PAPER_SOURCE_WIDTH, sourceWidth) / PAPER_SOURCE_WIDTH
)

/** Painted height uses the A4 column, not the grown client width. */
export const inkColumnWidthPx = (clientWidthPx: number, sourceWidth: number) => {
  const extent = inkWidthExtentFactor(sourceWidth)
  return Math.max(1, clientWidthPx) / extent
}

export const inkPaintedHeightPx = (columnWidthPx: number, sourceHeight: number) => {
  const raw = Math.max(1, columnWidthPx) * (Math.max(PAPER_SOURCE_HEIGHT, sourceHeight) / PAPER_SOURCE_WIDTH)
  return Math.ceil(raw / 4) * 4
}

export const inkExtentStyleValues = (
  sourceHeight: number,
  sourceWidth: number,
  clientWidthPx = PAPER_SOURCE_WIDTH,
) => {
  const widthExtent = inkWidthExtentFactor(sourceWidth)
  const columnPx = inkColumnWidthPx(clientWidthPx, sourceWidth)
  const paintedHeightPx = inkPaintedHeightPx(columnPx, sourceHeight)
  return {
    widthExtent,
    columnPx,
    paintedHeightPx,
    extentRatio: paintedHeightPx / columnPx,
  }
}

/** Class that pins the A4 left edge — only after the sheet actually grew right. */
export const INK_WIDTH_ANCHOR_CLASS = 'has-ink-width'

export const inkWidthNeedsAnchor = (widthExtent: number) => (
  Number.isFinite(widthExtent) && widthExtent > 1 + 1e-6
)

/** Same left inset as `margin-left: auto` on an A4-width sheet. */
export const a4ColumnOriginLeftPx = (containerWidthPx: number, paperWidthPx: number) => (
  (Math.max(0, containerWidthPx) - Math.max(0, paperWidthPx)) / 2
)

/** Left inset after ink-extent styles. Ungrown width must match A4 auto. */
export const inkExtentOriginLeftPx = (
  containerWidthPx: number,
  paperWidthPx: number,
  widthExtent: number,
) => {
  if (!inkWidthNeedsAnchor(widthExtent)) return a4ColumnOriginLeftPx(containerWidthPx, paperWidthPx)
  return Math.max(32, (containerWidthPx - paperWidthPx) / 2)
}

const paintedAxis = (prevSize: number, nextSize: number, scale: number) => (
  scale === 1 && paintedBoxIsUsable(prevSize) ? prevSize : nextSize
)

export const applyLiveHandwritingGrow = (
  point: { x: number; y: number },
  prev: { sourceW: number; sourceH: number; layoutW: number; layoutH: number },
  next: { sourceW: number; sourceH: number; layoutW: number; layoutH: number },
) => {
  const scaleX = liveGrowScale(prev.layoutW, next.layoutW, prev.sourceW, next.sourceW)
  const scaleY = liveGrowScale(prev.layoutH, next.layoutH, prev.sourceH, next.sourceH)
  const x = point.x * scaleX
  const y = point.y * scaleY
  const paintW = paintedAxis(prev.layoutW, next.layoutW, scaleX)
  const paintH = paintedAxis(prev.layoutH, next.layoutH, scaleY)
  return {
    x,
    y,
    pixelX: paperPixelY(point.x, paintedBoxIsUsable(prev.layoutW) ? prev.layoutW : paintW),
    pixelY: paperPixelY(point.y, paintedBoxIsUsable(prev.layoutH) ? prev.layoutH : paintH),
    nextPixelX: x * paintW,
    nextPixelY: y * paintH,
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

const axisPending = (prev: number, next: number) => (
  Number.isFinite(prev) && Number.isFinite(next) && next !== prev
)

/** Keep an unflushed axis when the other axis grows. Settled axes store prev=next. */
export const mergePendingGrow = (
  existing: PendingGrowRemap | null,
  grow: PendingGrowRemap,
  applied: { scaleX: number; scaleY: number },
): PendingGrowRemap | null => {
  const keepX = Boolean(existing && axisPending(existing.prevW, existing.nextW) && applied.scaleX === 1)
  const keepY = Boolean(existing && axisPending(existing.prevH, existing.nextH) && applied.scaleY === 1)
  const pendingX = applied.scaleX === 1 && (keepX || axisPending(grow.prevW, grow.nextW))
  const pendingY = applied.scaleY === 1 && (keepY || axisPending(grow.prevH, grow.nextH))
  const next: PendingGrowRemap = {
    prevW: pendingX ? (keepX && existing ? existing.prevW : grow.prevW) : grow.nextW,
    nextW: pendingX ? (keepX && existing ? Math.max(existing.nextW, grow.nextW) : grow.nextW) : grow.nextW,
    prevLayoutW: pendingX
      ? (keepX && existing && paintedBoxIsUsable(existing.prevLayoutW) ? existing.prevLayoutW : grow.prevLayoutW)
      : grow.prevLayoutW,
    prevH: pendingY ? (keepY && existing ? existing.prevH : grow.prevH) : grow.nextH,
    nextH: pendingY ? (keepY && existing ? Math.max(existing.nextH, grow.nextH) : grow.nextH) : grow.nextH,
    prevLayoutH: pendingY
      ? (keepY && existing && paintedBoxIsUsable(existing.prevLayoutH) ? existing.prevLayoutH : grow.prevLayoutH)
      : grow.prevLayoutH,
  }
  if (!axisPending(next.prevW, next.nextW) && !axisPending(next.prevH, next.nextH)) return null
  return next
}

/** Scale to apply once the painted box has actually grown. Unready axes stay pending. */
export const pendingGrowScale = (
  pending: PendingGrowRemap | null,
  layoutW: number,
  layoutH: number,
) => {
  const idle = { scaleX: 1, scaleY: 1, ready: false, discard: false, remaining: pending }
  if (!pending) return { ...idle, remaining: null }
  const prevUsable = paintedBoxIsUsable(pending.prevLayoutW) || paintedBoxIsUsable(pending.prevLayoutH)
  if (!prevUsable) return { scaleX: 1, scaleY: 1, ready: false, discard: true, remaining: null }
  const scaleX = liveGrowScale(pending.prevLayoutW, layoutW, pending.prevW, pending.nextW)
  const scaleY = liveGrowScale(pending.prevLayoutH, layoutH, pending.prevH, pending.nextH)
  const remaining = mergePendingGrow(pending, pending, { scaleX, scaleY })
  return { scaleX, scaleY, ready: scaleX !== 1 || scaleY !== 1, discard: false, remaining }
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

/** Skip source grow when the painted sheet is already taller/wider than the wanted extent. */
export const neededSourceExtentAgainstPainted = (
  wantedExtent: number,
  currentSource: number,
  painted: number,
) => {
  if (!paintedBoxIsUsable(painted)) return wantedExtent
  if (Number.isFinite(wantedExtent) && wantedExtent <= painted) return currentSource
  return wantedExtent
}

export const nextWriteExtent = (
  normalized: number | undefined,
  source: number,
  slack: number,
  step: number,
  painted = 0,
) => (
  neededSourceExtentAgainstPainted(
    neededWriteExtent(normalized, source, slack, step),
    source,
    painted,
  )
)
