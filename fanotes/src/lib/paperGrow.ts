import { isInkCorridorLeap, mapClientToPaperPoint, type InkPointerLike, type MappedInkPoint, type PaperSurfaceBox } from './inkSampleMap'

export const PAPER_SOURCE_WIDTH = 900
export const PAPER_SOURCE_HEIGHT = 1273

/** Modest empty paper past the last glyph or stroke — not half an A4. */
export const WRITE_SLACK_HEIGHT = 144
/** Modest empty paper to the right of the last stroke. */
export const WRITE_SLACK_WIDTH = 108
/** Grow in the same modest chunks so the sheet follows the pen, not a blank page. */
export const PAGE_GROW_STEP_HEIGHT = WRITE_SLACK_HEIGHT
export const PAGE_GROW_STEP_WIDTH = WRITE_SLACK_WIDTH
/** Runaway bitmap cap (~40 A4 pages). Ordinary notes never hit this. */
export const WRITE_MEMORY_CAP_HEIGHT = PAPER_SOURCE_HEIGHT * 40
/** Runaway bitmap cap (~20 A4 widths). */
export const WRITE_MEMORY_CAP_WIDTH = PAPER_SOURCE_WIDTH * 20

export const paperPixelY = (normalizedY: number, sourceHeight: number) => normalizedY * sourceHeight

/** A missing or 0×0 first layout must not count as “the sheet grew”. */
export const paintedBoxIsUsable = (size: number) => Number.isFinite(size) && size > 1

export const layoutGrewEnough = (prevLayout: number, nextLayout: number) => (
  paintedBoxIsUsable(prevLayout)
  && Number.isFinite(nextLayout)
  && nextLayout > prevLayout + 1
)

/** Remap 0–1 after the painted box grew. A width-only source grow that
 *  accidentally changed painted height must not rescale Y (`siblingSourceGrew`).
 *  A layout-only grow (PDF pages finishing) *must* remap so ink stays put. */
export const liveGrowScale = (
  prevLayout: number,
  nextLayout: number,
  prevSource = 0,
  nextSource = 0,
  siblingSourceGrew = false,
) => {
  if (!layoutGrewEnough(prevLayout, nextLayout) || !paintedBoxIsUsable(nextLayout)) return 1
  const sourceGrew = Number.isFinite(prevSource) && prevSource > 0 && Number.isFinite(nextSource) && nextSource > prevSource
  if (!sourceGrew && siblingSourceGrew) return 1
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
  const scaleX = liveGrowScale(prev.layoutW, next.layoutW, prev.sourceW, next.sourceW, next.sourceH > prev.sourceH)
  const scaleY = liveGrowScale(prev.layoutH, next.layoutH, prev.sourceH, next.sourceH, next.sourceW > prev.sourceW)
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
  const scaleX = axisPending(pending.prevW, pending.nextW)
    ? liveGrowScale(pending.prevLayoutW, layoutW, pending.prevW, pending.nextW)
    : 1
  const scaleY = axisPending(pending.prevH, pending.nextH)
    ? liveGrowScale(pending.prevLayoutH, layoutH, pending.prevH, pending.nextH)
    : 1
  const remaining = mergePendingGrow(pending, pending, { scaleX, scaleY })
  return { scaleX, scaleY, ready: scaleX !== 1 || scaleY !== 1, discard: false, remaining }
}

/** One remap when the painted box catches up. Pending width grow and a
 *  layout-only flush must not both scale X — that squishes left-side ink. */
export const resolvePaintedLayoutGrow = (input: {
  pending: PendingGrowRemap | null
  prevLayoutW: number
  prevLayoutH: number
  nextLayoutW: number
  nextLayoutH: number
  sourceW: number
  sourceH: number
}) => {
  if (input.pending) {
    const flushed = pendingGrowScale(input.pending, input.nextLayoutW, input.nextLayoutH)
    return {
      scaleX: flushed.scaleX,
      scaleY: flushed.scaleY,
      pending: flushed.remaining,
      apply: flushed.ready,
      discard: flushed.discard,
    }
  }
  if (!paintedBoxIsUsable(input.prevLayoutW) || !paintedBoxIsUsable(input.prevLayoutH)) {
    return { scaleX: 1, scaleY: 1, pending: null, apply: false, discard: false }
  }
  const scaleX = liveGrowScale(input.prevLayoutW, input.nextLayoutW, input.sourceW, input.sourceW, false)
  const scaleY = liveGrowScale(input.prevLayoutH, input.nextLayoutH, input.sourceH, input.sourceH, false)
  return {
    scaleX,
    scaleY,
    pending: null,
    apply: scaleX !== 1 || scaleY !== 1,
    discard: false,
  }
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

export type PaperContentBox = {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

export type PaperViewportSize = {
  width: number
  height: number
}

/** Paper/scroll size is the content box plus modest slack. Unused sides stay closed. */
export const paperScrollBounds = (
  content: PaperContentBox,
  slackX = WRITE_SLACK_WIDTH,
  slackY = WRITE_SLACK_HEIGHT,
): PaperContentBox => {
  const minX = Math.min(0, Number.isFinite(content.minX) ? content.minX : 0)
  const minY = Math.min(0, Number.isFinite(content.minY) ? content.minY : 0)
  const maxX = Math.max(0, Number.isFinite(content.maxX) ? content.maxX : 0) + Math.max(0, slackX)
  const maxY = Math.max(0, Number.isFinite(content.maxY) ? content.maxY : 0) + Math.max(0, slackY)
  return { minX, minY, maxX, maxY }
}

export const clampPaperScrollOffset = (
  offset: { x: number; y: number },
  bounds: PaperContentBox,
  viewport: PaperViewportSize,
) => {
  const viewW = Math.max(0, viewport.width)
  const viewH = Math.max(0, viewport.height)
  const maxScrollX = Math.max(0, bounds.maxX - bounds.minX - viewW)
  const maxScrollY = Math.max(0, bounds.maxY - bounds.minY - viewH)
  const x = Number.isFinite(offset.x) ? offset.x : 0
  const y = Number.isFinite(offset.y) ? offset.y : 0
  return {
    x: Math.min(maxScrollX, Math.max(0, x)),
    y: Math.min(maxScrollY, Math.max(0, y)),
  }
}
