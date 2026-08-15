/** A4 width in millimetres. The original paper column (900 source px) is 210 mm. */
export const A4_WIDTH_MM = 210
export const SOURCE_A4_PX = 900
export const RULER_LENGTH_MM = 160
export const RULER_HEIGHT_MM = 26
export const SET_SQUARE_LEG_MM = 140
export const SNAP_MM = 3.2
export const COMPASS_MIN_RADIUS_MM = 6
export const COMPASS_MAX_RADIUS_MM = 140
export const COMPASS_DEFAULT_RADIUS_MM = 35

export type DraftingKind = 'ruler' | 'setSquare' | 'compass'

export type DraftingPose = {
  x: number
  y: number
  rotation: number
  radiusMm?: number
  locked?: boolean
}

export type CompassPose = DraftingPose & {
  radiusMm: number
}

export type DraftingEdge = {
  ax: number
  ay: number
  bx: number
  by: number
}

export const mmToSourcePx = (mm: number) => mm * SOURCE_A4_PX / A4_WIDTH_MM

export const mmToNorm = (mm: number, sourceSize: number) => mmToSourcePx(mm) / Math.max(1, sourceSize)

export const defaultRulerPose = (): DraftingPose => ({ x: 0.5, y: 0.22, rotation: 0 })

export const defaultSetSquarePose = (): DraftingPose => ({ x: 0.38, y: 0.42, rotation: 0 })

export const defaultCompassPose = (): CompassPose => ({
  x: 0.44,
  y: 0.36,
  rotation: -Math.PI / 5,
  radiusMm: COMPASS_DEFAULT_RADIUS_MM,
  locked: false,
})

export const clampCompassRadius = (mm: number) => (
  Math.min(COMPASS_MAX_RADIUS_MM, Math.max(COMPASS_MIN_RADIUS_MM, mm))
)

export const asCompassPose = (pose: DraftingPose): CompassPose => ({
  x: pose.x,
  y: pose.y,
  rotation: pose.rotation,
  radiusMm: clampCompassRadius(pose.radiusMm ?? COMPASS_DEFAULT_RADIUS_MM),
  locked: Boolean(pose.locked),
})

export const compassRadiiNorm = (radiusMm: number, sourceWidth: number, sourceHeight: number) => ({
  rx: mmToNorm(radiusMm, sourceWidth),
  ry: mmToNorm(radiusMm, sourceHeight),
})

export const compassPencilPoint = (pose: CompassPose, sourceWidth: number, sourceHeight: number) => {
  const { rx, ry } = compassRadiiNorm(pose.radiusMm, sourceWidth, sourceHeight)
  return {
    x: pose.x + Math.cos(pose.rotation) * rx,
    y: pose.y + Math.sin(pose.rotation) * ry,
  }
}

export const radiusMmBetween = (
  ax: number,
  ay: number,
  bx: number,
  by: number,
  sourceWidth: number,
  sourceHeight: number,
) => {
  const dxMm = (bx - ax) * sourceWidth * A4_WIDTH_MM / SOURCE_A4_PX
  const dyMm = (by - ay) * sourceHeight * A4_WIDTH_MM / SOURCE_A4_PX
  return Math.hypot(dxMm, dyMm)
}

export const angleToPoint = (
  originX: number,
  originY: number,
  x: number,
  y: number,
  sourceWidth: number,
  sourceHeight: number,
) => Math.atan2((y - originY) * sourceHeight, (x - originX) * sourceWidth)

export const snapRadiusMm = (mm: number) => {
  const rounded = Math.round(mm)
  return Math.abs(mm - rounded) < 0.35 ? rounded : mm
}

export const shortestAngleDelta = (from: number, to: number) => {
  let delta = to - from
  while (delta > Math.PI) delta -= Math.PI * 2
  while (delta < -Math.PI) delta += Math.PI * 2
  return delta
}

export type CompassSample = { x: number; y: number }

export const sampleCompassArc = (
  pose: CompassPose,
  fromAngle: number,
  toAngle: number,
  sourceWidth: number,
  sourceHeight: number,
  stepRad = 0.035,
): CompassSample[] => {
  const { rx, ry } = compassRadiiNorm(pose.radiusMm, sourceWidth, sourceHeight)
  const delta = toAngle - fromAngle
  if (Math.abs(delta) < 1e-8) {
    return [{
      x: pose.x + Math.cos(toAngle) * rx,
      y: pose.y + Math.sin(toAngle) * ry,
    }]
  }
  const steps = Math.max(1, Math.ceil(Math.abs(delta) / stepRad))
  const points: CompassSample[] = []
  for (let index = 1; index <= steps; index += 1) {
    const angle = fromAngle + delta * (index / steps)
    points.push({
      x: pose.x + Math.cos(angle) * rx,
      y: pose.y + Math.sin(angle) * ry,
    })
  }
  return points
}

