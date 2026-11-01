/**
 * FaNotes ink recognizer: pen strokes → text lines. Desktop only.
 *
 * The renderer groups strokes into lines and renders each into the `fanotes-ink-line-v1` model
 * image with `fanotes-recog` (WASM). The CTC line model runs natively in the `fanotes-ocr`
 * sidecar through `window.fanotes.recognizeInkLine`; the same WASM module then decodes the
 * output with a character language model, the spelling dictionary and the writer's personal
 * vocabulary. Nothing runs in the browser, so the web and Android clients, which have no
 * sidecar, do not do this recognition.
 *
 * Model weights stay native (verified by the sidecar against the manifest digest). The renderer
 * only fetches the small language-model files, verified here, on the first conversion.
 */
import type { Stroke } from '../../../src/types'
import {
  inkCtcLoss,
  inkDecode,
  inkGroupLines,
  inkLineImage,
  inkSpanBoxes,
  setInkLanguageModel,
  setInkExactWords,
  setInkLexicon,
  setInkPersonalWords,
} from './recogWasm/fanotes_recog_wasm.js'
import { ensureRecogWasm } from './recogCore'
import { effectiveOcrThreadCount } from './resourceLimits'
import {
  INK_RETRY_VARIANTS,
  INK_SHEAR_RETRY,
  LARGER_SCALE,
  MERGE_SCORE_MARGIN,
  BRACKET_COMMA_MARGIN,
  BRACKET_STRETCH,
  FIRST_LETTER_MARGIN,
  NARROW_LINE_MARGIN,
  NARROW_SCALE,
  NARROW_STRETCH,
  NARROW_STRETCH_MARGIN,
  NARROW_WORD_MARGIN,
  SHEAR_SCORE_MARGIN,
  SPLICE_SCORE_MARGIN,
  WIDTH_RETRY_MARGIN,
  MIXED_CASE_SCALE,
  capitalizesOnlyTheFirstLetter,
  aToAeIndexes,
  charactersSeparatingFinalB,
  dToBIndexes,
  separateFinalBIndexes,
  fToLowerIndexes,
  finalLetterApostropheIndexes,
  rToNIndexes,
  replacesBracketPeriodWithComma,
  rewriteWord,
  charactersWithWordEdits,
  sameLettersAllowingCapsJoin,
  foldInkWord,
  hasLongUnknownWord,
  hasMixedInteriorCase,
  longUnknownWordEdits,
  narrowScaleKeepsKnownWords,
  capitalizedNounAfterDeterminer,
  capitalizedSentenceAdverb,
  capitalizeLoneLowercase,
  lowercaseVerbSein,
  interiorCapitalNeighbor,
  umlautAndOneOtherLetter,
  nounAfterAttributiveAdjective,
  capitalCompoundIndex,
  kraftPluralFromReading,
  largerScaleGrowsOneWord,
  tripleLetterFromNarrowGreedy,
  hasOneOddLetterGroup,
  longerKnownCropWord,
  quotedWordAfterDoubleSix,
  leadingStrokesAreTicks,
  COMPOUND_PEN,
  COMPOUND_SHEAR,
  COMPOUND_SCALE,
  dictionaryCompound,
  isolatedWideGroups,
  inkWords,
  charactersJoiningWords,
  insertedLetterInOneKnownWord,
  oneLetterInALongUnknownWord,
  oneUnknownWordBecomesKnown,
  rewriteSameLengthWord,
  shearReadingRewritesTwoWords,
  stretchedReadingKeepsKnownWords,
  textWithWordEdits,
  widthReadingKeepsKnownWords,
  widthReadingMergesTwoWords,
} from './inkWidthChoice'

export const INK_MANIFEST_FORMAT = 'fanotes-ink-recognizer-v1'
export type InkLanguage = 'de' | 'en'

/** Writer-specific rendering found by `fitInkPersonalStyle`. */
export type InkStyle = {
  penWidth: number
  extraShear: number
  stretchX: number
  scale: number
}

export const DEFAULT_INK_STYLE: InkStyle = { penWidth: 2.6, extraShear: 0, stretchX: 1, scale: 1 }

type FileDescriptor = { file: string; size: number; sha256: string }

export type InkDecoderSettings = {
  lmWeight: number
  wordBonus: number
  unknownWordPenalty: number
  insertionBonus: number
  beamWidth: number
  /** English lines follow the pen more closely than German lines. */
  englishLmWeight?: number
  englishWordBonus?: number
}

/** German keeps the manifest weights. English uses the lighter language-model settings when present. */
export const decoderForLanguage = (decoder: InkDecoderSettings, language: InkLanguage): InkDecoderSettings => ({
  beamWidth: decoder.beamWidth,
  unknownWordPenalty: decoder.unknownWordPenalty,
  insertionBonus: decoder.insertionBonus,
  lmWeight: language === 'en' ? decoder.englishLmWeight ?? decoder.lmWeight : decoder.lmWeight,
  wordBonus: language === 'en' ? decoder.englishWordBonus ?? decoder.wordBonus : decoder.wordBonus,
})

export type InkManifest = {
  format: typeof INK_MANIFEST_FORMAT
  name: string
  version: string
  alphabet: string
  height: number
  frameStride: number
  featureDim: number
  classes: number
  models: { desktop: FileDescriptor & { precision: string } }
  languageModels: Record<InkLanguage, FileDescriptor>
  decoder: InkDecoderSettings
}

export type InkCharacterAlternative = { char: string; confidence: number }

export type InkCharacter = {
  char: string
  /** 0–100 */
  confidence: number
  /** Horizontal span inside the line's model image, 0…1. */
  start: number
  end: number
  /** Page box of the ink under this character, normalized `[x, y, width, height]`. */
  bbox: [number, number, number, number] | null
  alternatives: InkCharacterAlternative[]
}

export type InkLineDebug = {
  image: { width: number; height: number; pixels: Float32Array }
  greedyText: string
  readings: Array<{ text: string; score: number }>
  inferenceMs: number
  decodeMs: number
  frames: number
  secondaryLanguage?: { language: InkLanguage; text: string; score: number }
}

export type InkLine = {
  text: string
  greedyText: string
  /** Other complete readings of the line, best first. */
  alternatives: string[]
  /** 0–100 */
  confidence: number
  bbox: [number, number, number, number]
  /** Indexes into the strokes passed to `recognizeInk`. */
  strokeIndexes: number[]
  characters: InkCharacter[]
  words: number
  knownWords: number
  language: InkLanguage
  debug?: InkLineDebug
}

export type InkRecognitionResult = {
  text: string
  /** 0–100 */
  confidence: number
  lines: InkLine[]
  engine: 'fanotes-ink'
  modelVersion: string
  personalized: boolean
  wordCount: number
  knownWordRatio: number
  /** Typical line height of the page in source pixels; reused when lines become training data. */
  referenceHeight: number
  timings: { totalMs: number; inferenceMs: number; decodeMs: number }
}

