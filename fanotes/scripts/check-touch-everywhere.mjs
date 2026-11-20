// Check: finger touch works everywhere in the desktop app (Electron on Windows
// and Linux, laptops with a touch screen).
// Part 1 (static): Electron does not switch touch off, and the touch layer is wired in.
// Part 2 (real Chromium, real touch input through CDP Input.dispatchTouchEvent,
// skipped with FANOTES_SKIP_BROWSER=1 or when no browser exists): taps, long
// presses, drags and finger text selection on the main surfaces. The pen must
// still draw and a resting palm must still be rejected.
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createServer as createNetServer } from 'node:net'
import { createServer } from 'vite'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (file) => readFileSync(join(root, file), 'utf8')

// ---- Part 1: static ---------------------------------------------------------
const preflight = read('electron/startup-preflight.cjs')
const main = read('electron/main.cjs')
for (const text of [preflight, main]) {
  assert.ok(!/appendSwitch\(\s*['"]touch-events['"]\s*,\s*['"]disabled['"]/u.test(text), 'touch events must not be disabled')
  assert.ok(!/appendSwitch\(\s*['"]disable-touch/u.test(text), 'no disable-touch* switch')
  assert.ok(!/(?:disable|enable)-features[^\n]*(?:Touch|Pointer)/u.test(text.replace(/\/\/.*$/gmu, '')), 'no touch/pointer feature may be switched off')
}
assert.ok(/commandLine\.appendSwitch\('ozone-platform', 'x11'\)/u.test(preflight), 'Linux uses X11/XWayland, where XInput2 delivers touch')
const mainWindow = main.slice(main.indexOf('mainWindow = new BrowserWindow('), main.indexOf('mainWindow = new BrowserWindow(') + 1500)
assert.ok(!/transparent:\s*true/u.test(mainWindow), 'a transparent window would not receive touch on Windows')
assert.ok(!/-webkit-app-region/u.test(read('src/styles.css')), 'drag regions swallow touch')
const entry = read('src/main.tsx')
assert.ok(entry.includes("import './touch.css'") && entry.includes('installTouchInput()'), 'main.tsx installs the touch layer')
assert.ok(read('src/components/MarkdownEditor.tsx').includes('touchSelection,'), 'the editor has finger selection')

// ---- Part 2: browser --------------------------------------------------------
const chromium = process.env.FANOTES_CHROMIUM ?? '/usr/bin/chromium'
const playwrightEntry = process.env.PLAYWRIGHT_CORE ?? '/srv/agents/fanotes/.site-redesign-tools/node_modules/playwright-core/index.mjs'
if (process.env.FANOTES_SKIP_BROWSER === '1' || !existsSync(chromium) || !existsSync(playwrightEntry)) {
  console.log('static touch checks passed; browser part skipped (no chromium / playwright-core)')
  process.exit(0)
}
const { chromium: browserType } = await import(pathToFileURL(playwrightEntry).href)

const freePort = await new Promise((resolve) => {
  const probe = createNetServer().listen(0, '127.0.0.1', () => { const { port } = probe.address(); probe.close(() => resolve(port)) })
})
const server = await createServer({
  root,
  appType: 'spa',
  logLevel: 'error',
  server: { host: '127.0.0.1', port: freePort, strictPort: true, fs: { strict: false } },
})
await server.listen()
const url = `http://127.0.0.1:${server.httpServer.address().port}/`

const browser = await browserType.launch({ executablePath: chromium, args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'] })
let failed = null
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, hasTouch: true, serviceWorkers: 'block' })
  const page = await context.newPage()
  page.setDefaultTimeout(20_000)
  const cdp = await context.newCDPSession(page)
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 })
  const pageErrors = []
  page.on('pageerror', (error) => pageErrors.push(error.message))

  const touch = (type, x, y) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y, id: 1 }] })
  const T = {
    async tap(x, y, hold = 40) { await touch('touchStart', x, y); await page.waitForTimeout(hold); await touch('touchEnd') },
    async press(x, y, ms = 750) { await T.tap(x, y, ms) },
    async drag(x1, y1, x2, y2, { hold = 0, steps = 12 } = {}) {
      await touch('touchStart', x1, y1)
      if (hold) await page.waitForTimeout(hold)
      for (let i = 1; i <= steps; i += 1) { await touch('touchMove', x1 + ((x2 - x1) * i) / steps, y1 + ((y2 - y1) * i) / steps); await page.waitForTimeout(16) }
      await touch('touchEnd')
    },
    async center(selector) {
      const locator = page.locator(selector).first()
      await locator.scrollIntoViewIfNeeded()
      const box = await locator.boundingBox()
      assert.ok(box, `${selector} is visible`)
      return { ...box, x: box.x + box.width / 2, y: box.y + box.height / 2 }
    },
    async tapOn(selector, hold) { const c = await T.center(selector); await T.tap(c.x, c.y, hold) },
  }
  const settle = (ms = 350) => page.waitForTimeout(ms)
  const inkPixels = () => page.evaluate(() => {
    let count = 0
    for (const canvas of document.querySelectorAll('canvas.lw-tablet-canvas')) {
      const data = canvas.getContext('2d')?.getImageData(0, 0, canvas.width, canvas.height).data
      if (data) for (let i = 3; i < data.length; i += 4) if (data[i]) count += 1
    }
    return count
  })
  const treeNames = () => page.locator('.file-tree__entry-button').allInnerTexts()
  const tabNames = () => page.locator('.note-tab-main').allInnerTexts()
  const hitSize = (selector) => page.evaluate((target) => {
    const element = document.querySelector(target)
    const box = element.getBoundingClientRect()
    const cx = box.left + box.width / 2
    const cy = box.top + box.height / 2
    const hits = (x, y) => { const found = document.elementFromPoint(x, y); return Boolean(found && (found === element || element.contains(found))) }
    let w = 0
    let h = 0
    for (let d = 0; d < 60 && hits(cx + d, cy); d += 1) w += 1
    for (let d = 1; d < 60 && hits(cx - d, cy); d += 1) w += 1
    for (let d = 0; d < 60 && hits(cx, cy + d); d += 1) h += 1
    for (let d = 1; d < 60 && hits(cx, cy - d); d += 1) h += 1
    return { w, h }
  }, selector)

  await page.goto(url, { waitUntil: 'domcontentloaded' })
  await page.locator('.first-run-continue, .file-tree__entry-button').first().waitFor({ timeout: 120_000 })
  assert.equal(await page.evaluate(() => matchMedia('(any-pointer: coarse)').matches), true, 'the touch screen is a coarse pointer')
  if (await page.locator('.first-run-continue').count()) await T.tapOn('.first-run-continue')
  await page.locator('.file-tree__entry-button').first().waitFor({ timeout: 60_000 })

  // Navigation: tap expands folders, tap opens a note once (no touch + emulated mouse double fire).
  const expand = async (folder, child) => {
    if (await page.locator(`.file-tree__entry-button:has-text("${child}")`).count()) return
    await T.tapOn(`.file-tree__entry-button:has-text("${folder}")`); await settle()
    assert.ok(await page.locator(`.file-tree__entry-button:has-text("${child}")`).count(), `a tap expands ${folder}`)
  }
  await T.tapOn('.file-tree__entry-button:has-text("Welcome")'); await settle(700)
  assert.deepEqual((await tabNames()).filter((name) => name === 'Welcome'), ['Welcome'], 'one tap opens the note once')
  await expand('Mathematics', 'Analysis'); await T.tapOn('.file-tree__entry-button:has-text("Analysis")'); await settle(500)
  await expand('German', 'Literature'); await T.tapOn('.file-tree__entry-button:has-text("Literature")'); await settle(500)
  assert.deepEqual((await tabNames()).sort(), ['Analysis', 'Literature', 'Welcome'])

  // Hit areas: the small controls are at least 32 px in the touch layout.
  for (const selector of ['.tab-close', '.tabs-menu', '.mode-switch button', '.icon-button', '.formatting-toolbar button']) {
    const pseudo = await page.evaluate((target) => {
      const element = document.querySelector(target)
      const after = getComputedStyle(element, '::after')
      return { content: after.content, position: after.position, w: element.offsetWidth, h: element.offsetHeight, aw: after.width, ah: after.height }
    }, selector)
    assert.ok(pseudo.content !== 'none' && pseudo.position === 'absolute', `${selector} has an invisible hit area`)
    assert.ok(Number.parseFloat(pseudo.aw) >= 40 && Number.parseFloat(pseudo.ah) >= 40, `${selector} hit area is ${pseudo.aw} x ${pseudo.ah}`)
  }

  // The hit areas must not disturb existing ::before/::after visuals (tab underline, summary chevrons, tooltips).
  const pseudoState = (withTouchClasses) => page.evaluate((on) => {
    const html = document.documentElement
    html.classList.toggle('has-touch-screen', on)
    html.classList.toggle('is-touch-input', false)
    const out = {}
    let index = 0
    for (const element of document.querySelectorAll('body *')) {
      element.__touchIndex ??= ++index
      for (const pseudo of ['::before', '::after']) {
        const style = getComputedStyle(element, pseudo)
        if (style.content === 'none') continue
        out[`${element.__touchIndex}${pseudo}`] = ['content', 'position', 'top', 'right', 'bottom', 'left', 'width', 'height', 'transform'].map((key) => style[key]).join('|')
      }
    }
    return out
  }, withTouchClasses)
  const pseudoOff = await pseudoState(false)
  const pseudoOn = await pseudoState(true)
  let preserved = 0
  for (const [key, value] of Object.entries(pseudoOff)) {
    preserved += 1
    assert.equal(pseudoOn[key], value, `existing pseudo-element ${key} must not change with has-touch-screen`)
  }
  assert.ok(preserved > 3, `found ${preserved} existing pseudo-elements to compare`)

  // Long press on a tree row opens its menu and does not open or toggle it.
  const tabsBefore = await tabNames()
  let row = await T.center('.file-tree__entry-button:has-text("Literature")')
  await T.press(row.x, row.y); await settle()
  assert.ok(await page.locator('.file-tree__context-menu').isVisible(), 'long press on a note opens its menu')
  assert.deepEqual(await tabNames(), tabsBefore, 'the release after a long press must not open the note')
  await page.keyboard.press('Escape'); await T.tap(900, 400); await settle()

  // Long press on a tab opens the tab menu.
  const tabBox = await T.center('.note-tab >> nth=0')
  await T.press(tabBox.x, tabBox.y); await settle()
  assert.ok(await page.locator('.tab-context-menu').isVisible(), 'long press on a tab opens the tab menu')
  await page.keyboard.press('Escape'); await T.tap(900, 400); await settle()

  // Drag: reorder tabs by holding a tab and moving it; move a note into a folder.
  const tabsNow = await tabNames()
  const first = await T.center('.note-tab >> nth=0')
  const last = await T.center('.note-tab >> nth=2')
  await T.drag(last.x, last.y, first.x - 80, first.y, { hold: 320 }); await settle(500)
  assert.equal((await tabNames())[0], tabsNow[2], 'a finger can drag a tab to the front')
  const source = await T.center('.file-tree__entry-button:has-text("Literature")')
  const target = await T.center('.file-tree__entry-button:has-text("Physics")')
  await T.drag(source.x, source.y, target.x, target.y, { hold: 320, steps: 15 }); await settle(800)
  if (!(await page.locator('.file-tree__entry-button[title^="Physics/Literature"]').count())) await T.tapOn('.file-tree__entry-button:has-text("Physics")')
  await settle()
  assert.ok(await page.locator('.file-tree__entry-button[title^="Physics/Literature"]').count(), 'a finger can drag a note into a folder')
  // A quick swipe over the list still scrolls instead of dragging.
  const before = await treeNames()
  await T.drag(source.x, source.y + 60, source.x, source.y, { steps: 8 }); await settle()
  assert.deepEqual(await treeNames(), before, 'a quick swipe does not move anything')

  // Markdown editor: tap places the caret; long press selects a word with handles and a menu.
  await T.tapOn('.file-tree__entry-button:has-text("Welcome")'); await settle(700)
  const line = await page.evaluate(() => {
    const el = [...document.querySelectorAll('.cm-line')].find((l) => l.getBoundingClientRect().top > 160 && l.innerText.length > 40)
    const r = el.getBoundingClientRect()
    return { x: r.left + 150, y: r.top + 10 }
  })
  await T.tap(line.x, line.y); await settle()
  assert.equal(await page.locator('.cm-touch-menu').isVisible(), false, 'a tap only places the caret')
  await T.press(line.x, line.y); await settle()
  const word = await page.evaluate(() => String(getSelection()))
  assert.ok(/^\S+$/u.test(word) && word.length > 1, `long press selects one word (got "${word}")`)
  assert.ok(await page.locator('.cm-touch-menu').isVisible(), 'the selection menu shows')
  assert.equal(await page.locator('.cm-touch-handle:visible').count(), 2, 'two selection handles show')
  const handle = await T.center('.cm-touch-handle--end')
  await T.drag(handle.x, handle.y, handle.x + 130, handle.y, { steps: 8 }); await settle()
  const grown = await page.evaluate(() => String(getSelection()))
  assert.ok(grown.length > word.length, 'dragging the end handle extends the selection')
  await T.tapOn('.cm-touch-menu button[data-action="all"]'); await settle()
  assert.ok((await page.evaluate(() => String(getSelection()).length)) > 200, 'Select all from the touch menu')
  await T.tap(line.x, line.y + 60); await settle()
  await touch('touchStart', line.x, line.y); await page.waitForTimeout(650)
  for (let i = 1; i <= 8; i += 1) { await touch('touchMove', line.x + i * 15, line.y); await page.waitForTimeout(16) }
  await touch('touchEnd'); await settle()
  assert.ok((await page.evaluate(() => String(getSelection()))).length > word.length, 'long press then drag extends the selection')

  // Ink: a finger draws (draw mode), the pen draws, a resting palm is rejected.
  await T.tap(line.x, line.y + 100); await T.tapOn('button[aria-label="Pen"]'); await settle(800)
  const canvas = await T.center('canvas.lw-tablet-canvas-live')
  const base = await inkPixels()
  await T.drag(canvas.x - 120, canvas.y - 150, canvas.x + 80, canvas.y - 120, { steps: 16 }); await settle(500)
  const afterFinger = await inkPixels()
  assert.ok(afterFinger > base + 500, 'a finger draws when finger drawing is on')
  const mouse = (type, x, y, buttons) => cdp.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons, pointerType: 'pen', pressure: 0.5, clickCount: 1 })
  await mouse('mousePressed', canvas.x - 200, canvas.y - 60, 1)
  for (let i = 1; i <= 10; i += 1) await mouse('mouseMoved', canvas.x - 200 + i * 12, canvas.y - 60 + i * 2, 1)
  await mouse('mouseReleased', canvas.x - 80, canvas.y - 40, 0); await settle(500)
  const afterPen = await inkPixels()
  assert.ok(afterPen > afterFinger + 300, 'the pen still draws')
  await mouse('mousePressed', canvas.x, canvas.y + 100, 1)
  await mouse('mouseMoved', canvas.x + 6, canvas.y + 100, 1)
  await settle(300)
  const beforePalm = await inkPixels()
  await T.drag(canvas.x + 100, canvas.y + 200, canvas.x + 250, canvas.y + 230, { steps: 10 })
  const withPalm = await inkPixels()
  await mouse('mouseReleased', canvas.x + 6, canvas.y + 100, 0)
  assert.ok(withPalm - beforePalm < 60, 'a palm while the pen is down is rejected')
  // Long press on the page opens no context menu and does not draw a dot menu.
  await T.press(canvas.x + 200, canvas.y + 300, 700); await settle()
  assert.equal(await page.locator('.file-tree__context-menu').count(), 0, 'no menu from a long press on the page')

  // Ink selection: finger lasso, move, and scale handle.
  await T.tapOn('button[title^="Frame handwriting"]'); await settle()
  await T.drag(canvas.x - 260, canvas.y - 220, canvas.x + 160, canvas.y - 20, { steps: 15 }); await settle(600)
  const rect = () => page.locator('.lw-selection-rect').first().boundingBox()
  const r0 = await rect()
  assert.ok(r0 && r0.width > 20, 'a finger can frame ink')
  await T.drag(r0.x + r0.width / 2, r0.y + r0.height / 2, r0.x + r0.width / 2 + 60, r0.y + r0.height / 2 + 40, { steps: 10 }); await settle(500)
  const r1 = await rect()
  assert.ok(r1.x > r0.x + 30, 'a finger moves the selected ink')
  const grip = await T.center('.lw-selection-scale')
  const touchArea = await hitSize('.lw-selection-scale')
  assert.ok(touchArea.w >= 40, `the scale handle has a ${touchArea.w}px touch area`)
  await T.drag(grip.x + 8, grip.y + 8, grip.x + 70, grip.y + 50, { steps: 10 }); await settle(500)
  const r2 = await rect()
  assert.ok(r2.width > r1.width + 20, 'a finger resizes the selected ink')

  // Settings: open by tap, toggle and slider by finger (track and padding).
  await T.tap(300, 700); await T.tapOn('button[aria-label="Open Settings"]'); await settle(800)
  const toggle = page.locator('.settings-modal button.toggle').first()
  const wasOn = await toggle.evaluate((node) => node.classList.contains('is-on'))
  await T.tapOn('.settings-modal button.toggle'); await settle()
  assert.notEqual(await toggle.evaluate((node) => node.classList.contains('is-on')), wasOn, 'a tap flips a settings toggle')
  // Static text: a long press selects a word so it can be copied.
  const copy = await page.evaluate(() => {
    const walker = document.createTreeWalker(document.querySelector('.settings-modal'), NodeFilter.SHOW_TEXT)
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const owner = node.parentElement
      if (!owner || owner.closest('button, input, select, label, textarea') || node.textContent.trim().length < 30) continue
      const range = document.createRange()
      range.setStart(node, 2)
      range.setEnd(node, 6)
      const box = range.getBoundingClientRect()
      if (box.width > 0 && box.top > 120 && box.bottom < 700) return { x: box.left + box.width / 2, y: box.top + box.height / 2 }
    }
    return null
  })
  assert.ok(copy, 'settings has static text to select')
  await T.press(copy.x, copy.y); await settle()
  assert.ok((await page.evaluate(() => String(getSelection()).trim())).length > 1, 'a long press selects a word of static text')
  const section = await page.locator('.settings-modal button:has-text("Accessibility")').first().boundingBox()
  await T.tap(section.x + section.width / 2, section.y + section.height / 2); await settle(500)
  const slider = page.locator('.settings-modal input[type=range]').first()
  const sliderBox = await slider.boundingBox()
  const v0 = await slider.inputValue()
  await T.drag(sliderBox.x + 6, sliderBox.y + sliderBox.height / 2, sliderBox.x + sliderBox.width - 6, sliderBox.y + sliderBox.height / 2, { steps: 10 }); await settle()
  const v1 = await slider.inputValue()
  assert.notEqual(v1, v0, 'a finger drags a slider on its track')
  await T.drag(sliderBox.x + sliderBox.width / 2, sliderBox.y + sliderBox.height / 2 + 13, sliderBox.x + 5, sliderBox.y + sliderBox.height / 2 + 13, { steps: 10 }); await settle()
  assert.notEqual(await slider.inputValue(), v1, 'a finger drags a slider from the padding around it')
  await T.tapOn('.settings-modal button:has-text("Done")'); await settle()
  assert.equal(await page.locator('.settings-modal').count(), 0, 'Done closes settings with a tap')

  assert.deepEqual(pageErrors, [], `page errors: ${pageErrors.join(' | ')}`)
  console.log('touch checks passed')
} catch (error) {
  failed = error
} finally {
  await browser.close()
  await server.close()
}
if (failed) { console.error(failed); process.exit(1) }
