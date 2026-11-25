// Real Electron check for the shared dialog shell (DialogFrame) and the shared menu keyboard contract.
//   Part A (the app, synthetic vault, light and dark, normal and 940x620 window):
//     Fehler melden, Versionsverlauf, Karteikarten open as shell dialogs; the file-tree, tab and editor menus take focus.
//   Part B (harness page in Electron with the real stylesheet): Fehler & Wünsche and the add-on prompt, which need an
//     account/server or a running add-on and cannot be opened in a fresh profile.
// For every dialog: it fits the window, has no horizontal overflow, uses the one dialog radius and the header of the
// confirm dialog (icon tile, eyebrow, title, close button), focus moves in, Tab stays inside, Escape closes.
// Menus: focus moves to the first item, Arrow keys/Home/End walk the items, Tab and Escape close, focus returns.
// FANOTES_DIALOG_SHOTS=<dir> saves a screenshot of every dialog. Needs `vite build` (dist/), xvfb-run, playwright-core.
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'
import { singleEntryPlugin } from './fixtures/single-entry-plugin.mjs'

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const skip = (why) => { console.log(`dialog-shell: skipped (${why})`); process.exit(0) }
if (process.env.FANOTES_SKIP_BROWSER === '1') skip('FANOTES_SKIP_BROWSER=1')
if (!spawnSync('sh', ['-c', 'command -v xvfb-run'], { encoding: 'utf8' }).stdout.trim()) skip('no xvfb-run')
if (!fs.existsSync(path.join(appRoot, 'dist', 'index.html'))) skip('no dist/ (run vite build)')
let flow
try { flow = await import('./lib/desktop-flow.mjs') } catch { skip('no playwright-core; set PLAYWRIGHT_CORE') }
const { createProfile, launch, connect, stop, sleep, makePdf, dismissNotices, electronBinary } = flow
const playwright = await import(process.env.PLAYWRIGHT_CORE || 'playwright-core')
const chromium = playwright.chromium ?? playwright.default.chromium

const shots = process.env.FANOTES_DIALOG_SHOTS || ''
if (shots) fs.mkdirSync(shots, { recursive: true })
const failures = []
const fail = (message) => { failures.push(message); console.log(`  FAIL ${message}`) }
const checked = []

const DIALOG = '[role="dialog"], [role="alertdialog"]'

/** Measures the topmost visible dialog. */
const probe = (page, selector = DIALOG) => page.evaluate((sel) => {
  const dialog = [...document.querySelectorAll(sel)].filter((node) => node.getClientRects().length).pop()
  if (!dialog) return null
  const rect = dialog.getBoundingClientRect()
  const style = getComputedStyle(dialog)
  const scrollers = [dialog, ...dialog.querySelectorAll('.dialog-frame__body')]
  const header = dialog.querySelector('.confirm-dialog-header')
  const icon = header?.querySelector('.confirm-dialog-icon')?.getBoundingClientRect()
  const close = header?.querySelector('button')
  return {
    cls: String(dialog.className).slice(0, 60),
    rect: { top: rect.top, left: rect.left, right: rect.right, bottom: rect.bottom },
    viewport: { width: innerWidth, height: innerHeight },
    radius: style.borderRadius,
    overflowX: scrollers.some((node) => node.scrollWidth > node.clientWidth + 1),
    wideChild: [...dialog.querySelectorAll('*')].some((node) => !node.closest('.dialog-frame__body') ? false : node.getBoundingClientRect().right > dialog.getBoundingClientRect().right + 1),
    header: Boolean(header),
    iconSize: icon ? `${Math.round(icon.width)}x${Math.round(icon.height)}` : null,
    eyebrow: Boolean(header?.querySelector('.eyebrow')),
    title: Boolean(header?.querySelector('h2')) && dialog.getAttribute('aria-labelledby') === header.querySelector('h2')?.id,
    closeLabel: close?.getAttribute('aria-label') ?? null,
    focusInside: dialog.contains(document.activeElement),
  }
}, selector)

