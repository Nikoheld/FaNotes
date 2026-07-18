'use strict'

const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const { Worker } = require('node:worker_threads')

const root = path.resolve(__dirname, '..')
const resources = path.join(root, 'release', 'linux-unpacked', 'resources')
const nativeRoot = path.join(resources, 'native-ocr')
const runtimeEntry = path.join(nativeRoot, 'node_modules', 'onnxruntime-node', 'dist', 'index.js')
const modelPath = path.join(resources, 'app.asar.unpacked', 'dist', 'ocr', 'pylaia-iam.onnx')
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'public', 'ocr', 'manifest.json'), 'utf8'))

for (const target of [runtimeEntry, modelPath]) assert.ok(fs.statSync(target).isFile(), `Fehlende Release-Ressource: ${target}`)
assert.equal(fs.statSync(modelPath).size, manifest.models.desktop.size)
assert.equal(crypto.createHash('sha256').update(fs.readFileSync(modelPath)).digest('hex'), manifest.models.desktop.sha256)
const resolvedCommon = require.resolve('onnxruntime-common', { paths: [path.dirname(runtimeEntry)] })
assert.ok(resolvedCommon.startsWith(`${nativeRoot}${path.sep}`), `Die Release-Runtime fällt auf den Workspace zurück: ${resolvedCommon}`)
const packagedCommon = JSON.parse(fs.readFileSync(path.join(nativeRoot, 'node_modules', 'onnxruntime-common', 'package.json'), 'utf8'))
assert.equal(packagedCommon.version, '1.21.0')

const width = 32
const height = 128
const input = new Float32Array(width * height)
const worker = new Worker(path.join(root, 'electron', 'native-ocr-worker.cjs'), {
  workerData: { runtimeEntry, modelPath },
})

const result = new Promise((resolve, reject) => {
  const timeout = setTimeout(() => reject(new Error('Packaged native OCR worker timed out.')), 30_000)
  worker.once('error', reject)
  worker.on('message', (message) => {
    if (message.id !== 'packaged-native-contract') return
    clearTimeout(timeout)
    if (message.error) reject(new Error(message.error))
    else resolve(message)
  })
})
worker.postMessage({ id: 'packaged-native-contract', input: input.buffer, width, height, threads: 2 }, [input.buffer])

result.then(async (message) => {
  assert.equal(message.engine, 'onnxruntime-node-cpu')
  assert.ok(message.probabilities instanceof ArrayBuffer)
  assert.equal(message.dims.at(-1), manifest.characters.count + 1)
  await worker.terminate()
  console.log(`Gepackte native ONNX-Runtime geprüft: eigenständige Common-Runtime ${packagedCommon.version}, externes SHA-256-Modell und echte Zwei-Thread-Inferenz.`)
}).catch(async (error) => {
  await worker.terminate()
  console.error(error)
  process.exitCode = 1
})
