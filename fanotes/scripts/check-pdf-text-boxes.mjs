// Regression check for the "Textfeld" tool on PDF notes.
// Part 1: pure logic (storage format, backward compatibility, geometry helpers).
// Part 2: real Chromium via playwright-core (skipped with FANOTES_SKIP_BROWSER=1 or when no browser exists).
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
const fields = await server.ssrLoadModule('/src/lib/noteTextField.ts')

// ---- Part 1: logic -------------------------------------------------------
const legacy = { id: 'tf-old', page: 2, x: 0.25, y: 0.4, width: 0.3, fontSize: 18, text: 'Alt äöü' }
const [loaded] = fields.parseNoteTextFields([legacy])
assert.deepEqual(loaded, legacy, 'a field written by an older build must load unchanged (no new keys)')
const styled = fields.parseNoteTextFields([{ ...legacy, color: '#C62F4A', bold: true }])[0]
assert.equal(styled.color, '#c62f4a')
assert.equal(styled.bold, true)
assert.equal(fields.parseNoteTextFields([{ ...legacy, color: 'red; background:url(x)', bold: 'yes' }])[0].color, undefined, 'only #rrggbb colours are stored')
assert.equal('bold' in fields.parseNoteTextFields([{ ...legacy, bold: 'yes' }])[0], false)
const patched = fields.patchNoteTextField([styled], 'tf-old', { color: undefined, bold: undefined })[0]
assert.equal('color' in patched || 'bold' in patched, false, 'clearing colour and bold drops the keys again')
assert.equal(fields.stepNoteTextFieldFontSize(16, 1), 18)
assert.equal(fields.stepNoteTextFieldFontSize(16, -1), 14)
assert.equal(fields.stepNoteTextFieldFontSize(48, 1), 48)
assert.equal(fields.stepNoteTextFieldFontSize(10, -1), 10)
assert.equal(fields.stepNoteTextFieldFontSize(17, 1), 18)
assert.equal(fields.stepNoteTextFieldFontSize(17, -1), 16)
const pages = [
  { page: 1, left: 100, top: 0, width: 400, height: 500 },
  { page: 2, left: 100, top: 520, width: 400, height: 500 },
]
assert.deepEqual(fields.noteTextFieldPointFromRects(pages, 300, 750), { page: 2, x: 0.5, y: 0.46 })
const gutter = fields.noteTextFieldPointFromRects(pages, 300, 515)
assert.equal(gutter.page, 2, 'the gutter snaps to the nearest page, not page 1')
assert.equal(gutter.y, 0)
assert.equal(fields.noteTextFieldPointFromRects(pages, 900, 1200).page, 2, 'dragging past the sheet clamps to the last page')
assert.equal(fields.noteTextFieldPointFromRects(pages, 900, 1200).x, 1)
console.log('text box logic ok')

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
const pdfPath = join(mkdtempSync(join(tmpdir(), 'fanotes-pdf-text-')), 'Textfelder.pdf')
writeFileSync(pdfPath, buildPdf(2))

const address = server.httpServer.address()
const base = `http://127.0.0.1:${address.port}/?web`
const browser = await browserType.launch({ executablePath: chromium, args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'] })
const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'en-US' })
const page = await context.newPage()
const pageErrors = []
page.on('pageerror', (error) => pageErrors.push(String(error)))
const shot = (name) => process.env.FANOTES_SHOT_DIR ? page.screenshot({ path: join(process.env.FANOTES_SHOT_DIR, name) }) : null

const TOOL = 'button.toolbar-button[aria-label="Insert text field"]'
const boxes = () => page.evaluate(() => [...document.querySelectorAll('[data-note-text-field]')].map((node) => {
  const rect = node.getBoundingClientRect()
  const wrap = node.closest('.note-text-field')
  return { id: node.getAttribute('data-note-text-field'), value: node.value, x: rect.x, y: rect.y, w: rect.width, h: rect.height, font: parseFloat(getComputedStyle(node).fontSize), weight: getComputedStyle(node).fontWeight, color: getComputedStyle(node).color, selected: wrap.classList.contains('is-selected'), focused: document.activeElement === node }
}))
const pageRect = (n) => page.evaluate((index) => {
  const rect = document.querySelector(`[data-pdf-page="${index}"]`).getBoundingClientRect()
  return { x: rect.x, y: rect.y, w: rect.width, h: rect.height }
}, n)
const near = (actual, expected, tolerance, label) => assert.ok(Math.abs(actual - expected) <= tolerance, `${label}: ${actual} vs ${expected}`)
const settle = (ms = 350) => page.waitForTimeout(ms)
const scrollPaperTo = async (n) => {
  await page.evaluate((index) => {
    const view = document.querySelector('.paper-view')
    const top = document.querySelector(`[data-pdf-page="${index}"]`).getBoundingClientRect().top - view.getBoundingClientRect().top
    view.scrollTop += top - 20
  }, n)
  await settle(500)
}
const placeAt = async (n, fx, fy) => {
  await page.locator(TOOL).click()
  const rect = await pageRect(n)
  const point = { x: rect.x + rect.w * fx, y: rect.y + rect.h * fy }
  await page.mouse.click(point.x, point.y)
  await settle()
  return point
}