const shot = async (page, name) => {
  if (!shots) return
  const box = await page.evaluate((sel) => { const el = [...document.querySelectorAll(sel)].filter((node) => node.getClientRects().length).pop(); const r = el?.getBoundingClientRect(); return r ? { x: Math.max(0, r.left - 12), y: Math.max(0, r.top - 12), width: r.width + 24, height: r.height + 24 } : null }, DIALOG)
  if (box) await page.screenshot({ path: path.join(shots, `${name}.png`), clip: box }).catch(() => {})
}

/** The whole dialog contract for one open dialog; closes it with Escape at the end. */
const verifyDialog = async (page, label, { expectIconSize = '36x36' } = {}) => {
  const m = await probe(page)
  if (!m) { fail(`${label}: dialog is not visible`); return }
  checked.push(label)
  if (m.rect.top < -1 || m.rect.left < -1 || m.rect.right > m.viewport.width + 1 || m.rect.bottom > m.viewport.height + 1) fail(`${label}: dialog leaves the ${m.viewport.width}x${m.viewport.height} window (${JSON.stringify(m.rect)})`)
  if (m.overflowX || m.wideChild) fail(`${label}: horizontal overflow`)
  if (m.radius !== '18px') fail(`${label}: radius ${m.radius}, the dialog shell uses 18px`)
  if (!m.header || !m.eyebrow || !m.title) fail(`${label}: header is not the shell header (header ${m.header}, eyebrow ${m.eyebrow}, labelled title ${m.title})`)
  if (m.iconSize !== expectIconSize) fail(`${label}: header icon tile ${m.iconSize}, expected ${expectIconSize}`)
  if (!m.closeLabel) fail(`${label}: close button has no label`)
  if (!m.focusInside) fail(`${label}: focus did not move into the dialog`)
  for (let step = 0; step < 24; step += 1) {
    await page.keyboard.press(step % 5 === 4 ? 'Shift+Tab' : 'Tab')
    const inside = await page.evaluate((sel) => { const d = [...document.querySelectorAll(sel)].filter((node) => node.getClientRects().length).pop(); return Boolean(d && d.contains(document.activeElement)) }, DIALOG)
    if (!inside) { fail(`${label}: Tab leaves the dialog`); break }
  }
  await page.keyboard.press('Escape')
  await sleep(350)
  if (await probe(page)) fail(`${label}: Escape does not close the dialog`)
}

const contrastOk = (page, label) => page.evaluate(() => {
  const dialog = [...document.querySelectorAll('[role="dialog"]')].filter((node) => node.getClientRects().length).pop()
  const bg = dialog ? getComputedStyle(dialog).backgroundColor : ''
  const text = dialog ? getComputedStyle(dialog).color : ''
  return { bg, text }
}).then(({ bg, text }) => { if (bg === text) fail(`${label}: text and background are the same colour`) })

const menuContract = async (page, label, openMenu, menuSelector) => {
  await openMenu()
  await sleep(500)
  const state = () => page.evaluate((sel) => {
    const menu = document.querySelector(sel)
    if (!menu) return null
    const items = [...menu.querySelectorAll('[role="menuitem"]:not(:disabled), button:not(:disabled)')].filter((n) => n.getClientRects().length)
    return { count: items.length, index: items.indexOf(document.activeElement), inside: menu.contains(document.activeElement) }
  }, menuSelector)
  let s = await state()
  if (!s) { fail(`${label}: menu did not open`); return }
  checked.push(label)
  if (!s.inside || s.index !== 0) fail(`${label}: focus did not move to the first item (index ${s.index})`)
  await page.keyboard.press('ArrowDown')
  s = await state()
  if (s?.index !== 1) fail(`${label}: ArrowDown did not move to the second item (index ${s?.index})`)
  await page.keyboard.press('End')
  s = await state()
  if (s?.index !== s?.count - 1) fail(`${label}: End did not move to the last item`)
  await page.keyboard.press('ArrowDown')
  s = await state()
  if (s?.index !== 0) fail(`${label}: ArrowDown does not wrap to the first item`)
  await page.keyboard.press('ArrowUp')
  s = await state()
  if (s?.index !== s?.count - 1) fail(`${label}: ArrowUp does not wrap to the last item`)
  await page.keyboard.press('Home')
  s = await state()
  if (s?.index !== 0) fail(`${label}: Home did not move to the first item`)
  await page.keyboard.press('Escape')
  await sleep(300)
  if (await state()) fail(`${label}: Escape does not close the menu`)
  // Tab closes it as well.
  await openMenu()
  await sleep(500)
  await page.keyboard.press('Tab')
  await sleep(300)
  if (await state()) fail(`${label}: Tab does not close the menu`)
}

