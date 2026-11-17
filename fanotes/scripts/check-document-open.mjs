// Regression check: opening a document (note or PDF) is one smooth change.
// Bug: entering a document flickered - a PDF showed a "PDF wird vorbereitet"
// box (its own pdf.js worker booting, ~250 ms), then empty page frames, then
// the pages; a note with handwriting showed its text first and got its ink
// (and a taller sheet) a moment later.
// Part 1: the prepared-PDF hand-off (pure logic, fake documents).
// Part 2: real Chromium via playwright-core, frame by frame (skipped with
// FANOTES_SKIP_BROWSER=1 or when no browser exists).
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createServer } from 'vite'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const server = await createServer({
  root,
  appType: 'spa',
  logLevel: 'error',
  server: { host: '127.0.0.1', port: 0, fs: { strict: false } },
})
await server.listen()

// ---- Part 1: hand-off logic ----------------------------------------------
const prep = await server.ssrLoadModule('/src/lib/pdfPrepare.ts')
const destroyed = []
const fakeOpen = (name) => async () => ({
  pdf: { name, getPage: async () => ({ getViewport: () => ({ width: 100, height: 141 }) }) },
  task: { destroy: async () => { destroyed.push(name) } },
})
const bytes = async () => new Uint8Array([37, 80, 68, 70, 1, 2, 3])
let clock = 1_000
const now = () => clock

const a = await prep.preparePdfDocument('A.pdf', fakeOpen('A'), bytes, now)
assert.equal(a.pdf.name, 'A')
assert.equal(a.ratio, 1.41, 'page 1 ratio is measured while preparing')
assert.equal(a.size, 7)
assert.equal(prep.takePreparedPdfDocument('B.pdf', now), null, 'another path does not get it')
assert.equal(prep.takePreparedPdfDocument('A.pdf', now), a, 'the view takes the prepared document')
assert.equal(prep.takePreparedPdfDocument('A.pdf', now), null, 'a document is handed out once')
assert.deepEqual(destroyed, [], 'a taken document belongs to the view')

// A newer prepare wins; the older one is destroyed, never handed out.
let releaseSlow
const slow = prep.preparePdfDocument('A.pdf', async (data) => {
  await new Promise((resolve) => { releaseSlow = resolve })
  return fakeOpen('A2')(data)
}, bytes, now)
await new Promise((resolve) => setTimeout(resolve, 5))
const b = await prep.preparePdfDocument('B.pdf', fakeOpen('B'), bytes, now)
releaseSlow()
assert.equal(await slow, null)
assert.deepEqual(destroyed, ['A2'])
assert.equal(prep.takePreparedPdfDocument('A.pdf', now), null)
assert.equal(prep.takePreparedPdfDocument('B.pdf', now), b)

// Unclaimed documents expire.
await prep.preparePdfDocument('C.pdf', fakeOpen('C'), bytes, now)
clock += prep.PREPARED_PDF_TTL_MS + 1
assert.equal(prep.takePreparedPdfDocument('C.pdf', now), null, 'an expired document is not used')
assert.ok(destroyed.includes('C'))

// The view mounted while the read was still running: it claims that read.
let releaseD
const pendingD = prep.preparePdfDocument('D.pdf', async (data) => {
  await new Promise((resolve) => { releaseD = resolve })
  return fakeOpen('D')(data)
}, bytes, now)
await new Promise((resolve) => setTimeout(resolve, 5))
const claim = prep.claimPreparingPdfDocument('D.pdf', now)
releaseD()
const claimed = await claim
assert.equal(claimed?.pdf.name, 'D', 'a running prepare is claimed instead of read twice')
assert.equal(await pendingD, claimed)
assert.equal(await prep.claimPreparingPdfDocument('E.pdf'), null)

// Returned right after adoption (StrictMode replay): taken again, else destroyed.
prep.returnPreparedPdfDocument(claimed, now)
assert.equal(prep.takePreparedPdfDocument('D.pdf', now), claimed)
prep.returnPreparedPdfDocument(claimed, now)
clock += prep.RETURNED_PDF_TTL_MS + 1
assert.equal(prep.takePreparedPdfDocument('D.pdf', now), null)
assert.ok(destroyed.includes('D'))

// Unreadable or password PDFs are not prepared; the view loads them itself.
assert.equal(await prep.preparePdfDocument('F.pdf', async () => { throw Object.assign(new Error('pw'), { name: 'PasswordException' }) }, bytes, now), null)
assert.equal(await prep.preparePdfDocument('G.pdf', fakeOpen('G'), async () => new Uint8Array(), now), null)
prep.discardPreparedPdfDocument()
console.log('prepared PDF hand-off ok')

