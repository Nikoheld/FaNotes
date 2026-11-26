// Real Electron check for the worksheet follow-ups of #1465:
//   1. a pasted picture and a PDF worksheet appear in the PDF and Word export (typed note and handwriting note), at
//      their placement (size and offset as a share of the text width, in the flow where the sheet shows them),
//   2. replacing a picture keeps the old text boxes and marks (also in the worksheet JSON),
//   3. quitting inside the undo window of a removed picture leaves no orphaned asset, and a picture a note still
//      references is never deleted.
// Needs `vite build`, xvfb-run and playwright-core (PLAYWRIGHT_CORE). Synthetic vault and temp profile only.
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { captureDownload, connect, createProfile, createReporter, dismissNotices, electronBinary, launch, makePdf, openFile, quit, root, sleep, stop, until } from './lib/desktop-flow.mjs'

const require = createRequire(import.meta.url)
const xvfb = spawnSync('sh', ['-c', 'command -v xvfb-run'], { encoding: 'utf8' }).stdout.trim()
const skipReason = process.env.FANOTES_SKIP_BROWSER === '1' ? 'FANOTES_SKIP_BROWSER=1'
  : !xvfb ? 'no xvfb-run'
    : !fs.existsSync(path.join(root, 'dist', 'index.html')) ? 'no dist/ (run vite build)'
      : !fs.existsSync(electronBinary) ? 'no electron' : ''
if (skipReason) {
  console.log(`worksheet follow-ups: skipped (${skipReason})`)
  process.exit(0)
}
try { await import(process.env.PLAYWRIGHT_CORE || 'playwright-core') } catch {
  console.log('worksheet follow-ups: skipped (no playwright-core; set PLAYWRIGHT_CORE)')
  process.exit(0)
}
const { serializeFamd, emptyFamdPayload } = require('../electron/famd.cjs')
const JSZip = require('jszip')
const pdfjs = await import(path.join(root, 'node_modules/pdfjs-dist/legacy/build/pdf.mjs'))
const { ok, failed, count } = createReporter()

const makePng = (width, height) => {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0 })
  const crc = (buffer) => { let c = 0xffffffff; for (const byte of buffer) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0 }
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const out = Buffer.alloc(body.length + 8)
    out.writeUInt32BE(data.length, 0)
    body.copy(out, 4)
    out.writeUInt32BE(crc(body), body.length + 4)
    return out
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8
  header[9] = 2
  const raw = Buffer.alloc((width * 3 + 1) * height)
  for (let y = 0; y < height; y += 1) {
    const row = y * (width * 3 + 1)
    for (let x = 0; x < width; x += 1) {
      raw[row + 1 + x * 3] = Math.round((x / width) * 200) + 30
      raw[row + 2 + x * 3] = Math.round((y / height) * 180) + 40
      raw[row + 3 + x * 3] = 190
    }
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}

const NOW = '2026-11-26T10:00:00.000Z'
const worksheetsDirectory = (profile) => path.join(profile.vault, '.fanotes', 'worksheets')
const writeWorksheet = (profile, id, kind, extra = {}) => {
  const directory = worksheetsDirectory(profile)
  fs.mkdirSync(directory, { recursive: true })
  const extension = kind === 'pdf' ? '.pdf' : '.png'
  fs.writeFileSync(path.join(directory, `${id}${extension}`), kind === 'pdf' ? makePdf(['[0 0 595 420]', '[0 0 595 420]'], 'Seite') : makePng(400, 300))
  fs.writeFileSync(path.join(directory, `${id}.json`), JSON.stringify({
    schemaVersion: 1, id, title: kind === 'pdf' ? 'Aufgaben' : 'Bild', kind, mimeType: kind === 'pdf' ? 'application/pdf' : 'image/png',
    sourceRelativePath: `.fanotes/worksheets/${id}${extension}`, dataRelativePath: `.fanotes/worksheets/${id}.json`,
    createdAt: NOW, updatedAt: NOW, textBoxes: [], highlights: [], ...extra,
  }))
}
const worksheetFiles = (profile) => fs.existsSync(worksheetsDirectory(profile)) ? fs.readdirSync(worksheetsDirectory(profile)).sort() : []
const readJson = (profile, id) => JSON.parse(fs.readFileSync(path.join(worksheetsDirectory(profile), `${id}.json`), 'utf8'))

