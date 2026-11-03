/** Local trajectory learning. No transcript is inferred from page text/search metadata. */
export const MODEL_VERSION = 2
export const MAX_PAGE_OBSERVATIONS = 48
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))
export const median = (xs, fallback = 0) => xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] : fallback
const length = ps => ps.slice(1).reduce((s, p, i) => s + Math.hypot(p.x - ps[i].x, p.y - ps[i].y), 0)
export function bounds(strokes) {
  let x = Infinity, y = Infinity, right = -Infinity, bottom = -Infinity
  for (const s of strokes) for (const p of s.points) { x = Math.min(x, p.x); y = Math.min(y, p.y); right = Math.max(right, p.x); bottom = Math.max(bottom, p.y) }
  return [x, y, right - x, bottom - y]
}
export function fingerprint(value) {
  // Two independent 32 bit hashes; used for geometry identity, never authentication.
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  let a = 2166136261, b = 5381
  for (let i = 0; i < text.length; i++) { a = Math.imul(a ^ text.charCodeAt(i), 16777619); b = Math.imul(b, 33) ^ text.charCodeAt(i) }
  return `${(a >>> 0).toString(16)}${(b >>> 0).toString(16)}`
}
export const emptyPersonalModel = () => ({ version: MODEL_VERSION, revision: 0, pages: {} })
export function validModel(model) {
  try { return model?.version === MODEL_VERSION && (!model.population || ['height','slant','pressure','pressureSpread','nibRatio','baseline','joinRate','gap','wordGap','speed'].every(k => Number.isFinite(model.population[k])) && model.population.height > 0 && model.population.nibRatio > 0) && Number.isSafeInteger(model.revision) && model.pages && typeof model.pages === 'object'
    && Object.values(model.pages).every(p => p && Array.isArray(p.observations) && p.observations.length <= MAX_PAGE_OBSERVATIONS
      && p.observations.every(o => ['height', 'slant', 'pressure', 'pressureSpread', 'nibRatio', 'baseline', 'joinRate', 'gap', 'wordGap', 'speed'].every(k => Number.isFinite(o[k])) && o.height > 0 && o.nibRatio > 0)
      && Array.isArray(p.units) && p.units.length <= 96 && p.units.every(u => u && typeof u.id === 'string' && typeof u.sessionId === 'string' && typeof u.label === 'string' && u.label.length <= 48
        && Number.isFinite(u.baseline) && u.baseline >= -.5 && u.baseline <= 2 && Array.isArray(u.bbox) && u.bbox.length === 4 && u.bbox.every(Number.isFinite)
        && u.bbox[2] > 0 && u.bbox[3] > 0 && u.sourceCanvas?.width > 0 && u.sourceCanvas?.height > 0 && Number.isFinite(u.sourceCanvas.width + u.sourceCanvas.height)
        && u.strokes?.length && u.strokes.length <= 64 && u.strokes.every(s => s.points?.length && s.points.length <= 4096
          && s.points.every(q => [q.x, q.y, q.t, q.pressure].every(Number.isFinite))))
      && (!p.joins || (p.joins.length <= 32 && p.joins.every(j => j.points?.length === 17 && j.entry?.length === 2 && j.exit?.length === 2 && [...j.entry, ...j.exit].every(Number.isFinite) && j.points.every(q => [q.x, q.y, q.pressure, q.t].every(Number.isFinite))))))
  } catch { return false }
}
const isHuman = s => !s.synthesis && !s.symbolId && !s.figurePaths?.length && s.purpose !== 'art'
  && (!s.brush || ['fineliner', 'pencil', 'ballpoint', 'fountain'].includes(s.brush))
  && s.points?.length > 1 && s.points.length <= 20000
  && s.points.every(p => [p.x, p.y, p.pressure, p.t].every(Number.isFinite) && p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1)

