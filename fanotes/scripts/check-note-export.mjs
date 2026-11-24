// Text-note export through the real dialog in the real app (Electron under Xvfb, temp profile, synthetic vault):
// a note with headings, a table, math, code, a picture and Unicode is exported as PDF and DOCX, and the files
// are read back (PDF text with pdf.js, DOCX as a zip). Needs a built renderer (`vite build`), xvfb-run and
// playwright-core (PLAYWRIGHT_CORE). Run: node scripts/check-note-export.mjs
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import zlib from 'node:zlib'
import {
  captureDownload, connect, createProfile, createReporter, dismissNotices, electronBinary, launch, openFile, root, sleep, stop,
} from './lib/desktop-flow.mjs'

const require = createRequire(import.meta.url)
const JSZip = require('jszip')
// A machine without a CJK font prints no glyphs for 日本 (Chromium drops them): only assert it when one is installed.
const cjkFont = process.platform !== 'linux' || spawnSync('sh', ['-c', 'fc-list :lang=ja'], { encoding: 'utf8' }).stdout.trim().length > 0
const xvfb = spawnSync('sh', ['-c', 'command -v xvfb-run'], { encoding: 'utf8' }).stdout.trim()
const skipReason = process.env.FANOTES_SKIP_BROWSER === '1' ? 'FANOTES_SKIP_BROWSER=1'
  : !xvfb ? 'no xvfb-run'
    : !fs.existsSync(path.join(root, 'dist', 'index.html')) ? 'no dist/ (run vite build)'
      : !fs.existsSync(electronBinary) ? 'no electron' : ''
if (skipReason) {
  console.log(`note export: skipped (${skipReason})`)
  process.exit(0)
}
try { await import(process.env.PLAYWRIGHT_CORE || 'playwright-core') } catch {
  console.log('note export: skipped (no playwright-core; set PLAYWRIGHT_CORE)')
  process.exit(0)
}
const pdfjs = await import(path.join(root, 'node_modules/pdfjs-dist/legacy/build/pdf.mjs'))
const { ok, failed, count } = createReporter()

/** A solid-colour RGB PNG (real zlib data and CRCs), so the picture decodes in Chromium and Word. */
const makePng = (width, height, [r, g, b]) => {
  const chunk = (type, data) => {
    const head = Buffer.alloc(8)
    head.writeUInt32BE(data.length, 0)
    head.write(type, 4, 'latin1')
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(zlib.crc32(Buffer.concat([head.subarray(4), data])), 0)
    return Buffer.concat([head, data, crc])
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header.set([8, 2, 0, 0, 0], 8)
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: width }, () => [r, g, b]).flat())])
  const raw = Buffer.concat(Array.from({ length: height }, () => row))
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}

const NOTE = [
  '# Exportprobe', '',
  'Text mit x ≤ 1, α→β, 日本 und **fett**.', '',
  '## Tabelle', '',
  '| Name | Wert |', '| --- | --- |', '| Alpha | 17 |', '| Beta | 42 |', '',
  '## Formel', '',
  'Inline $a^2 + b^2 = c^2$ und display:', '',
  '$$\\sum_{i=1}^{n} \\frac{i}{2}$$', '',
  '## Code', '',
  '```', 'const answer = 42', '```', '',
  '![Bild](bild.png)', '',
].join('\n')

const readPdf = async (file) => {
  const document = await pdfjs.getDocument({ data: new Uint8Array(fs.readFileSync(file)), useSystemFonts: false, verbosity: 0 }).promise
  const pages = []
  for (let number = 1; number <= document.numPages; number += 1) {
    const page = await document.getPage(number)
    const content = await page.getTextContent()
    pages.push({ view: page.view, text: content.items.map((item) => item.str).join(' ') })
  }
  return pages
}
const squash = (text) => text.replace(/\s+/gu, '')

