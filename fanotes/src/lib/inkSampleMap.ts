/** Legacy name kept for drawing-mode needles. Jump is now 0–1 page space. */
export const INK_LEAP_PAGE_RATIO = 0.42
export const INK_JUMP_DY = 0.08
export const INK_JUMP_HYPOT = 0.12
export const INK_FIRST_POINT_RESTART_Y = 0.05

export type PaperSurfaceBox = {
  left: number
  top: number
  width: number
  height: number
  offsetWidth?: number
  offsetHeight?: number
}

export type MappedInkPoint = {
  x: number
  y: number
  t: number
  pressure: number
  tiltX: number
  tiltY: number
  pointerType: string
}

export type InkPointerLike = {
  type?: string
  predicted?: boolean
  clientX?: number
  clientY?: number
  timeStamp?: number
  pressure?: number
  pointerType?: string
  tiltX?: number
  tiltY?: number
}

export const isPreviewOnlyPointerEvent = (event: InkPointerLike | null | undefined) => (
  Boolean(event?.predicted)
)

export const isUsablePointerClient = (event: InkPointerLike | null | undefined) => {
  if (!event) return false
  if (event.type === 'pointercancel' || event.type === 'lostpointercapture') return false
  if (!Number.isFinite(event.clientX) || !Number.isFinite(event.clientY)) return false
  return true
}

/** First gate only: 0,0 / missing surface / unusable. Does not leap-filter. */
export const acceptUsableInkClient = (
  event: InkPointerLike,
  surface: PaperSurfaceBox | null,
  rotation = 0,
) => {
  if (isPreviewOnlyPointerEvent(event) || !isUsablePointerClient(event)) return null
  return mapClientToPaperPoint(event, surface, rotation)
}

export const mapClientToPaperPoint = (
  event: InkPointerLike,
  surface: PaperSurfaceBox | null,
  rotation = 0,
): MappedInkPoint | null => {
  if (!surface || surface.width < 1 || surface.height < 1) return null
  if (!Number.isFinite(event.clientX) || !Number.isFinite(event.clientY)) return null
  // (0,0) is a common missing-coord default. A panned/zoomed sheet can
  // overlap the viewport origin while its corner sits far off-screen —
  // accepting that sample draws a ghost mid-page. Only treat 0,0 as a
  // real contact when the paper corner actually sits at the origin.
  if (event.clientX === 0 && event.clientY === 0) {
    const paperCornerAtOrigin = Math.abs(surface.left) <= 8 && Math.abs(surface.top) <= 8
    // A 0,0 down with no pressure is the usual missing-coord ghost, even when
    // the sheet happens to sit in the viewport corner.
    if (!paperCornerAtOrigin || !((event.pressure ?? 0) > 0)) return null
  }
  const paperW = Math.max(1, surface.offsetWidth ?? surface.width)
  const paperH = Math.max(1, surface.offsetHeight ?? surface.height)
  // Camera slack around the write surface (matches paperGrow.SCROLL_ROOM).
  const hitRoomPx = 560 * (surface.width / paperW)
  const pad = Math.max(48, hitRoomPx)
  if (
    event.clientX! < surface.left - pad
    || event.clientX! > surface.left + surface.width + pad
    || event.clientY! < surface.top - pad
    || event.clientY! > surface.top + surface.height + pad
  ) return null

  const visualX = (event.clientX! - surface.left) / surface.width
  const visualY = (event.clientY! - surface.top) / surface.height
  if (!Number.isFinite(visualX) || !Number.isFinite(visualY)) return null
  const edgeSlop = Math.max(0.04, hitRoomPx / Math.max(1, surface.width))
  if (
    visualX < -edgeSlop
    || visualX > 1 + edgeSlop
    || visualY < -edgeSlop
    || visualY > 1 + edgeSlop
  ) return null

  let paperLocalX = visualX * paperW
  let paperLocalY = visualY * paperH
  if (Math.abs(rotation) > 0.01) {
    const rad = (-rotation * Math.PI) / 180
    const cos = Math.cos(rad)
    const sin = Math.sin(rad)
    const dx = (visualX - 0.5) * paperW
    const dy = (visualY - 0.5) * paperH
    paperLocalX = dx * cos - dy * sin + paperW / 2
    paperLocalY = dx * sin + dy * cos + paperH / 2
  }

  // Keep out-of-range samples so the write surface can grow left/up.
  // Clamping to 0 here drew a ghost line to the top of the sheet.
  const x = paperLocalX / paperW
  const y = paperLocalY / paperH
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null
  const rawPressure = (event.pressure ?? 0) > 0
    ? event.pressure!
    : event.pointerType === 'mouse' ? 0.55 : 0.35
  return {
    x,
    y,
    t: Math.round((event.timeStamp ?? 0) * 100) / 100,
    pressure: Math.round(Math.max(0, Math.min(1, rawPressure)) * 1_000) / 1_000,
    tiltX: event.tiltX ?? 0,
    tiltY: event.tiltY ?? 0,
    pointerType: event.pointerType || 'mouse',
  }
}

