// Study annotations on a note page: callout labels, stamps, legends, reference
// images, freehand branch highlights and angle/distance measurements.
// Stored in the .famd payload as `annotations`. Coordinates are fractions (0-1)
// of one PDF page (page 1 on plain notes), the same space as text fields.
// Shared by the renderer (TypeScript) and the Electron main process.

export const ANNOTATION_LIMIT = 600
export const ANNOTATION_IMAGE_LIMIT = 12
export const ANNOTATION_IMAGE_MAX_CHARS = 1_600_000
export const ANNOTATION_TEXT_MAX = 400
export const ANNOTATION_TERMS_MAX = 80
export const ANNOTATION_STROKE_POINTS_MAX = 600

export const STAMPS = [
  { id: 'gain', glyph: '▲', label: 'gewonnen', color: '#16a34a' },
  { id: 'loss', glyph: '✕', label: 'verloren / reduziert', color: '#dc2626' },
  { id: 'event', glyph: '●', label: 'Ereignis', color: '#2563eb' },
  { id: 'dot-red', glyph: '●', label: 'rot', color: '#dc2626' },
  { id: 'dot-green', glyph: '●', label: 'grün', color: '#16a34a' },
  { id: 'dot-yellow', glyph: '●', label: 'gelb', color: '#eab308' },
  { id: 'letter-h', glyph: 'H', label: 'hemimetabol', color: '#9333ea' },
  { id: 'letter-v', glyph: 'V', label: 'holometabol', color: '#ea580c' },
  { id: 'letter-a', glyph: 'A', label: 'ametabol', color: '#0891b2' },
  { id: 'check', glyph: '✓', label: 'trifft zu', color: '#16a34a' },
]
const STAMP_IDS = new Set(STAMPS.map((stamp) => stamp.id))
export const stampById = (id) => STAMPS.find((stamp) => stamp.id === id) ?? null

const KINDS = new Set(['callout', 'stamp', 'legend', 'image', 'stroke', 'measure', 'terms'])
const ID = /^[a-zA-Z0-9._-]{1,96}$/u
const COLOR = /^#[0-9a-fA-F]{6}$/u

const num = (value, fallback) => {
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? n : fallback
}
const unit = (value, fallback) => Math.min(1, Math.max(0, num(value, fallback)))
const clamp = (value, min, max, fallback) => Math.min(max, Math.max(min, num(value, fallback)))
const page = (value) => {
  const p = num(value, 1)
  return Number.isSafeInteger(p) && p >= 1 && p <= 10_000 ? p : 1
}
const color = (value, fallback) => (typeof value === 'string' && COLOR.test(value) ? value.toLowerCase() : fallback)
const text = (value, max = ANNOTATION_TEXT_MAX) => (typeof value === 'string' ? value.slice(0, max) : '')

export const newAnnotationId = () => `an-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`

const points = (value, min, max) => {
  if (!Array.isArray(value)) return []
  const out = []
  for (const entry of value) {
    if (!Array.isArray(entry) || entry.length < 2) continue
    const x = num(entry[0], NaN)
    const y = num(entry[1], NaN)
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue
    out.push([Math.round(unit(x, 0) * 10000) / 10000, Math.round(unit(y, 0) * 10000) / 10000])
    if (out.length >= max) break
  }
  return out.length >= min ? out : []
}