const runApp = async (theme) => {
  console.log(`app ${theme}`)
  const profile = createProfile('dialog-shell-', { theme })
  fs.mkdirSync(path.join(profile.vault, 'Biologie'), { recursive: true })
  fs.writeFileSync(path.join(profile.vault, 'Biologie', 'Notiz.md'), '# Zelle\n\nText with #tag.\n\n- one\n- two\n')
  fs.writeFileSync(path.join(profile.vault, 'Biologie', 'Blatt.pdf'), makePdf())
  const app = launch(profile)
  let browser
  try {
    const connected = await connect(app)
    browser = connected.browser
    const page = connected.page
    await sleep(1200)
    await dismissNotices(page)
    const press = (key) => page.keyboard.press(key)
    const openRow = async (text) => {
      const row = page.locator('.file-tree__row', { hasText: text }).first()
      if (!(await row.isVisible().catch(() => false))) { await page.locator('.file-tree__row[data-kind="folder"]', { hasText: 'Biologie' }).first().click(); await sleep(400) }
      await row.click()
    }
    const viaPalette = async (query) => { await press('Control+p'); await page.locator('.command-palette input').first().fill(query); await sleep(300); await press('Enter'); await sleep(700) }
    await openRow('Notiz')
    await sleep(1500)
    for (const [size, viewport] of [['normal', null], ['small', { width: 940, height: 620 }]]) {
      if (viewport) await page.setViewportSize(viewport)
      await sleep(400)
      for (const [name, query] of [['bugreport', 'Fehler melden'], ['history', 'Versionsverlauf'], ['flashcards', 'Karteikarten']]) {
        await viaPalette(query)
        await sleep(400)
        const label = `${name} ${theme} ${size}`
        await contrastOk(page, label)
        if (size === 'normal') await shot(page, `${name}-${theme}`)
        await verifyDialog(page, label)
      }
    }
    await page.setViewportSize({ width: 1440, height: 940 })
    await sleep(300)
    await menuContract(page, `file-tree menu ${theme}`, async () => { await page.locator('.file-tree__row', { hasText: 'Notiz' }).first().click({ button: 'right' }) }, '.file-tree__context-menu:not(.tab-context-menu)')
    await menuContract(page, `tab menu ${theme}`, async () => { await page.locator('.tabs-bar [title$="Notiz.md"]').first().click({ button: 'right' }) }, '.tab-context-menu')
    await menuContract(page, `editor menu ${theme}`, async () => { await page.locator('button[aria-label="Weitere Notizaktionen"]').click() }, '.editor-more-menu')
  } finally {
    await stop(app, browser)
    profile.dispose()
  }
}

