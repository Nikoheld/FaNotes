import { SCROLL_ROOM } from './paperGrow'

export const PAPER_DOT_TILE_PX = 28

export type RulingBox = {
  x: number
  y: number
  width: number
  height: number
}

export type RulingPoint = {
  x: number
  y: number
}

/** Dots live on the Blatt, not in the dark left/top stage. */
export const paperRulingFillBox = (sheet: RulingBox, _plane: RulingBox): RulingBox => ({
  x: sheet.x,
  y: sheet.y,
  width: sheet.width,
  height: sheet.height,
})

export const paperRulingStaysOnSheet = (fill: RulingBox, sheet: RulingBox) => (
  fill.x >= sheet.x - 0.5
  && fill.y >= sheet.y - 0.5
  && fill.x + fill.width <= sheet.x + sheet.width + 0.5
  && fill.y + fill.height <= sheet.y + sheet.height + 0.5
)

export const paperRulingCoversCameraSides = (
  fill: RulingBox,
  sheet: RulingBox,
  plane: RulingBox,
) => {
  const coversPlane = (
    fill.x <= plane.x
    && fill.y <= plane.y
    && fill.x + fill.width >= plane.x + plane.width
    && fill.y + fill.height >= plane.y + plane.height
  )
  const left = fill.x <= plane.x && sheet.x > plane.x
  const top = fill.y <= plane.y && sheet.y > plane.y
  const right = fill.x + fill.width >= plane.x + plane.width && sheet.x + sheet.width < plane.x + plane.width
  const bottom = fill.y + fill.height >= plane.y + plane.height && sheet.y + sheet.height < plane.y + plane.height
  return coversPlane && left && top && right && bottom
}

export const paperRulingTileOrigin = (plane: RulingBox) => ({
  x: plane.x,
  y: plane.y,
})

export const paperRulingPhase = (
  x: number,
  y: number,
  tile = PAPER_DOT_TILE_PX,
  originX = 0,
  originY = 0,
) => {
  const span = tile > 0 ? tile : PAPER_DOT_TILE_PX
  const u = ((x - originX) % span + span) % span
  const v = ((y - originY) % span + span) % span
  return { u, v }
}

export const paperRulingContinuousGrid = (
  sheetPoint: RulingPoint,
  sidePoint: RulingPoint,
  origin: RulingPoint,
  tile = PAPER_DOT_TILE_PX,
) => {
  const a = paperRulingPhase(sheetPoint.x, sheetPoint.y, tile, origin.x, origin.y)
  const b = paperRulingPhase(sidePoint.x, sidePoint.y, tile, origin.x, origin.y)
  const expectU = ((a.u + (sidePoint.x - sheetPoint.x)) % tile + tile) % tile
  const expectV = ((a.v + (sidePoint.y - sheetPoint.y)) % tile + tile) % tile
  return Math.abs(expectU - b.u) < 1e-6 && Math.abs(expectV - b.v) < 1e-6
}

export const paperRulingSameLattice = (
  originA: RulingPoint,
  originB: RulingPoint,
  tile = PAPER_DOT_TILE_PX,
) => {
  const span = tile > 0 ? tile : PAPER_DOT_TILE_PX
  const rx = ((originA.x - originB.x) % span + span) % span
  const ry = ((originA.y - originB.y) % span + span) % span
  return rx < 1e-6 && ry < 1e-6
}

export const paperRulingDoublePaint = (
  planeFill: RulingBox | null | undefined,
  sheetFill: RulingBox | null | undefined,
) => {
  if (!planeFill || !sheetFill) return false
  const width = Math.min(planeFill.x + planeFill.width, sheetFill.x + sheetFill.width) - Math.max(planeFill.x, sheetFill.x)
  const height = Math.min(planeFill.y + planeFill.height, sheetFill.y + sheetFill.height) - Math.max(planeFill.y, sheetFill.y)
  return width > 0 && height > 0
}

export const paperCameraSheetLayout = (
  planeWidth: number,
  planeHeight: number,
  sheetWidth: number,
  sheetHeight: number,
  room = SCROLL_ROOM,
) => {
  const plane = { x: 0, y: 0, width: planeWidth, height: planeHeight }
  const pad = Math.max(0, room)
  const sheet = {
    x: pad,
    y: pad,
    width: Math.max(1, planeWidth - pad * 2),
    height: Math.max(1, planeHeight - pad * 2),
  }
  const text = {
    x: sheet.x,
    y: sheet.y,
    width: Math.max(1, Math.min(sheetWidth, sheet.width)),
    height: Math.max(1, Math.min(sheetHeight, sheet.height) || sheet.height),
  }
  const fill = paperRulingFillBox(sheet, plane)
  const origin = paperRulingTileOrigin(sheet)
  return { plane, sheet, fill, origin, room: pad, tile: PAPER_DOT_TILE_PX, text }
}
