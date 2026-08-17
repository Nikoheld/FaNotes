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

export const remapNormalizedAfterGrow = (
  point: { x: number; y: number },
  prevWidth: number,
  nextWidth: number,
  prevHeight: number,
  nextHeight: number,
) => ({
  x: nextWidth === prevWidth ? point.x : point.x * prevWidth / nextWidth,
  y: nextHeight === prevHeight ? point.y : point.y * prevHeight / nextHeight,
})

export const growLiveInkAndMapNext = (
  lastPoint: MappedInkPoint,
  prevHeight: number,
  nextHeight: number,
  event: InkPointerLike,
  surfaceAfterLayout: PaperSurfaceBox | null,
  rotation = 0,
) => {
  const last = {
    ...lastPoint,
    ...remapNormalizedAfterGrow(lastPoint, 1, 1, prevHeight, nextHeight),
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
  const needed = normalized * current + slack
  if (needed <= current) return current
  return Math.max(current, Math.ceil(needed / step) * step)
}