export const sampleCompassCircle = (
  pose: CompassPose,
  sourceWidth: number,
  sourceHeight: number,
): CompassSample[] => {
  const points = sampleCompassArc(
    pose,
    pose.rotation,
    pose.rotation + Math.PI * 2,
    sourceWidth,
    sourceHeight,
    0.028,
  )
  const first = points[0]
  if (first) points.push({ x: first.x, y: first.y })
  return points
}

export type CompassDrawEvent =
  | { type: 'begin'; pose: CompassPose }
  | { type: 'append'; pose: CompassPose; fromAngle: number; toAngle: number }
  | { type: 'commit'; pose: CompassPose }
  | { type: 'cancel' }
  | { type: 'circle'; pose: CompassPose }

const rotateAround = (x: number, y: number, cx: number, cy: number, rotation: number) => {
  const dx = x - cx
  const dy = y - cy
  const cos = Math.cos(rotation)
  const sin = Math.sin(rotation)
  return { x: cx + dx * cos - dy * sin, y: cy + dx * sin + dy * cos }
}

const localToNorm = (
  localX: number,
  localY: number,
  pose: DraftingPose,
  sourceWidth: number,
  sourceHeight: number,
) => rotateAround(
  pose.x + mmToNorm(localX, sourceWidth),
  pose.y + mmToNorm(localY, sourceHeight),
  pose.x,
  pose.y,
  pose.rotation,
)

const normToLocalMm = (
  x: number,
  y: number,
  pose: DraftingPose,
  sourceWidth: number,
  sourceHeight: number,
) => {
  const unrotated = rotateAround(x, y, pose.x, pose.y, -pose.rotation)
  return {
    x: (unrotated.x - pose.x) * sourceWidth * A4_WIDTH_MM / SOURCE_A4_PX,
    y: (unrotated.y - pose.y) * sourceHeight * A4_WIDTH_MM / SOURCE_A4_PX,
  }
}

const pointInsideRuler = (
  x: number,
  y: number,
  pose: DraftingPose,
  sourceWidth: number,
  sourceHeight: number,
) => {
  const local = normToLocalMm(x, y, pose, sourceWidth, sourceHeight)
  const half = RULER_LENGTH_MM / 2
  const top = -RULER_HEIGHT_MM / 2
  const bottom = RULER_HEIGHT_MM / 2
  return local.x >= -half && local.x <= half && local.y >= top - 0.6 && local.y <= bottom
}

const pointInsideSetSquare = (
  x: number,
  y: number,
  pose: DraftingPose,
  sourceWidth: number,
  sourceHeight: number,
) => {
  const local = normToLocalMm(x, y, pose, sourceWidth, sourceHeight)
  const pad = 0.8
  return local.x >= -pad && local.y <= pad && (local.x - local.y) <= SET_SQUARE_LEG_MM + pad
}

export const rulerDrawingEdges = (pose: DraftingPose, sourceWidth: number, sourceHeight: number): DraftingEdge[] => {
  const half = RULER_LENGTH_MM / 2
  const top = -RULER_HEIGHT_MM / 2
  const a = localToNorm(-half, top, pose, sourceWidth, sourceHeight)
  const b = localToNorm(half, top, pose, sourceWidth, sourceHeight)
  return [{ ax: a.x, ay: a.y, bx: b.x, by: b.y }]
}

export const setSquareDrawingEdges = (pose: DraftingPose, sourceWidth: number, sourceHeight: number): DraftingEdge[] => {
  const leg = SET_SQUARE_LEG_MM
  const right = localToNorm(0, 0, pose, sourceWidth, sourceHeight)
  const bottom = localToNorm(leg, 0, pose, sourceWidth, sourceHeight)
  const top = localToNorm(0, -leg, pose, sourceWidth, sourceHeight)
  return [
    { ax: right.x, ay: right.y, bx: bottom.x, by: bottom.y },
    { ax: right.x, ay: right.y, bx: top.x, by: top.y },
    { ax: bottom.x, ay: bottom.y, bx: top.x, by: top.y },
  ]
}

export const draftingEdges = (
  kind: DraftingKind,
  pose: DraftingPose,
  sourceWidth: number,
  sourceHeight: number,
) => {
  if (kind === 'compass') return []
  return (kind === 'ruler' ? rulerDrawingEdges : setSquareDrawingEdges)(pose, sourceWidth, sourceHeight)
}

const projectOnCompass = (
  x: number,
  y: number,
  pose: CompassPose,
  sourceWidth: number,
  sourceHeight: number,
  force: boolean,
): SnapResult | null => {
  const { rx, ry } = compassRadiiNorm(pose.radiusMm, sourceWidth, sourceHeight)
  if (rx < 1e-6 || ry < 1e-6) return null
  const distMm = radiusMmBetween(pose.x, pose.y, x, y, sourceWidth, sourceHeight)
  if (!force && Math.abs(distMm - pose.radiusMm) > SNAP_MM) return null
  const angle = angleToPoint(pose.x, pose.y, x, y, sourceWidth, sourceHeight)
  return {
    x: pose.x + Math.cos(angle) * rx,
    y: pose.y + Math.sin(angle) * ry,
    kind: 'compass',
    edgeIndex: 0,
    millimetres: pose.radiusMm,
  }
}

