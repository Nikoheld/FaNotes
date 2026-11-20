import type { StrokePoint } from '../../../src/types'
import type { PaperStyle } from '../types'

/**
 * Optional handwriting beautifier. Pure geometry, no DOM.
 *
 * Two gentle passes over freshly written text:
 *  1. shape-preserving smoothing of every stroke (corners, ends and dots stay),
 *  2. per-line normalisation: baseline slant, baseline-to-paper-line snap and
 *     a small nudge of letter height towards the line's median.
 * Everything is bounded, and anything that does not look like plain handwriting
 * (drawings, shapes, highlighter, math stamps, long lines) is left alone.
 */

export type BeautifyStrength = 'subtle' | 'medium'

export type BeautifyStroke = {
  points: StrokePoint[]
  pressureEnabled?: boolean
  purpose?: string
  brush?: string
  colorEffect?: string
  opacity?: number
  figureId?: unknown
  symbolId?: unknown
  graphExpression?: unknown
  figurePaths?: unknown
  graphPaths?: unknown
  synthesis?: unknown
}

export type BeautifyOptions = {
  /** Page size in page units; point coordinates are 0..1 of these. */
  pageWidth: number
  pageHeight: number
  strength: BeautifyStrength
  /** Paper line spacing in page units, or null when the paper has no rows to snap to. */
  paperStep: number | null
}

const A4_WIDTH_MM = 210
/** Smoothing never moves ink further than this (at medium strength). */
export const BEAUTIFY_MAX_SMOOTH_MM = 0.6
const CORNER_RAD = (50 * Math.PI) / 180

export const normalizeBeautifyStrength = (value: unknown): BeautifyStrength => (value === 'medium' ? 'medium' : 'subtle')

const factor = (strength: BeautifyStrength) => (strength === 'medium' ? 1 : 0.5)

/** Row spacing of the paper styles that have text rows, in page units. */
export const beautifyPaperStep = (style: PaperStyle, squareMm: number, pageWidth: number): number | null => {
  let mm: number
  if (style === 'lines' || style === 'dots') mm = 7.5
  else if (style === 'squares') mm = squareMm > 0 ? squareMm : 5
  else if (style === 'grid') mm = squareMm > 0 ? squareMm : 7.5
  else return null
  return Math.max(2, Math.round((pageWidth * mm) / A4_WIDTH_MM))
}

export const isBeautifyCandidate = (stroke: BeautifyStroke) => (
  stroke.purpose !== 'art'
  && (stroke.brush === undefined || stroke.brush === 'fineliner')
  && (stroke.colorEffect === undefined || stroke.colorEffect === 'solid')
  && (stroke.opacity === undefined || stroke.opacity >= 0.99)
  && stroke.figureId === undefined
  && stroke.symbolId === undefined
  && stroke.graphExpression === undefined
  && stroke.figurePaths === undefined
  && stroke.graphPaths === undefined
  && stroke.synthesis === undefined
  && stroke.points.length > 0
)

type Box = { x0: number; y0: number; x1: number; y1: number }

const boxOf = (points: readonly StrokePoint[], w: number, h: number): Box => {
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  for (const p of points) {
    const x = p.x * w
    const y = p.y * h
    if (x < x0) x0 = x
    if (x > x1) x1 = x
    if (y < y0) y0 = y
    if (y > y1) y1 = y
  }
  return { x0, y0, x1, y1 }
}

const median = (values: number[]) => {
  if (!values.length) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = sorted.length >> 1
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

const clamp = (value: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, value))

/**
 * Curvature-aware smoothing. Corners (turn > 50 degrees), the first and last
 * samples and tiny strokes (dots, ticks) are kept; the smoothing fades in away
 * from them. The result never strays further than `maxMm * strength` from the
 * original, and pressure is smoothed with the same fade.
 */
