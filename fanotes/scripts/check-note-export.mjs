// Vector export of handwriting notes and annotated PDF notes, and the DOCX wrapper.
// Run: node scripts/check-note-export.mjs [filter]
// Reads every produced PDF back with pdf.js (text, operators) and pdf-lib (graphics states, page count).
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

const appRoot = fileURLToPath(new URL('..', import.meta.url))
const require = createRequire(import.meta.url)
const JSZip = require('jszip')
const sax = require('sax')
const pdfLib = require('pdf-lib')
const pdfjs = await import(path.join(appRoot, 'node_modules/pdfjs-dist/legacy/build/pdf.mjs'))
const filter = process.argv[2] ?? ''
const vite = await createServer({ root: appRoot, appType: 'custom', logLevel: 'error', optimizeDeps: { noDiscovery: true }, server: { middlewareMode: true, hmr: false, ws: false } })
const load = (file) => vite.ssrLoadModule(file)
const results = []
const test = async (name, body) => {
  if (filter && !name.includes(filter)) return
  try {
    await body()
    results.push(['PASS', name])
  } catch (error) {
    results.push(['FAIL', name, error])
  }
}

const loadFont = async (key) => {
  const [dir, file] = key.split('/')
  const base = dir === 'writing' ? path.join(appRoot, 'public/writing/fonts') : path.join(appRoot, 'node_modules/pdfjs-dist/standard_fonts')
  return new Uint8Array(fs.readFileSync(path.join(base, file)))
}
const options = { format: 'pdf', pageSize: 'a4', margins: 'normal', includeTitle: true, pageNumbers: false, paperBackground: false, annotations: true }

const openPdf = async (bytes) => {
  const data = new Uint8Array(bytes)
  return pdfjs.getDocument({ data, useSystemFonts: false, standardFontDataUrl: path.join(appRoot, 'node_modules/pdfjs-dist/standard_fonts/'), verbosity: 0 }).promise
}
const pageText = async (pdf, number) => (await (await pdf.getPage(number)).getTextContent()).items.map((item) => item.str).join('').replace(/\s+/gu, ' ')
/** Counts path painting operators and image paints on a page. */
const opCounts = async (pdf, number) => {
  const list = await (await pdf.getPage(number)).getOperatorList()
  const counts = { stroke: 0, fill: 0, image: 0, constructPath: 0 }
  const paint = (op) => {
    if (op === pdfjs.OPS.stroke || op === pdfjs.OPS.closeStroke || op === pdfjs.OPS.fillStroke) counts.stroke += 1
    if (op === pdfjs.OPS.fill || op === pdfjs.OPS.eoFill || op === pdfjs.OPS.fillStroke) counts.fill += 1
  }
  list.fnArray.forEach((fn, index) => {
    // pdf.js folds the painting operator into the path it paints.
    if (fn === pdfjs.OPS.constructPath) paint(list.argsArray[index][0])
    paint(fn)
    if (fn === pdfjs.OPS.paintImageXObject || fn === pdfjs.OPS.paintInlineImageXObject || fn === pdfjs.OPS.paintImageMaskXObject) counts.image += 1
    if (fn === pdfjs.OPS.constructPath) counts.constructPath += 1
  })
  return counts
}
const wave = (row, rows, points = 60, extra = {}) => ({
  points: Array.from({ length: points }, (_unused, index) => ({ x: 0.1 + index * 0.012, y: row / rows + Math.sin(index / 5) * 0.004, pressure: 0.3 + 0.5 * Math.abs(Math.sin(index / 9)) })),
  baseWidth: 3,
  pressureEnabled: true,
  color: '#1f3a8a',
  ...extra,
})
const baseSheet = (strokes, extra = {}) => ({
  title: 'Test note',
  width: 900,
  height: 2400,
  strokes,
  smoothing: 0.5,
  paper: { style: 'grid', squareMm: 0 },
  fields: [],
  ...extra,
})