const projectOnEdge = (x: number, y: number, edge: DraftingEdge) => {
  const vx = edge.bx - edge.ax
  const vy = edge.by - edge.ay
  const length2 = vx * vx + vy * vy
  if (length2 < 1e-12) return { x: edge.ax, y: edge.ay, t: 0, distance: Math.hypot(x - edge.ax, y - edge.ay) }
  const t = Math.max(0, Math.min(1, ((x - edge.ax) * vx + (y - edge.ay) * vy) / length2))
  const px = edge.ax + t * vx
  const py = edge.ay + t * vy
  return { x: px, y: py, t, distance: Math.hypot(x - px, y - py) }
}

export type SnapResult = {
  x: number
  y: number
  kind: DraftingKind
  edgeIndex: number
  millimetres: number
}

const nearestOnEdges = (
  x: number,
  y: number,
  kind: DraftingKind,
  edges: DraftingEdge[],
  sourceWidth: number,
  threshold: number,
): SnapResult | null => {
  let best: SnapResult | null = null
  edges.forEach((edge, edgeIndex) => {
    const projected = projectOnEdge(x, y, edge)
    if (projected.distance > threshold) return
    const millimetres = projected.t * Math.hypot(edge.bx - edge.ax, edge.by - edge.ay) * sourceWidth * A4_WIDTH_MM / SOURCE_A4_PX
    const candidate = { x: projected.x, y: projected.y, kind, edgeIndex, millimetres }
    if (!best || projected.distance < Math.hypot(x - best.x, y - best.y)) best = candidate
  })
  return best
}

export const snapToDraftingTools = (
  x: number,
  y: number,
  tools: Array<{ kind: DraftingKind; pose: DraftingPose }>,
  sourceWidth: number,
  sourceHeight: number,
  locked?: { kind: DraftingKind; edgeIndex: number } | null,
): SnapResult | null => {
  if (locked) {
    const tool = tools.find((item) => item.kind === locked.kind)
    if (tool) {
      if (tool.kind === 'compass') {
        return projectOnCompass(x, y, asCompassPose(tool.pose), sourceWidth, sourceHeight, true)
      }
      const edges = draftingEdges(tool.kind, tool.pose, sourceWidth, sourceHeight)
      const edge = edges[locked.edgeIndex]
      if (edge) {
        const projected = projectOnEdge(x, y, edge)
        const millimetres = projected.t * Math.hypot(edge.bx - edge.ax, edge.by - edge.ay) * sourceWidth * A4_WIDTH_MM / SOURCE_A4_PX
        return { x: projected.x, y: projected.y, kind: tool.kind, edgeIndex: locked.edgeIndex, millimetres }
      }
    }
  }
  let best: SnapResult | null = null
  const edgeThreshold = mmToNorm(SNAP_MM, sourceWidth)
  for (const tool of tools) {
    if (tool.kind === 'compass') {
      const candidate = projectOnCompass(x, y, asCompassPose(tool.pose), sourceWidth, sourceHeight, false)
      if (!candidate) continue
      if (!best || Math.hypot(x - candidate.x, y - candidate.y) < Math.hypot(x - best.x, y - best.y)) best = candidate
      continue
    }
    const edges = draftingEdges(tool.kind, tool.pose, sourceWidth, sourceHeight)
    const inside = tool.kind === 'ruler'
      ? pointInsideRuler(x, y, tool.pose, sourceWidth, sourceHeight)
      : pointInsideSetSquare(x, y, tool.pose, sourceWidth, sourceHeight)
    const candidate = nearestOnEdges(x, y, tool.kind, edges, sourceWidth, inside ? Number.POSITIVE_INFINITY : edgeThreshold)
    if (!candidate) continue
    if (!best || Math.hypot(x - candidate.x, y - candidate.y) < Math.hypot(x - best.x, y - best.y)) best = candidate
  }
  return best
}

export const formatMillimetres = (mm: number) => {
  if (mm >= 10) return `${(mm / 10).toFixed(1).replace('.', ',')} cm`
  return `${Math.round(mm)} mm`
}

export const formatDegrees = (radians: number) => {
  const degrees = ((radians * 180 / Math.PI) % 360 + 360) % 360
  const folded = degrees > 180 ? 360 - degrees : degrees
  return `${folded.toFixed(0)}°`
}

export const formatArcDegrees = (radians: number) => {
  const degrees = Math.abs(radians) * 180 / Math.PI
  if (degrees >= 359.2) return '360°'
  return `${degrees.toFixed(0)}°`
}

export const draftingToolLabel = (kind: DraftingKind) => {
  if (kind === 'ruler') return 'Lineal'
  if (kind === 'setSquare') return 'Geodreieck'
  return 'Zirkel'
}
