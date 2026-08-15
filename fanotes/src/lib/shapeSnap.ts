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

export type ShapeSnapKind = 'line' | 'circle' | 'ellipse' | 'triangle' | 'square' | 'rectangle'

export type ShapeSnapResult = {
  kind: ShapeSnapKind
  stroke: SnappableStroke
  confidence: number
}

export const SHAPE_SNAP_LABEL: Record<ShapeSnapKind, string> = {
  line: 'Linie',
  circle: 'Kreis',
  ellipse: 'Ellipse',
  triangle: 'Dreieck',
  square: 'Quadrat',
  rectangle: 'Rechteck',
}

/** Only snap when we are this sure — letters and scribbles stay freehand. */
export const SHAPE_SNAP_MIN_CONFIDENCE = 0.72

type Phys = {
  x: number
  y: number
  t: number
  pressure: number
  tiltX: number
  tiltY: number
  pointerType: string
}

const clamp01 = (value: number) => Math.min(1, Math.max(0, value))
const hypot = Math.hypot

const physical = (points: StrokePoint[], sourceWidth: number, sourceHeight: number): Phys[] => (
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

const pathLength = (pts: Array<{ x: number; y: number }>) => {
  let length = 0
  for (let index = 1; index < pts.length; index += 1) {
    length += hypot(pts[index].x - pts[index - 1].x, pts[index].y - pts[index - 1].y)
  }
  return length
}

const bboxOf = (pts: Array<{ x: number; y: number }>) => {
  let minX = Infinity
  let maxX = -Infinity
  let minY = Infinity
  let maxY = -Infinity
  for (const point of pts) {
    minX = Math.min(minX, point.x)
    maxX = Math.max(maxX, point.x)
    minY = Math.min(minY, point.y)
    maxY = Math.max(maxY, point.y)
  }
  return { minX, maxX, minY, maxY, width: maxX - minX, height: maxY - minY }
}

const centroidOf = (pts: Array<{ x: number; y: number }>) => {
  let x = 0
  let y = 0
  for (const point of pts) {
    x += point.x
    y += point.y
  }
  const count = Math.max(1, pts.length)
  return { x: x / count, y: y / count }
}

const distToSegment = (px: number, py: number, ax: number, ay: number, bx: number, by: number) => {
  const dx = bx - ax
  const dy = by - ay
  const length2 = dx * dx + dy * dy
  if (length2 < 1e-8) return hypot(px - ax, py - ay)
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / length2))
  return hypot(px - (ax + t * dx), py - (ay + t * dy))
}

const rdp = (pts: Phys[], epsilon: number): Phys[] => {
  if (pts.length < 3) return pts.slice()
  let maxDist = 0
  let maxIndex = 0
  const first = pts[0]
  const last = pts[pts.length - 1]
  for (let index = 1; index < pts.length - 1; index += 1) {
    const dist = distToSegment(pts[index].x, pts[index].y, first.x, first.y, last.x, last.y)
    if (dist > maxDist) {
      maxDist = dist
      maxIndex = index
    }
  }
  if (maxDist <= epsilon) return [first, last]
  const left = rdp(pts.slice(0, maxIndex + 1), epsilon)
  const right = rdp(pts.slice(maxIndex), epsilon)
  return [...left.slice(0, -1), ...right]
}

const meanResidualToPolygon = (pts: Array<{ x: number; y: number }>, vertices: Array<{ x: number; y: number }>, closed: boolean) => {
  if (vertices.length < 2 || !pts.length) return Infinity
  let sum = 0
  for (const point of pts) {
    let best = Infinity
    const last = closed ? vertices.length : vertices.length - 1
    for (let index = 0; index < last; index += 1) {
      const a = vertices[index]
      const b = vertices[(index + 1) % vertices.length]
      best = Math.min(best, distToSegment(point.x, point.y, a.x, a.y, b.x, b.y))
    }
    sum += best
  }
  return sum / pts.length
}