await test('stroke outline: pressure widths become stroked path runs with curves', async () => {
  const geometry = await load('/src/lib/noteExport/inkGeometry.ts')
  const res = { gs: () => 'G1', group: () => 'Gr1' }
  const pressure = []
  assert.equal(geometry.emitStroke(pressure, res, wave(10, 100), 900, 1000, 0.5), true)
  const text = pressure.join('\n')
  const widths = [...text.matchAll(/([\d.]+) w/gu)].map((match) => Number(match[1]))
  assert.ok(new Set(widths).size > 3, 'pressure produces several line widths')
  assert.ok(/ c\n/u.test(`${text}\n`) && /\nS/u.test(text), 'smoothed segments are curves and are stroked')
  assert.ok(text.includes('1 J') || text.includes('1 j'), 'round caps and joins like the screen')
  const constant = []
  geometry.emitStroke(constant, res, { ...wave(10, 100), pressureEnabled: false }, 900, 1000, 0.5)
  assert.equal(constant.join('\n').match(/ w\n/gu)?.length ?? 0, 1, 'constant width is one path')
  assert.equal(geometry.parseInkColor('#ff0000')[0], 1)
})

await test('pagination: a stroke over a break is on both pages, strokes clear of it only on one', async () => {
  const { exportInkPdfDetailed } = await load('/src/lib/noteExport/inkPdf.ts')
  const height = 3000
  const at = (y) => y / height
  const strokes = [
    { points: [{ x: 0.1, y: at(100) }, { x: 0.8, y: at(110) }], baseWidth: 3, color: '#1f3a8a' },
    // 800 px tall: longer than the room a cut may move, so the cut has to cross it.
    { points: [{ x: 0.5, y: at(800) }, { x: 0.5, y: at(1700) }], baseWidth: 4, color: '#c62f4a' },
    { points: [{ x: 0.1, y: at(2000) }, { x: 0.8, y: at(2010) }], baseWidth: 3, color: '#1f3a8a' },
  ]
  const result = await exportInkPdfDetailed(baseSheet(strokes, { height }), { ...options, includeTitle: false }, loadFont)
  assert.equal(result.pages.length, 2, `pages ${JSON.stringify(result.pages)}`)
  const pdf = await openPdf(result.bytes)
  assert.equal(pdf.numPages, result.pages.length)
  const counts = [await opCounts(pdf, 1), await opCounts(pdf, 2)]
  assert.equal(counts[0].stroke, 2, 'page 1: the first stroke and the tall one')
  assert.equal(counts[1].stroke, 2, 'page 2: the rest of the tall one and the last stroke')
  const cut = result.pages[0].y1
  assert.ok(cut > 800 && cut < 1700 && cut > 1300, `cut at ${cut} runs through the tall stroke`)
  // A free row within the last quarter of the page is taken instead.
  const free = await exportInkPdfDetailed(baseSheet([strokes[0], { points: [{ x: 0.5, y: at(1200) }, { x: 0.5, y: at(1700) }], baseWidth: 4, color: '#c62f4a' }], { height }), { ...options, includeTitle: false }, loadFont)
  assert.ok(free.pages[0].y1 <= 1200, `cut ${free.pages[0].y1} keeps the stroke whole`)
})

await test('page cuts prefer empty rows', async () => {
  const { planInkPages } = await load('/src/lib/noteExport/inkPdf.ts')
  const rows = new Int32Array(3000).fill(1)
  for (let row = 1100; row < 1130; row += 1) rows[row] = 0
  const pages = planInkPages({ height: 3000, rows, usedBottom: 2500 }, 1280, 1280, false)
  assert.equal(pages[0].y0, 0)
  assert.ok(pages[0].y1 >= 1100 && pages[0].y1 < 1130, `cut ${pages[0].y1}`)
  assert.equal(pages[pages.length - 1].y1, 2500)
  const own = planInkPages({ height: 3000, rows, usedBottom: 2500 }, 1000, 1000, true)
  assert.equal(own[0].y1, 1000)
})

