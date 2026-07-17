'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { Worker } = require('node:worker_threads')

const root = path.resolve(__dirname, '..')
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'public', 'ocr', 'manifest.json'), 'utf8'))
assert.equal(manifest.format, 'fanotes-neural-handwriting-v3')
assert.equal(manifest.models.desktop.precision, 'fp32')
assert.equal(manifest.models.web.precision, 'q8-dynamic')
assert.ok(manifest.models.web.size < manifest.models.desktop.size * 0.4)

const packageMetadata = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
assert.deepEqual(packageMetadata.build.asarUnpack, ['dist/ocr/pylaia-iam.onnx'])
assert.ok(packageMetadata.build.files.includes('!dist/ocr/fanotes-trocr-web/**/*'))
assert.ok(packageMetadata.build.files.includes('!dist/ocr/pylaia-iam-q8.onnx'))
const linuxFilters = packageMetadata.build.linux.extraResources.flatMap((entry) => entry.filter ?? [])
const windowsFilters = packageMetadata.build.win.extraResources.flatMap((entry) => entry.filter ?? [])
const nativeCommonResources = [
  packageMetadata.build.linux.extraResources.find((entry) => entry.to === 'native-ocr/node_modules/onnxruntime-common'),
  packageMetadata.build.win.extraResources.find((entry) => entry.to === 'native-ocr/node_modules/onnxruntime-common'),
]
assert.ok(linuxFilters.includes('bin/napi-v3/linux/x64/onnxruntime_binding.node'))
assert.ok(linuxFilters.includes('bin/napi-v3/linux/x64/libonnxruntime.so.1'))
assert.ok(windowsFilters.includes('bin/napi-v3/win32/x64/onnxruntime_binding.node'))
assert.ok(windowsFilters.includes('bin/napi-v3/win32/x64/onnxruntime.dll'))
assert.doesNotMatch([...linuxFilters, ...windowsFilters].join('\n'), /cuda|tensorrt|directml/iu)
assert.ok(nativeCommonResources.every((entry) => entry?.from === 'node_modules/onnxruntime-node/node_modules/onnxruntime-common'))
assert.ok(nativeCommonResources.every((entry) => entry?.filter?.includes('dist/cjs/**/*')))
const mainSource = fs.readFileSync(path.join(root, 'electron', 'main.cjs'), 'utf8')
assert.match(mainSource, /app\.asar\.unpacked'[\s\S]+descriptor\.file/u)
assert.match(mainSource, /crypto\.createHash\('sha256'\)/u)

const width = 32
const height = 128
const input = new Float32Array(width * height)
const worker = new Worker(path.join(root, 'electron', 'native-ocr-worker.cjs'), {
  workerData: {
    runtimeEntry: require.resolve('onnxruntime-node'),
    modelPath: path.join(root, 'public', 'ocr', manifest.models.desktop.file),
  },
})

const result = new Promise((resolve, reject) => {
  const timeout = setTimeout(() => reject(new Error('Native OCR worker timed out.')), 30_000)
  worker.once('error', reject)
  worker.on('message', (message) => {
    if (message.id !== 'native-contract') return
    clearTimeout(timeout)
    if (message.error) reject(new Error(message.error))
    else resolve(message)
  })
})
worker.postMessage({ id: 'native-contract', input: input.buffer, width, height, threads: 2 }, [input.buffer])

result.then(async (message) => {
  assert.equal(message.engine, 'onnxruntime-node-cpu')
  assert.ok(message.probabilities instanceof ArrayBuffer)
  assert.deepEqual(message.dims.slice(0, 1), [1])
  assert.equal(message.dims.at(-1), manifest.characters.count + 1)
  const probabilities = new Float32Array(message.probabilities)
  assert.ok(probabilities.length > manifest.characters.count)
  assert.ok(probabilities.every(Number.isFinite))
  await worker.terminate()
  console.log(`Native ONNX OCR: CPU worker, 2 begrenzte Threads, ${message.dims.join('×')} Ausgabewerte; Linux-/Windows-Pakete ohne CUDA/DirectML-Ballast.`)
}).catch(async (error) => {
  await worker.terminate()
  console.error(error)
  process.exitCode = 1
})
