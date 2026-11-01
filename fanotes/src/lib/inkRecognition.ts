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
  MERGE_SCORE_MARGIN,
  SPLICE_SCORE_MARGIN,
  WIDTH_RETRY_MARGIN,
  MIXED_CASE_SCALE,
  charactersWithWordEdits,
  sameLettersAllowingCapsJoin,
  foldInkWord,
  hasLongUnknownWord,
  hasMixedInteriorCase,
  longUnknownWordEdits,
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
        if ((wordFix || mergeFix) && retryScore > bestScore) {
          decoded = retryDecoded
          activeImage = retryImage
          activePenWidth = variant.penWidth
          activeScale = variant.scale
          bestScore = retryScore
          continue
        }
        if (retryScore < baseScore + SPLICE_SCORE_MARGIN) continue
        const edits = longUnknownWordEdits(baseText, retryDecoded.text, known)
        if (!edits || (spliceBest && retryScore <= spliceBest.score)) continue
        spliceBest = { score: retryScore, decoded: retryDecoded, image: retryImage, penWidth: variant.penWidth, scale: variant.scale, edits }
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
      && hasMixedInteriorCase(decoded.text)
    ) {
      const caseImage = renderLine(packed, reference, { ...style, penWidth: activePenWidth, scale: MIXED_CASE_SCALE })
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
    if (!decoded.text.trim()) continue
    const spans = new Uint32Array(decoded.characters.flatMap((character) => [character.startFrame, character.endFrame]))
    const boxes = stitched?.boxes ?? inkSpanBoxes(activeImage.packed, reference, activePenWidth, style.extraShear, activeScale, spans)
    const unstretch = 1 / style.stretchX
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
