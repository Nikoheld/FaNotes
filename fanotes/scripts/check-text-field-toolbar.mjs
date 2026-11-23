// Regression check: a keyboard text box ("Textfeld einfügen") on a handwriting note uses the very same
// formatting toolbar as the normal note editor, and every option works on the box content.
//
// Drives the real app (Electron under Xvfb) over CDP with a synthetic vault:
//  1. toolbar button set (aria-labels in order, plus every menu entry) in a .md note vs inside a text box;
//  2. each option is applied in a real box: bold/italic/strike/sub/sup/code/link, headings 1-6, lists,
//     checklist, quote, code block, table, math block, details, rule, simple LaTeX, Ctrl+B/I/K;
//  3. the text persists in the .famd after reopening, an old-format box still loads unchanged, and the
//     rendered box shows the formatting; the toolbar stays on screen at a narrow window.
// Needs a built renderer (`vite build`), xvfb-run and playwright-core (PLAYWRIGHT_CORE);
// FANOTES_SKIP_BROWSER=1 skips it. FANOTES_QA_LANG=en runs the English UI.
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const { serializeFamd, emptyFamdPayload, parseFamd } = require('../electron/famd.cjs')
const english = process.env.FANOTES_QA_LANG === 'en'
const en = english ? JSON.parse(fs.readFileSync(path.join(root, 'resources', 'i18n', 'en.json'), 'utf8')) : {}
const t = (german) => en[german] ?? german

const executable = path.join(root, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron')
const xvfb = spawnSync('sh', ['-c', 'command -v xvfb-run'], { encoding: 'utf8' }).stdout.trim()
let playwright = null
if (process.env.FANOTES_SKIP_BROWSER !== '1') {
  try { playwright = await import(process.env.PLAYWRIGHT_CORE || 'playwright-core') } catch { playwright = null }
}
const missing = process.env.FANOTES_SKIP_BROWSER === '1' ? 'FANOTES_SKIP_BROWSER=1'
  : !xvfb ? 'no xvfb-run'
    : !fs.existsSync(path.join(root, 'dist', 'index.html')) ? 'no dist/ (run vite build)'
      : !fs.existsSync(executable) ? 'no electron'
        : !playwright ? 'no playwright-core (set PLAYWRIGHT_CORE)' : ''
if (missing) {
  console.log(`text field toolbar: skipped (${missing})`)
  process.exit(0)
}

const temporary = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'fanotes-tf-toolbar-'))
const home = path.join(temporary, 'home')
const configHome = path.join(temporary, 'config')
const runtime = path.join(temporary, 'runtime')
const vault = path.join(home, 'Notizen')
const userData = path.join(configHome, 'FaNotes')
for (const directory of [home, configHome, runtime, vault, userData]) fs.mkdirSync(directory, { recursive: true, mode: 0o700 })

const at = '2026-11-01T00:00:00.000Z'
const legacyBox = { id: 'tf-legacy', page: 1, x: 0.1, y: 0.2, width: 0.4, fontSize: 20, bold: true, color: '#c0392b', text: 'Alter Kasten **fett** und\n- Liste' }
fs.writeFileSync(path.join(vault, 'Anfang.md'), '# Anfang\n\nEine normale Notiz.\n')
fs.writeFileSync(path.join(vault, 'Alt.famd'), serializeFamd('# Alt\n\nText.\n', { ...emptyFamdPayload(at), paperStyle: 'lines', textFields: [legacyBox] }))
fs.writeFileSync(path.join(vault, 'Neu.famd'), serializeFamd('# Neu\n\nText.\n', { ...emptyFamdPayload(at), paperStyle: 'lines' }))
fs.writeFileSync(path.join(userData, 'config.json'), `${JSON.stringify({
  version: 3,
  vaultPath: vault,
  settings: { uiLanguage: english ? 'en' : 'de', autoCheckUpdates: false, autoDownloadUpdates: false, diagnosticsEnabled: false },
  onboarding: { version: 1, completed: true },
}, null, 2)}\n`, { mode: 0o600 })

