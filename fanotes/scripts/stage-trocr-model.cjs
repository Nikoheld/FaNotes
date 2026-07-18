'use strict'

const crypto = require('node:crypto')
const fs = require('node:fs/promises')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
const source = process.env.FANOTES_TROCR_SOURCE
const variant = process.env.FANOTES_TROCR_VARIANT === 'web' ? 'web' : 'desktop'
const target = path.join(root, 'public', 'ocr', variant === 'web' ? 'fanotes-trocr-web' : 'fanotes-trocr')
const temporary = `${target}.staging-${process.pid}`
const expectedFiles = new Set([
  'config.json',
  'generation_config.json',
  'onnx/decoder_model_merged.onnx',
  'onnx/encoder_model.onnx',
  'preprocessor_config.json',
  'sentencepiece.bpe.model',
  'special_tokens_map.json',
  'tokenizer.json',
  'tokenizer_config.json',
])
const modelNotice = `# FaNotes TrOCR model notices

FaNotes_TrOCR_DE_EN is a local German/English handwriting-recognition model
fine-tuned from Microsoft's TrOCR Small Handwritten model.

- TrOCR / UniLM: Copyright Microsoft Corporation, MIT License.
  https://github.com/microsoft/unilm/tree/master/trocr
- IAM Handwriting Database: used by the upstream TrOCR handwriting checkpoint;
  the IAM database is provided for non-commercial research use and requests
  citation of U. Marti and H. Bunke, "The IAM-database: An English Sentence
  Database for Off-line Handwriting Recognition", IJDAR 5 (2002), 39-46.
  https://fki.tic.heia-fr.ch/databases/iam-handwriting-database
- ScaDS.AI German Line- and Word-Level Handwriting Dataset, version 1.0,
  Thomas Burghardt and Ahmad Alzin, CC BY 4.0, DOI 10.5281/zenodo.18301532.

The model files are separate third-party/derived data components and are not
relicensed by FaNotes' application-code MIT license.
`

const digest = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex')

async function main() {
  if (!source) throw new Error('FANOTES_TROCR_SOURCE muss auf das geprüfte TrOCR-Modell zeigen.')
  const manifestBytes = await fs.readFile(path.join(source, 'manifest.json'))
  if (!manifestBytes.length || manifestBytes.length > 64 * 1024) throw new Error('Ungültiges TrOCR-Manifest.')
  const manifest = JSON.parse(manifestBytes.toString('utf8'))
  if (
    manifest?.format !== 'fanotes-trocr-web-v1'
    || manifest?.model !== 'FaNotes_TrOCR_DE_EN'
    || manifest?.opset !== 18
    || manifest?.quantization !== (variant === 'web' ? 'q8-encoder-q8-decoder' : 'fp32-encoder-q8-decoder')
    || !Array.isArray(manifest.assets)
  ) throw new Error('Das TrOCR-Modell entspricht nicht der freigegebenen Mischpräzisionsvariante.')

  const listed = new Set(manifest.assets.map((asset) => asset?.file))
  if (listed.size !== expectedFiles.size || [...expectedFiles].some((file) => !listed.has(file))) {
    throw new Error('Das TrOCR-Manifest enthält nicht exakt die erwarteten Ressourcen.')
  }

  await fs.rm(temporary, { recursive: true, force: true })
  await fs.mkdir(temporary, { recursive: true, mode: 0o755 })
  for (const asset of manifest.assets) {
    if (
      typeof asset.file !== 'string'
      || !expectedFiles.has(asset.file)
      || !Number.isSafeInteger(asset.size)
      || asset.size <= 0
      || asset.size > 100 * 1024 * 1024
      || !/^[a-f0-9]{64}$/u.test(asset.sha256)
    ) throw new Error(`Ungültiger TrOCR-Eintrag: ${String(asset?.file)}`)
    const sourceFile = path.join(source, ...asset.file.split('/'))
    const bytes = await fs.readFile(sourceFile)
    if (bytes.length !== asset.size || digest(bytes) !== asset.sha256) {
      throw new Error(`TrOCR-Ressource ist beschädigt: ${asset.file}`)
    }
    const destination = path.join(temporary, ...asset.file.split('/'))
    await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o755 })
    await fs.writeFile(destination, bytes, { mode: 0o644 })
  }
  await fs.writeFile(path.join(temporary, 'manifest.json'), manifestBytes, { mode: 0o644 })
  await fs.writeFile(path.join(temporary, 'NOTICE.md'), modelNotice, { mode: 0o644 })
  await fs.copyFile(
    path.join(root, 'packaging', 'LICENSE-TROCR-MIT.txt'),
    path.join(temporary, 'LICENSE-MIT.txt'),
  )

  await fs.rm(target, { recursive: true, force: true })
  await fs.rename(temporary, target)
  console.log(`TrOCR-Modell geprüft und bereitgestellt: ${target}`)
}

main().catch(async (error) => {
  await fs.rm(temporary, { recursive: true, force: true }).catch(() => {})
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