export const sanitizeAnnotation = (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const raw = value
  if (typeof raw.kind !== 'string' || !KINDS.has(raw.kind)) return null
  const id = typeof raw.id === 'string' && ID.test(raw.id) ? raw.id : newAnnotationId()
  switch (raw.kind) {
    case 'callout': {
      const ax = unit(raw.ax, 0.5)
      const ay = unit(raw.ay, 0.5)
      const number = Number.isSafeInteger(raw.num) && raw.num >= 1 && raw.num <= 999 ? raw.num : undefined
      return {
        kind: 'callout', id, page: page(raw.page), ax, ay,
        lx: unit(raw.lx, ax), ly: unit(raw.ly, ay),
        text: text(raw.text, 120), color: color(raw.color, '#1d4ed8'),
        ...(number ? { num: number } : {}),
      }
    }
    case 'stamp': {
      const stamp = typeof raw.stamp === 'string' && STAMP_IDS.has(raw.stamp) ? raw.stamp : 'event'
      return { kind: 'stamp', id, page: page(raw.page), x: unit(raw.x, 0.5), y: unit(raw.y, 0.5), stamp, size: clamp(raw.size, 12, 64, 24) }
    }
    case 'legend': {
      const names = {}
      if (raw.names && typeof raw.names === 'object' && !Array.isArray(raw.names)) {
        for (const key of Object.keys(raw.names).slice(0, 40)) {
          if (STAMP_IDS.has(key) && typeof raw.names[key] === 'string') names[key] = text(raw.names[key], 60)
        }
      }
      return { kind: 'legend', id, page: page(raw.page), x: unit(raw.x, 0.6), y: unit(raw.y, 0.05), names }
    }
    case 'image': {
      const src = typeof raw.src === 'string' && /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/u.test(raw.src) && raw.src.length <= ANNOTATION_IMAGE_MAX_CHARS ? raw.src : ''
      if (!src) return null
      return {
        kind: 'image', id, page: page(raw.page), x: unit(raw.x, 0.1), y: unit(raw.y, 0.1),
        w: clamp(raw.w, 0.05, 1, 0.4), aspect: clamp(raw.aspect, 0.05, 20, 1),
        opacity: clamp(raw.opacity, 0.1, 1, 1), locked: raw.locked === true, src,
        title: text(raw.title, 80),
      }
    }
    case 'stroke': {
      const pts = points(raw.pts, 2, ANNOTATION_STROKE_POINTS_MAX)
      if (!pts.length) return null
      return { kind: 'stroke', id, page: page(raw.page), pts, color: color(raw.color, '#facc15'), width: clamp(raw.width, 2, 60, 18), opacity: clamp(raw.opacity, 0.1, 1, 0.4) }
    }
    case 'measure': {
      const mode = raw.mode === 'distance' ? 'distance' : 'angle'
      const pts = points(raw.pts, mode === 'angle' ? 3 : 2, mode === 'angle' ? 4 : 2)
      if (!pts.length) return null
      return { kind: 'measure', id, page: page(raw.page), mode, pts, color: color(raw.color, '#dc2626') }
    }
    case 'terms': {
      const list = []
      if (Array.isArray(raw.list)) {
        for (const entry of raw.list) {
          const term = text(entry, 60).trim()
          if (term && !list.includes(term)) list.push(term)
          if (list.length >= ANNOTATION_TERMS_MAX) break
        }
      }
      return { kind: 'terms', id: 'terms', list }
    }
    default:
      return null
  }
}

export const parseAnnotations = (value) => {
  if (!Array.isArray(value)) return []
  const seen = new Set()
  const out = []
  let images = 0
  for (const entry of value) {
    const item = sanitizeAnnotation(entry)
    if (!item || seen.has(item.id)) continue
    if (item.kind === 'image' && ++images > ANNOTATION_IMAGE_LIMIT) continue
    seen.add(item.id)
    out.push(item)
    if (out.length >= ANNOTATION_LIMIT) break
  }
  return out
}

/** True when the list holds anything worth saving (an empty word bank is not). */
export const annotationsHaveContent = (list) => (
  Array.isArray(list) && list.some((item) => item.kind !== 'terms' || (item.list?.length ?? 0) > 0)
)

// ---- geometry -------------------------------------------------------------

/** Interior angle at `vertex` between the rays to `a` and `b`, in degrees (0-180). */
export const angleAt = (vertex, a, b) => {
  const ux = a[0] - vertex[0]; const uy = a[1] - vertex[1]
  const vx = b[0] - vertex[0]; const vy = b[1] - vertex[1]
  const lu = Math.hypot(ux, uy); const lv = Math.hypot(vx, vy)
  if (lu < 1e-9 || lv < 1e-9) return 0
  const cos = Math.min(1, Math.max(-1, (ux * vx + uy * vy) / (lu * lv)))
  return (Math.acos(cos) * 180) / Math.PI
}

