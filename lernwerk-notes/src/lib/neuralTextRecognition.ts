import type { InferenceSession as InferenceSessionType } from 'onnxruntime-web'
import {
  GERMAN_COMMON_BIGRAMS,
  GERMAN_COMMON_TRIGRAMS,
  GERMAN_COMMON_WORDS,
} from '../../../src/data/germanLanguage'
import {
  ENGLISH_COMMON_BIGRAMS,
  ENGLISH_COMMON_TRIGRAMS,
  ENGLISH_COMMON_WORDS,
} from '../../../src/data/englishLanguage'
import type { Stroke } from '../../../src/types'
import { normalizeGermanSharpS } from '../../../src/lib/orthography'
import type { HandwritingRecognitionResources } from '../types'
import { loadSpellingWordContext } from './spelling'
import { recognizeTrocrLine, resetTrocrRecognitionForTests } from './trocrClient'
import {
  effectiveOcrThreadCount,
  ocrWorkerKeepAliveMilliseconds,
  useExtendedDesktopOcrModel,
} from './resourceLimits'
import {
  applyFinalNeuralWordContext,
  applyNeuralWordContext,
  isExtendedNeuralContextWord,
  preserveWordCase,
  wordDistance,
} from './neuralWordContext'
export { applyNeuralWordContext } from './neuralWordContext'

const MODEL_HEIGHT = 128
const MAX_MODEL_WIDTH = 4096
const MAX_LINES = 32
const MIN_LINE_PIXELS = 6
const PUNCTUATION = new Set(Array.from(`!"#$%&'()*+,-./:;<=>?@[\\]^_\`{|}~`))
const GERMAN_LETTERS = new Set(Array.from('ÄÖÜäöü'))
const LANGUAGE_WORDS = { de: GERMAN_COMMON_WORDS, en: ENGLISH_COMMON_WORDS }
const LANGUAGE_BIGRAMS = { de: GERMAN_COMMON_BIGRAMS, en: ENGLISH_COMMON_BIGRAMS }
const LANGUAGE_TRIGRAMS = { de: GERMAN_COMMON_TRIGRAMS, en: ENGLISH_COMMON_TRIGRAMS }
const LANGUAGE_WORD_LISTS = {
  de: [...GERMAN_COMMON_WORDS],
  en: [...ENGLISH_COMMON_WORDS],
}
const LANGUAGE_WORD_RANKS = {
  de: new Map(LANGUAGE_WORD_LISTS.de.map((word, index) => [word, index])),
  en: new Map(LANGUAGE_WORD_LISTS.en.map((word, index) => [word, index])),
}

type RecognitionLanguage = 'de' | 'en'
type WordMembership = (word: string) => boolean

type PhysicalStroke = {
  stroke: Stroke
  minX: number
  minY: number
  maxX: number
  maxY: number
  centerY: number
  width: number
  height: number
}

type StrokeLine = {
  entries: PhysicalStroke[]
  minX: number
  minY: number
  maxX: number
  maxY: number
  centerY: number
}

export type NeuralTextLine = {
  text: string
  rawText: string
  beamText?: string
  greedyText?: string
  confidence: number
  bbox: [number, number, number, number]
  characters: NeuralTextCharacter[]
}

export type NeuralTextCharacter = {
  char: string
  confidence: number
  /** Horizontal span inside the recognized line, normalized to 0…1. */
  start: number
  end: number
}

export type NeuralTextRecognitionResult = {
  text: string
  confidence: number
  lines: NeuralTextLine[]
  engine: 'trocr-bilingual' | 'pylaia-iam' | 'trocr-bilingual+pylaia'
  /** Number of word-like spans in the complete recognized document. */
  wordCount?: number
  /** Fraction of spans supported by the active language lexicon/Bloom filter. */
  knownWordRatio?: number
  /** Local-only diagnostic populated when the compatibility path was needed. */
  trocrFailures?: string[]
}

let sessionPromise: Promise<{
  session: InferenceSessionType
  characters: string[]
}> | null = null
let ctcIdleTimer: ReturnType<typeof globalThis.setTimeout> | null = null

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value))

const asUint8Array = (value: Uint8Array) => value instanceof Uint8Array
  ? value
  : new Uint8Array(value as ArrayBuffer)

const loadSession = async () => {
  if (ctcIdleTimer !== null) globalThis.clearTimeout(ctcIdleTimer)
  ctcIdleTimer = null
  if (sessionPromise) return sessionPromise
  sessionPromise = (async () => {
    const resources: HandwritingRecognitionResources = await window.lernwerk.loadHandwritingRecognitionResources()
    const ort = await import('onnxruntime-web/wasm')
    ort.env.logLevel = 'error'
    ort.env.wasm.numThreads = window.lernwerk.platform === 'web'
      ? effectiveOcrThreadCount(2)
      : effectiveOcrThreadCount(4)
    // Module workers cannot import an ES module from Electron's packaged
    // app.asar file URL. Keep the off-main-thread proxy for the Web PWA and
    // initialize WASM directly only in the explicitly requested desktop OCR
    // action. The model remains lazy and never affects application startup.
    ort.env.wasm.proxy = window.lernwerk.platform === 'web' && typeof Worker !== 'undefined'
    // onnxruntime's ESM glue resolves relative to the hashed Vite chunk in
    // dist/assets. The bundled runtime module intentionally lives one level
    // higher so desktop file:// loading and the Web PWA share the same path.
    // Providing it explicitly prevents a failed assets/ort-*.mjs request.
    ort.env.wasm.wasmPaths = {
      mjs: new URL(/* @vite-ignore */ '../ort-wasm-simd-threaded.mjs', import.meta.url).href,
    }
    ort.env.wasm.wasmBinary = asUint8Array(resources.wasm)
    const session = await ort.InferenceSession.create(asUint8Array(resources.model), {
      executionProviders: ['wasm'],
      executionMode: 'sequential',
      graphOptimizationLevel: 'all',
      enableCpuMemArena: true,
      enableMemPattern: true,
    })
    return { session, characters: resources.characters }
  })().catch((error) => {
    sessionPromise = null
    throw error
  })
  return sessionPromise
}

