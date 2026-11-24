// Real Electron check for pictures and documents on the sheet (no worksheet bar any more):
//   - pasting an image puts a floating, selected object on the sheet (no `.worksheet-toolbar` anywhere)
//   - selected: corner handles and a floating tool strip, both inside the window
//   - dragging moves it, resizing keeps the aspect, the layout is written to the worksheet JSON and survives reopening
//   - Delete removes it (with an undo toast that brings it back)
//   - a worksheet note in the old format (no placement) still opens, in the flow, full width
//   - a PDF worksheet shows no bar, only a quiet chip on hover
// Screenshots (light and dark) go to FANOTES_SHEET_IMAGE_SHOTS (default: a temp folder).
// Needs `vite build`, xvfb-run and playwright-core (PLAYWRIGHT_CORE).
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { connect, createProfile, createReporter, dismissNotices, electronBinary, launch, makePdf, openFile, root, sleep, stop, until } from './lib/desktop-flow.mjs'

const xvfb = spawnSync('sh', ['-c', 'command -v xvfb-run'], { encoding: 'utf8' }).stdout.trim()
const skipReason = process.env.FANOTES_SKIP_BROWSER === '1' ? 'FANOTES_SKIP_BROWSER=1'
  : !xvfb ? 'no xvfb-run'
    : !fs.existsSync(path.join(root, 'dist', 'index.html')) ? 'no dist/ (run vite build)'
      : !fs.existsSync(electronBinary) ? 'no electron' : ''
if (skipReason) {
  console.log(`sheet images: skipped (${skipReason})`)
  process.exit(0)
}
try { await import(process.env.PLAYWRIGHT_CORE || 'playwright-core') } catch {
  console.log('sheet images: skipped (no playwright-core; set PLAYWRIGHT_CORE)')
  process.exit(0)
}

const shots = process.env.FANOTES_SHEET_IMAGE_SHOTS || fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'sheet-image-shots-'))
fs.mkdirSync(shots, { recursive: true })
const { ok, failed, count } = createReporter()

/** A small opaque PNG with a gradient and a frame, so a screenshot shows what moved. */
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
      const edge = x < 4 || y < 4 || x >= width - 4 || y >= height - 4
      raw[row + 1 + x * 3] = edge ? 30 : Math.round((x / width) * 200) + 30
      raw[row + 2 + x * 3] = edge ? 60 : Math.round((y / height) * 180) + 40
      raw[row + 3 + x * 3] = edge ? 140 : 190
    }
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}

const NOW = '2026-11-24T10:00:00.000Z'
const baseDocument = (id, extension, kind, mimeType, extra = {}) => ({
  schemaVersion: 1, id, title: 'Altes Blatt', kind, mimeType,
  sourceRelativePath: `.fanotes/worksheets/${id}${extension}`, dataRelativePath: `.fanotes/worksheets/${id}.json`,
  createdAt: NOW, updatedAt: NOW, textBoxes: [], highlights: [], ...extra,
})

/** Notes with worksheets exactly as older builds wrote them: no placement, no aspect. */
const seedVault = (profile) => {
  const directory = path.join(profile.vault, '.fanotes', 'worksheets')
  fs.mkdirSync(directory, { recursive: true })
  const legacyImage = 'legacy-image-1'
  fs.writeFileSync(path.join(directory, `${legacyImage}.png`), makePng(480, 320))
  fs.writeFileSync(path.join(directory, `${legacyImage}.json`), JSON.stringify(baseDocument(legacyImage, '.png', 'image', 'image/png', {
    textBoxes: [{ id: 'box-1', page: 1, x: 0.1, y: 0.1, width: 0.3, text: 'Alte Antwort', fontSize: 16 }],
  })))
  fs.writeFileSync(path.join(profile.vault, 'Altes Bild.md'), `# Altes Bild\n\nText davor.\n\n<!-- fanotes-worksheet:${legacyImage} -->\n`)
  const pdf = 'legacy-pdf-1'
  fs.writeFileSync(path.join(directory, `${pdf}.pdf`), makePdf(['[0 0 595 842]', '[0 0 595 842]'], 'Blatt'))
  fs.writeFileSync(path.join(directory, `${pdf}.json`), JSON.stringify(baseDocument(pdf, '.pdf', 'pdf', 'application/pdf', { title: 'Aufgaben' })))
  fs.writeFileSync(path.join(profile.vault, 'Aufgaben.md'), `# Aufgaben\n\n<!-- fanotes-worksheet:${pdf} -->\n`)
  return { legacyImage, pdf }
}

