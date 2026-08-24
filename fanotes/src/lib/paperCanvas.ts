import {
  PAGE_BACKGROUND,
  SCROLL_ROOM,
  growPageFromMark,
  inkOverlaySize,
  pageCanvasLayout,
  type CanvasSize,
} from './noteCanvas'
import { mapClientToPaperPoint, type InkPointerLike, type PaperSurfaceBox } from './inkSampleMap'

/** The write page and its extra scroll room are the same paper. */
export const PAPER_PAGE_BACKGROUND = PAGE_BACKGROUND

export type { CanvasSize }

/**
 * One write page at the origin. Extra scroll room is the same paper, not a
 * dark stage offset from the page.
 */
export const paperCanvasLayout = (page: CanvasSize, room = SCROLL_ROOM) => {
  const layout = pageCanvasLayout(page, room)
  return {
    pad: layout.pad,
    page: layout.page,
    sheet: layout.page,
    scroll: layout.scroll,
  }
}

export const inkOverlayCoversStage = inkOverlaySize
export { markdownInkPageBox } from './noteCanvas'

/** Map a pen sample onto the write page. Samples past an edge grow the page. */
export const mapClientToSheet = (
  event: InkPointerLike,
  sheet: PaperSurfaceBox | null,
  rotation = 0,
) => mapClientToPaperPoint(event, sheet, rotation)

/** Grow the write page around an ink sample in every direction. */
export const growSheetFromInk = (
  normalizedX: number | undefined,
  normalizedY: number | undefined,
  width: number,
  height: number,
) => growPageFromMark({ width, height }, { x: normalizedX, y: normalizedY })