await test('text fields are real selectable text (Unicode, markdown, wrapping)', async () => {
  const { exportInkPdfDetailed } = await load('/src/lib/noteExport/inkPdf.ts')
  const sheet = baseSheet([wave(100, 1000)], {
    fields: [
      { id: 'a', left: 100, top: 300, width: 220, fontSize: 18, text: 'x ≤ 1 α' },
      { id: 'b', left: 100, top: 400, width: 200, fontSize: 16, text: '# Heading\nSome **bold** and *italic* words that must wrap inside the narrow field width.\n- one\n- two' },
    ],
  })
  const result = await exportInkPdfDetailed(sheet, options, loadFont)
  const pdf = await openPdf(result.bytes)
  const text = await pageText(pdf, 1)
  assert.ok(text.includes('x ≤ 1 α'), `extracted: ${text}`)
  assert.ok(text.includes('Heading') && text.includes('bold') && text.includes('italic'), text)
  assert.ok(text.includes('Test note'), 'title is text')
  assert.deepEqual(result.pages[0].fieldIds, ['a', 'b'])
  const doc = await pdfLib.PDFDocument.load(result.bytes)
  assert.equal(doc.getTitle(), 'Test note')
  const lines = (await (await pdf.getPage(1)).getTextContent()).items.filter((item) => item.str.trim())
  const wrapped = lines.filter((item) => /wrap|narrow|words|field/u.test(item.str))
  assert.ok(new Set(wrapped.map((item) => Math.round(item.transform[5]))).size >= 2, 'long text wraps to several lines')
  const ink = await opCounts(pdf, 1)
  assert.equal(ink.image, 0, 'no raster images')
})

await test('highlighter uses a constant-alpha graphics state with Multiply', async () => {
  const { exportInkPdfDetailed } = await load('/src/lib/noteExport/inkPdf.ts')
  const marker = { points: [{ x: 0.1, y: 0.1 }, { x: 0.8, y: 0.1 }], baseWidth: 22, color: '#ffe600', purpose: 'art', brush: 'highlighter', opacity: 1 }
  const result = await exportInkPdfDetailed(baseSheet([marker, wave(300, 1000)]), options, loadFont)
  const doc = await pdfLib.PDFDocument.load(result.bytes)
  const states = []
  const resources = doc.getPage(0).node.Resources()
  const extGState = resources.lookup(pdfLib.PDFName.of('ExtGState'), pdfLib.PDFDict)
  for (const key of extGState.keys()) {
    const dict = extGState.lookup(key, pdfLib.PDFDict)
    states.push({ CA: dict.lookup(pdfLib.PDFName.of('CA'))?.asNumber(), BM: dict.lookup(pdfLib.PDFName.of('BM'))?.toString() })
  }
  assert.ok(states.some((state) => Math.abs(state.CA - 0.34) < 0.001 && state.BM === '/Multiply'), JSON.stringify(states))
  // A pressure marker is one transparency group composited once.
  const pressureMarker = { ...marker, pressureEnabled: true, points: Array.from({ length: 30 }, (_u, i) => ({ x: 0.1 + i * 0.02, y: 0.2, pressure: 0.3 + (i % 5) * 0.1 })) }
  const second = await exportInkPdfDetailed(baseSheet([pressureMarker]), options, loadFont)
  const loaded = await pdfLib.PDFDocument.load(second.bytes)
  const xobjects = loaded.getPage(0).node.Resources().lookup(pdfLib.PDFName.of('XObject'), pdfLib.PDFDict)
  const group = xobjects.lookup(xobjects.keys()[0])
  assert.equal(group.dict.lookup(pdfLib.PDFName.of('Group'), pdfLib.PDFDict).lookup(pdfLib.PDFName.of('S')).toString(), '/Transparency')
})

await test('pictures are embedded as PNG, paper background as vector lines', async () => {
  const { exportInkPdfDetailed } = await load('/src/lib/noteExport/inkPdf.ts')
  const png = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'))
  const sheet = baseSheet([], { images: [{ x: 100, y: 100, width: 200, height: 150, bytes: png, mime: 'image/png' }] })
  const result = await exportInkPdfDetailed(sheet, { ...options, paperBackground: true }, loadFont)
  const pdf = await openPdf(result.bytes)
  const counts = await opCounts(pdf, 1)
  assert.equal(counts.image, 1)
  assert.ok(counts.stroke >= 1, 'ruling is stroked lines')
  const plain = await exportInkPdfDetailed(sheet, options, loadFont)
  assert.ok((await opCounts(await openPdf(plain.bytes), 1)).stroke === 0, 'no ruling without the option')
})

const buildTwoPagePdf = async () => {
  const doc = await pdfLib.PDFDocument.create()
  const font = await doc.embedFont(pdfLib.StandardFonts.Helvetica)
  for (const label of ['First page text', 'Second page text']) {
    const page = doc.addPage([600, 800])
    page.drawText(label, { x: 60, y: 700, size: 24, font })
  }
  return new Uint8Array(await doc.save())
}

