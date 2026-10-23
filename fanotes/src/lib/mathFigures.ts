/**
 * Mathematical figures as 24×24 stroke paths.
 *
 * The ink painter strokes every path the same way and does not set a line dash,
 * so a hidden edge is a run of short `M`/`L` pieces. Yaw turns around Y, then
 * pitch turns around X. The camera sits on +Z. A face is in front when its
 * outward normal still points toward that camera.
 */

export type MathFigureGroup = 'plane' | 'solid'

export type MathFigureParam = {
  id: string
  label: string
  min: number
  max: number
  step: number
  value: number
}

export type MathFigureDefinition = {
  id: MathFigureId
  label: string
  group: MathFigureGroup
  params: readonly MathFigureParam[]
}

export const MATH_FIGURE_IDS = [
  'circle', 'ellipse', 'semicircle', 'ring', 'sector', 'arc',
  'triangle', 'right-triangle', 'square', 'rectangle', 'rhombus', 'parallelogram', 'trapezoid', 'kite',
  'polygon', 'star', 'arrow', 'double-arrow', 'angle', 'axes', 'number-line',
  'parabola', 'sine', 'grid', 'venn', 'parallel', 'chord', 'tangent', 'diameter',
  'cube-net', 'cross', 'vector',
  'cube', 'cuboid', 'tetrahedron', 'octahedron', 'icosahedron', 'dodecahedron',
  'square-pyramid', 'pentagonal-pyramid', 'hexagonal-pyramid',
  'triangular-prism', 'pentagonal-prism', 'hexagonal-prism',
  'cylinder', 'cone', 'frustum', 'sphere', 'hemisphere', 'torus', 'axes-3d', 'plane',
] as const

export type MathFigureId = typeof MATH_FIGURE_IDS[number]

const FIGURE_ID_SET = new Set<string>(MATH_FIGURE_IDS)

export const isMathFigureId = (value: unknown): value is MathFigureId => (
  typeof value === 'string' && FIGURE_ID_SET.has(value)
)

/** Stroke inside the 24×24 stamp before a figure had its own line thickness. */
export const FIGURE_ICON_STROKE = 1.75
/** Line thickness in page units. Size scales the stamp; this stays put. */
export const FIGURE_LINE_MIN = 0.5
export const FIGURE_LINE_MAX = 36
export const FIGURE_LINE_STEP = 0.25

const snapFigureLine = (value: number) => (
  Math.round(Math.round(value / FIGURE_LINE_STEP) * FIGURE_LINE_STEP * 100) / 100
)

/** The thickness a figure of `size` page units had when the stroke was fixed at 1.75. */
export const figureLineWidthForSize = (size: number) => (
  snapFigureLine(FIGURE_ICON_STROKE * size / 24)
)

export const clampFigureLineWidth = (value: unknown, fallback: number) => {
  const number = typeof value === 'number' ? value : Number(value)
  const raw = Number.isFinite(number) ? number : fallback
  return snapFigureLine(Math.min(FIGURE_LINE_MAX, Math.max(FIGURE_LINE_MIN, raw)))
}

const yawPitch = (): MathFigureParam[] => [
  { id: 'yaw', label: 'Drehung', min: 0, max: 360, step: 1, value: 35 },
  { id: 'pitch', label: 'Neigung', min: -60, max: 60, step: 1, value: 24 },
]

const define = (
  id: MathFigureId,
  label: string,
  group: MathFigureGroup,
  params: readonly MathFigureParam[] = [],
): MathFigureDefinition => ({ id, label, group, params })

