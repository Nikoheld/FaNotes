/**
 * Personalization of the ink recognizer, entirely local:
 *
 * - Every inserted conversion stores its lines with the confirmed text (`recordInkConversion`)
 *   and the written words join the personal vocabulary of the decoder.
 * - With enough lines, `fitInkPersonalStyle` searches the rendering (pen width, slant, width,
 *   scale) under which the shipped model reads this writer best, scored on held-out lines.
 * - A fine-tuned personal model trained from the exported lines (see
 *   `fanotes/scripts/ink-model/personalize.py`) can be imported and switched on or off.
 */
import type { Stroke } from '../../../src/types'
import {
  DEFAULT_INK_STYLE,
  inkLineTextLoss,
  inkRecognitionAvailable,
  inkRecognitionManifest,
  normalizeInkText,
  recognizeInkSingleLine,
  setInkPersonalModelInstalled,
  setInkPersonalStyle,
  setInkPersonalVocabulary,
  type InkLanguage,
  type InkRecognitionResult,
  type InkStyle,
} from './inkRecognition'
import {
  clearInkPersonalData,
  countInkLineSamples,
  getInkPersonalProfile,
  listInkLineSamples,
  putInkLineSamples,
  putInkPersonalProfile,
  sanitizeInkLineSample,
  type InkLineSample,
  type InkPersonalProfile,
} from './inkPersonalStore'

/** State of the natively-stored fine-tuned personal model (`window.fanotes.inkPersonalModel`). */
export type InkPersonalModelState = {
  installed: boolean
  baseVersion: string | null
  currentBaseVersion: string | null
  compatible: boolean
  size: number | null
  name: string | null
  importedAt: string | null
  sampleCount: number | null
  errorBefore: number | null
  errorAfter: number | null
}

export const MIN_STYLE_LINES = 8
const STYLE_REFIT_STEP = 8
const MAX_STYLE_FIT_LINES = 24
const MAX_VOCABULARY = 20_000
const MAX_MODEL_BYTES = 80 * 1024 * 1024

const STYLE_AXES: Array<{ key: keyof InkStyle; values: number[] }> = [
  { key: 'penWidth', values: [1.8, 2.2, 2.6, 3.0, 3.5] },
  { key: 'extraShear', values: [-0.12, -0.06, 0, 0.06, 0.12] },
  { key: 'stretchX', values: [0.88, 0.94, 1, 1.08, 1.16] },
  { key: 'scale', values: [0.92, 1] },
]

let activation: Promise<InkPersonalProfile | null> | null = null
let fitting: Promise<InkPersonalProfile> | null = null

const emptyProfile = (modelVersion: string): InkPersonalProfile => ({
  key: 'profile',
  modelVersion,
  enabled: true,
  style: null,
  vocabulary: { de: [], en: [] },
  fittedOn: 0,
  fittedAt: '',
  errorBefore: null,
  errorAfter: null,
})

const personalModelState = async (): Promise<InkPersonalModelState | null> => {
  const native = window.fanotes.inkPersonalModel
  if (!native) return null
  try {
    return await native({ action: 'state' }) as InkPersonalModelState
  } catch {
    return null
  }
}

const applyProfile = (profile: InkPersonalProfile | null, model: InkPersonalModelState | null, version: string) => {
  const enabled = profile?.enabled ?? true
  setInkPersonalVocabulary('de', enabled ? profile?.vocabulary.de ?? [] : [])
  setInkPersonalVocabulary('en', enabled ? profile?.vocabulary.en ?? [] : [])
  setInkPersonalStyle(enabled && profile?.style && profile.modelVersion === version ? profile.style : null)
  setInkPersonalModelInstalled(enabled && Boolean(model?.installed && model.compatible))
}

/** Loads the stored personalization into the recognizer (once; cheap afterwards). */
export const activateInkPersonalization = async (_language?: InkLanguage) => {
  if (!inkRecognitionAvailable()) return null
  activation ??= (async () => {
    const [profile, model, manifest] = await Promise.all([
      getInkPersonalProfile(),
      personalModelState(),
      inkRecognitionManifest(),
    ])
    applyProfile(profile, model, manifest.version)
    return profile
  })().catch((error) => {
    activation = null
    throw error
  })
  return activation
}

const reactivate = () => {
  activation = null
  return activateInkPersonalization()
}