const MARKS = {
  textBoxes: [{ id: 'box-1', page: 1, x: 0.1, y: 0.1, width: 0.5, text: 'Alte Antwort', fontSize: 16 }],
  highlights: [{ id: 'mark-1', page: 1, x: 0.1, y: 0.5, width: 0.4, height: 0.1, color: 'rgba(255,230,0,0.5)' }],
}

/** Image boxes of one PDF page in points from the top-left corner (matrix of paintImageXObject under the CTM). */
const imageBoxes = async (pdf, number) => {
  const page = await pdf.getPage(number)
  const { width, height } = page.getViewport({ scale: 1 })
  const list = await page.getOperatorList()
  const stack = []
  let ctm = [1, 0, 0, 1, 0, 0]
  const mul = (m, n) => [m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1], m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3], m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]]
  const boxes = []
  list.fnArray.forEach((fn, index) => {
    const args = list.argsArray[index]
    if (fn === pdfjs.OPS.save) stack.push(ctm)
    else if (fn === pdfjs.OPS.restore) ctm = stack.pop() ?? ctm
    else if (fn === pdfjs.OPS.transform) ctm = mul(ctm, args)
    else if (process.env.WS_DEBUG && [pdfjs.OPS.paintFormXObjectBegin, pdfjs.OPS.paintImageMaskXObject, pdfjs.OPS.paintJpegXObject, pdfjs.OPS.paintImageXObjectRepeat].includes(fn)) console.log('op', fn)
    else if (fn === pdfjs.OPS.paintImageXObject || fn === pdfjs.OPS.paintInlineImageXObject) {
      const xs = [0, 1].flatMap((u) => [0, 1].map((v) => ctm[0] * u + ctm[2] * v + ctm[4]))
      const ys = [0, 1].flatMap((u) => [0, 1].map((v) => ctm[1] * u + ctm[3] * v + ctm[5]))
      boxes.push({ left: Math.min(...xs), top: height - Math.max(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys), pageWidth: width })
    }
  })
  return boxes
}
const textRows = async (pdf, number) => {
  const page = await pdf.getPage(number)
  const { height } = page.getViewport({ scale: 1 })
  return (await page.getTextContent()).items.filter((item) => item.str.trim()).map((item) => ({ text: item.str, top: height - item.transform[5] }))
}
const openPdf = (file) => pdfjs.getDocument({ data: new Uint8Array(fs.readFileSync(file)), useSystemFonts: false, standardFontDataUrl: path.join(root, 'node_modules/pdfjs-dist/standard_fonts/'), verbosity: 0 }).promise

const withApp = async (profile, run) => {
  const app = launch(profile)
  let browser = null
  try {
    const connected = await connect(app)
    browser = connected.browser
    await connected.page.setViewportSize({ width: 1280, height: 900 }).catch(() => {})
    await dismissNotices(connected.page)
    return await run(connected.page, app)
  } finally {
    await stop(app, browser)
  }
}

const exportVia = async (page, profile, format) => {
  const dialog = page.locator('.note-export-dialog')
  await page.locator('button[aria-label="Weitere Notizaktionen"]').first().click()
  await page.locator('[role=menuitem][aria-label="Exportieren …"]').click()
  await dialog.waitFor({ state: 'visible', timeout: 15_000 })
  await dialog.locator(`[data-format="${format}"]`).click()
  const file = await captureDownload(page, profile, () => dialog.locator('.primary-button').click())
  await dialog.waitFor({ state: 'hidden', timeout: 20_000 })
  return file
}

