// Browser smoke check for the study tools (web build served at STUDY_UI_URL, e.g. http://127.0.0.1:5341/?web).
// Needs playwright-core and a Chromium binary; it is not part of the default CI run.
// Usage: STUDY_UI_URL=... PLAYWRIGHT_CORE=/path/to/playwright-core STUDY_UI_SHOTS=/dir node scripts/check-study-ui.mjs
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { deflateSync } from 'node:zlib'

const url = process.env.STUDY_UI_URL
if (!url) { console.log('STUDY_UI_URL not set: skipping the browser check'); process.exit(0) }
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_CORE || 'playwright-core')
const shots = process.env.STUDY_UI_SHOTS || ''
if (shots) mkdirSync(shots, { recursive: true })
const work = mkdtempSync(join(tmpdir(), 'fanotes-study-ui-'))

// Synthetic fixtures: invented worksheet text and flat-colour pictures.
const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0 })
const crc = (buffer) => { let c = 0xffffffff; for (const byte of buffer) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0 }
const chunk = (type, data) => { const body = Buffer.concat([Buffer.from(type), data]); const out = Buffer.alloc(8 + data.length + 4); out.writeUInt32BE(data.length, 0); body.copy(out, 4); out.writeUInt32BE(crc(body), 8 + data.length); return out }
const png = (r, g, b) => {
  const w = 96, h = 72, header = Buffer.alloc(13); header.writeUInt32BE(w, 0); header.writeUInt32BE(h, 4); header[8] = 8; header[9] = 2
  const raw = Buffer.alloc((w * 3 + 1) * h)
  for (let y = 0; y < h; y += 1) for (let x = 0; x < w; x += 1) { const at = y * (w * 3 + 1) + 1 + x * 3; raw[at] = r; raw[at + 1] = g; raw[at + 2] = b }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}