const wordsOf = (text: string, language: InkLanguage) => (
  normalizeInkText(text).toLocaleLowerCase(language === 'de' ? 'de-CH' : 'en-US').match(/\p{L}[\p{L}'-]*/gu) ?? []
).filter((word) => Array.from(word).length >= 2)

const mergedVocabulary = (current: string[], added: string[]) => {
  const merged = [...new Set([...added, ...current])]
  return merged.slice(0, MAX_VOCABULARY)
}

const lineStrokes = (strokes: Stroke[], indexes: number[]) => indexes
  .map((index) => strokes[index])
  .filter((stroke): stroke is Stroke => Boolean(stroke?.points.length))
  .map((stroke) => ({ baseWidth: stroke.baseWidth, pressureEnabled: stroke.pressureEnabled, points: stroke.points.map((point) => ({ ...point })) }))

const newId = () => `ink-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`

const updateProfile = async (change: (profile: InkPersonalProfile) => InkPersonalProfile) => {
  const manifest = await inkRecognitionManifest()
  const current = await getInkPersonalProfile() ?? emptyProfile(manifest.version)
  const next = change(current)
  await putInkPersonalProfile(next)
  return next
}

/**
 * Stores the lines of an inserted conversion with the text the user confirmed. Lines only pair
 * up when the confirmed text has as many lines as the reading; otherwise only the words are
 * kept. Returns true when anything was stored.
 */
export const recordInkConversion = async (
  result: InkRecognitionResult,
  strokes: Stroke[],
  confirmedText: string,
  language: InkLanguage,
  sourceWidth: number,
  sourceHeight: number,
) => {
  const confirmed = confirmedText.split(/\r?\n/u).map(normalizeInkText).filter(Boolean)
  const createdAt = new Date().toISOString()
  const samples: InkLineSample[] = confirmed.length === result.lines.length
    ? result.lines.flatMap((line, index) => {
      const text = confirmed[index]
      const lineInk = lineStrokes(strokes, line.strokeIndexes)
      if (!text || !lineInk.length) return []
      return [{
        id: newId(),
        text,
        language: line.language,
        strokes: lineInk,
        sourceWidth,
        sourceHeight,
        referenceHeight: result.referenceHeight,
        origin: text === normalizeInkText(line.text) ? 'confirmed' as const : 'correction' as const,
        createdAt,
      }]
    })
    : []
  await putInkLineSamples(samples)
  const words = wordsOf(confirmedText, language)
  if (words.length) {
    await updateProfile((profile) => ({
      ...profile,
      vocabulary: { ...profile.vocabulary, [language]: mergedVocabulary(profile.vocabulary[language], words) },
    }))
  }
  await reactivate()
  scheduleStyleRefit()
  return samples.length > 0 || words.length > 0
}

/** Lines written against a prompt in GlyphenWerk (already validated by the caller). */
export const addInkPromptSamples = async (values: unknown[]) => {
  const samples = values
    .map((value) => sanitizeInkLineSample(value, 'prompt'))
    .filter((sample): sample is InkLineSample => Boolean(sample))
  await putInkLineSamples(samples)
  for (const language of ['de', 'en'] as const) {
    const words = samples.filter((sample) => sample.language === language).flatMap((sample) => wordsOf(sample.text, language))
    if (words.length) {
      await updateProfile((profile) => ({
        ...profile,
        vocabulary: { ...profile.vocabulary, [language]: mergedVocabulary(profile.vocabulary[language], words) },
      }))
    }
  }
  await reactivate()
  scheduleStyleRefit()
  return samples.length
}

let refitTimer: ReturnType<typeof setTimeout> | null = null

const scheduleStyleRefit = () => {
  if (refitTimer !== null) clearTimeout(refitTimer)
  refitTimer = setTimeout(() => {
    refitTimer = null
    void (async () => {
      const [count, profile] = await Promise.all([countInkLineSamples(), getInkPersonalProfile()])
      if (count < MIN_STYLE_LINES || (profile && count - profile.fittedOn < STYLE_REFIT_STEP)) return
      await fitInkPersonalStyle()
    })().catch(() => undefined)
  }, 20_000)
}

const editDistance = (first: string, second: string) => {
  const a = Array.from(first)
  const b = Array.from(second)
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index)
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i]
    for (let j = 1; j <= b.length; j += 1) {
      current.push(Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + Number(a[i - 1] !== b[j - 1])))
    }
    previous = current
  }
  return previous[b.length]
}