export const isInkCorridorLeap = (
  previous: { x: number; y: number } | null | undefined,
  next: { x: number; y: number },
  _sourceWidth = 1,
  _sourceHeight = 1,
) => {
  if (!previous) return false
  if (previous.y >= INK_FIRST_POINT_RESTART_Y && next.y < INK_FIRST_POINT_RESTART_Y) return true
  // Right-half writing: a sample slammed into the top band is a leap even
  // when dy is just under INK_JUMP_DY (short strokes near y≈0.08).
  if (previous.x >= 0.5 && next.x >= 0.45 && next.y < INK_FIRST_POINT_RESTART_Y && previous.y >= 0.08) return true
  const dy = Math.abs(next.y - previous.y)
  return dy > INK_JUMP_DY || Math.hypot(next.x - previous.x, next.y - previous.y) > INK_JUMP_HYPOT
}

export const classifyInkJumpAppend = (
  previous: { x: number; y: number } | null | undefined,
  next: { x: number; y: number },
  existingCount: number,
) => {
  if (!previous || existingCount <= 0) return 'start' as const
  if (!isInkCorridorLeap(previous, next)) return 'append' as const
  if (existingCount === 1 && previous.y < INK_FIRST_POINT_RESTART_Y) return 'restart' as const
  return 'skip' as const
}

export const resolveInkJumpAppend = (
  points: MappedInkPoint[],
  next: MappedInkPoint,
) => {
  const action = classifyInkJumpAppend(points.at(-1) ?? null, next, points.length)
  if (action === 'start' || action === 'append') points.push(next)
  else if (action === 'restart') points.splice(0, 1, next)
  return { action, points }
}

/** A ghost 0,0 / unusable down must not become a point, but later samples may still start the stroke. */
export const resolveInkPointerDown = (
  event: InkPointerLike,
  surface: PaperSurfaceBox | null,
  rotation = 0,
) => {
  if (event.type === 'pointercancel' || event.type === 'lostpointercapture') {
    return { firstPoint: null, openStroke: false, commitFirst: false }
  }
  const firstPoint = acceptCommittedInkSample(event, surface, null, 1, 1, rotation)
  return {
    firstPoint,
    openStroke: true,
    commitFirst: firstPoint !== null,
  }
}

export const acceptCommittedInkSample = (
  event: InkPointerLike,
  surface: PaperSurfaceBox | null,
  previous: { x: number; y: number } | null,
  sourceWidth: number,
  sourceHeight: number,
  rotation = 0,
): MappedInkPoint | null => {
  const next = acceptNextCommittedInkSample(event, surface, previous, previous ? 2 : 0, sourceWidth, sourceHeight, rotation)
  return next.point
}

/** Like accept, but a lone ghost at y≈0 may be replaced by the next in-band sample. */
export const acceptNextCommittedInkSample = (
  event: InkPointerLike,
  surface: PaperSurfaceBox | null,
  previous: { x: number; y: number } | null,
  existingCount: number,
  sourceWidth: number,
  sourceHeight: number,
  rotation = 0,
) => {
  if (isPreviewOnlyPointerEvent(event) || !isUsablePointerClient(event)) {
    return { point: null, action: 'skip' as const }
  }
  const mapped = mapClientToPaperPoint(event, surface, rotation)
  if (!mapped) return { point: null, action: 'skip' as const }
  const action = classifyInkJumpAppend(previous, mapped, existingCount)
  if (action === 'skip') return { point: null, action }
  return { point: mapped, action }
}

export const appendAcceptedInkPoint = (
  points: MappedInkPoint[],
  event: InkPointerLike,
  surface: PaperSurfaceBox | null,
  sourceWidth: number,
  sourceHeight: number,
  rotation = 0,
) => {
  if (isPreviewOnlyPointerEvent(event) || !isUsablePointerClient(event)) return points
  const mapped = mapClientToPaperPoint(event, surface, rotation)
  if (!mapped) return points
  resolveInkJumpAppend(points, mapped)
  return points
}

/** Predicted extras must use the same leap/0,0 rules as committed samples. */
export const collectPreviewInkPoints = (
  committed: Array<{ x: number; y: number }>,
  predicted: Array<{ x: number; y: number } | null | undefined>,
) => {
  const extra: Array<{ x: number; y: number }> = []
  let previous = committed.at(-1) ?? null
  for (const next of predicted) {
    if (!next || !Number.isFinite(next.x) || !Number.isFinite(next.y)) continue
    if (isInkCorridorLeap(previous, next)) continue
    extra.push(next)
    previous = next
  }
  return extra
}

/** Drive a down + move sequence through the shipped accept/leap path. */
export const commitInkPointerSequence = (
  events: InkPointerLike[],
  surface: PaperSurfaceBox | null,
  sourceWidth: number,
  sourceHeight: number,
  rotation = 0,
) => {
  const points: MappedInkPoint[] = []
  for (const event of events) {
    if (points.length === 0) {
      const start = resolveInkPointerDown(event, surface, rotation)
      if (start.commitFirst && start.firstPoint) resolveInkJumpAppend(points, start.firstPoint)
      continue
    }
    appendAcceptedInkPoint(points, event, surface, sourceWidth, sourceHeight, rotation)
  }
  return points
}