const pasteImage = (page, bytes) => page.evaluate(async (base64) => {
  const binary = atob(base64)
  const data = Uint8Array.from(binary, (char) => char.charCodeAt(0))
  const transfer = new DataTransfer()
  transfer.items.add(new File([data], 'Eingefügt.png', { type: 'image/png' }))
  const target = document.querySelector('.cm-content') ?? document.body
  target.dispatchEvent(new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }))
}, bytes.toString('base64'))

const rectOf = (page, selector) => page.evaluate((query) => {
  const node = document.querySelector(query)
  if (!node) return null
  const rect = node.getBoundingClientRect()
  return { left: rect.left, top: rect.top, width: rect.width, height: rect.height, right: rect.right, bottom: rect.bottom }
}, selector)

/** Position on the sheet itself (scrolling does not change it). */
const sheetRectOf = (page, selector) => page.evaluate((query) => {
  const node = document.querySelector(query)
  const paper = document.querySelector('.unified-paper')
  if (!node || !paper) return null
  const rect = node.getBoundingClientRect()
  const origin = paper.getBoundingClientRect()
  return { left: rect.left - origin.left, top: rect.top - origin.top, width: rect.width, height: rect.height }
}, selector)

const insideWindow = (rect, page) => page.evaluate((box) => box.left >= -1 && box.top >= -1 && box.right <= innerWidth + 1 && box.bottom <= innerHeight + 1, rect)

const worksheetJson = (profile, id) => JSON.parse(fs.readFileSync(path.join(profile.vault, '.fanotes', 'worksheets', `${id}.json`), 'utf8'))
const worksheetIds = (profile) => fs.readdirSync(path.join(profile.vault, '.fanotes', 'worksheets')).filter((name) => name.endsWith('.json')).map((name) => name.slice(0, -5))