export const MATH_FIGURES: readonly MathFigureDefinition[] = [
  define('circle', 'Kreis', 'plane'),
  define('ellipse', 'Ellipse', 'plane', [
    { id: 'aspect', label: 'Verhältnis', min: 0.35, max: 1, step: 0.05, value: 0.62 },
  ]),
  define('semicircle', 'Halbkreis', 'plane'),
  define('ring', 'Ring', 'plane', [
    { id: 'inner', label: 'Innen', min: 0.25, max: 0.85, step: 0.05, value: 0.55 },
  ]),
  define('sector', 'Sektor', 'plane', [
    { id: 'degrees', label: 'Winkel', min: 20, max: 320, step: 1, value: 90 },
  ]),
  define('arc', 'Bogen', 'plane', [
    { id: 'degrees', label: 'Winkel', min: 20, max: 320, step: 1, value: 120 },
  ]),
  define('triangle', 'Dreieck', 'plane'),
  define('right-triangle', 'Rechtwinklig', 'plane'),
  define('square', 'Quadrat', 'plane'),
  define('rectangle', 'Rechteck', 'plane', [
    { id: 'aspect', label: 'Verhältnis', min: 0.35, max: 1, step: 0.05, value: 0.62 },
  ]),
  define('rhombus', 'Raute', 'plane'),
  define('parallelogram', 'Parallelogramm', 'plane', [
    { id: 'skew', label: 'Schräge', min: -0.6, max: 0.6, step: 0.05, value: 0.35 },
  ]),
  define('trapezoid', 'Trapez', 'plane', [
    { id: 'top', label: 'Oberseite', min: 0.35, max: 0.9, step: 0.05, value: 0.55 },
  ]),
  define('kite', 'Drachen', 'plane'),
  define('polygon', 'Vieleck', 'plane', [
    { id: 'sides', label: 'Ecken', min: 3, max: 12, step: 1, value: 6 },
  ]),
  define('star', 'Stern', 'plane', [
    { id: 'points', label: 'Zacken', min: 4, max: 12, step: 1, value: 5 },
  ]),
  define('arrow', 'Pfeil', 'plane'),
  define('double-arrow', 'Doppelpfeil', 'plane'),
  define('angle', 'Winkel', 'plane', [
    { id: 'degrees', label: 'Winkel', min: 20, max: 160, step: 1, value: 60 },
  ]),
  define('axes', 'Achsen', 'plane', [
    { id: 'ticks', label: 'Teilung', min: 0, max: 8, step: 1, value: 4 },
  ]),
  define('number-line', 'Zahlenstrahl', 'plane', [
    { id: 'ticks', label: 'Teilung', min: 2, max: 12, step: 1, value: 6 },
  ]),
  define('parabola', 'Parabel', 'plane'),
  define('sine', 'Sinus', 'plane', [
    { id: 'waves', label: 'Wellen', min: 0.5, max: 4, step: 0.5, value: 1.5 },
    { id: 'amplitude', label: 'Höhe', min: 0.3, max: 1, step: 0.05, value: 0.7 },
  ]),
  define('grid', 'Gitter', 'plane', [
    { id: 'cells', label: 'Felder', min: 2, max: 8, step: 1, value: 4 },
  ]),
  define('venn', 'Venn', 'plane'),
  define('parallel', 'Parallelen', 'plane'),
  define('chord', 'Sehne', 'plane'),
  define('tangent', 'Tangente', 'plane'),
  define('diameter', 'Durchmesser', 'plane'),
  define('cube-net', 'Würfelnetz', 'plane'),
  define('cross', 'Kreuz', 'plane'),
  define('vector', 'Vektor', 'plane'),
  define('cube', 'Würfel', 'solid', yawPitch()),
  define('cuboid', 'Quader', 'solid', [
    { id: 'width', label: 'Breite', min: 0.4, max: 2.2, step: 0.05, value: 1.4 },
    { id: 'height', label: 'Höhe', min: 0.4, max: 2.2, step: 0.05, value: 0.9 },
    { id: 'depth', label: 'Tiefe', min: 0.4, max: 2.2, step: 0.05, value: 0.7 },
    ...yawPitch(),
  ]),
  define('tetrahedron', 'Tetraeder', 'solid', yawPitch()),
  define('octahedron', 'Oktaeder', 'solid', yawPitch()),
  define('icosahedron', 'Ikosaeder', 'solid', yawPitch()),
  define('dodecahedron', 'Dodekaeder', 'solid', yawPitch()),
  define('square-pyramid', 'Pyramide', 'solid', yawPitch()),
  define('pentagonal-pyramid', 'Fünfeckpyramide', 'solid', yawPitch()),
  define('hexagonal-pyramid', 'Sechseckpyramide', 'solid', yawPitch()),
  define('triangular-prism', 'Dreiecksprisma', 'solid', yawPitch()),
  define('pentagonal-prism', 'Fünfeckprisma', 'solid', yawPitch()),
  define('hexagonal-prism', 'Sechseckprisma', 'solid', yawPitch()),
  define('cylinder', 'Zylinder', 'solid', [
    { id: 'segments', label: 'Segmente', min: 8, max: 24, step: 1, value: 16 },
    ...yawPitch(),
  ]),
  define('cone', 'Kegel', 'solid', [
    { id: 'segments', label: 'Segmente', min: 8, max: 24, step: 1, value: 16 },
    ...yawPitch(),
  ]),
  define('frustum', 'Kegelstumpf', 'solid', [
    { id: 'ratio', label: 'Deckel', min: 0.2, max: 0.85, step: 0.05, value: 0.45 },
    { id: 'segments', label: 'Segmente', min: 8, max: 24, step: 1, value: 16 },
    ...yawPitch(),
  ]),
  define('sphere', 'Kugel', 'solid', [
    { id: 'meridians', label: 'Meridiane', min: 4, max: 16, step: 1, value: 8 },
    { id: 'parallels', label: 'Breiten', min: 2, max: 8, step: 1, value: 4 },
    ...yawPitch(),
  ]),
  define('hemisphere', 'Halbkugel', 'solid', [
    { id: 'meridians', label: 'Meridiane', min: 4, max: 16, step: 1, value: 8 },
    ...yawPitch(),
  ]),
  define('torus', 'Torus', 'solid', [
    { id: 'tube', label: 'Dicke', min: 0.22, max: 0.55, step: 0.01, value: 0.36 },
    { id: 'rings', label: 'Ringe', min: 8, max: 18, step: 1, value: 12 },
    ...yawPitch(),
  ]),
  define('axes-3d', 'Raumachsen', 'solid', yawPitch()),
  define('plane', 'Ebene', 'solid', [
    { id: 'cells', label: 'Felder', min: 2, max: 8, step: 1, value: 4 },
    ...yawPitch(),
  ]),
]

const figureById = new Map<MathFigureId, MathFigureDefinition>(MATH_FIGURES.map((figure) => [figure.id, figure]))

export const mathFigureById = (id: MathFigureId): MathFigureDefinition => {
  const figure = figureById.get(id)
  if (!figure) throw new Error(`Unknown math figure ${id}`)
  return figure
}

const clampNumber = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value))

const snap = (value: number, step: number) => {
  if (!(step > 0)) return value
  const snapped = Math.round(value / step) * step
  return Math.round(snapped * 10000) / 10000
}

export const defaultFigureParams = (id: MathFigureId): Record<string, number> => {
  const params: Record<string, number> = {}
  for (const param of mathFigureById(id).params) params[param.id] = param.value
  return params
}

