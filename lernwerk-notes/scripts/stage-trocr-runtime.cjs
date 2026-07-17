'use strict'

const crypto = require('node:crypto')
const fs = require('node:fs/promises')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
const transformersRoot = path.join(root, 'node_modules', '@huggingface', 'transformers')
const packageRoot = path.join(transformersRoot, 'node_modules', 'onnxruntime-web')
const output = path.join(root, 'public', 'ocr', 'trocr-runtime')
const files = ['ort-wasm-simd-threaded.mjs', 'ort-wasm-simd-threaded.wasm']
const digest = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex')

async function main() {
  const transformersPackageJson = JSON.parse(
    await fs.readFile(path.join(transformersRoot, 'package.json'), 'utf8'),
  )
  const packageJson = JSON.parse(await fs.readFile(path.join(packageRoot, 'package.json'), 'utf8'))
  const runtimeNotice = `# FaNotes OCR runtime notices

- Transformers.js ${String(transformersPackageJson.version)}:
  Copyright the Hugging Face team, Apache License 2.0.
- ONNX Runtime Web ${String(packageJson.version)}:
  Copyright Microsoft Corporation, MIT License.

These libraries run locally in a sandboxed Web Worker. No handwriting image is
sent to Hugging Face, Microsoft, or another recognition service.
`
  if (packageJson.version !== '1.22.0-dev.20250409-89f8206ba4') {
    throw new Error(`Unerwartete Transformers.js-ONNX-Laufzeit: ${String(packageJson.version)}`)
  }
  await fs.mkdir(output, { recursive: true, mode: 0o755 })
  const assets = []
  for (const file of files) {
    const bytes = await fs.readFile(path.join(packageRoot, 'dist', file))
    if (!bytes.length || bytes.length > 16 * 1024 * 1024) throw new Error(`Ungültige TrOCR-Laufzeit: ${file}`)
    await fs.writeFile(path.join(output, file), bytes, { mode: 0o644 })
    assets.push({ file, size: bytes.length, sha256: digest(bytes) })
  }
  const manifest = {
    format: 'fanotes-trocr-runtime-v1',
    package: '@huggingface/transformers',
    transformersVersion: '3.8.1',
    onnxRuntimeVersion: packageJson.version,
    assets,
  }
  await fs.writeFile(path.join(output, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o644 })
  await fs.writeFile(path.join(output, 'NOTICE.md'), runtimeNotice, { mode: 0o644 })
  await Promise.all([
    fs.copyFile(
      path.join(root, 'packaging', 'LICENSE-TRANSFORMERS-APACHE-2.0.txt'),
      path.join(output, 'LICENSE-TRANSFORMERS-APACHE-2.0.txt'),
    ),
    fs.copyFile(
      path.join(root, 'packaging', 'LICENSE-ONNXRUNTIME-MIT.txt'),
      path.join(output, 'LICENSE-ONNXRUNTIME-MIT.txt'),
    ),
  ])
  console.log(`TrOCR-WASM-Laufzeit ${packageJson.version} bereitgestellt.`)
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
