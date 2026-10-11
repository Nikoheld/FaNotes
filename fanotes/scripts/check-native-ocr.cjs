'use strict'

const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const { ENGINE, createNativeOcrHost, nativeOcrExecutable, nativeOcrRuntime } = require('../electron/native-ocr.cjs')

const root = path.resolve(__dirname, '..')
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8')
const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')

const manifest = JSON.parse(read('public', 'ocr', 'manifest.json'))
assert.equal(manifest.format, 'fanotes-neural-handwriting-v3')
assert.equal(manifest.models.desktop.precision, 'fp32')
assert.equal(manifest.models.web.precision, 'q8-dynamic')
assert.ok(manifest.models.web.size < manifest.models.desktop.size * 0.4)

// Packaging: the sidecar plus the pinned CPU-only ONNX Runtime library, no Node addon.
const packageMetadata = JSON.parse(read('package.json'))
assert.deepEqual(packageMetadata.build.asarUnpack, ['dist/ocr/pylaia-iam.onnx'])
assert.ok(packageMetadata.build.files.includes('!dist/ocr/fanotes-trocr-web/**/*'))
assert.ok(packageMetadata.build.files.includes('!dist/ocr/pylaia-iam-q8.onnx'))
assert.equal(packageMetadata.devDependencies['onnxruntime-node'], '1.21.0')
assert.equal(require('onnxruntime-node/package.json').version, '1.21.0')
const platforms = [
  { name: 'linux', arch: 'x64', executable: 'fanotes-ocr', runtime: 'libonnxruntime.so.1' },
  { name: 'win', arch: 'x64', directory: 'win32', executable: 'fanotes-ocr.exe', runtime: 'onnxruntime.dll' },
]
for (const platform of platforms) {
  const directory = platform.directory ?? platform.name
  const resources = packageMetadata.build[platform.name].extraResources
  const sidecar = resources.find((entry) => entry.from === `native-ocr/${directory}-${platform.arch}`)
  const runtime = resources.find((entry) => entry.from === `node_modules/onnxruntime-node/bin/napi-v3/${directory}/${platform.arch}`)
  assert.deepEqual(sidecar, { from: `native-ocr/${directory}-${platform.arch}`, to: 'native-ocr', filter: [platform.executable, 'runtime-manifest.json'] })
  assert.deepEqual(runtime, { from: `node_modules/onnxruntime-node/bin/napi-v3/${directory}/${platform.arch}`, to: 'native-ocr', filter: [platform.runtime] })
  const filters = resources.flatMap((entry) => [entry.from, entry.to, ...(entry.filter ?? [])]).join('\n')
  assert.doesNotMatch(filters, /cuda|tensorrt|directml|onnxruntime_binding|onnxruntime-common|dist\/\*\.js/iu)

  // The committed sidecar is what runtime-manifest.json describes, and that manifest pins the
  // exact library of onnxruntime-node@1.21.0.
  const staged = path.join(root, 'native-ocr', `${directory}-${platform.arch}`)
  const runtimeManifest = JSON.parse(fs.readFileSync(path.join(staged, 'runtime-manifest.json'), 'utf8'))
  assert.equal(runtimeManifest.format, 'fanotes-native-ocr-runtime-v1')
  assert.equal(runtimeManifest.engine, ENGINE)
  assert.equal(runtimeManifest.executable.file, platform.executable)
  assert.equal(fs.statSync(path.join(staged, platform.executable)).size, runtimeManifest.executable.size)
  assert.equal(sha256(path.join(staged, platform.executable)), runtimeManifest.executable.sha256)
  assert.equal(runtimeManifest.onnxruntime.version, '1.21.0')
  assert.equal(runtimeManifest.onnxruntime.file, platform.runtime)
  assert.equal(sha256(path.join(root, runtimeManifest.onnxruntime.from)), runtimeManifest.onnxruntime.sha256)
  if (platform.name === 'linux') assert.ok(fs.statSync(path.join(staged, platform.executable)).mode & 0o111)
}

