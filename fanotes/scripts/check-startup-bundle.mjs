// Guards the startup bundle: the recognition wasm is a binary asset fetched on first use (not
// base64 in the main chunk), and trocr / pdf.js stay behind dynamic imports on the startup path.
//
//   node scripts/check-startup-bundle.mjs            static source checks
//   node scripts/check-startup-bundle.mjs dist       also checks a vite build (and the PWA precache)
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8')

const wasmPath = path.join(root, 'src', 'lib', 'recogWasm', 'fanotes_recog_wasm_bg.wasm')
const wasm = fs.readFileSync(wasmPath)
assert.deepEqual([...wasm.subarray(0, 4)], [0x00, 0x61, 0x73, 0x6d], 'the recognition wasm asset starts with the wasm magic')
assert.ok(WebAssembly.validate(wasm), 'the recognition wasm asset validates')
assert.equal(fs.existsSync(path.join(root, 'src', 'lib', 'recogWasm', 'bytes.ts')), false, 'no base64 copy of the recognition wasm')

const core = read('src', 'lib', 'recogCore.ts')
assert.doesNotMatch(core, /RECOG_WASM_BASE64|\.\/recogWasm\/bytes/u, 'recogCore must not embed the wasm as base64')
assert.match(core, /new URL\('\.\/recogWasm\/fanotes_recog_wasm_bg\.wasm', import\.meta\.url\)/u, 'recogCore fetches the wasm asset through a bundler-resolved URL')
assert.match(core, /export const loadRecogWasm/u)

const glue = read('src', 'lib', 'recogWasm', 'fanotes_recog_wasm.js')
assert.match(glue, /WebAssembly\.instantiateStreaming/u, 'the glue streams the wasm')
assert.match(glue, /WebAssembly\.instantiate\(bytes, imports\)/u, 'and falls back to an ArrayBuffer when the MIME type is wrong (file://)')

const staticImport = (source, name) => new RegExp(`^import[^\\n]*['"][^'"]*${name}['"]`, 'mu').test(source)
const recognition = fs.readFileSync(path.join(root, '..', 'src', 'lib', 'recognition.ts'), 'utf8')
assert.equal(staticImport(recognition, 'recogCore'), false, 'recognition.ts (main chunk) loads recogCore on demand')
assert.equal(staticImport(read('src', 'lib', 'docSearch', 'service.ts'), 'trocrClient'), false, 'docSearch/service loads trocrClient on demand')
assert.equal(staticImport(read('src', 'lib', 'docSearch', 'extract.ts'), 'pdfOcrRun'), false, 'docSearch/extract loads pdfOcrRun on demand')
const pdfDocument = read('src', 'lib', 'pdfDocument.ts')
assert.doesNotMatch(pdfDocument, /^import [^\n]*pdf\.worker/mu, 'pdfDocument must not statically import the pdf.js worker URL (it pulls the pdf.js chunk into startup)')

for (const file of ['inkRecognition.ts', 'neuralTextRecognition.ts']) {
  assert.match(read('src', 'lib', file), /loadRecogWasm/u, `${file} awaits the wasm before calling it`)
}

if (process.argv[2] === 'dist') {
  const assets = path.join(root, 'dist', 'assets')
  const files = fs.readdirSync(assets)
  const main = files.filter((file) => /^index-.*\.js$/u.test(file))
  for (const file of main) assert.doesNotMatch(fs.readFileSync(path.join(assets, file), 'utf8').slice(0, 5_000_000), /AGFzbQEAAAAB5AZjYAAA/u, `${file} carries no base64 recognition wasm`)
  const wasmAsset = files.find((file) => /^fanotes_recog_wasm_bg-.*\.wasm$/u.test(file))
  assert.ok(wasmAsset, 'the build emits the recognition wasm asset')
  const worker = fs.readFileSync(path.join(root, 'dist', 'sw.js'), 'utf8')
  assert.ok(worker.includes(`./assets/${wasmAsset}`), 'the service worker precaches the recognition wasm (offline handwriting)')
}
console.log('Startup-Bundle: Erkennungs-Wasm als Binaer-Asset, trocr und pdf.js nicht im Startpfad.')
