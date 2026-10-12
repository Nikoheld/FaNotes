import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createCanvas } from '@napi-rs/canvas'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { copyPdfjsAssets } from './pdfjs-assets-plugin.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const fonts = join(root, 'node_modules/pdfjs-dist/standard_fonts') + '/'
const cmaps = join(root, 'node_modules/pdfjs-dist/cmaps') + '/'
const wasm = join(root, 'node_modules/pdfjs-dist/wasm') + '/'
const iccs = join(root, 'node_modules/pdfjs-dist/iccs') + '/'

const pdfBytes = (fontName, text) => {
  const stream = `BT /F1 72 Tf 30 40 Td (${text}) Tj ET\n`
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 240 140] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`,
    `<< /Type /Font /Subtype /Type1 /BaseFont /${fontName} >>`,
  ]
  let body = '%PDF-1.4\n'
  const offsets = [0]
  for (let index = 0; index < objects.length; index += 1) {
    offsets.push(Buffer.byteLength(body))
    body += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`
  }
  const xref = Buffer.byteLength(body)
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (let index = 1; index < offsets.length; index += 1) {
    body += `${String(offsets[index]).padStart(10, '0')} 00000 n \n`
  }
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return new Uint8Array(Buffer.from(body))
}

const darkPixels = async (bytes, options) => {
  const task = getDocument({
    data: bytes.slice(),
    disableFontFace: true,
    useSystemFonts: true,
    ...options,
  })
  const pdf = await task.promise
  const page = await pdf.getPage(1)
  const viewport = page.getViewport({ scale: 2 })
  const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height))
  const context = canvas.getContext('2d')
  context.fillStyle = '#ffffff'
  context.fillRect(0, 0, canvas.width, canvas.height)
  await page.render({ canvasContext: context, viewport }).promise
  const image = context.getImageData(0, 0, canvas.width, canvas.height)
  let dark = 0
  for (let index = 0; index < image.data.length; index += 4) {
    if (image.data[index] < 40 && image.data[index + 1] < 40 && image.data[index + 2] < 40 && image.data[index + 3] > 200) {
      dark += 1
    }
  }
  await task.destroy()
  return dark
}

const assetOptions = {
  standardFontDataUrl: fonts,
  cMapUrl: cmaps,
  wasmUrl: wasm,
  iccUrl: iccs,
  cMapPacked: true,
  useWasm: true,
}

const dingbats = pdfBytes('ZapfDingbats', 'l')
const withAssets = await darkPixels(dingbats, assetOptions)
const withoutAssets = await darkPixels(dingbats, {})
assert.ok(withAssets > 400, `ZapfDingbats must paint with the bundled font, got ${withAssets} dark pixels`)
assert.ok(
  withAssets > withoutAssets * 2,
  `the bundled ZapfDingbats glyph must be larger than the missing-font fallback, got ${withAssets} vs ${withoutAssets}`,
)

const helvetica = pdfBytes('Helvetica', 'Ag')
const helveticaInk = await darkPixels(helvetica, assetOptions)
assert.ok(helveticaInk > 400, `Helvetica must paint with the bundled font, got ${helveticaInk} dark pixels`)

const copied = mkdtempSync(join(tmpdir(), 'fanotes-pdfjs-'))
try {
  copyPdfjsAssets(root, copied)
  assert.ok(existsSync(join(copied, 'pdfjs/cmaps/78-EUC-H.bcmap')))
  assert.ok(existsSync(join(copied, 'pdfjs/standard_fonts/LiberationSans-Regular.ttf')))
  assert.ok(existsSync(join(copied, 'pdfjs/wasm/openjpeg.wasm')))
  assert.ok(existsSync(join(copied, 'pdfjs/iccs/CGATS001Compat-v2-micro.icc')))
} finally {
  rmSync(copied, { recursive: true, force: true })
}

console.log(JSON.stringify({ withAssets, withoutAssets, helveticaInk }))
console.log('pdf-assets ok')