await test('annotated PDF note: original pages and text stay, ink lands on the marked page', async () => {
  const { exportAnnotatedPdfNote, exportAnnotatedPdfNoteDetailed } = await load('/src/lib/noteExport/pdfNote.ts')
  const original = await buildTwoPagePdf()
  // Paper 600 x 1616: page 1 at top 0, page 2 at top 816 (16 px gap).
  const snapshot = {
    paperWidth: 600,
    paperHeight: 1632,
    smoothing: 0.5,
    strokes: [{ points: [{ x: 0.2, y: (816 + 200) / 1632 }, { x: 0.8, y: (816 + 220) / 1632 }, { x: 0.5, y: (816 + 300) / 1632 }], baseWidth: 4, color: '#c62f4a' }],
    pages: [
      { page: 1, side: false, left: 0, top: 0, width: 600, height: 800, rotation: 0 },
      { page: 2, side: false, left: 0, top: 816, width: 600, height: 800, rotation: 0 },
    ],
    fields: [{ id: 'f', page: 2, left: 60, top: 816 + 400, width: 300, fontSize: 18, text: 'Margin note ≤ α', color: '#1f8a5b' }],
  }
  const marks = [{ id: 'm', page: 1, quote: 'First page text', kind: 'highlight' }]
  const pageText2 = async (number) => {
    const page = await (await openPdf(original)).getPage(number)
    const content = await page.getTextContent()
    return content.items.map((item) => ({ str: item.str, transform: item.transform, width: item.width, height: item.height }))
  }
  const bytes = await exportAnnotatedPdfNote({ original, snapshot, marks, pageText: pageText2, loadFont })
  const pdf = await openPdf(bytes)
  assert.equal(pdf.numPages, 2)
  assert.ok((await pageText(pdf, 1)).includes('First page text'), 'original text still selectable')
  assert.ok((await pageText(pdf, 2)).includes('Second page text'))
  assert.ok((await pageText(pdf, 2)).includes('Margin note ≤ α'), 'text box text')
  const one = await opCounts(pdf, 1)
  const two = await opCounts(pdf, 2)
  assert.ok(two.stroke >= 1, 'ink on page 2')
  assert.equal(one.stroke, 0, 'no ink on page 1')
  assert.ok(one.fill >= 1, 'highlight fill on page 1')
  // Ink at the right place: the stroke's first point is 200 px below the top of page 2.
  const doc = await pdfLib.PDFDocument.load(bytes)
  assert.equal(doc.getPageCount(), 2)
  // Side pages: an extra page after their PDF page.
  const withSide = await exportAnnotatedPdfNoteDetailed({
    original,
    snapshot: { ...snapshot, pages: [...snapshot.pages, { page: 1, side: true, left: 0, top: 1700, width: 600, height: 800, rotation: 0 }], paperHeight: 2600, strokes: [{ points: [{ x: 0.3, y: 1900 / 2600 }, { x: 0.6, y: 2000 / 2600 }], baseWidth: 3, color: '#000000' }], fields: [] },
    marks: [],
    loadFont,
  })
  assert.equal((await pdfLib.PDFDocument.load(withSide.bytes)).getPageCount(), 3)
  assert.deepEqual(withSide.pages, [{ page: 1, side: false }, { page: 1, side: true }, { page: 2, side: false }])
  // Original without marks is returned as a valid PDF with the same pages.
  const clean = await exportAnnotatedPdfNote({ original, snapshot: null, marks: [], loadFont })
  assert.equal((await pdfLib.PDFDocument.load(clean)).getPageCount(), 2)
})

await test('annotated PDF note: rotated and cropped pages map ink onto the crop box', async () => {
  const { exportAnnotatedPdfNote } = await load('/src/lib/noteExport/pdfNote.ts')
  const doc = await pdfLib.PDFDocument.create()
  const page = doc.addPage([600, 800])
  page.setCropBox(100, 100, 400, 600)
  const original = new Uint8Array(await doc.save())
  const snapshot = {
    paperWidth: 400,
    paperHeight: 600,
    smoothing: 0,
    strokes: [{ points: [{ x: 0.1, y: 0.1 }, { x: 0.9, y: 0.1 }], baseWidth: 2, color: '#000000' }],
    pages: [{ page: 1, side: false, left: 0, top: 0, width: 400, height: 600, rotation: 0 }],
    fields: [],
  }
  const bytes = await exportAnnotatedPdfNote({ original, snapshot, marks: [], loadFont })
  const pdfDoc = await pdfLib.PDFDocument.load(bytes)
  const contents = pdfDoc.getPage(0).node.Contents()
  const streams = contents.asArray().map((ref) => pdfDoc.context.lookup(ref))
  const decoded = streams.map((stream) => Buffer.from(pdfLib.decodePDFRawStream(stream).decode()).toString('latin1')).join('\n')
  // Paper px -> crop box: scale 1, origin at the crop box's top-left (100, 700).
  assert.match(decoded, /1 0 0 -1 100 700 cm/u)
})

