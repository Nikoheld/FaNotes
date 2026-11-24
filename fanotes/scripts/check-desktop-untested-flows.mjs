// Desktop flows the Linux/Windows QA reports could not cover, driven in the real app (Electron under Xvfb,
// playwright-core over CDP, temp profiles, synthetic vaults) and verified on disk:
//   pdf          annotate / highlight / erase / undo on a PDF, text marks, text fields on a PDF page
//   split        split view with the PDF in either pane
//   export       Export as PDF and LaTeX (content of the files), PDF import through the import action
//   history      version history restore; trash restore
//   account      account WITH password: create, sign out, wrong password, sign in on a second profile
//   share        share Decline and Block flows between two profiles, "Sync attachments" off
// The native dialogs are answered by scripts/electron-test-stub.cjs. Account and share flows run
// fanotes-site/server.mjs locally on a spare port (default 18996) with throwaway credentials and temp data;
// the production server is never contacted. Needs a built renderer (`vite build`), xvfb-run and playwright-core
// (PLAYWRIGHT_CORE). FANOTES_FLOW_ONLY=pdf,split,... runs a subset; FANOTES_SKIP_BROWSER=1 skips everything.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import {
  captureDownload, connect, createProfile, createReporter, dismissNotices, electronBinary, launch, makePdf, openFile,
  describeApp, root, routeSyncTo, sleep, startSite, stop, until, waitPdfRendered,
} from './lib/desktop-flow.mjs'

const require = createRequire(import.meta.url)
const famd = require('../electron/famd.cjs')

const xvfb = spawnSync('sh', ['-c', 'command -v xvfb-run'], { encoding: 'utf8' }).stdout.trim()
const skipReason = process.env.FANOTES_SKIP_BROWSER === '1' ? 'FANOTES_SKIP_BROWSER=1'
  : !xvfb ? 'no xvfb-run'
    : !fs.existsSync(path.join(root, 'dist', 'index.html')) ? 'no dist/ (run vite build)'
      : !fs.existsSync(electronBinary) ? 'no electron' : ''
if (skipReason) {
  console.log(`desktop untested flows: skipped (${skipReason})`)
  process.exit(0)
}
try { await import(process.env.PLAYWRIGHT_CORE || 'playwright-core') } catch {
  console.log('desktop untested flows: skipped (no playwright-core; set PLAYWRIGHT_CORE)')
  process.exit(0)
}

const only = (process.env.FANOTES_FLOW_ONLY ?? '').split(',').map((item) => item.trim()).filter(Boolean)
const wanted = (name) => only.length === 0 || only.includes(name)
const { ok, failed, count } = createReporter()
const sections = []
const section = (name, run) => sections.push({ name, run })

/** Runs `body` with a fresh app on a fresh profile and always cleans up. */
const withApp = async (profile, body, { site = null } = {}) => {
  const app = launch(profile)
  let browser = null
  let page = null
  try {
    const connected = await connect(app)
    page = connected.page
    browser = connected.browser
    if (site) await routeSyncTo(connected.page, site)
    await dismissNotices(connected.page)
    await body(connected.page, app)
    // Settings and the session are written with a short delay: let them land before the app is stopped.
    await sleep(5000)
  } catch (error) {
    if (/closed|crash|Target/iu.test(String(error))) console.log(`diagnostics: ${describeApp(app)}`)
    throw error
  } finally {
    await stop(app, browser)
  }
}

const drag = async (page, from, to, steps = 12) => {
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  for (let step = 1; step <= steps; step += 1) await page.mouse.move(from.x + (to.x - from.x) * step / steps, from.y + (to.y - from.y) * step / steps)
  await page.mouse.up()
  await sleep(500)
}
const pagePoint = async (page, number, u, v, scope = '') => {
  await page.evaluate(([selector]) => document.querySelector(selector)?.scrollIntoView({ block: 'center' }), [`${scope} [data-pdf-page="${number}"]`.trim()])
  await sleep(500)
  const box = await page.locator(`${scope} [data-pdf-page="${number}"]`.trim()).first().boundingBox()
  return { x: box.x + box.width * u, y: box.y + box.height * v }
}
const readFamd = (file) => (fs.existsSync(file) ? famd.parseFamd(fs.readFileSync(file, 'utf8')) : null)
const strokesOf = (file) => readFamd(file)?.payload?.ink?.strokes ?? []
const pointCount = (strokes) => strokes.reduce((sum, stroke) => sum + stroke.points.length, 0)
const waitFor = (check, what, timeout = 20_000) => until(check, what, timeout, 250).catch(() => false)

const labelsOf = (page, selector) => page.evaluate((query) => [...document.querySelectorAll(query)]
  .filter((node) => node.getBoundingClientRect().width > 0).map((node) => node.getAttribute('aria-label') || node.textContent.trim()), selector)