/** Keeps only this figure's knobs. A missing or non-finite value falls back to the default. */
export const clampFigureParams = (id: MathFigureId, raw: unknown): Record<string, number> => {
  const source = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
  const params: Record<string, number> = {}
  for (const param of mathFigureById(id).params) {
    const numeric = Number(source[param.id])
    const value = Number.isFinite(numeric) ? numeric : param.value
    params[param.id] = clampNumber(snap(value, param.step), param.min, param.max)
  }
  return params
}

type Pt = { x: number; y: number }
type V3 = { x: number; y: number; z: number }
type Poly = { pts: Pt[]; dashed?: boolean; close?: boolean }

const fmt = (value: number) => {
  const rounded = Math.round(value * 100) / 100
  if (rounded === 0) return '0'
  return String(rounded)
}

const rotate = (p: V3, yawDeg: number, pitchDeg: number): V3 => {
  const yaw = yawDeg * Math.PI / 180
  const pitch = pitchDeg * Math.PI / 180
  const cy = Math.cos(yaw)
  const sy = Math.sin(yaw)
  const cp = Math.cos(pitch)
  const sp = Math.sin(pitch)
  const x1 = p.x * cy + p.z * sy
  const y1 = p.y
  const z1 = -p.x * sy + p.z * cy
  const y2 = y1 * cp - z1 * sp
  const z2 = y1 * sp + z1 * cp
  return { x: x1, y: y2, z: z2 }
}

const screenOf = (p: V3): Pt => ({ x: p.x, y: -p.y })

const add = (a: V3, b: V3): V3 => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z })
const scaleV = (a: V3, k: number): V3 => ({ x: a.x * k, y: a.y * k, z: a.z * k })
const sub = (a: V3, b: V3): V3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z })
const dot = (a: V3, b: V3) => a.x * b.x + a.y * b.y + a.z * b.z
const cross = (a: V3, b: V3): V3 => ({
  x: a.y * b.z - a.z * b.y,
  y: a.z * b.x - a.x * b.z,
  z: a.x * b.y - a.y * b.x,
})
const lengthOf = (a: V3) => Math.hypot(a.x, a.y, a.z)
const normalize = (a: V3): V3 => {
  const len = lengthOf(a) || 1
  return scaleV(a, 1 / len)
}

const dashPath = (a: Pt, b: Pt): string => {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const len = Math.hypot(dx, dy)
  if (len < 0.35) return ''
  const ux = dx / len
  const uy = dy / len
  const on = 1.25
  const gap = 0.8
  const parts: string[] = []
  let t = 0
  while (t < len - 0.12 && parts.length < 48) {
    const end = Math.min(len, t + on)
    if (end - t >= 0.2) {
      parts.push(`M ${fmt(a.x + ux * t)} ${fmt(a.y + uy * t)} L ${fmt(a.x + ux * end)} ${fmt(a.y + uy * end)}`)
    }
    t = end + gap
  }
  return parts.join(' ')
}

const polyPath = (pts: Pt[], close: boolean): string => {
  let d = `M ${fmt(pts[0].x)} ${fmt(pts[0].y)}`
  for (let index = 1; index < pts.length; index += 1) d += ` L ${fmt(pts[index].x)} ${fmt(pts[index].y)}`
  if (close) d += ' Z'
  return d
}

/** Fits every polyline into the 24×24 stamp, then breaks hidden edges into dashes. */
const emit = (polys: Poly[]): string[] => {
  const points = polys.flatMap((poly) => poly.pts)
  if (points.length < 2) return []
  let minX = Number.POSITIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY
  for (const point of points) {
    if (point.x < minX) minX = point.x
    if (point.y < minY) minY = point.y
    if (point.x > maxX) maxX = point.x
    if (point.y > maxY) maxY = point.y
  }
  const width = Math.max(1e-6, maxX - minX)
  const height = Math.max(1e-6, maxY - minY)
  const pad = 1.7
  const avail = 24 - pad * 2
  const fit = Math.min(avail / width, avail / height)
  const ox = pad + (avail - width * fit) / 2
  const oy = pad + (avail - height * fit) / 2
  const map = (point: Pt): Pt => ({
    x: ox + (point.x - minX) * fit,
    y: oy + (point.y - minY) * fit,
  })
  const solid: string[] = []
  const hidden: string[] = []
  for (const poly of polys) {
    const mapped = poly.pts.map(map)
    if (mapped.length < 2) continue
    if (poly.dashed) {
      const seq = poly.close ? [...mapped, mapped[0]] : mapped
      const parts: string[] = []
      for (let index = 0; index < seq.length - 1; index += 1) {
        const piece = dashPath(seq[index], seq[index + 1])
        if (piece) parts.push(piece)
      }
      if (parts.length) hidden.push(parts.join(' '))
    } else {
      solid.push(polyPath(mapped, Boolean(poly.close)))
    }
  }
  const paths: string[] = []
  if (solid.length) paths.push(solid.join(' '))
  if (hidden.length) paths.push(hidden.join(' '))
  return paths
}

const line = (pts: Pt[], dashed = false): Poly => ({ pts, dashed })
const loop = (pts: Pt[]): Poly => ({ pts, close: true })

const circlePts = (cx: number, cy: number, rx: number, ry = rx, from = 0, to = Math.PI * 2, steps = 56): Pt[] => {
  const count = Math.max(8, Math.round(steps * Math.abs(to - from) / (Math.PI * 2)))
  const pts: Pt[] = []
  for (let index = 0; index <= count; index += 1) {
    const t = from + (to - from) * (index / count)
    pts.push({ x: cx + Math.cos(t) * rx, y: cy + Math.sin(t) * ry })
  }
  return pts
}

const samples = (count: number, at: (t: number) => Pt): Pt[] => {
  const pts: Pt[] = []
  for (let index = 0; index <= count; index += 1) pts.push(at(index / count))
  return pts
}