// ---- 1 and 2: export and replace -------------------------------------------------------------------------------
const exportSession = async () => {
  const profile = createProfile('worksheet-followups-')
  const paragraphs = Array.from({ length: 14 }, (_, index) => `Absatz ${index + 1} mit etwas Text.`)
  writeWorksheet(profile, 'float-image-1', 'image', { placement: { x: 0.5, y: 0.3, width: 0.3 }, aspect: 0.75, ...MARKS })
  writeWorksheet(profile, 'pdf-sheet-1', 'pdf')
  writeWorksheet(profile, 'ink-image-1', 'image', { placement: { x: 0.2, y: 0.15, width: 0.4 }, aspect: 0.75 })
  writeWorksheet(profile, 'legacy-image-1', 'image', { ...MARKS })
  fs.writeFileSync(path.join(profile.vault, 'Text.md'), `# Text\n\n${paragraphs.join('\n\n')}\n\n<!-- fanotes-worksheet:float-image-1 -->\n<!-- fanotes-worksheet:pdf-sheet-1 -->\n`)
  fs.writeFileSync(path.join(profile.vault, 'Alt.md'), '# Alt\n\nText davor.\n\n<!-- fanotes-worksheet:legacy-image-1 -->\n')
  const at = NOW
  const ink = {
    schemaVersion: 1, title: 'Seite', paperStyle: 'lines', sourceWidth: 900, sourceHeight: 1400, createdAt: at, updatedAt: at,
    strokes: [{ color: '#202333', baseWidth: 3.5, pressureEnabled: false, brush: 'fineliner', points: Array.from({ length: 30 }, (_u, k) => ({ x: 0.1 + k * 0.01, y: 0.5 + Math.sin(k / 3) * 0.01, t: k * 8, pressure: 0.5 })) }],
  }
  fs.writeFileSync(path.join(profile.vault, 'Tinte.famd'), serializeFamd('# Tinte\n\n<!-- fanotes-ink:ink-ws -->\n\nText der Tinte.\n\n<!-- fanotes-worksheet:ink-image-1 -->\n', { ...emptyFamdPayload(at), ink, paperStyle: 'lines' }))
  try {
    await withApp(profile, async (page) => {
      // --- Typed note: PDF and Word ---
      await openFile(page, 'Text')
      await until(() => page.locator('.sheet-image.is-floating img').first().evaluate((img) => img.complete && img.naturalWidth > 0).catch(() => false), 'float image loaded')
      await until(() => page.locator('.worksheet-pdf-page canvas').count().then((n) => n > 0), 'pdf worksheet shown')
      await sleep(800)
      // The line the picture sits beside on screen.
      const expectedAfter = await page.evaluate(() => {
        const frame = document.querySelector('.sheet-image.is-floating').getBoundingClientRect()
        const lines = [...document.querySelectorAll('.cm-line')].filter((line) => /^Absatz \d+/u.test(line.textContent ?? ''))
        let found = null
        for (const line of lines) if (line.getBoundingClientRect().top <= frame.top + 2) found = line.textContent.match(/^Absatz (\d+)/u)[1]
        return found
      })
      const pdfFile = await exportVia(page, profile, 'pdf')
      const pdf = await openPdf(pdfFile)
      const all = []
      for (let number = 1; number <= pdf.numPages; number += 1) for (const box of await imageBoxes(pdf, number)) all.push({ ...box, page: number })
      if (process.env.WS_DEBUG) console.log('pdf pages', pdf.numPages, fs.statSync(pdfFile).size, JSON.stringify(Object.keys(pdfjs.OPS).filter((k) => /image|Image/u.test(k))))
      const content = 595.28 - 2 * (22 / 25.4 * 72)
      const margin = 22 / 25.4 * 72
      const floating = all.find((box) => Math.abs(box.width / content - 0.3) < 0.03)
      ok('typed note PDF: the pasted picture is in the export at 30 % of the text width', Boolean(floating), JSON.stringify(all.map((box) => Math.round(box.width))))
      ok('typed note PDF: it sits at its horizontal offset (50 % of the text width)', floating && Math.abs((floating.left - margin) / content - 0.5) < 0.03, JSON.stringify(floating))
      const pdfPages = all.filter((box) => Math.abs(box.width / content - 1) < 0.04)
      ok('typed note PDF: both pages of the PDF worksheet follow as pictures', pdfPages.length === 2, `${pdfPages.length}`)
      if (floating && expectedAfter) {
        const rows = await textRows(pdf, floating.page)
        const above = rows.filter((row) => row.text.startsWith(`Absatz ${expectedAfter} `)).at(0)
        const next = rows.filter((row) => row.text.startsWith(`Absatz ${Number(expectedAfter) + 1} `)).at(0)
        ok(`typed note PDF: the picture sits right after the paragraph it floats beside on the sheet (Absatz ${expectedAfter})`, above && floating.top > above.top && (!next || floating.top < next.top), JSON.stringify({ above, next, top: floating.top }))
      } else ok('typed note PDF: placement line known', false, String(expectedAfter))
      const docxFile = await exportVia(page, profile, 'docx')
      const zip = await JSZip.loadAsync(fs.readFileSync(docxFile))
      const media = Object.keys(zip.files).filter((name) => /^word\/media\/[^/]+$/u.test(name))
      const documentXml = await zip.file('word/document.xml').async('string')
      const extents = [...documentXml.matchAll(/<wp:extent cx="(\d+)" cy="\d+"\/>/gu)].map((match) => Number(match[1]))
      ok('typed note Word: the picture and both PDF pages are embedded', media.length >= 3 && extents.length >= 3, `${media.length} media, ${extents.length} extents`)
      ok('typed note Word: the picture keeps its offset as an indent', /<w:ind w:left="\d{3,}"/u.test(documentXml))
      const original = makePng(400, 300)
      const embeddedMarks = (await Promise.all(media.map((name) => zip.file(name).async('nodebuffer')))).some((bytes) => bytes.length > 0 && !bytes.equals(original) && bytes.subarray(1, 4).toString() === 'PNG' && bytes.readUInt32BE(16) === 400)
      ok('typed note Word: the text box and mark of the picture are painted into it', embeddedMarks)

      // --- Handwriting note ---
      await openFile(page, 'Tinte')
      await page.waitForFunction(() => document.querySelector('.cm-content')?.textContent?.includes('Text der Tinte') && [...document.querySelectorAll('.lw-drawing-board canvas')].some((canvas) => canvas.width > 0), null, { timeout: 60_000 })
      await until(() => page.locator('.sheet-image.is-floating img').first().evaluate((img) => img.complete && img.naturalWidth > 0).catch(() => false), 'ink image loaded')
      await sleep(1200)
      const sheet = await page.evaluate(() => { const paper = document.querySelector('.unified-paper'); const frame = document.querySelector('.sheet-image').getBoundingClientRect(); const box = paper.getBoundingClientRect(); return { width: paper.offsetWidth, frameLeft: (frame.left - box.left) / box.width, frameTop: (frame.top - box.top) / box.width, frameWidth: frame.width / box.width } })
      const inkFile = await exportVia(page, profile, 'pdf')
      const inkPdf = await openPdf(inkFile)
      const inkBoxes = []
      for (let number = 1; number <= inkPdf.numPages; number += 1) for (const box of await imageBoxes(inkPdf, number)) inkBoxes.push({ ...box, page: number })
      const inkContent = 595.28 - 96
      const placed = inkBoxes.find((box) => Math.abs(box.width / inkContent - sheet.frameWidth) < 0.02)
      ok('handwriting note PDF: the pasted picture is in the export at the width it has on the sheet', Boolean(placed), JSON.stringify({ sheet, boxes: inkBoxes.map((box) => Math.round(box.width)) }))
      ok('handwriting note PDF: and at the same offset from the left edge', placed && Math.abs((placed.left - 48) / inkContent - sheet.frameLeft) < 0.02, JSON.stringify({ placed, frameLeft: sheet.frameLeft }))

      // --- Replace keeps the old marks ---
      await openFile(page, 'Alt')
      await until(() => page.locator('.sheet-image img').first().evaluate((img) => img.complete && img.naturalWidth > 0).catch(() => false), 'legacy image loaded')
      ok('replace: the old text box is shown before', await page.locator('.worksheet-textbox textarea').first().inputValue() === 'Alte Antwort')
      await page.locator('.sheet-image').first().click({ position: { x: 20, y: 150 } })
      const replacement = path.join(profile.temporary, 'neu.png')
      fs.writeFileSync(replacement, makePng(320, 320))
      await page.locator('input[data-sheet-image-file]').setInputFiles(replacement)
      await until(() => page.locator('.toast', { hasText: 'Bild ersetzt' }).count().then((n) => n > 0), 'replace toast', 15_000)
      await until(() => page.locator('.sheet-image img').first().evaluate((img) => img.complete && img.naturalWidth === 320).catch(() => false), 'replacement shown')
      const kept = await page.evaluate(() => ({ box: document.querySelector('.worksheet-textbox textarea')?.value ?? null, marks: document.querySelectorAll('.worksheet-highlight').length }))
      ok('replace: the old text box and mark are still on the new picture', kept.box === 'Alte Antwort' && kept.marks === 1, JSON.stringify(kept))
      const jsonIds = worksheetFiles(profile).filter((name) => name.endsWith('.json')).map((name) => name.slice(0, -5))
      const replacedId = jsonIds.find((id) => id !== 'legacy-image-1' && id !== 'float-image-1' && id !== 'pdf-sheet-1' && id !== 'ink-image-1')
      const stored = replacedId ? readJson(profile, replacedId) : null
      ok('replace: the worksheet JSON of the new picture carries them and the old files are gone', stored?.textBoxes?.[0]?.text === 'Alte Antwort' && stored.highlights?.length === 1 && !jsonIds.includes('legacy-image-1'), JSON.stringify({ jsonIds, boxes: stored?.textBoxes?.length }))
    })
  } finally {
    profile.dispose()
  }
}

