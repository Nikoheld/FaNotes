// Study tools on a PDF note in the real desktop app (Electron under Xvfb):
// place every object kind on a page, check the .famd on disk, reload, and
// check the objects come back. Synthetic PDF and vault only.
// Needs a built renderer (`vite build`), xvfb-run and PLAYWRIGHT_CORE.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const playwright = await import(process.env.PLAYWRIGHT_CORE || 'playwright-core')
const chromium = playwright.chromium ?? playwright.default.chromium
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const famd = createRequire(import.meta.url)('../electron/famd.cjs')
const executable = path.join(root, 'node_modules', 'electron', 'dist', 'electron')
const temporary = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'fanotes-study-'))
const shots = process.env.STUDY_SHOTS || ''
const home = path.join(temporary, 'home')
const configHome = path.join(temporary, 'config')
const runtime = path.join(temporary, 'runtime')
const vault = path.join(home, 'Notizen')
const userData = path.join(configHome, 'FaNotes')
for (const directory of [home, configHome, runtime, vault, userData, path.join(vault, 'Biologie')]) fs.mkdirSync(directory, { recursive: true, mode: 0o700 })

// A tiny two page PDF with a worksheet-like figure (lines and labels), written by hand.
const makePdf = () => {
  const content = (title) => `BT /F1 20 Tf 60 780 Td (${title}) Tj ET\n2 w 150 400 m 350 400 l S 250 300 m 250 500 l S 1 0 0 RG 200 350 120 100 re S\nBT /F1 12 Tf 60 740 Td (Auftrag 1: Beschrifte Caput Thorax Abdomen Coxa Femur Tibia Tarsus) Tj ET`
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>']
  const stream = (text) => `<< /Length ${text.length} >>\nstream\n${text}\nendstream`
  objects.push('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 7 0 R >> >> >>', stream(content('Seite 1')))
  objects.push('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 6 0 R /Resources << /Font << /F1 7 0 R >> >> >>', stream(content('Seite 2')))
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')
  let out = '%PDF-1.4\n'
  const offsets = []
  objects.forEach((body, index) => { offsets.push(out.length); out += `${index + 1} 0 obj\n${body}\nendobj\n` })
  const xref = out.length
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(out, 'latin1')
}
fs.writeFileSync(path.join(vault, 'Biologie', 'Arbeitsblatt.pdf'), makePdf())
fs.writeFileSync(path.join(userData, 'config.json'), `${JSON.stringify({
  version: 3, vaultPath: vault,
  settings: { uiLanguage: 'de', autoCheckUpdates: false, autoDownloadUpdates: false, reduceMotion: true },
  onboarding: { version: 1, completed: true },
}, null, 2)}\n`, { mode: 0o600 })
// A 2x2 PNG for the reference image.
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR4nGP8z8Dwn4EIwESMolGF6AAAn2cDEWl5OmQAAAAASUVORK5CYII=', 'base64')
const pngPath = path.join(temporary, 'ref.png')
fs.writeFileSync(pngPath, png)