const arrowHead = (tip: Pt, dir: Pt, size = 0.28): Pt[][] => {
  const len = Math.hypot(dir.x, dir.y) || 1
  const ux = dir.x / len
  const uy = dir.y / len
  const back = { x: tip.x - ux * size, y: tip.y - uy * size }
  const px = -uy * size * 0.55
  const py = ux * size * 0.55
  return [
    [{ x: tip.x, y: tip.y }, { x: back.x + px, y: back.y + py }],
    [{ x: tip.x, y: tip.y }, { x: back.x - px, y: back.y - py }],
  ]
}

const faceFront = (cam: V3[], face: number[]) => {
  const a = cam[face[0]]
  const b = cam[face[1]]
  const c = cam[face[2]]
  const ux = b.x - a.x
  const uy = b.y - a.y
  const vx = c.x - a.x
  const vy = c.y - a.y
  return ux * vy - uy * vx > 0.02
}

const wire = (verts: V3[], faces: number[][], yaw: number, pitch: number): Poly[] => {
  const cam = verts.map((vert) => rotate(vert, yaw, pitch))
  const front = faces.map((face) => faceFront(cam, face))
  const owners = new Map<string, number[]>()
  faces.forEach((face, faceIndex) => {
    for (let index = 0; index < face.length; index += 1) {
      const i = face[index]
      const j = face[(index + 1) % face.length]
      const key = i < j ? `${i}-${j}` : `${j}-${i}`
      const list = owners.get(key)
      if (list) list.push(faceIndex)
      else owners.set(key, [faceIndex])
    }
  })
  const polys: Poly[] = []
  for (const [key, faceIndexes] of owners) {
    const [i, j] = key.split('-').map(Number)
    polys.push({
      pts: [screenOf(cam[i]), screenOf(cam[j])],
      dashed: !faceIndexes.some((faceIndex) => front[faceIndex]),
    })
  }
  return polys
}

const ring = (count: number, y: number, radius: number): V3[] => {
  const verts: V3[] = []
  for (let index = 0; index < count; index += 1) {
    const angle = (index / count) * Math.PI * 2 - Math.PI / 2
    verts.push({ x: Math.cos(angle) * radius, y, z: Math.sin(angle) * radius })
  }
  return verts
}

const prismFaces = (sides: number, topRadius = 1): { verts: V3[]; faces: number[][] } => {
  const verts = [...ring(sides, -1, 1), ...ring(sides, 1, topRadius)]
  const faces: number[][] = []
  for (let index = 0; index < sides; index += 1) {
    const next = (index + 1) % sides
    faces.push([index, sides + index, sides + next, next])
  }
  const top: number[] = []
  const bottom: number[] = []
  for (let index = 0; index < sides; index += 1) {
    top.push(sides + ((sides - index) % sides))
    bottom.push(index)
  }
  faces.push(top, bottom)
  return { verts, faces }
}

const pyramid = (sides: number, yaw: number, pitch: number): Poly[] => {
  const verts = [...ring(sides, -0.8, 1), { x: 0, y: 1.25, z: 0 }]
  const apex = sides
  const faces: number[][] = []
  for (let index = 0; index < sides; index += 1) faces.push([index, apex, (index + 1) % sides])
  faces.push(Array.from({ length: sides }, (_, index) => index))
  return wire(verts, faces, yaw, pitch)
}

const orientOutward = (verts: V3[], face: number[]): number[] => {
  const ordered = face.slice()
  const a = verts[ordered[0]]
  const b = verts[ordered[1]]
  const c = verts[ordered[2]]
  const normal = cross(sub(b, a), sub(c, a))
  const mid = scaleV(add(add(a, b), c), 1 / 3)
  if (dot(normal, mid) < 0) ordered.reverse()
  return ordered
}

const mutualFaces = (verts: V3[], neighborLimit: number): number[][] => {
  const count = verts.length
  let nearest = Number.POSITIVE_INFINITY
  const dist: number[][] = Array.from({ length: count }, () => Array<number>(count).fill(0))
  for (let i = 0; i < count; i += 1) {
    for (let j = i + 1; j < count; j += 1) {
      const delta = sub(verts[i], verts[j])
      const value = dot(delta, delta)
      dist[i][j] = value
      dist[j][i] = value
      if (value > 1e-8 && value < nearest) nearest = value
    }
  }
  const limit = nearest * 1.02
  const neighbors = verts.map(() => [] as number[])
  for (let i = 0; i < count; i += 1) {
    for (let j = i + 1; j < count; j += 1) {
      if (dist[i][j] <= limit) {
        neighbors[i].push(j)
        neighbors[j].push(i)
      }
    }
  }
  const faces: number[][] = []
  for (let i = 0; i < count; i += 1) {
    for (const j of neighbors[i]) {
      if (j < i) continue
      for (const k of neighbors[j]) {
        if (k <= j || !neighbors[i].includes(k)) continue
        if (neighborLimit === 3) faces.push(orientOutward(verts, [i, j, k]))
      }
    }
  }
  return faces
}

const regularIcosahedron = (): { verts: V3[]; faces: number[][] } => {
  const phi = (1 + Math.sqrt(5)) / 2
  const raw: V3[] = []
  for (const sy of [-1, 1]) {
    for (const sz of [-1, 1]) raw.push({ x: 0, y: sy, z: sz * phi })
  }
  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) raw.push({ x: sx, y: sy * phi, z: 0 })
  }
  for (const sz of [-1, 1]) {
    for (const sx of [-1, 1]) raw.push({ x: sx * phi, y: 0, z: sz })
  }
  const verts = raw.map(normalize)
  return { verts, faces: mutualFaces(verts, 3) }
}

