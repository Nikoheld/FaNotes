/**
 * Open path for a heavy `.famd` ink layer.
 *
 * v2 keeps every sample in one JSON string. Parsing that string is fine on a
 * worker. Building a JavaScript object per sample and then stringifying it
 * again is what freezes the window. Above `INK_PACK_POINTS`, the open result
 * keeps samples in a Float64 column (`x, y, pressure, t, tiltX, tiltY`; NaN
 * means the field was absent) and the drawing JSON only names each stroke.
 * The board restores a slice of objects per frame and paints that slice.
 */

import { POINT_STRIDE, FamdCorruptError, decode85 } from './famdV2.mjs'

export const INK_PACK_POINTS = 8000
export const INK_FRAME_BUDGET_MS = 6
export const INK_COLUMN_STRIDE = 6
/** Files at least this long are parsed off the Electron main thread. */
export const FAMD_ASYNC_CHARS = 256 * 1024

const POINT_KEYS = new Set(['x', 'y', 't', 'pressure', 'tiltX', 'tiltY', 'pointerType'])

export const frameBudgetOpen = (startedAt, now, finishedUnits, budgetMs = INK_FRAME_BUDGET_MS) => (
  finishedUnits < 1 || now - startedAt < budgetMs
)

const finiteOrNaN = (value) => (
  typeof value === 'number' && Number.isFinite(value) ? value : Number.NaN
)

const isEmptyStroke = (value) => (
  !!value && typeof value === 'object' && !Array.isArray(value) && Array.isArray(value.points) && value.points.length === 0
)

const isInkStroke = (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  if (typeof value.famdPts === 'string') return true
  if (!Array.isArray(value.points) || value.points.length === 0) return false
  const point = value.points[0]
  return !!point && typeof point === 'object' && Number.isFinite(Number(point.x)) && Number.isFinite(Number(point.y))
}

const isStrokeList = (value) => {
  if (!Array.isArray(value) || value.length === 0) return false
  let strokes = 0
  for (const entry of value) {
    if (isInkStroke(entry)) strokes += 1
    else if (!isEmptyStroke(entry)) return false
  }
  return strokes > 0
}

const pointCountOf = (stroke) => {
  if (typeof stroke.famdPts === 'string') {
    if (stroke.famdPts.length % 5 !== 0) return 0
    return (stroke.famdPts.length / 5) * 4 / POINT_STRIDE
  }
  return Array.isArray(stroke.points) ? stroke.points.length : 0
}

const pushPoint = (sink, point) => {
  sink.push(
    finiteOrNaN(point?.x),
    finiteOrNaN(point?.y),
    finiteOrNaN(point?.pressure),
    finiteOrNaN(point?.t),
    finiteOrNaN(point?.tiltX),
    finiteOrNaN(point?.tiltY),
  )
}