const port = 19_300 + Math.floor(Math.random() * 400)
const child = spawn('xvfb-run', ['-a', '-s', '-screen 0 1440x1000x24', executable, root, `--remote-debugging-port=${port}`, '--no-sandbox'], {
  env: { ...process.env, HOME: home, XDG_CONFIG_HOME: configHome, XDG_RUNTIME_DIR: runtime },
  stdio: ['ignore', 'pipe', 'pipe'], detached: true,
})
let output = ''
child.stdout.on('data', (chunk) => { output += chunk })
child.stderr.on('data', (chunk) => { output += chunk })
const results = []
const ok = (name, pass, detail = '') => { results.push(pass); console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail !== '' ? ` -> ${String(detail).slice(0, 240)}` : ''}`) }

let browser; let lastErr = ''; let pageRef = null
try {
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`); break } catch (e) { lastErr = String(e).slice(0, 200); await new Promise((r) => setTimeout(r, 250)) }
    if (child.exitCode !== null) throw new Error(`Electron exited (${child.exitCode}): ${output.slice(-500)}`)
  }
  assert.ok(browser, `Electron did not open a debugging port: ${lastErr} ${output.slice(-600)}`)
  let page = null
  for (let tries = 0; tries < 120 && !page; tries += 1) {
    page = browser.contexts().flatMap((c) => c.pages()).find((p) => !p.url().startsWith('devtools')) ?? null
    if (!page) await new Promise((r) => setTimeout(r, 250))
  }
  assert.ok(page, 'no renderer page'); pageRef = page
  page.on('pageerror', (error) => console.log('pageerror', String(error).slice(0, 200)))
  await page.setViewportSize({ width: 1440, height: 1000 }).catch(() => {})
  await page.waitForFunction(() => Boolean(window.fanotes && document.querySelector('.file-tree__row')), null, { timeout: 60_000 })

  const openPdf = async () => {
    const folder = page.locator('.file-tree__row[data-kind="folder"]', { hasText: 'Biologie' }).first()
    if (!(await page.locator('.file-tree__row', { hasText: 'Arbeitsblatt' }).count())) await folder.click()
    await page.locator('.file-tree__row', { hasText: 'Arbeitsblatt' }).first().click()
    await page.waitForFunction(() => [...document.querySelectorAll('[data-pdf-page="1"] canvas')].some((c) => c.width > 0), null, { timeout: 60_000 })
    await page.waitForTimeout(1500)
  }
  await openPdf()
  const pageBox = async (n = 1) => (await page.locator(`[data-pdf-page="${n}"]`).boundingBox())
  const at = async (fx, fy, n = 1) => { const b = await pageBox(n); return { x: b.x + b.width * fx, y: b.y + b.height * fy } }
  const click = async (fx, fy, n = 1) => { const p = await at(fx, fy, n); await page.mouse.click(p.x, p.y) }
  const drag = async (a, b, n = 1) => {
    const p = await at(a[0], a[1], n); const q = await at(b[0], b[1], n)
    await page.mouse.move(p.x, p.y); await page.mouse.down()
    for (let i = 1; i <= 8; i += 1) await page.mouse.move(p.x + (q.x - p.x) * i / 8, p.y + (q.y - p.y) * i / 8)
    await page.mouse.up()
  }
  const count = (sel) => page.locator(`[data-study-layer] ${sel}`).count()

  await page.locator('button[aria-label="Lernwerkzeuge"]').click()
  await page.locator('.study-panel').waitFor()
  ok('the Lernwerkzeuge panel opens on a PDF note', true)

  // 1. callout with leader and typed text
  await page.locator('.study-tool', { hasText: 'Beschriftung setzen' }).click()
  await drag([0.45, 0.32], [0.7, 0.22])
  await page.keyboard.type('Caput')
  await page.keyboard.press('Enter')
  ok('callout label placed and typed', (await page.locator('[data-callout] input').first().inputValue()) === 'Caput')
  // word bank
  await page.locator('.study-terms input').fill('Thorax, Abdomen')
  await page.keyboard.press('Enter')
  ok('word bank terms added', (await page.locator('[data-study-term]').count()) === 2)
  const chip = await page.locator('[data-study-term="Thorax"]').boundingBox()
  const target = await at(0.5, 0.4)
  await page.mouse.move(chip.x + 5, chip.y + 5); await page.mouse.down()
  await page.mouse.move(target.x, target.y, { steps: 6 }); await page.mouse.up()
  ok('a term dragged onto the page becomes a label', (await page.locator('[data-callout] input').evaluateAll((els) => els.map((e) => e.value))).includes('Thorax'))
  // numbered mode
  await page.locator('.study-check input').check()
  await page.locator('.study-tool', { hasText: 'Beschriftung setzen' }).click().catch(() => {})
  await page.locator('.study-tool.is-active', { hasText: 'Beschriftung setzen' }).count() || await page.locator('.study-tool', { hasText: 'Beschriftung setzen' }).click()
  await drag([0.3, 0.35], [0.15, 0.45])
  ok('numbered label shows its number', (await page.locator('.study-label-num').first().textContent()) === '1')

  // 3. stamps, legend, branch highlight
  await page.locator('.study-tabs button', { hasText: 'Zeichen' }).click()
  await page.locator('[data-study-stamp="gain"]').click(); await click(0.2, 0.15)
  await page.locator('[data-study-stamp="letter-h"]').click(); await click(0.3, 0.15)
  ok('stamps placed', (await count('[data-study-kind="stamp"]')) === 2)
  await page.locator('.study-tool', { hasText: 'Legende platzieren' }).click(); await click(0.4, 0.07)
  ok('legend lists the used stamps', (await page.locator('.study-legend-row').count()) >= 2)
  await page.locator('.study-tool', { hasText: 'Ast markieren' }).click(); await drag([0.1, 0.5], [0.6, 0.5])
  ok('branch highlight drawn', (await count('[data-study-kind="stroke"]')) === 1)

  // 2. reference image from file, opacity, lock, compare, PDF crop
  await page.locator('.study-tabs button', { hasText: 'Bilder' }).click()
  await page.locator('.study-panel input[type="file"]:not([capture])').setInputFiles(pngPath)
  await page.locator('[data-study-image-row]').first().waitFor({ timeout: 10_000 })
  await page.locator('[data-study-image-row] input[type="range"]').first().fill('35')
  await page.locator('[data-study-image-row] button[aria-label="Sperren"]').first().click()
  await page.locator('[data-study-image-row] button[aria-label="Vergleichsansicht"]').first().click()
  ok('reference image: opacity, lock and compare view', (await page.locator('.study-compare img').count()) === 1 && (await page.locator('.study-image.is-locked').count()) === 1)
  await page.locator('[data-study-image-row] button[aria-label="Vergleichsansicht"]').first().click()
  await page.locator('.study-tool', { hasText: 'PDF-Ausschnitt' }).click()
  await drag([0.2, 0.25], [0.65, 0.45])
  await page.waitForFunction(() => document.querySelectorAll('[data-study-image-row]').length === 2, null, { timeout: 10_000 })
  ok('a PDF region becomes an image object', true)

  // 4. angle measure: 90 degrees on a square page region is not 90 on a tall page; use real units
  await page.locator('.study-tabs button', { hasText: 'Messen' }).click()
  await page.locator('.study-tool', { hasText: 'Winkel (3 Punkte)' }).click()
  const box = await pageBox()
  const a = await at(0.6, 0.47); const v = await at(0.4, 0.47); const c = { x: v.x + (a.x - v.x) * 0, y: v.y - (a.x - v.x) }
  for (const p of [a, v, c]) { await page.mouse.click(p.x, p.y) }
  const angle = await page.locator('[data-study-measure]').first().textContent()
  ok('angle between two page lines is shown as a label', /^90[,.]?0?°$/.test(angle ?? '') || (angle ?? '').startsWith('90'), angle)
  await page.locator('.study-tool', { hasText: 'Strecke' }).click()
  const s1 = await at(0.2, 0.5); const s2 = await at(0.7, 0.5)
  await page.mouse.click(s1.x, s1.y); await page.mouse.click(s2.x, s2.y)
  const labels = await page.locator('[data-study-measure]').allTextContents()
  ok('distance shown in cm', labels.some((t) => /cm$/.test(t)), labels.join(' | '))
  await page.keyboard.press('Escape')

  // undo / redo
  const before = await count('[data-study-object]')
  await page.locator('.study-panel-head button[aria-label^="Rückgängig"]').click()
  const afterUndo = await count('[data-study-object]')
  await page.locator('.study-panel-head button[aria-label="Wiederholen"]').click()
  ok('undo removes and redo restores the last object', afterUndo < before && (await count('[data-study-object]')) === before, `${before} -> ${afterUndo}`)
  if (shots) await page.screenshot({ path: path.join(shots, 'study-tools.png') })

  // saved on disk
  await page.waitForTimeout(1500)
  const famdPath = path.join(vault, 'Biologie', 'Arbeitsblatt.famd')
  ok('the companion .famd exists', fs.existsSync(famdPath))
  const kinds = () => {
    const parsed = famd.parseFamd(fs.readFileSync(famdPath, 'utf8'))
    return [...new Set((parsed.payload?.annotations ?? []).map((item) => item.kind))].sort()
  }
  ok('every object kind is stored in the payload', ['callout', 'image', 'legend', 'measure', 'stamp', 'stroke', 'terms'].every((k) => kinds().includes(k)), kinds().join(','))
  const saved = famd.parseFamd(fs.readFileSync(famdPath, 'utf8')).payload.annotations
  ok('the locked image keeps opacity and lock', saved.some((i) => i.kind === 'image' && i.locked && Math.abs(i.opacity - 0.35) < 0.01))
  const total = saved.filter((i) => i.kind !== 'terms').length

  // reload the whole app and reopen the note
  await page.locator('.study-panel-head button[aria-label="Schließen"]').click()
  await page.reload()
  await page.waitForFunction(() => Boolean(window.fanotes && document.querySelector('.file-tree__row')), null, { timeout: 60_000 })
  await openPdf()
  await page.waitForFunction((n) => document.querySelectorAll('[data-study-layer] [data-study-object]').length >= n, total - 1, { timeout: 20_000 }).catch(() => {})
  const restored = await count('[data-study-object]')
  ok('after a reload the objects come back', restored >= total - 1, `${restored} of ${total}`)
  ok('the callout text survived', (await page.locator('[data-callout] input').evaluateAll((els) => els.map((e) => e.value))).includes('Caput'))
  ok('a stamp survived', (await count('[data-stamp="gain"]')) === 1)
  ok('the angle label survived', (await page.locator('[data-study-measure]').count()) >= 2)
  if (shots) await page.screenshot({ path: path.join(shots, 'study-tools-reloaded.png') })

  // The existing drafting guides (ruler, Geodreieck with protractor) are reachable in pen mode on a PDF.
  await page.locator('button[aria-label="Stift"]').first().click()
  await page.waitForTimeout(1200)
  const guides = await page.evaluate(() => [...document.querySelectorAll('button')].map((b) => b.title || '').filter((t) => /^(Lineal|Geodreieck) einblenden/.test(t)).length)
  ok('ruler and Geodreieck can be shown on a PDF page', guides >= 2, guides)
  if (guides >= 2) {
    await page.locator('button[title^="Geodreieck einblenden"]').first().click()
    await page.waitForTimeout(600)
    ok('the Geodreieck appears over the PDF page', (await page.locator('.lw-drafting-panel, [aria-label="Zeichenhilfen"]').count()) > 0)
    if (shots) await page.screenshot({ path: path.join(shots, 'study-drafting.png') })
  }

  // other writers must not drop annotations
  await page.evaluate(async (p) => { await window.fanotes.writeNoteTextFields(p, [{ id: 'tf-1', page: 1, x: 0.1, y: 0.1, width: 0.3, text: 'Notiz', fontSize: 16 }]) }, 'Biologie/Arbeitsblatt.pdf')
  await page.waitForTimeout(500)
  ok('writing text fields keeps annotations', kinds().includes('callout'))
} catch (error) {
  console.log('ERROR', error instanceof Error ? error.message.slice(0, 400) : error)
  if (shots && pageRef) await pageRef.screenshot({ path: path.join(shots, 'error.png') }).catch(() => {})
  results.push(false)
} finally {
  await browser?.close().catch(() => {})
  try { process.kill(-child.pid, 'SIGTERM') } catch { /* gone */ }
  fs.rmSync(temporary, { recursive: true, force: true })
}
const failed = results.filter((r) => !r).length
console.log(failed ? `${failed} check(s) failed` : `all ${results.length} checks passed`)
process.exit(failed ? 1 : 0)