export const smoothStrokePoints = (
  points: readonly StrokePoint[],
  pageWidth: number,
  pageHeight: number,
  strength: BeautifyStrength,
  pressure = true,
): StrokePoint[] => {
  const n = points.length
  if (n < 6) return points.slice()
  const mm = pageWidth / A4_WIDTH_MM
  const s = factor(strength)
  const xs = points.map((p) => p.x * pageWidth)
  const ys = points.map((p) => p.y * pageHeight)
  let length = 0
  for (let i = 1; i < n; i += 1) length += Math.hypot(xs[i] - xs[i - 1], ys[i] - ys[i - 1])
  if (length < 1.5 * mm) return points.slice()

  // Corner detection with an arm of at least ~0.4 mm so jitter does not count.
  const minArm = 0.4 * mm
  const corner = new Array<boolean>(n).fill(false)
  for (let i = 1; i < n - 1; i += 1) {
    let a = i - 1
    while (a > 0 && Math.hypot(xs[i] - xs[a], ys[i] - ys[a]) < minArm) a -= 1
    let b = i + 1
    while (b < n - 1 && Math.hypot(xs[b] - xs[i], ys[b] - ys[i]) < minArm) b += 1
    const ux = xs[i] - xs[a]
    const uy = ys[i] - ys[a]
    const vx = xs[b] - xs[i]
    const vy = ys[b] - ys[i]
    if (!(ux || uy) || !(vx || vy)) continue
    const turn = Math.abs(Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy))
    if (turn > CORNER_RAD) corner[i] = true
  }
  // Fade factor: 0 at a corner or an end, 1 three samples away.
  const fade = new Array<number>(n).fill(1)
  let last = -100
  for (let i = 0; i < n; i += 1) {
    if (corner[i] || i === 0) last = i
    fade[i] = Math.min(fade[i], Math.min(1, (i - last) / 3))
  }
  last = 1000 + n
  for (let i = n - 1; i >= 0; i -= 1) {
    if (corner[i] || i === n - 1) last = i
    fade[i] = Math.min(fade[i], Math.min(1, (last - i) / 3))
  }

  const alpha = 0.35 + 0.35 * s
  let cx = xs
  let cy = ys
  for (let pass = 0; pass < 2; pass += 1) {
    const nx = cx.slice()
    const ny = cy.slice()
    for (let i = 1; i < n - 1; i += 1) {
      const wgt = fade[i] * alpha
      if (wgt <= 0) continue
      const lo = Math.max(0, i - 2)
      const hi = Math.min(n - 1, i + 2)
      let sx = 0
      let sy = 0
      let sw = 0
      for (let j = lo; j <= hi; j += 1) {
        const k = j === i ? 2 : 1
        sx += cx[j] * k
        sy += cy[j] * k
        sw += k
      }
      nx[i] = cx[i] + wgt * (sx / sw - cx[i])
      ny[i] = cy[i] + wgt * (sy / sw - cy[i])
    }
    cx = nx
    cy = ny
  }
  const bound = BEAUTIFY_MAX_SMOOTH_MM * mm * s
  const pr = points.map((p) => p.pressure)
  const smoothPressure = pressure && points.some((p) => p.pointerType === 'pen')
  return points.map((p, i) => {
    let dx = cx[i] - xs[i]
    let dy = cy[i] - ys[i]
    const d = Math.hypot(dx, dy)
    if (d > bound) {
      dx *= bound / d
      dy *= bound / d
    }
    let pressureOut = p.pressure
    if (smoothPressure && fade[i] > 0 && i > 0 && i < n - 1) {
      const avg = (pr[Math.max(0, i - 2)] + pr[i - 1] + 2 * pr[i] + pr[i + 1] + pr[Math.min(n - 1, i + 2)]) / 6
      pressureOut = clamp(pr[i] + 0.6 * s * (avg - pr[i]), 0, 1)
      pressureOut = clamp(pressureOut, pr[i] - 0.08, pr[i] + 0.08)
    }
    return { ...p, x: (xs[i] + dx) / pageWidth, y: (ys[i] + dy) / pageHeight, pressure: pressureOut }
  })
}

type LineEntry = { index: number; box: Box }

