import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import {
  PDF_OCR_FORMAT,
  PDF_OCR_MAX_PAGE_CHARS,
  PDF_OCR_MAX_PAGES,
  PDF_OCR_MIN_TEXT,
  pageNeedsLocalOcr,
  pdfByteStamp,
  pdfOcrCacheUsable,
  pdfPagesNeedingOcr,
  pdfTextSearchHits,
  sanitizePdfOcrCache,
  segmentPdfOcrLines,
} from '../src/lib/pdfOcr.ts'

const require = createRequire(import.meta.url)
const disk = require('../electron/pdf-ocr.cjs')

assert.equal(disk.FORMAT, PDF_OCR_FORMAT)
assert.equal(disk.MIN_TEXT, PDF_OCR_MIN_TEXT)
assert.equal(disk.MAX_PAGES, PDF_OCR_MAX_PAGES)
assert.equal(disk.MAX_PAGE_CHARS, PDF_OCR_MAX_PAGE_CHARS)
assert.equal(PDF_OCR_MIN_TEXT, 20)

assert.equal(pageNeedsLocalOcr(''), true)
assert.equal(pageNeedsLocalOcr('   Seite 4  '), true)
assert.equal(pageNeedsLocalOcr('x'.repeat(19)), true)
assert.equal(pageNeedsLocalOcr('x'.repeat(20)), false)
assert.equal(pageNeedsLocalOcr('Diese Seite hat bereits eine Textebene und bleibt unangetastet.'), false)

const pages = pdfPagesNeedingOcr([
  { page: 1, text: 'Diese Seite hat bereits eine Textebene und bleibt unangetastet.' },
  { page: 2, text: '' },
  { page: 3, text: 'Scan' },
  ...Array.from({ length: 80 }, (_, index) => ({ page: index + 4, text: '' })),
])
assert.deepEqual(pages.slice(0, 2), [2, 3])
assert.equal(pages.includes(1), false)
assert.equal(pages.length, PDF_OCR_MAX_PAGES)

const blank = new Uint8ClampedArray(80 * 40 * 4)
blank.fill(255)
assert.equal(segmentPdfOcrLines(blank, 80, 40).length, 0)

const paint = (width, height, bars, paper = 255) => {
  const pixels = new Uint8ClampedArray(width * height * 4)
  for (let index = 0; index < pixels.length; index += 4) {
    pixels[index] = paper
    pixels[index + 1] = paper
    pixels[index + 2] = paper
    pixels[index + 3] = 255
  }
  for (const bar of bars) {
    for (let y = bar.y0; y < bar.y1; y += 1) {
      for (let x = bar.x0; x < bar.x1; x += 1) {
        const index = (y * width + x) * 4
        pixels[index] = bar.ink
        pixels[index + 1] = bar.ink
        pixels[index + 2] = bar.ink
      }
    }
  }
  return pixels
}

const lines = segmentPdfOcrLines(paint(80, 48, [
  { y0: 8, y1: 16, x0: 10, x1: 50, ink: 0 },
  { y0: 28, y1: 36, x0: 12, x1: 46, ink: 0 },
]), 80, 48)
assert.equal(lines.length, 2)
for (const line of lines) {
  assert.ok(line.width >= 8 && line.width <= 4096)
  assert.ok(line.height >= 8 && line.height <= 1024)
  assert.equal(line.pixels.length, line.width * line.height * 4)
  assert.ok(line.width < 80)
}

const picture = paint(80, 400, [{ y0: 20, y1: 190, x0: 0, x1: 80, ink: 0 }])
assert.equal(segmentPdfOcrLines(picture, 80, 400).length, 0)

const negative = paint(80, 40, [{ y0: 12, y1: 22, x0: 8, x1: 60, ink: 255 }], 0)
assert.equal(segmentPdfOcrLines(negative, 80, 40).length, 1)
assert.equal(segmentPdfOcrLines(blank, 0, 40).length, 0)
assert.equal(segmentPdfOcrLines(blank.subarray(0, 10), 80, 40).length, 0)