/** Pixel-space segmentation. Normalized x/y must never be compared across rectangular sheets. */
export function extractWriting(document) {
  const w = document?.sourceWidth, h = document?.sourceHeight
  if (!(w > 0 && h > 0 && Number.isFinite(w + h))) return []
  const all = (document.strokes ?? []).filter(isHuman).slice(0, 20000).map(s => {
    // Retain pressure/timing, bound CPU and storage. Endpoints are always kept.
    const step = Math.max(1, Math.ceil(s.points.length / 2048))
    const points = s.points.filter((_, i) => i % step === 0 || i === s.points.length - 1).map(p => ({ ...p, x: p.x * w, y: p.y * h }))
    const stroke = { ...s, points }, box = bounds([stroke])
    return { stroke, box }
  }).filter(({ stroke, box: b }) => b[3] >= 1 && b[3] <= 180 && b[2] <= 1400 && length(stroke.points) > 3
    && length(stroke.points) < Math.max(60, Math.hypot(b[2], b[3]) * 35))
  const body = all.filter(s => s.box[3] >= 6 && s.box[2] / s.box[3] < 25)
  const typical = median(body.map(s => s.box[3]), 24)
  const lines = []
  for (const item of body.sort((a, b) => a.box[1] - b.box[1])) {
    const cy = item.box[1] + item.box[3] / 2
    let line = lines.find(l => Math.abs(l.cy - cy) < Math.max(typical * .6, Math.min(item.box[3], l.height) * .65))
    if (!line) { line = { cy, height: item.box[3], items: [] }; lines.push(line) }
    line.items.push(item); line.cy = median(line.items.map(s => s.box[1] + s.box[3] / 2)); line.height = median(line.items.map(s => s.box[3]))
  }
  // Attach delayed dots and crossbars by geometry, retaining their original stroke order.
  for (const item of all.filter(s => !body.includes(s))) {
    const line = lines.filter(l => item.box[1] > l.cy - typical * 1.4 && item.box[1] < l.cy + typical * .8)
      .sort((a, b) => Math.abs(a.cy - item.box[1]) - Math.abs(b.cy - item.box[1]))[0]
    if (line && item.box[2] < typical * 1.2) line.items.push(item)
  }
  const words = []
  for (const line of lines) {
    const sorted = line.items.sort((a, b) => a.box[0] - b.box[0])
    const groups = []; let group = [], right = -Infinity
    for (const item of sorted) {
      if (item.box[0] - right > typical * .65 && group.length) { groups.push(group); group = [] }
      group.push(item); right = Math.max(group.length === 1 ? -Infinity : right, item.box[0] + item.box[2])
    }
    if (group.length) groups.push(group)
    const bottoms = groups.map(g => Math.max(...g.map(s => s.box[1] + s.box[3])))
    const baseline = median(bottoms)
    for (let i = 0; i < groups.length; i++) {
      const strokes = groups[i].map(s => s.stroke).sort((a, b) => a.points[0].t - b.points[0].t)
      const b = bounds(strokes)
      if (strokes.length === 1 && b[2] < b[3] * 1.7) continue
      if (strokes.length === 1 && length(strokes[0].points) < Math.hypot(b[2], b[3]) * 1.15) continue
      if (b[3] < 6 || b[3] > typical * 2.8 || b[2] < 3 || b[2] / b[3] > 25 || strokes.length > 64) continue
      const next = groups[i + 1]
      words.push({ strokes, bbox: b, baseline, nextGap: next ? Math.max(0, next[0].box[0] - b[0] - b[2]) / typical : null })
    }
  }
  return words
}
function observation(word) {
  const { strokes, bbox: b } = word, ps = strokes.flatMap(s => s.points), slopes = [], speeds = []
  for (const s of strokes) for (let i = 1; i < s.points.length; i++) {
    const a = s.points[i - 1], p = s.points[i], dx = p.x - a.x, dy = p.y - a.y, dt = p.t - a.t
    if (Math.abs(dy) > 2 * Math.abs(dx) && Math.abs(dy) > .4) slopes.push(-dx / dy)
    if (dt > 0 && dt < 100) speeds.push(Math.hypot(dx, dy) / dt)
  }
  const pressure = median(ps.map(p => p.pressure), .5)
  const sorted = strokes.map(s => bounds([s])).sort((a, b) => a[0] - b[0])
  const gaps = sorted.slice(1).map((s, i) => (s[0] - sorted[i][0] - sorted[i][2]) / b[3]).filter(g => g >= 0 && g < .65)
  // A connected run is evidence only when a trajectory spans multiple x-height units.
  const connected = strokes.filter(s => { const q = bounds([s]); return q[2] > b[3] * 1.7 && length(s.points) > b[3] * 3 })
  return {
    height: b[3], slant: clamp(median(slopes), -.45, .45), pressure: clamp(pressure, .08, 1),
    pressureSpread: clamp(median(ps.map(p => Math.abs(p.pressure - pressure))), 0, .3),
    nibRatio: clamp(median(strokes.map(s => s.baseWidth)) / b[3], .01, .25),
    baseline: clamp((b[1] + b[3] - word.baseline) / b[3], -.15, .15),
    joinRate: connected.length ? .85 : .1, gap: clamp(median(gaps, .1), .015, .3),
    wordGap: clamp(word.nextGap ?? .42, .25, 1.2), speed: clamp(median(speeds, .3), .05, 2),
  }
}
function resample(ps, count = 24) {
  if (ps.length === 1) return Array(count).fill(ps[0])
  const cumulative = [0]
  for (let i = 1; i < ps.length; i++) cumulative.push(cumulative[i - 1] + Math.hypot(ps[i].x - ps[i - 1].x, ps[i].y - ps[i - 1].y))
  let j = 1
  return Array.from({ length: count }, (_, i) => {
    const target = cumulative.at(-1) * i / (count - 1)
    while (j < ps.length - 1 && cumulative[j] < target) j++
    const t = (target - cumulative[j - 1]) / Math.max(1e-9, cumulative[j] - cumulative[j - 1])
    return { x: ps[j - 1].x + (ps[j].x - ps[j - 1].x) * t, y: ps[j - 1].y + (ps[j].y - ps[j - 1].y) * t }
  })
}
function signature(strokes) {
  const b = bounds(strokes)
  if (!(b[2] > 0 && b[3] > 0)) return null
  return strokes.map(s => resample(s.points.map(p => ({ x: (p.x - b[0]) / b[2], y: (p.y - b[1]) / b[3] }))))
}
/** Conservative local shape matching. Distances are errors, not calibrated OCR probabilities. */
export function recognizeWord(word, library) {
  const sorted = word.strokes.map(s => ({ s, b: bounds([s]) })).sort((a, b) => a.b[0] - b.b[0])
  const clusters = []; let right = -Infinity
  for (const item of sorted) {
    if (item.b[0] > right + word.bbox[3] * .035 || !clusters.length) clusters.push([])
    clusters.at(-1).push(item.s); right = Math.max(right, item.b[0] + item.b[2])
  }
  const templates = library.filter(s => [...s.label].length === 1 && !/context|auto-page/.test(s.sessionId))
  const hits = []
  for (const cluster of clusters) {
    cluster.sort((a, b) => a.points[0].t - b.points[0].t)
    const sig = signature(cluster)
    if (!sig) return null
    const byLabel = new Map()
    for (const sample of templates) {
      if (sample.strokes.length !== cluster.length) continue
      const target = signature(sample.strokes)
      if (!target) continue
      const distance = Math.sqrt(sig.reduce((total, path, j) => total + path.reduce((sum, p, i) => sum + (p.x - target[j][i].x) ** 2 + (p.y - target[j][i].y) ** 2, 0), 0) / (sig.length * 24))
      byLabel.set(sample.label, Math.min(byLabel.get(sample.label) ?? Infinity, distance))
    }
    const scores = [...byLabel].sort((a, b) => a[1] - b[1])
    if (!scores.length || scores[0][1] > .035 || (scores[1]?.[1] ?? 0) - scores[0][1] < .025) return null
    hits.push({ label: scores[0][0], strokes: cluster, distance: scores[0][1] })
  }
  return hits.length ? hits : null
}
function unit(label, strokes, baseline, id, context = '') {
  const b = bounds(strokes), scale = Math.max(b[3], 1)
  return { id, label, labelId: label, sessionId: 'auto-page-v2', context, bbox: [0, 0, 1, 1],
    sourceCanvas: { width: b[2] / scale, height: 1 }, baseline: (baseline - b[1]) / scale,
    strokes: strokes.map(s => ({ baseWidth: s.baseWidth / scale, pressureEnabled: s.pressureEnabled,
      points: s.points.map(p => ({ ...p, x: (p.x - b[0]) / Math.max(b[2], 1), y: (p.y - b[1]) / scale })) })) }
}
/** Self-supervised joining motions: short rightward runs near the writing baseline.
 * They carry geometry/pressure, never a guessed letter identity. */