const interiorAngles = (vertices: Array<{ x: number; y: number }>) => {
  const count = vertices.length
  const angles: number[] = []
  for (let index = 0; index < count; index += 1) {
    const prev = vertices[(index - 1 + count) % count]
    const curr = vertices[index]
    const next = vertices[(index + 1) % count]
    const ax = prev.x - curr.x
    const ay = prev.y - curr.y
    const bx = next.x - curr.x
    const by = next.y - curr.y
    const denom = hypot(ax, ay) * hypot(bx, by)
    if (denom < 1e-6) {
      angles.push(180)
      continue
    }
    const cos = Math.max(-1, Math.min(1, (ax * bx + ay * by) / denom))
    angles.push((Math.acos(cos) * 180) / Math.PI)
  }
  return angles
}

const sideLengths = (vertices: Array<{ x: number; y: number }>, closed: boolean) => {
  const lengths: number[] = []
  const last = closed ? vertices.length : vertices.length - 1
  for (let index = 0; index < last; index += 1) {
    const a = vertices[index]
    const b = vertices[(index + 1) % vertices.length]
    lengths.push(hypot(b.x - a.x, b.y - a.y))
  }
  return lengths
}

const toStrokePoints = (
  pts: Array<{ x: number; y: number }>,
  template: Phys,
  sourceWidth: number,
  sourceHeight: number,
): StrokePoint[] => pts.map((point, index) => ({
  x: clamp01(point.x / sourceWidth),
  y: clamp01(point.y / sourceHeight),
  t: template.t + index,
  pressure: template.pressure,
  tiltX: template.tiltX,
  tiltY: template.tiltY,
  pointerType: template.pointerType || 'pen',
}))

const samplePolyline = (
  vertices: Array<{ x: number; y: number }>,
  closed: boolean,
  template: Phys,
  sourceWidth: number,
  sourceHeight: number,
): StrokePoint[] => {
  const ring = closed ? [...vertices, vertices[0]] : vertices
  const points: Array<{ x: number; y: number }> = []
  for (let index = 1; index < ring.length; index += 1) {
    const a = ring[index - 1]
    const b = ring[index]
    const length = hypot(b.x - a.x, b.y - a.y)
    const steps = Math.max(2, Math.round(length / 10))
    const start = index === 1 ? 0 : 1
    for (let step = start; step <= steps; step += 1) {
      const t = step / steps
      points.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t })
    }
  }
  return toStrokePoints(points, template, sourceWidth, sourceHeight)
}

const sampleEllipse = (
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  rotation: number,
  template: Phys,
  sourceWidth: number,
  sourceHeight: number,
  samples = 56,
): StrokePoint[] => {
  const cos = Math.cos(rotation)
  const sin = Math.sin(rotation)
  const points: Array<{ x: number; y: number }> = []
  for (let index = 0; index <= samples; index += 1) {
    const angle = (index / samples) * Math.PI * 2
    const lx = Math.cos(angle) * rx
    const ly = Math.sin(angle) * ry
    points.push({
      x: cx + lx * cos - ly * sin,
      y: cy + lx * sin + ly * cos,
    })
  }
  return toStrokePoints(points, template, sourceWidth, sourceHeight)
}

const fitEllipse = (pts: Array<{ x: number; y: number }>) => {
  const center = centroidOf(pts)
  let xx = 0
  let yy = 0
  let xy = 0
  for (const point of pts) {
    const dx = point.x - center.x
    const dy = point.y - center.y
    xx += dx * dx
    yy += dy * dy
    xy += dx * dy
  }
  const count = Math.max(1, pts.length)
  xx /= count
  yy /= count
  xy /= count
  const trace = xx + yy
  const det = xx * yy - xy * xy
  const disc = Math.sqrt(Math.max(0, (trace * trace) / 4 - det))
  const ev1 = trace / 2 + disc
  const ev2 = trace / 2 - disc
  const rotation = Math.abs(xy) < 1e-8 && xx >= yy ? 0 : Math.atan2(ev1 - xx, xy)
  const rx = Math.sqrt(Math.max(1, ev1 * 2))
  const ry = Math.sqrt(Math.max(1, ev2 * 2))
  let residual = 0
  const cos = Math.cos(rotation)
  const sin = Math.sin(rotation)
  for (const point of pts) {
    const dx = point.x - center.x
    const dy = point.y - center.y
    const lx = dx * cos + dy * sin
    const ly = -dx * sin + dy * cos
    const nx = rx < 1e-3 ? 0 : lx / rx
    const ny = ry < 1e-3 ? 0 : ly / ry
    const mag = hypot(nx, ny)
    residual += Math.abs(mag - 1)
  }
  residual /= count
  return { cx: center.x, cy: center.y, rx, ry, rotation, residual }
}

