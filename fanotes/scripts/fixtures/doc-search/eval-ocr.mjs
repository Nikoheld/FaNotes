// OCR evaluation: the app's line segmenter + bundled TrOCR vs host Tesseract (deu). Not part of the app or CI.
import fs from 'node:fs'
import { execFileSync } from 'node:child_process'
import { createServer } from 'vite'
import { pipeline, env, RawImage } from '@huggingface/transformers'
// usage (from fanotes/): node scripts/fixtures/doc-search/eval-ocr.mjs <model> <pages,...> <dir with NAME.rgba/NAME.json/NAME.png and truth.txt>
const dir = (process.argv[4] ?? '').replace(/\/?$/u, '/')
const server = await createServer({ appType: 'custom', logLevel: 'error', optimizeDeps: { noDiscovery: true }, server: { middlewareMode: true } })
const { segmentPdfOcrLines } = await server.ssrLoadModule('/src/lib/pdfOcr.ts')
const { foldPlain } = await server.ssrLoadModule('/src/lib/docSearch/text.ts')
env.allowRemoteModels = false; env.allowLocalModels = true; env.localModelPath = process.cwd() + '/public/ocr/'
const model = process.argv[2] || 'fanotes-trocr-web'
const recognizer = await pipeline('image-to-text', model, { local_files_only: true, dtype: 'fp32', device: 'cpu' })
const truth = fs.readFileSync(dir + 'truth.txt', 'utf8')
const truthWords = [...new Set(foldPlain(truth).split(' ').filter((w) => w.length >= 4))]
const lev = (a, b) => { const d = Array.from({ length: b.length + 1 }, (_, i) => i); for (let i = 1; i <= a.length; i++) { let prev = d[0]; d[0] = i; for (let j = 1; j <= b.length; j++) { const tmp = d[j]; d[j] = Math.min(d[j] + 1, d[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1)); prev = tmp } } return d[b.length] }
const score = (text) => { const words = new Set(foldPlain(text).split(' ')); const found = truthWords.filter((w) => words.has(w)).length; return { recall: found / truthWords.length, cer: lev(foldPlain(text), foldPlain(truth)) / foldPlain(truth).length } }
const rows = []
for (const name of (process.argv[3] || 'clean-sans,clean-serif,small-sans,skew-2deg,noise-lowcontrast,rotated-90').split(',')) {
  const meta = JSON.parse(fs.readFileSync(dir + name + '.json', 'utf8'))
  const pixels = new Uint8ClampedArray(fs.readFileSync(dir + name + '.rgba'))
  let t = performance.now()
  const lines = segmentPdfOcrLines(pixels, meta.width, meta.height)
  const parts = []
  for (const line of lines) {
    const out = await recognizer(new RawImage(line.pixels, line.width, line.height, 4), { max_new_tokens: 160, num_beams: 1, do_sample: false })
    parts.push(out[0].generated_text.trim())
  }
  const trocrMs = performance.now() - t
  const trocr = score(parts.join('\n'))
  t = performance.now()
  let tess = { recall: 0, cer: 1 }, tessText = ''
  try { tessText = execFileSync('tesseract', [dir + name + '.png', '-', '-l', 'deu', '--psm', '3'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); tess = score(tessText) } catch {}
  const tessMs = performance.now() - t
  rows.push({ page: name, lines: lines.length, trocrRecall: +(trocr.recall * 100).toFixed(0), trocrCer: +(trocr.cer * 100).toFixed(1), trocrSec: +(trocrMs / 1000).toFixed(1), tessRecall: +(tess.recall * 100).toFixed(0), tessCer: +(tess.cer * 100).toFixed(1), tessSec: +(tessMs / 1000).toFixed(1), sample: parts.slice(0, 2).join(' | ').slice(0, 120) })
  console.log(JSON.stringify(rows.at(-1)))
}
fs.writeFileSync(dir + `results-${model}.json`, JSON.stringify({ model, truthWords: truthWords.length, rows }, null, 1))
await server.close()