// ---- PDF: annotate, highlight, erase, undo, marks, text fields ------------------------------------------
section('pdf', async () => {
  const profile = createProfile('flow-pdf-')
  fs.mkdirSync(path.join(profile.vault, 'Biologie'))
  fs.writeFileSync(path.join(profile.vault, 'Biologie', 'Blatt.pdf'), makePdf())
  const companion = path.join(profile.vault, 'Biologie', 'Blatt.famd')
  try {
    await withApp(profile, async (page) => {
      await openFile(page, 'Blatt', 'Biologie')
      await waitPdfRendered(page)
      await sleep(1200)
      const toolbar = await labelsOf(page, '.pdf-note-toolbar button')
      ok('PDF toolbar buttons are present', ['Vorherige Seite', 'Nächste Seite', 'Auswahl markieren', 'Im PDF suchen', 'Seite drehen', 'Leere Seiten daneben'].every((label) => toolbar.includes(label)), toolbar.join(', '))
      const main = await labelsOf(page, '.toolbar button, .toolbar-button')
      ok('text field and link buttons are offered on a PDF, the worksheet import is not', main.includes('Textfeld einfügen') && main.includes('Verlinkung setzen') && !main.includes('Arbeitsblatt importieren'), main.join(', '))

      // Text mark (highlight of a text span) and its removal.
      await page.evaluate(() => {
        const span = [...document.querySelectorAll('[data-pdf-page="1"] span')].find((node) => /Seite 1/u.test(node.textContent ?? ''))
        const range = document.createRange()
        range.selectNodeContents(span)
        const selection = window.getSelection()
        selection.removeAllRanges()
        selection.addRange(range)
      })
      await page.locator('.pdf-note-toolbar button[aria-label="Auswahl markieren"]').click()
      ok('marking a text selection is written to the .famd companion', await waitFor(() => /Seite 1/u.test(readFamd(companion)?.markdown ?? ''), 'mark saved', 15_000))

      // Pen ink, highlighter, eraser, undo/redo.
      await page.locator('button[aria-label="Stift"]').first().click()
      await page.waitForSelector('.lw-drawing-board.is-input-active', { timeout: 20_000 })
      await sleep(800)
      await drag(page, await pagePoint(page, 1, 0.2, 0.4), await pagePoint(page, 1, 0.7, 0.4))
      ok('a pen stroke on the PDF is saved to the companion', await waitFor(() => strokesOf(companion).length === 1, 'pen stroke'), strokesOf(companion).length)
      const penPoints = strokesOf(companion)[0]?.points ?? []
      ok('the stroke is stored where it was drawn (page-relative, about y 0.4 of the first page)', penPoints.length > 3 && penPoints.every((point) => point.y > 0.1 && point.y < 0.45), JSON.stringify(penPoints[0]))

      await page.locator('.lw-draw-toolbar button', { hasText: 'Zeichnen' }).first().click()
      await page.locator('button[aria-label="Textmarker"], button[title^="Textmarker"]').first().click()
      await sleep(300)
      await drag(page, await pagePoint(page, 1, 0.2, 0.55), await pagePoint(page, 1, 0.7, 0.55))
      ok('a highlighter stroke is saved as its own stroke', await waitFor(() => strokesOf(companion).length === 2, 'highlighter stroke'), strokesOf(companion).length)
      const highlight = strokesOf(companion)[1]
      ok('the highlighter stroke keeps the highlighter brush', highlight?.brush === 'highlighter', JSON.stringify({ b: highlight?.brush, o: highlight?.opacity, p: highlight?.purpose, e: highlight?.colorEffect }))

      await page.locator('.lw-draw-toolbar button', { hasText: 'Radierer' }).first().click()
      await sleep(300)
      const crossing = await pagePoint(page, 1, 0.45, 0.4)
      const before = pointCount(strokesOf(companion))
      await drag(page, { x: crossing.x, y: crossing.y - 30 }, { x: crossing.x, y: crossing.y + 30 })
      ok('the area eraser cuts the pen stroke in two', await waitFor(() => strokesOf(companion).filter((stroke) => stroke.purpose !== 'art' && stroke.opacity === 1).length >= 2, 'eraser cut'), `${before} -> ${pointCount(strokesOf(companion))} points, ${strokesOf(companion).length} strokes`)
      await page.keyboard.press('Control+z')
      ok('undo puts the erased stroke back whole', await waitFor(() => strokesOf(companion).length === 2 && strokesOf(companion)[0].points.length === penPoints.length, 'undo erase'), `${strokesOf(companion).length} strokes`)
      await page.keyboard.press('Control+y')
      ok('redo erases again', await waitFor(() => strokesOf(companion).length === 3, 'redo erase'), `${strokesOf(companion).length} strokes`)
      await page.keyboard.press('Control+z')
      await page.keyboard.press('Control+z')
      ok('two more undos remove the highlighter stroke', await waitFor(() => strokesOf(companion).length === 1, 'undo highlighter'), `${strokesOf(companion).length} strokes`)

      // Text field on the PDF page.
      await page.locator('button[aria-label="Tastatur"], button[aria-label="Zur Tastatur wechseln"]').first().click().catch(() => {})
      await sleep(700)
      await page.locator('button[aria-label="Textfeld einfügen"]').click()
      const place = await pagePoint(page, 1, 0.3, 0.5)
      await page.mouse.click(place.x, place.y)
      await page.waitForSelector('textarea[data-note-text-field]', { timeout: 10_000 }).catch(async () => { throw new Error(`no text field after placing; placing layer: ${await page.locator('.note-text-layer.is-placing').count()}, drawing: ${await page.locator('.lw-drawing-board.is-input-active').count()}, button pressed: ${await page.locator('button[aria-label="Textfeld einfügen"]').getAttribute('aria-pressed')}`) })
      await page.keyboard.type('Hallo Feld')
      const away = await pagePoint(page, 1, 0.85, 0.8)
      await page.mouse.click(away.x, away.y)
      const field = await waitFor(() => readFamd(companion)?.payload?.textFields?.[0], 'text field saved')
      ok('a text field on the PDF page is saved page-relative with its text', field && field.page === 1 && field.text === 'Hallo Feld' && field.x > 0.25 && field.x < 0.35, JSON.stringify(field))
      ok('the pen stroke survived the text field write', strokesOf(companion).length === 1)
      // Move and resize controls of the text field.
      { const at = await pagePoint(page, 1, 0.4, 0.505); await page.mouse.click(at.x, at.y); await sleep(400) }
      const handle = await page.locator('button[aria-label="Textfeld verschieben"]').boundingBox()
      await drag(page, { x: handle.x + handle.width / 2, y: handle.y + handle.height / 2 }, { x: handle.x + handle.width / 2 + 120, y: handle.y + handle.height / 2 + 80 })
      const moved = await waitFor(() => { const next = readFamd(companion)?.payload?.textFields?.[0]; return next && next.x > field.x + 0.05 ? next : null }, 'text field moved')
      ok('dragging the move handle moves the text field on the PDF page', moved && moved.y > field.y, JSON.stringify([field.x, field.y, moved?.x, moved?.y]))
      { const at = await pagePoint(page, 1, moved.x + 0.1, moved.y + 0.005); await page.mouse.click(at.x, at.y); await sleep(400) }
      const grip = await page.locator('[aria-label="Textfeldbreite ändern"]').boundingBox()
      await drag(page, { x: grip.x + grip.width / 2, y: grip.y + grip.height / 2 }, { x: grip.x + grip.width / 2 + 100, y: grip.y + grip.height / 2 })
      const wider = await waitFor(() => { const next = readFamd(companion)?.payload?.textFields?.[0]; return next && next.width > (moved?.width ?? 0) + 0.03 ? next : null }, 'text field resized')
      ok('dragging the width handle resizes the text field', Boolean(wider), JSON.stringify([moved?.width, wider?.width]))
    })
  } finally {
    profile.dispose()
  }
})


