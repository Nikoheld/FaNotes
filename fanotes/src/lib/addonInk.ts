/** Strokes an add-on may write. The host merges them into the note's ink document. */

export type AddonInkPoint = { x: number; y: number }
export type AddonInkStroke = { color: string; points: AddonInkPoint[] }

const clamp = (value: number) => Math.min(1, Math.max(0, value))

export const sanitizeAddonStrokes = (value: unknown): AddonInkStroke[] | null => {
  if (!Array.isArray(value) || value.length > 2_000) return null
  const strokes: AddonInkStroke[] = []
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') return null
    const raw = entry as { color?: unknown; points?: unknown }
    if (!Array.isArray(raw.points) || raw.points.length < 1 || raw.points.length > 8_000) return null
    const points: AddonInkPoint[] = []
    for (const point of raw.points) {
      if (!point || typeof point !== 'object') return null
      const candidate = point as { x?: unknown; y?: unknown }
      if (typeof candidate.x !== 'number' || typeof candidate.y !== 'number') return null
      if (!Number.isFinite(candidate.x) || !Number.isFinite(candidate.y)) return null
      points.push({ x: clamp(candidate.x), y: clamp(candidate.y) })
    }
    const color = typeof raw.color === 'string' && /^#[0-9a-f]{6}$/iu.test(raw.color) ? raw.color : '#202333'
    strokes.push({ color, points })
  }
  return strokes
}

export const inkDocumentWithStrokes = (
  existingJson: string | null,
  strokes: readonly AddonInkStroke[],
  mode: 'append' | 'replace',
) => {
  let base: Record<string, unknown> = { schemaVersion: 1, strokes: [] }
  if (existingJson) {
    try {
      const parsed = JSON.parse(existingJson) as unknown
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) base = parsed as Record<string, unknown>
    } catch {
      base = { schemaVersion: 1, strokes: [] }
    }
  }
  const current = mode === 'replace' || !Array.isArray(base.strokes) ? [] : base.strokes
  const next = strokes.map((stroke) => ({
    color: stroke.color,
    points: stroke.points.map((point) => ({ x: point.x, y: point.y, pressure: 0.5 })),
  }))
  return JSON.stringify({ ...base, strokes: [...current, ...next] })
}
