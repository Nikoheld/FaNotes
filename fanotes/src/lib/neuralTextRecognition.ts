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
import { ENGLISH_CANONICAL_PROPER_NAMES } from '../../../src/data/englishProperNames'
import type { Stroke } from '../../../src/types'
import { normalizeGermanSharpS } from '../../../src/lib/orthography'
import type { HandwritingRecognitionResources } from '../types'
import { loadSpellingWordContext } from './spelling'
import {
  recognizeTrocrLine,
  recognizeTrocrLineCandidates,
  resetTrocrRecognitionForTests,
} from './trocrClient'
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
// A complete handwritten line can legitimately contain more than twelve
// short words. Treating every line above that old guard as one image exposed
// it to early decoder EOS and could erase the entire right-hand side. Twenty-
// four still bounds per-word work while covering a densely written page line.
const MAX_PHYSICAL_WORDS = 24
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
// N-best development analysis across English IAM and German ScaDS lines showed
// that the previous 0.10 penalty let weak language fluency override the
// decoder's visual order too often. A candidate now needs roughly one complete
// independently known-word advantage per displaced beam position. The ScaDS
// test fold is kept separate for final evaluation, not parameter selection.
const TROCR_VISUAL_RANK_PENALTY = 3
export const trocrVisualRankPenaltyForTests = TROCR_VISUAL_RANK_PENALTY
// An independent 1,208-line IAM N-best audit found one deliberately narrow
// exception to the full visual-rank penalty: when the next beam changes
// exactly one ordinary lower-case word by at most two characters and turns an
// unsupported token into a known word, it can safely receive part of the
// lexical advantage immediately. Names, compounds, punctuation, word-boundary
// changes and already-known visual words stay with the decoder's first beam.
const TROCR_SAFE_WORD_REPAIR_BONUS = 2
// If the top visual word has its own different, unique dictionary repair, the
// two lexical readings are ambiguous. The lower beam must then beat another
// full visual-rank step instead of receiving a dictionary bonus. This keeps
// the decoder's independent ink order authoritative without disabling N-best
// repairs whose first word truly has no viable reading.
const TROCR_COMPETING_WORD_REPAIR_PENALTY = 3
// A second beam must not manufacture lexical evidence by splitting one visual
// word into several unrelated dictionary words, duplicating it, detaching a
// continuation mark, or introducing an unsupported opening bracket. These
// structural rewrites previously gained roughly one full known-word bonus even
// when the first beam already preserved the measured ink sequence.
const TROCR_UNSUPPORTED_STRUCTURE_PENALTY = 4
const TROCR_ORDINARY_WORD_NAME_PENALTY = 3

type RecognitionLanguage = 'de' | 'en'
type WordMembership = (word: string) => boolean

