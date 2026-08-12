import type { StrokePoint } from '../../../src/types'

export type SnappableStroke = {
  points: StrokePoint[]
  baseWidth: number
  pressureEnabled: boolean
  color: string
  purpose?: 'handwriting' | 'art'
  brush?: string
  colorEffect?: string
  opacity?: number
  textureSeed?: number
  symbolId?: string
  symbolRotation?: number
}

export type ShapeSnapKind = 'line' | 'circle'

export type ShapeSnapResult = {
  kind: ShapeSnapKind
  stroke: SnappableStroke
  confidence: number
}

const clamp01 = (value: number) => Math.min(1, Math.max(0, value))

const physical = (points: StrokePoint[], sourceWidth: number, sourceHeight: number) => (
  points.map((point) => ({
    x: point.x * sourceWidth,
    y: point.y * sourceHeight,
    t: point.t,
    pressure: point.pressure,
    tiltX: point.tiltX,
    tiltY: point.tiltY,
    pointerType: point.pointerType,
  }))
)

const pathLength = (pts: { x: number; y: number }[]) => {
  let length = 0
  for (let index = 1; index < pts.length; index += 1) {
    length += Math.hypot(pts[index].x - pts[index - 1].x, pts[index].y - pts[index - 1].y)
  }
  return length
}

const sampleLine = (
  start: { x: number; y: number; t: number; pressure: number; tiltX: number; tiltY: number; pointerType: string },
  end: { x: number; y: number; t: number; pressure: number; tiltX: number; tiltY: number; pointerType: string },
  sourceWidth: number,
  sourceHeight: number,
  samples = 24,
): StrokePoint[] => {
  const points: StrokePoint[] = []
  for (let index = 0; index < samples; index += 1) {
    const t = index / (samples - 1)
    points.push({
      x: clamp01((start.x + (end.x - start.x) * t) / sourceWidth),
      y: clamp01((start.y + (end.y - start.y) * t) / sourceHeight),
      t: start.t + (end.t - start.t) * t,
      pressure: start.pressure * (1 - t) + end.pressure * t,
      tiltX: start.tiltX * (1 - t) + end.tiltX * t,
      tiltY: start.tiltY * (1 - t) + end.tiltY * t,
      pointerType: end.pointerType || start.pointerType || 'pen',
    })
  }
  return points
}

const sampleCircle = (
  cx: number,
  cy: number,
  radius: number,
  startAngle: number,
  endAngle: number,
  closed: boolean,
  template: { t: number; pressure: number; tiltX: number; tiltY: number; pointerType: string },
  sourceWidth: number,
  sourceHeight: number,
  samples = 48,
): StrokePoint[] => {
  const points: StrokePoint[] = []
  let span = endAngle - startAngle
  while (span <= 0) span += Math.PI * 2
  if (closed || span > Math.PI * 1.65) span = Math.PI * 2
  const count = closed || span >= Math.PI * 1.9 ? samples : Math.max(16, Math.round(samples * (span / (Math.PI * 2))))
  for (let index = 0; index <= count; index += 1) {
    const t = index / count
    const angle = startAngle + span * t
    points.push({
      x: clamp01((cx + Math.cos(angle) * radius) / sourceWidth),
      y: clamp01((cy + Math.sin(angle) * radius) / sourceHeight),
      t: template.t + t,
      pressure: template.pressure,
      tiltX: template.tiltX,
      tiltY: template.tiltY,
      pointerType: template.pointerType || 'pen',
    })
  }
  return points
}

/**
 * Detects a near-line or near-circle freehand stroke and returns a geometrically
 * cleaned replacement (normalized 0–1 coordinates). Returns null if no strong match.
 */
