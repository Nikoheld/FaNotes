// Real Electron check for the "Text in deine Handschrift" dialog (typed text -> ink in the user's letters):
//   - the dialog uses the app shell and tokens in dark and light (not the paper's forced light palette),
//     the insert button is readable, the dialog fits small windows
//   - no trained letters: a clear empty state with a way to train them; the preview still works (school script)
//   - few trained letters: it names the characters that fall back to the school script
//   - characters nobody can write (a euro sign) no longer block the insert; whitespace/empty never insert
//   - a very long text keeps the preview canvas small
//   - Escape closes and gives the focus back to the toolbar button; the draft survives Cancel but not an insert
//   - Ctrl+Enter inserts below the existing ink, in one undo step; undo removes it all
//   - an ink page that ends at the bottom of the sheet still takes the text (the page grows)
//   - opening the dialog stays fast
// Screenshots (light and dark) go to FANOTES_TTH_SHOTS (default: a temp folder).
// Needs `vite build`, xvfb-run and playwright-core (PLAYWRIGHT_CORE).
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { connect, createProfile, createReporter, dismissNotices, electronBinary, launch, root, sleep, stop, until } from './lib/desktop-flow.mjs'

const xvfb = spawnSync('sh', ['-c', 'command -v xvfb-run'], { encoding: 'utf8' }).stdout.trim()
const skipReason = process.env.FANOTES_SKIP_BROWSER === '1' ? 'FANOTES_SKIP_BROWSER=1'
  : !xvfb ? 'no xvfb-run'
    : !fs.existsSync(path.join(root, 'dist', 'index.html')) ? 'no dist/ (run vite build)'
      : !fs.existsSync(electronBinary) ? 'no electron' : ''
if (skipReason) {
  console.log(`text to handwriting flow: skipped (${skipReason})`)
  process.exit(0)
}
try { await import(process.env.PLAYWRIGHT_CORE || 'playwright-core') } catch {
  console.log('text to handwriting flow: skipped (no playwright-core; set PLAYWRIGHT_CORE)')
  process.exit(0)
}

const require = createRequire(import.meta.url)
const famd = require('../electron/famd.cjs')
const shots = process.env.FANOTES_TTH_SHOTS || fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'tth-shots-'))
fs.mkdirSync(shots, { recursive: true })
const { ok, failed, count } = createReporter()

const AT = '2026-11-01T00:00:00.000Z'
const OPEN = 'button[title^="Getippten Text"]'
const FIELD = '[data-tth-control="text"]'

/** A note with one line of ink at `y` (0..1 of the sheet). */
const seedNote = (profile, y) => {
  const ink = {
    schemaVersion: 1, title: 'Seite', paperStyle: 'lines', sourceWidth: 900, sourceHeight: 1273, createdAt: AT, updatedAt: AT,
    strokes: [{ color: '#202333', baseWidth: 3, pressureEnabled: true, brush: 'fineliner', points: Array.from({ length: 30 }, (_, k) => ({ x: 0.1 + k * 0.01, y: y + Math.sin(k / 3) * 0.004, t: k * 8, pressure: 0.5, pointerType: 'pen' })) }],
  }
  fs.writeFileSync(path.join(profile.vault, 'Hand.famd'), famd.serializeFamd('# Hand\n\n<!-- fanotes-ink:hand-ink -->\n', { ...famd.emptyFamdPayload(AT), ink, paperStyle: 'lines' }))
}

