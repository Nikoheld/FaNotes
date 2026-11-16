// Highlighter on a PDF comes off like pen ink: the eraser and undo remove
// highlighter strokes and PDF text highlights ("Markieren", "Wichtiges
// markieren"), and only what lies under the eraser.
// Part 1: logic. Part 2: real Chromium via playwright-core (skipped with
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

// ---- Part 1: logic -------------------------------------------------------
{
  const marks = await server.ssrLoadModule('/src/lib/pdfTextMarks.ts')
  const erase = await server.ssrLoadModule('/src/lib/pdfMarkErase.ts')
  const host = await server.ssrLoadModule('/src/lib/pdfMarkEraseHost.ts')
  const texts = ['Seite 1', 'Erste Zeile Licht', 'Zweite Zeile Licht', 'Dritte Zeile Licht', 'Licht']
  const passage = { id: 'a', page: 1, quote: 'Erste Zeile Licht Zweite Zeile Licht Dritte Zeile Licht', kind: 'highlight' }
  const other = { id: 'b', page: 2, quote: 'Erste Zeile Licht', kind: 'highlight' }
  const painted = (list) => marks.spanIndexesForQuotes(texts, list.filter((mark) => mark.page === 1))
  assert.deepEqual(painted([passage]), [1, 2, 3])

  // Erasing the middle line keeps the lines above and below, and nothing else.
  const middle = marks.unmarkPdfSpans([passage, other], 1, texts, [2])
  assert.deepEqual(painted(middle), [1, 3], 'only the erased line loses its highlight')
  assert.ok(middle.includes(other), 'a mark on another page is untouched')
  // The kept "Dritte Zeile Licht" must not light up the lone "Licht" span, nor
  // "Erste Zeile Licht" another occurrence: remnants are pinned to their place.
  assert.ok(middle.filter((mark) => mark.page === 1).every((mark) => Number.isInteger(mark.nth)))
  assert.equal(marks.unmarkPdfSpans(middle, 1, texts, [4]), middle, 'erasing plain text changes nothing')
  assert.equal(marks.unmarkPdfSpans(middle, 1, texts, []), middle)
  assert.deepEqual(painted(marks.unmarkPdfSpans(middle, 1, texts, [1, 3])), [], 'erasing the rest leaves no highlight')

  // A short quote that occurs twice: erasing one occurrence keeps the other.
  const twice = [{ id: 'c', page: 1, quote: 'Licht', kind: 'highlight' }]
  assert.deepEqual(painted(twice), [1, 2, 3, 4])
  assert.deepEqual(painted(marks.unmarkPdfSpans(twice, 1, texts, [4])), [1, 2, 3])
  assert.deepEqual(painted(marks.unmarkPdfSpans(twice, 1, texts, [2])), [1, 3, 4])

  // nth survives the note round trip; marks without it read as before.
  const note = marks.writePdfMarks('# PDF\n', middle)
  const back = marks.readPdfMarks(note)
  assert.deepEqual(painted(back), [1, 3])
  assert.equal('nth' in marks.readPdfMarks(marks.writePdfMarks('# PDF\n', [passage]))[0], false)
  assert.equal(marks.readPdfMarks(note.replace(/"nth": \d+/u, '"nth": "x"')).filter((mark) => mark.page === 1 && mark.nth === undefined).length, 1)
  // A pinned remnant does not block marking the same words everywhere again.
  const pinned = [{ id: 'p', page: 1, quote: 'Licht', kind: 'highlight', nth: 0 }]
  assert.equal(marks.addPdfMark(pinned, { page: 1, quote: 'Licht' }).length, 2)

  const unmarked = host.unmarkPdfNote(note, [{ page: 1, spanTexts: texts, spans: [1] }])
  assert.ok(unmarked)
  assert.deepEqual(painted(marks.readPdfMarks(unmarked.content)), [3])
  assert.equal(host.unmarkPdfNote(note, [{ page: 1, spanTexts: texts, spans: [4] }]), null)

  // Eraser geometry: disk swept along a path against a glyph box.
  const box = { left: 100, top: 100, right: 200, bottom: 120 }
  assert.equal(erase.eraserPathTouchesRect([{ x: 150, y: 110 }], 1, box), true)
  assert.equal(erase.eraserPathTouchesRect([{ x: 150, y: 130 }], 9, box), false)
  assert.equal(erase.eraserPathTouchesRect([{ x: 150, y: 130 }], 10, box), true)
  assert.equal(erase.eraserPathTouchesRect([{ x: 150, y: 60 }, { x: 150, y: 160 }], 1, box), true, 'a fast stroke across the line hits it')
  assert.equal(erase.eraserPathTouchesRect([{ x: 50, y: 50 }, { x: 250, y: 50 }], 20, box), false)
  assert.equal(erase.eraserPathTouchesRect([{ x: 50, y: 70 }, { x: 99, y: 99 }], 1.5, box), true)
  console.log('pdf highlighter erase logic ok')
}