type PhysicalStroke = {
  stroke: Stroke
  /** Tablet points in source-pixel coordinates. Keeping the trajectory here
   * lets spacing distinguish a real pen-down connector from two merely close
   * stroke boxes without rendering another canvas. */
  points: Array<{ x: number; y: number }>
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
  /** Deterministic local model alternatives, ordered by the ensemble. */
  alternatives?: string[]
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
    const resources: HandwritingRecognitionResources = await window.fanotes.loadHandwritingRecognitionResources()
    const ort = await import('onnxruntime-web/wasm')
    ort.env.logLevel = 'error'
    ort.env.wasm.numThreads = window.fanotes.platform === 'web'
      ? effectiveOcrThreadCount(2)
      : effectiveOcrThreadCount(4)
    // Module workers cannot import an ES module from Electron's packaged
    // app.asar file URL. Keep the off-main-thread proxy for the Web PWA and
    // initialize WASM directly only in the explicitly requested desktop OCR
    // action. The model remains lazy and never affects application startup.
    ort.env.wasm.proxy = window.fanotes.platform === 'web' && typeof Worker !== 'undefined'
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
  const points = stroke.points.map((point) => ({
    x: point.x * sourceWidth,
    y: point.y * sourceHeight,
  }))
  const xs = points.map((point) => point.x)
  const ys = points.map((point) => point.y)
  const radius = clamp(stroke.baseWidth / 2, 0.5, 20)
  const minX = Math.min(...xs) - radius
  const minY = Math.min(...ys) - radius
  const maxX = Math.max(...xs) + radius
  const maxY = Math.max(...ys) + radius
  return {
    stroke,
    points,
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
  const strokeHeights = sorted.map((entry) => entry.height).sort((first, second) => first - second)
  const typicalStrokeHeight = strokeHeights[Math.floor(strokeHeights.length / 2)] ?? lineHeight
  // A single tall capital or descender can make the full line box much higher
  // than its ordinary letter bodies. Scaling word gaps only from that box hid
  // otherwise clear spaces (for example all but one boundary in a real IAM
  // line). The median physical stroke height is robust to both tall capitals
  // and tiny dots/crossbars; retain the old line-height threshold as an upper
  // bound so separately written letters are not split into words.
  let minimumWordGap = Math.max(12, Math.min(
    lineHeight * 0.3,
    typicalStrokeHeight * 0.98,
  ))
  let measuredMaxX = sorted[0].maxX
  const positiveGaps = sorted.slice(1).flatMap((entry) => {
    const gap = entry.minX - measuredMaxX
    measuredMaxX = Math.max(measuredMaxX, entry.maxX)
    return gap > 0 ? [gap] : []
  }).sort((first, second) => first - second)
  let strongestBoundary: { threshold: number; strength: number } | null = null
  for (let index = 2; index < positiveGaps.length; index += 1) {
    const lower = positiveGaps[index - 1]
    const upper = positiveGaps[index]
    const jump = upper - lower
    // The upper cluster must already be word-gap sized relative to ordinary
    // stroke bodies. This keeps an isolated i-dot or a delayed crossbar from
    // making the smaller intra-letter gap cluster look like word spacing.
    if (
      upper < Math.max(12, typicalStrokeHeight * 0.58) ||
      upper < lower * 1.35 ||
      jump < Math.max(4, typicalStrokeHeight * 0.16) ||
      positiveGaps.length - index > MAX_PHYSICAL_WORDS
    ) continue
    const strength = jump / Math.max(6, lower) + Math.min(0.35, (positiveGaps.length - index) * 0.04)
    if (!strongestBoundary || strength > strongestBoundary.strength) {
      strongestBoundary = { threshold: (lower + upper) / 2, strength }
    }
  }
  if (strongestBoundary) minimumWordGap = Math.min(minimumWordGap, strongestBoundary.threshold)
  const groups: PhysicalStroke[][] = [[sorted[0]]]
  let groupMaxX = sorted[0].maxX
  sorted.slice(1).forEach((entry) => {
    const gap = entry.minX - groupMaxX
    if (gap >= minimumWordGap) groups.push([entry])
    else groups.at(-1)!.push(entry)
    groupMaxX = Math.max(entry.maxX, gap >= minimumWordGap ? entry.maxX : groupMaxX)
  })
  if (groups.length < 2 || groups.length > MAX_PHYSICAL_WORDS) return [line]
  return groups.map(lineFromEntries)
}

const hasTightSingleWordInk = (line: StrokeLine) => {
  if (line.entries.length <= 1) return true
  const sorted = [...line.entries].sort((first, second) => first.minX - second.minX)
  const heights = sorted.map((entry) => entry.height).sort((first, second) => first - second)
  const typicalHeight = heights[Math.floor(heights.length / 2)] ?? Math.max(1, line.maxY - line.minY)
  const lineHeight = Math.max(MIN_LINE_PIXELS, line.maxY - line.minY)
  let occupiedRight = sorted[0].maxX
  let maximumGap = 0
  for (const entry of sorted.slice(1)) {
    maximumGap = Math.max(maximumGap, entry.minX - occupiedRight)
    occupiedRight = Math.max(occupiedRight, entry.maxX)
  }
  // This is intentionally much stricter than splitLineAtWordGaps: the latter
  // may conservatively keep an uncertain boundary inside one line, whereas a
  // language-model space may be removed only when even the largest physical
  // ink gap is clearly an intra-word gap.
  const maximumIntraWordGap = Math.max(5, Math.min(lineHeight * 0.16, typicalHeight * 0.42))
  return maximumGap <= maximumIntraWordGap
}

/** True only when the pen trajectory itself crosses a decoder-proposed word
 * boundary. Close but independent letter/word strokes do not satisfy this.
 * This is the missing evidence needed for unknown names and technical terms:
 * the dictionary cannot prove that `Xyq aro` is one word, while an unbroken
 * tablet trace through that exact boundary can. */
const hasContinuousInkAtBoundary = (
  line: StrokeLine,
  normalizedBoundary: number,
) => {
  const contentWidth = Math.max(1, line.maxX - line.minX)
  const contentHeight = Math.max(1, line.maxY - line.minY)
  const marginX = clamp(contentHeight * 0.22, 5, 48)
  const renderedWidth = contentWidth + marginX * 2
  const boundaryX = line.minX - marginX + clamp(normalizedBoundary, 0, 1) * renderedWidth
  const alignmentTolerance = clamp(contentHeight * 0.075, 1.5, 8)
  const maximumLocalStep = Math.max(6, contentHeight * 0.38)

  return line.entries.some((entry) => {
    if (
      entry.points.length < 2 ||
      entry.minX > boundaryX - alignmentTolerance ||
      entry.maxX < boundaryX + alignmentTolerance
    ) return false
    return entry.points.slice(1).some((point, index) => {
      const previous = entry.points[index]
      const minimumX = Math.min(previous.x, point.x)
      const maximumX = Math.max(previous.x, point.x)
      const horizontalDistance = boundaryX < minimumX
        ? minimumX - boundaryX
        : boundaryX > maximumX ? boundaryX - maximumX : 0
      if (horizontalDistance > alignmentTolerance) return false
      const stepLength = Math.hypot(point.x - previous.x, point.y - previous.y)
      return stepLength <= maximumLocalStep
    })
  })
}

const neuralTextSpaceBoundaries = (text: string) => {
  const boundaries: number[] = []
  let visible = 0
  let pendingSpace = false
  Array.from(text).forEach((character) => {
    if (/[ \t]/u.test(character)) {
      pendingSpace = visible > 0
      return
    }
    if (pendingSpace) boundaries.push(visible)
    visible += 1
    pendingSpace = false
  })
  return { boundaries, visible }
}

const connectedNeuralSpaceBoundaries = (
  text: string,
  line: StrokeLine,
  characters: readonly NeuralTextCharacter[],
) => {
  const { boundaries, visible } = neuralTextSpaceBoundaries(text)
  if (!boundaries.length || visible < 2) return new Set<number>()
  const positions = characters.length === visible
    ? characters
    : Array.from({ length: visible }, (_entry, index) => ({
      start: index / visible,
      end: (index + 1) / visible,
    }))
  return new Set(boundaries.filter((boundary) => {
    if (boundary <= 0 || boundary >= visible) return false
    const normalizedBoundary = (positions[boundary - 1].end + positions[boundary].start) / 2
    return hasContinuousInkAtBoundary(line, normalizedBoundary)
  }))
}

const applyNeuralPhysicalWordBoundaries = (
  text: string,
  line: StrokeLine,
  characters: readonly NeuralTextCharacter[],
  language: RecognitionLanguage,
) => {
  const physicalWords = splitLineAtWordGaps(line)
  if (physicalWords.length < 2) return text
  const letters = language === 'de' ? 'A-Za-zÄÖÜäöü' : 'A-Za-z'
  const plainWords = new RegExp(`^[${letters}0-9]+(?:[ \\t]+[${letters}0-9]+)*$`, 'u')
  if (!plainWords.test(text)) return text
  const currentWords = text.trim().split(/[ \t]+/u)
  if (currentWords.length === physicalWords.length) return text
  const visible = Array.from(text).filter((character) => !/[ \t]/u.test(character))
  if (visible.length < physicalWords.length) return text

  const positions = characters.length === visible.length
    ? characters
    : visible.map((char, index) => ({
      char,
      confidence: 0,
      start: index / visible.length,
      end: (index + 1) / visible.length,
    }))
  const contentWidth = Math.max(1, line.maxX - line.minX)
  const contentHeight = Math.max(1, line.maxY - line.minY)
  const marginX = clamp(contentHeight * 0.22, 5, 48)
  const renderedWidth = contentWidth + marginX * 2
  const cuts: number[] = []
  let previousCut = 0
  for (let boundaryIndex = 0; boundaryIndex < physicalWords.length - 1; boundaryIndex += 1) {
    const left = physicalWords[boundaryIndex]
    const right = physicalWords[boundaryIndex + 1]
    const physicalBoundary = ((left.maxX + right.minX) / 2 - line.minX + marginX) / renderedWidth
    const minimumCut = previousCut + 1
    const remainingGroups = physicalWords.length - boundaryIndex - 1
    const maximumCut = visible.length - remainingGroups
    let bestCut = minimumCut
    let bestDistance = Number.POSITIVE_INFINITY
    for (let cut = minimumCut; cut <= maximumCut; cut += 1) {
      const visualBoundary = (positions[cut - 1].end + positions[cut].start) / 2
      const distance = Math.abs(visualBoundary - physicalBoundary)
      if (distance < bestDistance) {
        bestDistance = distance
        bestCut = cut
      }
    }
    cuts.push(bestCut)
    previousCut = bestCut
  }
  const cutSet = new Set(cuts)
  return visible.map((character, index) => (
    index > 0 && cutSet.has(index) ? ` ${character}` : character
  )).join('')
}

const repairNeuralPhysicalWordSpacing = (
  text: string,
  line: StrokeLine,
  language: RecognitionLanguage,
  wordMembership?: WordMembership,
  characters: readonly NeuralTextCharacter[] = [],
) => {
  const letters = language === 'de' ? 'A-Za-zÄÖÜäöü' : 'A-Za-z'
  const pattern = new RegExp(`^[${letters}]+(?:[ \\t]+[${letters}]+){1,3}$`, 'u')
  if (!pattern.test(text) || splitLineAtWordGaps(line).length !== 1 || !hasTightSingleWordInk(line)) return text
  const locale = language === 'de' ? 'de-CH' : 'en-US'
  const joined = text.replace(/[ \t]+/gu, '')
  const lower = joined.toLocaleLowerCase(locale)
  const joinedIsKnown = (
    LANGUAGE_WORDS[language].has(lower)
    || wordMembership?.(lower)
    || isExtendedNeuralContextWord(lower, language)
  )
  if (joinedIsKnown) return joined

  // Unknown names and specialist terms cannot rely on a finite dictionary.
  // Remove only those model spaces whose exact boundary is crossed by one
  // continuous pen-down trajectory. A close pair of independent strokes is
  // deliberately left unchanged, so genuine short phrases remain possible.
  const connectedBoundaries = connectedNeuralSpaceBoundaries(text, line, characters)
  if (!connectedBoundaries.size) return text
  let visibleIndex = 0
  let pendingSpace = false
  let output = ''
  Array.from(text).forEach((character) => {
    if (/[ \t]/u.test(character)) {
      pendingSpace = visibleIndex > 0
      return
    }
    if (pendingSpace && !connectedBoundaries.has(visibleIndex)) output += ' '
    output += character
    visibleIndex += 1
    pendingSpace = false
  })
  return output
}

/** Pure geometry hook for regressions of visually absent versus genuine word
 * gaps. It never runs a model and does not accept a reference transcription. */
export const repairNeuralPhysicalWordSpacingForTests = (
  text: string,
  strokes: Stroke[],
  language: RecognitionLanguage,
  sourceWidth = 100,
  sourceHeight = 100,
) => {
  const line = groupNeuralTextLines(strokes, sourceWidth, sourceHeight)[0]
  const visible = Array.from(text).filter((character) => !/[ \t]/u.test(character))
  return line ? repairNeuralPhysicalWordSpacing(
    text,
    line,
    language,
    undefined,
    visible.map((char, index) => ({
      char,
      confidence: 0,
      start: index / Math.max(1, visible.length),
      end: (index + 1) / Math.max(1, visible.length),
    })),
  ) : text
}

export const applyNeuralPhysicalWordBoundariesForTests = (
  text: string,
  strokes: Stroke[],
  language: RecognitionLanguage,
  sourceWidth = 100,
  sourceHeight = 100,
) => {
  const line = groupNeuralTextLines(strokes, sourceWidth, sourceHeight)[0]
  if (!line) return text
  const visible = Array.from(text).filter((character) => !/[ \t]/u.test(character))
  return applyNeuralPhysicalWordBoundaries(
    text,
    line,
    visible.map((char, index) => ({
      char,
      confidence: 0,
      start: index / Math.max(1, visible.length),
      end: (index + 1) / Math.max(1, visible.length),
    })),
    language,
  )
}

/** Deterministic geometry diagnostic used by real-ink regressions. */
export const neuralTextPhysicalWordGroupsForTests = (
  strokes: Stroke[],
  sourceWidth: number,
  sourceHeight: number,
) => groupNeuralTextLines(strokes, sourceWidth, sourceHeight).map((line) => (
  splitLineAtWordGaps(line).map((word) => ({
    minX: word.minX,
    maxX: word.maxX,
    minY: word.minY,
    maxY: word.maxY,
    strokes: word.entries.length,
  }))
))

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

const commonWordEvidence = (value: string, language: RecognitionLanguage) => {
  const words = value.toLocaleLowerCase(language)
    .match(language === 'de' ? /[a-zäöü]{2,}/giu : /[a-z]{2,}/giu) ?? []
  return {
    count: words.length,
    common: words.filter((word) => LANGUAGE_WORDS[language].has(word)).length,
  }
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
    { preserveExtendedWords: false, requirePlausibilityLead: false },
  )
  const contextualBeamText = beamText
    ? applyNeuralWordContext(
      beamText,
      language,
      { preserveExtendedWords: false, requirePlausibilityLead: false },
    )
    : ''
  const beamEvidence = commonWordEvidence(contextualBeamText, language)
  const greedyEvidence = commonWordEvidence(greedyText, language)
  // A rare dictionary word can narrowly win the beam score even when the
  // direct visual path contains a frequent word at the same physical
  // position (for example `herst` versus `test`). Prefer that direct path
  // only with identical word structure, a local difference, and strictly
  // stronger common-word evidence.
  const greedyHasClearLocalEvidence = Boolean(contextualBeamText)
    && beamEvidence.count === greedyEvidence.count
    && greedyEvidence.common > beamEvidence.common
    && wordDistance(
      contextualBeamText.toLocaleLowerCase(language),
      greedyText.toLocaleLowerCase(language),
    ) / Math.max(1, contextualBeamText.length, greedyText.length) <= 0.24
  const text = contextualBeamText
    && !greedyHasClearLocalEvidence
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

const terminalEnglishArticleMismatch = (value: string) => (
  /(?:^|\s)(?:a|an)\s+(?:a|an|the|and|or|but|more|most|very|is|are|was|were|to|of|in|on|at)(?=$|[.,;:!?])/iu
    .test(value)
)

type TrustedPhysicalWordEvidence = {
  count: number
  minimumConfidence: number
}

const splitFusionTokens = (value: string) => value.trim()
  ? value.trim().split(/\s+/u)
  : []

const sharedLeadingCharacters = (first: string, second: string) => {
  const left = Array.from(first)
  const right = Array.from(second)
  let count = 0
  while (count < left.length && count < right.length && left[count] === right[count]) count += 1
  return count
}

const sharedVisualCommonWord = (
  compactWord: string,
  contextWord: string,
  language: RecognitionLanguage,
) => {
  const lengthDifference = Math.abs(compactWord.length - contextWord.length)
  const modelDistance = wordDistance(compactWord, contextWord)
  const nearConsensus = (
    lengthDifference === 0
    && modelDistance <= 1
  )
  // Two independent decoders can damage different positions and even insert
  // one character (`rennen` versus `learner`). Admit the unique common word
  // between them only in the symmetric two-edit case; anything less balanced
  // remains the literal visual output.
  const divergentConsensus = (
    Math.min(compactWord.length, contextWord.length) >= 5
    && lengthDifference <= 1
    && modelDistance >= 3
    && modelDistance <= 5
  )
  if (
    compactWord === contextWord
    || compactWord.length < 4
    || contextWord.length < 4
    || Math.max(compactWord.length, contextWord.length) > 12
    || LANGUAGE_WORDS[language].has(compactWord)
    || LANGUAGE_WORDS[language].has(contextWord)
    || (!nearConsensus && !divergentConsensus)
  ) return ''
  const ranked = LANGUAGE_WORD_LISTS[language]
    .filter((candidate) => (
      candidate.length === compactWord.length || candidate.length === contextWord.length
    ))
    .map((candidate) => {
      const compactDistance = wordDistance(compactWord, candidate)
      const contextDistance = wordDistance(contextWord, candidate)
      return {
        candidate,
        compactDistance,
        contextDistance,
        total: compactDistance + contextDistance,
        maximum: Math.max(compactDistance, contextDistance),
      }
    })
    .filter(({ compactDistance, contextDistance, total }) => nearConsensus
      ? compactDistance <= 1 && contextDistance <= 2 && total <= 3
      : compactDistance === 2 && contextDistance === 2 && total === 4)
    .sort((first, second) => (
      first.total - second.total
      || first.maximum - second.maximum
      || (LANGUAGE_WORD_RANKS[language].get(first.candidate) ?? Number.MAX_SAFE_INTEGER)
        - (LANGUAGE_WORD_RANKS[language].get(second.candidate) ?? Number.MAX_SAFE_INTEGER)
    ))
  const best = ranked[0]
  const next = ranked[1]
  if (!best || (next && best.total === next.total && best.maximum === next.maximum)) return ''
  return best.candidate
}

const fusionWordSurface = (token: string, language: RecognitionLanguage) => (
  token.match(language === 'de' ? /[A-Za-zÄÖÜäöü]{2,}/u : /[A-Za-z]{2,}/u)?.[0]
    ?.toLocaleLowerCase(language) ?? ''
)

const fusionAlignmentSurface = (token: string, language: RecognitionLanguage) => (
  token.match(language === 'de' ? /[A-Za-zÄÖÜäöü]+|\d+/u : /[A-Za-z]+|\d+/u)?.[0]
    ?.toLocaleLowerCase(language) ?? ''
)

/** Returns a common equal-length neighbour only when a rare but valid context
 * word conflicts with an independent compact visual path that supports the
 * neighbour at least as well. The caller must obtain one more visual crop
 * before changing anything; this function alone never rewrites text. */
const rareContextCommonNeighbour = (
  compactText: string,
  contextText: string,
  contextRawText: string,
  language: RecognitionLanguage,
) => {
  const compactTokens = splitFusionTokens(compactText)
  const contextTokens = splitFusionTokens(contextText)
  if (compactTokens.length !== 1 || contextTokens.length !== 1) return ''
  const compactWord = fusionAlignmentSurface(compactTokens[0], language)
  const contextWord = fusionAlignmentSurface(contextTokens[0], language)
  const rawSurface = contextRawText.trim().match(/\p{L}+/u)?.[0] ?? ''
  if (
    !compactWord
    || !contextWord
    || compactWord === contextWord
    || contextWord.length < 4
    || contextWord.length > 12
    || LANGUAGE_WORDS[language].has(contextWord)
    || !isExtendedNeuralContextWord(contextWord, language)
    || /^\p{Lu}/u.test(rawSurface)
    || /\p{Ll}\p{Lu}/u.test(rawSurface)
  ) return ''
  const neighbours = LANGUAGE_WORD_LISTS[language].filter((candidate) => (
    candidate.length === contextWord.length
    && wordDistance(contextWord, candidate) === 1
  ))
  if (neighbours.length !== 1) return ''
  const candidate = neighbours[0]
  const contextDistance = wordDistance(compactWord, contextWord)
  const candidateDistance = wordDistance(compactWord, candidate)
  return contextDistance >= 2 && candidateDistance <= contextDistance ? candidate : ''
}

export const rareContextCommonNeighbourForTests = rareContextCommonNeighbour

const containsUnknownContextWord = (
  text: string,
  language: RecognitionLanguage,
  wordMembership?: WordMembership,
) => {
  const words = text.toLocaleLowerCase(language)
    .match(language === 'de' ? /[a-zäöü]{3,}/giu : /[a-z]{3,}/giu) ?? []
  return words.some((word) => !LANGUAGE_WORDS[language].has(word) && !wordMembership?.(word))
}

/** Transformers.js 3.8's image pipeline currently exposes only one generated
 * sequence even when its sampler is configured with multiple beams. Request a
 * genuinely independent rendering only when the first context view remains
 * unsupported, or when both visual paths disagree and either reading contains
 * an unknown word. This includes a visually plausible uncommon name opposed
 * by a frequent context hallucination. Fully known lines retain the
 * single-inference fast path. */
const shouldRequestIndependentTrocrView = (
  candidateCount: number,
  compactText: string,
  contextText: string,
  contextNeedsContext: boolean,
  language: RecognitionLanguage,
  wordMembership?: WordMembership,
) => {
  if (candidateCount > 1 || !contextText) return false
  if (contextNeedsContext) return true
  const compactSurface = compactText.toLocaleLowerCase(language).trim()
  const contextSurface = contextText.toLocaleLowerCase(language).trim()
  if (!compactSurface || compactSurface === contextSurface) return false
  return containsUnknownContextWord(contextText, language, wordMembership)
    || containsUnknownContextWord(compactText, language, wordMembership)
}

export const shouldRequestIndependentTrocrViewForTests = shouldRequestIndependentTrocrView

/** A complete-line decoder can prepend or append a short fluent phrase beyond
 * the ink. It is not safe to trim merely because two models disagree: this
 * guard activates only after every independently separated physical word was
 * recognized as a non-suspicious single word and one unique contiguous
 * context window aligns with all of them. */
const removeUnbackedContextWords = (
  compactTokens: string[],
  contextTokens: string[],
  contextRawText: string,
  language: RecognitionLanguage,
  physicalWords?: TrustedPhysicalWordEvidence,
) => {
  if (
    !physicalWords ||
    physicalWords.count < 2 ||
    physicalWords.minimumConfidence < 68 ||
    compactTokens.length !== physicalWords.count ||
    contextTokens.length <= compactTokens.length ||
    contextTokens.length > compactTokens.length + 3
  ) return contextTokens

  const rawContextTokens = splitFusionTokens(contextRawText)
  if (rawContextTokens.length !== contextTokens.length) return contextTokens
  const extraCount = contextTokens.length - compactTokens.length
  const validExtra = (index: number) => {
    const extraWord = fusionWordSurface(contextTokens[index], language)
    const rawExtraWord = fusionWordSurface(rawContextTokens[index], language)
    return Boolean(
      extraWord
      && extraWord === rawExtraWord
      && LANGUAGE_WORDS[language].has(extraWord)
      && (contextTokens[index].match(/\p{L}+/u)?.[0] ?? '') === extraWord,
    )
  }
  const alignedCandidates: Array<{
    removed: number[]
    tokens: string[]
    exactMatches: number
    totalDistance: number
  }> = []
  const removalSets: number[][] = []
  const collectRemovalSets = (from: number, selected: number[]) => {
    if (selected.length === extraCount) {
      removalSets.push([...selected])
      return
    }
    const remaining = extraCount - selected.length
    for (let index = from; index <= contextTokens.length - remaining; index += 1) {
      selected.push(index)
      collectRemovalSets(index + 1, selected)
      selected.pop()
    }
  }
  collectRemovalSets(0, [])
  for (const removed of removalSets) {
    if (!removed.every(validExtra)) continue
    const removedSet = new Set(removed)
    const alignedContext = contextTokens.filter((_token, index) => !removedSet.has(index))
    let exactMatches = 0
    let totalDistance = 0
    let validAlignment = true
    for (let index = 0; index < compactTokens.length; index += 1) {
      const compactWord = fusionAlignmentSurface(compactTokens[index], language)
      const contextWord = fusionAlignmentSurface(alignedContext[index], language)
      if (!compactWord || !contextWord) {
        validAlignment = false
        break
      }
      const distance = wordDistance(compactWord, contextWord)
      // One longer name can legitimately need two visual substitutions while
      // surrounding words agree exactly (Trewer → Trevor). Aggregate gates
      // keep that local exception from turning into fuzzy phrase deletion.
      const allowedDistance = Math.max(1, Math.floor(Math.max(compactWord.length, contextWord.length) * 0.34))
      if (distance > allowedDistance) {
        validAlignment = false
        break
      }
      if (distance === 0) exactMatches += 1
      totalDistance += distance
    }
    if (
      !validAlignment
      || exactMatches < Math.max(1, compactTokens.length - 2)
      || totalDistance > Math.max(1, Math.floor(compactTokens.length * 0.45))
    ) continue
    alignedCandidates.push({ removed, tokens: alignedContext, exactMatches, totalDistance })
  }
  alignedCandidates.sort((first, second) => (
    second.exactMatches - first.exactMatches
    || first.totalDistance - second.totalDistance
    || first.removed.join(',').localeCompare(second.removed.join(','))
  ))
  const best = alignedCandidates[0]
  const runnerUp = alignedCandidates[1]
  if (
    !best
    || (
      runnerUp
      && runnerUp.exactMatches === best.exactMatches
      && runnerUp.totalDistance === best.totalDistance
    )
  ) return contextTokens
  return best.tokens
}

const restoreBackedTrailingCompactWords = (
  compactTokens: string[],
  compactRawText: string,
  contextTokens: string[],
  contextRawText: string,
  language: RecognitionLanguage,
  physicalWords?: TrustedPhysicalWordEvidence,
) => {
  const compactRawTokens = splitFusionTokens(compactRawText)
  const rawContextTokens = splitFusionTokens(contextRawText)
  const hasTrustedPhysicalBacking = Boolean(
    physicalWords
    && physicalWords.count >= 2
    && physicalWords.minimumConfidence >= 68
    && compactTokens.length === physicalWords.count
  )
  // Physical word separation is the strongest completeness proof, but the
  // complete-line CTC decoder is also independent visual evidence. If both
  // its literal surface and its corrected surface contain the same longer
  // token sequence, a context decoder that emits only a matching prefix must
  // not delete the remaining ink. This path is intentionally unavailable for
  // a one-word prefix, terminal punctuation, or a changed/unsupported tail.
  const hasIndependentCompactContinuation = Boolean(
    !hasTrustedPhysicalBacking
    && contextTokens.length >= 2
    && compactTokens.length > contextTokens.length
    && compactTokens.length <= MAX_PHYSICAL_WORDS
    && compactRawTokens.length === compactTokens.length
    && rawContextTokens.length === contextTokens.length
    && !/[.!?]$/u.test(contextRawText.trim())
    && compactTokens.slice(contextTokens.length).every((token, suffixIndex) => {
      const rawToken = compactRawTokens[contextTokens.length + suffixIndex]
      const correctedWord = fusionAlignmentSurface(token, language)
      const rawWord = fusionAlignmentSurface(rawToken, language)
      return Boolean(
        correctedWord
        && rawWord
        && wordDistance(correctedWord, rawWord) <= Math.max(1, Math.floor(correctedWord.length * 0.18))
      )
    })
  )
  if (
    (!hasTrustedPhysicalBacking && !hasIndependentCompactContinuation)
    || contextTokens.length >= compactTokens.length
    || contextTokens.length < 1
  ) return contextTokens

  if (rawContextTokens.length !== contextTokens.length) return compactTokens
  let exactMatches = 0
  let totalDistance = 0
  for (let index = 0; index < contextTokens.length; index += 1) {
    const compactWord = fusionAlignmentSurface(compactTokens[index], language)
    const rawContextWord = fusionAlignmentSurface(rawContextTokens[index], language)
    if (!compactWord || !rawContextWord) return compactTokens
    const distance = wordDistance(compactWord, rawContextWord)
    const allowedDistance = Math.max(1, Math.floor(Math.max(compactWord.length, rawContextWord.length) * 0.34))
    if (distance > allowedDistance) return compactTokens
    if (distance === 0) exactMatches += 1
    totalDistance += distance
  }
  if (
    exactMatches < Math.max(1, contextTokens.length - 2)
    || totalDistance > Math.max(1, Math.floor(contextTokens.length * 0.5))
  ) return compactTokens
  return [...contextTokens, ...compactTokens.slice(contextTokens.length)]
}

const fuseCompactAndContextWords = (
  compactText: string,
  compactRawText: string,
  contextText: string,
  language: RecognitionLanguage,
  wordMembership?: WordMembership,
  physicalWords?: TrustedPhysicalWordEvidence,
  contextRawText = contextText,
) => {
  const compactTokens = splitFusionTokens(compactText)
  const compactRawTokens = splitFusionTokens(compactRawText)
  const contextRawTokens = splitFusionTokens(contextRawText)
  const trimmedContextTokens = removeUnbackedContextWords(
    compactTokens,
    splitFusionTokens(contextText),
    contextRawText,
    language,
    physicalWords,
  )
  const contextTokens = restoreBackedTrailingCompactWords(
    compactTokens,
    compactRawText,
    trimmedContextTokens,
    contextRawText,
    language,
    physicalWords,
  )
  if (compactTokens.length !== contextTokens.length) return contextText
  const wordPattern = language === 'de' ? /[A-Za-zÄÖÜäöü]{2,}/u : /[A-Za-z]{2,}/u
  const fusedTokens = compactTokens.map((compactToken, index) => {
    const contextToken = contextTokens[index]
    const compactWord = compactToken.match(wordPattern)?.[0]?.toLocaleLowerCase(language)
    const compactRawWord = compactRawTokens.length === compactTokens.length
      ? compactRawTokens[index]?.match(wordPattern)?.[0]?.toLocaleLowerCase(language)
      : undefined
    const contextWord = contextToken.match(wordPattern)?.[0]?.toLocaleLowerCase(language)
    const contextRawWord = contextRawTokens.length === contextTokens.length
      ? contextRawTokens[index]?.match(wordPattern)?.[0]?.toLocaleLowerCase(language)
      : undefined
    if (!compactWord || !contextWord) return compactToken
    const consensusWord = sharedVisualCommonWord(compactWord, contextRawWord || contextWord, language)
    if (consensusWord) {
      const compactSurface = compactToken.match(wordPattern)?.[0] ?? compactWord
      return compactToken.replace(wordPattern, preserveWordCase(compactSurface, consensusWord, language))
    }
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
    // If the independent context model reproduces the CTC surface exactly,
    // two visual paths agree and an earlier dictionary-only CTC rewrite must
    // not veto them (for example raw/context `more` versus rewritten `here`).
    // Keep the local correction only when the context model does not confirm
    // the raw visual word; this still protects Frevor → Trevor.
    const contextConfirmsCompactRaw = Boolean(compactRawWord && compactRawWord === contextWord)
    // A dictionary rewrite made only on the complete-line path has no
    // independent visual advantage when the compact decoder is equally close
    // to that model's raw surface. Preserve the compact reading in this tie;
    // otherwise an ordinary word can change merely because another valid
    // dictionary word exists one edit away.
    const contextWasCorrected = Boolean(contextRawWord && contextRawWord !== contextWord)
    const contextCorrectionDistance = contextRawWord
      ? wordDistance(contextRawWord, contextWord)
      : Number.POSITIVE_INFINITY
    const compactDistanceFromContextInk = contextRawWord
      ? wordDistance(contextRawWord, compactWord)
      : Number.POSITIVE_INFINITY
    const compactIsAtLeastAsVisual = Boolean(
      contextRawWord
      && contextWasCorrected
      && (
        compactDistanceFromContextInk < contextCorrectionDistance
        || (
          compactDistanceFromContextInk === contextCorrectionDistance
          && sharedLeadingCharacters(contextRawWord, compactWord)
            > sharedLeadingCharacters(contextRawWord, contextWord)
        )
      ),
    )
    if (compactIsAtLeastAsVisual) return compactToken
    const protectedLocalCorrection = /^\p{Lu}\p{Ll}{2,}$/u.test(compactToken)
      || /\p{Ll}\p{Lu}/u.test(compactToken)
    if (
      compactWasCorrected && compactKnown && protectedLocalCorrection
      && !contextConfirmsCompactRaw
    ) return compactToken
    if (contextKnown) return contextToken
    return compactKnown ? compactToken : contextToken
  })
  const fusedText = fusedTokens.join(' ')
  if (
    language === 'en' &&
    terminalEnglishArticleMismatch(fusedText) &&
    !terminalEnglishArticleMismatch(compactRawText) &&
    fusedTokens.length >= 2
  ) {
    const rawTerminal = compactRawTokens.at(-1)?.match(/[A-Za-z]{2,}/u)?.[0] ?? ''
    const rawTerminalKnown = rawTerminal && (
      LANGUAGE_WORDS.en.has(rawTerminal.toLocaleLowerCase('en-US')) ||
      wordMembership?.(rawTerminal.toLocaleLowerCase('en-US')) ||
      isExtendedNeuralContextWord(rawTerminal.toLocaleLowerCase('en-US'), 'en')
    )
    // Keep all better line-context choices (for example the independently
    // recovered proper name `Trevor`) but restore only a lexicon-backed raw
    // visual word that makes the article phrase complete (`A move`, not
    // `A more`). The raw token is never used without both checks.
    if (rawTerminalKnown) fusedTokens[fusedTokens.length - 1] = compactRawTokens[compactRawTokens.length - 1]
  }
  return fusedTokens.join(' ')
}

/** Pure deterministic regression hook; production supplies evidence only
 * after successful per-word image recognition. */
export const fuseNeuralPhysicalWordsForTests = (
  compactText: string,
  compactRawText: string,
  contextText: string,
  contextRawText: string,
  language: RecognitionLanguage,
  physicalWordCount?: number,
  minimumWordConfidence = 0,
) => fuseCompactAndContextWords(
  compactText,
  compactRawText,
  contextText,
  language,
  undefined,
  physicalWordCount === undefined
    ? undefined
    : { count: physicalWordCount, minimumConfidence: minimumWordConfidence },
  contextRawText,
)

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
  const structurallySuspicious = (
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
  const needsContext = structurallySuspicious || unsupportedShortWord
  const lengthFit = visible.length >= minimumCharacters && visible.length <= maximumCharacters ? 0.8 : -2.4
  const score = neuralTextHypothesisScore(text, language, wordMembership)
    + lengthFit
    + Math.min(0.8, knownRatio * 0.8)
    + Math.min(0.45, (letters + digits) / Math.max(1, visible.length) * 0.45)
  const confidence = Math.round(clamp(68 + knownRatio * 12 + lengthFit * 4 - invalid * 8, 35, 88))
  return {
    suspicious: structurallySuspicious,
    needsContext,
    lexicallyUnsupported: unsupportedShortWord,
    score,
    confidence,
  }
}

type TrocrWordSurface = { value: string; start: number; end: number }

const trocrWordSurfaces = (value: string, language: RecognitionLanguage): TrocrWordSurface[] => {
  const pattern = language === 'de' ? /[A-Za-zÄÖÜäöü]+/gu : /[A-Za-z]+/gu
  return [...value.matchAll(pattern)].map((match) => ({
    value: match[0],
    start: match.index,
    end: match.index + match[0].length,
  }))
}

const trocrStructuralRewritePenalty = (
  visualTop: string,
  candidate: string,
  language: RecognitionLanguage,
) => {
  let penalty = 0
  const sourceWords = trocrWordSurfaces(visualTop, language)
  const candidateWords = trocrWordSurfaces(candidate, language)
  if (candidateWords.length > sourceWords.length) {
    const locale = language === 'de' ? 'de-CH' : 'en-US'
    const sourceLetters = sourceWords.map((word) => word.value).join('').toLocaleLowerCase(locale)
    const candidateLetters = candidateWords.map((word) => word.value).join('').toLocaleLowerCase(locale)
    if (sourceLetters !== candidateLetters) {
      // A fused English conjunction is a recurring decoder boundary error;
      // the second beam may still repair the neighbouring word by one letter
      // while restoring that independently meaningful boundary (`andsuper` →
      // `and supper`). Other rewritten splits remain unsupported here.
      const separatesFusedAnd = language === 'en'
        && /\band(?=\p{L})/iu.test(visualTop)
        && /\band\s+\p{L}/iu.test(candidate)
      if (!separatesFusedAnd) penalty += TROCR_UNSUPPORTED_STRUCTURE_PENALTY
    } else {
      const sourceBoundaries = new Set<number>()
      let sourceOffset = 0
      sourceWords.slice(0, -1).forEach((word) => {
        sourceOffset += Array.from(word.value).length
        sourceBoundaries.add(sourceOffset)
      })
      let candidateOffset = 0
      for (let index = 0; index < candidateWords.length - 1; index += 1) {
        candidateOffset += Array.from(candidateWords[index].value).length
        if (sourceBoundaries.has(candidateOffset)) continue
        const left = candidateWords[index].value.toLocaleLowerCase(locale)
        const right = candidateWords[index + 1].value.toLocaleLowerCase(locale)
        const shortFunctionWord = [left, right].some((word) => (
          Array.from(word).length <= 3 && LANGUAGE_WORDS[language].has(word)
        ))
        if (!shortFunctionWord) {
          penalty += TROCR_UNSUPPORTED_STRUCTURE_PENALTY
          break
        }
      }
    }
  }
  const sourceLetters = sourceWords.map((word) => word.value).join('').toLocaleLowerCase(language)
  const candidateLetters = candidateWords.map((word) => word.value).join('').toLocaleLowerCase(language)
  if (
    sourceLetters !== candidateLetters
    && /\p{L}-$/u.test(visualTop)
    && /\p{L}+\s+-$/u.test(candidate)
  ) {
    penalty += TROCR_UNSUPPORTED_STRUCTURE_PENALTY
  }
  const availablePunctuation = new Map<string, number>()
  Array.from(visualTop).forEach((character) => {
    if (!PUNCTUATION.has(character)) return
    availablePunctuation.set(character, (availablePunctuation.get(character) ?? 0) + 1)
  })
  const candidateCharacters = Array.from(candidate.trimEnd())
  const introducesUnsupportedPunctuation = candidateCharacters.some((character, index) => {
    if (!PUNCTUATION.has(character)) return false
    const remaining = availablePunctuation.get(character) ?? 0
    if (remaining > 0) {
      availablePunctuation.set(character, remaining - 1)
      return false
    }
    // Terminal punctuation is independently checked against visible ink by
    // normalizedTrocrText. Internal punctuation has no such support and must
    // not let a lower visual hypothesis manufacture a dictionary word
    // (`Hamburges` -> `Hamburg,`). Removing spurious punctuation stays free.
    return index < candidateCharacters.length - 1 || !/[.,!?]/u.test(character)
  })
  if (introducesUnsupportedPunctuation) {
    penalty += TROCR_UNSUPPORTED_STRUCTURE_PENALTY
  }
  return penalty
}

export const trocrStructuralRewritePenaltyForTests = trocrStructuralRewritePenalty

const trocrOrdinaryWordNamePenalty = (
  visualTop: string,
  candidate: string,
  language: RecognitionLanguage,
  wordMembership?: WordMembership,
) => {
  if (language !== 'en') return 0
  const sourceWords = trocrWordSurfaces(visualTop, language)
  const candidateWords = trocrWordSurfaces(candidate, language)
  if (sourceWords.length !== candidateWords.length) return 0
  const changed = sourceWords.flatMap((source, index) => (
    source.value === candidateWords[index]?.value
      ? []
      : [{ source, target: candidateWords[index] }]
  ))
  if (changed.length !== 1 || !changed[0].target) return 0
  const { source, target } = changed[0]
  if (!/^\p{Lu}\p{Ll}{2,}$/u.test(source.value)) return 0
  const targetIsTitleCase = /^\p{Lu}\p{Ll}{2,}$/u.test(target.value)
  if (!targetIsTitleCase) return 0
  const prefix = visualTop.slice(0, source.start).trimEnd().replace(/["'’\])}]+$/gu, '').trimEnd()
  if (!prefix || /[.!?]$/u.test(prefix)) return 0
  const sourceLower = source.value.toLocaleLowerCase('en-US')
  const targetLower = target.value.toLocaleLowerCase('en-US')
  const known = (word: string) => LANGUAGE_WORDS.en.has(word) || Boolean(wordMembership?.(word))
  if (known(sourceLower) || !known(targetLower)) return 0

  if (ENGLISH_CANONICAL_PROPER_NAMES.has(targetLower)) {
    // Replacing one plausible name with a more frequent canonical name is
    // allowed by default (`Geleste` -> `Celeste`). An explicit title or name
    // connector, however, independently proves that this exact visual token is
    // part of a name sequence; frequency alone must not rewrite it.
    const suffix = visualTop.slice(source.end)
    const followsNameTitle = /(?:^|\s)(?:rabbi|dr|doctor|prof|professor|mr|mrs|ms|saint|st)\.?$/iu.test(prefix)
    const precedesNameConnector = /^\s+(?:al|ben|bin|de|del|der|di|ibn|van|von)\b/iu.test(suffix)
    if (!followsNameTitle && !precedesNameConnector) return 0
  }
  return TROCR_ORDINARY_WORD_NAME_PENALTY
}

export const trocrOrdinaryWordNamePenaltyForTests = trocrOrdinaryWordNamePenalty

const trocrDenseGermanNamePenalty = (
  visualTop: string,
  candidate: string,
  language: RecognitionLanguage,
  wordMembership?: WordMembership,
) => {
  if (language !== 'de') return 0
  const sourceWords = trocrWordSurfaces(visualTop, language)
  const candidateWords = trocrWordSurfaces(candidate, language)
  if (sourceWords.length !== candidateWords.length) return 0
  const titleCase = (word?: TrocrWordSurface) => Boolean(word && /^\p{Lu}\p{Ll}{2,}$/u.test(word.value))
  const known = (word: string) => LANGUAGE_WORDS.de.has(word) || Boolean(wordMembership?.(word))
  const directlyAdjacent = (leftIndex: number, rightIndex: number) => (
    titleCase(sourceWords[leftIndex])
    && titleCase(sourceWords[rightIndex])
    && /^\s+$/u.test(visualTop.slice(sourceWords[leftIndex].end, sourceWords[rightIndex].start))
  )
  for (let index = 0; index < sourceWords.length; index += 1) {
    const source = sourceWords[index]
    const target = candidateWords[index]
    if (!target || source.value === target.value || !titleCase(source)) continue
    let runStart = index
    let runEnd = index
    while (runStart > 0 && directlyAdjacent(runStart - 1, runStart)) runStart -= 1
    while (runEnd + 1 < sourceWords.length && directlyAdjacent(runEnd, runEnd + 1)) runEnd += 1
    const runLength = runEnd - runStart + 1
    const withinNameRun = runLength >= 3 || (runLength === 2 && sourceWords.length === 2)
    if (!withinNameRun) continue
    const sourceLower = source.value.toLocaleLowerCase('de-CH')
    const targetLower = target.value.toLocaleLowerCase('de-CH')
    if (!known(sourceLower) && known(targetLower)) return TROCR_ORDINARY_WORD_NAME_PENALTY
  }
  return 0
}

export const trocrDenseGermanNamePenaltyForTests = trocrDenseGermanNamePenalty

type TrocrLexicalRepairDisposition = 'none' | 'safe' | 'competing'

const trocrLexicalRepairDisposition = (
  visualTop: string,
  candidate: string,
  language: RecognitionLanguage,
  wordMembership?: WordMembership,
): TrocrLexicalRepairDisposition => {
  if (
    Math.abs(Array.from(candidate).length - Array.from(visualTop).length) > 1
    || wordDistance(visualTop, candidate) > 2
    || visualTop.replace(/[\p{L}\p{N}\s]/gu, '') !== candidate.replace(/[\p{L}\p{N}\s]/gu, '')
  ) return 'none'
  const sourceWords = trocrWordSurfaces(visualTop, language)
  const candidateWords = trocrWordSurfaces(candidate, language)
  if (sourceWords.length !== candidateWords.length) return 'none'
  const changed = sourceWords.flatMap((source, index) => (
    source.value === candidateWords[index]?.value
      ? []
      : [{ source, candidate: candidateWords[index] }]
  ))
  if (changed.length !== 1) return 'none'
  const repair = changed[0]
  if (!repair.candidate) return 'none'
  const source = repair.source.value
  const target = repair.candidate.value
  const sourceLower = source.toLocaleLowerCase(language)
  const targetLower = target.toLocaleLowerCase(language)
  const adjacentJoiner = (text: string, word: TrocrWordSurface) => (
    /[-'’]/u.test(text[word.start - 1] ?? '') || /[-'’]/u.test(text[word.end] ?? '')
  )
  const known = (word: string) => LANGUAGE_WORDS[language].has(word) || Boolean(wordMembership?.(word))
  const eligible = (
    source.length >= 4
    && target.length >= 4
    && source === sourceLower
    && target === targetLower
    && !adjacentJoiner(visualTop, repair.source)
    && !adjacentJoiner(candidate, repair.candidate)
    && !known(sourceLower)
    && known(targetLower)
  )
  if (!eligible) return 'none'
  // This expensive exhaustive lookup is intentionally reached only for the
  // single unknown word of an otherwise eligible lower beam, never once per
  // sentence or per ordinary candidate. It mirrors the correction that the
  // selected top beam would receive immediately after ranking.
  const topCorrection = applyFinalNeuralWordContext(source, language)
  const topCorrectionLower = topCorrection.toLocaleLowerCase(language)
  if (
    topCorrectionLower !== sourceLower
    && topCorrectionLower !== targetLower
    && known(topCorrectionLower)
  ) return 'competing'
  return 'safe'
}

/** Selects only among hypotheses emitted by the visual model. The small rank
 * penalty retains the decoder's acoustic order unless independent lexical or
 * grammatical evidence is materially better; expected test text is never
 * available here. */
const rankTrocrCandidates = (
  rawCandidates: readonly string[],
  line: StrokeLine,
  language: RecognitionLanguage,
  wordMembership?: WordMembership,
) => {
  const candidates = [...new Set(rawCandidates.map((rawText) => normalizeGermanSharpS(rawText).normalize('NFC').trim()))]
    .filter(Boolean)
  const visualTopWords = candidates[0]?.match(/\p{L}+/gu) ?? []
  return candidates.map((rawText, index) => {
    const text = normalizedTrocrText(rawText, language, line)
    const assessment = trocrLineAssessment(text, line, language, wordMembership)
    const grammarPenalty = language === 'en' && terminalEnglishArticleMismatch(text) ? 1.15 : 0
    const candidateWords = rawText.match(/\p{L}+/gu) ?? []
    const mixedCaseVisualPenalty = index === 0 ? 0 : visualTopWords.reduce((penalty, sourceWord, wordIndex) => {
      const letters = Array.from(sourceWord)
      const hasIntentionalInternalUppercase = letters.slice(1).some((character) => (
        character === character.toLocaleUpperCase(language) &&
        character !== character.toLocaleLowerCase(language)
      ))
      if (!hasIntentionalInternalUppercase || candidateWords[wordIndex] === sourceWord) return penalty
      return penalty + TROCR_VISUAL_RANK_PENALTY
    }, 0)
    const baseScore = assessment.score - grammarPenalty - mixedCaseVisualPenalty
    const repairDisposition = index > 0
      ? trocrLexicalRepairDisposition(candidates[0], rawText, language, wordMembership)
      : 'none'
    const safeRepairBonus = repairDisposition === 'safe' ? TROCR_SAFE_WORD_REPAIR_BONUS : 0
    const competingRepairPenalty = repairDisposition === 'competing'
      ? TROCR_COMPETING_WORD_REPAIR_PENALTY
      : 0
    const structuralRewritePenalty = index > 0
      ? trocrStructuralRewritePenalty(candidates[0], rawText, language)
      : 0
    const ordinaryWordNamePenalty = index > 0
      ? trocrOrdinaryWordNamePenalty(candidates[0], rawText, language, wordMembership)
      : 0
    const denseGermanNamePenalty = index > 0
      ? trocrDenseGermanNamePenalty(candidates[0], rawText, language, wordMembership)
      : 0
    return {
      rawText,
      text,
      assessment,
      visualRank: index,
      baseScore,
      score: baseScore - index * TROCR_VISUAL_RANK_PENALTY
        + safeRepairBonus - competingRepairPenalty - structuralRewritePenalty
        - ordinaryWordNamePenalty - denseGermanNamePenalty,
    }
  })
  .sort((first, second) => second.score - first.score)
}

/** Deterministic N-best diagnostic. It intentionally returns only candidates
 * emitted by the visual decoder; reference text is never accepted. */
export const rankTrocrCandidateTextsForTests = (
  rawCandidates: readonly string[],
  language: RecognitionLanguage,
  wordMembership?: WordMembership,
) => {
  const visibleLength = Math.max(3, ...rawCandidates.map((candidate) => (
    Array.from(candidate).filter((character) => !/\s/u.test(character)).length
  )))
  const line = lineFromEntries([{
    stroke: { baseWidth: 3, pressureEnabled: true, points: [] },
    points: [],
    minX: 0,
    minY: 0,
    maxX: visibleLength * 14,
    maxY: 60,
    centerY: 30,
    width: visibleLength * 14,
    height: 60,
  }])
  return rankTrocrCandidates(rawCandidates, line, language, wordMembership).map(({ rawText, text, score, visualRank, baseScore }) => ({
    rawText,
    text,
    score,
    visualRank,
    baseScore,
  }))
}

const modelDisagreementPenalty = (first: string, second: string, language: RecognitionLanguage) => {
  const firstTokens = first.split(/\s+/u)
  const secondTokens = second.split(/\s+/u)
  if (firstTokens.length !== secondTokens.length) return first === second ? 0 : 8
  const maximumRatio = firstTokens.reduce((maximum, token, index) => {
    const left = token.toLocaleLowerCase(language).replace(/[^\p{L}\p{N}]/gu, '')
    const right = secondTokens[index].toLocaleLowerCase(language).replace(/[^\p{L}\p{N}]/gu, '')
    if (!left && !right) return maximum
    return Math.max(maximum, wordDistance(left, right) / Math.max(1, left.length, right.length))
  }, 0)
  return Math.round(clamp(maximumRatio * 10, 0, 8))
}

const contextShouldReplaceCompact = (
  compact: Omit<NeuralTextLine, 'bbox'>,
  compactAssessment: ReturnType<typeof trocrLineAssessment>,
  context: Omit<NeuralTextLine, 'bbox'>,
  contextAssessment: ReturnType<typeof trocrLineAssessment>,
  language: RecognitionLanguage,
  wordMembership?: WordMembership,
  preferContextModel = false,
) => {
  const locale = language === 'de' ? 'de-CH' : 'en-US'
  const compactSurface = normalizeGermanSharpS(compact.text).trim()
  const contextSurface = normalizeGermanSharpS(context.text).trim()
  if (!contextSurface || contextSurface === compactSurface) return Boolean(contextSurface)
  const compactLetters = compactSurface.replace(/[^\p{L}\p{N}]/gu, '')
  const contextLetters = contextSurface.replace(/[^\p{L}\p{N}]/gu, '')
  const compactLower = compactSurface.toLocaleLowerCase(locale)
  const compactWords = compactLower.match(language === 'de' ? /[a-zäöü]{2,}/giu : /[a-z]{2,}/giu) ?? []
  const compactHasKnownWord = compactWords.some((word) => (
    LANGUAGE_WORDS[language].has(word) || wordMembership?.(word)
  ))
  const compactCommonWords = compactWords.filter((word) => LANGUAGE_WORDS[language].has(word)).length
  const contextWords = contextSurface.toLocaleLowerCase(locale)
    .match(language === 'de' ? /[a-zäöü]{2,}/giu : /[a-z]{2,}/giu) ?? []
  const contextHasKnownWord = contextWords.some((word) => (
    LANGUAGE_WORDS[language].has(word) || wordMembership?.(word)
  ))
  const contextCommonWords = contextWords.filter((word) => LANGUAGE_WORDS[language].has(word)).length
  const singleCompactSpan = /^\p{L}[\p{L}\p{N}_-]*$/u.test(compactSurface)
  const titleCaseUnknown = (
    /^\p{Lu}\p{Ll}{2,}$/u.test(compactSurface) &&
    !compactHasKnownWord
  )
  const intentionalMixedCase = singleCompactSpan && /\p{Ll}\p{Lu}/u.test(compactSurface)
  const disagreement = wordDistance(compactLower, contextSurface.toLocaleLowerCase(locale))
  const disagreementRatio = disagreement / Math.max(1, compactLetters.length, contextLetters.length)
  const highConfidenceVisualText = compact.confidence >= 72
  if (highConfidenceVisualText && (titleCaseUnknown || intentionalMixedCase)) return false
  // The Web model is a compact, quantized context recognizer and remains the
  // stronger primary path for ordinary words and complete sentences. The
  // standalone name/CamelCase guard above is the only visual veto required
  // there; desktop can apply the stricter disagreement guard below.
  if (preferContextModel) {
    // The compact web context model is normally the stronger path, but it is
    // not allowed to discard an independently confident CTC line with the
    // same word structure when that line contains strictly more high-value
    // common-word evidence and both readings differ only locally. Exhaustive
    // dictionary membership alone does not trigger this veto, so proper-name
    // repairs such as Trewer → Trevor remain available.
    if (
      compact.confidence >= 65 &&
      compactWords.length === contextWords.length &&
      compactWords.length >= 2 &&
      compactCommonWords > contextCommonWords &&
      disagreementRatio <= 0.28
    ) return false
    return true
  }
  if (compactAssessment.suspicious !== contextAssessment.suspicious) {
    return compactAssessment.suspicious
  }
  if (contextAssessment.suspicious) return false
  if (
    highConfidenceVisualText &&
    singleCompactSpan &&
    !contextHasKnownWord &&
    disagreementRatio > 0.34 &&
    context.confidence < compact.confidence + 8
  ) return false
  return (
    contextAssessment.score > compactAssessment.score + 0.12 ||
    (
      contextAssessment.score >= compactAssessment.score - 0.04 &&
      context.confidence > compact.confidence
    )
  )
}

export const preferNeuralContextCandidateForTests = (
  compactText: string,
  compactConfidence: number,
  contextText: string,
  contextConfidence: number,
  language: RecognitionLanguage,
  preferContextModel = false,
) => {
  const length = Math.max(3, Array.from(compactText).length, Array.from(contextText).length)
  const line = lineFromEntries([{
    stroke: { baseWidth: 3, pressureEnabled: true, points: [] },
    points: [],
    minX: 0,
    minY: 0,
    maxX: length * 18,
    maxY: 60,
    centerY: 30,
    width: length * 18,
    height: 60,
  }])
  const compact = {
    text: compactText,
    rawText: compactText,
    confidence: compactConfidence,
    characters: evenlySpacedCharacters(compactText, compactConfidence),
  }
  const context = {
    text: contextText,
    rawText: contextText,
    confidence: contextConfidence,
    characters: evenlySpacedCharacters(contextText, contextConfidence),
  }
  return contextShouldReplaceCompact(
    compact,
    trocrLineAssessment(compactText, line, language),
    context,
    trocrLineAssessment(contextText, line, language),
    language,
    undefined,
    preferContextModel,
  )
}

const recognizeCtcLine = async (
  image: RenderedLineImage,
  language: RecognitionLanguage,
  wordMembership?: WordMembership,
) => {
  const input = lineTensorInput(image)
  if (window.fanotes.platform !== 'web' && window.fanotes.recognizeNativeHandwritingLine) {
    try {
      const native = await window.fanotes.recognizeNativeHandwritingLine({
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
    if (useExtendedModel && (!selected || selectedAssessment?.needsContext)) {
      try {
        const rawText = normalizeGermanSharpS(await recognizeTrocrLine(image.pixels, image.width, image.height))
          .normalize('NFC')
          .trim()
        const text = normalizedTrocrText(rawText, language, physicalWord)
        const assessment = trocrLineAssessment(text, physicalWord, language, wordMembership)
        const contextCandidate = text ? {
          text,
          rawText,
          greedyText: text,
          confidence: assessment.confidence,
          characters: evenlySpacedCharacters(text, assessment.confidence),
        } : null
        if (
          contextCandidate &&
          (
            !selected ||
            !selectedAssessment ||
            contextShouldReplaceCompact(
              selected,
              selectedAssessment,
              contextCandidate,
              assessment,
              language,
              wordMembership,
              window.fanotes.platform === 'web',
            )
          )
        ) {
          selected = contextCandidate
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
      beamText: wordResults.map((result) => result.beamText || result.text).join(' '),
      greedyText: wordResults.map((result) => result.greedyText || result.text).join(' '),
      confidence,
      characters: evenlySpacedCharacters(text, confidence),
    },
    usedCtc,
    usedTrocr,
    physicalWordCount: physicalWords.length,
    minimumWordConfidence: Math.min(...wordResults.map((result) => result.confidence)),
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
  const useContextModel = window.fanotes.platform === 'web' || useExtendedDesktopOcrModel()
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
        let compact = await recognizeCtcLine(image, language, wordMembership)
        let compactAssessment = compact.text
          ? trocrLineAssessment(compact.text, line, language, wordMembership)
          : null
        const compactVisible = Array.from(compact.text).filter((character) => !/\s/u.test(character))
        const uncertainSingleWord = (
          compact.confidence < 80 &&
          compactVisible.length >= 4 &&
          compactVisible.length <= 14 &&
          /^\p{L}+$/u.test(compact.text)
        )
        if (uncertainSingleWord) {
          try {
            // A slightly tighter crop changes the relative x-height and ink
            // thickness seen by CTC. Running it only for a low-confidence
            // single word recovers valid-word confusions such as
            // rennen/lernen without doubling normal sentence work.
            const alternateImage = renderLineImage(line, sourceWidth, sourceHeight, {
              marginYRatio: 0.32,
              inkScale: 0.92,
            })
            const alternate = await recognizeCtcLine(alternateImage, language, wordMembership)
            const alternateAssessment = alternate.text
              ? trocrLineAssessment(alternate.text, line, language, wordMembership)
              : null
            if (
              alternateAssessment &&
              compactAssessment &&
              (
                (compactAssessment.suspicious && !alternateAssessment.suspicious) ||
                alternateAssessment.score > compactAssessment.score + 0.08 ||
                (
                  alternateAssessment.score >= compactAssessment.score - 0.04 &&
                  alternate.confidence >= compact.confidence + 2
                )
              )
            ) {
              compact = alternate
              compactAssessment = alternateAssessment
            }
          } catch {
            // The original compact result remains valid and already loaded.
          }
        }
        if (compact.text) {
          selected = compact
          primaryAssessment = compactAssessment
          ctcLines += 1
        }
      } catch {
        primaryAssessment = null
      }
    }

    const containsUnknownWord = selected
      ? containsUnknownContextWord(selected.text, language, wordMembership)
      : false
    const isWebRuntime = window.fanotes.platform === 'web'
    if (useContextModel && (isWebRuntime || !selected || primaryAssessment?.needsContext || containsUnknownWord)) {
      try {
        const trocrRecognition = await recognizeTrocrLineCandidates(image.pixels, image.width, image.height)
        let rankedContext = rankTrocrCandidates(
          trocrRecognition.candidates.length ? trocrRecognition.candidates : [trocrRecognition.text],
          line,
          language,
          wordMembership,
        )
        let bestContext = rankedContext[0]
        let rawText = bestContext?.rawText ?? normalizeGermanSharpS(trocrRecognition.text).normalize('NFC').trim()
        let text = bestContext?.text ?? normalizedTrocrText(rawText, language, line)
        let contextAssessment = trocrLineAssessment(text, line, language, wordMembership)
        let alternateRanked: ReturnType<typeof rankTrocrCandidates> | null = null
        const loadAlternateRanked = async () => {
          if (alternateRanked) return alternateRanked
          const alternateImage = renderLineImage(line, sourceWidth, sourceHeight, {
            marginYRatio: 0.32,
            inkScale: 0.92,
          })
          const alternateRecognition = await recognizeTrocrLineCandidates(
            alternateImage.pixels,
            alternateImage.width,
            alternateImage.height,
          )
          alternateRanked = rankTrocrCandidates(
            alternateRecognition.candidates.length
              ? alternateRecognition.candidates
              : [alternateRecognition.text],
            line,
            language,
            wordMembership,
          )
          return alternateRanked
        }
        if (shouldRequestIndependentTrocrView(
          trocrRecognition.candidates.length,
          selected?.text ?? '',
          text,
          contextAssessment.needsContext,
          language,
          wordMembership,
        )) {
          try {
            const independent = await loadAlternateRanked()
            const combinedRawCandidates = [
              ...rankedContext.map((candidate) => candidate.rawText),
              ...independent.map((candidate) => candidate.rawText),
            ]
            rankedContext = rankTrocrCandidates(combinedRawCandidates, line, language, wordMembership)
            bestContext = rankedContext[0]
            rawText = bestContext?.rawText ?? rawText
            text = bestContext?.text ?? text
            contextAssessment = trocrLineAssessment(text, line, language, wordMembership)
          } catch {
            // The first context view and compact model remain available.
          }
        }
        const disputedCommonNeighbour = selected
          ? rareContextCommonNeighbour(selected.text, text, rawText, language)
          : ''
        if (disputedCommonNeighbour) {
          try {
            // A tighter, slightly thinner rendering changes no ink or target
            // length; it only provides a second independent view of the last
            // character. In the controlled `computer`/`computed` conflict the
            // default crop chooses the valid but wrong past tense, while this
            // view reads the visible final `r`. Run it only after the strict
            // ambiguity gate above so ordinary lines keep one TrOCR inference.
            const alternateBest = (await loadAlternateRanked())[0]
            const alternateWord = alternateBest
              ? fusionAlignmentSurface(alternateBest.text, language)
              : ''
            if (alternateBest && alternateWord === disputedCommonNeighbour) {
              bestContext = alternateBest
              rawText = alternateBest.rawText
              text = alternateBest.text
              rankedContext = [
                alternateBest,
                ...rankedContext.filter((candidate) => candidate.text !== alternateBest.text),
              ]
            }
          } catch {
            // The default context and compact visual paths remain available.
          }
        }
        contextAssessment = trocrLineAssessment(text, line, language, wordMembership)
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
        if (text) {
          const contextCandidate = {
            text,
            rawText,
            greedyText: text,
            confidence: contextAssessment.confidence,
            characters: evenlySpacedCharacters(text, contextAssessment.confidence),
          }
          const useContext = !selected || !primaryAssessment || contextShouldReplaceCompact(
            selected,
            primaryAssessment,
            contextCandidate,
            contextAssessment,
            language,
              wordMembership,
              isWebRuntime,
            )
          if (useContext) {
            const compactContextText = selected
              // Keep this comparison purely visual. An exhaustive dictionary
              // rewrite here used to turn a compact `Trewer` into the valid
              // but wrong surname `Brewer` before the independent line model
              // could contribute `Trevor`. Final word context still runs
              // below after both visual paths have been fused.
              ? normalizedTrocrSurface(selected.text, line)
              : ''
            const fusedText = selected
              ? fuseCompactAndContextWords(
                compactContextText,
                selected.rawText,
                text,
                language,
                wordMembership,
                separated ? {
                  count: separated.physicalWordCount,
                  minimumConfidence: separated.minimumWordConfidence,
                } : undefined,
                rawText,
              )
              : text
            const fusedAssessment = trocrLineAssessment(fusedText, line, language, wordMembership)
            const fusedConfidence = Math.max(35, Math.max(
              selected?.confidence ?? 0,
              contextAssessment.confidence,
            ) - modelDisagreementPenalty(selected?.text ?? fusedText, fusedText, language))
            selected = {
              text: fusedText,
              rawText,
              beamText: selected?.beamText,
              greedyText: selected?.greedyText ?? fusedText,
              alternatives: rankedContext
                .map((candidate) => candidate.text)
                .filter((candidate) => candidate !== fusedText)
                .slice(0, 2),
              confidence: fusedConfidence,
              characters: evenlySpacedCharacters(fusedText, fusedConfidence),
            }
            primaryAssessment = fusedAssessment
            trocrLines += 1
          }
        }
      } catch (error) {
        trocrFailures.push((error instanceof Error ? error.message : String(error)).slice(0, 500))
      }
    }
    if (selected?.text) {
      const contextText = applyFinalNeuralWordContext(selected.text, language)
      const boundedText = applyNeuralPhysicalWordBoundaries(
        contextText,
        line,
        selected.characters,
        language,
      )
      const finalText = repairNeuralPhysicalWordSpacing(
        boundedText,
        line,
        language,
        wordMembership,
        selected.characters,
      )
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
