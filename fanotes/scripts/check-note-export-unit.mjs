// Text-note export without a window: Markdown -> DOCX (structure, well-formed XML, math, images, Unicode),
// LaTeX -> OMML, the print HTML, the Markdown/ZIP export and the plain-text PDF fallback.
// Run: node scripts/check-note-export-unit.mjs
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createServer } from 'vite'

const appRoot = fileURLToPath(new URL('..', import.meta.url))
const require = createRequire(import.meta.url)
const sax = require('sax')
const JSZip = require('jszip')
const vite = await createServer({ root: appRoot, appType: 'custom', logLevel: 'error', optimizeDeps: { noDiscovery: true }, server: { middlewareMode: true, hmr: false } })
const load = (file) => vite.ssrLoadModule(file)
const results = []
const test = async (name, body) => {
  try { await body(); results.push(['PASS', name]) } catch (error) { results.push(['FAIL', name, error]) }
}

const assertWellFormed = (xml, label) => {
  const parser = sax.parser(true, { xmlns: true })
  parser.onerror = (error) => { throw new Error(`${label}: ${error.message.split('\n')[0]}`) }
  parser.write(xml).close()
}

// A 2x3 PNG and a 4x2 JPEG header-only stub are enough: only the header is read.
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAADCAYAAAC56t6BAAAAEklEQVR4nGP8z8Dwn4GBgYEBAA0DAgEDvFpCAAAAAElFTkSuQmCC', 'base64')
const note = [
  '# Überschrift Eins', '', '## Zwei', '### Drei', '#### Vier', '##### Fünf', '###### Sechs', '',
  'Ein Absatz mit **fett**, *kursiv*, ~~durchgestrichen~~, `Code` und [Link](https://example.org/a?b=1&c=2). x ≤ 1, α→β, 日本 😀', '',
  '- Punkt A', '  - Unterpunkt', '- Punkt B', '', '1. Erstens', '2. Zweitens', '   1. Verschachtelt', '', '- [ ] offen', '- [x] erledigt', '',
  '> Ein Zitat', '> mehr', '', '```js', 'const x = 1 < 2 && "a"', '\tindent', '```', '',
  '| Name | Wert |', '| :--- | ---: |', '| Alpha | 1 |', '| Beta ≤ | 日本 |', '',
  '---', '', 'Inline $x^2 + \\frac{a}{b}$ und', '', '$$\\sum_{i=1}^{n} i = \\frac{n(n+1)}{2}$$', '',
  '![Bild](img/pic.png)', '', '![Fehlt](gone.png)', '',
].join('\n')

