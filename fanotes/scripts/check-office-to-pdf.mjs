// Word / PowerPoint files in the sidebar, converted to FaNotes PDF notes.
// Part 1 (node only): synthetic docx/pptx packages, the zip reader and its caps (zip bombs), the HTML renderers,
//   engine selection, the PowerShell (COM) and soffice command building, a fake soffice that really gets spawned,
//   and the `officeSource` field of the .famd.
// Part 2 (Electron, no built app): the built-in fallback prints real PDFs: one page per slide at the slide size,
//   the docx text is in the PDF.
// Part 3 (the real desktop app under Xvfb, needs `vite build`, xvfb-run and playwright-core via PLAYWRIGHT_CORE):
//   listing, `~$` files hidden, open = convert + open, reuse, changed-original notice, name collision, oversized and
//   zip-bomb files, link surviving a restart.
// Parts 2 and 3 run only with FANOTES_OFFICE_DESKTOP=1 (`npm run check:office-to-pdf-desktop`; the fast-check runner
// does not set it, so `npm run check:fast` stays free of Electron). FANOTES_SKIP_BROWSER=1 skips them even then.
// Everything is synthetic and lives in a temp dir.
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { fileURLToPath } from 'node:url'
import JSZip from 'jszip'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const engines = require('../electron/office-engines.cjs')
const { readZip, OfficeZipError } = require('../electron/office-zip.cjs')
const { docxToHtml } = require('../electron/office-docx-html.cjs')
const { pptxToHtml } = require('../electron/office-pptx-html.cjs')
const convert = require('../electron/office-convert.cjs')
const famdMain = require('../electron/famd.cjs')

const temporary = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'fanotes-office-'))
process.on('exit', () => { if (process.env.OFFICE_KEEP === '1') return; try { fs.rmSync(temporary, { recursive: true, force: true }) } catch { /* best effort */ } })

// ---- synthetic Office files ---------------------------------------------------------------------------------------

const png = (width, height, [r, g, b]) => {
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data])
    const out = Buffer.alloc(body.length + 8)
    out.writeUInt32BE(data.length, 0)
    body.copy(out, 4)
    out.writeUInt32BE(zlib.crc32(body) >>> 0, body.length + 4)
    return out
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8
  header[9] = 2
  const rows = Buffer.alloc((width * 3 + 1) * height)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) { const at = y * (width * 3 + 1) + 1 + x * 3; rows[at] = r; rows[at + 1] = g; rows[at + 2] = b }
  }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(rows)), chunk('IEND', Buffer.alloc(0))])
}

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"'
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const rels = (items) => `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${items.map(([id, type, target]) => `<Relationship Id="${id}" Type="${REL}/${type}" Target="${target}"/>`).join('')}</Relationships>`
const contentTypes = '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/></Types>'

export async function makeDocx({ title = 'Testbericht', lines = ['Erster Absatz mit Umlauten: äöü ß.', 'Zweiter Absatz.'], pages = 1 } = {}) {
  const zip = new JSZip()
  zip.file('[Content_Types].xml', contentTypes)
  zip.file('_rels/.rels', rels([['rId1', 'officeDocument', 'word/document.xml']]))
  zip.file('word/_rels/document.xml.rels', rels([['rId1', 'image', 'media/image1.png'], ['rId2', 'styles', 'styles.xml'], ['rId3', 'numbering', 'numbering.xml']]))
  zip.file('word/media/image1.png', png(40, 20, [200, 30, 30]))
  zip.file('word/styles.xml', `<?xml version="1.0"?><w:styles ${W}><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri"/><w:sz w:val="22"/></w:rPr></w:rPrDefault></w:docDefaults><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:rPr><w:b/><w:sz w:val="40"/></w:rPr></w:style></w:styles>`)
  zip.file('word/numbering.xml', `<?xml version="1.0"?><w:numbering ${W}><w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="o"/><w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num></w:numbering>`)
  const paragraph = (text, extra = '') => `<w:p>${extra}<w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`
  let body = `<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>${title}</w:t></w:r></w:p>`
  for (let page = 0; page < pages; page += 1) {
    for (const line of lines) body += paragraph(line)
    body += `<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:rPr><w:b/><w:color w:val="C00000"/></w:rPr><w:t>Fetter roter Listenpunkt</w:t></w:r></w:p>`
    body += `<w:tbl><w:tblPr><w:tblBorders><w:top w:val="single"/></w:tblBorders></w:tblPr><w:tblGrid><w:gridCol w:w="3000"/><w:gridCol w:w="3000"/></w:tblGrid><w:tr><w:tc><w:p><w:r><w:t>Zelle A</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Zelle B</w:t></w:r></w:p></w:tc></w:tr></w:tbl>`
    body += `<w:p><w:r><w:drawing><wp:inline><wp:extent cx="1270000" cy="635000"/><a:graphic><a:graphicData><a:blip r:embed="rId1"/></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`
    body += `<w:p><w:r><w:t>&lt;script&gt;alert(1)&lt;/script&gt; &lt;img src=x onerror=alert(2)&gt;</w:t></w:r></w:p>`
    if (page < pages - 1) body += '<w:p><w:r><w:br w:type="page"/></w:r></w:p>'
  }
  zip.file('word/document.xml', `<?xml version="1.0"?><w:document ${W}><w:body>${body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134"/></w:sectPr></w:body></w:document>`)
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
}