/** Trained letters straight into the handwriting database (valid label ids, strokes with pressureEnabled). */
const seedLetters = (page, chars, variants = 3) => page.evaluate(async ({ letters, variants }) => {
  const db = await new Promise((resolve, reject) => { const request = indexedDB.open('fanotes-handwriting'); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error) })
  const canvas = document.createElement('canvas')
  canvas.width = 64; canvas.height = 64
  const context = canvas.getContext('2d')
  context.fillStyle = '#fff'; context.fillRect(0, 0, 64, 64)
  context.strokeStyle = '#000'; context.lineWidth = 4; context.beginPath(); context.moveTo(10, 50); context.lineTo(32, 10); context.lineTo(54, 50); context.stroke()
  const imageData = canvas.toDataURL('image/png')
  const umlauts = { ä: 'german_lower_a_umlaut', ö: 'german_lower_o_umlaut', ü: 'german_lower_u_umlaut' }
  const transaction = db.transaction('samples', 'readwrite')
  const store = transaction.objectStore('samples')
  for (const char of letters) {
    const upper = char.toUpperCase() === char && char.toLowerCase() !== char
    for (let variant = 0; variant < variants; variant += 1) {
      const points = Array.from({ length: 14 }, (_, k) => ({ x: 0.1 + k * 0.006 + variant * 0.001, y: 0.2 - Math.sin((k / 13) * Math.PI * (1 + (char.charCodeAt(0) % 3) * 0.5)) * 0.07, t: k * 8, pressure: 0.5, tiltX: 0, tiltY: 0, pointerType: 'pen' }))
      store.put({
        id: `s-${char.charCodeAt(0)}-${variant}`, labelId: umlauts[char] ?? (upper ? `latin_upper_${char}` : `latin_lower_${char}`), label: char, labelName: char, latex: char,
        category: upper ? 'uppercase' : 'lowercase', writerId: 'w', sessionId: 'sess', createdAt: '2026-11-01T00:00:00.000Z', imageData, imageWidth: 64, imageHeight: 64,
        sourceCanvas: { width: 900, height: 1273, devicePixelRatio: 1 }, bbox: [0.1, 0.13, 0.18, 0.07],
        strokes: [{ id: `st${variant}`, color: '#000', baseWidth: 3, pressureEnabled: true, points }], strokeCount: 1, pointCount: 14, schemaVersion: 1,
      })
    }
  }
  await new Promise((resolve, reject) => { transaction.oncomplete = resolve; transaction.onerror = () => reject(transaction.error) })
  db.close()
}, { letters: chars, variants })

const session = async (theme, inkY, body) => {
  const profile = createProfile(`tth-flow-${theme}-`, { theme })
  seedNote(profile, inkY)
  const app = launch(profile)
  let browser = null
  try {
    const connected = await connect(app)
    browser = connected.browser
    const { page } = connected
    page.on('pageerror', (error) => console.log('pageerror', String(error).slice(0, 200)))
    await dismissNotices(page)
    const openNote = async () => {
      await page.locator('.file-tree__row', { hasText: 'Hand' }).first().click()
      await page.waitForFunction(() => [...document.querySelectorAll('.lw-drawing-board canvas')].some((canvas) => canvas.width > 0), null, { timeout: 60_000 })
      await sleep(1200)
      await page.locator('button[title^="Mit dem Stift schreiben"]').first().click().catch(() => {})
      await page.waitForSelector(OPEN, { timeout: 20_000 })
    }
    const disk = async () => {
      await page.keyboard.press('Control+s').catch(() => {})
      await sleep(1500)
      const ink = famd.parseFamd(fs.readFileSync(path.join(profile.vault, 'Hand.famd'), 'utf8')).payload.ink
      const strokes = ink.strokes
      const points = (list) => list.flatMap((stroke) => stroke.points)
      return {
        count: strokes.length,
        height: ink.sourceHeight,
        oldBottom: Math.max(...points(strokes.slice(0, 1)).map((point) => point.y)) * ink.sourceHeight,
        newTop: strokes.length > 1 ? Math.min(...points(strokes.slice(1)).map((point) => point.y)) * ink.sourceHeight : null,
        newBottom: strokes.length > 1 ? Math.max(...points(strokes.slice(1)).map((point) => point.y)) * ink.sourceHeight : null,
      }
    }
    await body({ page, profile, openNote, disk })
  } finally {
    await stop(app, browser)
    profile.dispose()
  }
}