// ---- Split view with a PDF in either pane ----------------------------------------------------------------
section('split', async () => {
  const profile = createProfile('flow-split-')
  fs.mkdirSync(path.join(profile.vault, 'Biologie'))
  fs.writeFileSync(path.join(profile.vault, 'Biologie', 'Blatt.pdf'), makePdf())
  fs.writeFileSync(path.join(profile.vault, 'Notiz.md'), '# Titel\n\nHallo Welt.\n')
  fs.writeFileSync(path.join(profile.vault, 'Biologie', 'Zwei.pdf'), makePdf(['[0 0 595 842]'], 'Zwei'))
  const companion = path.join(profile.vault, 'Biologie', 'Blatt.famd')
  const painted = (page, scope) => page.evaluate((selector) => [...document.querySelectorAll(`${selector} [data-pdf-page] canvas`)].some((canvas) => {
    if (!canvas.width || !canvas.height) return false
    const data = canvas.getContext('2d', { willReadFrequently: true })?.getImageData(0, 0, canvas.width, canvas.height).data
    if (!data) return false
    for (let index = 3; index < data.length; index += 4) if (data[index] > 0) return true
    return false
  }), scope)
  try {
    await withApp(profile, async (page) => {
      await openFile(page, 'Notiz')
      await page.waitForSelector('.cm-content', { timeout: 30_000 })
      await openFile(page, 'Blatt', 'Biologie')
      await waitPdfRendered(page)
      await page.locator('button[aria-label="Weitere Notizaktionen"]').first().click()
      await page.locator('[role=menuitem]', { hasText: 'Geteilte Ansicht' }).click()
      await page.waitForSelector('.split-pane', { timeout: 10_000 })
      ok('split view opens with the PDF in the main pane and the note in the second', await page.locator('.split-pane .cm-content').count() === 1 && await page.locator('.unified-note-view.is-main-pane [data-pdf-page]').count() === 2)
      ok('the PDF renders in the main pane next to the split note', await waitFor(() => painted(page, '.unified-note-view.is-main-pane'), 'main pdf painted'))
      // Typing in the split note does not disturb the PDF companion; ink on the PDF in the main pane works.
      await page.locator('.split-pane .cm-content').click()
      await page.keyboard.type(' Zweite Spalte')
      ok('typing in the split note is saved to its file', await waitFor(() => fs.readFileSync(path.join(profile.vault, 'Notiz.md'), 'utf8').includes('Zweite Spalte'), 'split note saved'))
      await page.locator('.unified-note-view.is-main-pane [data-pdf-page="1"]').first().click({ position: { x: 20, y: 20 } })
      await page.locator('button[aria-label="Stift"]').first().click()
      await page.waitForSelector('.lw-drawing-board.is-input-active', { timeout: 20_000 })
      await sleep(800)
      await drag(page, await pagePoint(page, 1, 0.2, 0.4, '.is-main-pane'), await pagePoint(page, 1, 0.6, 0.4, '.is-main-pane'))
      ok('ink on the main-pane PDF is saved while a note is split beside it', await waitFor(() => strokesOf(companion).length === 1, 'main pane ink'), strokesOf(companion).length)
      await page.locator('button[aria-label="Tastatur"], button[aria-label="Zur Tastatur wechseln"]').first().click().catch(() => {})
      await sleep(600)

      // Swap: now the PDF is in the second pane.
      await page.locator('button[aria-label="Notizen tauschen"]').click()
      await page.waitForSelector('.split-pane [data-pdf-page]', { timeout: 20_000 })
      ok('after the swap the PDF renders in the second pane', await waitFor(() => painted(page, '.split-pane'), 'split pdf painted'))
      const shareShown = () => page.evaluate(() => {
        const pane = document.querySelector('.split-pane .unified-note-view')?.getBoundingClientRect()
        const sheet = document.querySelector('.split-pane [data-pdf-page="1"]')?.getBoundingClientRect()
        if (!pane || !sheet) return 0
        const width = Math.max(0, Math.min(pane.right, sheet.right) - Math.max(pane.left, sheet.left))
        const height = Math.max(0, Math.min(pane.bottom, sheet.bottom) - Math.max(pane.top, sheet.top))
        return Math.round(100 * width * height / (pane.width * pane.height))
      })
      const visible = await shareShown()
      ok('a PDF opened in the second pane starts with page 1 filling the pane (not off to a corner)', visible >= 60, `${visible}% of the pane shows page 1`)
      // Text mark in the second-pane PDF.
      await page.evaluate(() => {
        const span = [...document.querySelectorAll('.split-pane [data-pdf-page="1"] span')].find((node) => /Seite 1/u.test(node.textContent ?? ''))
        const range = document.createRange()
        range.selectNodeContents(span)
        const selection = window.getSelection()
        selection.removeAllRanges()
        selection.addRange(range)
      })
      const paneBar = await labelsOf(page, '.split-pane .pdf-note-toolbar button')
      ok('a PDF in the second pane has its own PDF toolbar (pages, zoom, search, mark)', ['Vorherige Seite', 'Nächste Seite', 'Vergrößern', 'Im PDF suchen', 'Auswahl markieren'].every((label) => paneBar.includes(label)), paneBar.join(', ') || 'no toolbar in the pane')
      await page.locator('.split-pane .pdf-note-toolbar button[aria-label="Auswahl markieren"]').click({ timeout: 5000 })
      ok('a text mark made in the second-pane PDF is saved to the PDF companion', await waitFor(() => /Seite 1/u.test(readFamd(companion)?.markdown ?? ''), 'split mark saved', 15_000))
      await sleep(1500)
      const later = await shareShown()
      ok('the second-pane PDF stays in view after the toolbar and marks settle', later >= 60, `${later}%`)
      // Ink on a PDF stays in the main pane by design; the second pane says so instead of silently ignoring the pen.
      await page.locator('.split-pane [data-pdf-page="1"]').first().click({ position: { x: 20, y: 20 } })
      await page.locator('button[aria-label="Stift"]').first().click()
      ok('the pen on a second-pane PDF explains that PDF ink needs the main pane', await waitFor(() => page.locator('text=Handschrift auf einem PDF gibt es in der Hauptspalte').count(), 'pen hint', 6000))
      ok('the second-pane PDF ink board is not opened', await page.locator('.split-pane .lw-drawing-board').count() === 0)
      ok('the earlier main-pane stroke is intact', strokesOf(companion)[0]?.points.length > 3)

      // Two PDFs side by side: each pane has exactly one PDF bar.
      await page.locator('button[aria-label="Teilung schließen"]').click()
      await openFile(page, 'Blatt', 'Biologie')
      await waitPdfRendered(page)
      await openFile(page, 'Zwei', 'Biologie')
      await waitPdfRendered(page)
      await page.locator('button[aria-label="Weitere Notizaktionen"]').first().click()
      await page.locator('[role=menuitem]', { hasText: 'Geteilte Ansicht' }).click()
      await page.waitForSelector('.split-pane [data-pdf-page]', { timeout: 20_000 })
      await sleep(1500)
      const bars = await page.evaluate(() => [document.querySelectorAll('.split-pane .pdf-note-toolbar').length, document.querySelectorAll('.toolbar-context .pdf-note-toolbar').length])
      ok('two PDFs side by side show one PDF bar per pane', bars[0] === 1 && bars[1] === 1, JSON.stringify(bars))
      const titles = await page.evaluate(() => [document.querySelector('.split-pane .pdf-note-identity strong')?.textContent, document.querySelector('.toolbar-context .pdf-note-identity strong')?.textContent])
      ok('each bar belongs to its own PDF', titles[0] === 'Blatt' && titles[1] === 'Zwei', JSON.stringify(titles))
    })
  } finally {
    profile.dispose()
  }
})