const P = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"'
export async function makePptx({ slides = 3, width = 9144000, height = 5143500 } = {}) {
  const zip = new JSZip()
  zip.file('[Content_Types].xml', contentTypes)
  zip.file('_rels/.rels', rels([['rId1', 'officeDocument', 'ppt/presentation.xml']]))
  zip.file('ppt/presentation.xml', `<?xml version="1.0"?><p:presentation ${P}><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst><p:sldIdLst>${Array.from({ length: slides }, (_, index) => `<p:sldId id="${256 + index}" r:id="rId${10 + index}"/>`).join('')}</p:sldIdLst><p:sldSz cx="${width}" cy="${height}"/></p:presentation>`)
  zip.file('ppt/_rels/presentation.xml.rels', rels([['rId1', 'slideMaster', 'slideMasters/slideMaster1.xml'], ...Array.from({ length: slides }, (_, index) => [`rId${10 + index}`, 'slide', `slides/slide${index + 1}.xml`])]))
  zip.file('ppt/slideMasters/slideMaster1.xml', `<?xml version="1.0"?><p:sldMaster ${P}><p:cSld><p:bg><p:bgPr><a:solidFill><a:srgbClr val="F4F0E8"/></a:solidFill></p:bgPr></p:bg><p:spTree><p:nvGrpSpPr/><p:grpSpPr/></p:spTree></p:cSld><p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2"/><p:txStyles><p:titleStyle><a:lvl1pPr algn="l"><a:defRPr sz="3600" b="1"/></a:lvl1pPr></p:titleStyle><p:bodyStyle><a:lvl1pPr marL="342900" indent="-342900"><a:buChar char="•"/><a:defRPr sz="2000"/></a:lvl1pPr></p:bodyStyle></p:txStyles></p:sldMaster>`)
  zip.file('ppt/slideMasters/_rels/slideMaster1.xml.rels', rels([['rId1', 'slideLayout', '../slideLayouts/slideLayout1.xml'], ['rId2', 'theme', '../theme/theme1.xml']]))
  zip.file('ppt/slideLayouts/slideLayout1.xml', `<?xml version="1.0"?><p:sldLayout ${P}><p:cSld><p:spTree><p:nvGrpSpPr/><p:grpSpPr/><p:sp><p:nvSpPr><p:cNvPr id="2" name="Title"/><p:cNvSpPr/><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:spPr><a:xfrm><a:off x="457200" y="228600"/><a:ext cx="8229600" cy="857250"/></a:xfrm></p:spPr></p:sp></p:spTree></p:cSld></p:sldLayout>`)
  zip.file('ppt/slideLayouts/_rels/slideLayout1.xml.rels', rels([['rId1', 'slideMaster', '../slideMasters/slideMaster1.xml']]))
  zip.file('ppt/theme/theme1.xml', `<?xml version="1.0"?><a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:themeElements><a:clrScheme name="t"><a:dk1><a:srgbClr val="202020"/></a:dk1><a:lt1><a:srgbClr val="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="1F3864"/></a:dk2><a:lt2><a:srgbClr val="E7E6E6"/></a:lt2><a:accent1><a:srgbClr val="2E75B6"/></a:accent1></a:clrScheme></a:themeElements></a:theme>`)
  zip.file('ppt/media/image1.png', png(60, 40, [20, 120, 220]))
  for (let index = 0; index < slides; index += 1) {
    const n = index + 1
    zip.file(`ppt/slides/slide${n}.xml`, `<?xml version="1.0"?><p:sld ${P}><p:cSld><p:spTree><p:nvGrpSpPr/><p:grpSpPr/>
<p:sp><p:nvSpPr><p:cNvPr id="2" name="Titel"/><p:cNvSpPr/><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:p><a:r><a:rPr lang="de-DE"/><a:t>Folie ${n} Titel</a:t></a:r></a:p></p:txBody></p:sp>
<p:sp><p:nvSpPr><p:cNvPr id="3" name="Kasten"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="914400" y="1828800"/><a:ext cx="2743200" cy="1371600"/></a:xfrm><a:prstGeom prst="rect"/><a:solidFill><a:srgbClr val="C00000"/></a:solidFill></p:spPr><p:txBody><a:bodyPr anchor="ctr"/><a:p><a:pPr algn="ctr"/><a:r><a:rPr sz="2400" b="1"><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill></a:rPr><a:t>Roter Kasten ${n}</a:t></a:r></a:p></p:txBody></p:sp>
<p:pic><p:nvPicPr><p:cNvPr id="4" name="Bild"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="rId2"/></p:blipFill><p:spPr><a:xfrm><a:off x="4572000" y="1828800"/><a:ext cx="2743200" cy="1828800"/></a:xfrm></p:spPr></p:pic>
</p:spTree></p:cSld></p:sld>`)
    zip.file(`ppt/slides/_rels/slide${n}.xml.rels`, rels([['rId1', 'slideLayout', '../slideLayouts/slideLayout1.xml'], ['rId2', 'image', '../media/image1.png']]))
  }
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
}

/** A package whose entry inflates to `megabytes` of zeros: a genuine zip bomb. */
export async function makeBomb(extension, megabytes) {
  const zip = new JSZip()
  zip.file('[Content_Types].xml', contentTypes)
  zip.file(extension === '.docx' ? 'word/document.xml' : 'ppt/presentation.xml', '<x/>')
  zip.file('padding.bin', Buffer.alloc(megabytes * 1024 * 1024))
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 9 } })
}

// ---- Part 1: node-only ---------------------------------------------------------------------------------------------

const docx = await makeDocx()
const pptx = await makePptx()

// Zip reader.
{
  const zip = readZip(docx)
  assert.ok(zip.has('word/document.xml'))
  assert.match(zip.readText('word/document.xml'), /Erster Absatz/u)
  assert.equal(zip.read('missing'), null)
  assert.throws(() => readZip(Buffer.from('not a zip at all, definitely')), OfficeZipError)
  assert.throws(() => readZip(Buffer.alloc(10)), OfficeZipError)
  // Too many entries.
  const many = new JSZip()
  for (let index = 0; index < 120; index += 1) many.file(`f${index}.txt`, 'x')
  const manyBytes = await many.generateAsync({ type: 'nodebuffer' })
  assert.throws(() => readZip(manyBytes, { maxEntries: 100 }), /zu viele Dateien/u)
  assert.equal(readZip(manyBytes).names().length, 120)
  // Zip bomb: ratio and size caps trip from the central directory, before anything is inflated.
  const bomb = await makeBomb('.docx', 300)
  assert.ok(bomb.length < 1_000_000, `bomb is small on disk (${bomb.length})`)
  assert.throws(() => readZip(bomb), /Zip-Bombe|zu groß/u)
  assert.throws(() => convert.validateOfficePackage(bomb, 'word'), convert.OfficeConvertError)
  // A lying central directory (declared size 1 KiB, real data far larger) cannot make the inflater run away.
  const lying = Buffer.from(await makeBomb('.docx', 20))
  const directory = lying.lastIndexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]))
  let cursor = 0
  let patched = false
  while ((cursor = lying.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]), cursor)) >= 0) {
    const name = lying.toString('utf8', cursor + 46, cursor + 46 + lying.readUInt16LE(cursor + 28))
    if (name === 'padding.bin') { lying.writeUInt32LE(1024, cursor + 24); patched = true }
    cursor += 4
  }
  assert.ok(patched && directory > 0)
  assert.throws(() => readZip(lying).read('padding.bin'), OfficeZipError)
  // Wrong kind of package.
  assert.throws(() => convert.validateOfficePackage(docx, 'powerpoint'), /PowerPoint/u)
  assert.throws(() => convert.validateOfficePackage(pptx, 'word'), /Word/u)
  assert.throws(() => convert.validateOfficePackage(Buffer.alloc(0), 'word'), /leer/u)
  assert.throws(() => convert.validateOfficePackage(Buffer.alloc(convert.MAX_OFFICE_BYTES + 1), 'word'), /zu groß/u)
}

