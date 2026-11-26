// Real Electron check for the shared dialog shell (DialogFrame) and the shared menu keyboard contract.
//   Part A (the app, synthetic vault, light and dark, normal and 940x620 window):
//     Fehler melden, Versionsverlauf, Karteikarten open as shell dialogs; the file-tree, tab and editor menus take focus.
//   Part B (harness page in Electron with the real stylesheet): Fehler & Wünsche and the add-on prompt, which need an
//     account/server or a running add-on and cannot be opened in a fresh profile.
// For every dialog: it fits the window, has no horizontal overflow, uses the one dialog radius and the header of the
// confirm dialog (icon tile, eyebrow, title, close button), focus moves in, Tab stays inside, Escape closes.
// Menus: focus moves to the first item, Arrow keys/Home/End walk the items, Tab and Escape close, focus returns.
//   Round 2 adds: the toolbar popovers, note tags popover and paper picker (focus in, arrows, Escape returns focus), the
//   folder context menu (fits the window, grouped, rarer choices open in place), Geschichte importieren and the
//   writing-mode export and footnote dialogs, the first-run diagnostics notice (never above a modal), and in the
//   harness the OneNote import, share-with-user dialog and the share presence popover.
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

const shot = async (page, name, selector = DIALOG) => {
  if (!shots) return
  const box = await page.evaluate((sel) => { const el = [...document.querySelectorAll(sel)].filter((node) => node.getClientRects().length).pop(); const r = el?.getBoundingClientRect(); return r ? { x: Math.max(0, r.left - 12), y: Math.max(0, r.top - 12), width: Math.min(innerWidth, r.width + 24), height: Math.min(innerHeight, r.height + 24) } : null }, selector)
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

const MENU_ITEMS = '[role="menuitem"]:not(:disabled), button:not(:disabled)'
/**
 * Keyboard contract of a menu or popover. `items` is what the menu treats as an item, `returnTo` the element that
 * must hold focus after Escape, `tab: 'edge'` for popovers where Tab walks the controls and only leaving closes it.
 */
const menuContract = async (page, label, openMenu, menuSelector, { items = MENU_ITEMS, returnTo = null, tab = 'close', firstInput = false, initialAny = false, arrows = true } = {}) => {
  await openMenu()
  await sleep(500)
  const state = () => page.evaluate(({ sel, itemSel }) => {
    const menu = document.querySelector(sel)
    if (!menu) return null
    const nodes = [...menu.querySelectorAll(itemSel)].filter((n) => n.getClientRects().length)
    return { count: nodes.length, index: nodes.indexOf(document.activeElement), inside: menu.contains(document.activeElement), tag: document.activeElement?.tagName }
  }, { sel: menuSelector, itemSel: items })
  let s = await state()
  if (!s) { fail(`${label}: menu did not open`); return }
  checked.push(label)
  const start = s.index
  if (!s.inside || (firstInput ? s.tag !== 'INPUT' : initialAny ? s.index < 0 : s.index !== 0)) fail(`${label}: focus did not move to the first item (index ${s.index}, ${s.tag})`)
  if (s.count > 1 && !firstInput && arrows) {
    await page.keyboard.press('ArrowDown')
    s = await state()
    if (s?.index !== (start + 1) % s.count) fail(`${label}: ArrowDown did not move to the next item (index ${s?.index})`)
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
  }
  await page.keyboard.press('Escape')
  await sleep(300)
  if (await state()) fail(`${label}: Escape does not close the menu`)
  if (returnTo) {
    const back = await page.evaluate((sel) => Boolean(document.activeElement?.matches(sel)), returnTo)
    if (!back) fail(`${label}: focus did not return to the opener after Escape`)
  }
  // Tab closes it as well (for a popover with several controls: Tab out of the last one).
  await openMenu()
  await sleep(500)
  if (tab === 'edge' && !firstInput) await page.keyboard.press('End')
  await page.keyboard.press('Tab')
  await sleep(300)
  if (await state()) fail(`${label}: Tab does not close the menu`)
}

/** The menu (or popover) stays inside the window and has no horizontal overflow. */
const menuFits = async (page, label, selector) => {
  const m = await page.evaluate((sel) => {
    const el = [...document.querySelectorAll(sel)].filter((n) => n.getClientRects().length).pop()
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { top: r.top, left: r.left, right: r.right, bottom: r.bottom, vw: innerWidth, vh: innerHeight, overflowX: el.scrollWidth > el.clientWidth + 1, height: r.height }
  }, selector)
  if (!m) { fail(`${label}: not visible`); return null }
  checked.push(`${label} fits`)
  if (m.top < -1 || m.left < -1 || m.right > m.vw + 1 || m.bottom > m.vh + 1) fail(`${label}: leaves the ${m.vw}x${m.vh} window (${Math.round(m.top)}..${Math.round(m.bottom)})`)
  if (m.overflowX) fail(`${label}: horizontal overflow`)
  return m
}

const runApp = async (theme) => {
  console.log(`app ${theme}`)
  const profile = createProfile('dialog-shell-', { theme })
  fs.mkdirSync(path.join(profile.vault, 'Biologie'), { recursive: true })
  fs.mkdirSync(path.join(profile.vault, 'Leer'), { recursive: true })
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
    // Toolbar popovers, note tags and paper picker: focus enters, arrows walk, Escape closes and focus returns to the button.
    const popItems = '[role="menuitem"]:not(:disabled), button:not(:disabled):not([tabindex="-1"]), input:not(:disabled), select:not(:disabled)'
    const triggers = page.locator('.ftb-menu > button')
    for (let index = 0; index < await triggers.count(); index += 1) {
      const trigger = triggers.nth(index)
      if (!(await trigger.isVisible()) || await trigger.isDisabled()) continue
      const name = await trigger.getAttribute('aria-label')
      await menuContract(page, `toolbar popover "${name}" ${theme}`, async () => { await trigger.click() }, '.ftb-popover', { items: popItems, returnTo: '.ftb-menu > button', tab: 'edge', arrows: name !== 'Mehr' })
      await trigger.click()
      await sleep(400)
      await menuFits(page, `toolbar popover "${name}" ${theme}`, '.ftb-popover')
      await shot(page, `ftb-${index}-${theme}`, '.ftb-popover')
      await page.keyboard.press('Escape')
      await sleep(250)
    }
    await menuContract(page, `note tags popover ${theme}`, async () => { await page.locator('.note-tags-menu > button').click() }, '.note-tags-popover', { items: 'button:not(:disabled), input:not(:disabled)', returnTo: '.note-tags-menu > button', tab: 'edge', firstInput: true })
    await menuContract(page, `paper picker ${theme}`, async () => { await page.locator('.paper-picker__trigger').first().click() }, '.paper-picker__menu', { items: '[role="option"]:not(:disabled)', returnTo: '.paper-picker__trigger', initialAny: true })
    // Folder menu: fits the window (also a small one), grouped; the rarer choices open in place and still fit.
    const folderMenu = '.file-tree__context-menu:not(.tab-context-menu)'
    const openFolderMenu = async () => { await page.locator('.file-tree__row[data-kind="folder"]', { hasText: 'Leer' }).first().click({ button: 'right' }); await sleep(450) }
    for (const [size, viewport] of [['normal', { width: 1440, height: 940 }], ['small', { width: 940, height: 620 }]]) {
      await page.setViewportSize(viewport)
      await sleep(300)
      await openFolderMenu()
      const closed = await menuFits(page, `folder menu ${theme} ${size}`, folderMenu)
      if (closed && size === 'normal' && closed.height > 700) fail(`folder menu ${theme}: ${Math.round(closed.height)}px tall, the groups should keep it under 700px`)
      if (size === 'normal') await shot(page, `folder-menu-${theme}`, folderMenu)
      const share = page.locator(`${folderMenu} button[aria-expanded]`, { hasText: 'Teilen' })
      if (!(await share.count())) fail(`folder menu ${theme} ${size}: no Teilen disclosure`)
      else {
        await share.click()
        await sleep(350)
        await menuFits(page, `folder menu expanded ${theme} ${size}`, folderMenu)
        if (size === 'normal') await shot(page, `folder-menu-open-${theme}`, folderMenu)
        const opened = await page.evaluate(() => [...document.querySelectorAll('.file-tree__submenu button')].filter((n) => n.getClientRects().length).length)
        if (opened < 3) fail(`folder menu ${theme} ${size}: Teilen did not reveal its choices`)
      }
      await page.keyboard.press('Escape')
      await sleep(300)
    }
    await page.setViewportSize({ width: 1440, height: 940 })
    await sleep(300)
    await menuContract(page, `folder menu ${theme}`, openFolderMenu, folderMenu)
    // Geschichte importieren: it used to render unstyled at the bottom of the window (writing.css was not loaded).
    await viaPalette('Geschichte importieren')
    await sleep(500)
    await shot(page, `story-import-${theme}`)
    await verifyDialog(page, `story import ${theme}`)
  } finally {
    await stop(app, browser)
    profile.dispose()
  }
}