const stamp = pdfByteStamp(Uint8Array.from([1, 2, 3, 4, 5]))
assert.match(stamp, /^[a-f0-9]{8}$/u)
assert.equal(stamp, pdfByteStamp(Uint8Array.from([1, 2, 3, 4, 5])))
assert.notEqual(stamp, pdfByteStamp(Uint8Array.from([1, 2, 3, 4, 6])))

const cache = {
  format: PDF_OCR_FORMAT,
  path: 'scans/brief.pdf',
  size: 1200,
  mtimeMs: 50,
  stamp,
  pages: [{ page: 2, text: 'Hallo aus dem Scan' }],
}
assert.deepEqual(sanitizePdfOcrCache(cache), cache)
assert.equal(sanitizePdfOcrCache({ ...cache, format: 'other' }), null)
assert.equal(sanitizePdfOcrCache({ ...cache, pages: [{ page: 2, text: 'x'.repeat(PDF_OCR_MAX_PAGE_CHARS + 1) }] }), null)
assert.equal(disk.sanitize(cache).path, cache.path)
assert.equal(disk.sanitize({ ...cache, format: 'other' }), null)
assert.equal(pdfOcrCacheUsable(sanitizePdfOcrCache(cache), { size: 1200, stamp }), true)
assert.equal(pdfOcrCacheUsable(sanitizePdfOcrCache(cache), { size: 1201, stamp }), false)

const file = { path: 'scans/brief.pdf', size: 1200, mtimeMs: 50 }
assert.equal(disk.transcriptForFile(JSON.stringify(cache), file), 'Hallo aus dem Scan')
assert.equal(disk.transcriptForFile(JSON.stringify(cache), { ...file, size: 1201 }), '')
assert.equal(disk.transcriptForFile(JSON.stringify(cache), { ...file, mtimeMs: 51 }), '')
assert.equal(disk.transcriptForFile(JSON.stringify({ ...cache, path: 'other.pdf' }), file), '')
assert.equal(disk.sidecarRelative('scans/brief.pdf'), `.fanotes/pdf-ocr/${disk.sidecarName('scans/brief.pdf')}`)
assert.match(disk.sidecarName('scans/brief.pdf'), /^[a-f0-9]{32}\.json$/u)

const hits = pdfTextSearchHits(2, 'Hallo aus dem Scan', 'scan', 5)
assert.equal(hits.length, 1)
assert.equal(hits[0].page, 2)
assert.match(hits[0].excerpt, /Scan/u)

const read = (name) => readFileSync(new URL(name, import.meta.url), 'utf8')
const view = read('../src/components/PdfNoteView.tsx')
const runner = read('../src/lib/pdfOcrRun.ts')
const pageText = read('../src/lib/pdfPageText.ts')
const main = read('../electron/main.cjs')
const browser = read('../src/lib/browserApi.ts')
const surfaces = read('../docs/USER_SURFACES.md')

assert.match(view, /runLocalPdfOcr/)
assert.match(view, /pageNeedsLocalOcr/)
assert.match(view, /Text wird erkannt …/)
assert.match(runner, /pdfPagesNeedingOcr/)
assert.match(runner, /import\('\.\/trocrClient'\)/)
assert.match(runner, /recognizeTrocrLine/)
assert.doesNotMatch(runner, /https?:\/\//)
assert.doesNotMatch(runner, /tesseract|ocrmypdf|pdftotext/i)
assert.match(pageText, /The PDF file itself is not rewritten/)
assert.match(pageText, /pageNeedsLocalOcr/)
assert.match(main, /readPdfOcrTranscript/)
assert.match(main, /pdfOcrStore\.buildDocument/)
assert.match(main, /sidecarRelative/)
assert.match(browser, /readPdfOcr:/)
assert.match(browser, /writePdfOcr:/)
assert.match(surfaces, /export const pageNeedsLocalOcr/)

const writeHandler = main.slice(main.indexOf('handle(IPC.writePdfOcr'), main.indexOf('handle(IPC.search'))
assert.match(writeHandler, /atomicWrite\(destination/)
assert.doesNotMatch(writeHandler, /atomicWrite\(target/)
assert.doesNotMatch(writeHandler, /setting-row/)

console.log('pdf-ocr ok')