const ICOSA = regularIcosahedron()

const dodecahedron = (): { verts: V3[]; faces: number[][] } => {
  const { verts, faces } = ICOSA
  const centers = faces.map((face) => normalize(scaleV(
    face.reduce((sum, index) => add(sum, verts[index]), { x: 0, y: 0, z: 0 }),
    1 / face.length,
  )))
  const around: number[][] = verts.map(() => [])
  faces.forEach((face, faceIndex) => {
    for (const index of face) around[index].push(faceIndex)
  })
  const pentagons = around.map((faceIndexes, vertIndex) => {
    const outward = normalize(verts[vertIndex])
    const helper = Math.abs(outward.y) < 0.9 ? { x: 0, y: 1, z: 0 } : { x: 1, y: 0, z: 0 }
    const xAxis = normalize(cross(helper, outward))
    const yAxis = cross(outward, xAxis)
    return faceIndexes
      .map((faceIndex) => ({
        faceIndex,
        angle: Math.atan2(dot(centers[faceIndex], yAxis), dot(centers[faceIndex], xAxis)),
      }))
      .sort((left, right) => left.angle - right.angle)
      .map(({ faceIndex }) => faceIndex)
  })
  return { verts: centers, faces: pentagons }
}

const DODECA = dodecahedron()

const tetrahedron = (): { verts: V3[]; faces: number[][] } => {
  const verts = [
    { x: 1, y: 1, z: 1 },
    { x: 1, y: -1, z: -1 },
    { x: -1, y: 1, z: -1 },
    { x: -1, y: -1, z: 1 },
  ].map(normalize)
  const faces = [
    [0, 1, 2],
    [0, 2, 3],
    [0, 3, 1],
    [1, 3, 2],
  ].map((face) => orientOutward(verts, face))
  return { verts, faces }
}

const TETRA = tetrahedron()

const octahedron = (): { verts: V3[]; faces: number[][] } => {
  const verts: V3[] = [
    { x: 1, y: 0, z: 0 },
    { x: -1, y: 0, z: 0 },
    { x: 0, y: 1, z: 0 },
    { x: 0, y: -1, z: 0 },
    { x: 0, y: 0, z: 1 },
    { x: 0, y: 0, z: -1 },
  ]
  const faces: number[][] = []
  for (const x of [0, 1]) {
    for (const y of [2, 3]) {
      for (const z of [4, 5]) faces.push(orientOutward(verts, [x, y, z]))
    }
  }
  return { verts, faces }
}

const OCTA = octahedron()

const CUBE_VERTS: V3[] = [
  { x: -1, y: -1, z: -1 },
  { x: 1, y: -1, z: -1 },
  { x: 1, y: 1, z: -1 },
  { x: -1, y: 1, z: -1 },
  { x: -1, y: -1, z: 1 },
  { x: 1, y: -1, z: 1 },
  { x: 1, y: 1, z: 1 },
  { x: -1, y: 1, z: 1 },
]

const CUBE_FACES: number[][] = [
  [4, 5, 6, 7],
  [0, 3, 2, 1],
  [1, 2, 6, 5],
  [0, 4, 7, 3],
  [3, 7, 6, 2],
  [0, 1, 5, 4],
]

const splitSegments = (points: Pt[], segmentFront: boolean[]): Poly[] => {
  const polys: Poly[] = []
  let start = 0
  for (let index = 1; index <= segmentFront.length; index += 1) {
    if (index === segmentFront.length || segmentFront[index] !== segmentFront[start]) {
      const pts = points.slice(start, index + 1)
      if (pts.length >= 2) polys.push({ pts, dashed: !segmentFront[start] })
      start = index
    }
  }
  return polys
}

const depthCurves = (cam: V3[]): Poly[] => {
  const points = cam.map(screenOf)
  const flags: boolean[] = []
  for (let index = 1; index < cam.length; index += 1) {
    flags.push((cam[index - 1].z + cam[index].z) * 0.5 > 0.012)
  }
  return splitSegments(points, flags)
}

const normalCurves = (cam: V3[], normals: V3[], yaw: number, pitch: number): Poly[] => {
  const points = cam.map(screenOf)
  const turned = normals.map((normal) => rotate(normal, yaw, pitch))
  const flags: boolean[] = []
  for (let index = 1; index < turned.length; index += 1) {
    flags.push((turned[index - 1].z + turned[index].z) * 0.5 > 0.012)
  }
  return splitSegments(points, flags)
}

const spherePoint = (lat: number, lon: number): V3 => {
  const cosLat = Math.cos(lat)
  return { x: cosLat * Math.cos(lon), y: Math.sin(lat), z: cosLat * Math.sin(lon) }
}

const projectLines = (rows: { pts: V3[]; dashed?: boolean }[], yaw: number, pitch: number): Poly[] => (
  rows.map((row) => ({
    pts: row.pts.map((point) => screenOf(rotate(point, yaw, pitch))),
    dashed: row.dashed,
  }))
)

const axisArrow = (from: V3, to: V3): V3[][] => {
  const dir = normalize(sub(to, from))
  const helper = Math.abs(dir.y) < 0.9 ? { x: 0, y: 1, z: 0 } : { x: 1, y: 0, z: 0 }
  const side = normalize(cross(dir, helper))
  const up = cross(side, dir)
  const back = add(to, scaleV(dir, -0.2))
  return [
    [from, to],
    [to, add(back, scaleV(side, 0.08))],
    [to, add(back, scaleV(side, -0.08))],
    [to, add(back, scaleV(up, 0.08))],
  ]
}