try {
  await page.goto(base, { waitUntil: 'domcontentloaded' })
  // The cold Vite dev server occasionally stalls the first load: retry once.
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
  await page.waitForSelector('[data-pdf-page="2"]', { timeout: 40_000 }).catch(async (e) => { await page.screenshot({ path: '/srv/agents/fanotes/.site-redesign-tools/pdftext/fail.png' }); throw e })
  await settle(2500)

  // zoom in once so placement is checked on a zoomed sheet
  await page.locator('button[aria-label="Zoom in"]').last().click()
  await settle(800)

  // 1. place on page 1: box lands under the pointer, focused and selected at once
  const first = await placeAt(1, 0.3, 0.3)
  let list = await boxes()
  assert.equal(list.length, 1)
  assert.equal(list[0].focused, true, 'a placed box takes focus immediately')
  assert.equal(list[0].selected, true)
  near(list[0].x, first.x, 6, 'page 1 x')
  near(list[0].y, first.y, 6, 'page 1 y')
  await page.keyboard.type('Grüße äöü Größe')
  await page.keyboard.press('Delete')
  await page.keyboard.press('Backspace')
  await settle()
  list = await boxes()
  assert.equal(list[0].value, 'Grüße äöü Größ', 'typing, umlauts and edit keys stay inside the box')
  assert.equal(await page.locator('.note-text-field-toolbar').count(), 1, 'the floating toolbar shows for the selected box')
  await shot('pdf-text-box-selected.png')

  // long text grows the box instead of cutting it off
  const heightBefore = list[0].h
  await page.keyboard.type(' und noch viel mehr Text der in mehrere Zeilen umbrechen muss, damit das Feld wachsen kann')
  await settle()
  assert.ok((await boxes())[0].h > heightBefore + 10, 'the box auto-grows with its text')

  // 2. Escape finishes: toolbar gone, text kept
  await page.keyboard.press('Escape')
  await settle()
  list = await boxes()
  assert.equal(list.length, 1)
  assert.equal(list[0].focused, false)
  assert.equal(list[0].selected, false)
  assert.equal(await page.locator('.note-text-field-toolbar').count(), 0)

  // 3. an empty box vanishes when left
  await placeAt(1, 0.7, 0.2)
  assert.equal((await boxes()).length, 2)
  const outside = await pageRect(1)
  await page.mouse.click(outside.x + 20, outside.y + 20)
  await settle()
  assert.equal((await boxes()).length, 1, 'an empty box is removed when the user clicks elsewhere')

  // 4. place on page 2 after scrolling
  await scrollPaperTo(2)
  const second = await placeAt(2, 0.5, 0.2)
  list = await boxes()
  assert.equal(list.length, 2)
  const secondBox = list.find((item) => item.focused)
  assert.ok(secondBox, 'the page-2 box is focused')
  near(secondBox.x, second.x, 6, 'page 2 x')
  near(secondBox.y, second.y, 6, 'page 2 y')
  await page.keyboard.type('Seite zwei')
  // toolbar: bigger font, bold, colour
  await page.locator('.note-text-field-toolbar button[aria-label="Larger text"], .note-text-field-toolbar button[aria-label="Schrift größer"]').click()
  await page.locator('.note-text-field-toolbar button[aria-pressed][aria-label="Bold"], .note-text-field-toolbar button[aria-label="Fett"]').click()
  await page.locator('.note-text-field-toolbar button[aria-label="Blue"], .note-text-field-toolbar button[aria-label="Blau"]').click()
  await settle()
  list = await boxes()
  const styledBox = list.find((item) => item.value === 'Seite zwei')
  assert.equal(styledBox.focused, true, 'toolbar buttons do not steal focus from the text')
  assert.ok(styledBox.weight === '700' || styledBox.weight === 'bold')
  assert.equal(styledBox.color, 'rgb(37, 99, 201)')
  assert.equal(styledBox.font > 16, true, 'larger text step applied')

  // 5. move with the grip, across no page boundary
  const gripBox = await page.locator('.note-text-field.is-selected .note-text-field-move').boundingBox()
  assert.ok(gripBox && gripBox.width >= 20, 'the drag handle is visible and big enough')
  const beforeMove = (await boxes()).find((item) => item.value === 'Seite zwei')
  await page.mouse.move(gripBox.x + gripBox.width / 2, gripBox.y + gripBox.height / 2)
  await page.mouse.down()
  await page.mouse.move(gripBox.x + gripBox.width / 2 - 60, gripBox.y + gripBox.height / 2 + 40, { steps: 6 })
  await page.mouse.up()
  await settle()
  const afterMove = (await boxes()).find((item) => item.value === 'Seite zwei')
  near(afterMove.x - beforeMove.x, -60, 8, 'move dx')
  near(afterMove.y - beforeMove.y, 40, 8, 'move dy')
  // 6. resize
  const handle = await page.locator('.note-text-field.is-selected .note-text-field-resize').boundingBox()
  const widthBefore = (await boxes()).find((item) => item.value === 'Seite zwei').w
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2)
  await page.mouse.down()
  await page.mouse.move(handle.x + handle.width / 2 + 80, handle.y + handle.height / 2, { steps: 5 })
  await page.mouse.up()
  await settle()
  near((await boxes()).find((item) => item.value === 'Seite zwei').w - widthBefore, 80, 10, 'resize dw')
  await shot('pdf-text-box-edited.png')

  // dragging into the gutter between pages must not teleport the box
  await scrollPaperTo(2)
  const gutterGrip = await page.locator('.note-text-field.is-selected .note-text-field-move').boundingBox()
  const gutterY = await page.evaluate(() => {
    const a = document.querySelector('[data-pdf-page="1"]').getBoundingClientRect()
    const b = document.querySelector('[data-pdf-page="2"]').getBoundingClientRect()
    return (a.bottom + b.top) / 2
  })
  await page.mouse.move(gutterGrip.x + gutterGrip.width / 2, gutterGrip.y + gutterGrip.height / 2)
  await page.mouse.down()
  await page.mouse.move(gutterGrip.x + gutterGrip.width / 2, gutterY, { steps: 8 })
  await page.mouse.up()
  await settle()
  const afterGutter = (await boxes()).find((item) => item.value === 'Seite zwei')
  assert.ok(Math.abs(afterGutter.y - gutterY) < 120, `a drop in the gutter keeps the box next to the gutter (${afterGutter.y} vs ${gutterY}), not a jump to the top of page 1`)
  await scrollPaperTo(2)

  // 7. typing never fires sheet shortcuts ('[' and ']' rotate the sheet)
  await page.keyboard.type('[]0')
  await settle()
  assert.ok((await boxes()).some((item) => item.value.endsWith('[]0')), 'tool/view keys type text instead of firing')
  assert.equal(await page.evaluate(() => document.querySelector('.unified-paper')?.className.includes('is-view-rotated') ?? false), false)

  await page.keyboard.press('Escape')
  await settle(1200)
  assert.deepEqual(await page.evaluate(() => document.querySelectorAll('.note-text-field-toolbar').length), 0)

  // 8. persistence: reload the app and reopen the note
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.file-tree__entry-button', { timeout: 90_000 })
  await page.locator('.file-tree__entry-button', { hasText: 'Textfelder' }).first().click()
  await page.waitForSelector('[data-note-text-field]', { timeout: 60_000 })
  await settle(1000)
  list = await boxes()
  assert.equal(list.length, 2, 'both boxes survive a reload')
  assert.ok(list.some((item) => item.value.startsWith('Grüße äöü Größ')))
  const reloaded = list.find((item) => item.value.startsWith('Seite zwei'))
  assert.ok(reloaded, 'edited text is saved')
  assert.ok(reloaded.weight === '700' || reloaded.weight === 'bold', 'bold survives the reload')
  assert.equal(reloaded.color, 'rgb(37, 99, 201)', 'colour survives the reload')
  assert.deepEqual(pageErrors, [], 'no page errors')
  console.log('pdf text box browser check ok')
} finally {
  await browser.close()
  await server.close()
}