const pushPackedPoints = (sink, stroke) => {
  const bytes = decode85(stroke.famdPts)
  if (bytes.length % POINT_STRIDE !== 0) {
    const error = new Error('famd v2 point block length')
    error.code = 'FAMD_CORRUPT'
    throw error
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const count = bytes.length / POINT_STRIDE
  for (let index = 0; index < count; index += 1) {
    const offset = index * POINT_STRIDE
    const pressure = view.getFloat64(offset + 4, true)
    const time = view.getFloat64(offset + 12, true)
    const tiltX = view.getFloat64(offset + 20, true)
    const tiltY = view.getFloat64(offset + 28, true)
    sink.push(
      view.getUint16(offset, true) / 65535,
      view.getUint16(offset + 2, true) / 65535,
      Number.isNaN(pressure) ? Number.NaN : pressure,
      Number.isNaN(time) ? Number.NaN : time,
      Number.isNaN(tiltX) ? Number.NaN : tiltX,
      Number.isNaN(tiltY) ? Number.NaN : tiltY,
    )
  }
  return count
}

const pointerPack = (stroke, count) => {
  if (typeof stroke.famdPtr === 'string') return { ptr: stroke.famdPtr }
  if (Array.isArray(stroke.famdPtrList) && typeof stroke.famdPtrIdx === 'string') {
    const raw = decode85(stroke.famdPtrIdx)
    if (raw.length < count) throw new FamdCorruptError('famd v2 pointer index')
    const ptrs = []
    for (let index = 0; index < count; index += 1) {
      const code = raw[index]
      if (code === 255) {
        ptrs.push(null)
        continue
      }
      const name = stroke.famdPtrList[code]
      if (typeof name !== 'string') throw new FamdCorruptError('famd v2 pointer index')
      ptrs.push(name)
    }
    return { ptrs }
  }
  if (!Array.isArray(stroke.points)) return {}
  const types = stroke.points.map((point) => (
    point && typeof point.pointerType === 'string' ? point.pointerType : null
  ))
  if (types.every((type) => type == null)) return {}
  const first = types[0]
  if (types.every((type) => type === first)) return { ptr: first }
  return { ptrs: types }
}

const extraPack = (stroke, count) => {
  if (Array.isArray(stroke.famdPtExtra)) {
    const extra = stroke.famdPtExtra.slice(0, count)
    return extra.some((entry) => entry && typeof entry === 'object') ? extra : null
  }
  if (!Array.isArray(stroke.points)) return null
  const extra = []
  let any = false
  for (const point of stroke.points) {
    if (!point || typeof point !== 'object') {
      extra.push(null)
      continue
    }
    const rest = {}
    for (const key of Object.keys(point)) {
      if (POINT_KEYS.has(key)) continue
      rest[key] = point[key]
    }
    if (Object.keys(rest).length) {
      extra.push(rest)
      any = true
    } else extra.push(null)
  }
  return any ? extra : null
}

const slimStroke = (stroke, sink) => {
  const at = sink.length / INK_COLUMN_STRIDE
  const count = typeof stroke.famdPts === 'string'
    ? pushPackedPoints(sink, stroke)
    : (Array.isArray(stroke.points) ? (stroke.points.forEach((point) => pushPoint(sink, point)), stroke.points.length) : 0)
  const meta = {}
  for (const key of Object.keys(stroke)) {
    if (key === 'points' || key === 'famdPts' || key === 'famdPtExtra' || key === 'famdPtr' || key === 'famdPtrList' || key === 'famdPtrIdx') continue
    meta[key] = stroke[key]
  }
  const open = { at, n: count, ...pointerPack(stroke, count) }
  const extra = extraPack(stroke, count)
  if (extra) open.extra = extra
  meta.famdOpen = open
  return meta
}

const slimValue = (value, sink) => {
  if (Array.isArray(value)) {
    if (isStrokeList(value)) return value.map((stroke) => (isInkStroke(stroke) ? slimStroke(stroke, sink) : stroke))
    return value.map((entry) => slimValue(entry, sink))
  }
  if (!value || typeof value !== 'object') return value
  const next = {}
  for (const key of Object.keys(value)) next[key] = slimValue(value[key], sink)
  return next
}

/** `null` when the ink is small enough to keep as ordinary JSON. */
export const packInk = (ink) => {
  if (!ink || typeof ink !== 'object' || Array.isArray(ink)) return null
  const sink = []
  const slim = slimValue(ink, sink)
  const pointCount = sink.length / INK_COLUMN_STRIDE
  if (pointCount < INK_PACK_POINTS) return null
  return {
    slim,
    pointCount,
    packedInk: { stride: INK_COLUMN_STRIDE, columns: Float64Array.from(sink) },
  }
}

const columnsOf = (packed) => {
  const columns = packed?.columns
  if (packed?.stride !== INK_COLUMN_STRIDE || !columns || typeof columns.length !== 'number') return null
  if (columns instanceof Float64Array) return columns
  if (ArrayBuffer.isView(columns)) {
    const view = columns
    return new Float64Array(view.buffer, view.byteOffset, Math.floor(view.byteLength / 8))
  }
  // A structured clone can arrive as a list of numbers. Copy it once.
  if (columns.length % INK_COLUMN_STRIDE !== 0) return null
  try {
    return Float64Array.from(columns)
  } catch {
    return null
  }
}

const pointsFromOpen = (open, columns) => {
  const at = Number(open?.at)
  const count = Number(open?.n)
  if (!Number.isInteger(at) || at < 0 || !Number.isInteger(count) || count < 0) {
    throw new Error('Die gepackte Handschrift ist unvollständig.')
  }
  if ((at + count) * INK_COLUMN_STRIDE > columns.length) {
    throw new Error('Die gepackte Handschrift ist unvollständig.')
  }
  const points = new Array(count)
  for (let index = 0; index < count; index += 1) {
    const offset = (at + index) * INK_COLUMN_STRIDE
    const point = { x: columns[offset], y: columns[offset + 1] }
    const pressure = columns[offset + 2]
    const time = columns[offset + 3]
    const tiltX = columns[offset + 4]
    const tiltY = columns[offset + 5]
    if (!Number.isNaN(pressure)) point.pressure = pressure
    if (!Number.isNaN(time)) point.t = time
    if (!Number.isNaN(tiltX)) point.tiltX = tiltX
    if (!Number.isNaN(tiltY)) point.tiltY = tiltY
    if (typeof open.ptr === 'string') point.pointerType = open.ptr
    else if (Array.isArray(open.ptrs) && typeof open.ptrs[index] === 'string') point.pointerType = open.ptrs[index]
    const extra = Array.isArray(open.extra) ? open.extra[index] : null
    if (extra && typeof extra === 'object') Object.assign(point, extra)
    points[index] = point
  }
  return points
}

const expandValue = (value, columns) => {
  if (Array.isArray(value)) return value.map((entry) => expandValue(entry, columns))
  if (!value || typeof value !== 'object') return value
  if (value.famdOpen && typeof value.famdOpen === 'object') {
    const next = {}
    for (const key of Object.keys(value)) {
      if (key === 'famdOpen') continue
      next[key] = value[key]
    }
    next.points = pointsFromOpen(value.famdOpen, columns)
    return next
  }
  const next = {}
  for (const key of Object.keys(value)) next[key] = expandValue(value[key], columns)
  return next
}

/** Restores point objects. Safe for a document that was never packed. */
export const expandPackedInk = (ink, packed) => {
  if (!packed) return ink
  const columns = columnsOf(packed)
  if (!columns) throw new Error('Die gepackte Handschrift ist unvollständig.')
  return expandValue(ink, columns)
}

/** One stroke, so a page can come back a slice at a time. */
export const expandPackedStroke = (stroke, packed) => {
  if (!stroke || typeof stroke !== 'object' || !stroke.famdOpen) return stroke
  const columns = columnsOf(packed)
  if (!columns) throw new Error('Die gepackte Handschrift ist unvollständig.')
  return expandValue(stroke, columns)
}

export const countWalkPoints = (value, seen = new Set()) => {
  if (!value || typeof value !== 'object') return 0
  if (seen.has(value)) return 0
  if (Array.isArray(value)) {
    if (isStrokeList(value)) {
      return value.reduce((total, stroke) => total + (isInkStroke(stroke) ? pointCountOf(stroke) : 0), 0)
    }
    return value.reduce((total, entry) => total + countWalkPoints(entry, seen), 0)
  }
  seen.add(value)
  if (value.famdOpen && Number.isFinite(Number(value.famdOpen.n))) return Number(value.famdOpen.n)
  return Object.keys(value).reduce((total, key) => total + countWalkPoints(value[key], seen), 0)
}