const planeOf = (id: MathFigureId, p: Record<string, number>): Poly[] => {
  switch (id) {
    case 'circle':
      return [loop(circlePts(0, 0, 1))]
    case 'ellipse':
      return [loop(circlePts(0, 0, 1, p.aspect))]
    case 'semicircle':
      return [loop([...circlePts(0, 0, 1, 1, Math.PI, Math.PI * 2), { x: -1, y: 0 }])]
    case 'ring':
      return [loop(circlePts(0, 0, 1)), loop(circlePts(0, 0, p.inner))]
    case 'sector': {
      const span = p.degrees * Math.PI / 180
      const arc = circlePts(0, 0, 1, 1, -Math.PI / 2 - span / 2, -Math.PI / 2 + span / 2)
      return [loop([{ x: 0, y: 0 }, ...arc])]
    }
    case 'arc': {
      const span = p.degrees * Math.PI / 180
      return [line(circlePts(0, 0, 1, 1, -Math.PI / 2 - span / 2, -Math.PI / 2 + span / 2))]
    }
    case 'triangle':
      return [loop([{ x: 0, y: -0.95 }, { x: 0.9, y: 0.75 }, { x: -0.9, y: 0.75 }])]
    case 'right-triangle':
      return [
        loop([{ x: -1, y: 0.8 }, { x: 1, y: 0.8 }, { x: -1, y: -0.9 }]),
        line([{ x: -0.62, y: 0.8 }, { x: -0.62, y: 0.42 }, { x: -1, y: 0.42 }]),
      ]
    case 'square':
      return [loop([{ x: -0.85, y: -0.85 }, { x: 0.85, y: -0.85 }, { x: 0.85, y: 0.85 }, { x: -0.85, y: 0.85 }])]
    case 'rectangle':
      return [loop([{ x: -1, y: -p.aspect }, { x: 1, y: -p.aspect }, { x: 1, y: p.aspect }, { x: -1, y: p.aspect }])]
    case 'rhombus':
      return [loop([{ x: 0, y: -1 }, { x: 0.72, y: 0 }, { x: 0, y: 1 }, { x: -0.72, y: 0 }])]
    case 'parallelogram':
      return [loop([
        { x: -0.85 + p.skew, y: -0.7 },
        { x: 0.95 + p.skew, y: -0.7 },
        { x: 0.85 - p.skew, y: 0.7 },
        { x: -0.95 - p.skew, y: 0.7 },
      ])]
    case 'trapezoid':
      return [loop([
        { x: -1, y: 0.7 },
        { x: 1, y: 0.7 },
        { x: p.top, y: -0.7 },
        { x: -p.top, y: -0.7 },
      ])]
    case 'kite':
      return [loop([{ x: 0, y: -1 }, { x: 0.62, y: 0.15 }, { x: 0, y: 0.75 }, { x: -0.62, y: 0.15 }])]
    case 'polygon': {
      const sides = Math.max(3, Math.round(p.sides))
      const pts: Pt[] = []
      for (let index = 0; index <= sides; index += 1) {
        const angle = -Math.PI / 2 + (index / sides) * Math.PI * 2
        pts.push({ x: Math.cos(angle), y: Math.sin(angle) })
      }
      return [loop(pts)]
    }
    case 'star': {
      const count = Math.round(p.points)
      const pts: Pt[] = []
      for (let index = 0; index <= count * 2; index += 1) {
        const radius = index % 2 === 0 ? 1 : 0.42
        const angle = -Math.PI / 2 + (index / (count * 2)) * Math.PI * 2
        pts.push({ x: Math.cos(angle) * radius, y: Math.sin(angle) * radius })
      }
      return [loop(pts)]
    }
    case 'arrow':
      return [
        line([{ x: -1, y: 0 }, { x: 0.45, y: 0 }]),
        ...arrowHead({ x: 1, y: 0 }, { x: 1, y: 0 }, 0.55).map((pts) => line(pts)),
        line([{ x: 0.45, y: -0.32 }, { x: 1, y: 0 }, { x: 0.45, y: 0.32 }]),
      ]
    case 'double-arrow':
      return [
        line([{ x: -0.55, y: 0 }, { x: 0.55, y: 0 }]),
        line([{ x: -0.45, y: -0.28 }, { x: -1, y: 0 }, { x: -0.45, y: 0.28 }]),
        line([{ x: 0.45, y: -0.28 }, { x: 1, y: 0 }, { x: 0.45, y: 0.28 }]),
      ]
    case 'angle': {
      const turn = p.degrees * Math.PI / 180
      return [
        line([{ x: 0, y: 0 }, { x: 1.15, y: 0 }]),
        line([{ x: 0, y: 0 }, { x: Math.cos(-turn) * 1.15, y: Math.sin(-turn) * 1.15 }]),
        line(circlePts(0, 0, 0.42, 0.42, -turn, 0, 24)),
      ]
    }
    case 'axes': {
      const polys: Poly[] = [
        line([{ x: -1.15, y: 0 }, { x: 1.05, y: 0 }]),
        line([{ x: 0, y: 1.05 }, { x: 0, y: -1.15 }]),
        ...arrowHead({ x: 1.2, y: 0 }, { x: 1, y: 0 }).map((pts) => line(pts)),
        ...arrowHead({ x: 0, y: -1.2 }, { x: 0, y: -1 }).map((pts) => line(pts)),
      ]
      const ticks = Math.round(p.ticks)
      for (let index = 1; index <= ticks; index += 1) {
        const t = index / (ticks + 1)
        polys.push(line([{ x: -1 + t * 2, y: -0.06 }, { x: -1 + t * 2, y: 0.06 }]))
        polys.push(line([{ x: -0.06, y: 0.9 - t * 1.8 }, { x: 0.06, y: 0.9 - t * 1.8 }]))
      }
      return polys
    }
    case 'number-line': {
      const ticks = Math.round(p.ticks)
      const polys: Poly[] = [line([{ x: -1.2, y: 0 }, { x: 1.05, y: 0 }]), ...arrowHead({ x: 1.25, y: 0 }, { x: 1, y: 0 }).map((pts) => line(pts))]
      for (let index = 0; index <= ticks; index += 1) {
        const x = -1 + (index / ticks) * 2
        polys.push(line([{ x, y: -0.12 }, { x, y: 0.12 }]))
      }
      return polys
    }
    case 'parabola':
      return [line(samples(32, (t) => {
        const x = -1 + t * 2
        return { x, y: -x * x }
      }))]
    case 'sine':
      return [
        line([{ x: -1.05, y: 0 }, { x: 1.05, y: 0 }]),
        line(samples(72, (t) => ({
          x: -1 + t * 2,
          y: -Math.sin(t * p.waves * Math.PI * 2) * p.amplitude,
        }))),
      ]
    case 'grid': {
      const cells = Math.round(p.cells)
      const polys: Poly[] = []
      for (let index = 0; index <= cells; index += 1) {
        const t = -1 + (index / cells) * 2
        polys.push(line([{ x: t, y: -1 }, { x: t, y: 1 }]))
        polys.push(line([{ x: -1, y: t }, { x: 1, y: t }]))
      }
      return polys
    }
    case 'venn':
      return [loop(circlePts(-0.48, 0, 0.82)), loop(circlePts(0.48, 0, 0.82))]
    case 'parallel':
      return [
        line([{ x: -1.2, y: -0.42 }, { x: 1.2, y: -0.42 }]),
        line([{ x: -1.2, y: 0.42 }, { x: 1.2, y: 0.42 }]),
        line([{ x: -0.55, y: 1.05 }, { x: 0.4, y: -1.05 }]),
      ]
    case 'chord':
      return [
        loop(circlePts(0, 0, 1)),
        line([{ x: Math.cos(2.4), y: Math.sin(2.4) }, { x: Math.cos(0.7), y: Math.sin(0.7) }]),
      ]
    case 'tangent':
      return [
        loop(circlePts(0, 0, 1)),
        line([{ x: 0, y: 0 }, { x: 1, y: 0 }]),
        line([{ x: 1, y: -1.25 }, { x: 1, y: 1.25 }]),
      ]
    case 'diameter':
      return [loop(circlePts(0, 0, 1)), line([{ x: -1, y: 0 }, { x: 1, y: 0 }])]
    case 'cube-net': {
      const cell = 1
      const origins: Pt[] = [
        { x: 1, y: 0 },
        { x: 0, y: 1 }, { x: 1, y: 1 }, { x: 2, y: 1 }, { x: 3, y: 1 },
        { x: 1, y: 2 },
      ]
      return origins.map((origin) => loop([
        origin,
        { x: origin.x + cell, y: origin.y },
        { x: origin.x + cell, y: origin.y + cell },
        { x: origin.x, y: origin.y + cell },
      ]))
    }
    case 'cross':
      return [loop([
        { x: -0.28, y: -1 }, { x: 0.28, y: -1 }, { x: 0.28, y: -0.28 }, { x: 1, y: -0.28 },
        { x: 1, y: 0.28 }, { x: 0.28, y: 0.28 }, { x: 0.28, y: 1 }, { x: -0.28, y: 1 },
        { x: -0.28, y: 0.28 }, { x: -1, y: 0.28 }, { x: -1, y: -0.28 }, { x: -0.28, y: -0.28 },
      ])]
    case 'vector':
      return [
        line([{ x: -1, y: 0.35 }, { x: 0.55, y: -0.55 }]),
        line([{ x: 0.15, y: -0.72 }, { x: 0.85, y: -0.85 }, { x: 0.42, y: -0.15 }]),
      ]
    default:
      return []
  }
}

