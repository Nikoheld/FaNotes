// Layout check for the vertical editor toolbar (Settings -> Werkzeugleiste = "Seite").
//
// Renders the real app (vite dev server, web build, synthetic vault) with the toolbar on the side and asserts,
// for typing mode and ink mode, on Markdown notes, PDF notes, worksheets, split view and focus mode:
//   1. every toolbar item can be scrolled fully into the bar and lies inside the viewport,
//   2. no two toolbar items overlap and no item's label is cut off,
//   3. every popover / panel that a toolbar item opens lies fully inside the viewport and beside the bar,
//   4. the bar does not cover the page and the page never scrolls sideways.
// Window sizes are window pixels divided by the display scale (zoom 1, 1.25, 1.5, 2), so 1080 px at 200 % is a
// 540 px high CSS viewport. Both UI languages and both colour schemes are covered.
//
// Usage: node scripts/check-side-toolbar.mjs
// Env:   FANOTES_SHOT_DIR       write a screenshot per state there
//        FANOTES_SIDE_REPORT=1  list every violation and exit 0 (audit mode)
//        FANOTES_SIDE_LANG=de|en  only one language
//        FANOTES_SIDE_QUICK=1   two sizes only (iterating on CSS)
//        FANOTES_SIDE_FULL=1    run the full size x scale matrix for every state (default: popovers on a subset)
//        FANOTES_PLAYWRIGHT / FANOTES_CHROMIUM  playwright-core entry and browser binary
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer as createNetServer } from 'node:net'
import { createServer } from 'vite'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const shotDir = process.env.FANOTES_SHOT_DIR
if (shotDir) mkdirSync(shotDir, { recursive: true })
const report = process.env.FANOTES_SIDE_REPORT === '1'
const full = process.env.FANOTES_SIDE_FULL === '1'

const require = createRequire(import.meta.url)
const playwrightEntry = process.env.FANOTES_PLAYWRIGHT
  ?? (existsSync('/srv/agents/fanotes/.site-redesign-tools/node_modules/playwright-core/index.mjs')
    ? '/srv/agents/fanotes/.site-redesign-tools/node_modules/playwright-core/index.mjs'
    : 'playwright-core')
let chromium
try {
  ;({ chromium } = playwrightEntry.startsWith('/') ? await import(playwrightEntry) : require(playwrightEntry))
} catch {
  if (process.env.CI) throw new Error('playwright-core is required in CI')
  console.log('side toolbar check skipped (playwright-core is not installed)')
  process.exit(0)
}
const browserBinary = process.env.FANOTES_CHROMIUM ?? (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined)

