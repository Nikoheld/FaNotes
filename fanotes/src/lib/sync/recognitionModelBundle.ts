/** Opt-in handwriting model carried as one encrypted sync file. */

export const RECOGNITION_BUNDLE_VERSION = 1
export const MAX_RECOGNITION_BUNDLE_BYTES = 20 * 1024 * 1024

export type RecognitionCorrection = { from: string; to: string }

export type RecognitionModelBundle = {
  version: 1
  exportedAt: string
  samples: unknown[]
  layouts: unknown[]
  labels: unknown[]
  corrections: RecognitionCorrection[]
}

const isRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
)

const asList = (value: unknown, max: number) => (Array.isArray(value) ? value.slice(0, max) : [])

export const emptyRecognitionBundle = (at = new Date().toISOString()): RecognitionModelBundle => ({
  version: RECOGNITION_BUNDLE_VERSION,
  exportedAt: at,
  samples: [],
  layouts: [],
  labels: [],
  corrections: [],
})

export const parseRecognitionBundle = (raw: string): RecognitionModelBundle | null => {
  if (typeof raw !== 'string' || raw.length > MAX_RECOGNITION_BUNDLE_BYTES) return null
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!isRecord(parsed) || parsed.version !== 1) return null
    const corrections = asList(parsed.corrections, 2_000).flatMap((entry) => {
      if (!isRecord(entry) || typeof entry.from !== 'string' || typeof entry.to !== 'string') return []
      const from = entry.from.trim().slice(0, 80)
      const to = entry.to.trim().slice(0, 80)
      return from && to ? [{ from, to }] : []
    })
    return {
      version: 1,
      exportedAt: typeof parsed.exportedAt === 'string' ? parsed.exportedAt : new Date().toISOString(),
      samples: asList(parsed.samples, 20_000),
      layouts: asList(parsed.layouts, 4_000),
      labels: asList(parsed.labels, 2_000),
      corrections,
    }
  } catch {
    return null
  }
}

export const serializeRecognitionBundle = (bundle: RecognitionModelBundle) => `${JSON.stringify(bundle)}\n`

export const rememberCorrection = (bundle: RecognitionModelBundle, from: string, to: string): RecognitionModelBundle => {
  const source = from.trim().slice(0, 80)
  const target = to.trim().slice(0, 80)
  if (!source || !target || source === target) return bundle
  const corrections = [
    ...bundle.corrections.filter((entry) => entry.from.toLocaleLowerCase('de-DE') !== source.toLocaleLowerCase('de-DE')),
    { from: source, to: target },
  ].slice(-2_000)
  return { ...bundle, corrections, exportedAt: new Date().toISOString() }
}

export const correctionFor = (bundle: RecognitionModelBundle | null, word: string) => {
  if (!bundle) return null
  const needle = word.trim().toLocaleLowerCase('de-DE')
  const hit = [...bundle.corrections].reverse().find((entry) => entry.from.toLocaleLowerCase('de-DE') === needle)
  return hit?.to ?? null
}