/** Writing mode (export, footnote dialogs) and the first-run diagnostics notice, each in its own app start. */
const runExtra = async (theme) => {
  console.log(`app extras ${theme}`)
  const profile = createProfile('dialog-shell-extra-', { theme, diagnosticsEnabled: true, diagnosticsNoticeSeen: false })
  fs.mkdirSync(path.join(profile.vault, 'Leer'), { recursive: true })
  fs.writeFileSync(path.join(profile.vault, 'Notiz.md'), '# Notiz\n')
  const app = launch(profile)
  let browser
  try {
    const connected = await connect(app)
    browser = connected.browser
    const page = connected.page
    await sleep(1500)
    // The notice is up (nothing dismissed it). Open the Fehler-melden dialog: the dialog must cover the notice.
    const notice = await page.locator('.send-data-notice').count()
    if (!notice) fail(`diagnostics ${theme}: the first-run notice is not shown, the check cannot test the stacking`)
    else {
      await page.keyboard.press('Control+p')
      await page.locator('.command-palette input').first().fill('Fehler melden')
      await sleep(300)
      await page.keyboard.press('Enter')
      await sleep(900)
      const top = await page.evaluate(() => {
        const box = document.querySelector('.send-data-notice')?.getBoundingClientRect()
        const backdrop = document.querySelector('.modal-backdrop')
        if (!box || !backdrop) return 'missing'
        const point = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)
        return document.querySelector('.send-data-notice')?.contains(point) ? 'notice' : 'modal'
      })
      checked.push(`diagnostics notice under modal ${theme}`)
      if (top !== 'modal') fail(`diagnostics ${theme}: the first-run notice is drawn over an open dialog (${top})`)
      await shot(page, `diagnostics-over-modal-${theme}`, '.send-data-notice, .modal-backdrop')
      await page.keyboard.press('Escape')
      await sleep(400)
    }
    await dismissNotices(page)
    await sleep(300)
    // Writing mode: a new story from the folder menu.
    const folder = page.locator('.file-tree__row[data-kind="folder"]', { hasText: 'Leer' }).first()
    await folder.hover()
    await folder.locator('button[aria-haspopup="menu"]').click({ force: true })
    await page.locator('.file-tree__context-menu button', { hasText: 'Neue Geschichte' }).click()
    await page.locator('.wm-page').first().waitFor({ timeout: 60_000 })
    await sleep(900)
    for (const [size, viewport] of [['normal', { width: 1440, height: 940 }], ['small', { width: 940, height: 620 }]]) {
      await page.setViewportSize(viewport)
      await sleep(400)
      await page.locator('.wm-page').first().click({ position: { x: 160, y: 200 }, force: true })
      await page.keyboard.type('Ein Satz.')
      await page.locator('.wm-toolbar button[title^="Exportieren"]').click()
      await sleep(500)
      if (size === 'normal') await shot(page, `wm-export-${theme}`)
      await verifyDialog(page, `writing export ${theme} ${size}`)
      await page.locator('.wm-page').first().click({ position: { x: 160, y: 200 }, force: true })
      await page.keyboard.press('Control+Shift+O')
      await sleep(500)
      if (size === 'normal') await shot(page, `wm-footnote-${theme}`)
      await verifyDialog(page, `writing footnote ${theme} ${size}`)
    }
    await writingPanels(page, theme)
  } finally {
    await stop(app, browser)
    profile.dispose()
  }
}