const meanLoss = async (samples: InkLineSample[], style: InkStyle) => {
  let total = 0
  let counted = 0
  for (const sample of samples) {
    const output = await inkLineTextLoss(sample.strokes, sample.text, sample.sourceWidth, sample.sourceHeight, {
      referenceHeight: sample.referenceHeight,
      style,
    })
    if (output && Number.isFinite(output.loss)) {
      total += output.loss
      counted += 1
    }
  }
  return counted ? total / counted : Number.POSITIVE_INFINITY
}

const errorRate = async (samples: InkLineSample[], style: InkStyle) => {
  let edits = 0
  let characters = 0
  for (const sample of samples) {
    const decoded = await recognizeInkSingleLine(sample.strokes, sample.language, sample.sourceWidth, sample.sourceHeight, {
      referenceHeight: sample.referenceHeight,
      style,
    })
    if (!decoded) continue
    edits += editDistance(decoded.text, sample.text)
    characters += Array.from(sample.text).length
  }
  return characters ? (100 * edits) / characters : null
}

export type InkStyleFitProgress = { step: number; steps: number }

/**
 * Writer-adaptive rendering. Uses at most the last 24 confirmed lines; every fourth line is held
 * out to check that the fitted style reads unseen lines at least as well as the default.
 */
export const fitInkPersonalStyle = (onProgress?: (progress: InkStyleFitProgress) => void) => {
  fitting ??= (async () => {
    const manifest = await inkRecognitionManifest()
    const samples = (await listInkLineSamples()).slice(-(MAX_STYLE_FIT_LINES + MAX_STYLE_FIT_LINES / 3))
    if (samples.length < MIN_STYLE_LINES) {
      throw new Error(`Für die persönliche Anpassung braucht es mindestens ${MIN_STYLE_LINES} bestätigte Zeilen.`)
    }
    const heldOut = samples.length >= 12 ? samples.filter((_, index) => index % 4 === 3) : []
    const fitSet = samples.filter((sample) => !heldOut.includes(sample)).slice(-MAX_STYLE_FIT_LINES)
    const steps = 1 + STYLE_AXES.reduce((sum, axis) => sum + axis.values.length, 0) + (heldOut.length ? 2 : 0)
    let step = 0
    const tick = () => onProgress?.({ step: ++step, steps })
    let best: InkStyle = { ...DEFAULT_INK_STYLE }
    let bestLoss = await meanLoss(fitSet, best)
    tick()
    for (const axis of STYLE_AXES) {
      for (const value of axis.values) {
        if (value === best[axis.key]) {
          tick()
          continue
        }
        const trial = { ...best, [axis.key]: value }
        const loss = await meanLoss(fitSet, trial)
        if (loss < bestLoss * 0.995) {
          best = trial
          bestLoss = loss
        }
        tick()
      }
    }
    let errorBefore: number | null = null
    let errorAfter: number | null = null
    if (heldOut.length) {
      errorBefore = await errorRate(heldOut, DEFAULT_INK_STYLE)
      tick()
      errorAfter = await errorRate(heldOut, best)
      tick()
    }
    const accepted = errorBefore === null || errorAfter === null || errorAfter <= errorBefore
    const profile = await updateProfile((current) => ({
      ...current,
      modelVersion: manifest.version,
      style: accepted ? best : null,
      fittedOn: samples.length,
      fittedAt: new Date().toISOString(),
      errorBefore,
      errorAfter: accepted ? errorAfter : errorBefore,
    }))
    await reactivate()
    return profile
  })().finally(() => {
    fitting = null
  })
  return fitting
}

export const setInkPersonalizationEnabled = async (enabled: boolean) => {
  await updateProfile((profile) => ({ ...profile, enabled }))
  await reactivate()
}

export type InkPersonalizationSummary = {
  available: boolean
  lines: number
  corrections: number
  prompts: number
  enabled: boolean
  style: InkStyle | null
  vocabulary: number
  errorBefore: number | null
  errorAfter: number | null
  fittedAt: string
  model: InkPersonalModelState | null
  minimumLines: number
}

export const inkPersonalizationSummary = async (): Promise<InkPersonalizationSummary> => {
  const [samples, profile, model] = await Promise.all([
    listInkLineSamples(),
    getInkPersonalProfile(),
    personalModelState(),
  ])
  return {
    available: inkRecognitionAvailable(),
    lines: samples.length,
    corrections: samples.filter((sample) => sample.origin === 'correction').length,
    prompts: samples.filter((sample) => sample.origin === 'prompt').length,
    enabled: profile?.enabled ?? true,
    style: profile?.style ?? null,
    vocabulary: (profile?.vocabulary.de.length ?? 0) + (profile?.vocabulary.en.length ?? 0),
    errorBefore: profile?.errorBefore ?? null,
    errorAfter: profile?.errorAfter ?? null,
    fittedAt: profile?.fittedAt ?? '',
    model,
    minimumLines: MIN_STYLE_LINES,
  }
}