const session = async (theme, full) => {
  const profile = createProfile(`sheet-images-${theme}-`, { theme })
  const ids = seedVault(profile)
  const app = launch(profile)
  let browser = null
  try {
    const connected = await connect(app)
    browser = connected.browser
    const { page } = connected
    await page.setViewportSize({ width: 1280, height: 860 }).catch(() => {})
    await dismissNotices(page)
    const label = `[${theme}]`

    // --- Old-format picture worksheet: opens, full width in the flow, no bar ---------------------------------------
    await openFile(page, 'Altes Bild')
    await until(() => page.locator('.sheet-image img').first().evaluate((img) => img.complete && img.naturalWidth > 0).catch(() => false), 'legacy image loaded')
    ok(`${label} old-format picture worksheet opens without a bar`, await page.locator('.worksheet-toolbar, .worksheet-hint').count() === 0)
    const legacy = await page.evaluate(() => {
      const frame = document.querySelector('.sheet-image')
      const paper = document.querySelector('.unified-paper')
      return { floating: frame?.classList.contains('is-floating'), width: frame?.getBoundingClientRect().width, paper: paper?.getBoundingClientRect().width, box: document.querySelector('.worksheet-textbox textarea')?.value }
    })
    ok(`${label} old-format picture stays in the flow at page width, its answer is kept`, legacy.floating === false && legacy.width > legacy.paper * 0.8 && legacy.box === 'Alte Antwort', JSON.stringify(legacy))
    await page.locator('.sheet-image').first().click({ position: { x: 20, y: 200 } })
    ok(`${label} clicking it selects it: handles and tool strip`, await page.locator('.sheet-image.is-selected .sheet-image-handle').count() === 4 && await page.locator('.sheet-image-bar button').count() >= 3)

    // --- PDF worksheet: no bar, a chip on hover ---------------------------------------------------------------------
    await openFile(page, 'Aufgaben')
    await until(() => page.locator('.worksheet-pdf-page').count().then((n) => n > 0), 'pdf pages')
    await page.evaluate(() => document.querySelector('.worksheet-layer.is-document')?.scrollIntoView({ block: 'start' }))
    await page.locator('.worksheet-layer.is-document').first().hover()
    await sleep(400)
    const chip = await page.locator('.sheet-doc-chip').first().innerText().catch(() => '')
    ok(`${label} PDF worksheet has no bar, only a chip with the page count`, await page.locator('.worksheet-toolbar').count() === 0 && /2 Seiten/u.test(chip), chip)
    // The chip sits inside the first page's corner (the page may be scrolled partly out of view while it paints).
    const chrome = await page.evaluate(() => {
      const bar = document.querySelector('.sheet-doc-chrome')?.getBoundingClientRect()
      const layer = document.querySelector('.worksheet-layer.is-document')?.getBoundingClientRect()
      return bar && layer ? { insideLayer: bar.left >= layer.left && bar.right <= layer.right && bar.top >= layer.top && bar.bottom <= layer.bottom, insideWidth: bar.left >= 0 && bar.right <= innerWidth } : null
    })
    ok(`${label} PDF chip and remove button stay inside the page and the window width`, chrome?.insideLayer && chrome?.insideWidth, JSON.stringify(chrome))
    await page.screenshot({ path: path.join(shots, `pdf-worksheet-${theme}.png`) })

    // --- Paste: a floating, selected object ------------------------------------------------------------------------
    await page.locator('button[aria-label="Neue Notiz"], button[aria-label="New note"]').first().click()
    await until(() => page.locator('.cm-content').count().then((n) => n > 0), 'new note')
    await page.locator('.cm-content').first().click()
    const before = new Set(worksheetIds(profile))
    await pasteImage(page, makePng(400, 300))
    await until(() => page.locator('.sheet-image.is-floating').count().then((n) => n === 1), 'floating image')
    await until(() => page.locator('.sheet-image img').first().evaluate((img) => img.complete && img.naturalWidth > 0).catch(() => false), 'pasted image decoded')
    ok(`${label} paste creates one floating image and no worksheet bar`, await page.locator('.worksheet-toolbar, .worksheet-hint').count() === 0)
    ok(`${label} the new image starts selected: 4 handles and the tool strip`, await page.locator('.sheet-image.is-selected .sheet-image-handle').count() === 4 && await page.locator('.sheet-image-bar').isVisible())
    const bar = await rectOf(page, '.sheet-image-bar')
    ok(`${label} the tool strip is inside the window and has labelled icon buttons`, await insideWindow(bar, page) && await page.locator('.sheet-image-bar button[aria-label]').count() === 4, JSON.stringify(bar))
    const first = await rectOf(page, '.sheet-image')
    ok(`${label} it is visible where the reader looks and not upscaled past 400 px`, await insideWindow(first, page) && first.width <= 401 && first.width > 100, JSON.stringify(first))
    await page.screenshot({ path: path.join(shots, `selected-image-${theme}.png`) })

    if (full) {
      const mid = { x: first.left + first.width / 2, y: first.top + first.height / 2 }
      // Drag with the mouse.
      await page.mouse.move(mid.x, mid.y)
      await page.mouse.down()
      await page.mouse.move(mid.x - 50, mid.y + 30, { steps: 6 })
      await page.mouse.move(mid.x - 100, mid.y + 60, { steps: 6 })
      await page.mouse.up()
      const moved = await rectOf(page, '.sheet-image')
      ok(`${label} dragging moves the image by the pointer distance`, Math.abs(moved.left - first.left + 100) < 4 && Math.abs(moved.top - first.top - 60) < 4, JSON.stringify({ first, moved }))
      // Resize from the south-east handle, aspect locked.
      const handle = await rectOf(page, '.sheet-image-handle.is-se')
      await page.mouse.move(handle.left + handle.width / 2, handle.top + handle.height / 2)
      await page.mouse.down()
      await page.mouse.move(handle.left + 40, handle.top + 20, { steps: 5 })
      await page.mouse.move(handle.left + 100, handle.top + 10, { steps: 5 })
      await page.mouse.up()
      const resized = await rectOf(page, '.sheet-image')
      const resizedOnSheet = await sheetRectOf(page, '.sheet-image')
      const ratioBefore = moved.width / moved.height
      const ratioAfter = resized.width / resized.height
      ok(`${label} resizing from a corner keeps the aspect and anchors the opposite corner`, resized.width > moved.width + 40 && Math.abs(ratioBefore - ratioAfter) < 0.02 && Math.abs(resized.left - moved.left) < 2 && Math.abs(resized.top - moved.top) < 2, JSON.stringify({ moved, resized }))
      // Persisted to the worksheet JSON.
      const id = await until(() => worksheetIds(profile).find((candidate) => !before.has(candidate) && worksheetJson(profile, candidate).placement), 'worksheet written', 15_000)
      // x / width on the sheet equals left / width of the picture, whatever the paper width is.
      await until(() => Math.abs(worksheetJson(profile, id).placement.x / worksheetJson(profile, id).placement.width - resizedOnSheet.left / resizedOnSheet.width) < 0.01
        && Math.abs(worksheetJson(profile, id).placement.y / worksheetJson(profile, id).placement.width - resizedOnSheet.top / resizedOnSheet.width) < 0.01, 'placement saved after drag', 10_000).catch(() => {})
      const stored = worksheetJson(profile, id)
      ok(`${label} the worksheet JSON keeps the dragged and resized placement and the aspect`, stored.placement && Math.abs(stored.placement.x / stored.placement.width - resizedOnSheet.left / resizedOnSheet.width) < 0.01 && Math.abs(stored.placement.width * (resizedOnSheet.width / stored.placement.width) - resizedOnSheet.width) < 1 && Math.abs(stored.aspect - 0.75) < 0.01, JSON.stringify({ placement: stored.placement, aspect: stored.aspect }))
      // Reopen the note: same place.
      await page.waitForTimeout?.(900)
      const title = fs.readdirSync(profile.vault).find((name) => name.endsWith('.md') && !['Altes Bild.md', 'Aufgaben.md'].includes(name))
      await openFile(page, 'Altes Bild')
      await until(() => page.locator('.sheet-image:not(.is-floating)').count().then((n) => n === 1), 'other note shown')
      await openFile(page, title.replace(/\.md$/u, ''))
      await until(() => page.locator('.sheet-image.is-floating img').first().evaluate((img) => img.complete && img.naturalWidth > 0).catch(() => false), 'image back after reopening')
      const back = await sheetRectOf(page, '.sheet-image')
      ok(`${label} the image is at the same place and size after reopening`, Math.abs(back.left - resizedOnSheet.left) < 3 && Math.abs(back.top - resizedOnSheet.top) < 3 && Math.abs(back.width - resizedOnSheet.width) < 3, JSON.stringify({ resizedOnSheet, back }))
      ok(`${label} reopened image is not selected; clicking outside deselects`, await page.locator('.sheet-image.is-selected').count() === 0)
      // Click selects, Escape deselects, click outside deselects.
      await page.locator('.sheet-image').click()
      ok(`${label} a click selects`, await page.locator('.sheet-image.is-selected').count() === 1)
      await page.mouse.click(8, 400)
      ok(`${label} a click outside deselects`, await page.locator('.sheet-image.is-selected').count() === 0)
      // Pen layer: the object is inert while writing.
      await page.locator('.sheet-image').click()
      await page.keyboard.press('Control+d')
      await sleep(600)
      const penBefore = await sheetRectOf(page, '.sheet-image')
      const penClient = await rectOf(page, '.sheet-image')
      const pen = await page.evaluate(() => getComputedStyle(document.querySelector('.sheet-image')).pointerEvents)
      await page.mouse.move(penClient.left + 30, penClient.top + 30)
      await page.mouse.down()
      await page.mouse.move(penClient.left + 90, penClient.top + 70, { steps: 8 })
      await page.mouse.up()
      const penAfter = await sheetRectOf(page, '.sheet-image')
      const stillSelected = await page.locator('.sheet-image.is-selected').count()
      ok(`${label} drawing with the pen over the image does not move it and the image is inert`, pen === 'none' && Math.abs(penAfter.left - penBefore.left) < 1 && Math.abs(penAfter.top - penBefore.top) < 1 && stillSelected === 0, JSON.stringify({ pen, penBefore, penAfter, stillSelected }))
      await page.keyboard.press('Control+d')
      await sleep(600)
      // Delete removes it, with an undo toast.
      await page.locator('.sheet-image').click()
      await page.keyboard.press('Delete')
      await until(() => page.locator('.sheet-image').count().then((n) => n === 0), 'image removed')
      const undo = page.locator('.toast .toast-action')
      ok(`${label} Delete removes the image and offers Undo`, await undo.count() === 1 && /Rückgängig/u.test(await undo.innerText()))
      await undo.click()
      await until(() => page.locator('.sheet-image.is-floating img').count().then((n) => n === 1), 'image restored')
      const restored = await sheetRectOf(page, '.sheet-image')
      ok(`${label} Undo brings it back in the same place`, Math.abs(restored.left - resizedOnSheet.left) < 3 && Math.abs(restored.top - resizedOnSheet.top) < 3, JSON.stringify({ resizedOnSheet, restored }))
      await page.locator('.sheet-image').click()
      await page.locator('.sheet-image-bar button[aria-label="Bild entfernen"]').click()
      await until(() => page.locator('.sheet-image').count().then((n) => n === 0), 'removed by the strip')
      await sleep(11_500)
      ok(`${label} the removed picture's files are deleted once the undo time is over`, !worksheetIds(profile).includes(id))
    }
    ok(`${label} no page error and no worksheet bar anywhere`, await page.locator('.worksheet-toolbar').count() === 0)
    ids.legacyImage && await sleep(200)
  } finally {
    await stop(app, browser)
    profile.dispose()
  }
}

try {
  await session('light', true)
  await session('dark', false)
} catch (error) {
  ok('sheet image flow ran to the end', false, error instanceof Error ? error.stack ?? error.message : String(error))
}
console.log(`sheet images: ${count() - failed()}/${count()} checks passed (screenshots in ${shots})`)
process.exit(failed() === 0 ? 0 : 1)
