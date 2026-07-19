'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { parentPort, workerData } = require('node:worker_threads')

if (!parentPort) throw new Error('Der native OCR-Worker benötigt einen übergeordneten Prozess.')

const runtimeEntry = path.resolve(String(workerData?.runtimeEntry ?? ''))
const modelPath = path.resolve(String(workerData?.modelPath ?? ''))
for (const target of [runtimeEntry, modelPath]) {
  const info = fs.lstatSync(target)
  if (!info.isFile() || info.isSymbolicLink() || info.size <= 0) {
    throw new Error('Eine native OCR-Ressource ist ungültig.')
  }
}

// Loaded inside this isolated worker only after an explicit conversion. The
// prebuilt CPU provider performs runtime AVX/AVX2/AVX-512 dispatch on Intel and
// remains compatible with AMD CPUs that expose the corresponding instruction
// sets. No native module is touched during normal application startup.
const ort = require(runtimeEntry)
ort.env.logLevel = 'error'

let sessionPromise = null
let sessionThreads = 0
let queue = Promise.resolve()

async function sessionFor(threads) {
  if (sessionPromise && sessionThreads === threads) return sessionPromise
  if (sessionPromise) {
    const previous = await sessionPromise.catch(() => null)
    await previous?.release?.()
  }
  sessionThreads = threads
  sessionPromise = ort.InferenceSession.create(modelPath, {
    executionProviders: ['cpu'],
    executionMode: 'sequential',
    graphOptimizationLevel: 'all',
    enableCpuMemArena: true,
    enableMemPattern: true,
    intraOpNumThreads: threads,
    interOpNumThreads: 1,
  }).catch((error) => {
    sessionPromise = null
    sessionThreads = 0
    throw error
  })
  return sessionPromise
}

async function recognize(request) {
  if (
    !request
    || typeof request.id !== 'string'
    || request.id.length > 96
    || !(request.input instanceof ArrayBuffer)
    || !Number.isSafeInteger(request.width)
    || !Number.isSafeInteger(request.height)
    || request.width < 32
    || request.width > 4096
    || request.height !== 128
    || request.input.byteLength !== request.width * request.height * Float32Array.BYTES_PER_ELEMENT
    || !Number.isSafeInteger(request.threads)
    || request.threads < 1
    || request.threads > 4
  ) throw new Error('Die native OCR-Eingabe ist ungültig.')
  const session = await sessionFor(request.threads)
  const tensor = new ort.Tensor('float32', new Float32Array(request.input), [1, 1, request.height, request.width])
  const output = await session.run({ x: tensor })
  const prediction = output.probabilities ?? output[session.outputNames[0]]
  if (!prediction || !(prediction.data instanceof Float32Array)) {
    throw new Error('Die native ONNX-Laufzeit hat keine lesbare Textzeile geliefert.')
  }
  const probabilities = Float32Array.from(prediction.data)
  const dims = Array.from(prediction.dims, Number)
  parentPort.postMessage({
    id: request.id,
    probabilities: probabilities.buffer,
    dims,
    engine: 'onnxruntime-node-cpu',
  }, [probabilities.buffer])
}

parentPort.on('message', (request) => {
  queue = queue.then(() => recognize(request)).catch((error) => {
    parentPort.postMessage({
      id: typeof request?.id === 'string' ? request.id : '',
      error: error instanceof Error ? error.message : 'Die native ONNX-Erkennung ist fehlgeschlagen.',
    })
  })
})
