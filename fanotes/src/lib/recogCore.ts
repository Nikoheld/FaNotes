/**
 * Shared PyLaia line tensor and CTC decoder (`fanotes-recog`).
 * Loaded with handwriting recognition, not at application startup.
 */
import init, { decodeCtc, fuseRecognitionModel, lineTensor, setLexicon } from './recogWasm/fanotes_recog_wasm.js'

export type RecogCtcRun = { char: string; confidence: number; start: number; end: number }
export type RecogCtcCore = {
  rawText: string
  rawBeamText: string
  ctcGreedyText: string
  confidence: number
  characters: RecogCtcRun[]
}

let ready = false
let loading: Promise<void> | null = null
const lexicons = new Set<string>()

/**
 * `fetch` handles http(s) and Electron's `file://`; plain Chromium refuses `file:` in `fetch`
 * (the headless recognition checks), where an XHR still works.
 */
const fetchWasm = async (url: URL): Promise<Response | ArrayBuffer> => {
  // A bundler that inlines assets (library builds of the headless recognition checks) yields a
  // `data:` URL: decode it directly instead of going through the network stack.
  const inline = /^data:[^,]*;base64,(.*)$/u.exec(url.href)
  if (inline) {
    const binary = atob(inline[1])
    const bytes = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
    return bytes.buffer
  }
  try {
    return await fetch(url)
  } catch (error) {
    if (url.protocol !== 'file:' || typeof XMLHttpRequest === 'undefined') throw error
    return new Promise<ArrayBuffer>((resolve, reject) => {
      const request = new XMLHttpRequest()
      request.open('GET', url.href)
      request.responseType = 'arraybuffer'
      request.onload = () => (request.response instanceof ArrayBuffer ? resolve(request.response) : reject(error))
      request.onerror = () => reject(error)
      request.send()
    })
  }
}

/**
 * Fetches and instantiates the recognition wasm, once. The binary is a build asset next to the
 * glue (not base64 in the bundle); the glue streams it with `WebAssembly.instantiateStreaming` and
 * falls back to `WebAssembly.instantiate` on an ArrayBuffer when the server (or `file://`) does
 * not send `application/wasm`. Every entry point that reaches the wasm awaits this first.
 */
export const loadRecogWasm = (): Promise<void> => {
  if (ready) return Promise.resolve()
  loading ??= init({ module_or_path: fetchWasm(new URL('./recogWasm/fanotes_recog_wasm_bg.wasm', import.meta.url)) })
    .then(() => { ready = true })
    .catch((error: unknown) => {
      loading = null
      throw error
    })
  return loading
}

/** For synchronous wasm calls: throws when `loadRecogWasm` has not resolved yet. */
export const ensureRecogWasm = () => {
  if (!ready) throw new Error('Die Erkennungs-Engine ist noch nicht geladen.')
}

export const installRecogLexicon = async (language: 'de' | 'en', words: readonly string[]) => {
  await loadRecogWasm()
  if (lexicons.has(language)) return
  setLexicon(language, words.slice())
  lexicons.add(language)
}

export const fuseRecogModel = async (entries: unknown) => {
  await loadRecogWasm()
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