// docx -> HTML.
{
  const { html, pageSize } = docxToHtml(readZip(docx), { title: 'Testbericht' })
  for (const text of ['Testbericht', 'Erster Absatz mit Umlauten: äöü ß.', 'Zweiter Absatz.', 'Fetter roter Listenpunkt', 'Zelle A', 'Zelle B']) assert.ok(html.includes(text), `docx html has "${text}"`)
  assert.match(html, /<h1 [^>]*font-weight:700/u, 'heading style')
  assert.match(html, /<span style="[^"]*color:#c00000/u, 'run color')
  assert.match(html, /<table /u)
  assert.match(html, /src="data:image\/png;base64,/u, 'picture inlined')
  assert.match(html, /@page\{size:210mm 297mm/u, 'A4 from sectPr')
  assert.deepEqual(pageSize, { widthMm: 210, heightMm: 297 })
  // Sanitizing: user text is escaped, the page can load nothing from the network, and nothing executes.
  assert.ok(!/<script/iu.test(html) && !/onerror=/iu.test(html.replace(/&lt;img src=x onerror=alert\(2\)&gt;/u, '')), 'no live script/handler')
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'))
  assert.match(html, /Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'"/u)
  assert.ok(!/(?:src|href)="(?!data:)/iu.test(html), 'no external references')
  assert.throws(() => docxToHtml(readZip(pptx)), /document\.xml/u)
}

// pptx -> HTML: real slide size, positions in px (1 px = 9525 EMU), background, picture, text.
{
  const { html, slides, slideSize } = pptxToHtml(readZip(pptx), { title: 'Folien' })
  assert.equal(slides, 3)
  assert.deepEqual(slideSize, { widthPx: 960, heightPx: 540 })
  assert.equal((html.match(/class="slide"/gu) ?? []).length, 3)
  assert.match(html, /@page\{size:960px 540px;margin:0\}/u)
  assert.ok(html.includes('Folie 2 Titel') && html.includes('Roter Kasten 3'))
  assert.match(html, /left:96px;top:192px;width:288px;height:144px[^"]*background:#c00000/u, 'rectangle at its real position and size')
  assert.match(html, /left:48px;top:24px;width:864px;height:90px/u, 'title placeholder geometry inherited from the layout')
  assert.match(html, /font-size:48px[^"]*font-weight:700|font-weight:700[^"]*font-size:48px/u, 'title size/bold from the master (36pt)')
  assert.match(html, /background:#f4f0e8/u, 'slide background from the master')
  assert.match(html, /<img src="data:image\/png;base64,[^"]+" alt="" style="position:absolute;[^"]*width:288px;height:192px/u, 'picture fills its frame')
  assert.ok(!/<script/iu.test(html))
  assert.equal(pptxToHtml(readZip(await makePptx({ slides: 1, width: 12192000, height: 6858000 }))).slideSize.widthPx, 1280)
  assert.throws(() => pptxToHtml(readZip(docx)), /presentation\.xml/u)
}

// Names and hidden/temp files.
assert.equal(engines.officeKindOf('Bericht.DOCX').kind, 'word')
assert.equal(engines.officeKindOf('Folien.pptx').kind, 'powerpoint')
assert.equal(engines.officeKindOf('alt.doc'), null)
for (const name of ['~$Bericht.docx', 'Ordner/~$Folien.pptx', '.~lock.Bericht.docx#', '.versteckt.docx']) assert.ok(engines.isOfficeTempName(name), name)
assert.ok(!engines.isOfficeTempName('Ordner/Bericht.docx'))

// Engine selection.
{
  const plan = (options) => engines.planEngines(options)
  assert.deepEqual(plan({ kind: 'word', platform: 'win32', soffice: 'C:/LO/soffice.exe', env: {} }), ['com', 'libreoffice', 'builtin'])
  assert.deepEqual(plan({ kind: 'powerpoint', platform: 'win32', soffice: null, env: {} }), ['com', 'builtin'])
  assert.deepEqual(plan({ kind: 'word', platform: 'linux', soffice: '/usr/bin/soffice', env: {} }), ['libreoffice', 'builtin'])
  assert.deepEqual(plan({ kind: 'word', platform: 'linux', soffice: null, env: {} }), ['builtin'])
  assert.deepEqual(plan({ kind: 'word', platform: 'win32', soffice: '/x', env: {}, disabled: new Set(['com']) }), ['libreoffice', 'builtin'])
  assert.deepEqual(plan({ kind: 'word', platform: 'win32', soffice: '/x', env: { FANOTES_OFFICE_ENGINE: 'builtin' } }), ['builtin'])
  assert.deepEqual(plan({ kind: 'word', platform: 'linux', soffice: '/x', env: { FANOTES_OFFICE_ENGINE: 'libreoffice' } }), ['libreoffice'])
  // Finding LibreOffice: override, PATH, install folders, nothing.
  const exists = (set) => (file) => set.includes(file)
  assert.equal(engines.findSoffice({ platform: 'linux', env: { PATH: '/a:/b' }, exists: exists(['/b/soffice']) }), '/b/soffice')
  assert.equal(engines.findSoffice({ platform: 'linux', env: { PATH: '/a' }, exists: exists(['/usr/lib/libreoffice/program/soffice']) }), '/usr/lib/libreoffice/program/soffice')
  assert.equal(engines.findSoffice({ platform: 'win32', env: { PATH: 'C:\\x', ProgramFiles: 'C:\\Program Files' }, exists: exists(['C:\\Program Files\\LibreOffice\\program\\soffice.exe']) }), 'C:\\Program Files\\LibreOffice\\program\\soffice.exe')
  assert.equal(engines.findSoffice({ platform: 'linux', env: { PATH: '/a' }, exists: () => false }), null)
  assert.equal(engines.findSoffice({ platform: 'linux', env: { PATH: '/a', FANOTES_SOFFICE: '/opt/my/soffice' }, exists: exists(['/opt/my/soffice']) }), '/opt/my/soffice')
}

// COM command building: paths travel in the environment, never inside the script text.
{
  const nasty = String.raw`C:\Users\Zoë Müller\Mathe "Klasse" 5a's $(calc) ;.docx`
  for (const kind of ['word', 'powerpoint']) {
    const command = engines.buildComCommand(kind, nasty, String.raw`C:\tmp\ausgabe äöü.pdf`)
    assert.equal(command.command, 'powershell.exe')
    assert.deepEqual(command.args.slice(0, 6), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden'])
    assert.equal(command.args[6], '-EncodedCommand')
    const script = Buffer.from(command.args[7], 'base64').toString('utf16le')
    assert.equal(script, command.script)
    assert.deepEqual(command.env, { FANOTES_OFFICE_SRC: nasty, FANOTES_OFFICE_DST: String.raw`C:\tmp\ausgabe äöü.pdf` })
    assert.ok(!script.includes('Müller') && !script.includes('calc') && !script.includes('ausgabe'), 'no path in script text')
    assert.ok(command.args.every((arg) => !arg.includes('Müller')), 'no path on the command line')
    assert.match(script, /\$env:FANOTES_OFFICE_SRC/u)
    assert.match(script, /AutomationSecurity = 3/u, 'macros forced off')
    assert.match(script, /exit 3/u, 'not-installed exit code')
    assert.match(script, /Quit\(/u)
    assert.match(script, /finally \{/u)
  }
  const word = engines.buildComCommand('word', 'a.docx', 'a.pdf').script
  assert.match(word, /Word\.Application/u)
  assert.match(word, /Documents\.Open\(\$src, \$false, \$true, \$false\)/u, 'read-only, no recent file')
  assert.match(word, /ExportAsFixedFormat\(\$dst, 17\)/u)
  const power = engines.buildComCommand('powerpoint', 'a.pptx', 'a.pdf').script
  assert.match(power, /PowerPoint\.Application/u)
  assert.match(power, /Presentations\.Open\(\$src, -1, 0, 0\)/u, 'read-only, untitled, no window')
  assert.match(power, /SaveAs\(\$dst, 32\)/u)
  assert.throws(() => engines.buildComCommand('excel', 'a', 'b'))
  // The scripts are balanced (cheap syntax sanity without PowerShell).
  for (const script of [word, power]) {
    for (const [open, close] of [['{', '}'], ['(', ')']]) assert.equal(script.split(open).length, script.split(close).length, `balanced ${open}${close}`)
  }
}

// soffice command building and a fake soffice that is really spawned.
{
  const command = engines.buildSofficeCommand('/opt/lo/soffice', '/tmp/w/input.docx', '/tmp/w/out', '/tmp/w/profile dir')
  assert.equal(command.command, '/opt/lo/soffice')
  assert.ok(command.args.includes('--headless') && command.args.includes('--convert-to') && command.args.includes('pdf'))
  assert.ok(command.args.includes('-env:UserInstallation=file:///tmp/w/profile%20dir'), 'private profile as a file URL')
  assert.deepEqual(command.args.slice(-3), ['--outdir', '/tmp/w/out', '/tmp/w/input.docx'])
  assert.equal(command.args.at(-1), '/tmp/w/input.docx')
  if (process.platform !== 'win32') {
    const fake = path.join(temporary, 'fake soffice')
    fs.writeFileSync(fake, `#!/bin/sh
# Records its arguments, then writes <outdir>/input.pdf like soffice --convert-to pdf does.
out=""; prev=""
for arg in "$@"; do if [ "$prev" = "--outdir" ]; then out="$arg"; fi; prev="$arg"; done
printf '%s\\n' "$@" > "${path.join(temporary, 'soffice-args.txt')}"
printf '%%PDF-1.4\\n%% fake pdf from soffice with padding to look real enough ....................\\n%%%%EOF\\n' > "$out/input.pdf"
`, { mode: 0o755 })
    const printed = []
    const result = await convert.convertOfficeToPdf({ bytes: docx, kind: 'word', title: 'T', scratchDir: temporary, soffice: fake, env: {}, platform: 'linux', printHtmlToPdf: async (html) => { printed.push(html); return Buffer.alloc(0) } })
    assert.equal(result.engine, 'libreoffice')
    assert.equal(result.fallback, false)
    assert.ok(result.pdf.toString('latin1').startsWith('%PDF-'))
    assert.equal(printed.length, 0, 'built-in renderer not used when LibreOffice works')
    const args = fs.readFileSync(path.join(temporary, 'soffice-args.txt'), 'utf8').split('\n')
    assert.ok(args.some((arg) => arg.startsWith('-env:UserInstallation=file://')) && args.includes('--headless'))
    assert.deepEqual(fs.readdirSync(temporary).filter((name) => name.startsWith('office-')), [], 'work folder removed')
    // A failing LibreOffice (timeout / error exit / no output) falls through to the built-in renderer.
    const failing = path.join(temporary, 'failing soffice')
    fs.writeFileSync(failing, '#!/bin/sh\nexit 7\n', { mode: 0o755 })
    const fallbackPdf = Buffer.from(`%PDF-1.4\n${'x'.repeat(100)}\n%%EOF\n`)
    const failures = []
    const fell = await convert.convertOfficeToPdf({ bytes: pptx, kind: 'powerpoint', scratchDir: temporary, soffice: failing, env: {}, platform: 'linux', onEngineFailure: (engine) => failures.push(engine), printHtmlToPdf: async (html, info) => { assert.ok(html.includes('class="slide"')); assert.deepEqual(info.slideSize, { widthPx: 960, heightPx: 540 }); return fallbackPdf } })
    assert.equal(fell.engine, 'builtin')
    assert.equal(fell.fallback, true)
    assert.deepEqual(failures, ['libreoffice'])
    const hang = path.join(temporary, 'hanging soffice')
    fs.writeFileSync(hang, '#!/bin/sh\nsleep 30\n', { mode: 0o755 })
    const started = Date.now()
    const timedOut = await convert.convertOfficeToPdf({ bytes: docx, kind: 'word', scratchDir: temporary, soffice: hang, env: {}, platform: 'linux', timeoutMs: 700, printHtmlToPdf: async () => fallbackPdf })
    assert.equal(timedOut.engine, 'builtin')
    assert.ok(Date.now() - started < 10_000, 'the hanging engine was killed at its timeout')
    // Both engines broken: a clear German error, no stray folders.
    await assert.rejects(convert.convertOfficeToPdf({ bytes: docx, kind: 'word', scratchDir: temporary, soffice: null, env: {}, platform: 'linux', printHtmlToPdf: async () => { throw new Error('boom') } }), /konnte nicht umgewandelt werden/u)
    assert.deepEqual(fs.readdirSync(temporary).filter((name) => name.startsWith('office-')), [])
  }
}

// famd: the source link round-trips (v1 and v2) and bad values are dropped.
{
  const source = { path: 'Schule/Bericht äö.docx', size: 1234, mtimeMs: 1_700_000_000_123, engine: 'builtin', convertedAt: '2026-11-27T10:00:00.000Z' }
  for (const encoding of ['v1', 'v2']) {
    const text = famdMain.serializeFamd('', { ...famdMain.emptyFamdPayload(), officeSource: source }, encoding)
    assert.deepEqual(famdMain.parseFamd(text).payload.officeSource, source, `${encoding} round trip`)
    const rewritten = famdMain.composeFamdCompanion(text, '', undefined, 'blank')
    assert.deepEqual(famdMain.parseFamd(rewritten).payload.officeSource, source, `${encoding} survives a text/ink save`)
  }
  const { parseOfficeSource } = await import('../electron/officeSource.mjs')
  assert.equal(parseOfficeSource({ ...source, path: 'x.exe' }), null)
  assert.equal(parseOfficeSource({ ...source, size: -1 }), null)
  assert.equal(parseOfficeSource('nope'), null)
  assert.equal(parseOfficeSource({ ...source, engine: 'evil' }).engine, 'builtin')
  assert.equal(famdMain.parseFamd(famdMain.serializeFamd('', famdMain.emptyFamdPayload(), 'v1')).payload.officeSource, undefined)
}

// Tree and renderer wiring (source contracts).
{
  const main = fs.readFileSync(path.join(root, 'electron/main.cjs'), 'utf8')
  assert.match(main, /'\.docx',\s*'\.pptx',/u, 'tree lists docx/pptx')
  assert.equal((main.match(/isListedTreeFile\(/gu) ?? []).length, 4, 'every tree scan uses the temp-file filter')
  assert.ok(!/TREE_EXTENSIONS\.has\((?:path\.extname|extensionWithDot)/u.test(main), 'no scan bypasses the filter')
  assert.match(main, /fanotes:import-office-document/u)
  const app = fs.readFileSync(path.join(root, 'src/App.tsx'), 'utf8')
  assert.match(app, /officeKindOfPath\(path\)/u)
  assert.match(app, /window\.fanotes\.importOfficeDocument/u)
  const preload = fs.readFileSync(path.join(root, 'electron/preload.cjs'), 'utf8')
  assert.match(preload, /importOfficeDocument: \(relativePath, options\)/u)
  const browserApi = fs.readFileSync(path.join(root, 'src/lib/browserApi.ts'), 'utf8')
  assert.ok(!/importOfficeDocument|readOfficeSource/u.test(browserApi), 'web build has no Office conversion')
}
console.log('office to pdf: packages, zip caps, renderers, engines, commands and famd link checks passed')

// ---- Part 2 and 3 need Electron ------------------------------------------------------------------------------------

const electron = path.join(root, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron')
const xvfb = spawnSync('sh', ['-c', 'command -v xvfb-run'], { encoding: 'utf8' }).stdout.trim()
if (process.env.FANOTES_OFFICE_DESKTOP !== '1' || process.env.FANOTES_SKIP_BROWSER === '1' || !xvfb || !fs.existsSync(electron)) {
  console.log(`office to pdf: desktop parts skipped (${process.env.FANOTES_OFFICE_DESKTOP !== '1' ? 'set FANOTES_OFFICE_DESKTOP=1 to run them' : process.env.FANOTES_SKIP_BROWSER === '1' ? 'FANOTES_SKIP_BROWSER=1' : !xvfb ? 'no xvfb-run' : 'no electron'})`)
  process.exit(0)
}
const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs')
const pdfInfo = async (bytes) => {
  const document = await getDocument({ data: new Uint8Array(bytes), useSystemFonts: true, disableFontFace: true, verbosity: 0 }).promise
  const pages = []
  for (let number = 1; number <= document.numPages; number += 1) {
    const page = await document.getPage(number)
    const view = page.view
    const text = (await page.getTextContent()).items.map((item) => item.str).join(' ')
    pages.push({ width: view[2] - view[0], height: view[3] - view[1], text })
  }
  return { count: document.numPages, pages }
}
const results = []
const ok = (name, pass, detail = '') => {
  results.push(Boolean(pass))
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail !== '' ? ` -> ${String(detail).slice(0, 240)}` : ''}`)
}

// Part 2: the built-in renderer in real Electron.
{
  const work = path.join(temporary, 'print')
  fs.mkdirSync(work, { recursive: true })
  fs.writeFileSync(path.join(work, 'a.docx'), await makeDocx({ pages: 2 }))
  fs.writeFileSync(path.join(work, 'b.pptx'), await makePptx({ slides: 3 }))
  fs.writeFileSync(path.join(work, 'c.pptx'), await makePptx({ slides: 2, width: 12192000, height: 6858000 }))
  fs.writeFileSync(path.join(work, 'package.json'), '{"name":"office-print-check","main":"main.cjs"}')
  fs.writeFileSync(path.join(work, 'main.cjs'), `
const { app } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const { convertOfficeToPdf } = require(${JSON.stringify(path.join(root, 'electron/office-convert.cjs'))})
const { printOfficeHtmlToPdf } = require(${JSON.stringify(path.join(root, 'electron/office-print.cjs'))})
app.disableHardwareAcceleration()
app.on('window-all-closed', () => {})
app.whenReady().then(async () => {
  const out = {}
  try {
    for (const [name, kind] of [['a.docx', 'word'], ['b.pptx', 'powerpoint'], ['c.pptx', 'powerpoint']]) {
      const result = await convertOfficeToPdf({ bytes: fs.readFileSync(path.join(${JSON.stringify(work)}, name)), kind, scratchDir: ${JSON.stringify(work)}, soffice: null, env: {}, platform: 'linux', printHtmlToPdf: (html) => printOfficeHtmlToPdf(html, { tempDir: ${JSON.stringify(work)} }) })
      fs.writeFileSync(path.join(${JSON.stringify(work)}, name + '.pdf'), result.pdf)
      out[name] = { engine: result.engine }
    }
  } catch (error) { out.error = String(error && error.stack || error) }
  fs.writeFileSync(path.join(${JSON.stringify(work)}, 'result.json'), JSON.stringify(out))
  app.exit(0)
})
`)
  const run = spawnSync('xvfb-run', ['-a', electron, path.join(work, 'main.cjs'), '--no-sandbox'], { env: { ...process.env, HOME: work, XDG_CONFIG_HOME: work, XDG_RUNTIME_DIR: work }, encoding: 'utf8', timeout: 180_000 })
  const resultFile = path.join(work, 'result.json')
  const printed = fs.existsSync(resultFile) ? JSON.parse(fs.readFileSync(resultFile, 'utf8')) : { error: `no result (exit ${run.status}): ${`${run.stdout}${run.stderr}`.split('\n').filter((line) => !/dbus|DBus/u.test(line)).join(' ').slice(-600)}` }
  ok('built-in renderer ran in Electron', !printed.error, printed.error)
  if (!printed.error) {
    const word = await pdfInfo(fs.readFileSync(path.join(work, 'a.docx.pdf')))
    ok('docx: the text is in the PDF', ['Testbericht', 'Erster Absatz mit Umlauten', 'Fetter roter Listenpunkt', 'Zelle A'].every((text) => word.pages.some((page) => page.text.includes(text))), word.pages[0]?.text.slice(0, 120))
    ok('docx: A4 page size', Math.abs(word.pages[0].width - 595) < 3 && Math.abs(word.pages[0].height - 842) < 3, `${word.pages[0].width}x${word.pages[0].height}`)
    ok('docx: explicit page break gives 2 pages', word.count === 2, word.count)
    const slides = await pdfInfo(fs.readFileSync(path.join(work, 'b.pptx.pdf')))
    ok('pptx: one PDF page per slide', slides.count === 3, slides.count)
    ok('pptx: pages have the slide size (10 x 5.625 in = 720 x 405 pt)', slides.pages.every((page) => Math.abs(page.width - 720) < 2 && Math.abs(page.height - 405) < 2), slides.pages.map((page) => `${page.width}x${page.height}`).join(' '))
    ok('pptx: slide text lands on its own page', [1, 2, 3].every((n) => slides.pages[n - 1].text.includes(`Folie ${n} Titel`) && slides.pages[n - 1].text.includes(`Roter Kasten ${n}`)), slides.pages.map((page) => page.text.slice(0, 40)).join(' | '))
    const wide = await pdfInfo(fs.readFileSync(path.join(work, 'c.pptx.pdf')))
    ok('pptx 16:9 widescreen: 2 pages of 960 x 540 pt', wide.count === 2 && wide.pages.every((page) => Math.abs(page.width - 960) < 2 && Math.abs(page.height - 540) < 2), wide.pages.map((page) => `${page.width}x${page.height}`).join(' '))
  }
}

// Part 3: the real app.
const builtRenderer = fs.existsSync(path.join(root, 'dist', 'index.html'))
let playwright = null
if (builtRenderer) {
  try { playwright = await import(process.env.PLAYWRIGHT_CORE || 'playwright-core') } catch { /* skipped below */ }
}
if (!builtRenderer || !playwright) {
  console.log(`office to pdf: app part skipped (${!builtRenderer ? 'no dist/ (run vite build)' : 'no playwright-core; set PLAYWRIGHT_CORE'})`)
} else {
  const chromium = playwright.chromium ?? playwright.default.chromium
  const home = path.join(temporary, 'home')
  const configHome = path.join(temporary, 'config')
  const runtime = path.join(temporary, 'runtime')
  const vault = path.join(home, 'Notizen')
  const userData = path.join(configHome, 'FaNotes')
  for (const directory of [home, configHome, runtime, vault, userData]) fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
  const shots = process.env.OFFICE_SHOTS || path.join(temporary, 'shots')
  fs.mkdirSync(shots, { recursive: true })
  const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
  const v = (name) => path.join(vault, name)

  const bericht = await makeDocx({ title: 'Quartalsbericht', lines: ['Der Umsatz stieg im dritten Quartal deutlich.', 'Alle Zahlen sind vorläufig.'] })
  fs.writeFileSync(v('Bericht.docx'), bericht)
  fs.writeFileSync(v('Folien.pptx'), await makePptx({ slides: 3 }))
  fs.writeFileSync(v('~$Bericht.docx'), Buffer.from('owner file'))
  fs.writeFileSync(v('.~lock.Bericht.docx#'), 'lock')
  fs.writeFileSync(v('Doppelt.docx'), await makeDocx({ title: 'Doppelt' }))
  const unrelatedPdf = Buffer.from(`%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >>\nendobj\ntrailer\n<< /Root 1 0 R /Size 4 >>\n%%EOF\n`)
  fs.writeFileSync(v('Doppelt.pdf'), unrelatedPdf)
  fs.writeFileSync(v('Bombe.docx'), await makeBomb('.docx', 300))
  fs.writeFileSync(v('Kaputt.pptx'), Buffer.from('this is not a zip file'.repeat(5)))
  fs.writeFileSync(path.join(userData, 'config.json'), `${JSON.stringify({
    version: 3,
    vaultPath: vault,
    settings: { uiLanguage: 'de', autoCheckUpdates: false, autoDownloadUpdates: false, reduceMotion: true },
    onboarding: { version: 1, completed: true },
  }, null, 2)}\n`, { mode: 0o600 })

  const launch = () => {
    const port = 19_300 + Math.floor(Math.random() * 400)
    const child = spawn('xvfb-run', ['-a', '-s', '-screen 0 1440x1000x24', electron, root, `--remote-debugging-port=${port}`, '--no-sandbox'], {
      env: { ...process.env, HOME: home, XDG_CONFIG_HOME: configHome, XDG_RUNTIME_DIR: runtime, FANOTES_OFFICE_ENGINE: 'builtin' },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    })
    let output = ''
    child.stdout.on('data', (chunk) => { output += chunk })
    child.stderr.on('data', (chunk) => { output += chunk })
    return { child, port, output: () => output }
  }
  const connect = async (app) => {
    let browser = null
    const deadline = Date.now() + 60_000
    while (!browser && Date.now() < deadline) {
      try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${app.port}`) } catch { await new Promise((resolve) => setTimeout(resolve, 250)) }
      if (app.child.exitCode !== null) throw new Error(`Electron exited: ${app.output().slice(-400)}`)
    }
    assert.ok(browser, 'Electron did not open a debugging port')
    let page = null
    for (let tries = 0; tries < 120 && !page; tries += 1) {
      page = browser.contexts().flatMap((context) => context.pages()).find((candidate) => !/^devtools|ocr-host|recognition\.html|fanotes-note-export/u.test(candidate.url())) ?? null
      if (!page) await new Promise((resolve) => setTimeout(resolve, 250))
    }
    assert.ok(page, 'no renderer page')
    page.on('pageerror', (error) => console.log('pageerror', String(error).slice(0, 200)))
    await page.waitForFunction(() => Boolean(window.fanotes && document.querySelector('.file-tree__row')), null, { timeout: 60_000 })
    return { browser, page }
  }
  const stop = async (app, browser) => {
    await browser?.close().catch(() => {})
    try { process.kill(-app.child.pid, 'SIGTERM') } catch { /* gone */ }
    await new Promise((resolve) => setTimeout(resolve, 800))
  }
  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

  let app = launch()
  let browser = null
  try {
    let page
    ;({ browser, page } = await connect(app))
    const rows = () => page.locator('.file-tree__row').allInnerTexts()
    const row = (name) => page.locator('.file-tree__row', { has: page.locator('.file-tree__name', { hasText: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}$`, 'u') }) }).first()
    const pdfReady = () => page.waitForFunction(() => [...document.querySelectorAll('[data-pdf-page="1"] canvas')].some((canvas) => canvas.width > 0), null, { timeout: 90_000 })
    const toastTexts = () => page.locator('.toast').allInnerTexts()
    const activeTitle = () => page.evaluate(() => document.querySelector('.note-tab-main[aria-current="true"]')?.textContent ?? '')

    const listing = (await rows()).join('\n')
    ok('tree lists the Word and PowerPoint files', /Bericht\.docx/u.test(listing) && /Folien\.pptx/u.test(listing) && /Doppelt\.docx/u.test(listing), listing.replace(/\n+/gu, ' | '))
    ok('~$ owner files and lock files are hidden', !/~\$/u.test(listing) && !/\.~lock/u.test(listing))
    ok('Office files get their own icon', (await page.locator('.file-tree__office.is-word').count()) >= 1 && (await page.locator('.file-tree__office.is-powerpoint').count()) >= 1)
    const originalHash = sha(v('Bericht.docx'))
    const diagnostics = page.getByRole('button', { name: 'OK', exact: true })
    if (await diagnostics.isVisible().catch(() => false)) await diagnostics.click()

    // Open the docx: converts and opens the PDF note.
    await row('Bericht.docx').click()
    await pdfReady()
    await pause(900)
    ok('opening the docx creates Bericht.pdf next to it', fs.existsSync(v('Bericht.pdf')) && fs.readFileSync(v('Bericht.pdf')).toString('latin1', 0, 5) === '%PDF-')
    const converted = await pdfInfo(fs.readFileSync(v('Bericht.pdf')))
    ok('converted PDF contains the docx text', converted.pages[0]?.text.includes('Quartalsbericht') && converted.pages[0].text.includes('Alle Zahlen sind vorläufig'), converted.pages[0]?.text.slice(0, 100))
    ok('a .famd companion records the source (path, size, mtime, engine)', (() => {
      const payload = famdMain.parseFamd(fs.readFileSync(v('Bericht.famd'), 'utf8')).payload
      const source = payload?.officeSource
      return source?.path === 'Bericht.docx' && source.size === bericht.length && Math.abs(source.mtimeMs - fs.statSync(v('Bericht.docx')).mtimeMs) < 2 && source.engine === 'builtin'
    })())
    ok('the original is untouched', sha(v('Bericht.docx')) === originalHash)
    ok('the tree now shows the converted PDF note', (await rows()).some((text) => text.trim() === 'Bericht'))
    ok('the PDF note is the open tab', /Bericht/u.test(await activeTitle()), await activeTitle())
    ok('built-in fallback shows the layout hint', await page.locator('.office-notice.is-hint').isVisible())
    await page.screenshot({ path: path.join(shots, 'docx-open-as-pdf-note.png') })
    await page.locator('.office-notice.is-hint .office-notice__close').click()

    // pptx: one page per slide.
    await row('Folien.pptx').click()
    await pdfReady()
    await pause(900)
    ok('opening the pptx creates Folien.pdf', fs.existsSync(v('Folien.pdf')))
    const deck = await pdfInfo(fs.readFileSync(v('Folien.pdf')))
    ok('Folien.pdf has one page per slide at the slide size', deck.count === 3 && Math.abs(deck.pages[0].width - 720) < 2 && Math.abs(deck.pages[0].height - 405) < 2, `${deck.count} pages ${deck.pages[0].width}x${deck.pages[0].height}`)
    ok('the pptx PDF note is the open tab', /Folien/u.test(await activeTitle()), await activeTitle())
    await page.screenshot({ path: path.join(shots, 'pptx-open-as-pdf-note.png') })

    // Open the docx again: reuses.
    const pdfMtime = fs.statSync(v('Bericht.pdf')).mtimeMs
    await row('Bericht.docx').click()
    await pdfReady()
    await pause(700)
    const afterReuse = fs.readdirSync(vault).sort()
    ok('opening the docx again reuses the PDF (no new file)', afterReuse.filter((name) => /^Bericht.*\.pdf$/u.test(name)).length === 1 && fs.statSync(v('Bericht.pdf')).mtimeMs === pdfMtime)
    ok('the dismissed hint stays dismissed', !(await page.locator('.office-notice.is-hint').isVisible()))

    // Changed original: notice and a fresh PDF on request, nothing overwritten.
    await pause(1200)
    const edited = await makeDocx({ title: 'Quartalsbericht', lines: ['Der Umsatz stieg im dritten Quartal deutlich.', 'NEU: Jahresausblick ergänzt.'] })
    fs.writeFileSync(v('Bericht.docx'), edited)
    const oldPdfHash = sha(v('Bericht.pdf'))
    await row('Bericht.docx').click()
    await pdfReady()
    await pause(500)
    await page.evaluate(() => window.dispatchEvent(new Event('focus')))
    await page.locator('.office-notice.is-changed').waitFor({ state: 'visible', timeout: 10_000 }).catch(() => {})
    const noticeText = await page.locator('.office-notice.is-changed').innerText().catch(() => '')
    ok('a changed original shows the notice', /Original geändert – neu umwandeln\?/u.test(noticeText), noticeText)
    ok('the old PDF is untouched until asked', sha(v('Bericht.pdf')) === oldPdfHash && !fs.existsSync(v('Bericht (Word).pdf')))
    await page.screenshot({ path: path.join(shots, 'changed-original-notice.png') })
    await page.locator('.office-notice.is-changed button', { hasText: 'Neu umwandeln' }).click()
    const deadline = Date.now() + 60_000
    while (!fs.existsSync(v('Bericht (Word).pdf')) && Date.now() < deadline) await pause(300)
    await pause(800)
    ok('"Neu umwandeln" creates a new PDF note and keeps the old one', fs.existsSync(v('Bericht (Word).pdf')) && sha(v('Bericht.pdf')) === oldPdfHash)
    const fresh = await pdfInfo(fs.readFileSync(v('Bericht (Word).pdf')))
    ok('the new PDF has the changed text', fresh.pages[0]?.text.includes('Jahresausblick'), fresh.pages[0]?.text.slice(0, 120))
    ok('the link moved to the new PDF', famdMain.parseFamd(fs.readFileSync(v('Bericht (Word).famd'), 'utf8')).payload?.officeSource?.path === 'Bericht.docx' && !famdMain.parseFamd(fs.readFileSync(v('Bericht.famd'), 'utf8')).payload?.officeSource)
    const count = fs.readdirSync(vault).filter((name) => /\.pdf$/u.test(name)).length
    await row('Bericht.docx').click()
    await pdfReady()
    await pause(800)
    ok('the docx now opens the newest conversion without converting again', fs.readdirSync(vault).filter((name) => /\.pdf$/u.test(name)).length === count)
    ok('no change notice after re-converting', !(await page.locator('.office-notice.is-changed').isVisible()))

    // Name collision with an unrelated PDF.
    const unrelatedHash = sha(v('Doppelt.pdf'))
    await row('Doppelt.docx').click()
    await pdfReady()
    await pause(900)
    ok('a taken name becomes "Name (Word).pdf"', fs.existsSync(v('Doppelt (Word).pdf')) && sha(v('Doppelt.pdf')) === unrelatedHash)

    // Bad files.
    const pdfsBefore = fs.readdirSync(vault).filter((name) => /\.pdf$/u.test(name)).sort().join('|')
    await row('Bombe.docx').click()
    await page.locator('.toast.error').first().waitFor({ state: 'visible', timeout: 30_000 }).catch(() => {})
    const bombToast = (await toastTexts()).join(' ')
    ok('a zip bomb is rejected with a clear German error', /Zip-Bombe|zu groß/u.test(bombToast), bombToast)
    await pause(500)
    await row('Kaputt.pptx').click()
    await pause(2500)
    const brokenToast = (await toastTexts()).join(' ')
    ok('a broken file is rejected with a clear German error', /kein gültiges Office-Dokument|beschädigt/u.test(brokenToast), brokenToast)
    ok('rejected files create no PDF', fs.readdirSync(vault).filter((name) => /\.pdf$/u.test(name)).sort().join('|') === pdfsBefore && !fs.existsSync(v('Bombe.pdf')) && !fs.existsSync(v('Kaputt.pdf')))
    ok('the UI stays responsive (busy state cleared)', (await page.locator('.office-busy').count()) === 0)

    await stop(app, browser)
    browser = null

    // Restart: the link survives.
    app = launch()
    ;({ browser, page } = await connect(app))
    const filesBefore = fs.readdirSync(vault).sort().join('|')
    await row('Folien.pptx').click()
    await pdfReady()
    await pause(900)
    ok('after a restart the pptx still opens its existing PDF', fs.readdirSync(vault).sort().join('|') === filesBefore)
  } catch (error) {
    ok('desktop app flow', false, error?.stack ?? error)
  } finally {
    await stop(app, browser)
  }
}
const failed = results.filter((pass) => !pass).length
console.log(`office to pdf: ${results.length - failed}/${results.length} desktop checks passed`)
process.exit(failed ? 1 : 0)