export type InkRecognitionOptions = {
  /** Use the personal style and personal model. Defaults to true. */
  personal?: boolean
  /** Also try the other language's model on lines with few dictionary words. */
  mixedLanguages?: boolean
  debug?: boolean
}

type DecodedChar = {
  char: string
  confidence: number
  startFrame: number
  endFrame: number
  alternatives: InkCharacterAlternative[]
}

type Decoded = {
  text: string
  greedyText: string
  confidence: number
  characters: DecodedChar[]
  readings: Array<{ text: string; score: number }>
  frames: number
  knownWords: number
  words: number
}

type GroupedLine = {
  strokes: number[]
  minX: number
  minY: number
  maxX: number
  maxY: number
  bodyHeight: number
}

type Engine = {
  manifest: InkManifest
  alphabet: string
  classes: number
  root: string
  languages: Map<InkLanguage, Promise<void>>
}

const exactWords: Record<InkLanguage, Set<string>> = { de: new Set(), en: new Set() }

const wordIsKnown = (language: InkLanguage, word: string) => {
  const folded = foldInkWord(word)
  if (exactWords[language].has(folded)) return true
  return (personalWords[language] ?? []).some((item) => foldInkWord(item) === folded)
}

const MAX_MANIFEST_BYTES = 64 * 1024
const MAX_LM_BYTES = 24 * 1024 * 1024
const MAX_STROKES = 6_000
const MAX_POINTS = 400_000
const SHA256 = /^[a-f0-9]{64}$/u
const FILE_NAME = /^[a-z0-9][a-z0-9._-]*$/u

let enginePromise: Promise<Engine> | null = null
let personalWords: Partial<Record<InkLanguage, string[]>> = {}
let personalStyle: InkStyle | null = null
let personalModelInstalled = false

/** True when the native sidecar is reachable, i.e. the desktop app. */
export const inkRecognitionAvailable = () => typeof window.fanotes?.recognizeInkLine === 'function'

const requireNative = () => {
  const native = window.fanotes?.recognizeInkLine
  if (!native) throw new Error('Die Stifterkennung ist nur in der FaNotes-Desktop-App verfügbar.')
  return native
}

const assetRoot = () => window.fanotes.platform === 'web'
  ? new URL('./ocr/', document.baseURI).href
  : 'fanotes-model://local/'

const isDescriptor = (value: unknown, maximum: number): value is FileDescriptor => {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<FileDescriptor>
  return typeof candidate.file === 'string'
    && FILE_NAME.test(candidate.file)
    && Number.isSafeInteger(candidate.size)
    && Number(candidate.size) > 0
    && Number(candidate.size) <= maximum
    && typeof candidate.sha256 === 'string'
    && SHA256.test(candidate.sha256)
}

export const isInkManifest = (value: unknown): value is InkManifest => {
  if (!value || typeof value !== 'object') return false
  const manifest = value as Partial<InkManifest>
  const decoder = manifest.decoder as Partial<InkDecoderSettings> | undefined
  return manifest.format === INK_MANIFEST_FORMAT
    && typeof manifest.name === 'string'
    && typeof manifest.version === 'string'
    && typeof manifest.alphabet === 'string'
    && Array.from(manifest.alphabet).length + 1 === manifest.classes
    && manifest.height === 64
    && manifest.frameStride === 4
    && Number.isSafeInteger(manifest.featureDim)
    && isDescriptor(manifest.models?.desktop, 64 * 1024 * 1024)
    && isDescriptor(manifest.languageModels?.de, MAX_LM_BYTES)
    && isDescriptor(manifest.languageModels?.en, MAX_LM_BYTES)
    && !!decoder
    && ['lmWeight', 'wordBonus', 'unknownWordPenalty', 'insertionBonus', 'beamWidth']
      .every((key) => Number.isFinite(decoder[key as keyof InkDecoderSettings]))
    && (decoder.englishLmWeight === undefined || Number.isFinite(decoder.englishLmWeight))
    && (decoder.englishWordBonus === undefined || Number.isFinite(decoder.englishWordBonus))
}

const hex = (bytes: ArrayBuffer) => Array.from(new Uint8Array(bytes), (value) => value.toString(16).padStart(2, '0')).join('')

const fetchVerified = async (url: URL, descriptor: FileDescriptor) => {
  const response = await fetch(url, { credentials: 'same-origin' })
  if (!response.ok) throw new Error(`Das lokale Handschriftmodell ist nicht verfügbar (${response.status}).`)
  const buffer = await response.arrayBuffer()
  if (buffer.byteLength !== descriptor.size) throw new Error('Das lokale Handschriftmodell ist unvollständig.')
  if (hex(await globalThis.crypto.subtle.digest('SHA-256', buffer)) !== descriptor.sha256) {
    throw new Error('Das lokale Handschriftmodell hat die Integritätsprüfung nicht bestanden.')
  }
  return new Uint8Array(buffer)
}

const readManifest = async (root: string): Promise<InkManifest> => {
  const response = await fetch(new URL('fanotes-ink/manifest.json', root), { credentials: 'same-origin' })
  if (!response.ok) throw new Error(`Das Handschriftmodell-Manifest fehlt (${response.status}).`)
  const bytes = await response.arrayBuffer()
  if (!bytes.byteLength || bytes.byteLength > MAX_MANIFEST_BYTES) throw new Error('Das Handschriftmodell-Manifest ist beschädigt.')
  const manifest = JSON.parse(new TextDecoder().decode(bytes)) as unknown
  if (!isInkManifest(manifest)) throw new Error('Das Handschriftmodell-Manifest ist ungültig.')
  return manifest
}

const loadEngine = () => {
  enginePromise ??= (async () => {
    requireNative()
    ensureRecogWasm()
    const root = assetRoot()
    const manifest = await readManifest(root)
    return {
      manifest,
      alphabet: manifest.alphabet,
      classes: manifest.classes,
      root,
      languages: new Map<InkLanguage, Promise<void>>(),
    }
  })().catch((error) => {
    enginePromise = null
    throw error
  })
  return enginePromise
}

const ensureLanguage = (engine: Engine, language: InkLanguage) => {
  let loading = engine.languages.get(language)
  if (!loading) {
    loading = (async () => {
      const descriptor = engine.manifest.languageModels[language]
      const [bytes, spelling] = await Promise.all([
        fetchVerified(new URL(descriptor.file, new URL('fanotes-ink/', engine.root)), descriptor),
        window.fanotes.loadSpellingResources().catch(() => null),
      ])
      setInkLanguageModel(language, bytes)
      if (spelling) setInkLexicon(language, spelling[language], spelling.manifest.languages[language].bitCount)
      const candidates = await window.fanotes.loadSpellingWordCandidates(language).catch(() => null)
      if (candidates?.bytes?.byteLength) {
        const text = new TextDecoder().decode(candidates.bytes)
        const words = text.split('\n').filter((word) => word.length > 0)
        exactWords[language] = new Set(words.map((word) => foldInkWord(word)))
        setInkExactWords(language, words)
      }
      setInkPersonalWords(language, personalWords[language] ?? [])
    })().catch((error) => {
      engine.languages.delete(language)
      throw error
    })
    engine.languages.set(language, loading)
  }
  return loading
}