export function joiningMotions(word) {
  const h = word.bbox[3], motions = []
  for (const stroke of word.strokes) {
    const ps = resampleFull(stroke.points, Math.min(256, Math.max(24, Math.ceil(length(stroke.points) / (h * .035)))))
    for (let i = 0; i + 5 < ps.length && motions.length < 12; i += 3) {
      const a = ps[i]
      if (a.y < word.bbox[1] + h * .52) continue
      let j = i + 1
      while (j < Math.min(ps.length, i + 18) && ps[j].x >= ps[j - 1].x - h * .008 && ps[j].x - a.x < h * .7) j++
      j--
      const b = ps[j], distance = Math.hypot(b.x - a.x, b.y - a.y)
      if (j - i < 4 || b.x - a.x < h * .16 || Math.abs(b.y - a.y) > h * .4 || distance > h * .8) continue
      const path = resampleFull(ps.slice(i, j + 1), 17)
      const points = path.map(p => ({ ...p, x: (p.x - a.x) / h, y: (p.y - a.y) / h, t: p.t - a.t }))
      const entry = [points[1].x, points[1].y], exit = [points.at(-1).x - points.at(-2).x, points.at(-1).y - points.at(-2).y]
      if (Math.hypot(...entry) < 1e-6 || Math.hypot(...exit) < 1e-6) continue
      motions.push({ points, entry, exit }); i = j - 1
    }
  }
  return motions
}
function resampleFull(ps, count) {
  const positions = resample(ps, count)
  return positions.map((p, i) => {
    const raw = ps[Math.min(ps.length - 1, Math.round(i * (ps.length - 1) / (count - 1)))]
    return { ...raw, ...p }
  })
}
export function learnPage(document, library = []) {
  const words = extractWriting(document), observations = [], units = [], joins = []
  // Stable, spatially distributed sampling: a long first paragraph cannot fill the entire budget.
  const stride = Math.max(1, Math.ceil(words.length / MAX_PAGE_OBSERVATIONS))
  for (let i = 0; i < words.length; i += stride) {
    const word = words[i]; observations.push(observation(word))
    joins.push(...joiningMotions(word).slice(0, Math.max(0, 32 - joins.length)))
    const hits = recognizeWord(word, library)
    if (!hits) continue
    const label = hits.map(h => h.label).join('')
    if (!/^[\p{L}\p{N}.,!?;:'"()\-+%=]+$/u.test(label) || label.length > 48) continue
    // Full words, pair/triplet trajectories and context-conditioned glyphs retain real spacing and pen lifts.
    const wordId = fingerprint(word.strokes)
    for (let start = 0; start < hits.length && units.length < 96; start++) {
      for (const count of [...new Set([1, 2, 3, hits.length])]) {
        if (start + count > hits.length || (count === hits.length && start > 0) || units.length >= 96) continue
        const part = hits.slice(start, start + count)
        const text = part.map(h => h.label).join('')
        const ps = part.flatMap(h => h.strokes).sort((a, b) => a.points[0].t - b.points[0].t)
        units.push(unit(text, ps, word.baseline, `${wordId}-${start}-${count}`, `${hits[start - 1]?.label ?? '^'}|${hits[start + count]?.label ?? '$'}`))
      }
    }
  }
  const boundedUnits = units.filter(u => u.baseline >= -.5 && u.baseline <= 2 && u.strokes.reduce((n, s) => n + s.points.length, 0) <= 768)
    .sort((a, b) => (a.context === '^|$' && a.label.length > 1 ? 0 : Math.min(a.label.length, 4)) - (b.context === '^|$' && b.label.length > 1 ? 0 : Math.min(b.label.length, 4)) || a.id.localeCompare(b.id)).slice(0, 16)
  return { fingerprint: fingerprint((document.strokes ?? []).filter(isHuman)), observations, units: boundedUnits, joins }
}
export function updatePersonalPage(model, id, contribution) {
  if (!validModel(model)) model = emptyPersonalModel()
  if (model.pages[id]?.fingerprint === contribution?.fingerprint) return model
  const pages = { ...model.pages }
  if (!contribution || (!contribution.observations.length && !contribution.units.length)) delete pages[id]
  else pages[id] = contribution
  const next = { version: MODEL_VERSION, revision: model.revision + 1, pages }
  if (!validModel(next)) throw new Error('Rejected invalid handwriting checkpoint')
  return next
}
export const STYLE_KEYS = ['height','slant','pressure','pressureSpread','nibRatio','baseline','joinRate','gap','wordGap','speed']
export function summarizeObservations(observations) {
  if (!observations.length) return null
  return Object.fromEntries(STYLE_KEYS.map(k => [k, median(observations.map(o => o[k]))]))
}
/** All pages inform the center; an empirical reservoir supplies correlated variation.
 * Held-out page geometry guards updates when enough independent pages exist.
 * This measures style reconstruction, never text accuracy or human similarity. */
export function fitPopulation(records, previous = null) {
  const seen = new Set()
  const all = records.filter(r => r.summary && !seen.has(r.fingerprint) && seen.add(r.fingerprint))
  const joined = all.filter(r => r.summary.joinRate > .5).length > all.length / 2
  const dominant = all.filter(r => (r.summary.joinRate > .5) === joined)
  if (!dominant.length) return { population: null, validation: null }
  const holdout = dominant.filter(r => parseInt(r.fingerprint.slice(0, 2), 16) % 5 === 0)
  const enough = holdout.length >= 2 && dominant.length - holdout.length >= 5
  const train = enough ? dominant.filter(r => !holdout.includes(r)) : dominant
  const candidate = summarizeObservations(train.map(r => r.summary))
  const scales = [24,.15,.3,.1,.1,.1,1,.1,.5,.5]
  const error = center => holdout.reduce((sum, r) => sum + STYLE_KEYS.reduce((n, k, i) => n + Math.abs(r.summary[k] - center[k]) / scales[i], 0), 0) / Math.max(1, holdout.length * STYLE_KEYS.length)
  const before = enough && previous ? error(previous) : null, after = enough ? error(candidate) : null
  const accepted = before === null || after <= before + 1e-9
  return { population: accepted ? candidate : previous, validation: { holdoutPages: enough ? holdout.length : 0, previousError: before, candidateError: after, accepted } }
}
export function personalStyle(model) {
  if (!validModel(model)) return { observations: [], units: [], joins: [], pageCount: 0 }
  // Duplicate geometry has one vote even when copied/renamed into several notes.
  const seen = new Set(), entries = Object.values(model.pages).filter(p => p.observations.length || p.units.length || p.joins?.length).filter(p => { if (seen.has(p.fingerprint)) return false; seen.add(p.fingerprint); return true })
  const all = entries.flatMap(p => p.observations)
  const height = median(all.map(o => o.height), 24)
  const observations = all.filter(o => o.height > height * .5 && o.height < height * 2)
  const joined = observations.filter(o => o.joinRate > .5).length > observations.length / 2
  const dominantGroup = observations.filter(o => (o.joinRate > .5) === joined)
  const dominant = median(dominantGroup.map(o => o.slant))
  const empirical = dominantGroup.filter(o => Math.abs(o.slant - dominant) < .2)
  const center = summarizeObservations(empirical)
  const adjusted = model.population && center ? empirical.map(o => Object.fromEntries(STYLE_KEYS.map(k => [k,
    k === 'height' ? o[k] * model.population[k] / Math.max(1, center[k]) : o[k] + model.population[k] - center[k]]))) : empirical
  return { observations: adjusted, units: entries.flatMap(p => p.units), joins: entries.flatMap(p => p.joins ?? []).slice(0, 128), pageCount: entries.length }
}

/**
 * A quintic Hermite splice with endpoint velocity and acceleration constraints.
 * It returns the whole continuous pen-down trajectory, never an overlay connector.
 * Reject infeasible joins instead of reversing strokes or adding long flourishes.
 */
export function spliceTrajectories(left, right, em, motions = []) {
  if (left.length < 3 || right.length < 3) return null
  const a = left.at(-1), b = right[0], dx = b.x - a.x, dy = b.y - a.y, gap = Math.hypot(dx, dy)
  if (dx < -em * .06 || dx > em * .65 || Math.abs(dy) > em * .4 || gap < .05) return null
  const tangent = (points, end) => {
    const p = end ? points.at(-1) : points[0]
    const candidates = end ? points.slice(0, -1).reverse() : points.slice(1)
    const q = candidates.find(q => Math.hypot(q.x - p.x, q.y - p.y) >= em * .035) ?? candidates.at(-1)
    const dx = (end ? p.x - q.x : q.x - p.x), dy = (end ? p.y - q.y : q.y - p.y), n = Math.hypot(dx, dy) || 1
    return { x: dx / n, y: dy / n }
  }
  const u = tangent(left, true), v = tangent(right, false)
  // Backward or nearly vertical exits characteristic of print should lift.
  if (u.x < .1 || v.x < .1 || (u.x * v.x + u.y * v.y) < -.5) return null
  const cosine = (a, b) => (a[0] * b[0] + a[1] * b[1]) / Math.max(1e-9, Math.hypot(...a) * Math.hypot(...b))
  const donor = motions.map(m => ({ motion: m, score: cosine(m.entry, [u.x, u.y]) + cosine(m.exit, [v.x, v.y]) }))
    .filter(m => m.score > 1.65).sort((a, b) => b.score - a.score)[0]?.motion
  const d = Math.min(em * .35, gap * .8)
  const accel = (ps, end) => {
    const q = end ? ps.slice(-3) : ps.slice(0, 3)
    const ta = tangent(q.slice(0, 2), true), tb = tangent(q.slice(1), true)
    const ds = (Math.hypot(q[1].x - q[0].x, q[1].y - q[0].y) + Math.hypot(q[2].x - q[1].x, q[2].y - q[1].y)) / 2
    return { x: clamp((tb.x - ta.x) / Math.max(ds, .1) * d * d, -em * .3, em * .3), y: clamp((tb.y - ta.y) / Math.max(ds, .1) * d * d, -em * .3, em * .3) }
  }
  const aa = accel(left, true), ab = accel(right, false)
  const coefficients = (p, q, v0, v1, a0, a1) => {
    const c0 = p, c1 = v0, c2 = a0 / 2, A = q - c0 - c1 - c2, B = v1 - c1 - 2 * c2, C = a1 - 2 * c2
    return [c0, c1, c2, 10 * A - 4 * B + C / 2, -15 * A + 7 * B - C, 6 * A - 3 * B + C / 2]
  }
  const cx = coefficients(a.x, b.x, u.x * d, v.x * d, aa.x, ab.x), cy = coefficients(a.y, b.y, u.y * d, v.y * d, aa.y, ab.y)
  const evaluate = (c, t) => c.reduceRight((s, x) => s * t + x, 0)
  const count = Math.max(12, Math.ceil(gap / .65)), bridge = []
  for (let i = 1; i < count; i++) {
    const t = i / count
    let residual = 0
    if (donor) {
      const position = t * 16, k = Math.min(15, Math.floor(position)), f = position - k
      const weights = [(1-f)**3/6, (3*f**3-6*f*f+4)/6, (-3*f**3+3*f*f+3*f+1)/6, f**3/6]
      const neighbors = [-1,0,1,2].map(offset => donor.points[clamp(k + offset, 0, 16)])
      const end = donor.points[16]
      const px = neighbors.reduce((sum, p, n) => sum + weights[n] * p.x, 0), py = neighbors.reduce((sum, p, n) => sum + weights[n] * p.y, 0)
      residual = (py * end.x - px * end.y) / Math.max(1e-6, end.x * end.x + end.y * end.y)
        * gap * .35 * 64 * t ** 3 * (1 - t) ** 3
    }
    const x = evaluate(cx, t) - dy / gap * residual, y = evaluate(cy, t) + dx / gap * residual
    if (x < a.x - em * .08 || x > b.x + em * .08 || y < Math.min(a.y, b.y) - em * .18 || y > Math.max(a.y, b.y) + em * .18) return null
    bridge.push({ ...a, x, y, t: a.t + (b.t - a.t) * t, pressure: a.pressure + (b.pressure - a.pressure) * (t * t * (3 - 2 * t)) })
  }
  if (length([a, ...bridge, b]) > Math.max(gap * 1.65, em * .12)) return null
  return [...left, ...bridge, ...right]
}
