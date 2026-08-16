export const INK_LEAP_PAGE_RATIO = 0.42

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

export const mapClientToPaperPoint = (
  event: InkPointerLike,
  surface: PaperSurfaceBox | null,
  rotation = 0,
): MappedInkPoint | null => {
  if (!surface || surface.width < 1 || surface.height < 1) return null
  if (!Number.isFinite(event.clientX) || !Number.isFinite(event.clientY)) return null
  // (0,0) is a common missing-coord default. Only accept it when the paper
  // actually sits on that viewport corner.
  if (event.clientX === 0 && event.clientY === 0) {
    const coversOrigin = surface.left <= 8 && surface.top <= 8
      && surface.left + surface.width >= 0
      && surface.top + surface.height >= 0
    if (!coversOrigin) return null
  }
  const pad = Math.max(48, Math.max(surface.width, surface.height) * 0.2)
  if (
    event.clientX! < surface.left - pad
    || event.clientX! > surface.left + surface.width + pad
    || event.clientY! < surface.top - pad
    || event.clientY! > surface.top + surface.height + pad
  ) return null

  const paperW = Math.max(1, surface.offsetWidth ?? surface.width)
  const paperH = Math.max(1, surface.offsetHeight ?? surface.height)
  const visualX = (event.clientX! - surface.left) / surface.width
  const visualY = (event.clientY! - surface.top) / surface.height
  if (!Number.isFinite(visualX) || !Number.isFinite(visualY)) return null
  // Far outside the sheet would clamp to a corner and draw a ghost line.
  const edgeSlop = 0.04
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

  const x = Math.max(0, Math.min(1, paperLocalX / paperW))
  const y = Math.max(0, Math.min(1, paperLocalY / paperH))
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
  sourceWidth: number,
  sourceHeight: number,
) => {
  if (!previous) return false
  const distance = Math.hypot(
    (next.x - previous.x) * sourceWidth,
    (next.y - previous.y) * sourceHeight,
  )
  return distance > Math.max(sourceWidth, sourceHeight) * INK_LEAP_PAGE_RATIO
}

export const acceptCommittedInkSample = (
  event: InkPointerLike,
  surface: PaperSurfaceBox | null,
  previous: { x: number; y: number } | null,
  sourceWidth: number,
  sourceHeight: number,
  rotation = 0,
): MappedInkPoint | null => {
  if (isPreviewOnlyPointerEvent(event)) return null
  if (!isUsablePointerClient(event)) return null
  const mapped = mapClientToPaperPoint(event, surface, rotation)
  if (!mapped) return null
  if (isInkCorridorLeap(previous, mapped, sourceWidth, sourceHeight)) return null
  return mapped
}

export const appendAcceptedInkPoint = (
  points: MappedInkPoint[],
  event: InkPointerLike,
  surface: PaperSurfaceBox | null,
  sourceWidth: number,
  sourceHeight: number,
  rotation = 0,
) => {
  const accepted = acceptCommittedInkSample(
    event,
    surface,
    points.at(-1) ?? null,
    sourceWidth,
    sourceHeight,
    rotation,
  )
  if (accepted) points.push(accepted)
  return points
}
