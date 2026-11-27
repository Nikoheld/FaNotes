import assert from 'node:assert/strict'
import { PDFDocument } from 'pdf-lib'
import { movePage, buildPdfWithPages } from '../src/lib/pdfPageOrder.ts'

assert.deepEqual(movePage([1, 2, 3, 4], 0, 2), [2, 3, 1, 4])
assert.deepEqual(movePage([1, 2, 3], 2, 0), [3, 1, 2])
assert.deepEqual(movePage([1, 2], 0, 5), [1, 2])

const source = await PDFDocument.create()
for (const width of [100, 200, 300, 400]) source.addPage([width, 50])
const bytes = await source.save()
const out = await PDFDocument.load(await buildPdfWithPages(bytes, [3, 1]))
assert.equal(out.getPageCount(), 2)
assert.deepEqual(out.getPages().map((page) => page.getWidth()), [300, 100])
await assert.rejects(() => buildPdfWithPages(bytes, []))
await assert.rejects(() => buildPdfWithPages(bytes, [9]))
console.log('pdf page order: ok')