const scheduleCtcSessionRelease = () => {
  if (ctcIdleTimer !== null) globalThis.clearTimeout(ctcIdleTimer)
  const scheduledSession = sessionPromise
  ctcIdleTimer = globalThis.setTimeout(() => {
    ctcIdleTimer = null
    if (!scheduledSession || sessionPromise !== scheduledSession) return
    sessionPromise = null
    void scheduledSession.then(({ session }) => session.release()).catch(() => undefined)
  }, ocrWorkerKeepAliveMilliseconds())
}

const physicalStroke = (stroke: Stroke, sourceWidth: number, sourceHeight: number): PhysicalStroke | null => {
  if (!stroke.points.length) return null
  const xs = stroke.points.map((point) => point.x * sourceWidth)
  const ys = stroke.points.map((point) => point.y * sourceHeight)
  const radius = clamp(stroke.baseWidth / 2, 0.5, 20)
  const minX = Math.min(...xs) - radius
  const minY = Math.min(...ys) - radius
  const maxX = Math.max(...xs) + radius
  const maxY = Math.max(...ys) + radius
  return {
    stroke,
    minX,
    minY,
    maxX,
    maxY,
    centerY: (minY + maxY) / 2,
    width: maxX - minX,
    height: maxY - minY,
  }
}

const addToLine = (line: StrokeLine, entry: PhysicalStroke) => {
  line.entries.push(entry)
  line.minX = Math.min(line.minX, entry.minX)
  line.minY = Math.min(line.minY, entry.minY)
  line.maxX = Math.max(line.maxX, entry.maxX)
  line.maxY = Math.max(line.maxY, entry.maxY)
  const weights = line.entries.map((candidate) => Math.max(MIN_LINE_PIXELS, candidate.height))
  line.centerY = line.entries.reduce((sum, candidate, index) => sum + candidate.centerY * weights[index], 0)
    / weights.reduce((sum, weight) => sum + weight, 0)
}

const lineFromEntries = (entries: PhysicalStroke[]): StrokeLine => {
  const first = entries[0]
  const line: StrokeLine = {
    entries: [first],
    minX: first.minX,
    minY: first.minY,
    maxX: first.maxX,
    maxY: first.maxY,
    centerY: first.centerY,
  }
  entries.slice(1).forEach((entry) => addToLine(line, entry))
  return line
}

/** Returns only physically unambiguous word groups. It is deliberately more
 * conservative than the later language spacing model: a false split would
 * remove useful line context, while a missed split still uses the full-line
 * recognizer. */
const splitLineAtWordGaps = (line: StrokeLine) => {
  const sorted = [...line.entries].sort((first, second) => first.minX - second.minX)
  if (sorted.length < 2) return [line]
  const lineHeight = Math.max(MIN_LINE_PIXELS, line.maxY - line.minY)
  const minimumWordGap = Math.max(12, lineHeight * 0.3)
  const groups: PhysicalStroke[][] = [[sorted[0]]]
  let groupMaxX = sorted[0].maxX
  sorted.slice(1).forEach((entry) => {
    const gap = entry.minX - groupMaxX
    if (gap >= minimumWordGap) groups.push([entry])
    else groups.at(-1)!.push(entry)
    groupMaxX = Math.max(entry.maxX, gap >= minimumWordGap ? entry.maxX : groupMaxX)
  })
  if (groups.length < 2 || groups.length > 12) return [line]
  return groups.map(lineFromEntries)
}

/** Groups pen strokes into complete text lines before neural recognition. */
export const groupNeuralTextLines = (
  strokes: Stroke[],
  sourceWidth: number,
  sourceHeight: number,
) => {
  const entries = strokes
    .map((stroke) => physicalStroke(stroke, sourceWidth, sourceHeight))
    .filter((entry): entry is PhysicalStroke => Boolean(entry))
  const substantial = entries
    .filter((entry) => entry.height >= MIN_LINE_PIXELS || entry.width >= MIN_LINE_PIXELS * 1.4)
    .sort((first, second) => second.height - first.height)
  const tiny = entries.filter((entry) => !substantial.includes(entry))
  const lines: StrokeLine[] = []

  substantial.forEach((entry) => {
    const matching = lines
      .map((line) => {
        const height = Math.max(MIN_LINE_PIXELS, line.maxY - line.minY)
        const overlap = Math.min(line.maxY, entry.maxY) - Math.max(line.minY, entry.minY)
        const centerDistance = Math.abs(line.centerY - entry.centerY)
        const tolerance = Math.max(10, Math.min(34, Math.max(height, entry.height) * 0.62))
        return { line, overlap, centerDistance, tolerance }
      })
      .filter(({ overlap, centerDistance, tolerance }) => overlap >= -3 || centerDistance <= tolerance)
      .sort((first, second) => first.centerDistance - second.centerDistance)[0]
    if (matching) addToLine(matching.line, entry)
    else lines.push({
      entries: [entry],
      minX: entry.minX,
      minY: entry.minY,
      maxX: entry.maxX,
      maxY: entry.maxY,
      centerY: entry.centerY,
    })
  })

  tiny.forEach((entry) => {
    const matching = lines
      .map((line) => {
        const height = Math.max(MIN_LINE_PIXELS, line.maxY - line.minY)
        const entryCenterX = (entry.minX + entry.maxX) / 2
        const verticalDistance = entry.centerY < line.minY
          ? line.minY - entry.centerY
          : entry.centerY > line.maxY ? entry.centerY - line.maxY : 0
        const nearestGlyphDistance = Math.min(...line.entries.map((candidate) => (
          entryCenterX < candidate.minX
            ? candidate.minX - entryCenterX
            : entryCenterX > candidate.maxX ? entryCenterX - candidate.maxX : 0
        )))
        const horizontalDistance = Math.max(0, Math.max(line.minX - entry.maxX, entry.minX - line.maxX))
        const verticallyNear = entry.centerY >= line.minY - height * 1.1 && entry.centerY <= line.maxY + height * 0.9
        return {
          line,
          score: verticallyNear
            ? verticalDistance + nearestGlyphDistance * 0.24 + horizontalDistance * 0.08
            : Number.POSITIVE_INFINITY,
          tolerance: Math.max(18, height * 0.95),
        }
      })
      .filter(({ score, tolerance }) => score <= tolerance)
      .sort((first, second) => first.score - second.score)[0]
    if (matching) addToLine(matching.line, entry)
    else lines.push({
      entries: [entry],
      minX: entry.minX,
      minY: entry.minY,
      maxX: entry.maxX,
      maxY: entry.maxY,
      centerY: entry.centerY,
    })
  })

  return lines
    .filter((line) => line.entries.length)
    .sort((first, second) => first.centerY - second.centerY)
    .slice(0, MAX_LINES)
}