/** Words the decoder treats as known in addition to the dictionary (lower-cased). */
export const setInkPersonalVocabulary = (language: InkLanguage, words: readonly string[]) => {
  const cleaned = [...new Set(words
    .map((word) => word.normalize('NFC').toLocaleLowerCase(language === 'de' ? 'de-CH' : 'en-US'))
    .filter((word) => /^\p{L}[\p{L}'-]{0,47}$/u.test(word)))]
    .slice(0, 20_000)
  personalWords = { ...personalWords, [language]: cleaned }
  if (enginePromise) void enginePromise.then((engine) => {
    if (engine.languages.has(language)) {
      ensureRecogWasm()
      setInkPersonalWords(language, cleaned)
    }
  }).catch(() => undefined)
}

/** Writer style used for every line while personalization is on; `null` restores the default. */
export const setInkPersonalStyle = (style: InkStyle | null) => {
  personalStyle = style
}

/** Records whether a fine-tuned personal model is installed natively (toggles personal inference). */
export const setInkPersonalModelInstalled = (installed: boolean) => {
  personalModelInstalled = installed
}

export const inkPersonalState = () => ({ style: personalStyle, model: personalModelInstalled })

const usableStrokeIndexes = (strokes: Stroke[]) => {
  const indexes: number[] = []
  let points = 0
  strokes.forEach((stroke, index) => {
    if (!stroke.points.length || indexes.length >= MAX_STROKES) return
    if (stroke.points.some((point) => !Number.isFinite(point.x) || !Number.isFinite(point.y))) return
    points += stroke.points.length
    if (points <= MAX_POINTS) indexes.push(index)
  })
  return indexes
}

const packStrokes = (strokes: Stroke[], indexes: readonly number[], sourceWidth: number, sourceHeight: number) => {
  let count = 0
  for (const index of indexes) count += 1 + strokes[index].points.length * 2
  const packed = new Float64Array(count)
  let offset = 0
  for (const index of indexes) {
    const points = strokes[index].points
    packed[offset] = points.length
    offset += 1
    for (const point of points) {
      packed[offset] = point.x * sourceWidth
      packed[offset + 1] = point.y * sourceHeight
      offset += 2
    }
  }
  return packed
}

const stretchPacked = (packed: Float64Array, stretchX: number) => {
  if (stretchX === 1) return packed
  const out = Float64Array.from(packed)
  for (let offset = 0; offset < out.length;) {
    const count = out[offset]
    for (let index = 0; index < count; index += 1) out[offset + 1 + index * 2] *= stretchX
    offset += 1 + count * 2
  }
  return out
}

const median = (values: number[]) => {
  if (!values.length) return 0
  const sorted = [...values].sort((first, second) => first - second)
  return sorted[Math.floor(sorted.length / 2)]
}

/** Groups page strokes into recognition lines (indexes into `strokes`). */
export const groupInkLines = (strokes: Stroke[], sourceWidth: number, sourceHeight: number) => {
  ensureRecogWasm()
  const usable = usableStrokeIndexes(strokes)
  if (!usable.length) return [] as GroupedLine[]
  const grouped = JSON.parse(inkGroupLines(packStrokes(strokes, usable, sourceWidth, sourceHeight))) as GroupedLine[]
  return grouped.map((line) => ({ ...line, strokes: line.strokes.map((index) => usable[index]) }))
}

type LineImage = { image: Float32Array; width: number; packed: Float64Array }

const renderLine = (packed: Float64Array, reference: number, style: InkStyle): LineImage | null => {
  const stretched = stretchPacked(packed, style.stretchX)
  const raw = inkLineImage(stretched, reference, style.penWidth, style.extraShear, style.scale)
  return raw.length < 3 ? null : { image: raw.subarray(2), width: raw[0], packed: stretched }
}

const HEIGHT = 64

const infer = async (image: LineImage, threads: number, personal: boolean) => {
  const result = await requireNative()({
    input: image.image,
    width: image.width,
    height: HEIGHT,
    threads,
    model: personal ? 'personal' : 'base',
  })
  const logits = result.logits
  const dims = result.dims
  if (
    result.engine !== 'fanotes-ink'
    || !(logits instanceof Float32Array)
    || !Array.isArray(dims)
    || dims.length !== 3
  ) throw new Error('Die native Stifterkennung hat kein lesbares Ergebnis geliefert.')
  return { logits, frames: dims[1], classes: dims[2] }
}

const decodeLine = (engine: Engine, logits: Float32Array, language: InkLanguage, settings: InkDecoderSettings): Decoded => JSON.parse(inkDecode(
  logits,
  engine.classes,
  engine.alphabet,
  language,
  JSON.stringify({
    beamWidth: settings.beamWidth,
    lmWeight: settings.lmWeight,
    wordBonus: settings.wordBonus,
    unknownWordPenalty: settings.unknownWordPenalty,
    insertionBonus: settings.insertionBonus,
    nBest: 5,
  }),
)) as Decoded

/** Text normalization shared with training: typographic quotes become ASCII, ß stays a letter. */
export const normalizeInkText = (value: string) => value
  .normalize('NFC')
  .replace(/[„“”«»]/gu, '"')
  .replace(/[‚‘’´`]/gu, "'")
  .replace(/\s+/gu, ' ')
  .trim()

const cropPacked = (packed: Float64Array, minX: number, maxX: number): Float64Array | null => {
  const chunks: Float64Array[] = []
  let total = 0
  for (let offset = 0; offset < packed.length;) {
    const count = packed[offset]
    const end = offset + 1 + count * 2
    let lo = Infinity
    let hi = -Infinity
    for (let index = 0; index < count; index += 1) {
      const x = packed[offset + 1 + index * 2]
      lo = Math.min(lo, x)
      hi = Math.max(hi, x)
    }
    const center = (lo + hi) / 2
    if (center >= minX - 3 && center <= maxX + 3) {
      chunks.push(packed.subarray(offset, end))
      total += end - offset
    }
    offset = end
  }
  if (chunks.length < 2) return null
  const out = new Float64Array(total)
  let cursor = 0
  for (const chunk of chunks) {
    out.set(chunk, cursor)
    cursor += chunk.length
  }
  return out
}

const wordSpan = (
  characters: Array<{ char: string }>,
  index: number,
  boxes: Float64Array,
): { minX: number; maxX: number } | null => {
  const runs: Array<{ start: number; end: number }> = []
  let cursor = 0
  while (cursor < characters.length) {
    if (!/[A-Za-zÄÖÜäöüß]/u.test(characters[cursor].char)) {
      cursor += 1
      continue
    }
    const start = cursor
    while (cursor < characters.length && /[A-Za-zÄÖÜäöüß]/u.test(characters[cursor].char)) cursor += 1
    runs.push({ start, end: cursor })
  }
  const run = runs[index]
  if (!run) return null
  let minX = Infinity
  let maxX = -Infinity
  for (let glyph = run.start; glyph < run.end; glyph += 1) {
    const left = boxes[glyph * 4]
    const right = boxes[glyph * 4 + 2]
    if (!Number.isFinite(left) || !Number.isFinite(right)) continue
    minX = Math.min(minX, left)
    maxX = Math.max(maxX, right)
  }
  return Number.isFinite(minX) ? { minX, maxX } : null
}

const lineBox = (line: GroupedLine, sourceWidth: number, sourceHeight: number): [number, number, number, number] => [
  Math.max(0, line.minX / sourceWidth),
  Math.max(0, line.minY / sourceHeight),
  Math.max(0, (line.maxX - line.minX) / sourceWidth),
  Math.max(0, (line.maxY - line.minY) / sourceHeight),
]

/**
 * Recognizes all text lines in `strokes` (normalized page coordinates of a
 * `sourceWidth × sourceHeight` page). Desktop only; throws elsewhere.
 */
export async function recognizeInk(
  strokes: Stroke[],
  language: InkLanguage,
  sourceWidth = 900,
  sourceHeight = 1_273,
  options: InkRecognitionOptions = {},
): Promise<InkRecognitionResult> {
  const started = performance.now()
  const engine = await loadEngine()
  const other: InkLanguage = language === 'de' ? 'en' : 'de'
  await ensureLanguage(engine, language)
  const mixedLanguages = options.mixedLanguages !== false
  if (mixedLanguages) await ensureLanguage(engine, other).catch(() => undefined)
  const personal = (options.personal ?? true) && (personalModelInstalled || Boolean(personalStyle))
  const style = (options.personal ?? true) && personalStyle ? personalStyle : DEFAULT_INK_STYLE
  const usePersonalModel = (options.personal ?? true) && personalModelInstalled
  const threads = effectiveOcrThreadCount(4)
  const grouped = groupInkLines(strokes, sourceWidth, sourceHeight)
  const reference = median(grouped.filter((line) => line.strokes.length >= 2).map((line) => line.maxY - line.minY))
  const lines: InkLine[] = []
  let inferenceMs = 0
  let decodeMs = 0
  for (const line of grouped) {
    const packed = packStrokes(strokes, line.strokes, sourceWidth, sourceHeight)
    const image = renderLine(packed, reference, style)
    if (!image) continue
    const inferenceStarted = performance.now()
    const run = await infer(image, threads, usePersonalModel)
    const lineInference = performance.now() - inferenceStarted
    inferenceMs += lineInference
    if (run.classes !== engine.classes) throw new Error('Das Handschriftmodell passt nicht zu seinem Manifest.')
    const decodeStarted = performance.now()
    let decoded = decodeLine(engine, run.logits, language, decoderForLanguage(engine.manifest.decoder, language))
    let lineLanguage = language
    let secondary: InkLineDebug['secondaryLanguage']
    if (
      mixedLanguages
      && engine.languages.has(other)
      && decoded.words >= 1
      && decoded.knownWords / Math.max(1, decoded.words) < 0.5
    ) {
      const alternative = decodeLine(engine, run.logits, other, decoderForLanguage(engine.manifest.decoder, other))
      secondary = { language: other, text: alternative.text, score: alternative.readings[0]?.score ?? Number.NEGATIVE_INFINITY }
      if (
        alternative.knownWords > decoded.knownWords
        && (alternative.readings[0]?.score ?? Number.NEGATIVE_INFINITY) > (decoded.readings[0]?.score ?? Number.NEGATIVE_INFINITY) + 0.75
      ) {
        decoded = alternative
        lineLanguage = other
      }
    }
    const lineDecode = performance.now() - decodeStarted
    decodeMs += lineDecode
    let activeImage = image
    let activePenWidth = style.penWidth
    let activeScale = style.scale
    let activeShear = style.extraShear
    let activeStretch = style.stretchX
    const baseDecoded = decoded
    const baseText = decoded.text
    const baseScore = decoded.readings[0]?.score ?? Number.NEGATIVE_INFINITY
    const defaultPen = style.penWidth === DEFAULT_INK_STYLE.penWidth
      && style.extraShear === DEFAULT_INK_STYLE.extraShear
      && style.scale === DEFAULT_INK_STYLE.scale
      && style.stretchX === DEFAULT_INK_STYLE.stretchX
    let spliceBest: {
      score: number
      decoded: Decoded
      image: LineImage
      penWidth: number
      scale: number
      edits: ReturnType<typeof longUnknownWordEdits>
    } | null = null
    if (
      defaultPen
      && exactWords[lineLanguage].size > 0
      && hasLongUnknownWord(baseText, (word) => wordIsKnown(lineLanguage, word))
    ) {
      let bestScore = baseScore
      const known = (word: string) => wordIsKnown(lineLanguage, word)
      for (const variant of INK_RETRY_VARIANTS) {
        const retryImage = renderLine(packed, reference, { ...style, penWidth: variant.penWidth, scale: variant.scale })
        if (!retryImage) continue
        const retryInferenceStarted = performance.now()
        const retryRun = await infer(retryImage, threads, usePersonalModel)
        inferenceMs += performance.now() - retryInferenceStarted
        if (retryRun.classes !== engine.classes) continue
        const retryDecodeStarted = performance.now()
        const retryDecoded = decodeLine(engine, retryRun.logits, lineLanguage, decoderForLanguage(engine.manifest.decoder, lineLanguage))
        decodeMs += performance.now() - retryDecodeStarted
        const retryScore = retryDecoded.readings[0]?.score ?? Number.NEGATIVE_INFINITY
        const wordFix = retryScore >= baseScore + WIDTH_RETRY_MARGIN
          && widthReadingKeepsKnownWords(baseText, retryDecoded.text, known)
        const mergeFix = retryScore >= baseScore + MERGE_SCORE_MARGIN
          && widthReadingMergesTwoWords(baseText, retryDecoded.text)
        const narrow = variant.scale === NARROW_SCALE
        const shortFix = narrow
          && retryScore >= baseScore + NARROW_WORD_MARGIN
          && oneUnknownWordBecomesKnown(baseText, retryDecoded.text, known)
        const lineFix = narrow
          && retryScore >= baseScore + NARROW_LINE_MARGIN
          && narrowScaleKeepsKnownWords(baseText, retryDecoded.text, known)
        if ((wordFix || mergeFix || shortFix || lineFix) && retryScore > bestScore) {
          decoded = retryDecoded
          activeImage = retryImage
          activePenWidth = variant.penWidth
          activeScale = variant.scale
          bestScore = retryScore
          continue
        }
        // The narrow scale is taken only as a whole line. Copying one long word out of it
        // can replace a word with a worse one (`Landstatisters` → `Landstatisesse`).
        if (narrow) continue
        if (retryScore < baseScore + SPLICE_SCORE_MARGIN) continue
        const edits = longUnknownWordEdits(baseText, retryDecoded.text, known)
        if (!edits || (spliceBest && retryScore <= spliceBest.score)) continue
        spliceBest = { score: retryScore, decoded: retryDecoded, image: retryImage, penWidth: variant.penWidth, scale: variant.scale, edits }
      }
      const narrowImage = renderLine(packed, reference, { ...style, penWidth: DEFAULT_INK_STYLE.penWidth, extraShear: 0, scale: 1, stretchX: NARROW_STRETCH })
      if (narrowImage) {
        const narrowInferenceStarted = performance.now()
        const narrowRun = await infer(narrowImage, threads, usePersonalModel)
        inferenceMs += performance.now() - narrowInferenceStarted
        if (narrowRun.classes === engine.classes) {
          const narrowDecodeStarted = performance.now()
          const narrowDecoded = decodeLine(engine, narrowRun.logits, lineLanguage, decoderForLanguage(engine.manifest.decoder, lineLanguage))
          decodeMs += performance.now() - narrowDecodeStarted
          const narrowScore = narrowDecoded.readings[0]?.score ?? Number.NEGATIVE_INFINITY
          if (
            narrowScore >= baseScore + NARROW_STRETCH_MARGIN
            && narrowScore > bestScore
            && stretchedReadingKeepsKnownWords(baseText, narrowDecoded.text, known)
          ) {
            decoded = narrowDecoded
            activeImage = narrowImage
            activePenWidth = DEFAULT_INK_STYLE.penWidth
            activeScale = 1
            activeShear = 0
            activeStretch = NARROW_STRETCH
            bestScore = narrowScore
          }
        }
      }
    }
    let stitched: { boxes: Float64Array } | null = null
    if (decoded.text === baseText && spliceBest?.edits) {
      const edited = charactersWithWordEdits(baseDecoded.characters, spliceBest.decoded.characters, spliceBest.edits)
      if (edited) {
        const splicedText = textWithWordEdits(baseText, spliceBest.edits)
        decoded = {
          ...baseDecoded,
          text: splicedText,
          characters: edited.characters,
          confidence: edited.characters.reduce((sum, character) => sum + character.confidence, 0) / Math.max(1, edited.characters.length),
        }
        const spanBoxes = (sourceImage: LineImage, penWidth: number, scale: number, characters: Decoded['characters']) => {
          const spans = new Uint32Array(characters.flatMap((character) => [character.startFrame, character.endFrame]))
          return inkSpanBoxes(sourceImage.packed, reference, penWidth, style.extraShear, scale, spans)
        }
        const baseBoxes = spanBoxes(image, style.penWidth, style.scale, baseDecoded.characters)
        const altBoxes = spanBoxes(spliceBest.image, spliceBest.penWidth, spliceBest.scale, spliceBest.decoded.characters)
        const boxes = new Float64Array(edited.characters.length * 4)
        edited.source.forEach((source, index) => {
          const from = source.alt ? altBoxes : baseBoxes
          boxes.set(from.subarray(source.index * 4, source.index * 4 + 4), index * 4)
        })
        stitched = { boxes }
      }
    }
    if (
      defaultPen
      && decoded.text === baseText
      && exactWords[lineLanguage].size > 0
    ) {
      const shearImage = renderLine(packed, reference, { ...style, extraShear: INK_SHEAR_RETRY })
      if (shearImage) {
        const shearInferenceStarted = performance.now()
        const shearRun = await infer(shearImage, threads, usePersonalModel)
        inferenceMs += performance.now() - shearInferenceStarted
        if (shearRun.classes === engine.classes) {
          const shearDecodeStarted = performance.now()
          const shearDecoded = decodeLine(engine, shearRun.logits, lineLanguage, decoderForLanguage(engine.manifest.decoder, lineLanguage))
          decodeMs += performance.now() - shearDecodeStarted
          const shearScore = shearDecoded.readings[0]?.score ?? Number.NEGATIVE_INFINITY
          if (
            shearScore >= baseScore + SHEAR_SCORE_MARGIN
            && shearReadingRewritesTwoWords(baseText, shearDecoded.text)
          ) {
            decoded = shearDecoded
            activeImage = shearImage
            activeShear = INK_SHEAR_RETRY
            stitched = null
          }
        }
      }
    }
    if (
      defaultPen
      && decoded.text === baseText
      && exactWords[lineLanguage].size > 0
    ) {
      const grownImage = renderLine(packed, reference, { ...style, extraShear: 0, scale: LARGER_SCALE })
      if (grownImage) {
        const grownInferenceStarted = performance.now()
        const grownRun = await infer(grownImage, threads, usePersonalModel)
        inferenceMs += performance.now() - grownInferenceStarted
        if (grownRun.classes === engine.classes) {
          const grownDecodeStarted = performance.now()
          const grownDecoded = decodeLine(engine, grownRun.logits, lineLanguage, decoderForLanguage(engine.manifest.decoder, lineLanguage))
          decodeMs += performance.now() - grownDecodeStarted
          const grownScore = grownDecoded.readings[0]?.score ?? Number.NEGATIVE_INFINITY
          if (
            grownScore > baseScore
            && largerScaleGrowsOneWord(baseText, grownDecoded.text, (word) => wordIsKnown(lineLanguage, word))
          ) {
            decoded = grownDecoded
            activeImage = grownImage
            activeScale = LARGER_SCALE
            activeShear = 0
            stitched = null
          }
        }
      }
    }
    if (defaultPen && decoded.text === baseText && hasOneOddLetterGroup(decoded.text)) {
      const groupImage = renderLine(packed, reference, { ...style, penWidth: DEFAULT_INK_STYLE.penWidth, extraShear: 0, scale: NARROW_SCALE, stretchX: 1 })
      if (groupImage) {
        const groupInferenceStarted = performance.now()
        const groupRun = await infer(groupImage, threads, usePersonalModel)
        inferenceMs += performance.now() - groupInferenceStarted
        if (groupRun.classes === engine.classes) {
          const groupDecodeStarted = performance.now()
          const groupDecoded = decodeLine(engine, groupRun.logits, lineLanguage, decoderForLanguage(engine.manifest.decoder, lineLanguage))
          decodeMs += performance.now() - groupDecodeStarted
          const grouped = tripleLetterFromNarrowGreedy(decoded.text, groupDecoded.greedyText)
          if (grouped) {
            const rewritten = rewriteSameLengthWord(decoded.characters, grouped.index, grouped.to)
            const nextText = textWithWordEdits(decoded.text, [grouped])
            if (rewritten && nextText !== decoded.text) {
              decoded = { ...decoded, text: nextText, characters: rewritten }
              stitched = null
            }
          }
        }
      }
    }
    const firstLetter = [...decoded.text][0]
    if (
      defaultPen
      && firstLetter
      && firstLetter !== firstLetter.toUpperCase()
    ) {
      const capitalImage = renderLine(packed, reference, { ...style, penWidth: activePenWidth, extraShear: activeShear, scale: NARROW_SCALE })
      if (capitalImage) {
        const capitalInferenceStarted = performance.now()
        const capitalRun = await infer(capitalImage, threads, usePersonalModel)
        inferenceMs += performance.now() - capitalInferenceStarted
        if (capitalRun.classes === engine.classes) {
          const capitalDecodeStarted = performance.now()
          const capitalDecoded = decodeLine(engine, capitalRun.logits, lineLanguage, decoderForLanguage(engine.manifest.decoder, lineLanguage))
          decodeMs += performance.now() - capitalDecodeStarted
          const capitalScore = capitalDecoded.readings[0]?.score ?? Number.NEGATIVE_INFINITY
          const currentScore = decoded.readings[0]?.score ?? Number.NEGATIVE_INFINITY
          if (
            capitalScore >= currentScore + FIRST_LETTER_MARGIN
            && capitalizesOnlyTheFirstLetter(decoded.text, capitalDecoded.text)
          ) {
            decoded = capitalDecoded
            activeImage = capitalImage
            activeScale = NARROW_SCALE
            stitched = null
          }
        }
      }
    }
    if (
      defaultPen
      && hasMixedInteriorCase(decoded.text)
    ) {
      const caseImage = renderLine(packed, reference, { ...style, penWidth: activePenWidth, extraShear: activeShear, scale: MIXED_CASE_SCALE })
      if (caseImage) {
        const caseInferenceStarted = performance.now()
        const caseRun = await infer(caseImage, threads, usePersonalModel)
        inferenceMs += performance.now() - caseInferenceStarted
        if (caseRun.classes === engine.classes) {
          const caseDecodeStarted = performance.now()
          const caseDecoded = decodeLine(engine, caseRun.logits, lineLanguage, decoderForLanguage(engine.manifest.decoder, lineLanguage))
          decodeMs += performance.now() - caseDecodeStarted
          const caseScore = caseDecoded.readings[0]?.score ?? Number.NEGATIVE_INFINITY
          const currentScore = decoded.readings[0]?.score ?? Number.NEGATIVE_INFINITY
          if (caseScore > currentScore && sameLettersAllowingCapsJoin(decoded.text, caseDecoded.text)) {
            decoded = caseDecoded
            activeImage = caseImage
            activeScale = MIXED_CASE_SCALE
            stitched = null
          }
        }
      }
    }
    if (defaultPen && decoded.text.includes('.]')) {
      const bracketImage = renderLine(packed, reference, {
        ...style,
        penWidth: activePenWidth,
        extraShear: activeShear,
        scale: activeScale,
        stretchX: BRACKET_STRETCH,
      })
      if (bracketImage) {
        const bracketInferenceStarted = performance.now()
        const bracketRun = await infer(bracketImage, threads, usePersonalModel)
        inferenceMs += performance.now() - bracketInferenceStarted
        if (bracketRun.classes === engine.classes) {
          const bracketDecodeStarted = performance.now()
          const bracketDecoded = decodeLine(engine, bracketRun.logits, lineLanguage, decoderForLanguage(engine.manifest.decoder, lineLanguage))
          decodeMs += performance.now() - bracketDecodeStarted
          const bracketScore = bracketDecoded.readings[0]?.score ?? Number.NEGATIVE_INFINITY
          const currentScore = decoded.readings[0]?.score ?? Number.NEGATIVE_INFINITY
          if (
            bracketScore >= currentScore + BRACKET_COMMA_MARGIN
            && replacesBracketPeriodWithComma(decoded.text, bracketDecoded.text)
          ) {
            decoded = bracketDecoded
            activeImage = bracketImage
            activeStretch = BRACKET_STRETCH
            stitched = null
          }
        }
      }
    }
    if (decoded.text !== baseText) {
      const inserted = insertedLetterInOneKnownWord(
        baseText,
        decoded.text,
        baseDecoded.readings,
        (word) => wordIsKnown(lineLanguage, word),
      )
      if (inserted) {
        const rewritten = rewriteWord(decoded.characters, inserted.index, inserted.to)
        const nextText = textWithWordEdits(decoded.text, [inserted])
        if (rewritten && nextText !== decoded.text) {
          decoded = { ...decoded, text: nextText, characters: rewritten }
          stitched = null
        }
      }
    }
    const compoundIndex = capitalCompoundIndex(decoded.text, (word) => wordIsKnown(lineLanguage, word))
    if (compoundIndex !== null) {
      const characters = charactersJoiningWords(decoded.characters, compoundIndex)
      const nextText = characters?.map((character) => character.char).join('')
      if (characters && nextText && nextText !== decoded.text) {
        decoded = { ...decoded, text: nextText, characters }
        stitched = null
      }
    }
    const pluralEdit = kraftPluralFromReading(
      decoded.text,
      decoded.readings,
      (word) => wordIsKnown(lineLanguage, word),
    )
    if (pluralEdit) {
      const rewritten = rewriteWord(decoded.characters, pluralEdit.index, pluralEdit.to)
      const nextText = textWithWordEdits(decoded.text, [pluralEdit])
      if (rewritten && nextText !== decoded.text) {
        decoded = { ...decoded, text: nextText, characters: rewritten }
        stitched = null
      }
    }
    const letterEdit = oneLetterInALongUnknownWord(
      decoded.text,
      decoded.readings,
      (word) => wordIsKnown(lineLanguage, word),
    )
    if (letterEdit) {
      const rewritten = rewriteSameLengthWord(decoded.characters, letterEdit.index, letterEdit.to)
      const nextText = textWithWordEdits(decoded.text, [letterEdit])
      if (rewritten && nextText !== decoded.text) {
        decoded = { ...decoded, text: nextText, characters: rewritten }
        stitched = null
      }
    }
    for (const index of aToAeIndexes(decoded.characters)) {
      const characters = decoded.characters.map((character, characterIndex) => characterIndex === index ? { ...character, char: 'ä' } : character)
      decoded = { ...decoded, characters, text: characters.map((character) => character.char).join('') }
      stitched = null
    }
    for (const index of fToLowerIndexes(decoded.characters)) {
      const characters = decoded.characters.map((character, characterIndex) => characterIndex === index ? { ...character, char: 'f' } : character)
      decoded = { ...decoded, characters, text: characters.map((character) => character.char).join('') }
      stitched = null
    }
    const separatedB = separateFinalBIndexes(decoded.characters)
    if (separatedB.length) {
      const characters = charactersSeparatingFinalB(decoded.characters, separatedB)
      decoded = { ...decoded, characters, text: characters.map((character) => character.char).join('') }
      stitched = null
    }
    for (const index of dToBIndexes(decoded.characters)) {
      const characters = decoded.characters.map((character, characterIndex) => characterIndex === index ? { ...character, char: 'B' } : character)
      decoded = { ...decoded, characters, text: characters.map((character) => character.char).join('') }
      stitched = null
    }
    for (const index of rToNIndexes(decoded.characters)) {
      const characters = decoded.characters.map((character, characterIndex) => characterIndex === index ? { ...character, char: 'n' } : character)
      decoded = { ...decoded, characters, text: characters.map((character) => character.char).join('') }
      stitched = null
    }
    for (const index of finalLetterApostropheIndexes(decoded.characters)) {
      const characters = decoded.characters.map((character, characterIndex) => characterIndex === index ? { ...character, char: "'" } : character)
      decoded = { ...decoded, characters, text: characters.map((character) => character.char).join('') }
      stitched = null
    }
    const adverb = capitalizedSentenceAdverb(decoded.text)
    if (adverb) {
      const rewritten = rewriteSameLengthWord(decoded.characters, adverb.index, adverb.to)
      const nextText = textWithWordEdits(decoded.text, [adverb])
      if (rewritten && nextText !== decoded.text) {
        decoded = { ...decoded, text: nextText, characters: rewritten }
        stitched = null
      }
    }
    const loneCap = capitalizeLoneLowercase(decoded.text)
    if (loneCap) {
      const rewritten = rewriteSameLengthWord(decoded.characters, loneCap.index, loneCap.to)
      const nextText = textWithWordEdits(decoded.text, [loneCap])
      if (rewritten && nextText !== decoded.text) {
        decoded = { ...decoded, text: nextText, characters: rewritten }
        stitched = null
      }
    }
    const verbSein = lowercaseVerbSein(decoded.text)
    if (verbSein) {
      const rewritten = rewriteSameLengthWord(decoded.characters, verbSein.index, verbSein.to)
      const nextText = textWithWordEdits(decoded.text, [verbSein])
      if (rewritten && nextText !== decoded.text) {
        decoded = { ...decoded, text: nextText, characters: rewritten }
        stitched = null
      }
    }
    const interior = interiorCapitalNeighbor(decoded.text, (word) => wordIsKnown(lineLanguage, word))
    if (interior) {
      const rewritten = rewriteSameLengthWord(decoded.characters, interior.index, interior.to)
      const nextText = textWithWordEdits(decoded.text, [interior])
      if (rewritten && nextText !== decoded.text) {
        decoded = { ...decoded, text: nextText, characters: rewritten }
        stitched = null
      }
    }
    const umlautEdit = umlautAndOneOtherLetter(decoded.text, (word) => wordIsKnown(lineLanguage, word))
    if (umlautEdit) {
      const rewritten = rewriteSameLengthWord(decoded.characters, umlautEdit.index, umlautEdit.to)
      const nextText = textWithWordEdits(decoded.text, [umlautEdit])
      if (rewritten && nextText !== decoded.text) {
        decoded = { ...decoded, text: nextText, characters: rewritten }
        stitched = null
      }
    }
    const capitalNoun = capitalizedNounAfterDeterminer(decoded.text, (word) => wordIsKnown(lineLanguage, word))
    if (capitalNoun) {
      const rewritten = rewriteSameLengthWord(decoded.characters, capitalNoun.index, capitalNoun.to)
      const nextText = textWithWordEdits(decoded.text, [capitalNoun])
      if (rewritten && nextText !== decoded.text) {
        decoded = { ...decoded, text: nextText, characters: rewritten }
        stitched = null
      }
    }
    const nounEdit = nounAfterAttributiveAdjective(decoded.text, (word) => wordIsKnown(lineLanguage, word))
    if (nounEdit) {
      const rewritten = rewriteWord(decoded.characters, nounEdit.index, nounEdit.to)
      const nextText = textWithWordEdits(decoded.text, [nounEdit])
      if (rewritten && nextText !== decoded.text) {
        decoded = { ...decoded, text: nextText, characters: rewritten }
        stitched = null
      }
    }
    const defaultStyle = activePenWidth === DEFAULT_INK_STYLE.penWidth
      && activeShear === 0
      && activeScale === 1
      && activeStretch === 1
    if (defaultPen && defaultStyle) {
      const known = (word: string) => wordIsKnown(lineLanguage, word)
      const runs = inkWords(decoded.text)
        .map((word, index) => ({ word, index }))
        .filter(({ word }) => [...word].length >= 6 && known(word))
      if (runs.length) {
        const spans = new Uint32Array(decoded.characters.flatMap((character) => [character.startFrame, character.endFrame]))
        const wordBoxes = inkSpanBoxes(packed, reference, DEFAULT_INK_STYLE.penWidth, 0, 1, spans)
        for (const run of runs) {
          const range = wordSpan(decoded.characters, run.index, wordBoxes)
          if (!range) continue
          const cropped = cropPacked(packed, range.minX, range.maxX)
          if (!cropped) continue
          const cropImage = renderLine(cropped, reference, { ...DEFAULT_INK_STYLE })
          if (!cropImage) continue
          const cropInferenceStarted = performance.now()
          const cropRun = await infer(cropImage, threads, usePersonalModel)
          inferenceMs += performance.now() - cropInferenceStarted
          if (cropRun.classes !== engine.classes) continue
          const cropDecodeStarted = performance.now()
          const cropDecoded = decodeLine(engine, cropRun.logits, lineLanguage, decoderForLanguage(engine.manifest.decoder, lineLanguage))
          decodeMs += performance.now() - cropDecodeStarted
          const replacement = longerKnownCropWord(run.word, cropDecoded.text, known)
          if (!replacement) continue
          const rewritten = rewriteWord(decoded.characters, run.index, replacement)
          const nextText = textWithWordEdits(decoded.text, [{ index: run.index, from: run.word, to: replacement }])
          if (!rewritten || nextText === decoded.text) continue
          decoded = { ...decoded, text: nextText, characters: rewritten }
          stitched = null
          break
        }
      }
    }
    if (
      defaultPen
      && defaultStyle
      && decoded.characters.length >= 3
      && decoded.characters[0].char === '6'
      && decoded.characters[1].char === '6'
      && decoded.characters[2].char === ' '
      && quotedWordAfterDoubleSix(decoded.text)
      && leadingStrokesAreTicks(packed)
    ) {
      const quote = { ...decoded.characters[0], char: '"', endFrame: decoded.characters[1].endFrame }
      const characters = [quote, ...decoded.characters.slice(3)]
      decoded = { ...decoded, characters, text: characters.map((character) => character.char).join('') }
      stitched = null
    }
    const known = (word: string) => wordIsKnown(lineLanguage, word)
    const unknownCompound = inkWords(decoded.text)
      .map((word, index) => ({ word, index }))
      .filter(({ word }) => [...word].length >= 12 && !known(word) && !dictionaryCompound(word, known))
    if (unknownCompound.length === 1) {
      const compounds: string[] = []
      for (const group of isolatedWideGroups(packed)) {
        const compoundImage = renderLine(group, reference, {
          penWidth: COMPOUND_PEN,
          extraShear: COMPOUND_SHEAR,
          scale: COMPOUND_SCALE,
          stretchX: 1,
        })
        if (!compoundImage) continue
        const compoundInferenceStarted = performance.now()
        const compoundRun = await infer(compoundImage, threads, usePersonalModel)
        inferenceMs += performance.now() - compoundInferenceStarted
        if (compoundRun.classes !== engine.classes) continue
        const compoundDecodeStarted = performance.now()
        const compoundDecoded = decodeLine(engine, compoundRun.logits, lineLanguage, decoderForLanguage(engine.manifest.decoder, lineLanguage))
        decodeMs += performance.now() - compoundDecodeStarted
        const tokens = inkWords(compoundDecoded.text)
        if (tokens.length === 1 && dictionaryCompound(tokens[0], known)) compounds.push(tokens[0])
      }
      const target = unknownCompound[0]
      if (compounds.length === 1 && compounds[0] !== target.word) {
        const rewritten = rewriteWord(decoded.characters, target.index, compounds[0])
        const nextText = textWithWordEdits(decoded.text, [{ index: target.index, from: target.word, to: compounds[0] }])
        if (rewritten && nextText !== decoded.text) {
          decoded = { ...decoded, text: nextText, characters: rewritten }
          stitched = null
        }
      }
    }
    if (!decoded.text.trim()) continue
    const spans = new Uint32Array(decoded.characters.flatMap((character) => [character.startFrame, character.endFrame]))
    const boxes = stitched?.boxes ?? inkSpanBoxes(activeImage.packed, reference, activePenWidth, activeShear, activeScale, spans)
    const unstretch = 1 / activeStretch
    lines.push({
      text: decoded.text,
      greedyText: decoded.greedyText,
      alternatives: decoded.readings.slice(1).map((reading) => reading.text).filter((text) => text && text !== decoded.text),
      confidence: Math.round(decoded.confidence * 100),
      bbox: lineBox(line, sourceWidth, sourceHeight),
      strokeIndexes: line.strokes,
      characters: decoded.characters.map((character, index) => {
        const box = boxes.subarray(index * 4, index * 4 + 4)
        return {
          char: character.char,
          confidence: Math.round(character.confidence * 100),
          start: character.startFrame / Math.max(1, decoded.frames),
          end: character.endFrame / Math.max(1, decoded.frames),
          bbox: Number.isFinite(box[0])
            ? [(box[0] * unstretch) / sourceWidth, box[1] / sourceHeight, ((box[2] - box[0]) * unstretch) / sourceWidth, (box[3] - box[1]) / sourceHeight]
            : null,
          alternatives: character.alternatives.map((alternative) => ({
            char: alternative.char,
            confidence: Math.round(alternative.confidence * 100),
          })),
        }
      }),
      words: decoded.words,
      knownWords: decoded.knownWords,
      language: lineLanguage,
      ...(options.debug ? {
        debug: {
          image: { width: activeImage.width, height: HEIGHT, pixels: activeImage.image.slice() },
          greedyText: decoded.greedyText,
          readings: decoded.readings,
          inferenceMs: lineInference,
          decodeMs: lineDecode,
          frames: decoded.frames,
          secondaryLanguage: secondary,
        },
      } : {}),
    })
  }
  const words = lines.reduce((sum, line) => sum + line.words, 0)
  const knownWords = lines.reduce((sum, line) => sum + line.knownWords, 0)
  const characterCount = lines.reduce((sum, line) => sum + line.characters.length, 0)
  return {
    text: lines.map((line) => line.text).join('\n'),
    confidence: characterCount
      ? Math.round(lines.reduce((sum, line) => sum + line.confidence * line.characters.length, 0) / characterCount)
      : 0,
    lines,
    engine: 'fanotes-ink',
    modelVersion: engine.manifest.version,
    personalized: personal,
    wordCount: words,
    knownWordRatio: knownWords / Math.max(1, words),
    referenceHeight: reference,
    timings: { totalMs: performance.now() - started, inferenceMs, decodeMs },
  }
}

export type InkLineLoss = { loss: number; frames: number }

/**
 * CTC loss per character of `text` for one already-separated line, rendered with `style`. Used
 * by `fitInkPersonalStyle` to score a writer rendering. All strokes are treated as one line.
 */
export const inkLineTextLoss = async (
  strokes: Stroke[],
  text: string,
  sourceWidth: number,
  sourceHeight: number,
  options: { referenceHeight?: number; style?: InkStyle; personal?: boolean } = {},
): Promise<InkLineLoss | null> => {
  const engine = await loadEngine()
  const packed = packStrokes(strokes, usableStrokeIndexes(strokes), sourceWidth, sourceHeight)
  const image = renderLine(packed, options.referenceHeight ?? 0, options.style ?? DEFAULT_INK_STYLE)
  if (!image) return null
  const run = await infer(image, effectiveOcrThreadCount(4), Boolean(options.personal) && personalModelInstalled)
  const labels = encodeInkLabels(engine.alphabet, text)
  if (!labels) return null
  const loss = inkCtcLoss(run.logits, run.classes, labels) / labels.length
  return { loss, frames: run.frames }
}

/** Decodes one line's text with the current language model; used to score personalization. */
export const recognizeInkSingleLine = async (
  strokes: Stroke[],
  language: InkLanguage,
  sourceWidth: number,
  sourceHeight: number,
  options: { referenceHeight?: number; style?: InkStyle; personal?: boolean } = {},
) => {
  const engine = await loadEngine()
  await ensureLanguage(engine, language)
  const packed = packStrokes(strokes, usableStrokeIndexes(strokes), sourceWidth, sourceHeight)
  const image = renderLine(packed, options.referenceHeight ?? 0, options.style ?? DEFAULT_INK_STYLE)
  if (!image) return null
  const run = await infer(image, effectiveOcrThreadCount(4), Boolean(options.personal) && personalModelInstalled)
  return decodeLine(engine, run.logits, language, decoderForLanguage(engine.manifest.decoder, language))
}

const encodeInkLabels = (alphabet: string, text: string) => {
  const characters = Array.from(alphabet)
  const out: number[] = []
  for (const character of Array.from(normalizeInkText(text))) {
    const index = characters.indexOf(character)
    if (index < 0) return null
    out.push(index + 1)
  }
  return out.length ? Uint32Array.from(out) : null
}

export const inkRecognitionManifest = async () => (await loadEngine()).manifest

export const resetInkRecognitionForTests = () => {
  enginePromise = null
  personalWords = {}
  personalStyle = null
  personalModelInstalled = false
  exactWords.de = new Set()
  exactWords.en = new Set()
}