// ---- Export as PDF and LaTeX, PDF import -------------------------------------------------------------------
section('export', async () => {
  const profile = createProfile('flow-export-')
  fs.mkdirSync(path.join(profile.vault, 'Biologie'))
  fs.writeFileSync(path.join(profile.vault, 'Biologie', 'Blatt.pdf'), makePdf(['[0 0 595 842]', '[0 0 842 595]'], 'Original'))
  const longLine = `Lang ${'wort '.repeat(40)}Ende`
  const rows = Array.from({ length: 60 }, (_, index) => `Zeile ${index + 1}`)
  fs.writeFileSync(path.join(profile.vault, 'Notiz.md'), ['# Größe & Maß', '', 'Rabatt 100 % und a_b mit #Tag, Formel $x^2 + y^2$ fertig.', '', longLine, '', ...rows, ''].join('\n'))
  const external = path.join(profile.temporary, 'extern')
  fs.mkdirSync(external)
  const importSource = path.join(external, 'Arbeitsblatt Eins.pdf')
  fs.writeFileSync(importSource, makePdf(['[0 0 595 842]', '[0 0 595 842]', '[0 0 595 842]'], 'Import'))
  try {
    await withApp(profile, async (page) => {
      await openFile(page, 'Notiz')
      await page.waitForSelector('.cm-content', { timeout: 30_000 })
      const dialog = page.locator('.note-export-dialog')
      const exportVia = async (format) => {
        await page.locator('button[aria-label="Weitere Notizaktionen"]').first().click()
        await page.locator('[role=menuitem][aria-label="Exportieren …"]').click()
        await dialog.waitFor({ state: 'visible', timeout: 15_000 })
        await dialog.locator(`[data-format="${format}"]`).click()
        const file = await captureDownload(page, profile, () => dialog.locator('.primary-button').click())
        await dialog.waitFor({ state: 'hidden', timeout: 15_000 })
        return file
      }
      const pdfFile = await exportVia('pdf')
      const pdfBytes = fs.readFileSync(pdfFile)
      const pdfjs = await import(path.join(root, 'node_modules/pdfjs-dist/legacy/build/pdf.mjs'))
      const pdfDocument = await pdfjs.getDocument({ data: new Uint8Array(pdfBytes), verbosity: 0 }).promise
      let pdfText = ''
      for (let number = 1; number <= pdfDocument.numPages; number += 1) pdfText += `${(await (await pdfDocument.getPage(number)).getTextContent()).items.map((item) => item.str).join(' ')} `
      const flat = pdfText.replace(/\s+/gu, '')
      ok('Export as PDF writes a valid PDF named after the note', path.basename(pdfFile) === 'Notiz.pdf' && pdfBytes.subarray(0, 5).toString() === '%PDF-' && pdfDocument.numPages >= 1, `${pdfDocument.numPages} pages`)
      ok('the PDF keeps umlauts and the note text as selectable text', flat.includes('Größe&Maß') && flat.includes('Rabatt100%'), flat.slice(0, 80))
      ok('the PDF holds every row of the note', rows.every((row) => flat.includes(row.replace(/\s+/gu, ''))) && flat.includes('Ende'))
      const texFile = await exportVia('latex')
      const tex = fs.readFileSync(texFile, 'utf8')
      ok('Export as LaTeX is a complete document with the note title', path.basename(texFile) === 'Notiz.tex' && tex.startsWith('\\documentclass{article}') && tex.includes('\\title{Notiz}') && tex.trimEnd().endsWith('\\end{document}'))
      ok('LaTeX escapes text specials and keeps the formula and umlauts', tex.includes('100 \\% und a\\_b mit \\#Tag') && tex.includes('$x^2 + y^2$') && tex.includes('Größe \\& Maß'), tex.split('\n').slice(6, 9).join(' / '))

      // A PDF note exports as its PDF, never as an empty page.
      await openFile(page, 'Blatt', 'Biologie')
      await waitPdfRendered(page)
      await sleep(800)
      const pdfNoteExport = await exportVia('pdf')
      const exported = fs.readFileSync(pdfNoteExport)
      // The export is the original PDF with the user's marks drawn on; without marks it keeps the pages and text.
      const exportedDocument = await pdfjs.getDocument({ data: new Uint8Array(exported), verbosity: 0 }).promise
      const exportedPages = []
      for (let number = 1; number <= exportedDocument.numPages; number += 1) {
        const exportedPage = await exportedDocument.getPage(number)
        const viewport = exportedPage.getViewport({ scale: 1 })
        exportedPages.push({ landscape: viewport.width > viewport.height, text: (await exportedPage.getTextContent()).items.map((item) => item.str).join('') })
      }
      ok('exporting a PDF note saves the PDF itself (its pages and text), not an empty sheet', exported.subarray(0, 5).toString() === '%PDF-' && exportedPages.length === 2 && !exportedPages[0].landscape && exportedPages[1].landscape && exportedPages.every((entry) => entry.text.includes('Original')), JSON.stringify(exportedPages))
      await page.locator('button[aria-label="Weitere Notizaktionen"]').first().click()
      await page.locator('[role=menuitem][aria-label="Exportieren …"]').click()
      await dialog.waitFor({ state: 'visible', timeout: 15_000 })
      ok('LaTeX export is not offered for a PDF note, and Word is', await dialog.locator('[data-format="latex"]').count() === 0 && await dialog.locator('[data-format="docx"]').isEnabled())
      await page.keyboard.press('Escape')
      await dialog.waitFor({ state: 'hidden', timeout: 5000 })

      // Import through the import action; the native file dialog is answered by the test stub.
      profile.answerDialogs({ open: [importSource] })
      const created = await page.evaluate(() => window.fanotes.importPdfNote(''))
      ok('PDF import copies the file into the vault under its own name', created?.relativePath === 'Arbeitsblatt Eins.pdf' && fs.readFileSync(path.join(profile.vault, 'Arbeitsblatt Eins.pdf')).equals(fs.readFileSync(importSource)))
      ok('PDF import creates the .famd companion next to it', fs.existsSync(path.join(profile.vault, 'Arbeitsblatt Eins.famd')))
      const again = await page.evaluate(() => window.fanotes.importPdfNote(''))
      ok('importing the same PDF again gets a numbered name instead of overwriting', again?.relativePath !== created?.relativePath && fs.existsSync(path.join(profile.vault, again.relativePath)), again?.relativePath)
      profile.answerDialogs({})
      ok('cancelling the dialog imports nothing', (await page.evaluate(() => window.fanotes.importPdfNote(''))) === null)
      await page.locator('.file-tree__row', { hasText: 'Arbeitsblatt Eins' }).first().waitFor({ state: 'visible', timeout: 15_000 })
      await openFile(page, 'Arbeitsblatt Eins')
      await waitPdfRendered(page)
      ok('the imported PDF opens with all three pages', await waitFor(async () => (await page.locator('[data-pdf-page]').count()) === 3, 'three pages', 10_000))
      // The import button in the sidebar goes through the same action.
      fs.copyFileSync(importSource, path.join(external, 'Zweiter.pdf'))
      profile.answerDialogs({ open: [path.join(external, 'Zweiter.pdf')] })
      await page.locator('.sidebar button', { hasText: 'PDF' }).first().click()
      ok('the PDF button in the sidebar imports a file', await waitFor(() => fs.existsSync(path.join(profile.vault, 'Zweiter.pdf')), 'sidebar import'))
    })
  } finally {
    profile.dispose()
  }
})

