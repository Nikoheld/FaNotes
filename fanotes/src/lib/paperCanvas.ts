import {
  PAGE_GROW_STEP_HEIGHT,
  PAGE_GROW_STEP_WIDTH,
  SCROLL_ROOM,
  WRITE_SLACK_HEIGHT,
  WRITE_SLACK_WIDTH,
  neededWriteExtent,
  neededWriteMinPad,
} from './paperGrow'
import { mapClientToPaperPoint, type InkPointerLike, type PaperSurfaceBox } from './inkSampleMap'

/** Dark stage beyond the Blatt — not dotted paper. */
export const PAPER_STAGE_BACKGROUND = '#111'

export type CanvasSize = { width: number; height: number }

const finiteSize = (value: number) => Number.isFinite(value) && value > 0 ? value : 0

/**
 * One canvas: the Blatt is the write surface (origin 0,0). Camera room around
 * it is empty dark stage. Overlay hits the stage; paint stays on the Blatt.
 */
export const paperCanvasLayout = (sheet: CanvasSize, room = SCROLL_ROOM) => {
  const pad = Math.max(0, Number.isFinite(room) ? room : 0)
  const sheetW = Math.max(1, finiteSize(sheet.width) || 1)
  const sheetH = Math.max(1, finiteSize(sheet.height) || 1)
  return {
    pad,
    sheet: { x: pad, y: pad, width: sheetW, height: sheetH },
    stage: { x: 0, y: 0, width: sheetW + pad * 2, height: sheetH + pad * 2 },
  }
}

/**
 * Hit overlay must cover Blatt + dark stage. A 0×0 Blatt-only overlay is the
 * Linux “no line” path — fall back to the plane, then to stage from the Blatt.
 */
export const inkOverlayCoversStage = (
  overlay: CanvasSize,
  paper: CanvasSize,
  plane: CanvasSize = { width: 0, height: 0 },
) => {
  const overlayW = finiteSize(overlay.width)
  const overlayH = finiteSize(overlay.height)
  const paperW = finiteSize(paper.width)
  const paperH = finiteSize(paper.height)
  const planeW = finiteSize(plane.width)
  const planeH = finiteSize(plane.height)
  const layout = paperW > 8 && paperH > 8
    ? paperCanvasLayout({ width: paperW, height: paperH })
    : null
  if (layout && overlayW >= layout.stage.width - 1 && overlayH >= layout.stage.height - 1 && overlayW >= 8 && overlayH >= 8) {
    return { width: overlayW, height: overlayH }
  }
  if (planeW >= 8 && planeH >= 8) return { width: planeW, height: planeH }
  if (layout) return { width: layout.stage.width, height: layout.stage.height }
  if (overlayW >= 8 && overlayH >= 8) return { width: overlayW, height: overlayH }
  return { width: 0, height: 0 }
}

/** Map a pen sample onto the Blatt. Past the left/top edge is stage, not paper. */
export const mapClientToSheet = (
  event: InkPointerLike,
  sheet: PaperSurfaceBox | null,
  rotation = 0,
) => {
  const mapped = mapClientToPaperPoint(event, sheet, rotation)
  if (!mapped) return null
  if (mapped.x < 0 || mapped.y < 0) return null
  return mapped
}

/** Grow only right/down. Left/top pad stays 0. */
export const growSheetFromInk = (
  normalizedX: number | undefined,
  normalizedY: number | undefined,
  width: number,
  height: number,
) => ({
  width: neededWriteExtent(normalizedX, width, WRITE_SLACK_WIDTH, PAGE_GROW_STEP_WIDTH),
  height: neededWriteExtent(normalizedY, height, WRITE_SLACK_HEIGHT, PAGE_GROW_STEP_HEIGHT),
  padX: neededWriteMinPad(normalizedX, width, WRITE_SLACK_WIDTH, PAGE_GROW_STEP_WIDTH),
  padY: neededWriteMinPad(normalizedY, height, WRITE_SLACK_HEIGHT, PAGE_GROW_STEP_HEIGHT),
})