const pictures = [[220, 60, 60], [60, 120, 220], [60, 170, 90]].map((rgb, index) => { const file = join(work, `Falter ${index + 1}.png`); writeFileSync(file, png(...rgb)); return file })
const pdfText = (lines) => `BT /F1 12 Tf 50 780 Td 18 TL\n${lines.map((line) => `(${line}) Tj T*`).join('\n')}\nET`
const pdfPages = [
  ['Arbeitsblatt Insekten (synthetisch)', 'Auftrag 1: Zeichnen Sie ein Insekt ab und beschriften Sie die Teile. (ca. 20 Minuten)', 'Auftrag 2: Lesen Sie den Text und markieren Sie die wichtigen Punkte! (10 Minuten)', 'Die Aufgabe der Hormone ist die Steuerung.'],
  ['Seite zwei', 'Auftrag 3: Erklaeren Sie den Zusam-', 'menhang zwischen den beiden Hor-', 'monen. (ca. 1 Lektion)'],
]
const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>']
pdfPages.forEach((lines, index) => {
  objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 7 0 R >> >> /Contents ${4 + index * 2} 0 R >>`)
  const stream = pdfText(lines)
  objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`)
})
objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')
let pdf = '%PDF-1.4\n'
const offsets = objects.map((body, index) => { const at = pdf.length; pdf += `${index + 1} 0 obj\n${body}\nendobj\n`; return at })
const xref = pdf.length
pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((at) => `${String(at).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
const pdfFile = join(work, 'Arbeitsblatt Insekten.pdf')
writeFileSync(pdfFile, Buffer.from(pdf, 'latin1'))

const profile = join(work, 'profile')
const launch = () => chromium.launchPersistentContext(profile, { executablePath: process.env.CHROMIUM || '/usr/bin/chromium', args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'], viewport: { width: 1440, height: 950 }, locale: 'de-CH', permissions: ['clipboard-read', 'clipboard-write'] })
const steps = []
const ok = (name, detail = '') => { steps.push(name); console.log(`PASS ${name}${detail ? ` (${detail})` : ''}`) }
const shot = async (page, name) => { if (shots) await page.screenshot({ path: join(shots, `${name}.png`) }) }
const errors = []
const track = (page) => { page.on('pageerror', (error) => errors.push(String(error).slice(0, 300))) }
const boot = async (context) => {
  const page = context.pages()[0] || await context.newPage()
  track(page)
  await page.addInitScript(() => {
    const click = HTMLInputElement.prototype.click
    HTMLInputElement.prototype.click = function () { if (this.type === 'file') return undefined; return click.call(this) }
  })
  await page.goto(url, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(3500)
  return page
}

let context = await launch()
try {
  let page = await boot(context)
  if (await page.getByRole('button', { name: 'FaNotes einrichten' }).count()) {
    await page.getByRole('button', { name: /^Schule/ }).first().click()
    await page.waitForTimeout(400)
    await page.getByRole('button', { name: 'FaNotes einrichten' }).click()
    await page.waitForTimeout(4500)
  }
  await page.getByRole('button', { name: 'Neue Notiz in Biologie' }).click()
  await page.waitForTimeout(1500)
  await page.locator('.cm-content').click()
  await page.keyboard.insertText('# Gliederfüsser\n\nStart.')
  await page.waitForTimeout(600)

  const insertTool = async (label) => {
    await page.locator('.cm-content').click()
    await page.keyboard.press('Control+End')
    await page.getByRole('button', { name: 'Lernwerkzeuge', exact: true }).click()
    await page.getByRole('menuitem', { name: label }).click()
    await page.locator('[data-study-modal]').waitFor()
  }
  const finish = async () => { await page.getByRole('button', { name: 'Fertig', exact: true }).last().click(); await page.locator('[data-study-modal]').waitFor({ state: 'detached' }); await page.waitForTimeout(300) }

  // 1. table + key with skeleton, compare image, export button
  await insertTool('Tabelle und Bestimmungsschlüssel')
  const grid = page.locator('.study-grid')
  await grid.getByLabel('Art 1').fill('Käfer')
  await grid.getByLabel('Art 2').fill('Wanzen')
  await grid.getByLabel('Merkmal 1', { exact: true }).fill('Flügel gehärtet')
  await page.getByRole('button', { name: 'Schlüssel erzeugen' }).click()
  await page.locator('.study-preview svg').waitFor()
  assert.ok(await page.locator('.study-preview svg text').count() >= 3, 'key preview has text')
  await page.getByRole('tab', { name: 'Vergleich' }).click()
  await page.locator('.study-compare-view input[type=file]').setInputFiles(pictures[0], { timeout: 5000 }).catch(() => undefined)
  await shot(page, 'key-editor')
  assert.ok(await page.getByRole('button', { name: /Bild kopieren/ }).count(), 'export buttons present')
  await finish()
  assert.equal(await page.locator('.cm-study-shell.study-kind-key').count(), 1)
  ok('key block created and rendered in the note')

  // 2. sort board
  await insertTool('Sortier-Board')
  await page.getByLabel('Karten hinzufügen').fill('Libellen\nKäfer\nSilberfischchen\nFlöhe')
  await page.getByRole('button', { name: 'Hinzufügen' }).click()
  const groupNames = page.getByLabel('Gruppenname')
  await groupNames.nth(0).fill('hemimetabol')
  await groupNames.nth(1).fill('holometabol')
  const card = (text) => page.locator('.study-modal .study-card', { hasText: text }).first()
  const dragTo = async (text, target) => {
    const from = await card(text).boundingBox(); const to = await page.locator(target).first().boundingBox()
    await page.mouse.move(from.x + 10, from.y + 8); await page.mouse.down(); await page.mouse.move(from.x + 40, from.y + 30, { steps: 4 }); await page.mouse.move(to.x + to.width / 2, to.y + to.height - 8, { steps: 8 }); await page.mouse.up()
  }
  await dragTo('Libellen', '.study-modal .study-group >> nth=0')
  await card('Käfer').click(); await page.locator('.study-modal .study-group').nth(1).click({ position: { x: 12, y: 58 } })
  await shot(page, 'sort-board')
  assert.equal(await page.locator('.study-modal .study-group').nth(0).locator('.study-card').count(), 1, 'dragged card landed in group 1')
  assert.equal(await page.locator('.study-modal .study-group').nth(1).locator('.study-card').count(), 1, 'tapped card landed in group 2')
  await page.getByRole('button', { name: 'Als Tabelle einfügen' }).click()
  await finish()
  assert.equal(await page.locator('.cm-study-shell.study-kind-sort').count(), 1)
  ok('sort board persists moves and inserts a table')

  // 3. concept map
  await insertTool('Begriffsnetz (Ursache und Wirkung)')
  await page.getByLabel('Schnell eingeben: eine Beziehung pro Zeile').fill('Häutungshormon -> löst aus -> Häutung\nJuvenilhormon -> hemmt -> Verpuppung')
  await page.getByRole('button', { name: 'Übernehmen' }).click()
  await page.locator('.study-preview svg path[marker-end]').first().waitFor()
  await shot(page, 'concept-map')
  await finish()
  assert.equal(await page.locator('.cm-study-shell.study-kind-map svg').count(), 1)
  ok('concept map block created')

  // 4. picture sheet
  await insertTool('Bildtafel')
  await page.locator('.study-editor input[type=file]').setInputFiles(pictures)
  await page.locator('.study-plate-item img').nth(2).waitFor()
  await page.getByLabel('Name Bild 1').fill('Distelfalter')
  await page.getByLabel('Name Bild 2').fill('Admiral')
  await shot(page, 'picture-sheet')
  await finish()
  assert.equal(await page.locator('.cm-study-shell.study-kind-plate img').count(), 3)
  ok('picture sheet with three images')

  // 5. definition cards
  await insertTool('Definitionskarten')
  await page.locator('.study-term-form').first().getByRole('textbox').nth(0).fill('Mimikry')
  await page.locator('.study-term-form').first().getByRole('textbox').nth(1).fill('Nachahmung einer wehrhaften Art.')
  await finish()
  assert.equal(await page.locator('.cm-study-shell.study-kind-term').count(), 1)
  ok('definition card block created')

  // flashcards use the blocks (image card + definition card)
  await page.keyboard.press('Control+p')
  await page.getByPlaceholder('Befehl suchen …').fill('Karteikarten')
  await page.waitForTimeout(200)
  await page.keyboard.press('Enter')
  await page.locator('.history-dialog').waitFor()
  const seen = new Set()
  for (let step = 0; step < 4; step += 1) {
    const front = await page.locator('.history-dialog strong').first().textContent().catch(() => '')
    if (front) seen.add(front)
    if (await page.locator('.study-card-image').count()) seen.add('image')
    await page.getByRole('button', { name: 'Antwort zeigen' }).click().catch(() => undefined)
    await page.getByRole('button', { name: 'Gut' }).click().catch(() => undefined)
  }
  assert.ok(seen.has('image') && seen.has('Mimikry'), `cards from blocks: ${[...seen].join(', ')}`)
  await page.keyboard.press('Escape')
  ok('flashcards include the image and definition cards')

  // reload: everything is still there
  await page.waitForTimeout(1500)
  await context.close()
  context = await launch()
  page = await boot(context)
  await page.locator('.cm-study-shell').first().waitFor({ timeout: 15000 })
  assert.equal(await page.locator('.cm-study-shell').count(), 5, 'all five blocks survive a reload')
  assert.ok((await page.locator('.cm-content').innerText()).includes('hemimetabol'), 'inserted table survives')
  await shot(page, 'note-after-reload')
  ok('all blocks survive a reload')

  // 6. PDF: tasks panel
  await page.locator('button', { hasText: /^\s*PDF\s*$/ }).first().click()
  const input = page.locator('input[type=file]').last()
  await input.waitFor({ state: 'attached' })
  await input.setInputFiles(pdfFile)
  await page.waitForTimeout(3500)
  await page.getByRole('button', { name: 'Lernwerkzeuge', exact: true }).click()
  await page.locator('.study-task').first().waitFor({ timeout: 20000 })
  assert.equal(await page.locator('.study-task').count(), 3, 'three assignments detected')
  const clocks = await page.locator('.study-clock').allTextContents()
  assert.ok(clocks[0].includes('/ 20 min') && clocks[1].includes('/ 10 min') && clocks[2].includes('/ 45 min'), `time hints ${clocks.join(' | ')}`)
  assert.ok((await page.locator('.study-task').nth(2).innerText()).includes('Zusammenhang'), 'hyphenation joined')
  await page.locator('.study-task input[type=checkbox]').first().check()
  await page.getByRole('button', { name: 'Timer starten' }).nth(1).click()
  await page.waitForTimeout(2300)
  await page.getByRole('button', { name: 'Timer anhalten' }).click()
  assert.match(await page.locator('.study-progress-text').innerText(), /1 von 3 erledigt/)
  await shot(page, 'tasks-panel')
  await page.getByRole('button', { name: 'Markierungen', exact: true }).click()
  assert.ok(await page.locator('.study-panel').innerText().then((text) => /0 Markierungen/.test(text)), 'marks tab opens')
  await page.getByRole('button', { name: 'Aufträge', exact: true }).first().click()
  ok('tasks panel detects, ticks and times assignments')
  await page.waitForTimeout(1500)
  await context.close()
  context = await launch()
  page = await boot(context)
  if (!(await page.locator('.study-task').count())) {
    await page.getByRole('button', { name: 'Lernwerkzeuge', exact: true }).click().catch(() => undefined)
  }
  await page.locator('.study-task').first().waitFor({ timeout: 20000 })
  assert.ok(await page.locator('.study-task input[type=checkbox]').first().isChecked(), 'done state persists')
  assert.match(await page.locator('.study-progress-text').innerText(), /1 von 3 erledigt/)
  const spent = await page.locator('.study-clock').nth(1).innerText()
  assert.ok(!spent.startsWith('00:00'), `timer time persisted: ${spent}`)
  ok('task progress and timer survive a reload')

  assert.deepEqual(errors, [], `page errors: ${errors.join(' | ')}`)
  console.log(`study ui checks passed (${steps.length} steps)`)
} finally {
  await context.close().catch(() => undefined)
}