// ---- Version history restore and trash restore ----------------------------------------------------------------
section('history', async () => {
  const profile = createProfile('flow-history-')
  fs.mkdirSync(path.join(profile.vault, 'Biologie'))
  fs.writeFileSync(path.join(profile.vault, 'Biologie', 'Blatt.pdf'), makePdf())
  const notePath = path.join(profile.vault, 'Notiz.md')
  fs.writeFileSync(notePath, '# Titel\n\nVersion eins\n')
  const companion = path.join(profile.vault, 'Biologie', 'Blatt.famd')
  const snapshots = () => {
    const root = path.join(profile.vault, '.fanotes', 'history')
    if (!fs.existsSync(root)) return []
    return fs.readdirSync(root).flatMap((directory) => {
      const index = path.join(root, directory, 'index.json')
      return fs.existsSync(index) ? [{ directory, index: JSON.parse(fs.readFileSync(index, 'utf8')) }] : []
    })
  }
  try {
    await withApp(profile, async (page) => {
      await openFile(page, 'Notiz')
      await page.waitForSelector('.cm-content', { timeout: 30_000 })
      await page.locator('.cm-content').click()
      await page.keyboard.press('Control+End')
      await page.keyboard.type('Version zwei')
      ok('the edit reaches the file', await waitFor(() => fs.readFileSync(notePath, 'utf8').includes('Version zwei'), 'edit saved'))
      ok('saving recorded the previous version in the local history', await waitFor(() => snapshots().some((entry) => entry.index.path === 'Notiz.md' && entry.index.snapshots?.length >= 1 || entry.index.entries?.length >= 1), 'snapshot recorded'), JSON.stringify(snapshots()).slice(0, 200))
      await page.locator('button[aria-label="Weitere Notizaktionen"]').first().click()
      await page.locator('[role=menuitem]', { hasText: 'Versionsverlauf' }).click()
      await page.waitForSelector('.history-dialog li', { timeout: 10_000 })
      ok('the history dialog lists the earlier version', await page.locator('.history-dialog li').count() >= 1)
      await page.locator('.history-dialog li button', { hasText: 'Wiederherstellen' }).first().click()
      ok('restoring a version puts its text into the editor', await waitFor(async () => /Version eins/u.test(await page.locator('.cm-content').innerText()) && !/Version zwei/u.test(await page.locator('.cm-content').innerText()), 'restored in editor', 10_000))
      await page.keyboard.press('Control+s')
      ok('the restored version is saved back to the file', await waitFor(() => { const text = fs.readFileSync(notePath, 'utf8'); return text.includes('Version eins') && !text.includes('Version zwei') }, 'restored on disk'), fs.readFileSync(notePath, 'utf8').replace(/\n/gu, '|'))
      ok('the dialog closed after the restore', await page.locator('.history-dialog').count() === 0)

      // A PDF note: its history is the .famd companion with the handwriting.
      await openFile(page, 'Blatt', 'Biologie')
      await waitPdfRendered(page)
      await page.locator('button[aria-label="Stift"]').first().click()
      await page.waitForSelector('.lw-drawing-board.is-input-active', { timeout: 20_000 })
      await sleep(800)
      await drag(page, await pagePoint(page, 1, 0.2, 0.3), await pagePoint(page, 1, 0.6, 0.3))
      ok('first PDF stroke saved', await waitFor(() => strokesOf(companion).length === 1, 'stroke a'))
      await drag(page, await pagePoint(page, 1, 0.2, 0.5), await pagePoint(page, 1, 0.6, 0.5))
      ok('second PDF stroke saved', await waitFor(() => strokesOf(companion).length === 2, 'stroke b'))
      ok('the PDF companion has a snapshot of the earlier ink', await waitFor(() => snapshots().some((entry) => /Blatt\.famd$/u.test(entry.index.path ?? '')), 'pdf snapshot'), JSON.stringify(snapshots().map((entry) => entry.index.path)))
      await page.locator('button[aria-label="Tastatur"], button[aria-label="Zur Tastatur wechseln"]').first().click().catch(() => {})
      await sleep(600)
      await page.locator('button[aria-label="Weitere Notizaktionen"]').first().click()
      await page.locator('[role=menuitem]', { hasText: 'Versionsverlauf' }).click()
      await page.waitForSelector('.history-dialog li', { timeout: 10_000 })
      await page.locator('.history-dialog li button', { hasText: 'Wiederherstellen' }).first().click()
      ok('restoring a PDF note version brings back its earlier handwriting (one stroke)', await waitFor(() => strokesOf(companion).length === 1, 'pdf restore on disk', 20_000), `${strokesOf(companion).length} strokes on disk`)
    })
  } finally {
    profile.dispose()
  }
})