// Wiring: the manifest digest travels to the sidecar, which is loaded on the first conversion only.
const mainSource = read('electron', 'main.cjs')
assert.match(mainSource, /app\.asar\.unpacked'[\s\S]+descriptor\.file/u)
assert.match(mainSource, /size: descriptor\.size,\s*sha256: descriptor\.sha256/u)
assert.match(mainSource, /function ensureNativeOcrHost\(model\) \{[\s\S]*?require\('\.\/native-ocr\.cjs'\)/u)
assert.equal(mainSource.match(/require\('\.\/native-ocr\.cjs'\)/gu)?.length, 1)
assert.match(mainSource, /async function recognizeNativeOcrLine[\s\S]*?ensureNativeOcrHost\(model\)\.recognize/u)
assert.doesNotMatch(mainSource, /onnxruntime-node|native-ocr-worker|worker_threads/u)
assert.ok(!fs.existsSync(path.join(root, 'electron', 'native-ocr-worker.cjs')))
assert.match(read('src', 'lib', 'neuralTextRecognition.ts'), /native\.engine !== 'fanotes-ort-cpu'/u)

const modelPath = path.join(root, 'public', 'ocr', manifest.models.desktop.file)
const model = { path: modelPath, size: manifest.models.desktop.size, sha256: manifest.models.desktop.sha256 }
const location = { packaged: false, appPath: root }
const executable = nativeOcrExecutable(location)
const runtime = nativeOcrRuntime(location)

const strokes = (width) => Float32Array.from({ length: width * 128 }, (_, index) => {
  const y = Math.floor(index / width)
  const x = index % width
  return y >= 40 && y < 88 && Math.floor(x / 6) % 3 === 0 ? 1 : 0
})
const noise = (width) => {
  let state = 0x2545f491
  return Float32Array.from({ length: width * 128 }, () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 2 ** 32
  })
}
const lines = [
  { width: 32, input: new Float32Array(32 * 128) },
  { width: 333, input: strokes(333) },
  { width: 1000, input: noise(1000) },
]

async function main() {
  const host = createNativeOcrHost({ executable, runtime, model })
  assert.equal(host.pid, null, 'Nothing may start before the first conversion.')
  await assert.rejects(host.recognize({ input: new Float32Array(32 * 64), width: 32, height: 64, threads: 2 }), /Die native OCR-Eingabe ist ungültig\./u)
  await assert.rejects(host.recognize({ input: new Float32Array(32 * 128), width: 32, height: 128, threads: 5 }), /Die native OCR-Eingabe ist ungültig\./u)
  assert.equal(host.pid, null, 'Refused input must not start the sidecar.')

  const first = await host.recognize({ input: new Float32Array(32 * 128), width: 32, height: 128, threads: 2 })
  assert.ok(host.pid)
  assert.equal(first.engine, ENGINE)
  assert.ok(first.probabilities instanceof Float32Array)
  assert.deepEqual(first.dims.slice(0, 1), [1])
  assert.equal(first.dims.at(-1), manifest.characters.count + 1)
  assert.ok(first.probabilities.length > manifest.characters.count)
  assert.ok(first.probabilities.every(Number.isFinite))

  // Same lines through onnxruntime-node with the options native-ocr-worker.cjs used.
  const ort = require('onnxruntime-node')
  ort.env.logLevel = 'error'
  const reference = await ort.InferenceSession.create(modelPath, {
    executionProviders: ['cpu'],
    executionMode: 'sequential',
    graphOptimizationLevel: 'all',
    enableCpuMemArena: true,
    enableMemPattern: true,
    intraOpNumThreads: 2,
    interOpNumThreads: 1,
  })
  let largest = 0
  for (const line of lines) {
    const native = await host.recognize({ input: line.input, width: line.width, height: 128, threads: 2 })
    const expected = (await reference.run({ x: new ort.Tensor('float32', line.input, [1, 1, 128, line.width]) })).probabilities
    assert.deepEqual(native.dims, Array.from(expected.dims, Number), `width ${line.width}`)
    for (let index = 0; index < expected.data.length; index += 1) {
      largest = Math.max(largest, Math.abs(native.probabilities[index] - expected.data[index]))
    }
  }
  await reference.release()
  // Same library, same options, same thread count: the bits must match. A different graph
  // optimization level alone already moves them by about 5e-6.
  assert.equal(largest, 0, `fanotes-ort differs from onnxruntime-node by ${largest}`)
  host.stop()

  // The SHA-256 gate: weights that do not match the manifest never reach a session.
  const tampered = createNativeOcrHost({ executable, runtime, model: { ...model, sha256: `${model.sha256[0] === '0' ? '1' : '0'}${model.sha256.slice(1)}` } })
  await assert.rejects(tampered.recognize({ input: new Float32Array(32 * 128), width: 32, height: 128, threads: 2 }), /Das native Handschriftmodell ist beschädigt\./u)
  tampered.stop()

  console.log(`Native ONNX OCR: fanotes-ocr (ort, ONNX Runtime 1.21.0) als eigener Prozess, 2 begrenzte Threads, ${first.dims.join('×')} Ausgabewerte, maximal ${largest.toExponential(1)} Abweichung zu onnxruntime-node; SHA-256-Sperre aktiv; Linux-/Windows-Pakete ohne CUDA/DirectML-Ballast.`)
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