const solidOf = (id: MathFigureId, p: Record<string, number>): Poly[] => {
  const yaw = p.yaw ?? 35
  const pitch = p.pitch ?? 24
  switch (id) {
    case 'cube':
      return wire(CUBE_VERTS, CUBE_FACES, yaw, pitch)
    case 'cuboid':
      return wire(CUBE_VERTS.map((vert) => ({
        x: vert.x * p.width,
        y: vert.y * p.height,
        z: vert.z * p.depth,
      })), CUBE_FACES, yaw, pitch)
    case 'tetrahedron':
      return wire(TETRA.verts, TETRA.faces, yaw, pitch)
    case 'octahedron':
      return wire(OCTA.verts, OCTA.faces, yaw, pitch)
    case 'icosahedron':
      return wire(ICOSA.verts, ICOSA.faces, yaw, pitch)
    case 'dodecahedron':
      return wire(DODECA.verts, DODECA.faces, yaw, pitch)
    case 'square-pyramid':
      return pyramid(4, yaw, pitch)
    case 'pentagonal-pyramid':
      return pyramid(5, yaw, pitch)
    case 'hexagonal-pyramid':
      return pyramid(6, yaw, pitch)
    case 'triangular-prism': {
      const mesh = prismFaces(3)
      return wire(mesh.verts, mesh.faces, yaw, pitch)
    }
    case 'pentagonal-prism': {
      const mesh = prismFaces(5)
      return wire(mesh.verts, mesh.faces, yaw, pitch)
    }
    case 'hexagonal-prism': {
      const mesh = prismFaces(6)
      return wire(mesh.verts, mesh.faces, yaw, pitch)
    }
    case 'cylinder': {
      const mesh = prismFaces(Math.round(p.segments))
      return wire(mesh.verts, mesh.faces, yaw, pitch)
    }
    case 'cone':
      return pyramid(Math.round(p.segments), yaw, pitch)
    case 'frustum': {
      const mesh = prismFaces(Math.round(p.segments), p.ratio)
      return wire(mesh.verts, mesh.faces, yaw, pitch)
    }
    case 'sphere':
    case 'hemisphere': {
      const meridians = Math.round(p.meridians)
      const upper = id === 'hemisphere'
      const polys: Poly[] = []
      for (let index = 0; index < meridians; index += 1) {
        const lon = (index / meridians) * Math.PI * 2
        const cam: V3[] = []
        const steps = 28
        for (let step = 0; step <= steps; step += 1) {
          const lat = upper
            ? (step / steps) * (Math.PI / 2)
            : -Math.PI / 2 + (step / steps) * Math.PI
          cam.push(rotate(spherePoint(lat, lon), yaw, pitch))
        }
        polys.push(...depthCurves(cam))
      }
      const parallelCount = upper ? 2 : Math.round(p.parallels ?? 4)
      for (let band = 1; band < parallelCount; band += 1) {
        const lat = upper
          ? (band / parallelCount) * (Math.PI / 2)
          : -Math.PI / 2 + (band / parallelCount) * Math.PI
        const cam: V3[] = []
        for (let step = 0; step <= 48; step += 1) {
          cam.push(rotate(spherePoint(lat, (step / 48) * Math.PI * 2), yaw, pitch))
        }
        polys.push(...depthCurves(cam))
      }
      if (upper) {
        const equator: V3[] = []
        for (let step = 0; step <= 56; step += 1) equator.push(rotate(spherePoint(0, (step / 56) * Math.PI * 2), yaw, pitch))
        polys.push({ pts: equator.map(screenOf) })
      } else {
        const silhouette: Pt[] = []
        for (let step = 0; step <= 64; step += 1) {
          const t = (step / 64) * Math.PI * 2
          silhouette.push({ x: Math.cos(t), y: -Math.sin(t) })
        }
        polys.push(loop(silhouette))
      }
      return polys
    }
    case 'torus': {
      const rings = Math.round(p.rings)
      const tubeSteps = 10
      const major = 1
      const minor = p.tube
      const polys: Poly[] = []
      const at = (theta: number, phi: number): V3 => {
        const radius = major + minor * Math.cos(phi)
        return { x: radius * Math.cos(theta), y: minor * Math.sin(phi), z: radius * Math.sin(theta) }
      }
      const normalAt = (theta: number, phi: number): V3 => ({
        x: Math.cos(phi) * Math.cos(theta),
        y: Math.sin(phi),
        z: Math.cos(phi) * Math.sin(theta),
      })
      for (let index = 0; index < rings; index += 1) {
        const theta = (index / rings) * Math.PI * 2
        const cam: V3[] = []
        const normals: V3[] = []
        for (let step = 0; step <= tubeSteps; step += 1) {
          const phi = (step / tubeSteps) * Math.PI * 2
          cam.push(rotate(at(theta, phi), yaw, pitch))
          normals.push(normalAt(theta, phi))
        }
        polys.push(...normalCurves(cam, normals, yaw, pitch))
      }
      for (let step = 0; step < tubeSteps; step += 1) {
        const phi = (step / tubeSteps) * Math.PI * 2
        const cam: V3[] = []
        const normals: V3[] = []
        for (let index = 0; index <= rings; index += 1) {
          const theta = (index / rings) * Math.PI * 2
          cam.push(rotate(at(theta, phi), yaw, pitch))
          normals.push(normalAt(theta, phi))
        }
        polys.push(...normalCurves(cam, normals, yaw, pitch))
      }
      return polys
    }
    case 'axes-3d': {
      const rows: { pts: V3[]; dashed?: boolean }[] = []
      const tips = [
        { x: 1.25, y: 0, z: 0 },
        { x: 0, y: 1.25, z: 0 },
        { x: 0, y: 0, z: 1.25 },
      ]
      for (const tip of tips) {
        for (const pts of axisArrow({ x: 0, y: 0, z: 0 }, tip)) rows.push({ pts })
        rows.push({ pts: [scaleV(tip, -0.45), { x: 0, y: 0, z: 0 }], dashed: true })
      }
      return projectLines(rows, yaw, pitch)
    }
    case 'plane': {
      const cells = Math.round(p.cells)
      const rows: { pts: V3[] }[] = []
      for (let index = 0; index <= cells; index += 1) {
        const t = -1 + (index / cells) * 2
        rows.push({ pts: [{ x: t, y: 0, z: -1 }, { x: t, y: 0, z: 1 }] })
        rows.push({ pts: [{ x: -1, y: 0, z: t }, { x: 1, y: 0, z: t }] })
      }
      for (const pts of axisArrow({ x: 0, y: 0, z: 0 }, { x: 0, y: 0.85, z: 0 })) rows.push({ pts })
      return projectLines(rows, yaw, pitch)
    }
    default:
      return []
  }
}

export const mathFigurePaths = (id: string, params?: Record<string, number> | null): string[] => {
  if (!isMathFigureId(id)) return []
  const values = clampFigureParams(id, params ?? {})
  const figure = mathFigureById(id)
  const polys = figure.group === 'solid' ? solidOf(id, values) : planeOf(id, values)
  return emit(polys)
}