const dialogState = (page) => page.evaluate(() => {
  const options = document.querySelector('[data-tth-preview-options]')
  const insert = document.querySelector('.lw-tth-insert')
  const canvas = document.querySelector('.tth-preview-canvas')
  return {
    glyphs: options ? JSON.parse(options.getAttribute('data-tth-preview-options')).glyphCount : -1,
    insertDisabled: insert ? insert.disabled : null,
    letters: document.querySelector('[data-tth-letters]')?.getAttribute('data-tth-letters') ?? null,
    fallback: [...document.querySelectorAll('[data-tth-fallback] kbd')].map((node) => node.textContent).join(''),
    skipped: [...document.querySelectorAll('[data-tth-skipped] kbd')].map((node) => node.textContent).join(''),
    hint: document.querySelector('.tth-dialog__hint')?.textContent ?? '',
    stats: document.querySelector('.tth-preview-head small')?.textContent ?? '',
    canvas: canvas ? [canvas.width, canvas.height] : null,
  }
})
const typeText = async (page, value) => { await page.locator(FIELD).fill(value) }
const settled = (page, check, what, timeout = 20_000) => until(async () => { const state = await dialogState(page); return check(state) ? state : null }, what, timeout, 120)

/** Background and text colours of the insert button, as `rgb()` strings. */
const insertColours = (page) => page.evaluate(() => {
  const style = getComputedStyle(document.querySelector('.lw-tth-insert'))
  const dialog = getComputedStyle(document.querySelector('.lw-tth-dialog'))
  return { color: style.color, background: style.backgroundColor, dialog: dialog.backgroundColor }
})
const luminance = (rgb) => {
  const [r, g, b] = (rgb.match(/[\d.]+/gu) ?? []).slice(0, 3).map((value) => { const channel = Number(value) / 255; return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4 })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
const contrast = (a, b) => { const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05) }