const profile = createProfile('note-export-')
fs.writeFileSync(path.join(profile.vault, 'Probe.md'), NOTE)
fs.writeFileSync(path.join(profile.vault, 'bild.png'), makePng(320, 160, [200, 40, 40]))
const app = launch(profile)
let browser = null
try {
  const connected = await connect(app)
  const page = connected.page
  browser = connected.browser
  await dismissNotices(page)
  await openFile(page, 'Probe')
  await page.waitForSelector('.cm-content', { timeout: 30_000 })

  const dialog = page.locator('.note-export-dialog')
  const openDialog = async () => {
    await page.locator('button[aria-label="Weitere Notizaktionen"]').first().click()
    await page.locator('[role=menuitem][aria-label="Exportieren …"]').click()
    await dialog.waitFor({ state: 'visible', timeout: 15_000 })
  }
  const exportAs = async (format, { pageSize = null, pageNumbers = null } = {}) => {
    await openDialog()
    await dialog.locator(`[data-format="${format}"]`).click()
    if (pageSize) await dialog.locator('select[aria-label="Seitengröße"]').selectOption(pageSize)
    if (pageNumbers !== null) await dialog.locator('input[type=checkbox]').nth(1).setChecked(pageNumbers)
    const file = await captureDownload(page, profile, () => dialog.locator('.primary-button').click())
    await dialog.waitFor({ state: 'hidden', timeout: 15_000 })
    return file
  }

  await openDialog()
  const formats = await dialog.locator('[role=radio]').allTextContents()
  ok('the dialog offers PDF, Word, LaTeX and Markdown', ['PDF', 'Word (.docx)', 'LaTeX (.tex)', 'Markdown (.md)'].every((label) => formats.includes(label)), formats.join(', '))
  await page.keyboard.press('Escape')
  await dialog.waitFor({ state: 'hidden', timeout: 5000 })
  ok('Escape closes the dialog', true)

  // ---- PDF ---------------------------------------------------------------------------------------------
  const pdfFile = await exportAs('pdf')
  const bytes = fs.readFileSync(pdfFile)
  if (process.env.NOTE_EXPORT_KEEP) fs.copyFileSync(pdfFile, path.join(process.env.NOTE_EXPORT_KEEP, 'probe.pdf'))
  const pages = await readPdf(pdfFile)
  const all = squash(pages.map((entry) => entry.text).join(' '))
  ok('PDF: named after the note and a real PDF with at least one page', path.basename(pdfFile) === 'Probe.pdf' && bytes.subarray(0, 5).toString() === '%PDF-' && pages.length > 0, `${pages.length} page(s), ${bytes.length} bytes`)
  ok(`PDF: Unicode text is selectable (x ≤ 1, α→β${cjkFont ? ', 日本' : ''})`, ['x≤1', 'α→β', ...(cjkFont ? ['日本'] : [])].every((text) => all.includes(text)), all.slice(0, 160))
  ok('PDF: heading, table cells and code are in the text', ['Exportprobe', 'Tabelle', 'Alpha', '17', 'Beta', '42', 'constanswer=42'.replace('constanswer', 'const answer').replace(/\s/gu, '')].every((text) => all.includes(squash(text))), all.slice(0, 200))
  const formula = all.slice(all.indexOf('display:'))
  ok('PDF: math is rendered with KaTeX (inline a, b, c and the display sum)', ['a', 'b', 'c', '=', '∑', 'i=1'].every((text) => formula.includes(text)), formula.slice(0, 60))
  ok('PDF: A4 page by default (595 x 842 pt)', Math.abs(pages[0].view[2] - 595) < 3 && Math.abs(pages[0].view[3] - 842) < 3, pages[0].view.join(' '))
  ok('PDF: the footer shows the page number', /1\s*\/\s*1/u.test(pages[0].text), pages[0].text.slice(-40))
  const imageOps = await (async () => {
    const document = await pdfjs.getDocument({ data: new Uint8Array(bytes), verbosity: 0 }).promise
    const list = await (await document.getPage(1)).getOperatorList()
    return list.fnArray.filter((fn) => fn === pdfjs.OPS.paintImageXObject || fn === pdfjs.OPS.paintInlineImageXObject || fn === pdfjs.OPS.paintImageMaskXObject).length
  })()
  ok('PDF: the picture from the vault is drawn', imageOps > 0, `${imageOps} image operator(s)`)

  const letter = await readPdf(await exportAs('pdf', { pageSize: 'letter', pageNumbers: false }))
  ok('PDF: Letter size (612 x 792 pt) and no footer when page numbers are off', Math.abs(letter[0].view[2] - 612) < 3 && Math.abs(letter[0].view[3] - 792) < 3 && !/1\s*\/\s*1/u.test(letter[0].text), letter[0].view.join(' '))

  // ---- DOCX --------------------------------------------------------------------------------------------
  await openDialog()
  ok('the dialog remembers the last choices (Letter, no page numbers)', await dialog.locator('select[aria-label="Seitengröße"]').inputValue() === 'letter' && !(await dialog.locator('input[type=checkbox]').nth(1).isChecked()))
  await page.keyboard.press('Escape')
  await dialog.waitFor({ state: 'hidden', timeout: 5000 })
  const docxFile = await exportAs('docx')
  const zip = await JSZip.loadAsync(fs.readFileSync(docxFile))
  const document = await zip.file('word/document.xml').async('string')
  ok('DOCX: named after the note and unzips with its parts', path.basename(docxFile) === 'Probe.docx' && Boolean(zip.file('[Content_Types].xml')) && Boolean(zip.file('word/styles.xml')))
  ok('DOCX: document.xml has a table, OMML math and Word heading styles', document.includes('<w:tbl>') && document.includes('<m:oMath>') && /<w:pStyle w:val="Heading1"\/>/u.test(document) && /<w:pStyle w:val="Heading2"\/>/u.test(document))
  ok('DOCX: the picture is in word/media', Object.keys(zip.files).some((name) => /^word\/media\/image\d+\.png$/u.test(name)))
  ok('DOCX: Unicode and table text survive; Letter page size from the options', ['x ≤ 1, α→β, 日本', 'Alpha', '42'].every((text) => document.includes(text)) && document.includes('w:w="12240" w:h="15840"'))

  // ---- LaTeX and Markdown ------------------------------------------------------------------------------
  const texFile = await exportAs('latex')
  ok('LaTeX stays available as a format', path.basename(texFile) === 'Probe.tex' && fs.readFileSync(texFile, 'utf8').startsWith('\\documentclass'))
  const mdFile = await exportAs('markdown')
  ok('Markdown export is a ZIP with the note text and its picture', path.basename(mdFile) === 'Probe.zip' && Boolean((await JSZip.loadAsync(fs.readFileSync(mdFile))).file('Probe/Probe.md')) && Object.keys((await JSZip.loadAsync(fs.readFileSync(mdFile))).files).some((name) => name.startsWith('Probe/images/')))
  await sleep(500)
} catch (error) {
  ok('note export flow ran to the end', false, error instanceof Error ? error.stack : error)
} finally {
  await stop(app, browser)
  profile.dispose()
}
console.log(failed() ? `note export: ${failed()} of ${count()} checks failed` : `note export: all ${count()} checks passed`)
process.exit(failed() ? 1 : 0)