export type InkPersonalBundle = {
  format: 'fanotes-ink-personal-v1'
  exportedAt: string
  lines: InkLineSample[]
  profile: Omit<InkPersonalProfile, 'key'> | null
}

/** Everything except the (large) personal model, for the training ZIP. */
export const exportInkPersonalBundle = async (): Promise<InkPersonalBundle> => {
  const [lines, profile] = await Promise.all([listInkLineSamples(), getInkPersonalProfile()])
  const { key: _key, ...rest } = profile ?? { key: 'profile' as const }
  return {
    format: 'fanotes-ink-personal-v1',
    exportedAt: new Date().toISOString(),
    lines,
    profile: profile ? rest as Omit<InkPersonalProfile, 'key'> : null,
  }
}

/** Imports lines (and vocabulary) from a training ZIP. Returns the number of new lines. */
export const importInkPersonalBundle = async (value: unknown) => {
  if (!value || typeof value !== 'object') return 0
  const bundle = value as Partial<InkPersonalBundle>
  if (bundle.format !== 'fanotes-ink-personal-v1' || !Array.isArray(bundle.lines)) return 0
  const existing = new Set((await listInkLineSamples()).map((sample) => sample.id))
  const samples = bundle.lines
    .slice(0, 5_000)
    .map((line) => sanitizeInkLineSample(line))
    .filter((sample): sample is InkLineSample => Boolean(sample) && !existing.has(sample!.id))
  await putInkLineSamples(samples)
  const vocabulary = bundle.profile?.vocabulary
  if (vocabulary && typeof vocabulary === 'object') {
    await updateProfile((profile) => ({
      ...profile,
      vocabulary: {
        de: mergedVocabulary(profile.vocabulary.de, Array.isArray(vocabulary.de) ? vocabulary.de.filter((word): word is string => typeof word === 'string') : []),
        en: mergedVocabulary(profile.vocabulary.en, Array.isArray(vocabulary.en) ? vocabulary.en.filter((word): word is string => typeof word === 'string') : []),
      },
    }))
  }
  await reactivate()
  scheduleStyleRefit()
  return samples.length
}

const ONNX_PROTOBUF_START = 0x08

/**
 * Imports a personal model produced by `scripts/ink-model/personalize.py`: the `.onnx` file plus
 * its optional `.json` report. The native host stores and verifies it; the bytes never enter the
 * renderer database.
 */
export const importInkPersonalModel = async (model: File, report?: File) => {
  const native = window.fanotes.inkPersonalModel
  if (!native) throw new Error('Persönliche Modelle gibt es nur in der FaNotes-Desktop-App.')
  if (model.size < 1_000_000 || model.size > MAX_MODEL_BYTES) throw new Error('Die Datei ist kein persönliches FaNotes-Modell.')
  const bytes = new Uint8Array(await model.arrayBuffer())
  if (bytes[0] !== ONNX_PROTOBUF_START) throw new Error('Die Datei ist kein ONNX-Modell.')
  let details: Record<string, unknown> = {}
  if (report) {
    if (report.size > 64 * 1024) throw new Error('Der Modellbericht ist zu gross.')
    details = JSON.parse(await report.text()) as Record<string, unknown>
    if (details.format !== 'fanotes-ink-personal-model-v1') throw new Error('Der Modellbericht ist ungültig.')
  }
  const number = (key: string) => typeof details[key] === 'number' && Number.isFinite(details[key]) ? details[key] : undefined
  const state = await native({
    action: 'install',
    bytes,
    report: {
      name: model.name.slice(0, 120),
      baseVersion: typeof details.baseVersion === 'string' ? details.baseVersion : undefined,
      sampleCount: number('lines') ?? number('sampleCount'),
      errorBefore: number('errorBefore'),
      errorAfter: number('errorAfter'),
    },
  }) as InkPersonalModelState
  await reactivate()
  return state
}

export const removeInkPersonalModel = async () => {
  await window.fanotes.inkPersonalModel?.({ action: 'remove' })
  await reactivate()
}

export const clearInkPersonalization = async () => {
  await clearInkPersonalData()
  await reactivate()
}