const angularCoverage = (pts: Array<{ x: number; y: number }>, cx: number, cy: number) => {
  if (pts.length < 4) return 0
  const angles = pts.map((point) => Math.atan2(point.y - cy, point.x - cx)).sort((a, b) => a - b)
  let maxGap = 0
  for (let index = 1; index < angles.length; index += 1) {
    maxGap = Math.max(maxGap, angles[index] - angles[index - 1])
  }
  maxGap = Math.max(maxGap, angles[0] + Math.PI * 2 - angles[angles.length - 1])
  return Math.max(0, 1 - maxGap / (Math.PI * 2))
}

const templateFrom = (pts: Phys[]): Phys => {
  const start = pts[0]
  const end = pts[pts.length - 1]
  return {
    x: start.x,
    y: start.y,
    t: start.t,
    pressure: pts.reduce((sum, point) => sum + point.pressure, 0) / pts.length,
    tiltX: start.tiltX,
    tiltY: start.tiltY,
    pointerType: end.pointerType || start.pointerType || 'pen',
  }
}

const pickBest = (candidates: Array<ShapeSnapResult | null>): ShapeSnapResult | null => {
  const valid = candidates.filter((candidate): candidate is ShapeSnapResult => (
    Boolean(candidate && candidate.confidence >= SHAPE_SNAP_MIN_CONFIDENCE)
  ))
  if (!valid.length) return null
  valid.sort((a, b) => b.confidence - a.confidence)
  const best = valid[0]
  const second = valid[1]
  // Ambiguous geometry (letter-like) stays freehand.
  if (second && best.confidence - second.confidence < 0.05 && second.kind !== best.kind) return null
  return best
}

/**
 * Detects a clear geometric figure and returns a cleaned replacement.
 * Returns null unless the stroke is confidently a line, circle, ellipse,
 * triangle, square or rectangle — not handwriting.
 */