await test('docx: zip structure, well-formed XML, one picture page per page, text fields as paragraphs', async () => {
  const { exportInkDocx } = await load('/src/lib/noteExport/inkDocx.ts')
  const png = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'))
  const bytes = await exportInkDocx([
    { png, widthPt: 595.28, heightPt: 841.89, fields: ['# Titel\nErste **fette** Zeile ≤ α\n- Punkt', 'Zweites Feld'] },
    { png, widthPt: 595.28, heightPt: 841.89, fields: [] },
  ], { margins: 'normal' }, 'Notiz & <Test>')
  const zip = await JSZip.loadAsync(bytes)
  for (const name of ['[Content_Types].xml', '_rels/.rels', 'word/document.xml', 'word/_rels/document.xml.rels', 'word/styles.xml', 'docProps/core.xml', 'word/media/page1.png', 'word/media/page2.png']) {
    assert.ok(zip.file(name), `${name} present`)
  }
  for (const name of ['[Content_Types].xml', '_rels/.rels', 'word/document.xml', 'word/_rels/document.xml.rels', 'word/styles.xml', 'docProps/core.xml', 'docProps/app.xml']) {
    const xml = await zip.file(name).async('string')
    const parser = sax.parser(true)
    parser.onerror = (error) => { throw new Error(`${name}: ${error.message.split('\n')[0]}`) }
    parser.write(xml).close()
  }
  const documentXml = await zip.file('word/document.xml').async('string')
  assert.equal(documentXml.match(/<w:drawing>/gu).length, 2)
  assert.ok(documentXml.includes('Textfelder') && documentXml.includes('fette') && documentXml.includes('≤ α'))
  assert.ok((documentXml.match(/<w:pgSz w:w="11906" w:h="16838"\/>/gu)?.length ?? 0) >= 2, 'A4 page size in twips')
  assert.ok(documentXml.includes('r:embed="rIdImg2"'))
  assert.ok((await zip.file('docProps/core.xml').async('string')).includes('Notiz &amp; &lt;Test&gt;'))
  const rels = await zip.file('word/_rels/document.xml.rels').async('string')
  assert.ok(rels.includes('media/page2.png'))
})

await test('performance: 300k points export in seconds and far smaller than a raster page', async () => {
  const { exportInkPdfDetailed } = await load('/src/lib/noteExport/inkPdf.ts')
  const strokes = []
  for (let row = 0; row < 600; row += 1) {
    strokes.push({
      points: Array.from({ length: 500 }, (_unused, index) => ({ x: 0.05 + index * 0.0018, y: 0.01 + (row / 600) * 0.97 + Math.sin(index / 7 + row) * 0.0016, pressure: 0.25 + 0.6 * Math.abs(Math.sin(index / 23 + row)) })),
      baseWidth: 3,
      pressureEnabled: true,
      color: '#1f3a8a',
    })
  }
  const started = performance.now()
  const result = await exportInkPdfDetailed(baseSheet(strokes, { height: 12000 }), options, loadFont)
  const ms = performance.now() - started
  console.log(`  300k points: ${Math.round(ms)} ms, ${(result.bytes.length / 1024).toFixed(0)} KB, ${result.pages.length} pages`)
  assert.ok(ms < 8000, `${ms} ms`)
  assert.ok(result.bytes.length < 12 * 1024 * 1024, `${result.bytes.length} bytes`)
})

let failed = 0
for (const [status, name, error] of results) {
  console.log(`${status} ${name}`)
  if (status === 'FAIL') {
    failed += 1
    console.log(`  ${error?.stack ?? error}`)
  }
}
await vite.close()
if (failed) {
  console.log(`${failed} failed`)
  process.exit(1)
}
console.log(`${results.length} passed`)
process.exit(0)