/** Writing mode: the Assist popover (keeps the editor focus, Tab enters it, Escape returns) and the Scene panel. */
const writingPanels = async (page, theme) => {
  await page.setViewportSize({ width: 1440, height: 940 })
  await sleep(400)
  await page.locator('.wm-page').first().click({ position: { x: 160, y: 200 }, force: true })
  await page.keyboard.press('Control+End')
  await page.keyboard.press('Enter')
  await page.keyboard.type('Das ist ein Tset und es ist sehr schoen.')
  await sleep(1500)
  for (let i = 0; i < 30; i += 1) await page.keyboard.press('ArrowLeft')
  await page.keyboard.press('Shift+F7')
  await sleep(500)
  const label = `writing assist ${theme}`
  const state = () => page.evaluate(() => {
    const pop = document.querySelector('.wm-assist')
    if (!pop) return null
    const r = pop.getBoundingClientRect()
    const active = document.activeElement
    return { inEditor: Boolean(active?.matches('textarea.wm-input')), inside: pop.contains(active), fits: r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight, buttons: pop.querySelectorAll('button').length }
  })
  checked.push(label)
  let st = await state()
  if (!st) fail(`${label}: Shift+F7 does not open the popover`)
  else {
    if (!st.inEditor) fail(`${label}: opening it took the focus away from the editor`)
    if (!st.fits) fail(`${label}: leaves the window`)
    await shot(page, `wm-assist-${theme}`, '.wm-assist')
    await page.keyboard.press('Tab')
    await sleep(300)
    st = await state()
    if (!st?.inside) fail(`${label}: Tab does not move focus into the popover`)
    const before = await page.evaluate(() => document.activeElement?.textContent)
    await page.keyboard.press('ArrowDown')
    const after = await page.evaluate(() => ({ text: document.activeElement?.textContent, inside: Boolean(document.activeElement?.closest('.wm-assist')) }))
    if (!after.inside) fail(`${label}: ArrowDown leaves the popover`)
    else if (st.buttons > 3 && after.text === before) fail(`${label}: ArrowDown does not move between the suggestions`)
    await page.keyboard.press('Escape')
    await sleep(300)
    if (await state()) fail(`${label}: Escape does not close the popover`)
    else if (!(await page.evaluate(() => document.activeElement?.matches('textarea.wm-input')))) fail(`${label}: focus did not return to the editor`)
  }
  // Typing is never interrupted: open it again and type a letter, the editor still takes it.
  await page.keyboard.press('Shift+F7')
  await sleep(300)
  await page.keyboard.type('x')
  const typed = await page.evaluate(() => document.querySelector('.wm-page')?.textContent?.includes('x'))
  if (!typed) fail(`${label}: typing while the popover is open does not reach the editor`)
  await page.keyboard.press('Escape')

  // Scene panel
  await page.keyboard.press('F7')
  await sleep(400)
  await page.locator('.wm-tabs button[role="tab"]', { hasText: 'Szene' }).click()
  await sleep(400)
  for (const [size, viewport] of [['normal', { width: 1440, height: 940 }], ['small', { width: 940, height: 620 }]]) {
    await page.setViewportSize(viewport)
    await sleep(400)
    const panel = await page.evaluate(() => {
      const inspector = document.querySelector('.wm-inspector')
      if (!inspector) return null
      const box = inspector.getBoundingClientRect()
      const close = inspector.querySelector('.wm-tabs .wm-icon')?.getBoundingClientRect()
      const wide = [...inspector.querySelectorAll('.wm-inspector-body *')].filter((node) => node.getBoundingClientRect().right > box.right + 1).length
      const unnamed = [...inspector.querySelectorAll('.wm-inspector-body input, .wm-inspector-body select, .wm-inspector-body textarea, .wm-inspector-body button')].filter((node) => !(node.getAttribute('aria-label') || node.closest('label') || node.textContent?.trim() || node.getAttribute('title'))).length
      return { overflowX: inspector.scrollWidth > inspector.clientWidth + 1, closeVisible: Boolean(close && close.right <= box.right + 1 && close.left >= box.left), wide, unnamed }
    })
    const name = `writing scene panel ${theme} ${size}`
    checked.push(name)
    if (!panel) { fail(`${name}: panel missing`); continue }
    if (panel.overflowX || panel.wide) fail(`${name}: horizontal overflow (${JSON.stringify(panel)})`)
    if (!panel.closeVisible) fail(`${name}: the close button is clipped`)
    if (panel.unnamed) fail(`${name}: ${panel.unnamed} controls without a name`)
    if (size === 'normal') await shot(page, `wm-scene-${theme}`, '.wm-inspector')
  }
}

