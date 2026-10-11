/**
 * Shared PyLaia line tensor and CTC decoder (`fanotes-recog`).
 * Loaded with handwriting recognition, not at application startup.
 */
import { initSync, decodeCtc, fuseRecognitionModel, lineTensor, setLexicon } from './recogWasm/fanotes_recog_wasm.js'
import { RECOG_WASM_BASE64 } from './recogWasm/bytes'

export type RecogCtcRun = { char: string; confidence: number; start: number; end: number }
export type RecogCtcCore = {
  rawText: string
  rawBeamText: string
  ctcGreedyText: string
  confidence: number
  characters: RecogCtcRun[]
}

let ready = false
const lexicons = new Set<string>()

const wasmBytes = () => {
  const binary = atob(RECOG_WASM_BASE64)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes
}

export const ensureRecogWasm = () => {
  if (ready) return
  initSync({ module: wasmBytes() })
  ready = true
}

export const installRecogLexicon = (language: 'de' | 'en', words: readonly string[]) => {
  ensureRecogWasm()
  if (lexicons.has(language)) return
  setLexicon(language, words.slice())
  lexicons.add(language)
}

export const fuseRecogModel = (entries: unknown) => {
  ensureRecogWasm()
  return JSON.parse(fuseRecognitionModel(JSON.stringify(entries))) as {
    trusts: Array<{ sampleId: string; trust: number }>
    weights: Record<string, number>
    prototypes: Array<Record<string, unknown>>
    prototypeSets: Array<{ labelId: string; sampleIds: string[] }>
    classifierIds: string[]
    labelStats: Array<{ labelId: string; value: Record<string, number> }>
    aspectStats: Array<{ labelId: string; value: { median: number; spread: number; personal: boolean } }>
    estimatedAccuracy: number | null
    evaluatedSamples: number
  }
}

export const decodeRecogCtc = (
  probabilities: Float32Array,
  dimensions: readonly number[],
  characters: string[],
  language: 'de' | 'en',
): RecogCtcCore => {
  ensureRecogWasm()
  const timeSteps = dimensions.at(-2) ?? 0
  const classes = dimensions.at(-1) ?? 0
  return JSON.parse(decodeCtc(probabilities, timeSteps, classes, characters.slice(), language)) as RecogCtcCore
}

type TensorLine = {
  minX: number
  minY: number
  maxX: number
  maxY: number
  entries: Array<{ stroke: { baseWidth: number; points: Array<{ x: number; y: number }> } }>
}

export const renderRecogLineTensor = (
  line: TensorLine,
  sourceWidth: number,
  sourceHeight: number,
  options: { marginXRatio?: number; marginYRatio?: number; inkScale?: number } = {},
) => {
  ensureRecogWasm()
  let count = 0
  for (const entry of line.entries) count += 2 + entry.stroke.points.length * 2
  const packed = new Float64Array(count)
  let index = 0
  for (const entry of line.entries) {
    packed[index] = entry.stroke.baseWidth
    packed[index + 1] = entry.stroke.points.length
    index += 2
    for (const point of entry.stroke.points) {
      packed[index] = point.x
      packed[index + 1] = point.y
      index += 2
    }
  }
  const ratio = (value: number | undefined) => value ?? Number.NaN
  const out = lineTensor(
    line.minX,
    line.minY,
    line.maxX,
    line.maxY,
    sourceWidth,
    sourceHeight,
    ratio(options.marginXRatio),
    ratio(options.marginYRatio),
    ratio(options.inkScale),
    packed,
  )
  const width = out[0]
  return { width, values: new Float32Array(out.subarray(1)) }
}