// Source guards: the viewer reuses one worker, the adoption is a layout effect.
const { readFileSync } = await import('node:fs')
const pdfDocumentSource = readFileSync(join(root, 'src/lib/pdfDocument.ts'), 'utf8')
assert.match(pdfDocumentSource, /worker: sharedViewerWorker\(/, 'the viewer passes its shared pdf.js worker')
const viewSource = readFileSync(join(root, 'src/components/PdfNoteView.tsx'), 'utf8')
assert.match(viewSource, /takePreparedPdfDocument\(path\)/)
assert.match(viewSource, /openPdfDocument\(bytes, password \|\| undefined, \{ viewer: true \}\)/)
console.log('source guards ok')

// ---- Part 2: browser -----------------------------------------------------
const chromium = process.env.FANOTES_CHROMIUM ?? '/usr/bin/chromium'
const playwrightEntry = process.env.PLAYWRIGHT_CORE ?? '/srv/agents/fanotes/.site-redesign-tools/node_modules/playwright-core/index.mjs'
if (process.env.FANOTES_SKIP_BROWSER === '1' || !existsSync(chromium) || !existsSync(playwrightEntry)) {
  console.log('browser part skipped (no chromium / playwright-core)')
  await server.close()
  process.exit(0)
}
const { chromium: browserType } = await import(pathToFileURL(playwrightEntry).href)

const buildPdf = (count) => {
  const objs = []
  objs[1] = '<< /Type /Catalog /Pages 2 0 R >>'
  objs[2] = `<< /Type /Pages /Kids [${Array.from({ length: count }, (_, i) => `${4 + i * 2} 0 R`).join(' ')}] /Count ${count} >>`
  objs[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
  for (let i = 0; i < count; i += 1) {
    const stream = `BT /F1 24 Tf 60 760 Td (Seite ${i + 1}) Tj ET`
    objs[4 + i * 2] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + i * 2} 0 R >>`
    objs[5 + i * 2] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`
  }
  let out = '%PDF-1.4\n'
  const offsets = []
  for (let i = 1; i < objs.length; i += 1) {
    offsets[i] = out.length
    out += `${i} 0 obj\n${objs[i]}\nendobj\n`
  }
  const xref = out.length
  out += `xref\n0 ${objs.length}\n0000000000 65535 f \n${offsets.slice(1).map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`
  out += `trailer\n<< /Size ${objs.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(out, 'latin1')
}
const pdfPath = join(mkdtempSync(join(tmpdir(), 'fanotes-open-')), 'Blatt.pdf')
writeFileSync(pdfPath, buildPdf(3))

const browser = await browserType.launch({ executablePath: chromium, args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'] })
const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'de-CH' })
const page = await context.newPage()
const pageErrors = []
page.on('pageerror', (error) => pageErrors.push(String(error)))
const settle = (ms) => page.waitForTimeout(ms)

// One sample per animation frame: what the sheet shows.
const startRecorder = () => page.evaluate(() => {
  const frames = []
  let on = true
  const sample = () => {
    const paper = document.querySelector('.unified-paper')
    const rect = paper?.getBoundingClientRect()
    const hidden = !paper || getComputedStyle(paper).visibility === 'hidden'
    const pdfCanvases = [...document.querySelectorAll('.pdf-note-canvas-host canvas')]
    frames.push({
      tab: document.querySelector('.note-tab.active')?.getAttribute('title') ?? document.querySelector('.note-tab.active')?.textContent?.trim() ?? '',
      pdf: Boolean(paper?.classList.contains('is-pdf-note')),
      hidden,
      rect: rect ? `${Math.round(rect.left)},${Math.round(rect.top)},${Math.round(rect.width)},${Math.round(rect.height)}` : '',
      // Present but still transparent is the slow-open fallback (its fade-in waits); visible is the flicker.
      status: [...document.querySelectorAll('.pdf-note-status')].some((node) => Number(getComputedStyle(node).opacity) > 0.05),
      pages: document.querySelectorAll('[data-pdf-page]').length,
      painted: pdfCanvases.filter((canvas) => canvas.width > 0 && canvas.style.visibility === 'visible').length,
      text: document.querySelector('.cm-content')?.textContent?.length ?? -1,
      ink: [...(paper?.querySelectorAll('canvas') ?? [])].filter((canvas) => !canvas.closest('.pdf-note-canvas-host') && canvas.width > 0).length,
    })
    if (on) requestAnimationFrame(sample)
  }
  requestAnimationFrame(sample)
  window.__stopOpenRecorder = () => { on = false; return frames }
})
const stopRecorder = () => page.evaluate(() => window.__stopOpenRecorder())

try {
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/?web`, { waitUntil: 'domcontentloaded' })
  const startup = '.first-run-continue, .pdf-import-button'
  await page.waitForSelector(startup, { timeout: 45_000 }).catch(async () => {
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.waitForSelector(startup, { timeout: 90_000 })
  })
  for (let step = 0; step < 6 && await page.locator('.first-run-continue').count(); step += 1) {
    await page.locator('.first-run-continue').first().click()
    await settle(900)
  }
  await page.waitForSelector('button.pdf-import-button', { timeout: 90_000 })
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.locator('button.pdf-import-button').first().click()])
  await chooser.setFiles(pdfPath)
  await page.waitForSelector('[data-pdf-page="2"]', { timeout: 40_000 })
  await settle(2000)

  // A note with text and handwriting.
  await page.locator('button[aria-label="Neue Notiz"], button[aria-label="New note"]').first().click()
  await page.waitForSelector('.cm-content', { timeout: 20_000 })
  await settle(600)
  await page.locator('.cm-content').click()
  await page.keyboard.type('# Titel\n\nText der Notiz.\nZweite Zeile.')
  await settle(1000)
  await page.keyboard.press('Control+d')
  await settle(2000)
  const box = await page.locator('.unified-paper').boundingBox()
  await page.mouse.move(box.x + 120, box.y + 200)
  await page.mouse.down()
  for (let i = 0; i < 30; i += 1) await page.mouse.move(box.x + 120 + i * 12, box.y + 200 + Math.sin(i / 3) * 30)
  await page.mouse.up()
  await settle(800)
  await page.keyboard.press('Control+d')
  await settle(2500)

  const tabs = page.locator('.note-tab')
  const titles = await tabs.allTextContents()
  const pdfTab = titles.findIndex((title) => /Blatt/.test(title))
  const noteTab = titles.length - 1
  assert.ok(pdfTab >= 0 && pdfTab !== noteTab, `tabs: ${titles.join(' | ')}`)

  for (let round = 0; round < 2; round += 1) {
    // Note -> PDF.
    await startRecorder()
    await tabs.nth(pdfTab).click()
    await settle(1500)
    let frames = await stopRecorder()
    let opened = frames.filter((frame) => frame.pdf)
    assert.ok(opened.length > 0, 'the PDF opened')
    assert.equal(opened.filter((frame) => frame.status).length, 0, 'no loading box between the note and the PDF')
    const laidOut = opened.filter((frame) => frame.pages > 0)
    assert.ok(laidOut.length && laidOut[0].pages >= 3, 'the PDF lays out its page column')
    assert.ok(opened.indexOf(laidOut[0]) <= 2, 'the page column is there within the first frames, not after a loading box')
    assert.equal(new Set(laidOut.map((frame) => frame.rect)).size, 1, `the sheet does not jump while the PDF opens: ${[...new Set(laidOut.map((frame) => frame.rect))].join(' / ')}`)
    const shownEmpty = laidOut.filter((frame) => !frame.hidden && frame.painted === 0)
    assert.ok(shownEmpty.length <= 1, `the PDF shows once painted, not as empty frames first (${shownEmpty.length} empty frames)`)
    assert.ok(opened.at(-1).painted > 0 && !opened.at(-1).hidden, 'the PDF ends up painted and visible')

    // PDF -> note with handwriting.
    await startRecorder()
    await tabs.nth(noteTab).click()
    await settle(1500)
    frames = await stopRecorder()
    opened = frames.filter((frame) => !frame.pdf && frame.text > 0)
    assert.ok(opened.length > 0, 'the note opened')
    assert.ok(opened[0].ink > 0, 'the note\'s first frame already shows its handwriting')
    assert.equal(new Set(opened.map((frame) => frame.rect)).size, 1, `the note sheet does not grow after it opened: ${[...new Set(opened.map((frame) => frame.rect))].join(' / ')}`)
    assert.equal(frames.filter((frame) => !frame.pdf && frame.text < 0 && frame.pages === 0 && frame.tab).length, 0, 'no empty sheet between the PDF and the note')
  }
  assert.deepEqual(pageErrors, [])
  console.log('document open browser check ok')
} finally {
  await browser.close()
  await server.close()
}