const runHarness = async () => {
  console.log('harness (work requests, add-on prompt)')
  const temporary = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'dialog-shell-harness-'))
  const output = path.join(temporary, 'dist')
  try {
    const entry = path.join(appRoot, 'scripts/fixtures/dialog-shell-harness.tsx')
    await build({
      plugins: [singleEntryPlugin(entry)],
      root: appRoot,
      logLevel: 'error',
      configFile: path.join(appRoot, 'vite.config.ts'),
      define: { 'process.env.NODE_ENV': JSON.stringify('production') },
      build: { outDir: output, emptyOutDir: true, lib: { entry, formats: ['es'], fileName: () => 'harness.js' } },
    })
    const css = fs.readdirSync(output).find((name) => name.endsWith('.css'))
    fs.writeFileSync(path.join(output, 'index.html'), `<!doctype html><html><head>${css ? `<link rel="stylesheet" href="./${css}">` : ''}</head><body><div id="root"></div><script type="module" src="./harness.js"></script></body></html>`)
    for (const theme of ['light', 'dark']) {
      for (const [name, hash, query] of [['workrequests', 'work-requests', ''], ['workrequests-list', 'work-requests', '&tab=mine'], ['addon-prompt', 'addon-prompt', '']]) {
        const port = 19_900 + Math.floor(Math.random() * 90)
        const url = `file://${path.join(output, 'index.html')}?theme=${theme}${query}#${hash}`
        const child = spawn('xvfb-run', ['-a', '-s', '-screen 0 1440x1000x24', electronBinary, path.join(appRoot, 'scripts/fixtures/harness-main.cjs'), `--remote-debugging-port=${port}`, '--no-sandbox', '--harness', url], { stdio: ['ignore', 'pipe', 'pipe'], detached: true })
        let browser
        try {
          for (let tries = 0; tries < 120 && !browser; tries += 1) { try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`) } catch { await sleep(250) } }
          if (!browser) { fail(`${name} ${theme}: Electron did not start`); continue }
          let page
          for (let tries = 0; tries < 80 && !page; tries += 1) { page = browser.contexts().flatMap((context) => context.pages()).find((candidate) => candidate.url().includes('index.html')); if (!page) await sleep(200) }
          page.on('pageerror', (error) => console.log(`  pageerror ${name} ${theme}: ${String(error).slice(0, 200)}`))
          await page.waitForSelector('[role="dialog"]', { timeout: 20_000 }).catch((error) => { throw new Error(`${name} ${theme}: no dialog (${page.url().slice(-60)}) ${String(error).split('\n')[0]}`) })
          await sleep(500)
          for (const [size, viewport] of [['normal', { width: 1280, height: 860 }], ['small', { width: 940, height: 620 }]]) {
            await page.setViewportSize(viewport)
            await sleep(300)
            const label = `${name} ${theme} ${size}`
            if (size === 'normal') await shot(page, `${name}-${theme}`)
            const m = await probe(page)
            if (!m) { fail(`${label}: dialog is not visible`); continue }
            // The harness has no opener and closes nothing on Escape, so only the geometry and keyboard trap are asserted.
            checked.push(label)
            if (m.rect.top < -1 || m.rect.bottom > m.viewport.height + 1 || m.rect.left < -1 || m.rect.right > m.viewport.width + 1) fail(`${label}: dialog leaves the window (${JSON.stringify(m.rect)})`)
            if (m.overflowX || m.wideChild) fail(`${label}: horizontal overflow`)
            if (m.radius !== '18px') fail(`${label}: radius ${m.radius}`)
            if (!m.header || !m.eyebrow || !m.title || m.iconSize !== '36x36' || !m.closeLabel) fail(`${label}: header is not the shell header (${JSON.stringify({ h: m.header, e: m.eyebrow, t: m.title, i: m.iconSize, c: m.closeLabel })})`)
            if (!m.focusInside) fail(`${label}: focus did not move into the dialog`)
            for (let step = 0; step < 20; step += 1) {
              await page.keyboard.press('Tab')
              const inside = await page.evaluate(() => { const d = document.querySelector('[role="dialog"]'); return Boolean(d && d.contains(document.activeElement)) })
              if (!inside) { fail(`${label}: Tab leaves the dialog`); break }
            }
          }
        } finally {
          await browser?.close().catch(() => {})
          try { process.kill(-child.pid, 'SIGTERM') } catch { /* gone */ }
          await sleep(500)
        }
      }
    }
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true })
  }
}

const watchdog = setTimeout(() => { console.error('dialog-shell: watchdog (9 min)'); process.exit(1) }, 9 * 60_000)
try {
  for (const theme of (process.env.FANOTES_DIALOG_SKIP_APP ? [] : ['light', 'dark'])) await runApp(theme).catch((error) => fail(`app ${theme} aborted: ${String(error).split('\n')[0]}`))
  await runHarness().catch((error) => fail(`harness aborted: ${String(error).split('\n')[0]}`))
} finally {
  clearTimeout(watchdog)
}
console.log(`dialog-shell: ${checked.length} dialog/menu states checked`)
if (failures.length) { console.error(`dialog-shell: ${failures.length} failures`); process.exit(1) }
console.log('dialog-shell: ok')