try {
  // ---- Dark: the whole flow -------------------------------------------------------------------------------------
  await session('dark', 0.2, async ({ page, openNote, disk }) => {
    await openNote()
    const before = await disk()
    ok('the note starts with one stroke', before.count === 1, JSON.stringify(before))

    // The first open right after a note loaded shares the main thread with the board's own start-up work; the
    // second one is the dialog itself.
    await page.locator(OPEN).first().click()
    await page.waitForSelector('.lw-tth-dialog')
    await page.keyboard.press('Escape')
    await page.waitForFunction(() => !document.querySelector('.lw-tth-dialog'), null, { timeout: 5000 })
    await sleep(1500)
    const warm = await page.evaluate(async () => {
      const button = document.querySelector('button[title^="Getippten Text"]')
      const longTasks = []
      const observer = new PerformanceObserver((list) => longTasks.push(...list.getEntries().map((entry) => entry.duration)))
      observer.observe({ entryTypes: ['longtask'] })
      const started = performance.now()
      button.click()
      const shown = await new Promise((resolve) => { const tick = () => (document.querySelector('.lw-tth-dialog') ? resolve(performance.now() - started) : requestAnimationFrame(tick)); tick() })
      await new Promise((resolve) => setTimeout(resolve, 1500))
      observer.disconnect()
      return { shown: Math.round(shown), longest: Math.round(Math.max(0, ...longTasks)), total: Math.round(longTasks.reduce((sum, value) => sum + value, 0)) }
    })
    ok('the dialog opens quickly (warm) without long main-thread tasks', warm.shown < 600 && warm.longest < 700, JSON.stringify(warm))
    ok('the dialog sits under the page body, in the app shell (not inside the paper)', await page.evaluate(() => document.querySelector('.lw-tth-backdrop')?.parentElement === document.body && /confirm-dialog/u.test(document.querySelector('.lw-tth-dialog').className)))
    ok('keyboard focus is in the text field', await page.evaluate(() => document.activeElement?.matches('[data-tth-control="text"]')))
    const dark = await insertColours(page)
    ok('dark: the dialog is dark, not the paper palette', luminance(dark.dialog) < 0.1, dark.dialog)
    ok('dark: the insert button text is readable (contrast >= 3 even disabled)', contrast(dark.color, dark.background) >= 3, `${dark.color} on ${dark.background}`)
    ok('no English text in the German dialog', !/Local learning|Learn automatically|Preparing preview|school script\./u.test(await page.locator('.lw-tth-dialog').innerText()))

    // No trained letters: empty state with a way to train, and the preview still works.
    await typeText(page, '')
    let state = await dialogState(page)
    ok('empty text: insert is disabled and the hint says what to do', state.insertDisabled === true && /Text/u.test(state.hint), state.hint)
    await page.waitForFunction(() => document.querySelector('[data-tth-letters]')?.getAttribute('data-tth-letters') !== 'loading', null, { timeout: 15_000 })
    state = await dialogState(page)
    ok('no letters trained: an empty state with a train button', state.letters === 'none' && await page.locator('.tth-letters button', { hasText: 'Buchstaben trainieren' }).count() === 1)
    await page.screenshot({ path: path.join(shots, 'dark-empty.png') })
    await typeText(page, '   \n  ')
    await sleep(600)
    state = await dialogState(page)
    ok('whitespace only: nothing to insert, zero lines', state.insertDisabled === true && /0 Zeilen/u.test(state.stats), state.stats)
    await typeText(page, 'Hallo Welt')
    state = await settled(page, (value) => value.glyphs > 0 && value.insertDisabled === false, 'preview without letters')
    ok('school script previews and inserts without trained letters', state.glyphs === 9, JSON.stringify(state))
    await page.screenshot({ path: path.join(shots, 'dark-typed.png') })

    // A character nobody can write must not block the rest.
    await typeText(page, 'Preis 5 € heute')
    state = await settled(page, (value) => value.glyphs > 0 && /€/u.test(value.skipped), 'euro sign')
    ok('a euro sign is named, the rest can still be inserted', state.skipped.includes('€') && state.insertDisabled === false, JSON.stringify(state))
    await typeText(page, '€')
    state = await settled(page, (value) => value.skipped === '€' && !/wird erstellt/u.test(value.hint), 'only a euro sign')
    ok('only unwritable characters: insert stays disabled and says why', state.insertDisabled === true && state.hint !== '', state.hint)

    // A very long text keeps the preview canvas small.
    await page.locator(FIELD).fill('Lorem ipsum dolor sit amet. '.repeat(280))
    state = await settled(page, (value) => value.glyphs > 1000, 'long text', 40_000)
    ok('a very long text keeps the preview canvas small', state.canvas && state.canvas[1] <= state.canvas[0] * 1.55, JSON.stringify(state.canvas))
    ok('the long text can be inserted', state.insertDisabled === false)

    // Escape: closes, focus back to the toolbar button, the draft stays.
    await typeText(page, 'Hallo welt')
    await sleep(500)
    await page.keyboard.press('Escape')
    await page.waitForFunction(() => !document.querySelector('.lw-tth-dialog'), null, { timeout: 5000 })
    ok('Escape closes the dialog', true)
    ok('focus returns to the toolbar button', await page.evaluate(() => document.activeElement?.matches('button[title^="Getippten Text"]')))
    ok('Escape closes only the dialog: the handwriting page and its tools stay', await page.locator(OPEN).count() === 1)
    await page.locator(OPEN).first().click()
    await page.waitForSelector('.lw-tth-dialog')
    ok('the draft survives Cancel/Escape', (await page.locator(FIELD).inputValue()) === 'Hallo welt')

    // Letters typed in the field never reach the board's shortcuts.
    await page.locator(FIELD).fill('')
    await page.keyboard.type('pe e')
    ok('typing letters does not switch tools or close the dialog', (await page.locator(FIELD).inputValue()) === 'pe e' && await page.locator('.lw-tth-dialog').count() === 1)

    // Insert with Ctrl+Enter.
    await typeText(page, 'Hallo welt')
    await settled(page, (value) => value.glyphs > 0 && value.insertDisabled === false, 'insertable')
    await page.keyboard.press('Control+Enter')
    await page.waitForFunction(() => !document.querySelector('.lw-tth-dialog'), null, { timeout: 5000 })
    const inserted = await disk()
    ok('Ctrl+Enter inserts the strokes', inserted.count > before.count + 5, JSON.stringify(inserted))
    ok('the text lands below the existing ink', inserted.newTop > inserted.oldBottom, `${inserted.newTop} > ${inserted.oldBottom}`)
    ok('focus is back on the toolbar button after inserting', await page.evaluate(() => document.activeElement?.matches('button[title^="Getippten Text"]')))
    await page.screenshot({ path: path.join(shots, 'dark-inserted.png') })
    await page.keyboard.press('Control+z')
    const undone = await until(async () => { const value = await disk(); return value.count === before.count ? value : null }, 'one undo removes the whole text', 8000, 500).catch(() => null)
    ok('one undo removes the whole inserted text', Boolean(undone), JSON.stringify(await disk()))
    await page.locator(OPEN).first().click()
    await page.waitForSelector('.lw-tth-dialog')
    ok('after an insert the dialog starts empty again', (await page.locator(FIELD).inputValue()) === '')
    await page.keyboard.press('Escape')
    await page.waitForFunction(() => !document.querySelector('.lw-tth-dialog'), null, { timeout: 5000 })

    // Few trained letters.
    await seedLetters(page, 'halo W'.replace(' ', '').split(''))
    await page.reload()
    await page.waitForSelector('.file-tree__row', { timeout: 60_000 })
    await openNote()
    await page.locator(OPEN).first().click()
    await page.waitForSelector('.lw-tth-dialog')
    await typeText(page, 'Hallo Straße')
    state = await settled(page, (value) => value.letters === 'trained' && value.glyphs > 0 && value.fallback !== '', 'few letters', 30_000)
    ok('few trained letters: the characters that fall back to school script are named', state.fallback.includes('ß') && state.fallback.includes('S') && !state.fallback.includes('a'), state.fallback)
    await page.screenshot({ path: path.join(shots, 'dark-few-letters.png') })

    // A small window.
    await page.setViewportSize({ width: 760, height: 560 })
    await sleep(500)
    const small = await page.evaluate(() => {
      const dialog = document.querySelector('.lw-tth-dialog').getBoundingClientRect()
      const insert = document.querySelector('.lw-tth-insert').getBoundingClientRect()
      return { top: dialog.top, bottom: dialog.bottom, right: dialog.right, insertBottom: insert.bottom, insertVisible: insert.width > 0, height: innerHeight, width: innerWidth }
    })
    ok('a small window: the dialog and its insert button stay inside', small.top >= 0 && small.bottom <= small.height && small.right <= small.width && small.insertBottom <= small.height && small.insertVisible, JSON.stringify(small))
    await page.screenshot({ path: path.join(shots, 'dark-small.png') })
    await page.setViewportSize({ width: 1440, height: 1000 })
  })

  // ---- Ink at the very bottom of the sheet ----------------------------------------------------------------------
  await session('dark', 0.97, async ({ page, openNote, disk }) => {
    await openNote()
    const before = await disk()
    await page.locator(OPEN).first().click()
    await page.waitForSelector('.lw-tth-dialog')
    await typeText(page, 'Ganz unten')
    await settled(page, (value) => value.glyphs > 0 && value.insertDisabled === false, 'bottom insert')
    await page.locator('.lw-tth-insert').click()
    await page.waitForFunction(() => !document.querySelector('.lw-tth-dialog'), null, { timeout: 5000 })
    const after = await disk()
    ok('ink at the bottom of the sheet: the text still lands below it', after.count > before.count && after.newTop > after.oldBottom - 1, JSON.stringify(after))
    ok('the sheet grew to hold it', after.newBottom <= after.height + 1, `${after.newBottom} <= ${after.height}`)
  })

  // ---- The first open right after a note loads, with a big set of trained letters ---------------------------------------
  // Reading and checking 1,500 samples used to take seconds after the click, with the dialog open and claiming that no
  // letters were trained. They are read in idle time once the page is open; whoever clicks sooner sees a loading note.
  await session('dark', 0.2, async ({ page, profile }) => {
    const letters = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZäöüÄÖÜ0123456789.,'.split('')
    await seedLetters(page, letters, 20)
    await page.reload()
    await page.waitForSelector('.file-tree__row', { timeout: 60_000 })
    await dismissNotices(page)
    const openedAt = Date.now()
    await page.locator('.file-tree__row', { hasText: 'Hand' }).first().click()
    await page.waitForFunction(() => [...document.querySelectorAll('.lw-drawing-board canvas')].some((canvas) => canvas.width > 0), null, { timeout: 60_000 })
    const noteMs = Date.now() - openedAt
    await sleep(1200)
    await page.locator('button[title^="Mit dem Stift schreiben"]').first().click().catch(() => {})
    await page.waitForSelector(OPEN, { timeout: 20_000 })
    // At once: no waiting for the prewarm.
    const early = Date.now()
    await page.locator(OPEN).first().click()
    await page.waitForSelector('.lw-tth-dialog')
    const shownMs = Date.now() - early
    const first = await dialogState(page)
    ok('the first open is immediate even before the letters are read', shownMs < 1500, `${shownMs} ms`)
    ok('while the letters load the dialog says so and does not claim there are none', first.letters === 'loading' || first.letters === 'trained', first.letters)
    await typeText(page, 'Hallo Welt')
    await settled(page, (value) => value.letters === 'trained' && value.glyphs > 0 && value.insertDisabled === false, 'big set preview', 40_000)
    ok('the preview comes in the trained letters once they are loaded', true, `${Date.now() - early} ms after the click`)
    await page.keyboard.press('Escape')
    await page.waitForFunction(() => !document.querySelector('.lw-tth-dialog'), null, { timeout: 5000 })
    // Opened later: the letters were read in idle time, the dialog has them at once.
    await page.reload()
    await page.waitForSelector('.file-tree__row', { timeout: 60_000 })
    await dismissNotices(page)
    await page.locator('.file-tree__row', { hasText: 'Hand' }).first().click()
    await page.waitForFunction(() => [...document.querySelectorAll('.lw-drawing-board canvas')].some((canvas) => canvas.width > 0), null, { timeout: 60_000 })
    await sleep(1200)
    await page.locator('button[title^="Mit dem Stift schreiben"]').first().click().catch(() => {})
    await page.waitForSelector(OPEN, { timeout: 20_000 })
    await page.evaluate(() => { window.__long = []; new PerformanceObserver((list) => { for (const entry of list.getEntries()) window.__long.push(Math.round(entry.duration)) }).observe({ entryTypes: ['longtask'] }) })
    await sleep(Number(process.env.FANOTES_TTH_PREWARM_WAIT_MS || 14_000))
    // Tasks of the idle phase only: the click (dialog, worker, first preview) is measured separately.
    const idleLong = await page.evaluate(() => [...window.__long])
    const warm = Date.now()
    await page.locator(OPEN).first().click()
    await page.waitForSelector('.lw-tth-dialog')
    const warmState = await settled(page, (value) => value.letters === 'trained', 'prewarmed letters', 10_000).catch(() => null)
    const warmMs = Date.now() - warm
    ok('after the page was open a while the dialog has the letters at once (prewarmed in idle time)', warmState !== null && warmMs < 800, `${warmMs} ms`)
    const long = await page.evaluate(() => window.__long)
    console.log(`tth open: note ${noteMs} ms, dialog shown ${shownMs} ms, prewarmed letters ${warmMs} ms, long tasks idle ${JSON.stringify(idleLong)}, with the open ${JSON.stringify(long)}`)
    ok('opening the note stays fast with a big set of trained letters', noteMs < 4000, `${noteMs} ms`)
    ok('reading the trained letters in idle time causes no main-thread task over 50 ms', Math.max(0, ...idleLong) <= 50, JSON.stringify(idleLong))
  })

  // ---- A zoomed and scrolled page ---------------------------------------------------------------------------------
  // The text is written in sheet units: it has the same size at every zoom, and after the insert it is on screen,
  // wherever the view was scrolled to.
  const zoomedInsert = {}
  for (const zoom of [1, 2.5]) {
    await session('dark', 0.6, async ({ page, openNote, disk }) => {
      await openNote()
      const pane = await page.evaluate(() => { const box = document.querySelector('.paper-view').getBoundingClientRect(); return { x: box.left + box.width / 2, y: box.top + box.height / 2 } })
      await page.mouse.move(pane.x, pane.y)
      const cdp = await page.context().newCDPSession(page)
      const zoomNow = () => page.evaluate(() => { const paper = document.querySelector('.paper-view .unified-paper'); return paper.getBoundingClientRect().width / paper.offsetWidth })
      if (zoom !== 1) {
        const steps = 14
        const delta = (-100 * Math.log(zoom / await zoomNow())) / steps
        for (let step = 0; step < steps; step += 1) { await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: pane.x, y: pane.y, deltaX: 0, deltaY: delta + 0.013, modifiers: 2 }); await sleep(16) }
        await sleep(1200)
      }
      // Scrolled to the top of the sheet: the end of the ink (60 % down) is off screen at a high zoom.
      await page.evaluate(() => { const view = document.querySelector('.unified-note-view'); view.scrollTop = 0; view.dispatchEvent(new Event('scroll')) })
      await sleep(500)
      const zoomed = await zoomNow()
      await page.locator(OPEN).first().click()
      await page.waitForSelector('.lw-tth-dialog')
      await typeText(page, 'Hallo Welt, das ist ein Test')
      await settled(page, (value) => value.glyphs > 0 && value.insertDisabled === false, 'zoomed insert')
      await page.locator('.lw-tth-insert').click()
      await page.waitForFunction(() => !document.querySelector('.lw-tth-dialog'), null, { timeout: 5000 })
      await sleep(1500)
      const after = await disk()
      const view = await page.evaluate(({ sourceHeight, newTop, newBottom }) => {
        const paper = document.querySelector('.paper-view .unified-paper').getBoundingClientRect()
        const scroller = document.querySelector('.unified-note-view').getBoundingClientRect()
        const top = paper.top + (newTop / sourceHeight) * paper.height
        const bottom = paper.top + (newBottom / sourceHeight) * paper.height
        return { top, bottom, viewTop: scroller.top, viewBottom: scroller.bottom, zoom: paper.width / document.querySelector('.paper-view .unified-paper').offsetWidth }
      }, { sourceHeight: after.height, newTop: after.newTop, newBottom: after.newBottom })
      zoomedInsert[zoom] = after.newBottom - after.newTop
      const label = `zoom ${Math.round(zoomed * 100)} %`
      ok(`${label}, scrolled to the top: the inserted text is on screen`, view.top >= view.viewTop - 2 && view.bottom <= view.viewBottom + 2, JSON.stringify(view))
    })
  }
  ok('the inserted text has the same size at 100 % and at 250 % (sheet units)', zoomedInsert[1] > 0 && Math.abs(zoomedInsert[2.5] / zoomedInsert[1] - 1) < 0.05, JSON.stringify(zoomedInsert))

  // ---- Light: tokens and contrast -------------------------------------------------------------------------------
  await session('light', 0.2, async ({ page, openNote }) => {
    await openNote()
    await page.locator(OPEN).first().click()
    await page.waitForSelector('.lw-tth-dialog')
    await typeText(page, 'Hallo Welt')
    await settled(page, (value) => value.glyphs > 0 && value.insertDisabled === false, 'light preview')
    const light = await insertColours(page)
    ok('light: the dialog is light', luminance(light.dialog) > 0.5, light.dialog)
    ok('light: the insert button text is readable', contrast(light.color, light.background) >= 4.5, `${light.color} on ${light.background}`)
    await page.screenshot({ path: path.join(shots, 'light-typed.png') })
  })
} catch (error) {
  ok(`flow completed (${String(error?.message ?? error).slice(0, 240)})`, false)
}

console.log(`text to handwriting flow: ${count() - failed()}/${count()} passed; screenshots in ${shots}`)
process.exit(failed() === 0 ? 0 : 1)
