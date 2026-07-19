import {
  env,
  pipeline,
  RawImage,
  type ImageToTextPipeline,
} from '@huggingface/transformers'
import { normalizeGermanSharpS } from '../../../src/lib/orthography'

type WorkerRequest = {
  id: string
  pixels: ArrayBuffer
  width: number
  height: number
  modelRoot: string
  modelId: 'fanotes-trocr' | 'fanotes-trocr-web'
  runtimeWasmUrl: string
  runtimeModuleUrl: string
  runtimeModuleSource?: string
  threads: number
}

type WorkerResponse = {
  id: string
  text?: string
  candidates?: string[]
  error?: string
}

let recognizerPromise: Promise<ImageToTextPipeline> | null = null
let activeConfiguration = ''
let runtimeModuleBlobUrl = ''

const loadRecognizer = (request: WorkerRequest) => {
  if (
    request.runtimeModuleSource !== undefined
    && (request.runtimeModuleSource.length < 1_000 || request.runtimeModuleSource.length > 64 * 1024)
  ) throw new Error('Das lokale TrOCR-Laufzeitmodul ist ungültig.')
  const runtimeModuleUrl = request.runtimeModuleSource
    ? (runtimeModuleBlobUrl ||= URL.createObjectURL(new Blob(
      [request.runtimeModuleSource],
      { type: 'text/javascript' },
    )))
    : request.runtimeModuleUrl
  const configuration = [
    request.modelRoot,
    request.modelId,
    request.runtimeWasmUrl,
    runtimeModuleUrl,
    request.threads,
  ].join('|')
  if (recognizerPromise && configuration === activeConfiguration) return recognizerPromise
  if (recognizerPromise) throw new Error('Die lokale OCR-Laufzeitkonfiguration hat sich unerwartet geändert.')
  activeConfiguration = configuration
  env.allowRemoteModels = false
  env.allowLocalModels = true
  env.useBrowserCache = false
  env.useFS = false
  env.useFSCache = false
  env.backends.onnx.wasm!.numThreads = Math.max(1, Math.min(4, request.threads))
  env.backends.onnx.wasm!.proxy = false
  env.backends.onnx.wasm!.wasmPaths = {
    wasm: request.runtimeWasmUrl,
    mjs: runtimeModuleUrl,
  }
  env.localModelPath = request.modelRoot
  recognizerPromise = pipeline('image-to-text', request.modelId, {
    local_files_only: true,
    device: 'wasm',
    // The visual encoder is FP32 while quantized MatMul operators are embedded
    // directly in the decoder graph. Both files intentionally keep the normal
    // ONNX filename, so the loader must not append a dtype suffix.
    dtype: 'fp32',
    session_options: {
      executionMode: 'sequential',
      graphOptimizationLevel: 'all',
      enableCpuMemArena: true,
      enableMemPattern: true,
    },
  }).catch((error) => {
    recognizerPromise = null
    activeConfiguration = ''
    throw error
  })
  return recognizerPromise
}

globalThis.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const request = event.data
  const respond = (message: Omit<WorkerResponse, 'id'>) => globalThis.postMessage({ id: request?.id, ...message })
  try {
    if (
      !request
      || typeof request.id !== 'string'
      || request.id.length > 96
      || !(request.pixels instanceof ArrayBuffer)
      || !Number.isSafeInteger(request.width)
      || !Number.isSafeInteger(request.height)
      || request.width < 8
      || request.width > 4096
      || request.height < 8
      || request.height > 1024
      || request.pixels.byteLength !== request.width * request.height * 4
      || !['fanotes-trocr', 'fanotes-trocr-web'].includes(request.modelId)
    ) throw new Error('Die gerenderte Handschriftzeile ist ungültig.')
    const recognizer = await loadRecognizer(request)
    const image = new RawImage(new Uint8ClampedArray(request.pixels), request.width, request.height, 4)
    // Transformers.js 3.8's image pipeline exposes one deterministic sequence;
    // its generic generation loop does not spawn and retain independent beams.
    // Asking it for two therefore paid top-k work without producing a second
    // usable line. The caller obtains a real alternative from a separately
    // rendered view only for unresolved lines.
    const generated = await recognizer(image, {
      max_new_tokens: 160,
      num_beams: 1,
      num_return_sequences: 1,
      do_sample: false,
    })
    const outputs = generated as unknown as Array<{ generated_text: string }>
    const candidates = [...new Set(outputs.map((entry) => normalizeGermanSharpS(entry.generated_text)
      .normalize('NFC')
      .replace(/[ \t]{2,}/gu, ' ')
      .replace(/\s+([,.;:!?])/gu, '$1')
      .trim()
      .slice(0, 1_000)))]
      .filter(Boolean)
      .slice(0, 4)
    respond({ text: candidates[0] ?? '', candidates })
  } catch (error) {
    respond({ error: error instanceof Error ? error.message : 'Das lokale TrOCR-Modell konnte die Zeile nicht lesen.' })
  }
}