section('trash', async () => {
  const profile = createProfile('flow-trash-')
  fs.mkdirSync(path.join(profile.vault, 'Biologie'))
  fs.writeFileSync(path.join(profile.vault, 'Biologie', 'Blatt.pdf'), makePdf())
  fs.writeFileSync(path.join(profile.vault, 'Notiz.md'), '# Titel\n\nBleibt erhalten\n')
  const trashFiles = path.join(profile.home, '.local', 'share', 'Trash', 'files')
  const trashMenu = async (page, name) => {
    await page.locator('.file-tree__row', { hasText: name }).first().click({ button: 'right' })
    await page.locator('[role=menuitem], .context-menu button', { hasText: 'In Papierkorb' }).first().click()
    await page.locator('.confirm-dialog button', { hasText: 'Verschieben' }).click()
  }
  try {
    await withApp(profile, async (page) => {
      await openFile(page, 'Notiz')
      await page.waitForSelector('.cm-content', { timeout: 30_000 })
      await trashMenu(page, 'Notiz')
      ok('the note leaves the vault and lands in the system trash', await waitFor(() => !fs.existsSync(path.join(profile.vault, 'Notiz.md')) && fs.existsSync(path.join(trashFiles, 'Notiz.md')), 'trashed'), fs.existsSync(trashFiles) ? fs.readdirSync(trashFiles).join(',') : 'no trash dir')
      ok('the note disappears from the tree and its tab closes', await waitFor(async () => (await page.locator('.file-tree__row', { hasText: 'Notiz' }).count()) === 0 && (await page.locator('.tabs-bar [role=tab]', { hasText: 'Notiz' }).count()) === 0, 'tree updated', 10_000))
      // Restore like a file manager does: move the file back.
      fs.renameSync(path.join(trashFiles, 'Notiz.md'), path.join(profile.vault, 'Notiz.md'))
      ok('a note restored from the trash shows up again in the tree', await waitFor(async () => (await page.locator('.file-tree__row', { hasText: 'Notiz' }).count()) === 1, 'restored in tree', 20_000), (await page.locator('.file-tree__row').allInnerTexts()).join(' | '))
      await openFile(page, 'Notiz')
      await page.waitForSelector('.cm-content', { timeout: 30_000 })
      ok('the restored note opens with its text', await waitFor(async () => /Bleibt erhalten/u.test(await page.locator('.cm-content').innerText()), 'restored text', 10_000))
      await page.locator('.cm-content').click()
      await page.keyboard.press('Control+End')
      await page.keyboard.type(' mehr')
      ok('the restored note can be edited and saved again', await waitFor(() => fs.readFileSync(path.join(profile.vault, 'Notiz.md'), 'utf8').includes('mehr'), 'edit after restore'))

      // A PDF note takes its handwriting companion to the trash and back.
      await openFile(page, 'Blatt', 'Biologie')
      await waitPdfRendered(page)
      await page.locator('button[aria-label="Stift"]').first().click()
      await page.waitForSelector('.lw-drawing-board.is-input-active', { timeout: 20_000 })
      await sleep(800)
      await drag(page, await pagePoint(page, 1, 0.2, 0.3), await pagePoint(page, 1, 0.6, 0.3))
      const companion = path.join(profile.vault, 'Biologie', 'Blatt.famd')
      ok('stroke saved before trashing the PDF', await waitFor(() => strokesOf(companion).length === 1, 'stroke saved'))
      await page.locator('button[aria-label="Tastatur"], button[aria-label="Zur Tastatur wechseln"]').first().click().catch(() => {})
      await sleep(600)
      await trashMenu(page, 'Blatt')
      ok('the PDF and its handwriting companion both go to the trash', await waitFor(() => !fs.existsSync(path.join(profile.vault, 'Biologie', 'Blatt.pdf')) && !fs.existsSync(companion) && fs.existsSync(path.join(trashFiles, 'Blatt.pdf')) && fs.existsSync(path.join(trashFiles, 'Blatt.famd')), 'pdf trashed'), fs.readdirSync(trashFiles).join(','))
      fs.renameSync(path.join(trashFiles, 'Blatt.pdf'), path.join(profile.vault, 'Biologie', 'Blatt.pdf'))
      fs.renameSync(path.join(trashFiles, 'Blatt.famd'), companion)
      await page.locator('.file-tree__row', { hasText: 'Blatt' }).first().waitFor({ state: 'visible', timeout: 20_000 }).catch(() => {})
      await openFile(page, 'Blatt', 'Biologie')
      await waitPdfRendered(page)
      ok('the restored PDF note opens with its handwriting', await waitFor(() => page.evaluate(() => [...document.querySelectorAll('.lw-drawing-board canvas')].some((canvas) => {
        const data = canvas.width ? canvas.getContext('2d', { willReadFrequently: true })?.getImageData(0, 0, canvas.width, canvas.height).data : null
        if (!data) return false
        for (let index = 3; index < data.length; index += 4) if (data[index] > 0) return true
        return false
      })), 'ink painted', 15_000))
    })
  } finally {
    profile.dispose()
  }
})

// ---- Accounts with a password, shares, "Sync attachments" ---------------------------------------------------
const PASSWORD = 'correct horse battery staple'
const openSync = async (page) => {
  if (!(await page.locator('.settings-nav').count())) { await page.locator('.file-tree').first().click({ position: { x: 5, y: 5 }, force: true }).catch(() => {}); await page.keyboard.press('Control+,'); await page.waitForSelector('.settings-nav', { timeout: 15_000 }) }
  await page.locator('.settings-nav button', { hasText: 'Konto, Geräte und Verschlüsselung' }).first().click()
  await sleep(500)
}
const closeSettings = async (page) => {
  await page.keyboard.press('Escape')
  if (await page.locator('.settings-nav').count()) await page.locator('button[aria-label="Schließen"]').first().click({ timeout: 3000 }).catch(() => {})
  await page.waitForSelector('.settings-nav', { state: 'detached', timeout: 5000 }).catch(() => {})
}
const accountForm = (page, mode, name, password, repeat = password) => (async () => {
  await page.locator('.sync-mode-switch button', { hasText: mode === 'register' ? 'Konto erstellen' : 'Anmelden' }).click()
  const form = page.locator('form.sync-form').first()
  await form.locator('input[type=text]').first().fill(name)
  await form.locator('input[type=password]').first().fill(password)
  if (mode === 'register') await form.locator('input[type=password]').nth(1).fill(repeat)
  await form.locator('button[type=submit]').click()
})()
const syncNotice = (page) => page.locator('.backup-notice').first().innerText().catch(() => '')
const signedInAs = (page) => page.locator('.sync-status-card strong').first().innerText().catch(() => null)
/** Every file below `directory` that contains `needle` (as UTF-8 text). */
const filesContaining = (directory, needle) => {
  const hits = []
  const walk = (entry) => {
    let info
    try { info = fs.lstatSync(entry) } catch { return }
    if (info.isSymbolicLink()) return
    if (info.isDirectory()) { for (const name of fs.readdirSync(entry)) walk(path.join(entry, name)); return }
    if (info.size > 20_000_000) return
    try { if (fs.readFileSync(entry).includes(needle)) hits.push(entry) } catch { /* unreadable */ }
  }
  walk(directory)
  return hits
}
const waitNotice = (page, pattern, timeout = 60_000) => waitFor(async () => pattern.test(await syncNotice(page)), `notice ${pattern}`, timeout)