const port = 19_900 + Math.floor(Math.random() * 90)
const child = spawn(xvfb, ['-a', '-s', '-screen 0 1440x900x24', executable, root, `--remote-debugging-port=${port}`, '--no-sandbox'], {
  env: { ...process.env, HOME: home, XDG_CONFIG_HOME: configHome, XDG_RUNTIME_DIR: runtime },
  stdio: ['ignore', 'pipe', 'pipe'],
  detached: true,
})
let output = ''
child.stdout.on('data', (chunk) => { output += chunk })
child.stderr.on('data', (chunk) => { output += chunk })
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

let browser
let failure = null
try {
  for (let tries = 0; tries < 240 && !browser; tries += 1) {
    try { browser = await playwright.chromium.connectOverCDP(`http://127.0.0.1:${port}`) } catch { await sleep(250) }
    if (child.exitCode !== null) throw new Error(`Electron exited (${child.exitCode}): ${output.slice(-600)}`)
  }
  assert.ok(browser, 'Electron did not open a debugging port')
  let page = null
  for (let tries = 0; tries < 120 && !page; tries += 1) {
    page = browser.contexts().flatMap((context) => context.pages()).find((candidate) => !candidate.url().startsWith('devtools')) ?? null
    if (!page) await sleep(250)
  }
  assert.ok(page, 'no renderer page')
  const pageErrors = []
  page.on('pageerror', (error) => pageErrors.push(String(error)))
  await page.waitForFunction(() => Boolean(window.fanotes && document.querySelector('.file-tree__row')), null, { timeout: 90_000 })
  await sleep(1500)

  const openNote = async (file) => {
    await page.locator(`.file-tree__entry-button[data-path="${file}"]`).first().click()
    await page.waitForFunction((name) => document.querySelector('.note-tab.active, .note-tab[aria-selected="true"]')?.textContent?.includes(name) ?? true, file.replace(/\.\w+$/u, ''))
    await sleep(900)
  }

  // Everything the toolbar offers: the bar's own buttons in order, then the entries of each menu.
  const toolbarSet = async (selector) => {
    const bar = page.locator(selector).first()
    const own = await bar.evaluate((node) => {
      const labels = []
      for (const child of node.children) {
        if (child.classList.contains('ftb-sep')) break
        const button = child.matches('button') ? child : child.querySelector(':scope > button')
        if (button) labels.push(button.getAttribute('aria-label'))
      }
      return labels
    })
    const menus = []
    for (const label of own.filter((name) => name === t('Überschrift') || name === t('Mehr'))) {
      await bar.locator(`button[aria-label="${label}"]`).click()
      await page.locator('.ftb-popover').waitFor()
      menus.push([label, await page.locator('.ftb-popover').evaluate((node) => [...node.querySelectorAll('button, input')].map((item) => item.getAttribute('aria-label')))])
      // Escape would leave the text box (and drop its toolbar); the menu button toggles it shut.
      await bar.locator(`button[aria-label="${label}"]`).click()
      await page.locator('.ftb-popover').waitFor({ state: 'detached' })
    }
    const titles = await bar.evaluate((node) => [...node.querySelectorAll(':scope > button, :scope > .ftb-menu > button')].filter((b) => !b.closest('.ftb-sep ~ *')).map((b) => b.title))
    return { own, menus, titles }
  }

  await openNote('Anfang.md')
  await page.locator('.cm-content').first().waitFor()
  await page.locator('.cm-content').first().click()
  const documentSet = await toolbarSet('.editor-toolbar .formatting-toolbar')
  assert.ok(documentSet.own.length > 8, `document toolbar has buttons (${documentSet.own.join(', ')})`)
  assert.ok(documentSet.menus.length === 2, 'document toolbar has the heading and more menus')

  // A legacy box (stored before this change) loads unchanged and shows its formatting.
  await openNote('Alt.famd')
  const legacy = page.locator('.note-text-field').first()
  await legacy.waitFor()
  assert.ok(await legacy.locator('.note-text-field-render strong').count() > 0, 'legacy box renders its markdown')
  assert.ok(await legacy.locator('.note-text-field-render li').count() > 0, 'legacy box renders its list')

  // A new box through the real placement flow.
  await openNote('Neu.famd')
  await page.locator(`button[aria-label="${t('Textfeld einfügen')}"]`).first().click()
  const sheet = await page.locator('.unified-paper').first().boundingBox()
  assert.ok(sheet, 'sheet is visible')
  await page.mouse.click(sheet.x + sheet.width * 0.15, sheet.y + 140)
  const area = page.locator('textarea[data-note-text-field]').first()
  await area.waitFor()
  const boxToolbar = '.note-text-field-toolbar .formatting-toolbar'
  await page.locator(boxToolbar).waitFor()

  await sleep(600)
  const boxSet = await toolbarSet(boxToolbar)
  assert.deepEqual(boxSet.own, documentSet.own, 'toolbar buttons: text box == document (same order)')
  assert.deepEqual(boxSet.titles, documentSet.titles, 'toolbar tooltips: text box == document')
  assert.deepEqual(boxSet.menus, documentSet.menus, 'toolbar menus: text box == document')
  console.log(`ok toolbar parity: ${boxSet.own.length} buttons, menus ${boxSet.menus.map(([name, items]) => `${name} (${items.length})`).join(', ')}`)

  const value = () => area.inputValue()
  const bar = page.locator(boxToolbar)
  const clickBar = async (label) => { await bar.locator(`button[aria-label="${label}"]`).first().click() }
  const clickMenu = async (menu, label) => {
    await bar.locator(`button[aria-label="${t(menu)}"]`).first().click()
    await page.locator(`.ftb-popover [aria-label="${label}"]`).first().click()
  }
  // Appends a fresh line "abc", selects it, runs the option and returns what the option added.
  const apply = async (label, run, expected) => {
    await area.focus()
    await page.keyboard.press('Control+End')
    await page.keyboard.type('\nabc')
    const base = (await value()).slice(0, -3)
    await area.evaluate((node) => node.setSelectionRange(node.value.length - 3, node.value.length))
    await run()
    await sleep(60)
    const added = (await value()).slice(base.length)
    for (const part of [].concat(expected)) assert.ok(added.includes(part), `${label}: expected ${JSON.stringify(part)} in ${JSON.stringify(added)}`)
  }
  await area.focus()
  await page.keyboard.type('Start')
  const barOption = (german, expected) => apply(german, () => clickBar(t(german)), expected)
  await barOption('Fett', '**abc**')
  await barOption('Kursiv', '*abc*')
  await barOption('Durchgestrichen', '~~abc~~')
  await barOption('Text tiefgestellt', '<sub>abc</sub>')
  await barOption('Text hochgestellt', '<sup>abc</sup>')
  await barOption('Code', '`abc`')
  await barOption('Link', '[abc](https://)')
  await barOption('Aufzählung', '- abc')
  await barOption('Nummerierte Liste', '1. abc')
  await barOption('Aufgabenliste', '- [ ] abc')
  await barOption('Zitat', '> abc')
  for (let level = 1; level <= 6; level += 1) await apply(`Überschrift ${level}`, () => clickMenu('Überschrift', t(`Überschrift ${level}`)), `${'#'.repeat(level)} abc`)
  await apply('Mathematikblock', () => clickMenu('Mehr', t('Mathematikblock')), '$$\nabc\n$$')
  await apply('Einklappbarer Bereich', () => clickMenu('Mehr', t('Einklappbarer Bereich')), ['<details>', 'abc'])
  await apply('Codeblock', () => clickMenu('Mehr', t('Codeblock')), '```\nabc\n```')
  await apply('Trennlinie', () => clickMenu('Mehr', t('Trennlinie')), '---')
  await apply('Tabelle 3x3', () => clickMenu('Mehr', english ? 'Insert table with 3 rows and 3 columns' : 'Tabelle mit 3 Zeilen und 3 Spalten einfügen'), ['| --- |', 'abc'])
  await apply('Formel Bruch', async () => {
    await bar.locator(`button[aria-label="${t('Mehr')}"]`).first().click()
    await page.locator(`.ftb-popover input[aria-label="${t('Erstes Stück')}"]`).fill('3')
    await page.locator(`.ftb-popover input[aria-label="${t('Zweites Stück')}"]`).fill('4')
    await page.locator(`.ftb-popover button[aria-label="${t('Bruch')}"]`).click()
  }, '$\\frac{3}{4}$')
  await apply('Strg+B', () => page.keyboard.press('Control+b'), '**abc**')
  await apply('Strg+I', () => page.keyboard.press('Control+i'), '*abc*')
  await apply('Strg+K', () => page.keyboard.press('Control+k'), '[abc](https://)')
  // Undo steps back through the formatted edits like in the editor.
  const beforeUndo = await value()
  await page.keyboard.press('Control+z')
  await sleep(100)
  assert.notEqual(await value(), beforeUndo, 'Strg+Z undoes the last formatting')
  await page.keyboard.press('Control+Shift+z')
  await sleep(100)
  assert.equal(await value(), beforeUndo, 'Strg+Umschalt+Z redoes it')
  console.log('ok every option formats the text box content')

  // The toolbar stays inside the window and the box stays reachable.
  const fits = async (label) => {
    const rect = await page.evaluate((selector) => {
      const node = document.querySelector(selector)
      const box = node?.getBoundingClientRect()
      return box ? { left: box.left, right: box.right, top: box.top, bottom: box.bottom, width: innerWidth, height: innerHeight } : null
    }, '.note-text-field-toolbar')
    assert.ok(rect && rect.left >= -1 && rect.right <= rect.width + 1 && rect.top >= -1 && rect.bottom <= rect.height + 1, `${label}: toolbar on screen ${JSON.stringify(rect)}`)
    // The bar lives in the app header, above the page area that holds the box.
    const view = await page.locator('.paper-view').first().boundingBox()
    assert.ok(view && rect.bottom <= view.y + 1, `${label}: toolbar sits above the page, not over the box (${JSON.stringify(rect)} vs ${JSON.stringify(view)})`)
  }
  await fits('wide window')
  const session = await page.context().newCDPSession(page)
  await session.send('Emulation.setDeviceMetricsOverride', { width: 760, height: 700, deviceScaleFactor: 1, mobile: false })
  await sleep(700)
  await fits('narrow window')
  await bar.locator(`button[aria-label="${t('Mehr')}"]`).first().click()
  const popover = await page.locator('.ftb-popover').boundingBox()
  assert.ok(popover && popover.x >= -1 && popover.x + popover.width <= 761, `narrow window: Mehr menu on screen ${JSON.stringify(popover)}`)
  await bar.locator(`button[aria-label="${t('Mehr')}"]`).first().click()
  await session.send('Emulation.clearDeviceMetricsOverride')
  await sleep(500)

  // Persistence: leave the box, switch notes, reopen, read the file.
  const finalText = await value()
  await area.focus()
  await page.keyboard.press('Escape')
  await sleep(2500)
  await openNote('Anfang.md')
  await sleep(500)
  await openNote('Neu.famd')
  const stored = parseFamd(fs.readFileSync(path.join(vault, 'Neu.famd'), 'utf8')).payload?.textFields ?? []
  assert.equal(stored.length, 1, 'one text box stored')
  assert.equal(stored[0].text, finalText, 'formatted text persisted in the .famd')
  const rendered = page.locator('.note-text-field-render').first()
  await rendered.waitFor()
  for (const selector of ['strong', 'em', 'del', 'sub', 'sup', 'code', 'a', 'ul', 'ol', 'blockquote', 'h1', 'h6', 'table', 'hr', 'pre', '.katex']) {
    assert.ok(await rendered.locator(selector).count() > 0, `reopened box renders <${selector}>`)
  }
  const legacyStored = parseFamd(fs.readFileSync(path.join(vault, 'Alt.famd'), 'utf8')).payload?.textFields ?? []
  assert.deepEqual(legacyStored[0], legacyBox, 'legacy box is stored unchanged')
  assert.deepEqual(pageErrors, [], 'no page errors')
  console.log('ok formatting persists after reopening; legacy box unchanged')
} catch (error) {
  failure = error
}
try { await browser?.close() } catch {}
try { process.kill(-child.pid, 'SIGTERM') } catch {}
await sleep(500)
fs.rmSync(temporary, { recursive: true, force: true })
if (failure) {
  console.error(failure instanceof Error ? failure.stack ?? failure.message : failure)
  process.exit(1)
}
console.log('text field toolbar: ok')
process.exit(0)