export type RenderedLineImage = {
  pixels: Uint8ClampedArray
  width: number
  height: number
}

export type NeuralLineRenderOptions = {
  /** Horizontal whitespace relative to the physical ink height. */
  marginXRatio?: number
  /** Vertical whitespace relative to the physical ink height. */
  marginYRatio?: number
  /** Multiplier applied after pressure-independent pen-width scaling. */
  inkScale?: number
}

const renderLineImage = (
  line: StrokeLine,
  sourceWidth: number,
  sourceHeight: number,
  options: NeuralLineRenderOptions = {},
): RenderedLineImage => {
  const contentWidth = Math.max(1, line.maxX - line.minX)
  const contentHeight = Math.max(1, line.maxY - line.minY)
  // TrOCR was trained on complete line crops, which retain substantially more
  // ascender/descender whitespace than a tight canvas bounding box. The 0.40
  // default reduced independent recomposed-UJI CER from 22% to 15% across 12
  // unseen writers while preserving the genuine IAM-OnDB line prediction.
  const marginY = clamp(contentHeight * clamp(options.marginYRatio ?? 0.40, 0.04, 0.6), 4, 36)
  const marginX = clamp(contentHeight * clamp(options.marginXRatio ?? 0.22, 0.04, 0.8), 5, 48)
  const inkScale = clamp(options.inkScale ?? 1, 0.55, 1.8)
  const imageWidth = contentWidth + marginX * 2
  const imageHeight = contentHeight + marginY * 2
  const modelWidth = clamp(Math.ceil(MODEL_HEIGHT * imageWidth / imageHeight), 32, MAX_MODEL_WIDTH)
  const scaleX = modelWidth / imageWidth
  const scaleY = MODEL_HEIGHT / imageHeight
  const canvas = document.createElement('canvas')
  canvas.width = modelWidth
  canvas.height = MODEL_HEIGHT
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (!context) throw new Error('Die Handschriftzeile konnte nicht gerendert werden.')
  context.fillStyle = '#fff'
  context.fillRect(0, 0, modelWidth, MODEL_HEIGHT)
  context.strokeStyle = '#000'
  context.fillStyle = '#000'
  context.lineCap = 'round'
  context.lineJoin = 'round'

  line.entries.forEach(({ stroke }) => {
    const mapped = stroke.points.map((point) => ({
      x: (point.x * sourceWidth - line.minX + marginX) * scaleX,
      y: (point.y * sourceHeight - line.minY + marginY) * scaleY,
    }))
    const widthScale = Math.sqrt(scaleX * scaleY)
    context.lineWidth = clamp(stroke.baseWidth * widthScale * inkScale, 1, 10)
    if (mapped.length === 1) {
      context.beginPath()
      context.arc(mapped[0].x, mapped[0].y, context.lineWidth / 2, 0, Math.PI * 2)
      context.fill()
      return
    }
    context.beginPath()
    mapped.forEach((point, index) => index ? context.lineTo(point.x, point.y) : context.moveTo(point.x, point.y))
    context.stroke()
  })

  return {
    pixels: context.getImageData(0, 0, modelWidth, MODEL_HEIGHT).data,
    width: modelWidth,
    height: MODEL_HEIGHT,
  }
}

/**
 * Renders the first physical handwriting line exactly as the local TrOCR path
 * sees it. The explicit options make preprocessing choices reproducibly
 * benchmarkable without running several expensive recognizers in production.
 */
export const renderNeuralTextLineImage = (
  strokes: Stroke[],
  sourceWidth: number,
  sourceHeight: number,
  options: NeuralLineRenderOptions = {},
) => {
  const line = groupNeuralTextLines(strokes, sourceWidth, sourceHeight)[0]
  return line ? renderLineImage(line, sourceWidth, sourceHeight, options) : null
}

const lineTensorInput = (image: RenderedLineImage) => {
  const plane = image.width * image.height
  const input = new Float32Array(plane)
  for (let index = 0; index < plane; index += 1) {
    // PyLaia was trained on grayscale IAM lines with a black background and
    // bright ink. The canvas uses the opposite convention, so invert it while
    // converting to the model's 0…1 input range.
    input[index] = 1 - image.pixels[index * 4] / 255
  }
  return input
}

const allowedCharacterIndexes = (characters: string[], language: RecognitionLanguage) => characters.flatMap((character, index) => {
  const allowed = /^[A-Za-z0-9]$/u.test(character)
    || PUNCTUATION.has(character)
    || character === ' '
    || (language === 'de' && GERMAN_LETTERS.has(character))
  return allowed ? [index + 1] : []
})

const logAdd = (values: number[]) => {
  const maximum = Math.max(...values)
  if (!Number.isFinite(maximum)) return Number.NEGATIVE_INFINITY
  return maximum + Math.log(values.reduce((sum, value) => sum + Math.exp(value - maximum), 0))
}

const ctcWordScore = (
  probabilities: Float32Array,
  classes: number,
  start: number,
  end: number,
  indexes: number[],
) => {
  const steps = end - start
  if (!indexes.length || steps < indexes.length) return Number.NEGATIVE_INFINITY
  const states = indexes.length * 2 + 1
  const labels = Array.from({ length: states }, (_, index) => index % 2 ? indexes[(index - 1) / 2] : 0)
  let previous = new Float64Array(states).fill(Number.NEGATIVE_INFINITY)
  const firstOffset = start * classes
  previous[0] = Math.log(Math.max(1e-12, probabilities[firstOffset]))
  previous[1] = Math.log(Math.max(1e-12, probabilities[firstOffset + labels[1]]))
  for (let step = start + 1; step < end; step += 1) {
    const current = new Float64Array(states).fill(Number.NEGATIVE_INFINITY)
    const offset = step * classes
    for (let state = 0; state < states; state += 1) {
      const transitions = [previous[state]]
      if (state > 0) transitions.push(previous[state - 1])
      if (state > 1 && labels[state] !== 0 && labels[state] !== labels[state - 2]) transitions.push(previous[state - 2])
      current[state] = logAdd(transitions) + Math.log(Math.max(1e-12, probabilities[offset + labels[state]]))
    }
    previous = current
  }
  return logAdd([previous[states - 1], previous[states - 2]])
}