export const snapStrokeToShape = (
  stroke: SnappableStroke,
  sourceWidth: number,
  sourceHeight: number,
): ShapeSnapResult | null => {
  if (stroke.symbolId) return null
  if (stroke.points.length < 10) return null
  const pts = physical(stroke.points, sourceWidth, sourceHeight)
  const length = pathLength(pts)
  if (length < 40) return null
  const box = bboxOf(pts)
  const diagonal = hypot(box.width, box.height)
  if (diagonal < 32) return null

  const start = pts[0]
  const end = pts[pts.length - 1]
  const chord = hypot(end.x - start.x, end.y - start.y)
  const closed = chord <= Math.max(18, diagonal * 0.2)
  const template = templateFrom(pts)

  // --- Line (open, almost straight, not a tiny glyph) ---
  let lineScore = 0
  if (!closed && chord >= 56) {
    let maxDev = 0
    let sumDev = 0
    const nx = (end.x - start.x) / chord
    const ny = (end.y - start.y) / chord
    for (const point of pts) {
      const along = (point.x - start.x) * nx + (point.y - start.y) * ny
      const px = start.x + nx * along
      const py = start.y + ny * along
      const dev = hypot(point.x - px, point.y - py)
      maxDev = Math.max(maxDev, dev)
      sumDev += dev
    }
    const meanDev = sumDev / pts.length
    const straight = chord / Math.max(1, length)
    if (straight >= 0.9 && maxDev <= Math.max(6, chord * 0.055) && meanDev <= Math.max(3.5, chord * 0.03)) {
      lineScore = clamp01((straight - 0.88) / 0.12) * clamp01(1 - meanDev / Math.max(4, chord * 0.045))
    }
  }

  // --- Circle / ellipse ---
  const ellipse = fitEllipse(pts)
  const coverage = angularCoverage(pts, ellipse.cx, ellipse.cy)
  const radiusMean = (ellipse.rx + ellipse.ry) / 2
  const aspect = ellipse.rx / Math.max(1, ellipse.ry)
  const circular = aspect > 0.82 && aspect < 1.22
  const elliptical = aspect >= 0.38 && aspect <= 2.65
  let circleScore = 0
  let ellipseScore = 0
  if (
    closed
    && coverage >= 0.68
    && radiusMean >= 18
    && length >= radiusMean * Math.PI * 1.05
    && length <= radiusMean * Math.PI * 3.6
  ) {
    if (circular && ellipse.residual <= 0.18) {
      circleScore = clamp01(1 - ellipse.residual / 0.18) * clamp01(0.55 + coverage * 0.45)
    } else if (elliptical && ellipse.residual <= 0.2 && (aspect <= 0.86 || aspect >= 1.16)) {
      ellipseScore = clamp01(1 - ellipse.residual / 0.2) * clamp01(0.5 + coverage * 0.5)
    }
  }

  // --- Polygons via corner simplification ---
  const epsilon = Math.max(5, diagonal * 0.055)
  let corners = rdp(pts, epsilon)
  if (closed && corners.length >= 3) {
    const first = corners[0]
    const last = corners[corners.length - 1]
    if (hypot(last.x - first.x, last.y - first.y) <= Math.max(12, diagonal * 0.1)) {
      corners = corners.slice(0, -1)
    }
  }
  // Collapse near-duplicate corners.
  const unique: Phys[] = []
  for (const corner of corners) {
    const previous = unique[unique.length - 1]
    if (!previous || hypot(corner.x - previous.x, corner.y - previous.y) > Math.max(10, diagonal * 0.06)) {
      unique.push(corner)
    }
  }
  if (unique.length >= 3 && hypot(unique[0].x - unique[unique.length - 1].x, unique[0].y - unique[unique.length - 1].y) <= Math.max(10, diagonal * 0.06)) {
    unique.pop()
  }

  let triangleScore = 0
  let squareScore = 0
  let rectangleScore = 0
  let triangleVertices: Array<{ x: number; y: number }> | null = null
  let quadVertices: Array<{ x: number; y: number }> | null = null

  if (closed && unique.length === 3) {
    const sides = sideLengths(unique, true)
    const angles = interiorAngles(unique)
    const residual = meanResidualToPolygon(pts, unique, true)
    const minSide = Math.min(...sides)
    const sharp = angles.every((angle) => angle > 28 && angle < 142)
    if (minSide >= 22 && sharp && residual <= Math.max(5, diagonal * 0.055)) {
      triangleScore = clamp01(1 - residual / Math.max(6, diagonal * 0.07))
      triangleVertices = unique
      const similar = Math.max(...sides) / Math.max(1, Math.min(...sides))
      if (similar < 1.22 && angles.every((angle) => Math.abs(angle - 60) < 18)) {
        triangleScore = Math.min(1, triangleScore + 0.06)
      }
    }
  }

  if (closed && unique.length === 4) {
    const sides = sideLengths(unique, true)
    const angles = interiorAngles(unique)
    const residual = meanResidualToPolygon(pts, unique, true)
    const minSide = Math.min(...sides)
    const right = angles.every((angle) => Math.abs(angle - 90) <= 18)
    const oppositeSimilar = (
      Math.abs(sides[0] - sides[2]) / Math.max(1, (sides[0] + sides[2]) / 2) <= 0.22
      && Math.abs(sides[1] - sides[3]) / Math.max(1, (sides[1] + sides[3]) / 2) <= 0.22
    )
    if (minSide >= 20 && right && oppositeSimilar && residual <= Math.max(5.5, diagonal * 0.055)) {
      const sideRatio = Math.max(sides[0], sides[1]) / Math.max(1, Math.min(sides[0], sides[1]))
      const score = clamp01(1 - residual / Math.max(6, diagonal * 0.07))
        * clamp01(1 - Math.max(...angles.map((angle) => Math.abs(angle - 90))) / 22)
      quadVertices = unique
      if (sideRatio <= 1.2) squareScore = Math.min(1, score + 0.04)
      else rectangleScore = score
    }
  }

  // Too many corners = handwriting / scribble, never force a shape.
  if (!closed && unique.length >= 5) lineScore = 0
  if (closed && unique.length >= 6 && circleScore < 0.86 && ellipseScore < 0.86) {
    triangleScore = 0
    squareScore = 0
    rectangleScore = 0
  }

  const line = lineScore >= SHAPE_SNAP_MIN_CONFIDENCE
    ? {
        kind: 'line' as const,
        confidence: lineScore,
        stroke: {
          ...stroke,
          points: samplePolyline([start, end], false, template, sourceWidth, sourceHeight),
        },
      }
    : null

  const circle = circleScore >= SHAPE_SNAP_MIN_CONFIDENCE
    ? {
        kind: 'circle' as const,
        confidence: circleScore,
        stroke: {
          ...stroke,
          points: sampleEllipse(ellipse.cx, ellipse.cy, radiusMean, radiusMean, 0, template, sourceWidth, sourceHeight),
        },
      }
    : null

  const oval = ellipseScore >= SHAPE_SNAP_MIN_CONFIDENCE
    ? {
        kind: 'ellipse' as const,
        confidence: ellipseScore,
        stroke: {
          ...stroke,
          points: sampleEllipse(ellipse.cx, ellipse.cy, ellipse.rx, ellipse.ry, ellipse.rotation, template, sourceWidth, sourceHeight),
        },
      }
    : null

  const triangle = triangleScore >= SHAPE_SNAP_MIN_CONFIDENCE && triangleVertices
    ? {
        kind: 'triangle' as const,
        confidence: triangleScore,
        stroke: {
          ...stroke,
          points: samplePolyline(triangleVertices, true, template, sourceWidth, sourceHeight),
        },
      }
    : null

  const square = squareScore >= SHAPE_SNAP_MIN_CONFIDENCE && quadVertices
    ? {
        kind: 'square' as const,
        confidence: squareScore,
        stroke: {
          ...stroke,
          points: samplePolyline(regularizeRectangle(quadVertices, true), true, template, sourceWidth, sourceHeight),
        },
      }
    : null

  const rectangle = rectangleScore >= SHAPE_SNAP_MIN_CONFIDENCE && quadVertices
    ? {
        kind: 'rectangle' as const,
        confidence: rectangleScore,
        stroke: {
          ...stroke,
          points: samplePolyline(regularizeRectangle(quadVertices, false), true, template, sourceWidth, sourceHeight),
        },
      }
    : null

  return pickBest([line, circle, oval, triangle, square, rectangle])
}