/** Rows of strokes: a stroke joins the row whose vertical extent it overlaps most. */
const groupRows = (entries: LineEntry[]): LineEntry[][] => {
  const rows: { items: LineEntry[]; y0: number; y1: number }[] = []
  for (const entry of [...entries].sort((a, b) => (a.box.y0 + a.box.y1) - (b.box.y0 + b.box.y1))) {
    const h = Math.max(1e-6, entry.box.y1 - entry.box.y0)
    let best: (typeof rows)[number] | null = null
    let bestOverlap = 0
    for (const row of rows) {
      const overlap = Math.min(row.y1, entry.box.y1) - Math.max(row.y0, entry.box.y0)
      const ratio = overlap / Math.min(h, row.y1 - row.y0 || h)
      if (ratio > 0.5 && overlap > bestOverlap) {
        best = row
        bestOverlap = overlap
      }
    }
    if (best) {
      best.items.push(entry)
      best.y0 = Math.min(best.y0, entry.box.y0)
      best.y1 = Math.max(best.y1, entry.box.y1)
    } else rows.push({ items: [entry], y0: entry.box.y0, y1: entry.box.y1 })
  }
  return rows.map((row) => row.items)
}

const theilSenSlope = (xs: number[], ys: number[]) => {
  const slopes: number[] = []
  for (let i = 0; i < xs.length; i += 1) {
    for (let j = i + 1; j < xs.length; j += 1) {
      const dx = xs[j] - xs[i]
      if (Math.abs(dx) > 1e-6) slopes.push((ys[j] - ys[i]) / dx)
    }
  }
  return median(slopes)
}

export type BeautifyResult = {
  /** Same length as the input: new points for a changed stroke, null when untouched. */
  points: (StrokePoint[] | null)[]
  changed: number
}

/**
 * Beautify `strokes` (the freshly written ones). Pure: returns new point
 * arrays and never mutates the input.
 */