type CtcWordSpan = { source: string; start: number; end: number }

const ctcWordSpans = (path: number[], characters: string[]) => {
  const spans: CtcWordSpan[] = []
  let source = ''
  let start = 0
  let previous = -1
  const flush = (end: number) => {
    if (source) spans.push({ source, start, end })
    source = ''
  }
  path.forEach((index, step) => {
    if (!index || index === previous) {
      previous = index
      return
    }
    const character = characters[index - 1]
    if (/^\p{L}$/u.test(character)) {
      if (!source) start = Math.max(0, start)
      source += character
    } else {
      flush(step)
      start = step + 1
    }
    previous = index
  })
  flush(path.length)
  return spans
}

const applyCtcWordContext = (
  text: string,
  probabilities: Float32Array,
  classes: number,
  path: number[],
  characters: string[],
  language: RecognitionLanguage,
) => {
  const locale = language === 'de' ? 'de' : 'en'
  const lexicon = LANGUAGE_WORDS[language]
  const characterIndexes = new Map(characters.map((character, index) => [character, index + 1]))
  const spans = ctcWordSpans(path, characters)
  let spanIndex = 0
  const pattern = language === 'de' ? /[A-Za-zÄÖÜäöü]{2,}/gu : /[A-Za-z]{2,}/gu
  return text.replace(pattern, (source) => {
    const span = spans[spanIndex]
    spanIndex += 1
    if (!span || span.source.toLocaleLowerCase(locale) !== source.toLocaleLowerCase(locale)) return source
    const lower = source.toLocaleLowerCase(locale)
    if (lexicon.has(lower) || lower.length < 3) return source
    const maximumDistance = lower.length >= 4 ? 2 : 1
    const sourceIndexes = [...lower].map((character) => characterIndexes.get(character) ?? -1)
    if (sourceIndexes.includes(-1)) return source
    const sourceScore = ctcWordScore(probabilities, classes, span.start, span.end, sourceIndexes)
    const candidates = [...lexicon]
      .filter((candidate) => Math.abs(candidate.length - lower.length) <= maximumDistance)
      .map((candidate) => ({ candidate, distance: wordDistance(lower, candidate) }))
      .filter(({ candidate, distance }) => distance <= maximumDistance && [...candidate].every((character) => characterIndexes.has(character)))
      .map(({ candidate, distance }) => ({
        candidate,
        distance,
        score: ctcWordScore(
          probabilities,
          classes,
          span.start,
          span.end,
          [...candidate].map((character) => characterIndexes.get(character)!),
        ),
      }))
      .sort((first, second) => second.score - first.score || first.distance - second.distance)
    const best = candidates[0]
    const runnerUp = candidates[1]
    const visualAllowance = best?.distance === 2
      ? lower.length <= 5 ? 1.5 : Math.max(5.8, lower.length * 0.8)
      : Math.max(8, lower.length * 1.4)
    if (
      !best
      || best.score < sourceScore - visualAllowance
      || (runnerUp && best.score - runnerUp.score < 0.5)
    ) return source
    return preserveWordCase(source, best.candidate, language)
  })
}

type CtcBeamState = {
  prefix: string
  blank: number
  nonblank: number
  languageScore: number
  characterCount: number
}

const CTC_BEAM_WIDTH = 8
const CTC_BEAM_TOP_K = 5
const CTC_LANGUAGE_WEIGHT = 0.42
const CTC_INSERTION_BONUS = 0.04

