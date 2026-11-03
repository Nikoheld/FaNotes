/** CPU/RAM budgets are explicit. The tablet engine keeps its independent Kotlin policy. */
export const TABLET_LEARNING_POLICY = Object.freeze({ tag: 'tablet-v2', pages: 48, observations: 48, joins: 32, units: 16, unitPoints: 768, pagePoints: 12288, candidates: 96, recognitionPoints: 24, strokePoints: 2048, hotPoints: 589824, snapshotPoints: 589824, snapshotUnits: 1500, variants: 8, motions: 128, beamWidth: 1 })
export function desktopLearningPolicy({ cores = 4, memoryBytes = 8 * 1024 ** 3 } = {}) {
  const expanded = cores >= 4 && memoryBytes >= 8 * 1024 ** 3
  return Object.freeze({ tag: expanded ? 'desktop-expanded-v3' : 'desktop-balanced-v3', pages: expanded ? 192 : 96,
    observations: 96, joins: 64, units: expanded ? 96 : 48, unitPoints: expanded ? 2048 : 1536,
    pagePoints: expanded ? 12288 : 8192, candidates: expanded ? 768 : 384, recognitionPoints: 64, strokePoints: 4096,
    hotPoints: expanded ? 750000 : 300000, snapshotPoints: expanded ? 300000 : 160000,
    snapshotUnits: expanded ? 4096 : 2048, variants: 16, motions: expanded ? 512 : 256,
    beamWidth: expanded ? 16 : 8, heapMb: expanded ? 512 : 320 })
}
/** Balanced rounds preserve rare characters, contextual alternatives, and complete words. */
export function selectDiverseUnits(units, { maxUnits, pointBudget, variants = 16 }) {
  const groups = new Map(), seen = new Set()
  for (const u of units) {
    const identity = `${u.label}:${u.id}`
    if (seen.has(identity)) continue
    seen.add(identity)
    const group = groups.get(u.label) ?? []
    if (group.length < variants) group.push(u)
    groups.set(u.label, group)
  }
  const buckets = [...groups].sort((a,b) => Number([...a[0]].length > 1) - Number([...b[0]].length > 1) || a[0].localeCompare(b[0])).map(([,list]) => list)
  const result = [], selected = new Set(), counts = new Map(); let points = 0
  // Keep cohesive words before short-fragment coverage consumes a page's budget.
  for (const unit of units.filter(u => u.context === '^|$' && [...u.label].length > 1)) {
    const identity = `${unit.label}:${unit.id}`, count = unit.strokes.reduce((n,s) => n+s.points.length,0)
    if ((counts.get(unit.label) ?? 0) >= variants || selected.has(identity) || points+count > pointBudget*.4 || result.length >= Math.max(1,Math.floor(maxUnits*.4))) continue
    result.push(unit); selected.add(identity); counts.set(unit.label,(counts.get(unit.label) ?? 0)+1); points += count
  }
  for (let round = 0; round < variants && result.length < maxUnits; round++) for (const bucket of buckets) {
    const unit = bucket[round]
    if (!unit) continue
    const count = unit.strokes.reduce((n,s) => n + s.points.length, 0)
    const identity = `${unit.label}:${unit.id}`
    if ((counts.get(unit.label) ?? 0) >= variants || selected.has(identity) || points + count > pointBudget || result.length >= maxUnits) continue
    result.push(unit); selected.add(identity); counts.set(unit.label,(counts.get(unit.label) ?? 0)+1); points += count
  }
  return result
}