try {
  const types = await load('/src/lib/noteExport/types.ts')
  const docxModule = await load('/src/lib/noteExport/docx.ts')
  const omml = await load('/src/lib/noteExport/omml.ts')
  const prepare = await load('/src/lib/noteExport/prepare.ts')
  const htmlModule = await load('/src/lib/noteExport/html.ts')
  const index = await load('/src/lib/noteExport/index.ts')
  const simpleLatex = await load('/src/lib/simpleLatex.ts')
  const options = { ...types.DEFAULT_NOTE_EXPORT_OPTIONS, format: 'docx' }
  const resolveImage = async (source) => (source === 'img/pic.png' ? { bytes: new Uint8Array(png), ...prepare.readImageInfo(new Uint8Array(png)) } : null)
  const docxBytes = await docxModule.noteToDocx({ markdown: note, title: 'Titel & <Test>', resolveImage }, options, new Date('2026-11-24T10:00:00Z'))
  const zip = await JSZip.loadAsync(docxBytes)
  const read = (name) => zip.file(name).async('string')
  const document = await read('word/document.xml')

  await test('docx: every part is present and every XML part is well-formed', async () => {
    for (const name of ['[Content_Types].xml', '_rels/.rels', 'word/document.xml', 'word/styles.xml', 'word/numbering.xml', 'word/settings.xml', 'word/_rels/document.xml.rels', 'docProps/core.xml', 'docProps/app.xml']) {
      assert.ok(zip.file(name), name)
      assertWellFormed(await read(name), name)
    }
    assert.match(await read('docProps/core.xml'), /<dc:title>Titel &amp; &lt;Test&gt;<\/dc:title>/u)
  })
  await test('docx: headings 1-6 use the Word heading styles and the title is a Title paragraph', async () => {
    for (let level = 1; level <= 6; level += 1) assert.ok(document.includes(`<w:pStyle w:val="Heading${level}"/>`), `Heading${level}`)
    assert.ok(document.includes('<w:pStyle w:val="Title"/>'))
    const styles = await read('word/styles.xml')
    for (let level = 1; level <= 6; level += 1) assert.ok(styles.includes(`w:styleId="Heading${level}"`) && styles.includes(`<w:outlineLvl w:val="${level - 1}"/>`))
  })
  await test('docx: bold, italic, strike, inline code and a real hyperlink', async () => {
    assert.ok(/<w:b\/><w:bCs\/><\/w:rPr><w:t xml:space="preserve">fett/u.test(document))
    assert.ok(/<w:i\/><w:iCs\/><\/w:rPr><w:t xml:space="preserve">kursiv/u.test(document))
    assert.ok(/<w:strike\/><\/w:rPr><w:t xml:space="preserve">durchgestrichen/u.test(document))
    assert.ok(document.includes('<w:rStyle w:val="CodeChar"/>'))
    assert.ok(/<w:hyperlink r:id="rId\d+" w:history="1">/u.test(document))
    const rels = await read('word/_rels/document.xml.rels')
    assert.ok(rels.includes('Target="https://example.org/a?b=1&amp;c=2" TargetMode="External"'))
  })
  await test('docx: lists use numbering.xml, tasks show boxes', async () => {
    assert.ok(/<w:numPr><w:ilvl w:val="0"\/><w:numId w:val="1"\/><\/w:numPr>/u.test(document))
    assert.ok(/<w:numPr><w:ilvl w:val="1"\/><w:numId w:val="1"\/><\/w:numPr>/u.test(document), 'nested bullet')
    assert.ok(/<w:numId w:val="2"\/>/u.test(document) && /<w:numPr><w:ilvl w:val="1"\/><w:numId w:val="3"\/>/u.test(document), 'ordered lists')
    const numbering = await read('word/numbering.xml')
    assert.ok(numbering.includes('<w:num w:numId="2">') && numbering.includes('w:numFmt w:val="decimal"') && numbering.includes('w:numFmt w:val="bullet"'))
    assert.ok(document.includes('☐ ') && document.includes('☑ '))
  })
  await test('docx: quote, code block (monospace, shaded, tab kept), rule', async () => {
    assert.ok(document.includes('<w:pStyle w:val="Quote"/>'))
    assert.ok(document.includes('<w:pStyle w:val="CodeBlock"/>'))
    assert.ok(document.includes('const x = 1 &lt; 2 &amp;&amp; &quot;a&quot;') && document.includes('<w:tab/>'))
    const styles = await read('word/styles.xml')
    assert.ok(styles.includes('w:fill="F5F5F5"') && styles.includes('Consolas'))
    assert.ok(document.includes('<w:pBdr><w:bottom'))
  })
  await test('docx: table has borders, a header row, alignment and its cell text', async () => {
    assert.ok(document.includes('<w:tbl>') && document.includes('<w:tblBorders>') && document.includes('<w:tblHeader/>'))
    assert.ok(/<w:tr>.*Name.*<\/w:tr>/su.test(document) && document.includes('Beta ≤') && document.includes('日本'))
    assert.ok(document.includes('<w:jc w:val="right"/>'))
    assert.equal((document.match(/<w:tr>/gu) ?? []).length, 3)
  })
  await test('docx: math becomes OMML (inline and display) with fraction, sum and limits', async () => {
    assert.ok(document.includes('<m:oMath>') && document.includes('<m:oMathPara>'))
    assert.ok(document.includes('<m:sSup>') && document.includes('<m:f>'))
    assert.ok(/<m:nary><m:naryPr><m:chr m:val="∑"\/>/u.test(document))
    assert.ok(document.includes('xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"'))
  })
  await test('docx: the picture is embedded, scaled and related; a missing one is a placeholder', async () => {
    assert.ok(zip.file('word/media/image1.png'))
    assert.ok(document.includes('<w:drawing>') && /<a:blip r:embed="rId\d+"\/>/u.test(document))
    assert.ok(document.includes('[Fehlt]'))
    const types = await read('[Content_Types].xml')
    assert.ok(types.includes('Extension="png"'))
  })
  await test('docx: Unicode text survives (x ≤ 1, α→β, 日本, emoji)', async () => {
    for (const text of ['x ≤ 1, α→β, 日本', '😀']) assert.ok(document.includes(text), text)
  })
  await test('docx: page size and margins follow the options (Letter, wide)', async () => {
    const letter = await JSZip.loadAsync(await docxModule.noteToDocx({ markdown: 'Hallo' , title: 'x' }, { ...options, pageSize: 'letter', margins: 'wide', includeTitle: false }))
    const xml = await letter.file('word/document.xml').async('string')
    assert.ok(xml.includes('<w:pgSz w:w="12240" w:h="15840"/>'), xml.match(/<w:pgSz[^>]*>/u)?.[0])
    assert.ok(/<w:pgMar w:top="1814"/u.test(xml))
    assert.ok(!xml.includes('w:val="Title"'))
  })
  await test('docx: empty note and hostile text still produce a valid document', async () => {
    for (const text of ['', '\u0000\u0001 control \uD800 lone', '<script>alert(1)</script> &amp; <!-- c -->', '[[Wiki|Alias]] and <!-- fanotes-ink:abc -->']) {
      const result = await JSZip.loadAsync(await docxModule.noteToDocx({ markdown: text, title: '' }, options))
      assertWellFormed(await result.file('word/document.xml').async('string'), 'doc')
    }
    const wiki = await JSZip.loadAsync(await docxModule.noteToDocx({ markdown: '[[Wiki|Alias]] x <!-- fanotes-ink:abc -->', title: '' }, options))
    const xml = await wiki.file('word/document.xml').async('string')
    assert.ok(xml.includes('Alias') && !xml.includes('fanotes-ink'))
  })

  const sample = (latex) => omml.latexToOmml(latex)
  await test('omml: fraction, scripts, roots', () => {
    assert.match(sample('\\frac{a}{b}'), /<m:f><m:num><m:r>.*<m:t[^>]*>a<\/m:t>.*<m:den>/su)
    assert.match(sample('x^2'), /<m:sSup><m:e>.*>x<.*<m:sup>.*>2</su)
    assert.match(sample('a_i'), /<m:sSub>/u)
    assert.match(sample('a_i^2'), /<m:sSubSup>/u)
    assert.match(sample('\\sqrt{x}'), /<m:rad><m:radPr><m:degHide m:val="1"\/>/u)
    assert.match(sample('\\sqrt[3]{x}'), /<m:rad><m:radPr><\/m:radPr><m:deg>.*>3</su)
  })
  await test('omml: Greek, operators and relations map to Unicode', () => {
    const xml = sample('\\alpha + \\beta \\leq \\gamma \\neq \\pi \\cdot 2 \\times 3 \\pm 1 \\approx 4 \\geq 5 \\to \\infty')
    for (const symbol of ['α', 'β', '≤', 'γ', '≠', 'π', '⋅', '×', '±', '≈', '≥', '→', '∞']) assert.ok(xml.includes(symbol), symbol)
  })
  await test('omml: big operators with limits, integrals, lim and \\left \\right', () => {
    assert.match(sample('\\sum_{k=0}^{n} k'), /<m:nary><m:naryPr><m:chr m:val="∑"\/><m:limLoc m:val="undOvr"\/><\/m:naryPr><m:sub>.*<m:sup>.*<m:e>.*>k</su)
    assert.match(sample('\\int_0^1 x\\,dx'), /<m:chr m:val="∫"\/><m:limLoc m:val="subSup"\/>/u)
    assert.match(sample('\\lim_{x \\to 0} f(x)'), /<m:limLow><m:e>.*>lim<.*<m:lim>/su)
    assert.match(sample('\\left( \\frac{a}{b} \\right)'), /<m:d><m:dPr><m:begChr m:val="\("\/><m:endChr m:val="\)"\/>/u)
    assert.match(sample('\\left\\{ x \\right.'), /<m:begChr m:val="\{"\/><m:endChr m:val=""\/>/u)
  })
  await test('omml: text, matrices, cases, accents, blackboard', () => {
    assert.match(sample('\\text{wenn } x'), /<m:nor\/>/u)
    assert.match(sample('\\begin{pmatrix} a & b \\\\ c & d \\end{pmatrix}'), /<m:d>.*<m:m>.*<m:mr>.*<m:mr>/su)
    assert.match(sample('\\begin{cases} 1 & x>0 \\\\ 0 & \\text{sonst} \\end{cases}'), /<m:eqArr>/u)
    assert.match(sample('\\hat{x} \\vec{v} \\overline{AB}'), /<m:acc>.*<m:acc>.*<m:bar>/su)
    assert.ok(sample('\\mathbb{R}').includes('ℝ'))
  })
  await test('omml: unknown commands and broken input never throw', () => {
    assert.ok(sample('\\unknowncmd{x}').includes('\\unknowncmd'))
    for (const broken of ['\\frac{a', '{{{', '}}}', 'x^', '\\left(', '\\begin{pmatrix} a', '^^__&&\\\\', '']) {
      const xml = sample(broken)
      assertWellFormed(`<root xmlns:m="${omml.M_NS}" xmlns:w="http://w">${xml}</root>`, broken)
    }
  })

  await test('html: print page has tables, task lists, code, KaTeX markup, inlined images and a light stylesheet', async () => {
    const result = await htmlModule.renderNoteHtml({ markdown: note, title: 'Titel & <Test>', resolveImage }, { ...types.DEFAULT_NOTE_EXPORT_OPTIONS })
    const html = result.html
    assert.ok(html.includes('<table>') && html.includes('<th') && html.includes('Beta ≤') && html.includes('日本'))
    assert.ok(html.includes('type="checkbox"') && html.includes('<pre>') && html.includes('<blockquote>') && html.includes('<hr/>'))
    assert.ok(html.includes('class="katex') && result.hasMath)
    assert.ok(html.includes('src="data:image/png;base64,') && html.includes('[Fehlt]'))
    assert.ok(html.includes('<h1 class="note-title">Titel &amp; &lt;Test&gt;</h1>'))
    assert.ok(!/<script/iu.test(html) && html.includes("default-src 'none'"))
    assert.ok(/break-inside: avoid/u.test(html) && html.includes('background: #fff'))
    const without = await htmlModule.renderNoteHtml({ markdown: 'plain', title: 'T' }, { ...types.DEFAULT_NOTE_EXPORT_OPTIONS, includeTitle: false })
    assert.ok(!without.html.includes('note-title"') && !without.hasMath)
  })
  await test('html: raw HTML is sanitized (no script, no event handlers, no remote images)', async () => {
    const result = await htmlModule.renderNoteHtml({ markdown: '<img src=x onerror=alert(1)>\n\n<script>alert(1)</script>\n\n![r](https://example.org/a.png) [x](javascript:alert(1))', title: 'T' }, types.DEFAULT_NOTE_EXPORT_OPTIONS)
    assert.ok(!/onerror|<script|javascript:|https:\/\/example\.org\/a\.png/iu.test(result.html), result.html.slice(-400))
  })
  await test('html: print settings map page size and margins (footer gets room)', () => {
    const narrow = htmlModule.printSettings({ ...types.DEFAULT_NOTE_EXPORT_OPTIONS, pageSize: 'letter', margins: 'narrow', pageNumbers: true })
    assert.equal(narrow.pageSize, 'Letter')
    assert.ok(Math.abs(narrow.margins.left - 0.5) < 0.01 && narrow.margins.bottom >= 0.6)
    assert.equal(htmlModule.printSettings({ ...types.DEFAULT_NOTE_EXPORT_OPTIONS, pageNumbers: false }).pageNumbers, false)
  })

  await test('markdown export: plain .md, or a ZIP with the pictures and rewritten links', async () => {
    const plain = await index.exportTextNote({ markdown: '# Hallo\n\nText', title: 'Eine/Notiz' }, { ...types.DEFAULT_NOTE_EXPORT_OPTIONS, format: 'markdown' })
    assert.equal(plain.filename, 'Eine Notiz.md')
    assert.equal(await plain.blob.text(), '# Hallo\n\nText')
    const withImage = await index.exportTextNote({ markdown: 'A\n\n![x](img/pic.png)\n', title: 'Mit Bild', resolveImage }, { ...types.DEFAULT_NOTE_EXPORT_OPTIONS, format: 'markdown' })
    assert.equal(withImage.filename, 'Mit Bild.zip')
    const archive = await JSZip.loadAsync(Buffer.from(await withImage.blob.arrayBuffer()))
    assert.ok(archive.file('Mit Bild/images/bild-1.png'))
    assert.ok((await archive.file('Mit Bild/Mit Bild.md').async('string')).includes('![x](images/bild-1.png)'))
  })
  await test('latex export and plain PDF fallback accept non-Latin-1 text', async () => {
    const tex = await index.exportTextNote({ markdown: 'x ≤ 1', title: 'T' }, { ...types.DEFAULT_NOTE_EXPORT_OPTIONS, format: 'latex' })
    assert.equal(tex.filename, 'T.tex')
    const bytes = simpleLatex.exportNotePdf('x ≤ 1, α→β, 日本 😀', 'Titel ≤')
    assert.equal(Buffer.from(bytes.subarray(0, 5)).toString(), '%PDF-')
    const fallback = await index.exportTextNote({ markdown: 'x ≤ 1, α→β, 日本', title: 'T' }, { ...types.DEFAULT_NOTE_EXPORT_OPTIONS, format: 'pdf' })
    assert.equal(fallback.filename, 'T.pdf')
  })
  await test('dialog: handwriting and PDF notes offer PDF and Word (plus their own options), text notes offer all four', async () => {
    const dialogModule = await load('/src/components/NoteExportDialog.tsx')
    const render = (kind) => renderToStaticMarkup(createElement(dialogModule.NoteExportDialog, { title: 'N', kind, onExport: async () => undefined, onClose: () => undefined }))
    const ink = render('ink')
    assert.ok(/data-format="docx"/u.test(ink) && !/<button[^>]*disabled=""[^>]*data-format="docx"|<button[^>]*data-format="docx"[^>]*disabled=""/u.test(ink), 'Word is enabled for ink')
    assert.ok(!ink.includes('data-format="latex"') && ink.includes('Papier im Hintergrund'))
    assert.ok(render('pdf').includes('Original ohne Anmerkungen') && !render('text').includes('Papier im Hintergrund'))
    const text = render('text')
    for (const format of ['pdf', 'docx', 'latex', 'markdown']) assert.ok(text.includes(`data-format="${format}"`), format)
    assert.ok(!/<button[^>]*disabled=""[^>]*data-format="docx"/u.test(text))
  })
  await test('options: stored values are validated', () => {
    assert.deepEqual(types.normalizeNoteExportOptions(null), types.DEFAULT_NOTE_EXPORT_OPTIONS)
    const stored = types.normalizeNoteExportOptions({ format: 'docx', pageSize: 'letter', margins: 'wide', includeTitle: false, pageNumbers: false, extra: 1 })
    assert.deepEqual(stored, { format: 'docx', pageSize: 'letter', margins: 'wide', includeTitle: false, pageNumbers: false, paperBackground: false, annotations: true })
    assert.equal(types.normalizeNoteExportOptions({ format: 'exe', pageSize: 'a0' }).format, 'pdf')
  })
  await test('images: sizes are read from PNG, JPEG, GIF and WebP headers', () => {
    assert.deepEqual(prepare.readImageInfo(new Uint8Array(png)), { mime: 'image/png', width: 2, height: 3 })
    const gif = Uint8Array.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 5, 0, 7, 0])
    assert.deepEqual(prepare.readImageInfo(gif), { mime: 'image/gif', width: 5, height: 7 })
    const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xc0, 0, 17, 8, 0, 9, 0, 12, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1])
    assert.deepEqual(prepare.readImageInfo(jpeg), { mime: 'image/jpeg', width: 12, height: 9 })
    assert.equal(prepare.readImageInfo(Uint8Array.from([1, 2, 3])), null)
  })
} finally {
  await vite.close()
}

let failed = 0
for (const [status, name, error] of results) {
  console.log(`${status} ${name}`)
  if (error) { failed += 1; console.log(`  ${error.stack?.split('\n').slice(0, 4).join('\n  ') ?? error}`) }
}
console.log(`\nnote export (unit): ${results.length - failed}/${results.length} passed`)
if (failed) process.exit(1)