section('account', async () => {
  const first = createProfile('flow-acct-a-')
  const second = createProfile('flow-acct-b-')
  fs.writeFileSync(path.join(first.vault, 'Geteilt.md'), '# Titel\n\nVon Gerät A\n')
  const site = await startSite(first.temporary)
  try {
    await withApp(first, async (page) => {
      await openSync(page)
      await accountForm(page, 'register', 'alice.test', PASSWORD, `${PASSWORD}x`)
      ok('a mismatching password repeat is rejected', await waitNotice(page, /nicht überein|stimmen/u, 10_000) || (await page.locator('input[type=password]:invalid').count()) > 0, await syncNotice(page))
      await accountForm(page, 'register', 'alice.test', PASSWORD)
      ok('creating an account with a password signs in', await waitFor(async () => (await signedInAs(page)) === 'alice.test', 'signed in', 90_000), await syncNotice(page))
      ok('the server stores the account, never the password', fs.existsSync(site.data) && filesContaining(site.data, PASSWORD).length === 0)
      ok('the password is not written to the profile or the vault', filesContaining(first.temporary, PASSWORD).filter((file) => !file.startsWith(site.data)).length === 0, filesContaining(first.temporary, PASSWORD).map((file) => path.relative(first.temporary, file)).join(', '))

      await page.locator('button', { hasText: 'Abmelden' }).first().click()
      ok('signing out shows the sign-in form again', await waitFor(async () => (await page.locator('.sync-mode-switch').count()) === 1 && (await signedInAs(page)) === null, 'signed out', 30_000))
      ok('signing out keeps the notes on the device', fs.readFileSync(path.join(first.vault, 'Geteilt.md'), 'utf8').includes('Von Gerät A'))
      await accountForm(page, 'login', 'alice.test', 'wrong password 123')
      ok('a wrong password is refused with a clean German message and stays signed out', await waitNotice(page, /^Benutzername oder Passwort stimmen nicht\.$/u, 60_000) && (await signedInAs(page)) === null, await syncNotice(page))
      await accountForm(page, 'login', 'alice.test', PASSWORD)
      ok('the right password signs in again', await waitFor(async () => (await signedInAs(page)) === 'alice.test', 'signed in again', 90_000), await syncNotice(page))
      // Cloud sync is off for new accounts; switch it on and push the note.
      await page.locator('button[aria-label="Notizen in der Cloud synchronisieren"]').click()
      await page.locator('button', { hasText: 'Jetzt synchronisieren' }).first().click().catch(() => {})
      ok('with cloud sync on, the note is uploaded (usage shows a file)', await waitFor(async () => /[1-9]\d* (Dateien|Datei|files|file)/u.test(await page.locator('.sync-status-card').innerText().catch(() => '')), 'usage shows a file', 60_000))
      ok('the server holds only ciphertext of the note', filesContaining(site.data, 'Von Gerät A').length === 0 && filesContaining(site.data, 'Geteilt').length === 0)
    }, { site })

    // Second profile: wrong password, then the right one; the note arrives.
    await withApp(second, async (page) => {
      await openSync(page)
      await accountForm(page, 'login', 'alice.test', 'not the password')
      ok('a wrong password on a second profile is refused with the same message', await waitNotice(page, /^Benutzername oder Passwort stimmen nicht\.$/u, 60_000) && (await signedInAs(page)) === null, await syncNotice(page))
      await accountForm(page, 'login', 'alice.test', PASSWORD)
      ok('the second profile signs in with the password', await waitFor(async () => (await signedInAs(page)) === 'alice.test', 'second profile signed in', 90_000), await syncNotice(page))
      ok('signing in on a second device turns cloud sync on for it', (await page.locator('button[aria-label="Notizen in der Cloud synchronisieren"]').getAttribute('aria-checked')) === 'true')
      await page.locator('button', { hasText: 'Jetzt synchronisieren' }).first().click().catch(() => {})
      ok('the note from the first profile arrives in the second vault', await waitFor(() => fs.existsSync(path.join(second.vault, 'Geteilt.md')) && fs.readFileSync(path.join(second.vault, 'Geteilt.md'), 'utf8').includes('Von Gerät A'), 'note synced', 90_000), fs.readdirSync(second.vault).join(','))
    }, { site })
  } finally {
    await site.stop()
    first.dispose()
    second.dispose()
  }
})

section('share', async () => {
  const alice = createProfile('flow-share-a-')
  const bob = createProfile('flow-share-b-')
  fs.writeFileSync(path.join(alice.vault, 'Mappe.md'), '# Titel\n\nEins\n')
  fs.writeFileSync(path.join(alice.vault, 'Zwei.md'), '# Zwei\n\nZwei\n')
  fs.writeFileSync(path.join(alice.vault, 'Drei.md'), '# Drei\n\nDrei\n')
  fs.writeFileSync(path.join(alice.vault, 'Vier.md'), '# Vier\n\nVier\n')
  const site = await startSite(alice.temporary)
  const aliceApp = launch(alice)
  const bobApp = launch(bob)
  let aliceBrowser = null
  let bobBrowser = null
  try {
    const [a, b] = await Promise.all([connect(aliceApp), connect(bobApp)])
    aliceBrowser = a.browser
    bobBrowser = b.browser
    const pageA = a.page
    const pageB = b.page
    await Promise.all([routeSyncTo(pageA, site), routeSyncTo(pageB, site)])
    await Promise.all([dismissNotices(pageA), dismissNotices(pageB)])
    for (const [page, name] of [[pageA, 'alice.share'], [pageB, 'bob.share']]) {
      await openSync(page)
      await accountForm(page, 'register', name, PASSWORD)
    }
    ok('both accounts are created', await waitFor(async () => (await signedInAs(pageA)) === 'alice.share' && (await signedInAs(pageB)) === 'bob.share', 'both signed in', 120_000))
    await Promise.all([closeSettings(pageA), closeSettings(pageB)])

    const shareWithBob = async (file) => {
      await pageA.locator('.file-tree__row', { hasText: file }).first().click({ button: 'right' })
      await pageA.locator('[role=menuitem]', { hasText: 'Mit FaNotes-Benutzer teilen' }).first().click()
      await pageA.locator('.share-user-dialog input[type=text]').fill('bob.share')
      await pageA.locator('.share-user-status strong', { hasText: 'bob.share' }).waitFor({ timeout: 20_000 })
      await pageA.locator('.share-user-dialog .primary-button', { hasText: 'Teilen' }).click()
    }
    const shareStatuses = async () => pageA.locator('.share-user-list li').allInnerTexts().catch(() => [])
    const pull = async (page) => {
      await page.keyboard.press('Control+p')
      await page.keyboard.type('Jetzt synchronisieren')
      await sleep(400)
      await page.keyboard.press('Enter')
      await sleep(800)
    }
    const pullBob = () => pull(pageB)
    const pending = async () => {
      const head = pageB.locator('.shared-with-me__head').first()
      if (await head.count() && (await head.getAttribute('aria-expanded')) !== 'true') await head.click()
      return pageB.locator('.shared-with-me__request').allInnerTexts()
    }
    const waitPending = async (count) => waitFor(async () => { await pullBob(); return (await pending()).length === count }, `bob sees ${count} pending`, 60_000)

    // 1. Decline.
    await shareWithBob('Mappe')
    ok('alice sends a share (it waits for acceptance)', await waitFor(async () => (await shareStatuses()).some((line) => /bob\.share/u.test(line) && /wartet/u.test(line)), 'pending in dialog', 20_000), (await shareStatuses()).join(' / '))
    await pageA.locator('.share-user-dialog button', { hasText: 'Schließen' }).last().click()
    ok('bob sees the request with the sender and the note name', await waitPending(1) && /alice\.share/u.test((await pending())[0] ?? ''), (await pending()).join(' | '))
    await pageB.locator('.shared-with-me__request button', { hasText: 'Ablehnen' }).first().click()
    ok('declining removes the request and puts nothing in bob\'s vault', await waitFor(async () => (await pending()).length === 0, 'request gone', 20_000) && !fs.readdirSync(bob.vault).some((name) => /Mappe/u.test(name)), fs.readdirSync(bob.vault).join(','))
    ok('declined shares do not block the sender', (await pageB.locator('.shared-with-me__blocked, [data-blocked]').count()) === 0)
    await pageA.locator('.file-tree__row', { hasText: 'Mappe' }).first().click({ button: 'right' })
    await pageA.locator('[role=menuitem]', { hasText: 'Mit FaNotes-Benutzer teilen' }).first().click()
    ok('alice sees the share as declined', await waitFor(async () => { await pull(pageA); return (await shareStatuses()).some((line) => /bob\.share/u.test(line) && /abgelehnt/u.test(line)) }, 'declined in dialog', 60_000), (await shareStatuses()).join(' / '))
    await pageA.locator('.share-user-dialog button', { hasText: 'Schließen' }).last().click()

    // 2. Block: decline plus block; later shares from alice never reach bob.
    await shareWithBob('Zwei')
    await pageA.locator('.share-user-dialog button', { hasText: 'Schließen' }).last().click()
    ok('a second request arrives', await waitPending(1))
    await pageB.locator('.shared-with-me__request button[title^="Ablehnen und weitere"]').first().click()
    ok('blocking removes the request', await waitFor(async () => (await pending()).length === 0, 'blocked request gone', 20_000))
    await shareWithBob('Drei')
    await pageA.locator('.share-user-dialog button', { hasText: 'Schließen' }).last().click()
    await sleep(2000)
    ok('after a block a new share from alice does not reach bob', await (async () => { for (let round = 0; round < 3; round += 1) { await pullBob(); await sleep(1500) } return (await pending()).length === 0 })())
    ok('bob\'s vault has none of the shared notes', !fs.readdirSync(bob.vault).some((name) => /Mappe|Zwei|Drei/u.test(name)), fs.readdirSync(bob.vault).join(','))
    // The block list in the settings: unblock lets a new share through.
    await openSync(pageB)
    const blockedRow = pageB.locator('.setting-row', { hasText: 'Blockiert' }).filter({ hasText: 'alice.share' })
    ok('the block list names alice and offers to unblock', await blockedRow.count() === 1)
    await blockedRow.locator('button', { hasText: 'Entsperren' }).click()
    ok('unblocking is confirmed and the list is empty again', await waitFor(async () => (await pageB.locator('.setting-row', { hasText: 'Blockiert' }).count()) === 0, 'unblocked'))
    await closeSettings(pageB)
    await shareWithBob('Vier')
    await pageA.locator('.share-user-dialog button', { hasText: 'Schließen' }).last().click()
    ok('after unblocking, a new share from alice reaches bob again', await waitPending(1) && /Vier/u.test((await pending())[0] ?? ''), (await pending()).join(' | '))
    await pageB.locator('.shared-with-me__request button', { hasText: 'Annehmen' }).first().click()
    ok('accepting puts the shared note into bob\'s vault with alice\'s text', await waitFor(() => filesContaining(bob.vault, 'Vier').length > 0, 'accepted note on disk', 60_000), fs.readdirSync(bob.vault).join(','))
  } finally {
    await stop(bobApp, bobBrowser)
    await stop(aliceApp, aliceBrowser)
    await site.stop()
    alice.dispose()
    bob.dispose()
  }
})

