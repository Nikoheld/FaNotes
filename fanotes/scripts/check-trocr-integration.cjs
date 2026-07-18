'use strict'

const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
const read = (relative) => fs.readFileSync(path.join(root, relative))
const text = (relative) => read(relative).toString('utf8')
const digest = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex')

const verifyManifest = (directory, expectedFormat, maximumBytes) => {
  const manifest = JSON.parse(text(`${directory}/manifest.json`))
  assert.equal(manifest.format, expectedFormat)
  assert.ok(Array.isArray(manifest.assets) && manifest.assets.length > 0)
  const listed = new Set()
  for (const asset of manifest.assets) {
    assert.match(asset.file, /^(?:onnx\/)?[a-z0-9][a-z0-9._-]*$/u)
    assert.ok(!listed.has(asset.file), `Doppelte OCR-Ressource: ${asset.file}`)
    listed.add(asset.file)
    const bytes = read(`${directory}/${asset.file}`)
    assert.equal(bytes.length, asset.size, `Falsche Dateigrösse: ${asset.file}`)
    assert.ok(bytes.length > 0 && bytes.length <= maximumBytes, `Unzulässige Ressourcengrösse: ${asset.file}`)
    assert.equal(digest(bytes), asset.sha256, `Prüfsummenfehler: ${asset.file}`)
  }
  return manifest
}

const model = verifyManifest('public/ocr/fanotes-trocr', 'fanotes-trocr-web-v1', 100 * 1024 * 1024)
assert.equal(model.opset, 18)
assert.equal(model.quantization, 'fp32-encoder-q8-decoder')
assert.equal(model.assets.length, 9)
assert.match(text('public/ocr/fanotes-trocr/NOTICE.md'), /IAM Handwriting Database/u)
assert.match(text('public/ocr/fanotes-trocr/NOTICE.md'), /10\.5281\/zenodo\.18301532/u)
assert.match(text('public/ocr/fanotes-trocr/LICENSE-MIT.txt'), /Copyright \(c\) Microsoft Corporation/u)

const webModel = verifyManifest('public/ocr/fanotes-trocr-web', 'fanotes-trocr-web-v1', 64 * 1024 * 1024)
assert.equal(webModel.opset, 18)
assert.equal(webModel.quantization, 'q8-encoder-q8-decoder')
assert.equal(webModel.assets.length, 9)
assert.ok(webModel.assets.find((asset) => asset.file === 'onnx/encoder_model.onnx').size < 25 * 1024 * 1024)
assert.ok(webModel.assets.reduce((sum, asset) => sum + asset.size, 0) < model.assets.reduce((sum, asset) => sum + asset.size, 0) * 0.55)
assert.match(text('public/ocr/fanotes-trocr-web/NOTICE.md'), /IAM Handwriting Database/u)
assert.match(text('public/ocr/fanotes-trocr-web/LICENSE-MIT.txt'), /Copyright \(c\) Microsoft Corporation/u)

const runtime = verifyManifest('public/ocr/trocr-runtime', 'fanotes-trocr-runtime-v1', 16 * 1024 * 1024)
assert.equal(runtime.transformersVersion, '3.8.1')
assert.equal(runtime.onnxRuntimeVersion, '1.22.0-dev.20250409-89f8206ba4')
assert.deepEqual(runtime.assets.map((asset) => asset.file).sort(), [
  'ort-wasm-simd-threaded.mjs',
  'ort-wasm-simd-threaded.wasm',
])
assert.match(text('public/ocr/trocr-runtime/NOTICE.md'), /Apache License 2\.0/u)
assert.match(text('public/ocr/trocr-runtime/NOTICE.md'), /MIT License/u)
assert.match(text('public/ocr/trocr-runtime/LICENSE-TRANSFORMERS-APACHE-2.0.txt'), /Apache License/u)
assert.match(text('public/ocr/trocr-runtime/LICENSE-ONNXRUNTIME-MIT.txt'), /Copyright \(c\) Microsoft Corporation/u)

const worker = text('src/lib/trocrWorker.ts')
assert.match(worker, /env\.allowRemoteModels = false/u)
assert.match(worker, /device: 'wasm'/u)
assert.match(worker, /num_beams: 2/u)
assert.doesNotMatch(worker, /webgpu|cuda|vulkan/iu)
assert.match(worker, /Math\.min\(4, request\.threads\)/u)
assert.match(worker, /request\.modelId/u)
assert.match(worker, /fanotes-trocr-web/u)

const client = text('src/lib/trocrClient.ts')
const limits = text('src/lib/resourceLimits.ts')
assert.match(client, /import TrocrWorker from '\.\/trocrWorker\?worker&inline'/u)
assert.match(client, /new TrocrWorker\(/u)
assert.match(client, /120_000/u)
assert.match(client, /fanotes-model:\/\/local\//u)
assert.match(client, /crypto\.subtle\.digest\('SHA-256'/u)
assert.match(client, /trocr-runtime\/manifest\.json/u)
assert.match(client, /threads: effectiveOcrThreadCount\(window\.fanotes\.platform === 'web' \? 2 : 4\)/u)
assert.match(client, /ocrWorkerKeepAliveMilliseconds\(\)/u)
assert.match(limits, /fanotesOcrThreads/u)
assert.match(limits, /fanotesOcrKeepAliveSeconds/u)
assert.match(limits, /Math\.floor\(hardware \/ 2\)/u)
assert.match(limits, /seconds === 0 \? 1 : seconds \* 1_000/u)

assert.match(worker, /URL\.createObjectURL\(new Blob/u)
assert.match(worker, /runtimeModuleSource/u)

const main = text('electron/main.cjs')
assert.match(main, /scheme: 'fanotes-model'/u)
assert.match(main, /Cross-Origin-Embedder-Policy': \['require-corp'\]/u)
assert.match(main, /Cross-Origin-Opener-Policy': \['same-origin'\]/u)
assert.match(main, /script-src 'self' blob: 'wasm-unsafe-eval'/u)
assert.match(main, /fanotes-trocr\(\?:-web\)\?\|trocr-runtime/u)
assert.match(main, /info\.isSymbolicLink\(\)/u)
assert.match(main, /info\.size > 100 \* 1024 \* 1024/u)
assert.match(main, /Access-Control-Allow-Origin', '\*'/u)
assert.match(main, /text\/javascript; charset=utf-8/u)
assert.match(main, /application\/wasm/u)

const pwa = text('scripts/build-web-pwa.mjs')
assert.match(pwa, /file\.startsWith\('ocr\/'\)/u)
assert.match(pwa, /file\.includes\('trocrWorker-'/u)
assert.match(pwa, /file\.includes\('neuralTextRecognition-'/u)
assert.match(pwa, /ort-wasm|\.wasm/u)

console.log('TrOCR-Integration geprüft: Modell/WASM bytegenau, Beam-2 lokal, Worker-Lazy-Loading, Electron-Protokoll, Isolation und PWA-Startcache.')