// ---- fixtures ---------------------------------------------------------------------------------
const buildPdf = (count) => {
  const objs = []
  objs[1] = '<< /Type /Catalog /Pages 2 0 R >>'
  objs[2] = `<< /Type /Pages /Kids [${Array.from({ length: count }, (_, i) => `${4 + i * 2} 0 R`).join(' ')}] /Count ${count} >>`
  objs[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
  for (let i = 0; i < count; i += 1) {
    const stream = `BT /F1 24 Tf 60 760 Td (Page ${i + 1}) Tj ET`
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
const tmp = mkdtempSync(join(tmpdir(), 'fanotes-side-toolbar-'))
const pdfPath = join(tmp, 'Sheet.pdf')
writeFileSync(pdfPath, buildPdf(3))
const pngPath = join(tmp, 'Sheet.png')
writeFileSync(pngPath, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAoAAAAKCAYAAACNMs+9AAAAFUlEQVR42mP8z8BQz0AEYBxVSF+FABJADveWkH6oAAAAAElFTkSuQmCC', 'base64'))

// ---- matrix -----------------------------------------------------------------------------------
const WINDOWS = [[1024, 600], [1280, 720], [1440, 900], [1920, 1080], [2560, 1080]]
const SCALES = [1, 1.25, 1.5, 2]
const css = (value, scale) => Math.round(value / scale)
const matrix = WINDOWS.flatMap(([w, h]) => SCALES.map((scale) => ({ w: css(w, scale), h: css(h, scale), label: `${w}x${h}@${scale}` })))
const allSizes = process.env.FANOTES_SIDE_QUICK === '1' ? matrix.filter((size) => ['1024x600@1', '1280x720@1.25'].includes(size.label)) : matrix
// Popover checks are slower: by default only the extremes plus the common laptop sizes.
const popoverSizes = full ? allSizes : allSizes.filter((size) => ['1024x600@1', '1280x720@1', '1280x720@1.25', '1440x900@1', '1920x1080@1', '1920x1080@2', '1024x600@1.5'].includes(size.label))
const LANGUAGES = [
  { locale: 'de-CH', scheme: 'light', theme: /^Hell/u, settings: /Einstellungen/, done: /^Fertig$/ },
  // The English run also pretends to have a touch screen: touch.css then adds 40 px invisible hit areas.
  { locale: 'en-US', scheme: 'dark', theme: /^Dark/u, settings: /Settings/, done: /^Done$/, touch: true },
]

const violations = []
const fail = (where, message) => { violations.push(`${where}: ${message}`) }

// ---- in-page measuring ------------------------------------------------------------------------
const measureBar = () => {
  const bar = document.querySelector('.editor-toolbar.is-vertical')
  if (!bar) return { missing: true }
  const itemSelector = 'button, input, select, textarea, a[href], [role="button"], output, .pdf-note-pager > span, .pdf-note-identity > small, .pdf-note-identity > strong'
  const visible = (element) => {
    const rect = element.getBoundingClientRect()
    if (rect.width < 1 || rect.height < 1) return false
    for (let node = element; node && node !== document.body; node = node.parentElement) {
      const style = getComputedStyle(node)
      if (style.display === 'none' || style.visibility === 'hidden') return false
    }
    return true
  }
  const items = [...bar.querySelectorAll(itemSelector)].filter(visible)
  const name = (element) => `${element.tagName.toLowerCase()}${element.className && typeof element.className === 'string' ? `.${element.className.trim().split(/\s+/u).slice(0, 2).join('.')}` : ''}[${(element.getAttribute('aria-label') || element.getAttribute('title') || element.textContent || '').trim().slice(0, 28)}]`
  const out = { problems: [], count: items.length }
  // Below the app minimum (body min-width 940 / min-height 620) the whole page scrolls by design, so
  // positions are compared in page coordinates against the larger of viewport and minimum.
  const vw = Math.max(document.documentElement.clientWidth, 940)
  const vh = Math.max(document.documentElement.clientHeight, 620)
  const sx = window.scrollX
  const sy = window.scrollY
  const barRect = bar.getBoundingClientRect()
  if (barRect.left + sx < -0.5 || barRect.top + sy < -0.5 || barRect.right + sx > vw + 0.5 || barRect.bottom + sy > vh + 0.5) out.problems.push(`bar outside the viewport (${[barRect.left + sx, barRect.top + sy, barRect.right + sx, barRect.bottom + sy].map(Math.round)} in ${vw}x${vh})`)
  // 2. overlap at scroll 0 (layout positions), nested pairs excluded
  const scrollers = [bar, ...bar.querySelectorAll('*')].filter((node) => /auto|scroll/u.test(getComputedStyle(node).overflowY) || /auto|scroll/u.test(getComputedStyle(node).overflowX))
  const saved = scrollers.map((node) => [node, node.scrollTop, node.scrollLeft])
  scrollers.forEach((node) => { node.scrollTop = 0; node.scrollLeft = 0 })
  const rects = items.map((item) => ({ item, rect: item.getBoundingClientRect() }))
  const sticky = (element) => getComputedStyle(element.closest('.mode-switch') ?? element).position === 'sticky'
  for (let a = 0; a < rects.length; a += 1) {
    for (let b = a + 1; b < rects.length; b += 1) {
      const first = rects[a]
      const second = rects[b]
      if (first.item.contains(second.item) || second.item.contains(first.item)) continue
      if (first.item.closest('label') && first.item.closest('label') === second.item.closest('label') && (first.item.tagName === 'OUTPUT' || second.item.tagName === 'OUTPUT') === false) continue
      const w = Math.min(first.rect.right, second.rect.right) - Math.max(first.rect.left, second.rect.left)
      const h = Math.min(first.rect.bottom, second.rect.bottom) - Math.max(first.rect.top, second.rect.top)
      if (w > 1.5 && h > 1.5 && !(sticky(first.item) && sticky(second.item))) out.problems.push(`overlap ${name(first.item)} x ${name(second.item)} (${Math.round(w)}x${Math.round(h)})`)
    }
  }
  saved.forEach(([node, top, left]) => { node.scrollTop = top; node.scrollLeft = left })
  // 1. reachability: scroll each item into view and require it inside every clipping ancestor and the viewport
  for (const item of items) {
    item.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    const rect = item.getBoundingClientRect()
    const tolerance = 0.6
    if (rect.left + window.scrollX < -tolerance || rect.top + window.scrollY < -tolerance || rect.right + window.scrollX > vw + tolerance || rect.bottom + window.scrollY > vh + tolerance) out.problems.push(`outside viewport ${name(item)} (${[rect.left, rect.top, rect.right, rect.bottom].map(Math.round)} in ${vw}x${vh})`)
    for (let node = item.parentElement; node; node = node.parentElement) {
      const style = getComputedStyle(node)
      const clips = style.overflowX !== 'visible' || style.overflowY !== 'visible'
      if (clips) {
        const clip = node.getBoundingClientRect()
        const border = parseFloat(style.borderLeftWidth) || 0
        if (rect.left < clip.left + border - tolerance || rect.right > clip.right - border + tolerance || rect.top < clip.top - tolerance || rect.bottom > clip.bottom + tolerance) {
          out.problems.push(`clipped by ${name(node)}: ${name(item)} (${[rect.left, rect.top, rect.right, rect.bottom].map(Math.round)} vs ${[clip.left, clip.top, clip.right, clip.bottom].map(Math.round)})`)
          break
        }
      }
      if (node === bar) break
    }
    if (item.tagName === 'BUTTON' && getComputedStyle(item).fontSize !== '0px' && item.innerText.trim()) {
      const range = document.createRange()
      range.selectNodeContents(item)
      const text = range.getBoundingClientRect()
      if (text.width > rect.width + 1 || text.height > rect.height + 1) out.problems.push(`label cut off ${name(item)} (${Math.round(text.width)}x${Math.round(text.height)} in ${Math.round(rect.width)}x${Math.round(rect.height)})`)
    }
  }
  bar.scrollTop = 0
  // 4. the bar must not cover the page, nothing scrolls sideways
  const stage = document.querySelector('.workspace > .editor-stage')
  if (stage && stage.getBoundingClientRect().left < barRect.right - 1) out.problems.push('the bar covers the editor stage')
  const doc = document.documentElement
  if (doc.clientWidth >= 940 && doc.scrollWidth > doc.clientWidth + 1) out.problems.push(`page scrolls sideways (${doc.scrollWidth} > ${doc.clientWidth})`)
  return out
}

const measurePopover = (selector) => {
  const bar = document.querySelector('.editor-toolbar.is-vertical')
  const barRect = bar?.getBoundingClientRect()
  const vw = document.documentElement.clientWidth
  const vh = document.documentElement.clientHeight
  const nodes = [...document.querySelectorAll(selector)].filter((node) => {
    const rect = node.getBoundingClientRect()
    return rect.width > 4 && rect.height > 4 && getComputedStyle(node).visibility !== 'hidden'
  })
  if (!nodes.length) return { found: false, problems: [] }
  const problems = []
  for (const node of nodes) {
    const rect = node.getBoundingClientRect()
    const label = `${node.tagName.toLowerCase()}.${String(node.className).trim().split(/\s+/u)[0]}`
    if (rect.left < -0.5 || rect.top < -0.5 || rect.right > vw + 0.5 || rect.bottom > vh + 0.5) problems.push(`${label} outside the viewport (${[rect.left, rect.top, rect.right, rect.bottom].map(Math.round)} in ${vw}x${vh})`)
    if (barRect && rect.left < barRect.right - 1 && rect.right > barRect.left + 1 && rect.top < barRect.bottom && rect.bottom > barRect.top) problems.push(`${label} covers the bar (${[rect.left, rect.right].map(Math.round)} vs bar ${[barRect.left, barRect.right].map(Math.round)})`)
    // reachable content: anything scrollable has to actually scroll
    const style = getComputedStyle(node)
    if (node.scrollHeight > node.clientHeight + 1 && !/auto|scroll/u.test(style.overflowY)) problems.push(`${label} content is cut off (${node.scrollHeight} > ${node.clientHeight})`)
    const first = document.elementFromPoint(Math.min(vw - 1, Math.max(0, rect.left + 6)), Math.min(vh - 1, Math.max(0, rect.top + 6)))
    if (first && !node.contains(first) && !first.contains(node)) problems.push(`${label} is behind ${first.tagName.toLowerCase()}.${String(first.className).trim().split(/\s+/u)[0]}`)
  }
  return { found: true, problems }
}

// ---- driver -----------------------------------------------------------------------------------
// vite treats port 0 as "use the configured default", so ask the OS for a free port first.
const freePort = () => new Promise((resolve, reject) => {
  const probe = createNetServer()
  probe.once('error', reject)
  probe.listen(0, '127.0.0.1', () => { const { port } = probe.address(); probe.close(() => resolve(port)) })
})
const server = await createServer({
  root,
  appType: 'spa',
  logLevel: 'error',
  server: { host: '127.0.0.1', port: Number(process.env.FANOTES_CHECK_PORT ?? await freePort()), strictPort: true, fs: { strict: false } },
})
await server.listen()
const base = process.env.FANOTES_CHECK_URL ?? `http://127.0.0.1:${server.httpServer.address().port}/?web`
const browser = await chromium.launch({ executablePath: browserBinary, args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'] })
let checks = 0

const safeShot = async (page, name) => {
  if (shotDir) await page.screenshot({ path: join(shotDir, `${name}.png`) }).catch(() => undefined)
}

const checkBar = async (page, where) => {
  checks += 1
  const result = await page.evaluate(measureBar)
  if (result.missing) return fail(where, 'the vertical toolbar is not rendered')
  if (!result.count) fail(where, 'the vertical toolbar has no items')
  for (const problem of result.problems) fail(where, problem)
}

const closePopovers = async (page, escape = true) => {
  // Escape also leaves ink mode, so panels opened in ink mode are only closed by their own button.
  if (escape) await page.keyboard.press('Escape').catch(() => undefined)
  await page.waitForTimeout(80)
}

/** Click one toolbar item, measure what it opened, close it again. */
const checkPopover = async (page, where, trigger, popover, { optional = false } = {}) => {
  const target = page.locator(`.editor-toolbar.is-vertical ${trigger}`).first()
  if (!(await target.count())) {
    if (!optional) { fail(where, `trigger ${trigger} not found`); await safeShot(page, `missing_${where.replace(/[^a-z0-9]+/giu, '_')}`) }
    return
  }
  await target.scrollIntoViewIfNeeded().catch(() => undefined)
  await target.click({ timeout: 3000 }).catch(async () => { await page.waitForTimeout(400); await target.click({ timeout: 4000 }).catch((error) => fail(where, `could not click ${trigger}: ${String(error).split('\n')[0]}`)) })
  await page.waitForTimeout(260)
  checks += 1
  const result = await page.evaluate(measurePopover, popover)
  if (!result.found) { if (!optional) fail(where, `${trigger} opened no ${popover}`) } else for (const problem of result.problems) fail(where, problem)
  await safeShot(page, where.replace(/[^a-z0-9]+/giu, '_'))
  // Toggle panels shut with the same button, then dismiss menus with Escape / an outside click.
  if (result.found && await page.evaluate((selector) => [...document.querySelectorAll(selector)].some((node) => node.getBoundingClientRect().width > 4), popover)) {
    await target.click({ timeout: 2000, force: true }).catch(() => undefined)
    await page.waitForTimeout(120)
  }
  await closePopovers(page, popover !== INK_PANELS)
}

const openSettingsSide = async (page, language) => {
  await page.getByRole('button', { name: language.settings }).first().click()
  await page.locator('button').filter({ hasText: language.theme }).first().click()
  await page.locator('button').filter({ hasText: /^Editor/u }).first().click()
  await page.locator('select[aria-label="Werkzeugleiste"], select[aria-label="Toolbar"]').first().selectOption('side')
  await page.getByRole('button', { name: language.done }).click()
  await page.waitForSelector('.editor-toolbar.is-vertical', { timeout: 10_000 })
}

const setViewport = async (page, size) => {
  await page.setViewportSize({ width: size.w, height: size.h })
  await page.waitForTimeout(160)
}
const mode = async (page, ink) => {
  const button = page.locator('.editor-toolbar .mode-switch button').nth(ink ? 1 : 0)
  if ((await button.getAttribute('aria-pressed')) === 'true') return
  await button.click()
  await page.waitForTimeout(350)
  if (ink) await page.waitForSelector('.editor-toolbar.is-vertical .lw-draw-toolgroup > button', { timeout: 15_000 }).catch(() => undefined)
}

const TYPE_POPOVERS = [
  ['.note-tags-menu > .toolbar-button', '.note-tags-popover'],
  ['.paper-picker__trigger', '.paper-picker__menu'],
  ['.menu-trigger', '.editor-more-menu'],
]
const FIGURE = '.lw-draw-toolgroup > button[title^="Figur"], .lw-draw-toolgroup > button[title*="igure"]'
const INK_PANELS = '.lw-figure-library, .lw-art-studio, .lw-drafting-panel, .lw-conversion-panel, .lw-draw-notice'
const INK_POPOVERS = [
  [FIGURE, INK_PANELS],
  ['.lw-draw-toolgroup > button[title^="Funktionsgraph"], .lw-draw-toolgroup > button[title*="unction graph"]', INK_PANELS],
  ['.lw-draw-toolgroup > button[title^="Lineal"], .lw-draw-toolgroup > button[title*="uler"]', INK_PANELS],
  ['.lw-draw-toolgroup > button[title^="Optionen"], .lw-draw-toolgroup > button[title*="ptions"]', INK_PANELS],
]

try {
  for (const language of LANGUAGES.filter((item) => !process.env.FANOTES_SIDE_LANG || item.locale.startsWith(process.env.FANOTES_SIDE_LANG))) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: language.locale, colorScheme: language.scheme })
    const page = await context.newPage()
    const pageErrors = []
    page.on('pageerror', (error) => pageErrors.push(String(error)))
    await page.goto(base, { waitUntil: 'domcontentloaded' })
    const startup = '.first-run-continue, button.pdf-import-button'
    await page.waitForSelector(startup, { timeout: 90_000 })
    for (let step = 0; step < 6 && await page.locator('.first-run-continue').count(); step += 1) {
      await page.locator('.first-run-continue').first().click()
      await page.waitForTimeout(700)
    }
    await page.waitForSelector('button.pdf-import-button', { timeout: 90_000 })
    await openSettingsSide(page, language)
    if (language.touch) await page.evaluate(() => document.documentElement.classList.add('has-touch-screen'))
    const tag = language.locale.slice(0, 2)

    // 0. PDF note (first: a fresh vault imports it most reliably)
    await setViewport(page, { w: 1440, h: 900, label: '1440x900@1' })
    // The cold Vite dev server may reload once while it optimises pdf.js: retry the import after a reload.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.locator('button.pdf-import-button').first().click()])
      await chooser.setFiles(pdfPath)
      if (await page.waitForSelector('[data-pdf-page="2"]', { timeout: 30_000 }).then(() => true, () => false)) break
      if (attempt === 2) throw new Error('the PDF note did not open')
      await page.reload({ waitUntil: 'domcontentloaded' })
      await page.waitForSelector('button.pdf-import-button', { timeout: 60_000 })
      if (!(await page.locator('.editor-toolbar.is-vertical').count())) await openSettingsSide(page, language)
    }
    await page.waitForTimeout(1500)
    for (const size of allSizes) {
      await setViewport(page, size)
      await mode(page, false)
      await checkBar(page, `${tag} pdf ${size.label}`)
    }
    if (process.env.FANOTES_SIDE_DEBUG) console.log('pdf state', await page.evaluate(() => [document.querySelector('.editor-toolbar')?.className, [...document.querySelectorAll('.editor-toolbar .mode-switch button')].map((b) => b.getAttribute('aria-pressed')).join(','), document.querySelector('.editor-toolbar .toolbar-context')?.innerHTML.slice(0, 120), document.querySelectorAll('.editor-split.is-split').length]))
    for (const size of popoverSizes) {
      await setViewport(page, size)
      await mode(page, false)
      await page.waitForSelector('.pdf-toolbar-slot .pdf-note-toolbar', { timeout: 10_000 }).catch(() => undefined)
      await checkPopover(page, `${tag} pdf search ${size.label}`, '.pdf-note-tools > button', '.pdf-note-search')
      await page.waitForTimeout(100)
      await mode(page, true)
      await checkBar(page, `${tag} pdf ink ${size.label}`)
      await mode(page, false)
    }
    await safeShot(page, `${tag}-pdf`)

    // 1. Markdown note
    await page.locator('.file-tree, .sidebar').getByText(/^(Willkommen|Welcome)$/u).first().click()
    await page.waitForSelector('.cm-editor, .markdown-editor', { timeout: 30_000 })
    await page.waitForTimeout(800)
    for (const size of allSizes) {
      await setViewport(page, size)
      await mode(page, false)
      await checkBar(page, `${tag} markdown typing ${size.label}`)
      await mode(page, true)
      await checkBar(page, `${tag} markdown ink ${size.label}`)
    }
    for (const size of popoverSizes) {
      await setViewport(page, size)
      await mode(page, false)
      for (const [trigger, popover] of TYPE_POPOVERS) await checkPopover(page, `${tag} typing ${trigger.split(' ')[0]} ${size.label}`, trigger, popover)
      await mode(page, true)
      for (const [trigger, popover] of INK_POPOVERS) await checkPopover(page, `${tag} ink ${trigger.slice(0, 30)} ${size.label}`, trigger, popover, { optional: true })
      // Drawing studio: brushes, special inks, width and opacity sliders, art brush trigger
      await page.locator('.editor-toolbar.is-vertical .lw-draw-toolgroup > button').nth(1).click({ timeout: 4000 }).catch((error) => fail(`${tag} ink drawing ${size.label}`, `drawing tool not clickable: ${String(error).split('\n').filter((line) => /intercepts|waiting for/u.test(line)).slice(-2).join(' ')}`))
      await page.waitForTimeout(400)
      await checkBar(page, `${tag} ink drawing mode ${size.label}`)
      await checkPopover(page, `${tag} ink art studio ${size.label}`, '.lw-art-studio-trigger', INK_PANELS, { optional: true })
      await page.locator('.editor-toolbar.is-vertical .lw-draw-toolgroup > button').nth(0).click({ timeout: 4000 }).catch(() => undefined)
      await page.waitForTimeout(300)
    }
    await safeShot(page, `${tag}-markdown-ink`)

    // 2a. split view (two notes side by side)
    await setViewport(page, { w: 1440, h: 900, label: '1440x900@1' })
    await mode(page, false)
    // The split needs a second note.
    await page.getByRole('button', { name: /^(Neue Notiz|New note)$/u }).first().click({ timeout: 4000 }).catch(() => undefined)
    await page.waitForTimeout(900)
    for (const trigger of ['.editor-toolbar.is-vertical .menu-trigger']) {
      await page.locator(trigger).first().click({ timeout: 4000 }).catch(() => undefined)
      await page.locator('.editor-more-menu button').filter({ hasText: /Geteilte Ansicht|Split view/u }).first().click({ timeout: 4000 }).catch((error) => fail(`${tag} split view`, `menu entry not clickable: ${String(error).split('\n')[0]}`))
    }
    await page.waitForTimeout(900)
    if (await page.locator('.editor-split.is-split').count()) {
      for (const size of allSizes) {
        await setViewport(page, size)
        await checkBar(page, `${tag} split view ${size.label}`)
      }
      await setViewport(page, { w: 1440, h: 900, label: '1440x900@1' })
      await safeShot(page, `${tag}-split`)
      await page.locator('.editor-toolbar.is-vertical .menu-trigger').first().click({ timeout: 4000 }).catch(() => undefined)
      await page.locator('.editor-more-menu button').filter({ hasText: /Geteilte Ansicht|Split view|Close split|Teilung/u }).first().click({ timeout: 4000 }).catch(() => undefined)
      await page.waitForTimeout(600)
    } else { fail(`${tag} split view`, 'split view did not open'); await safeShot(page, `${tag}-split-missing`) }

    // 2b. focus mode
    await setViewport(page, { w: 1280, h: 720, label: '1280x720@1' })
    await mode(page, false)
    await page.keyboard.press('Control+Shift+E')
    await page.waitForTimeout(500)
    await checkBar(page, `${tag} focus mode`)
    await safeShot(page, `${tag}-focus`)
    await page.keyboard.press('Control+Shift+E')
    await page.waitForTimeout(400)

    // 3. worksheet
    await page.evaluate(() => { document.activeElement?.blur?.() })
    await page.locator('.editor-toolbar.is-vertical .toolbar-button:has(svg)').filter({ has: page.locator('svg') }).evaluateAll((nodes) => nodes.find((node) => /Arbeitsblatt|worksheet/iu.test(node.getAttribute('aria-label') ?? ''))?.click())
    await page.waitForSelector('.worksheet-import-options', { timeout: 5000 }).catch(() => undefined)
    const [sheetChooser] = await Promise.all([
      page.waitForEvent('filechooser', { timeout: 8000 }).catch(() => null),
      page.locator('.worksheet-import-options button').nth(1).click({ timeout: 4000 }).catch(() => undefined),
    ])
    if (sheetChooser) {
      await sheetChooser.setFiles(pngPath)
      await page.waitForTimeout(2500)
      for (const size of popoverSizes) {
        await setViewport(page, size)
        await mode(page, false).catch(() => undefined)
        await checkBar(page, `${tag} worksheet typing ${size.label}`)
        await mode(page, true).catch(() => undefined)
        await checkBar(page, `${tag} worksheet ink ${size.label}`)
      }
      await safeShot(page, `${tag}-worksheet`)
    }

    if (pageErrors.length) fail(`${tag} page errors`, pageErrors.slice(0, 3).join(' | '))
    await context.close()
  }
} finally {
  await browser.close()
  await server.close()
}

if (violations.length) {
  const unique = [...new Set(violations)]
  console.log(`${unique.length} violation(s) in ${checks} measurements:`)
  for (const line of unique.slice(0, 400)) console.log(`  - ${line}`)
  if (!report) process.exit(1)
} else {
  console.log(`side toolbar ok (${checks} measurements)`)
}