section('attachments', async () => {
  const first = createProfile('flow-att-a-')
  const second = createProfile('flow-att-b-')
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')
  fs.writeFileSync(path.join(first.vault, 'Notiz.md'), '# Titel\n\nNur Text\n')
  fs.writeFileSync(path.join(first.vault, 'Bild.png'), png)
  fs.writeFileSync(path.join(first.vault, 'Heft.pdf'), makePdf(['[0 0 595 842]'], 'Heft'))
  const site = await startSite(first.temporary)
  const toggle = (page, label) => page.locator(`button[aria-label="${label}"]`)
  const syncNow = async (page) => { await page.locator('button', { hasText: 'Jetzt synchronisieren' }).first().click(); await sleep(1500) }
  try {
    await withApp(first, async (page) => {
      await openSync(page)
      await accountForm(page, 'register', 'carol.att', PASSWORD)
      await waitFor(async () => (await signedInAs(page)) === 'carol.att', 'signed in', 90_000)
      ok('"Sync attachments" is on by default', (await toggle(page, 'Anhänge synchronisieren').getAttribute('aria-checked')) === 'true')
      await toggle(page, 'Anhänge synchronisieren').click()
      ok('the switch turns it off', (await toggle(page, 'Anhänge synchronisieren').getAttribute('aria-checked')) === 'false')
      await toggle(page, 'Notizen in der Cloud synchronisieren').click()
      await syncNow(page)
      await waitFor(async () => /[1-9]\d* (Dateien|Datei|files|file)/u.test(await page.locator('.sync-status-card').innerText().catch(() => '')), 'uploaded', 60_000)
    }, { site })
    await withApp(second, async (page) => {
      await openSync(page)
      await accountForm(page, 'login', 'carol.att', PASSWORD)
      await waitFor(async () => (await signedInAs(page)) === 'carol.att', 'second signed in', 90_000)
      await syncNow(page)
      ok('with attachments off the notes and the PDF arrive on the other profile', await waitFor(() => fs.existsSync(path.join(second.vault, 'Notiz.md')) && fs.existsSync(path.join(second.vault, 'Heft.pdf')), 'notes arrived', 90_000), fs.readdirSync(second.vault).join(','))
      await sleep(3000)
      ok('with attachments off the image is not uploaded', !fs.existsSync(path.join(second.vault, 'Bild.png')), fs.readdirSync(second.vault).join(','))
    }, { site })
    // Switching attachments on later uploads the image.
    await withApp(first, async (page) => {
      await openSync(page)
      ok('the account is still signed in after restarting the app', await waitFor(async () => (await signedInAs(page)) === 'carol.att', 'first still signed in', 60_000), await syncNotice(page))
      ok('the "Sync attachments" setting is remembered across a restart', (await toggle(page, 'Anhänge synchronisieren').getAttribute('aria-checked')) === 'false')
      await toggle(page, 'Anhänge synchronisieren').click()
      await syncNow(page)
      await sleep(2000)
    }, { site })
    await withApp(second, async (page) => {
      await openSync(page)
      ok('the second profile is still signed in with cloud sync on after a restart', await waitFor(async () => (await signedInAs(page)) === 'carol.att' && (await toggle(page, 'Notizen in der Cloud synchronisieren').getAttribute('aria-checked')) === 'true', 'second restored', 60_000), `${await signedInAs(page)} / ${await syncNotice(page)}`)
      await syncNow(page)
      ok('switching attachments on later brings the image over', await waitFor(async () => { if (fs.existsSync(path.join(second.vault, 'Bild.png'))) return true; await syncNow(page); return false }, 'image arrived', 90_000))
      ok('the image arrives byte for byte', fs.existsSync(path.join(second.vault, 'Bild.png')) && fs.readFileSync(path.join(second.vault, 'Bild.png')).equals(png))
    }, { site })
  } finally {
    await site.stop()
    first.dispose()
    second.dispose()
  }
})

// ---- run ---------------------------------------------------------------------------------------------------
for (const { name, run } of sections) {
  if (!wanted(name)) continue
  const started = Date.now()
  try {
    await run()
  } catch (error) {
    ok(`${name}: flow ran to the end`, false, error instanceof Error ? error.message : error)
  }
  console.log(`-- ${name} done in ${Math.round((Date.now() - started) / 1000)} s`)
}
console.log(failed() ? `desktop untested flows: ${failed()} of ${count()} checks failed` : `desktop untested flows: all ${count()} checks passed`)
process.exit(failed() ? 1 : 0)