const regularizeRectangle = (vertices: Array<{ x: number; y: number }>, forceSquare: boolean) => {
  const center = centroidOf(vertices)
  const edge = {
    x: vertices[1].x - vertices[0].x,
    y: vertices[1].y - vertices[0].y,
  }
  let rotation = Math.atan2(edge.y, edge.x)
  const snapped = Math.round(rotation / (Math.PI / 2)) * (Math.PI / 2)
  if (Math.abs(rotation - snapped) < (10 * Math.PI) / 180) rotation = snapped
  const cos = Math.cos(-rotation)
  const sin = Math.sin(-rotation)
  let maxX = 0
  let maxY = 0
  for (const vertex of vertices) {
    const dx = vertex.x - center.x
    const dy = vertex.y - center.y
    maxX = Math.max(maxX, Math.abs(dx * cos - dy * sin))
    maxY = Math.max(maxY, Math.abs(dx * sin + dy * cos))
  }
  if (forceSquare) {
    const size = (maxX + maxY) / 2
    maxX = size
    maxY = size
  }
  const local = [
    { x: -maxX, y: -maxY },
    { x: maxX, y: -maxY },
    { x: maxX, y: maxY },
    { x: -maxX, y: maxY },
  ]
  const rc = Math.cos(rotation)
  const rs = Math.sin(rotation)
  return local.map((point) => ({
    x: center.x + point.x * rc - point.y * rs,
    y: center.y + point.x * rs + point.y * rc,
  }))
}

/** True when the tip has barely moved recently (start of a deliberate hold). */
export const isStrokeDwelling = (
  stroke: SnappableStroke,
  sourceWidth: number,
  sourceHeight: number,
  windowMs = 480,
  maxMovePx = 6,
): boolean => {
  const points = stroke.points
  if (points.length < 6) return false
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
  return hypot((maxX - minX) * sourceWidth, (maxY - minY) * sourceHeight) <= maxMovePx
}

/** Peek whether a stroke is already a recognizable figure (no rewrite). */
export const strokeLooksLikeShape = (
  stroke: SnappableStroke,
  sourceWidth: number,
  sourceHeight: number,
) => {
  const result = snapStrokeToShape(stroke, sourceWidth, sourceHeight)
  return result !== null && result.confidence >= SHAPE_SNAP_MIN_CONFIDENCE
}
