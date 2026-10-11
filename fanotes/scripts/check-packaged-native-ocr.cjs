'use strict'

const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const { ENGINE, createNativeOcrHost, nativeOcrExecutable, nativeOcrRuntime } = require('../electron/native-ocr.cjs')

const root = path.resolve(__dirname, '..')
const resources = path.join(root, 'release', 'linux-unpacked', 'resources')
const nativeRoot = path.join(resources, 'native-ocr')
const executable = nativeOcrExecutable({ packaged: true, resourcesPath: resources, platform: 'linux', arch: 'x64' })
const runtimeLibrary = path.join(nativeRoot, 'libonnxruntime.so.1')
const modelPath = path.join(resources, 'app.asar.unpacked', 'dist', 'ocr', 'pylaia-iam.onnx')
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'public', 'ocr', 'manifest.json'), 'utf8'))
const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')

for (const target of [executable, runtimeLibrary, modelPath]) assert.ok(fs.statSync(target).isFile(), `Fehlende Release-Ressource: ${target}`)
assert.equal(fs.statSync(modelPath).size, manifest.models.desktop.size)
assert.equal(sha256(modelPath), manifest.models.desktop.sha256)

// The package carries the sidecar, its manifest and the pinned ONNX Runtime library, nothing of the
// former onnxruntime-node addon.
assert.deepEqual(fs.readdirSync(nativeRoot).sort(), ['fanotes-ocr', 'libonnxruntime.so.1', 'runtime-manifest.json'])
assert.ok(fs.statSync(executable).mode & 0o111, 'fanotes-ocr muss ausführbar sein.')
const packagedManifest = JSON.parse(fs.readFileSync(path.join(nativeRoot, 'runtime-manifest.json'), 'utf8'))
assert.deepEqual(packagedManifest, JSON.parse(fs.readFileSync(path.join(root, 'native-ocr', 'linux-x64', 'runtime-manifest.json'), 'utf8')))
assert.equal(sha256(executable), packagedManifest.executable.sha256)
assert.equal(packagedManifest.onnxruntime.version, '1.21.0')
assert.equal(sha256(runtimeLibrary), packagedManifest.onnxruntime.sha256)

async function main() {
  const host = createNativeOcrHost({
    executable,
    runtime: nativeOcrRuntime({ packaged: true }),
    model: { path: modelPath, size: manifest.models.desktop.size, sha256: manifest.models.desktop.sha256 },
  })
  const width = 32
  const result = await host.recognize({ input: new Float32Array(width * 128), width, height: 128, threads: 2 })
  assert.equal(result.engine, ENGINE)
  assert.ok(result.probabilities instanceof Float32Array)
  assert.equal(result.dims.at(-1), manifest.characters.count + 1)
  assert.ok(result.probabilities.every(Number.isFinite))
  // The sidecar loaded the packaged runtime, not a workspace copy.
  const mapped = fs.readFileSync(`/proc/${host.pid}/maps`, 'utf8')
  assert.ok(mapped.includes(fs.realpathSync(runtimeLibrary)), 'fanotes-ocr muss die mitgelieferte ONNX Runtime laden.')
  assert.ok(!mapped.includes(path.join(root, 'node_modules')), 'Die Release-Laufzeit fällt auf den Workspace zurück.')
  host.stop()
  console.log(`Gepackte native OCR-Laufzeit geprüft: fanotes-ocr mit eigener ONNX Runtime ${packagedManifest.onnxruntime.version}, externes SHA-256-Modell und echte Zwei-Thread-Inferenz (${result.dims.join('×')}).`)
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