// ---- 3: quitting in the undo window ------------------------------------------------------------------------------
const quitSession = async () => {
  const profile = createProfile('worksheet-orphans-')
  writeWorksheet(profile, 'remove-me-1', 'image', { placement: { x: 0.1, y: 0.2, width: 0.4 }, aspect: 0.75 })
  writeWorksheet(profile, 'keep-me-1', 'image', { placement: { x: 0.5, y: 0.2, width: 0.3 }, aspect: 0.75 })
  fs.writeFileSync(path.join(profile.vault, 'Eins.md'), '# Eins\n\nText.\n\n<!-- fanotes-worksheet:remove-me-1 -->\n')
  fs.writeFileSync(path.join(profile.vault, 'Zwei.md'), '# Zwei\n\nText.\n\n<!-- fanotes-worksheet:keep-me-1 -->\n')
  try {
    const app = launch(profile)
    let browser = null
    try {
      const connected = await connect(app)
      browser = connected.browser
      const { page } = connected
      await dismissNotices(page)
      await openFile(page, 'Eins')
      await until(() => page.locator('.sheet-image img').first().evaluate((img) => img.complete && img.naturalWidth > 0).catch(() => false), 'image loaded')
      await page.locator('.sheet-image').click()
      await page.locator('.sheet-image.is-selected').waitFor({ timeout: 5000 })
      await page.locator('.sheet-image-bar button[aria-label="Bild entfernen"]').click()
      await until(() => page.locator('.sheet-image').count().then((n) => n === 0), 'image removed')
      ok('quit: the files still exist inside the undo window', worksheetFiles(profile).includes('remove-me-1.png'))
      await quit(app, page)
      await until(() => app.child.exitCode !== null, 'app quit', 20_000).catch(() => {})
    } finally {
      await stop(app, browser)
    }
    const files = worksheetFiles(profile)
    ok('quit during the undo window: the removed picture leaves no orphaned files', !files.some((name) => name.startsWith('remove-me-1')), files.join(','))
    ok('quit during the undo window: a picture another note still references is kept', files.includes('keep-me-1.png') && files.includes('keep-me-1.json'), files.join(','))
    ok('quit: the note no longer carries the marker of the removed picture', !fs.readFileSync(path.join(profile.vault, 'Eins.md'), 'utf8').includes('remove-me-1'))
  } finally {
    profile.dispose()
  }
}

try {
  await exportSession()
  await quitSession()
} catch (error) {
  ok('worksheet follow-up flow ran to the end', false, error instanceof Error ? error.stack ?? error.message : String(error))
}
console.log(`worksheet follow-ups: ${count() - failed()}/${count()} checks passed`)
process.exit(failed() === 0 ? 0 : 1)