// ---- Part 2: browser -----------------------------------------------------
const chromium = process.env.FANOTES_CHROMIUM ?? '/usr/bin/chromium'
const playwrightEntry = process.env.PLAYWRIGHT_CORE ?? '/srv/agents/fanotes/.site-redesign-tools/node_modules/playwright-core/index.mjs'
if (process.env.FANOTES_SKIP_BROWSER === '1' || !existsSync(chromium) || !existsSync(playwrightEntry)) {
  console.log('browser part skipped (no chromium / playwright-core)')
  await server.close()
  process.exit(0)
}
const { chromium: browserType } = await import(pathToFileURL(playwrightEntry).href)

const LINES = ['Erste Zeile Photosynthese', 'Zweite Zeile Zellatmung', 'Dritte Zeile Sauerstoff']
const buildPdf = (count) => {
  const objs = []
  objs[1] = '<< /Type /Catalog /Pages 2 0 R >>'
  objs[2] = `<< /Type /Pages /Kids [${Array.from({ length: count }, (_, i) => `${4 + i * 2} 0 R`).join(' ')}] /Count ${count} >>`
  objs[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
  for (let i = 0; i < count; i += 1) {
    const lines = LINES.map((line, index) => `BT /F1 16 Tf 60 ${700 - index * 30} Td (${line}) Tj ET`).join(' ')
    const stream = `BT /F1 24 Tf 60 760 Td (Seite ${i + 1}) Tj ET ${lines}`
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
const pdfPath = join(mkdtempSync(join(tmpdir(), 'fanotes-pdf-marker-')), 'Marker.pdf')
writeFileSync(pdfPath, buildPdf(2))

const address = server.httpServer.address()
const base = `http://127.0.0.1:${address.port}/?web`
const browser = await browserType.launch({ executablePath: chromium, args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'] })
const context = await browser.newContext({ viewport: { width: 1280, height: 1500 }, locale: 'de-CH' })
const page = await context.newPage()
const pageErrors = []
page.on('pageerror', (error) => pageErrors.push(String(error)))
const shot = (name) => process.env.FANOTES_SHOT_DIR ? page.screenshot({ path: join(process.env.FANOTES_SHOT_DIR, name) }) : null
const settle = (ms = 350) => page.waitForTimeout(ms)

// Summed alpha of every ink canvas at a client point.
const inkAlphaAt = ({ x, y }) => page.evaluate(([cx, cy]) => {
  let total = 0
  for (const canvas of document.querySelectorAll('.lw-drawing-board canvas')) {
    const rect = canvas.getBoundingClientRect()
    if (!rect.width || !rect.height || cx < rect.left || cx > rect.right || cy < rect.top || cy > rect.bottom) continue
    const context = canvas.getContext('2d', { willReadFrequently: true })
    if (!context) continue
    const px = Math.floor((cx - rect.left) * canvas.width / rect.width)
    const py = Math.floor((cy - rect.top) * canvas.height / rect.height)
    if (px < 0 || py < 0 || px >= canvas.width || py >= canvas.height) continue
    total += context.getImageData(px, py, 1, 1).data[3]
  }
  return total
}, [x, y])
const drag = async (from, to, steps = 18) => {
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move(to.x, to.y, { steps })
  await page.mouse.up()
  await settle(500)
}
const tool = async (name) => {
  await page.locator('.lw-draw-toolbar button', { hasText: name }).first().click()
  await settle(300)
}
const pageBox = () => page.evaluate(() => {
  const r = document.querySelector('[data-pdf-page="1"]').getBoundingClientRect()
  return { x: r.x, y: r.y, w: r.width, h: r.height }
})
// Text runs of page 1 and whether each is highlighted.
const textRuns = () => page.evaluate(() => [...document.querySelectorAll('[data-pdf-page="1"] .pdf-note-text-layer span')]
  .filter((span) => !span.querySelector('span') && span.textContent.trim())
  .map((span) => {
    const r = span.getBoundingClientRect()
    return { text: span.textContent.trim(), marked: span.classList.contains('pdf-anchored-mark'), x: r.x, y: r.y, w: r.width, h: r.height }
  }))
const markedLines = async () => (await textRuns()).filter((run) => run.marked).map((run) => run.text)
const selectLines = (from, to) => page.evaluate(([first, last]) => {
  const spans = [...document.querySelectorAll('[data-pdf-page="1"] .pdf-note-text-layer span')].filter((span) => !span.querySelector('span'))
  const a = spans.find((span) => span.textContent.includes(first))
  const b = spans.find((span) => span.textContent.includes(last))
  const range = document.createRange()
  range.setStart(a.firstChild, 0)
  range.setEnd(b.firstChild, b.firstChild.textContent.length)
  const selection = window.getSelection()
  selection.removeAllRanges()
  selection.addRange(range)
}, [from, to])
const waitForMarked = async (expected, label) => {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const lines = await markedLines()
    if (JSON.stringify(lines) === JSON.stringify(expected)) return
    await settle(150)
  }
  assert.deepEqual(await markedLines(), expected, label)
}
const enterPen = async () => {
  await page.locator('button[aria-label="Stift"], button[aria-label="Mit Stift schreiben"]').first().click()
  await page.waitForSelector('.lw-draw-toolbar.is-visible', { timeout: 20_000 })
  await settle(800)
}
const leavePen = async () => {
  await page.locator('button[aria-label="Tastatur"], button[aria-label="Zur Tastatur wechseln"]').first().click()
  await settle(800)
}

try {
  await page.goto(base, { waitUntil: 'domcontentloaded' })
  const startupSelector = '.first-run-continue, .pdf-import-button'
  await page.waitForSelector(startupSelector, { timeout: 45_000 }).catch(async () => {
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.waitForSelector(startupSelector, { timeout: 90_000 })
  })
  for (let step = 0; step < 6 && await page.locator('.first-run-continue').count(); step += 1) {
    await page.locator('.first-run-continue').first().click()
    await settle(900)
  }
  await page.waitForSelector('button.pdf-import-button', { timeout: 90_000 })
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.locator('button.pdf-import-button').first().click()])
  await chooser.setFiles(pdfPath)
  await page.waitForSelector('[data-pdf-page="2"]', { timeout: 40_000 })
  await page.waitForFunction(() => document.querySelectorAll('[data-pdf-page="1"] .pdf-note-text-layer span').length >= 4, null, { timeout: 30_000 })
  await settle(1500)

  // 1. PDF text highlight: mark three lines, then "Markieren" on a marked line takes it off.
  await selectLines(LINES[0], LINES[2])
  await page.locator('button[aria-label="Auswahl markieren"]').click()
  await waitForMarked(LINES, 'Markieren highlights the selected lines')
  await selectLines(LINES[2], LINES[2])
  await page.locator('button[aria-label="Auswahl markieren"]').click()
  await waitForMarked(LINES.slice(0, 2), '"Markieren" on a highlighted line removes only that highlight')
  await shot('pdf-marks-1-toggled.png')

  // 2. Highlighter ink: erase a piece, the rest and a neighbour stay.
  await enterPen()
  await tool('Zeichnen')
  await page.locator('button[aria-label="Textmarker"], button[title^="Textmarker"]').first().click()
  await settle(300)
  const rect = await pageBox()
  const row = (fy) => ({ a: { x: rect.x + rect.w * 0.25, y: rect.y + rect.h * fy }, b: { x: rect.x + rect.w * 0.75, y: rect.y + rect.h * fy } })
  const mid = (r) => ({ x: (r.a.x + r.b.x) / 2, y: r.a.y })
  const first = row(0.45)
  const keep = row(0.55)
  await drag(first.a, first.b)
  await drag(keep.a, keep.b)
  assert.ok(await inkAlphaAt(mid(first)) > 0, 'the highlighter stroke is painted')
  await tool('Radierer')
  await drag({ x: mid(first).x, y: first.a.y - 25 }, { x: mid(first).x, y: first.a.y + 25 }, 10)
  assert.equal(await inkAlphaAt(mid(first)), 0, 'the eraser removes the highlighter under it')
  assert.ok(await inkAlphaAt({ x: first.a.x + 20, y: first.a.y }) > 0, 'the rest of the erased stroke stays')
  assert.ok(await inkAlphaAt(mid(keep)) > 0, 'a stroke not under the eraser stays')

  // 3. Undo takes a fresh highlighter stroke off.
  await tool('Zeichnen')
  const third = row(0.65)
  await drag(third.a, third.b)
  assert.ok(await inkAlphaAt(mid(third)) > 0)
  await page.keyboard.press('Control+z')
  await settle(600)
  assert.equal(await inkAlphaAt(mid(third)), 0, 'undo removes the highlighter stroke')
  assert.ok(await inkAlphaAt(mid(keep)) > 0, 'undo leaves the other stroke')

  // 4. Crossing highlighters and highlighter over pen ink.
  const cross = row(0.75)
  await drag(cross.a, cross.b)
  const cx = mid(cross).x
  await drag({ x: cx, y: cross.a.y - 80 }, { x: cx, y: cross.a.y + 80 })
  await tool('Radierer')
  await drag({ x: cx - 25, y: cross.a.y }, { x: cx + 25, y: cross.a.y }, 10)
  assert.equal(await inkAlphaAt({ x: cx, y: cross.a.y }), 0, 'the crossing is erased')
  assert.ok(await inkAlphaAt({ x: cx, y: cross.a.y - 60 }) > 0, 'the crossing stroke keeps the part off the eraser')
  assert.ok(await inkAlphaAt({ x: cross.a.x + 30, y: cross.a.y }) > 0)
  await tool('Schreiben')
  const pen = row(0.38)
  await drag(pen.a, pen.b)
  await tool('Zeichnen')
  await drag(pen.a, pen.b)
  await tool('Radierer')
  const px = pen.a.x + 120
  await drag({ x: px, y: pen.a.y - 25 }, { x: px, y: pen.a.y + 25 }, 10)
  assert.equal(await inkAlphaAt({ x: px, y: pen.a.y }), 0, 'pen ink and highlighter under the eraser both go')
  assert.ok(await inkAlphaAt({ x: px + 80, y: pen.a.y }) > 0, 'pen ink and highlighter off the eraser stay')
  await shot('pdf-marks-2-ink.png')

  // 5. The eraser takes a PDF text highlight off: only the line under it.
  const runs = await textRuns()
  const line1 = runs.find((run) => run.text === LINES[0])
  assert.ok(line1?.marked)
  const lineY = line1.y + line1.h / 2
  const lineX = line1.x + line1.w / 2
  await drag({ x: lineX - 10, y: lineY - 4 }, { x: lineX + 10, y: lineY + 4 }, 6)
  await waitForMarked([LINES[1]], 'the eraser removes the highlight under it, not the next line')
  assert.ok(await inkAlphaAt(mid(keep)) > 0, 'erasing a text highlight leaves ink alone')
  await shot('pdf-marks-3-erased.png')

  // 6. Undo brings the highlight back, redo takes it off again.
  await page.keyboard.press('Control+z')
  await waitForMarked(LINES.slice(0, 2), 'undo restores the erased text highlight')
  await page.keyboard.press('Control+Shift+z')
  await waitForMarked([LINES[1]], 'redo erases it again')
  await page.keyboard.press('Control+z')
  await waitForMarked(LINES.slice(0, 2), 'undo once more')
  // Ink undo still works after it: the step before was the eraser cut through pen and highlighter.
  await page.keyboard.press('Control+z')
  await settle(600)
  assert.ok(await inkAlphaAt({ x: px, y: pen.a.y }) > 0, 'the next undo restores the erased ink')
  await page.keyboard.press('Control+Shift+z')
  await settle(600)
  await page.keyboard.press('Control+Shift+z')
  await waitForMarked([LINES[1]], 'redo through both steps')

  // 7. Persisted: reload and reopen.
  await leavePen()
  await settle(2500)
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.file-tree__entry-button', { timeout: 90_000 })
  await page.locator('.file-tree__entry-button', { hasText: 'Marker' }).first().click()
  await page.waitForFunction(() => document.querySelectorAll('[data-pdf-page="1"] .pdf-note-text-layer span').length >= 4, null, { timeout: 60_000 })
  await waitForMarked([LINES[1]], 'the erased highlight stays erased after a reload')
  assert.deepEqual(pageErrors, [], 'no page errors')
  console.log('pdf highlighter erase browser check ok')
} finally {
  await browser.close()
  await server.close()
}
