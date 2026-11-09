import { inkGeometryEpoch } from './strokeBounds'

/**
 * `JSON.stringify` of a drawing document, with each stroke's JSON kept from
 * the previous save. An autosave of a 320k-sample note stringified every point
 * on the page's thread: about 0.2–0.3 s after each pause in writing. A
 * committed stroke does not change, so only new strokes are written out again.
 *
 * Reusing a stroke's text needs the same points array, the same geometry
 * epoch (a page grow or rescale moves points in place), the same count, and
 * the same two running sums over every sample. Any difference writes that
 * stroke again, so a missed in-place change costs time, not ink.
 */
type CachedStroke = { epoch: number; length: number; sumA: number; sumB: number; json: string }

const cache = new WeakMap<object, CachedStroke>()
const STROKES_KEY = '"strokes":[]'

type JsonPoint = { x?: unknown; y?: unknown; t?: unknown; pressure?: unknown }

const pointSums = (points: readonly JsonPoint[]) => {
  let sumA = 0
  let sumB = 0
  for (let index = 0; index < points.length; index += 1) {
    const point = points[index]
    const x = point.x as number
    const y = point.y as number
    sumA += x + y * 3.1 + (point.t as number) * 1e-7 + (point.pressure as number) * 0.37
    sumB += (x - y) * (index + 1)
  }
  return { sumA, sumB }
}

/** The stroke's `JSON.stringify` text. */
export const strokeJson = (stroke: unknown): string => {
  if (!stroke || typeof stroke !== 'object') return JSON.stringify(stroke) ?? 'null'
  const points = (stroke as { points?: unknown }).points
  if (!Array.isArray(points)) return JSON.stringify(stroke)
  const epoch = inkGeometryEpoch()
  const { sumA, sumB } = pointSums(points as JsonPoint[])
  const cached = cache.get(points)
  // `===`: a NaN sum (a missing time or pressure) never counts as the same.
  if (cached && cached.epoch === epoch && cached.length === points.length && cached.sumA === sumA && cached.sumB === sumB) {
    return cached.json
  }
  const json = JSON.stringify(stroke)
  cache.set(points, { epoch, length: points.length, sumA, sumB, json })
  return json
}

/** Byte-for-byte `JSON.stringify(drawing)` for a document whose `strokes` is an array of objects. */
export const drawingDocumentJson = (drawing: { strokes: readonly unknown[] } & Record<string, unknown>): string => {
  if (!Array.isArray(drawing.strokes)) return JSON.stringify(drawing)
  const shell = JSON.stringify({ ...drawing, strokes: [] })
  // Inside a JSON string every quote is escaped, so this sequence is the
  // document's own `strokes` key: it comes before `sections` and `inkHistory`.
  const at = shell.indexOf(STROKES_KEY)
  if (at < 0) return JSON.stringify(drawing)
  let body = '"strokes":['
  for (let index = 0; index < drawing.strokes.length; index += 1) {
    if (index > 0) body += ','
    body += strokeJson(drawing.strokes[index])
  }
  return `${shell.slice(0, at)}${body}]${shell.slice(at + STROKES_KEY.length)}`
}