const runHarness = async () => {
  console.log('harness (work requests, add-on prompt, OneNote import, share dialogs, presence popover, pen menu)')
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
      for (const [name, hash, query] of [['workrequests', 'work-requests', ''], ['workrequests-list', 'work-requests', '&tab=mine'], ['addon-prompt', 'addon-prompt', ''], ['onenote', 'onenote', ''], ['share-user', 'share-user', ''], ['share-presence', 'share-presence', ''], ['pen-quick', 'pen-quick', ''], ['math-solver', 'math-solver', ''], ['math-solver-loading', 'math-solver', '&tab=recognizing'], ['math-solver-error', 'math-solver', '&tab=error'], ['math-correction', 'math-correction', ''], ['math-correction-loading', 'math-correction', '&tab=recognizing']]) {
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
          // Popovers: the share presence popover and the pen radial menu are no dialogs (the presence one is a popover dialog).
          if (name === 'pen-quick') {
            await page.waitForSelector('.lw-pqm-disc', { timeout: 20_000 })
            const fits = await page.evaluate(() => { const r = document.querySelector('.lw-pqm-disc').getBoundingClientRect(); return r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight })
            checked.push(`pen quick menu ${theme}`)
            if (!fits) fail(`pen quick menu ${theme}: leaves the window`)
            await shot(page, `pen-quick-${theme}`, '.lw-pqm-disc')
            continue
          }
          // The drawing board's math popovers (synthetic recognition results): fit the stage, focus in, arrows, Escape returns focus.
          if (name.startsWith('math-')) {
            await page.waitForSelector('.math-popover', { timeout: 20_000 })
            await sleep(400)
            const label = `${name} ${theme}`
            const geometry = () => page.evaluate(() => {
              const pop = document.querySelector('.math-popover')
              const stage = document.querySelector('#math-stage')
              if (!pop || !stage) return null
              const r = pop.getBoundingClientRect()
              const s = stage.getBoundingClientRect()
              const active = document.activeElement
              return {
                inside: pop.contains(active), onClose: Boolean(active?.matches('.math-popover__close')), onInput: Boolean(active?.matches('input[data-autofocus]')),
                fits: r.left >= s.left - 1 && r.right <= s.right + 1 && r.top >= s.top - 1 && r.bottom <= s.bottom + 1,
                overflowX: pop.scrollWidth > pop.clientWidth + 1, background: getComputedStyle(pop).backgroundColor, active: active?.tagName,
              }
            })
            const g = await geometry()
            checked.push(label)
            if (!g?.inside) fail(`${label}: focus did not move into the popover`)
            else if (name.endsWith('loading') ? !g.onClose : !(g.onInput || g.active === 'BUTTON')) fail(`${label}: focus is on the wrong control (${g.active})`)
            if (g && !g.fits) fail(`${label}: leaves its stage`)
            if (g?.overflowX) fail(`${label}: horizontal overflow`)
            await shot(page, label, '.math-popover')
            if (!name.endsWith('loading')) {
              const before = await page.evaluate(() => document.activeElement?.outerHTML.slice(0, 80))
              await page.keyboard.press('ArrowDown')
              const after = await page.evaluate(() => ({ html: document.activeElement?.outerHTML.slice(0, 80), inside: Boolean(document.activeElement?.closest('.math-popover')) }))
              if (!after.inside || after.html === before) fail(`${label}: ArrowDown does not move between the controls`)
              await page.keyboard.press('End')
              const last = await page.evaluate(() => ({ inside: Boolean(document.activeElement?.closest('.math-popover')), tag: document.activeElement?.tagName }))
              if (!last.inside) fail(`${label}: End leaves the popover`)
            }
            await page.keyboard.press('Escape')
            await sleep(400)
            if (await page.locator('.math-popover').count()) fail(`${label}: Escape does not close the popover`)
            else if (!(await page.evaluate(() => document.activeElement?.id === 'harness-opener'))) fail(`${label}: focus did not return to the page`)
            continue
          }
          if (name === 'share-presence') {
            await page.waitForSelector('.share-presence-popover', { timeout: 20_000 })
            await sleep(400)
            const state = () => page.evaluate(() => { const pop = document.querySelector('.share-presence-popover'); return pop ? { inside: pop.contains(document.activeElement), right: pop.getBoundingClientRect().right, vw: innerWidth } : null })
            let st = await state()
            checked.push(`share presence popover ${theme}`)
            if (!st?.inside) fail(`share presence popover ${theme}: focus did not move into the popover`)
            if (st && st.right > st.vw + 1) fail(`share presence popover ${theme}: leaves the window`)
            await shot(page, `share-presence-${theme}`, '.share-presence-popover')
            await page.keyboard.press('Escape')
            await sleep(300)
            if (await state()) fail(`share presence popover ${theme}: Escape does not close it`)
            else if (!(await page.evaluate(() => document.activeElement?.matches('.share-presence-button')))) fail(`share presence popover ${theme}: focus did not return to the avatar button`)
            continue
          }
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
          if (name === 'onenote' || name === 'share-user') {
            await page.keyboard.press('Escape')
            await sleep(400)
            if (!(await page.evaluate(() => document.body.hasAttribute('data-harness-closed')))) fail(`${name} ${theme}: Escape does not close the dialog`)
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

const watchdog = setTimeout(() => { console.error('dialog-shell: watchdog (15 min)'); process.exit(1) }, 15 * 60_000)
try {
  for (const theme of (process.env.FANOTES_DIALOG_SKIP_APP ? [] : ['light', 'dark'])) {
    await runApp(theme).catch((error) => fail(`app ${theme} aborted: ${String(error).split('\n')[0]}`))
    await runExtra(theme).catch((error) => fail(`app extras ${theme} aborted: ${String(error).split('\n')[0]}`))
  }
  await runHarness().catch((error) => fail(`harness aborted: ${String(error).split('\n')[0]}`))
} finally {
  clearTimeout(watchdog)
}
console.log(`dialog-shell: ${checked.length} dialog/menu states checked`)
if (failures.length) { console.error(`dialog-shell: ${failures.length} failures`); process.exit(1) }
console.log('dialog-shell: ok')