export const snapStrokeToShape = (
  stroke: SnappableStroke,
  sourceWidth: number,
  sourceHeight: number,
): ShapeSnapResult | null => {
  if (stroke.symbolId) return null
  if (!stroke.points.length || stroke.points.length < 10) return null
  const pts = physical(stroke.points, sourceWidth, sourceHeight)
  const length = pathLength(pts)
  if (length < 28) return null

  const start = pts[0]
  const end = pts[pts.length - 1]
  const chord = Math.hypot(end.x - start.x, end.y - start.y)

  // --- Line ---
  let maxLineDev = 0
  let sumLineDev = 0
  if (chord > 1e-3) {
    const nx = (end.x - start.x) / chord
    const ny = (end.y - start.y) / chord
    for (const point of pts) {
      const dx = point.x - start.x
      const dy = point.y - start.y
      const along = dx * nx + dy * ny
      const px = start.x + nx * along
      const py = start.y + ny * along
      const dev = Math.hypot(point.x - px, point.y - py)
      maxLineDev = Math.max(maxLineDev, dev)
      sumLineDev += dev
    }
  }
  const meanLineDev = sumLineDev / pts.length
  const lineRatio = chord / Math.max(1, length)
  const lineScore = chord >= 36 && lineRatio >= 0.86 && maxLineDev <= Math.max(7, chord * 0.075)
    ? clamp01(1 - meanLineDev / Math.max(6, chord * 0.08)) * lineRatio
    : 0

  // --- Circle ---
  let cx = 0
  let cy = 0
  for (const point of pts) {
    cx += point.x
    cy += point.y
  }
  cx /= pts.length
  cy /= pts.length
  const radii = pts.map((point) => Math.hypot(point.x - cx, point.y - cy))
  const meanR = radii.reduce((sum, value) => sum + value, 0) / radii.length
  let radiusVariance = 0
  for (const radius of radii) radiusVariance += (radius - meanR) ** 2
  radiusVariance /= radii.length
  const radiusStd = Math.sqrt(radiusVariance)
  const closedGap = Math.hypot(end.x - start.x, end.y - start.y)
  const closed = closedGap <= Math.max(14, meanR * 0.45)
  // Angular coverage
  const angles = pts.map((point) => Math.atan2(point.y - cy, point.x - cx))
  let covered = 0
  if (angles.length > 1) {
    const sorted = [...angles].sort((a, b) => a - b)
    let maxGap = 0
    for (let index = 1; index < sorted.length; index += 1) {
      maxGap = Math.max(maxGap, sorted[index] - sorted[index - 1])
    }
    maxGap = Math.max(maxGap, (sorted[0] + Math.PI * 2) - sorted[sorted.length - 1])
    covered = Math.max(0, 1 - maxGap / (Math.PI * 2))
  }
  const circleScore = meanR >= 16
    && radiusStd / meanR <= 0.18
    && length >= meanR * Math.PI * 0.85
    && (closed || covered >= 0.72)
    ? clamp01(1 - (radiusStd / meanR) / 0.18) * clamp01(0.55 + covered * 0.45)
    : 0

  if (lineScore < 0.62 && circleScore < 0.62) return null

  const template = {
    t: start.t,
    pressure: pts.reduce((sum, point) => sum + point.pressure, 0) / pts.length,
    tiltX: start.tiltX,
    tiltY: start.tiltY,
    pointerType: end.pointerType || start.pointerType || 'pen',
  }

  if (circleScore >= lineScore && circleScore >= 0.62) {
    const startAngle = Math.atan2(start.y - cy, start.x - cx)
    const endAngle = Math.atan2(end.y - cy, end.x - cx)
    const points = sampleCircle(
      cx,
      cy,
      meanR,
      startAngle,
      closed ? startAngle + Math.PI * 2 : endAngle,
      closed,
      template,
      sourceWidth,
      sourceHeight,
      closed ? 52 : 40,
    )
    return {
      kind: 'circle',
      confidence: circleScore,
      stroke: { ...stroke, points },
    }
  }

  if (lineScore >= 0.62) {
    const points = sampleLine(start, end, sourceWidth, sourceHeight, Math.min(36, Math.max(12, Math.round(chord / 18))))
    return {
      kind: 'line',
      confidence: lineScore,
      stroke: { ...stroke, points },
    }
  }

  return null
}

/** True when the tip has barely moved for the last few samples (dwell). */
export const isStrokeDwelling = (
  stroke: SnappableStroke,
  sourceWidth: number,
  sourceHeight: number,
  windowMs = 420,
  maxMovePx = 5.5,
): boolean => {
  const points = stroke.points
  if (points.length < 4) return false
  const last = points[points.length - 1]
  const cutoff = last.t - windowMs
  let minX = last.x
  let maxX = last.x
  let minY = last.y
  let maxY = last.y
  let found = 0
  for (let index = points.length - 1; index >= 0; index -= 1) {
    const point = points[index]
    if (point.t < cutoff) break
    minX = Math.min(minX, point.x)
    maxX = Math.max(maxX, point.x)
    minY = Math.min(minY, point.y)
    maxY = Math.max(maxY, point.y)
    found += 1
  }
  if (found < 3) return false
  const move = Math.hypot((maxX - minX) * sourceWidth, (maxY - minY) * sourceHeight)
  return move <= maxMovePx
}