/** Angle between two infinite lines (a1-a2) and (b1-b2), 0-90 degrees. */
export const angleBetweenLines = (a1, a2, b1, b2) => {
  const da = Math.atan2(a2[1] - a1[1], a2[0] - a1[0])
  const db = Math.atan2(b2[1] - b1[1], b2[0] - b1[0])
  let diff = Math.abs((da - db) * 180 / Math.PI) % 180
  if (diff > 90) diff = 180 - diff
  return diff
}

/** Points are page fractions; `pageSize` is the page width/height in the unit wanted (cm). */
export const distanceOf = (a, b, pageSize) => Math.hypot((a[0] - b[0]) * pageSize.width, (a[1] - b[1]) * pageSize.height)

export const measureValue = (item, pageSize) => {
  // Page fractions are not isotropic; scale to real units before measuring angles.
  const real = item.pts.map((p) => [p[0] * pageSize.width, p[1] * pageSize.height])
  if (item.mode === 'distance') return Math.hypot(real[0][0] - real[1][0], real[0][1] - real[1][1])
  if (real.length >= 4) return angleBetweenLines(real[0], real[1], real[2], real[3])
  return angleAt(real[1], real[0], real[2])
}

export const formatMeasure = (item, value) => (
  item.mode === 'distance' ? `${value.toFixed(1).replace('.', ',')} cm` : `${Math.round(value * 10) / 10}°`.replace('.', ',')
)

/** Next free number for numbered labels. */
export const nextCalloutNumber = (list) => (
  list.reduce((max, item) => (item.kind === 'callout' && item.num ? Math.max(max, item.num) : max), 0) + 1
)

/** Renumber callouts 1..n in reading order (page, then top to bottom, left to right). */
export const renumberCallouts = (list) => {
  const numbered = list.filter((item) => item.kind === 'callout' && item.num)
    .sort((p, q) => p.page - q.page || p.ly - q.ly || p.lx - q.lx)
  const map = new Map(numbered.map((item, index) => [item.id, index + 1]))
  return list.map((item) => (map.has(item.id) ? { ...item, num: map.get(item.id) } : item))
}

/** Legend rows: used stamps with their (possibly renamed) meaning, then numbered labels. */
export const legendRows = (list, names = {}) => {
  const rows = []
  const seen = new Set()
  for (const item of list) {
    if (item.kind !== 'stamp' || seen.has(item.stamp)) continue
    seen.add(item.stamp)
    const def = stampById(item.stamp)
    if (def) rows.push({ key: item.stamp, glyph: def.glyph, color: def.color, label: names[item.stamp] || def.label })
  }
  const numbered = list.filter((item) => item.kind === 'callout' && item.num).sort((p, q) => p.num - q.num)
  for (const item of numbered) rows.push({ key: item.id, glyph: String(item.num), color: item.color, label: item.text })
  return rows
}

/** Split pasted/selected PDF text into word-bank terms. */
export const termsFromText = (raw) => {
  if (typeof raw !== 'string') return []
  const out = []
  for (const part of raw.split(/[\n\r;,•·]+/u)) {
    const term = part.replace(/\s+/gu, ' ').trim().replace(/^[-–—:.\d)]+\s*/u, '').slice(0, 60)
    if (term.length >= 2 && !out.includes(term)) out.push(term)
  }
  return out.slice(0, ANNOTATION_TERMS_MAX)
}

// ---- undo/redo (own stack; ink keeps its own) ------------------------------

export const createAnnotationHistory = (limit = 100) => ({ past: [], future: [], limit })
export const pushAnnotationHistory = (history, snapshot) => ({
  ...history, past: [...history.past, snapshot].slice(-history.limit), future: [],
})
export const undoAnnotations = (history, current) => (
  history.past.length
    ? { history: { ...history, past: history.past.slice(0, -1), future: [...history.future, current] }, list: history.past.at(-1) }
    : null
)
export const redoAnnotations = (history, current) => (
  history.future.length
    ? { history: { ...history, past: [...history.past, current], future: history.future.slice(0, -1) }, list: history.future.at(-1) }
    : null
)
