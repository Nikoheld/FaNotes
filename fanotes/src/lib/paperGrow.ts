import {
  classifyInkJumpAppend,
  isInkCorridorLeap,
  mapClientToPaperPoint,
  type InkPointerLike,
  type MappedInkPoint,
  type PaperSurfaceBox,
} from './inkSampleMap'
import {
  growWriteExtent,
  keepMarkOnPage,
  PAPER_SOURCE_WIDTH,
  WRITE_SLACK_HEIGHT,
} from './noteCanvas'

export {
  PAGE_START_WIDTH,
  PAGE_START_HEIGHT,
  WRITE_MARGIN_X,
  WRITE_MARGIN_Y,
  GROW_STEP_X,
  GROW_STEP_Y,
  SCROLL_ROOM,
  WRITE_CAP_WIDTH,
  WRITE_CAP_HEIGHT,
  PAGE_BACKGROUND,
  growWriteExtent,
  growWriteOrigin,
  growPageFromMark,
  writePageLayoutSize,
  keepMarkOnPage,
  markPagePosition,
  canvasScrollBounds,
  clampCanvasScroll,
  writeExtentFromContent,
  pageCanvasLayout,
  inkOverlaySize,
  mapClientToPage,
  writePageSurface,
  writeSurfaceIsPage,
  paperScrollPad,
  paperScrollBoundsFromVisualRect,
  paperMinEdgeGrows,
  PAPER_SOURCE_WIDTH,
  PAPER_SOURCE_HEIGHT,
  WRITE_SLACK_WIDTH,
  WRITE_SLACK_HEIGHT,
  PAGE_GROW_STEP_WIDTH,
  PAGE_GROW_STEP_HEIGHT,
  WRITE_MEMORY_CAP_WIDTH,
  WRITE_MEMORY_CAP_HEIGHT,
  neededWriteExtent,
  neededWriteMinPad,
  remapNormalizedAfterExtent,
  paperScrollBounds,
  clampPaperScrollOffset,
  paperSourceExtentFromContent,
  mapClientToOneCanvas,
  oneCanvasSurface,
  writeSurfaceIsPlane,
} from './noteCanvas'
export type {
  CanvasBox,
  CanvasBox as PaperContentBox,
  CanvasViewport as PaperViewportSize,
} from './noteCanvas'

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
  const height = Number.isFinite(sourceHeight) && sourceHeight > 0 ? sourceHeight : WRITE_SLACK_HEIGHT
  const raw = Math.max(1, columnWidthPx) * (height / PAPER_SOURCE_WIDTH)
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
export const HAS_INK_EXTENT_CLASS = 'has-ink-extent'

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

export type WritePageExtent = {
  width: number
  height: number
  padX?: number
  padY?: number
}

/**
 * Live markdown append path. `last` must be the pre-grow snapshot — not the
 * live stroke point after setPageExtent already ran keepMarkOnPage on it.
 */
export const continueStrokeAfterExtentGrow = (
  last: { x: number; y: number } | null | undefined,
  current: { x: number; y: number },
  prev: WritePageExtent,
  next: WritePageExtent,
  existingCount: number,
) => {
  const padX = Math.max(0, next.padX ?? 0)
  const padY = Math.max(0, next.padY ?? 0)
  const remap = (point: { x: number; y: number }) => ({
    x: keepMarkOnPage(point.x, prev.width, next.width, padX),
    y: keepMarkOnPage(point.y, prev.height, next.height, padY),
  })
  const remappedLast = last ? { ...last, ...remap(last) } : null
  const remappedCurrent = { ...current, ...remap(current) }
  return {
    last: remappedLast,
    current: remappedCurrent,
    action: classifyInkJumpAppend(remappedLast, remappedCurrent, existingCount),
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

/**
 * PDF overlays can already be taller than A4 source. Markdown write-page grow
 * uses growPageFromMark, which must not consult CSS fill.
 */
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
    growWriteExtent(normalized, source, slack, step),
    source,
    painted,
  )
)

/**
 * Bitmap scale so `penWidth` (settings: px) stays CSS pixels on the painted
 * overlay. Using sourceWidth here made a 3.5px pen a hairline once the overlay
 * was wider than A4 or shorter than a tall PDF in source space.
 */
export const inkStrokePaintScale = (bitmapWidth: number, layoutWidth: number) => {
  const layout = layoutWidth > 1 ? layoutWidth : bitmapWidth
  if (!(bitmapWidth > 0) || !(layout > 0)) return 1
  return bitmapWidth / layout
}

/** CSS-pixel stroke width at zoom 1. Independent of source extent. */
export const inkStrokeCssPixels = (baseWidth: number, bitmapWidth: number, layoutWidth: number) => (
  Math.max(0, baseWidth) * inkStrokePaintScale(bitmapWidth, layoutWidth)
)

/**
 * Tablet-board A4 box. Must not size the inline overlay — a tall PDF
 * (`sourceHeight` ≫ A4) collapses this to a strip, so the pen misses the page
 * or paints a hairline.
 */
export const a4AspectBoardSize = (
  availableWidth: number,
  availableHeight: number,
  sourceWidth: number,
  sourceHeight: number,
) => {
  const ratio = Math.max(0.05, sourceWidth) / Math.max(1, sourceHeight)
  const width = Math.min(Math.max(1, availableWidth), Math.max(1, availableHeight) * ratio)
  return { width, height: width / ratio }
}

export const clearInkExtentStyles = (paper: {
  classList?: { remove: (...names: string[]) => void }
  style?: { removeProperty: (name: string) => void }
  closest?: (selector: string) => { style?: { removeProperty: (name: string) => void } } | null
} | null) => {
  if (!paper) return
  paper.classList?.remove(HAS_INK_EXTENT_CLASS, INK_WIDTH_ANCHOR_CLASS)
  paper.style?.removeProperty('--ink-extent-ratio')
  paper.style?.removeProperty('--ink-width-extent')
  paper.style?.removeProperty('--ink-page-width')
  paper.style?.removeProperty('--ink-page-height')
  paper.style?.removeProperty('--text-origin-x')
  paper.style?.removeProperty('--text-origin-y')
  paper.closest?.('.paper-sheet-plane')?.style?.removeProperty('--paper-scroll-room')
}