const trailingBeamWord = (value: string) => (
  /([\p{L}]+(?:'[\p{L}]+)?)$/u.exec(value)?.[1] ?? ''
)

const beamWordCompletionScore = (
  word: string,
  language: RecognitionLanguage,
  wordMembership?: WordMembership,
) => {
  if (!word) return 0
  const lower = word.toLocaleLowerCase(language)
  if (LANGUAGE_WORDS[language].has(lower) || wordMembership?.(lower)) {
    return 1.25 + Math.min(1.1, lower.length * 0.09)
  }
  if (lower.length === 1 && (lower === 'a' || lower === 'i')) return 0.65
  // Proper names and technical terms must remain possible.
  return -Math.min(0.42, 0.08 + lower.length * 0.025)
}

const beamExtensionLanguageDelta = (
  prefix: string,
  character: string,
  language: RecognitionLanguage,
  wordMembership?: WordMembership,
) => {
  let delta = 0
  if (/^\p{L}$/u.test(character)) {
    const letters = Array.from(`${prefix.slice(-3)}${character}`)
      .filter((entry) => /^\p{L}$/u.test(entry))
      .join('')
      .toLocaleLowerCase(language)
    if (letters.length >= 2) delta += LANGUAGE_BIGRAMS[language].has(letters.slice(-2)) ? 0.1 : -0.025
    if (letters.length >= 3) delta += LANGUAGE_TRIGRAMS[language].has(letters.slice(-3)) ? 0.17 : -0.02
  } else if (/\s/u.test(character) || /^[,.;:!?]$/u.test(character)) {
    delta += beamWordCompletionScore(trailingBeamWord(prefix), language, wordMembership)
    if (/\s/u.test(character) && (!prefix || /\s$/u.test(prefix))) delta -= 1.2
    if (/^[,.;:!?]$/u.test(character) && prefix.endsWith(character)) delta -= 0.8
  }
  return delta
}

const topCtcIndexes = (
  probabilities: Float32Array,
  offset: number,
  allowed: number[],
) => {
  const top: { index: number; probability: number }[] = []
  allowed.forEach((index) => {
    const probability = probabilities[offset + index]
    if (top.length === CTC_BEAM_TOP_K && probability <= top.at(-1)!.probability) return
    const insertion = top.findIndex((entry) => probability > entry.probability)
    if (insertion < 0) top.push({ index, probability })
    else top.splice(insertion, 0, { index, probability })
    if (top.length > CTC_BEAM_TOP_K) top.pop()
  })
  return top
}

const ctcBeamScore = (
  state: CtcBeamState,
  final = false,
  language?: RecognitionLanguage,
  wordMembership?: WordMembership,
) => {
  const completedLanguageScore = final && language
    ? state.languageScore + beamWordCompletionScore(trailingBeamWord(state.prefix), language, wordMembership)
    : state.languageScore
  return logAdd([state.blank, state.nonblank])
    + CTC_LANGUAGE_WEIGHT * completedLanguageScore
    + CTC_INSERTION_BONUS * state.characterCount
}

const decodeCtcBeam = (
  probabilities: Float32Array,
  timeSteps: number,
  classes: number,
  allowed: number[],
  characters: string[],
  language: RecognitionLanguage,
  wordMembership?: WordMembership,
) => {
  let beam = new Map<string, CtcBeamState>([[
    '',
    {
      prefix: '',
      blank: 0,
      nonblank: Number.NEGATIVE_INFINITY,
      languageScore: 0,
      characterCount: 0,
    },
  ]])

  for (let step = 0; step < timeSteps; step += 1) {
    const offset = step * classes
    const candidates = topCtcIndexes(probabilities, offset, allowed)
    const blankLog = Math.log(Math.max(1e-12, probabilities[offset]))
    const next = new Map<string, CtcBeamState>()
    const target = (
      prefix: string,
      languageScore: number,
      characterCount: number,
    ) => {
      let state = next.get(prefix)
      if (!state) {
        state = {
          prefix,
          blank: Number.NEGATIVE_INFINITY,
          nonblank: Number.NEGATIVE_INFINITY,
          languageScore,
          characterCount,
        }
        next.set(prefix, state)
      }
      return state
    }

    beam.forEach((state) => {
      const total = logAdd([state.blank, state.nonblank])
      const same = target(state.prefix, state.languageScore, state.characterCount)
      same.blank = logAdd([same.blank, total + blankLog])
      const last = state.prefix.at(-1) ?? ''
      candidates.forEach(({ index, probability }) => {
        const character = characters[index - 1]
        const characterLog = Math.log(Math.max(1e-12, probability))
        let source = total
        if (character === last) {
          same.nonblank = logAdd([same.nonblank, state.nonblank + characterLog])
          source = state.blank
        }
        if (!Number.isFinite(source)) return
        const prefix = `${state.prefix}${character}`
        const extended = target(
          prefix,
          state.languageScore + beamExtensionLanguageDelta(state.prefix, character, language, wordMembership),
          state.characterCount + Number(!/\s/u.test(character)),
        )
        extended.nonblank = logAdd([extended.nonblank, source + characterLog])
      })
    })
    beam = new Map(
      [...next.values()]
        .sort((first, second) => ctcBeamScore(second) - ctcBeamScore(first))
        .slice(0, CTC_BEAM_WIDTH)
        .map((state) => [state.prefix, state]),
    )
  }
  const best = [...beam.values()]
    .sort((first, second) => (
      ctcBeamScore(second, true, language, wordMembership) -
      ctcBeamScore(first, true, language, wordMembership)
    ))[0]
  return best?.prefix
    .normalize('NFC')
    .replace(/[ \t]{2,}/gu, ' ')
    .replace(/\s+([,.;:!?])/gu, '$1')
    .trim() ?? ''
}

const neuralTextHypothesisScore = (
  value: string,
  language: RecognitionLanguage,
  wordMembership?: WordMembership,
) => {
  const locale = language === 'de' ? 'de' : 'en'
  const words = value.toLocaleLowerCase(locale)
    .match(language === 'de' ? /[a-zäöü]+/giu : /[a-z]+/giu) ?? []
  let score = 0
  words.forEach((word) => {
    score += LANGUAGE_WORDS[language].has(word) || wordMembership?.(word)
      ? 2.4 + Math.min(0.8, word.length * 0.08)
      : -0.08
    for (let index = 1; index < word.length; index += 1) {
      score += LANGUAGE_BIGRAMS[language].has(word.slice(index - 1, index + 1)) ? 0.1 : -0.025
    }
    for (let index = 2; index < word.length; index += 1) {
      score += LANGUAGE_TRIGRAMS[language].has(word.slice(index - 2, index + 1)) ? 0.17 : -0.02
    }
  })
  score -= (value.match(/\s{2,}|([,.;:!?])\1/gu)?.length ?? 0) * 0.9
  return score
}

const decodeCtc = (
  probabilities: Float32Array,
  dimensions: readonly number[],
  characters: string[],
  language: RecognitionLanguage,
  wordMembership?: WordMembership,
) => {
  const timeSteps = dimensions.at(-2) ?? 0
  const classes = dimensions.at(-1) ?? 0
  if (!timeSteps || classes !== characters.length + 1 || probabilities.length !== timeSteps * classes) {
    throw new Error('Das Handschriftmodell hat ein unerwartetes Ergebnis geliefert.')
  }
  const allowed = allowedCharacterIndexes(characters, language)
  const output: string[] = []
  const confidences: number[] = []
  const path: number[] = []
  let previous = -1
  for (let step = 0; step < timeSteps; step += 1) {
    const offset = step * classes
    let bestIndex = 0
    let bestProbability = probabilities[offset]
    for (let candidateIndex = 0; candidateIndex < allowed.length; candidateIndex += 1) {
      const index = allowed[candidateIndex]
      const probability = probabilities[offset + index]
      if (probability > bestProbability) {
        bestIndex = index
        bestProbability = probability
      }
    }
    if (bestIndex && bestIndex !== previous) {
      output.push(characters[bestIndex - 1])
      confidences.push(bestProbability)
    }
    path.push(bestIndex)
    previous = bestIndex
  }
  const rawText = normalizeGermanSharpS(output.join(''))
    .normalize('NFC')
    .replace(/[ \t]{2,}/gu, ' ')
    .replace(/\s+([,.;:!?])/gu, '$1')
    .trim()
  const characterRuns: NeuralTextCharacter[] = []
  let runStart = 0
  while (runStart < path.length) {
    const index = path[runStart]
    let runEnd = runStart + 1
    while (runEnd < path.length && path[runEnd] === index) runEnd += 1
    if (index) {
      let peak = 0
      for (let step = runStart; step < runEnd; step += 1) {
        peak = Math.max(peak, probabilities[step * classes + index])
      }
      characterRuns.push({
        char: characters[index - 1],
        confidence: Math.round(peak * 100),
        start: runStart / timeSteps,
        end: runEnd / timeSteps,
      })
    }
    runStart = runEnd
  }
  const beamText = rawText.length >= 3
    ? decodeCtcBeam(probabilities, timeSteps, classes, allowed, characters, language, wordMembership)
    : ''
  const greedyText = applyNeuralWordContext(
    applyCtcWordContext(rawText, probabilities, classes, path, characters, language),
    language,
  )
  const contextualBeamText = beamText ? applyNeuralWordContext(beamText, language) : ''
  const text = contextualBeamText
    && neuralTextHypothesisScore(contextualBeamText, language, wordMembership)
      >= neuralTextHypothesisScore(greedyText, language, wordMembership) - 0.15
    ? contextualBeamText
    : greedyText
  const confidence = confidences.length
    ? Math.round(confidences.reduce((sum, value) => sum + value, 0) / confidences.length * 100)
    : 0
  return { text, rawText, beamText: contextualBeamText, greedyText, confidence, characters: characterRuns }
}

const hasTerminalPunctuationInk = (line: StrokeLine) => {
  const height = Math.max(1, line.maxY - line.minY)
  const rightEdge = line.maxX - height * 0.62
  return line.entries.some((entry) => (
    entry.maxX >= rightEdge
    && entry.width <= height * 0.42
    && entry.height <= height * 0.48
  ))
}

const normalizedTrocrSurface = (
  value: string,
  line: StrokeLine,
) => normalizeGermanSharpS(value)
    .normalize('NFC')
    .replace(/[ \t]{2,}/gu, ' ')
    .replace(/\s+([,.;:!?])/gu, '$1')
    .replace(/[.,]$/u, (punctuation) => hasTerminalPunctuationInk(line) ? punctuation : '')
    .trim()

const normalizedTrocrText = (
  value: string,
  language: RecognitionLanguage,
  line: StrokeLine,
) => applyNeuralWordContext(normalizedTrocrSurface(value, line), language)

const fuseCompactAndContextWords = (
  compactText: string,
  compactRawText: string,
  contextText: string,
  language: RecognitionLanguage,
  wordMembership?: WordMembership,
) => {
  const compactTokens = compactText.split(/\s+/u)
  const compactRawTokens = compactRawText.split(/\s+/u)
  const contextTokens = contextText.split(/\s+/u)
  if (compactTokens.length !== contextTokens.length) return contextText
  const wordPattern = language === 'de' ? /[A-Za-zÄÖÜäöü]{2,}/u : /[A-Za-z]{2,}/u
  return compactTokens.map((compactToken, index) => {
    const contextToken = contextTokens[index]
    const compactWord = compactToken.match(wordPattern)?.[0]?.toLocaleLowerCase(language)
    const compactRawWord = compactRawTokens.length === compactTokens.length
      ? compactRawTokens[index]?.match(wordPattern)?.[0]?.toLocaleLowerCase(language)
      : undefined
    const contextWord = contextToken.match(wordPattern)?.[0]?.toLocaleLowerCase(language)
    if (!compactWord || !contextWord) return compactToken
    const compactKnown = LANGUAGE_WORDS[language].has(compactWord)
      || Boolean(wordMembership?.(compactWord))
      || isExtendedNeuralContextWord(compactWord, language)
    const contextKnown = LANGUAGE_WORDS[language].has(contextWord)
      || Boolean(wordMembership?.(contextWord))
      || isExtendedNeuralContextWord(contextWord, language)
    if (compactWord === contextWord) return compactToken
    // Keep an unambiguous local correction backed by the compact visual path
    // (for example Frevor → Trevor). Otherwise the stronger context model may
    // replace even a valid but visually confused word such as rennen/lernen.
    const compactWasCorrected = Boolean(compactRawWord && compactRawWord !== compactWord)
    if (compactWasCorrected && compactKnown) return compactToken
    if (compactKnown && contextKnown && wordDistance(compactWord, contextWord) > 2) return compactToken
    if (contextKnown) return contextToken
    return compactKnown ? compactToken : contextToken
  }).join(' ')
}

const evenlySpacedCharacters = (text: string, confidence: number): NeuralTextCharacter[] => {
  const visible = Array.from(text).filter((character) => !/\s/u.test(character))
  return visible.map((char, index) => ({
    char,
    confidence,
    start: index / Math.max(1, visible.length),
    end: (index + 1) / Math.max(1, visible.length),
  }))
}

const trocrLineAssessment = (
  text: string,
  line: StrokeLine,
  language: RecognitionLanguage,
  wordMembership?: WordMembership,
) => {
  const visible = Array.from(text).filter((character) => !/\s/u.test(character))
  const letters = visible.filter((character) => /^\p{L}$/u.test(character)).length
  const digits = visible.filter((character) => /^\d$/u.test(character)).length
  const punctuation = visible.filter((character) => PUNCTUATION.has(character)).length
  const aspect = Math.max(0.2, (line.maxX - line.minX) / Math.max(1, line.maxY - line.minY))
  const minimumCharacters = aspect >= 3 ? Math.max(2, Math.floor(aspect * 0.42)) : 1
  const maximumCharacters = Math.max(4, Math.ceil(aspect * 4.8 + 7))
  const invalid = visible.length - letters - digits - punctuation
  const suspicious = (
    visible.length === 0
    || visible.length < minimumCharacters
    || visible.length > maximumCharacters
    || invalid > 0
    || /(.)\1{6,}/u.test(text)
    || (visible.length >= 4 && letters + digits < visible.length * 0.45)
  )
  const words = text.toLocaleLowerCase(language)
    .match(language === 'de' ? /[a-zäöü]{2,}/giu : /[a-z]{2,}/giu) ?? []
  const knownWords = words.filter((word) => LANGUAGE_WORDS[language].has(word) || wordMembership?.(word)).length
  const knownRatio = knownWords / Math.max(1, words.length)
  const unsupportedShortWord = words.length === 1
    && visible.length >= 3
    && visible.length <= 10
    && letters === visible.length
    && knownWords === 0
  const needsFallback = suspicious || unsupportedShortWord
  const lengthFit = visible.length >= minimumCharacters && visible.length <= maximumCharacters ? 0.8 : -2.4
  const score = neuralTextHypothesisScore(text, language, wordMembership)
    + lengthFit
    + Math.min(0.8, knownRatio * 0.8)
    + Math.min(0.45, (letters + digits) / Math.max(1, visible.length) * 0.45)
  const confidence = Math.round(clamp(68 + knownRatio * 12 + lengthFit * 4 - invalid * 8, 35, 88))
  return { suspicious: needsFallback, score, confidence }
}

const recognizeCtcLine = async (
  image: RenderedLineImage,
  language: RecognitionLanguage,
  wordMembership?: WordMembership,
) => {
  const input = lineTensorInput(image)
  if (window.lernwerk.platform !== 'web' && window.lernwerk.recognizeNativeHandwritingLine) {
    try {
      const native = await window.lernwerk.recognizeNativeHandwritingLine({
        input,
        width: image.width,
        height: image.height,
        threads: effectiveOcrThreadCount(4),
      })
      if (
        native.engine !== 'onnxruntime-node-cpu'
        || !(native.probabilities instanceof Float32Array)
        || !Array.isArray(native.dims)
        || !Array.isArray(native.characters)
        || native.characters.some((character) => typeof character !== 'string' || Array.from(character).length !== 1)
      ) throw new Error('Die native OCR-Antwort ist ungültig.')
      return decodeCtc(native.probabilities, native.dims, native.characters, language, wordMembership)
    } catch {
      // Damaged or unavailable native binaries must not remove handwriting
      // recognition. The verified WASM model below is the portable fallback.
    }
  }
  const [{ session, characters }, ort] = await Promise.all([
    loadSession(),
    import('onnxruntime-web/wasm'),
  ])
  try {
    const tensor = new ort.Tensor('float32', input, [1, 1, image.height, image.width])
    const output = await session.run({ x: tensor })
    const prediction = output.fetch_name_0 ?? output[session.outputNames[0]]
    if (!prediction || !(prediction.data instanceof Float32Array)) {
      throw new Error('Das Handschrift-Fallbackmodell hat keine lesbare Textzeile geliefert.')
    }
    return decodeCtc(prediction.data, prediction.dims, characters, language, wordMembership)
  } finally {
    scheduleCtcSessionRelease()
  }
}

const recognizeSeparatedWordLine = async (
  line: StrokeLine,
  language: RecognitionLanguage,
  sourceWidth: number,
  sourceHeight: number,
  wordMembership?: WordMembership,
  useExtendedModel = false,
) => {
  const physicalWords = splitLineAtWordGaps(line)
  if (physicalWords.length < 2) return null
  const wordResults: Array<Omit<NeuralTextLine, 'bbox'>> = []
  let usedCtc = false
  let usedTrocr = false
  for (const physicalWord of physicalWords) {
    const image = renderLineImage(physicalWord, sourceWidth, sourceHeight)
    let selected: Omit<NeuralTextLine, 'bbox'> | null = null
    let selectedAssessment: ReturnType<typeof trocrLineAssessment> | null = null
    try {
      const ctc = await recognizeCtcLine(image, language, wordMembership)
      if (ctc.text) {
        selected = ctc
        selectedAssessment = trocrLineAssessment(ctc.text, physicalWord, language, wordMembership)
        usedCtc = true
      }
    } catch {
      // TrOCR below can still recognize this physical word.
    }
    // A confident dictionary-backed CTC word needs no second inference. This
    // keeps clear multi-word lines faster than recognizing the complete line
    // and then rerunning every word.
    if (useExtendedModel && (!selected || selectedAssessment?.suspicious)) {
      try {
        const rawText = normalizeGermanSharpS(await recognizeTrocrLine(image.pixels, image.width, image.height))
          .normalize('NFC')
          .trim()
        const text = normalizedTrocrText(rawText, language, physicalWord)
        const assessment = trocrLineAssessment(text, physicalWord, language, wordMembership)
        if (
          text &&
          (
            !selected ||
            assessment.score > (selectedAssessment?.score ?? Number.NEGATIVE_INFINITY) + 0.12 ||
            (assessment.score >= (selectedAssessment?.score ?? Number.NEGATIVE_INFINITY) - 0.04
              && assessment.confidence > selected.confidence)
          )
        ) {
          selected = {
            text,
            rawText,
            greedyText: text,
            confidence: assessment.confidence,
            characters: evenlySpacedCharacters(text, assessment.confidence),
          }
          selectedAssessment = assessment
          usedTrocr = true
        }
      } catch {
        // The CTC word remains available if it was usable.
      }
    }
    if (!selected?.text || selectedAssessment?.suspicious || /\s/u.test(selected.text)) return null
    wordResults.push(selected)
  }
  const text = wordResults.map((result) => result.text).join(' ')
  const assessment = trocrLineAssessment(text, line, language, wordMembership)
  if (assessment.suspicious) return null
  const confidence = Math.round(wordResults.reduce((sum, result) => sum + result.confidence, 0) / wordResults.length)
  return {
    result: {
      text,
      rawText: wordResults.map((result) => result.rawText).join(' '),
      greedyText: text,
      confidence,
      characters: evenlySpacedCharacters(text, confidence),
    },
    usedCtc,
    usedTrocr,
  }
}

/**
 * Recognizes complete handwriting lines through one shared segmentation and
 * correction path. Web uses the compact Q8 WASM model. Desktop uses the FP32
 * model through native ONNX Runtime and can optionally add the larger TrOCR
 * context model for difficult lines.
 */
export async function recognizeNeuralText(
  strokes: Stroke[],
  language: RecognitionLanguage,
  sourceWidth = 900,
  sourceHeight = 1273,
): Promise<NeuralTextRecognitionResult> {
  const useContextModel = window.lernwerk.platform === 'web' || useExtendedDesktopOcrModel()
  const lines = groupNeuralTextLines(strokes, sourceWidth, sourceHeight)
  if (!lines.length) return {
    text: '',
    confidence: 0,
    lines: [],
    engine: useContextModel ? 'trocr-bilingual' : 'pylaia-iam',
    wordCount: 0,
    knownWordRatio: 0,
  }
  const wordMembership = await loadSpellingWordContext(language).catch(() => undefined)
  const results: NeuralTextLine[] = []
  const trocrFailures: string[] = []
  let trocrLines = 0
  let ctcLines = 0
  for (const line of lines) {
    const separated = await recognizeSeparatedWordLine(
      line,
      language,
      sourceWidth,
      sourceHeight,
      wordMembership,
      useContextModel,
    ).catch(() => null)
    const image = renderLineImage(line, sourceWidth, sourceHeight)
    let selected: Omit<NeuralTextLine, 'bbox'> | null = separated?.result ?? null
    let primaryAssessment: ReturnType<typeof trocrLineAssessment> | null = selected
      ? trocrLineAssessment(selected.text, line, language, wordMembership)
      : null
    if (separated?.usedCtc) ctcLines += 1
    if (separated?.usedTrocr) trocrLines += 1
    if (!selected) {
      try {
        const compact = await recognizeCtcLine(image, language, wordMembership)
        if (compact.text) {
          selected = compact
          primaryAssessment = trocrLineAssessment(compact.text, line, language, wordMembership)
          ctcLines += 1
        }
      } catch {
        primaryAssessment = null
      }
    }

    const selectedWords = selected?.text.toLocaleLowerCase(language)
      .match(language === 'de' ? /[a-zäöü]{3,}/giu : /[a-z]{3,}/giu) ?? []
    const containsUnknownWord = selectedWords.some((word) => (
      !LANGUAGE_WORDS[language].has(word) && !wordMembership?.(word)
    ))
    const isWebRuntime = window.lernwerk.platform === 'web'
    if (useContextModel && (isWebRuntime || !selected || primaryAssessment?.suspicious || containsUnknownWord)) {
      try {
        const rawText = normalizeGermanSharpS(await recognizeTrocrLine(image.pixels, image.width, image.height))
          .normalize('NFC')
          .trim()
        const text = normalizedTrocrText(rawText, language, line)
        let contextAssessment = trocrLineAssessment(text, line, language, wordMembership)
        const surfaceText = normalizedTrocrSurface(rawText, line)
        const contextualEdits = wordDistance(
          surfaceText.toLocaleLowerCase(language),
          text.toLocaleLowerCase(language),
        )
        if (contextualEdits > 0 && /\s/u.test(text)) contextAssessment = {
          ...contextAssessment,
          suspicious: true,
          score: contextAssessment.score - Math.min(0.7, contextualEdits * 0.24),
        }
        if (
          text
          && (
            isWebRuntime
            || !selected
            || contextAssessment.score > (primaryAssessment?.score ?? Number.NEGATIVE_INFINITY) + 0.12
            || (contextAssessment.score >= (primaryAssessment?.score ?? Number.NEGATIVE_INFINITY) - 0.04
              && contextAssessment.confidence > selected.confidence)
          )
        ) {
          const compactContextText = selected
            ? normalizedTrocrSurface(applyFinalNeuralWordContext(selected.text, language), line)
            : ''
          const fusedText = selected
            ? fuseCompactAndContextWords(compactContextText, selected.rawText, text, language, wordMembership)
            : text
          const fusedAssessment = trocrLineAssessment(fusedText, line, language, wordMembership)
          const fusedConfidence = Math.max(selected?.confidence ?? 0, contextAssessment.confidence)
          selected = {
            text: fusedText,
            rawText,
            greedyText: fusedText,
            confidence: fusedConfidence,
            characters: evenlySpacedCharacters(fusedText, fusedConfidence),
          }
          primaryAssessment = fusedAssessment
          trocrLines += 1
        }
      } catch (error) {
        trocrFailures.push((error instanceof Error ? error.message : String(error)).slice(0, 500))
      }
    }
    if (selected?.text) {
      const finalText = applyFinalNeuralWordContext(selected.text, language)
      if (finalText !== selected.text) selected = {
        ...selected,
        text: finalText,
        characters: evenlySpacedCharacters(finalText, selected.confidence),
      }
    }
    if (!selected?.text) continue
    if (ctcLines + trocrLines < results.length + 1) {
      if (useContextModel) trocrLines += 1
      else ctcLines += 1
    }
    results.push({
      ...selected,
      bbox: [
        clamp(line.minX / sourceWidth, 0, 1),
        clamp(line.minY / sourceHeight, 0, 1),
        clamp((line.maxX - line.minX) / sourceWidth, 0, 1),
        clamp((line.maxY - line.minY) / sourceHeight, 0, 1),
      ],
    })
  }
  const text = results.map((line) => line.text).join('\n')
  const words = text.toLocaleLowerCase(language)
    .match(language === 'de' ? /[a-zäöü]{2,}/giu : /[a-z]{2,}/giu) ?? []
  const knownWords = words.filter((word) => (
    LANGUAGE_WORDS[language].has(word) || wordMembership?.(word)
  )).length
  return {
    text,
    confidence: results.length
      ? Math.round(results.reduce((sum, line) => sum + line.confidence, 0) / results.length)
      : 0,
    lines: results,
    engine: ctcLines && trocrLines
      ? 'trocr-bilingual+pylaia'
      : ctcLines ? 'pylaia-iam' : 'trocr-bilingual',
    wordCount: words.length,
    knownWordRatio: knownWords / Math.max(1, words.length),
    ...(trocrFailures.length ? { trocrFailures } : {}),
  }
}

export const resetNeuralTextRecognitionForTests = () => {
  if (ctcIdleTimer !== null) globalThis.clearTimeout(ctcIdleTimer)
  ctcIdleTimer = null
  const previousSession = sessionPromise
  sessionPromise = null
  void previousSession?.then(({ session }) => session.release()).catch(() => undefined)
  resetTrocrRecognitionForTests()
}