export const beautifyInk = (strokes: readonly BeautifyStroke[], options: BeautifyOptions): BeautifyResult => {
  const { pageWidth: W, pageHeight: H, strength } = options
  const s = factor(strength)
  const mm = W / A4_WIDTH_MM
  const out: (StrokePoint[] | null)[] = strokes.map(() => null)
  const candidates: LineEntry[] = []
  strokes.forEach((stroke, index) => {
    if (!isBeautifyCandidate(stroke)) return
    const box = boxOf(stroke.points, W, H)
    // A long or tall single stroke is a drawing, a frame or an underline, not a letter.
    if (box.y1 - box.y0 > 16 * mm || box.x1 - box.x0 > 40 * mm) return
    candidates.push({ index, box })
  })

  for (const row of groupRows(candidates)) {
    const box: Box = {
      x0: Math.min(...row.map((e) => e.box.x0)),
      y0: Math.min(...row.map((e) => e.box.y0)),
      x1: Math.max(...row.map((e) => e.box.x1)),
      y1: Math.max(...row.map((e) => e.box.y1)),
    }
    const rowHeight = box.y1 - box.y0
    const heights = row.map((e) => e.box.y1 - e.box.y0)
    const medH = median(heights)
    // Plain writing: modest height, visible letters. Anything else is ambiguous.
    if (rowHeight > 16 * mm || medH < 1.2 * mm || medH > 9 * mm) continue
    const smoothed = new Map<number, StrokePoint[]>()
    for (const e of row) {
      const stroke = strokes[e.index]
      smoothed.set(e.index, smoothStrokePoints(stroke.points, W, H, strength, stroke.pressureEnabled !== false))
    }
    const current = new Map(smoothed)

    // Normalisation needs enough letters to know where the baseline is.
    const core = row.filter((e) => (e.box.y1 - e.box.y0) >= 0.45 * medH && (e.box.x1 - e.box.x0) < 30 * mm)
    if (core.length >= 3 && box.x1 - box.x0 >= 8 * mm) {
      const lineHeight = options.paperStep ?? medH * 1.6
      const maxMove = 0.25 * lineHeight
      const centers = core.map((e) => (e.box.x0 + e.box.x1) / 2)
      const bottoms = core.map((e) => e.box.y1)
      const spanX = Math.max(...centers) - Math.min(...centers)
      let angle = 0
      let pivotX = (box.x0 + box.x1) / 2
      let baselineAtPivot = median(bottoms)
      if (spanX >= 12 * mm) {
        const slope = theilSenSlope(centers, bottoms)
        const intercept = median(bottoms.map((b, i) => b - slope * centers[i]))
        const residual = median(bottoms.map((b, i) => Math.abs(b - (intercept + slope * centers[i]))))
        // A scattered baseline (descenders everywhere, a curve) is ambiguous.
        if (residual <= 0.25 * medH) {
          const maxAngle = (3 * Math.PI / 180) * s
          const raw = Math.atan(slope)
          if (Math.abs(raw) >= (0.4 * Math.PI) / 180) angle = clamp(raw, -maxAngle, maxAngle)
          pivotX = (box.x0 + box.x1) / 2
          baselineAtPivot = intercept + slope * pivotX
        }
      }
      const cos = Math.cos(-angle)
      const sin = Math.sin(-angle)
      // Baseline after the rotation (rotation about (pivotX, baselineAtPivot) keeps it there).
      let shift = 0
      if (options.paperStep) {
        const step = options.paperStep
        const target = Math.round(baselineAtPivot / step) * step
        const distance = target - baselineAtPivot
        if (target > 0 && Math.abs(distance) <= 0.25 * step * (0.6 + 0.4 * s)) shift = distance
      }
      const scaleLimit = 0.04 * s
      const coreSet = new Set(core.map((e) => e.index))
      for (const e of row) {
        const pts = current.get(e.index)!
        const h = e.box.y1 - e.box.y0
        const ratio = h / medH
        let scale = 1
        if (coreSet.has(e.index) && ratio >= 0.7 && ratio <= 1.4) scale = 1 + clamp((1 / ratio - 1) * 0.4, -scaleLimit, scaleLimit)
        const anchorX = (e.box.x0 + e.box.x1) / 2
        const anchorY = e.box.y1
        // Anchor after rotation.
        const ax = pivotX + (anchorX - pivotX) * cos - (anchorY - baselineAtPivot) * sin
        const ay = baselineAtPivot + (anchorX - pivotX) * sin + (anchorY - baselineAtPivot) * cos
        let transformed = pts.map((p) => {
          const x = p.x * W
          const y = p.y * H
          const rx = pivotX + (x - pivotX) * cos - (y - baselineAtPivot) * sin
          const ry = baselineAtPivot + (x - pivotX) * sin + (y - baselineAtPivot) * cos
          return { x: ax + (rx - ax) * scale, y: ay + (ry - ay) * scale + shift }
        })
        // Bound the line-level movement (relative to the unsmoothed original).
        let worst = 0
        transformed.forEach((q, i) => {
          const o = strokes[e.index].points[i]
          worst = Math.max(worst, Math.hypot(q.x - o.x * W, q.y - o.y * H))
        })
        if (worst > maxMove + BEAUTIFY_MAX_SMOOTH_MM * mm) {
          const k = (maxMove + BEAUTIFY_MAX_SMOOTH_MM * mm) / worst
          transformed = transformed.map((q, i) => {
            const o = strokes[e.index].points[i]
            return { x: o.x * W + (q.x - o.x * W) * k, y: o.y * H + (q.y - o.y * H) * k }
          })
        }
        current.set(e.index, pts.map((p, i) => ({ ...p, x: transformed[i].x / W, y: transformed[i].y / H })))
      }
    }
    current.forEach((pts, index) => {
      const old = strokes[index].points
      let moved = false
      for (let i = 0; i < pts.length; i += 1) {
        if (Math.abs(pts[i].x - old[i].x) > 1e-9 || Math.abs(pts[i].y - old[i].y) > 1e-9 || pts[i].pressure !== old[i].pressure) { moved = true; break }
      }
      if (moved) out[index] = pts
    })
  }
  return { points: out, changed: out.filter(Boolean).length }
}

/** Linear blend of two point lists of equal length, for the short settle animation. */
export const blendStrokePoints = (from: readonly StrokePoint[], to: readonly StrokePoint[], t: number): StrokePoint[] => (
  to.map((p, i) => {
    const a = from[i] ?? p
    return { ...p, x: a.x + (p.x - a.x) * t, y: a.y + (p.y - a.y) * t, pressure: a.pressure + (p.pressure - a.pressure) * t }
  })
)
