// Settings modal layout + OLED theme check (real Chromium via playwright-core, web build, synthetic data only).
//  - at 1400 and 800 px, in Hell / Dunkel / OLED: no horizontal overflow, every section reachable and rendered
//  - OLED: app, panels, sidebar, toolbar and the dialog compute to pure #000, no shadows or blurs
//  - the saved theme is applied before first paint (boot-theme.js)
// Skipped with FANOTES_SKIP_BROWSER=1 or when no browser exists. FANOTES_SHOTS=<dir> writes screenshots.
import assert from 'node:assert/strict'
import { existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createServer } from 'vite'

const chromium = process.env.FANOTES_CHROMIUM ?? '/usr/bin/chromium'
const playwrightEntry = process.env.PLAYWRIGHT_CORE ?? '/srv/agents/fanotes/.site-redesign-tools/node_modules/playwright-core/index.mjs'
if (process.env.FANOTES_SKIP_BROWSER === '1' || !existsSync(chromium) || !existsSync(playwrightEntry)) {
  console.log('settings layout check skipped (no chromium / playwright-core)')
  process.exit(0)
}
const { chromium: browserType } = await import(pathToFileURL(playwrightEntry).href)
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const shots = process.env.FANOTES_SHOTS
if (shots) mkdirSync(shots, { recursive: true })

const server = await createServer({ root, appType: 'spa', logLevel: 'error', server: { host: '127.0.0.1', port: Number(process.env.FANOTES_CHECK_PORT ?? 5371), strictPort: false, fs: { strict: false } } })
await server.listen()
const base = `http://127.0.0.1:${server.httpServer.address().port}/?web`
const browser = await browserType.launch({ executablePath: chromium, args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'] })
let failed = false
try {
  const THEMES = [['Hell', 'light'], ['Dunkel', 'dark'], ['OLED', 'oled']]
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 }, locale: 'de-CH' })
  const page = await context.newPage()
  await page.goto(base, { waitUntil: 'domcontentloaded' })
  const startup = '.first-run-continue, .pdf-import-button'
  await page.waitForSelector(startup, { timeout: 45_000 }).catch(async () => {
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.waitForSelector(startup, { timeout: 90_000 })
  })
  for (let step = 0; step < 6 && await page.locator('.first-run-continue').count(); step += 1) {
    await page.locator('.first-run-continue').first().click()
    await page.waitForTimeout(900)
  }
  const openSettings = async () => {
    if (await page.locator('.settings-modal').count()) return
    await page.getByRole('button', { name: 'Einstellungen öffnen' }).first().click({ timeout: 60000 })
    await page.locator('.settings-modal').waitFor()
  }
  await page.getByRole('button', { name: 'Einstellungen öffnen' }).first().waitFor({ timeout: 90000 })

  const overflow = () => page.evaluate(() => {
    const modal = document.querySelector('.settings-modal')
    const box = modal.getBoundingClientRect()
    const bad = []
    for (const el of modal.querySelectorAll('*')) {
      const r = el.getBoundingClientRect()
      if (!r.width || !r.height) continue
      if (el.closest('nav') && el.closest('nav').scrollWidth > el.closest('nav').clientWidth + 1) bad.push(`nav-x ${el.className}`)
      // Content inside its own horizontal scroller (a wide heatmap) or clip is fine.
      let clipped = false
      for (let parent = el.parentElement; parent && parent !== modal; parent = parent.parentElement) {
        if (getComputedStyle(parent).overflowX !== 'visible' && parent.getBoundingClientRect().right <= box.right + 1) { clipped = true; break }
      }
      if (r.right > box.right + 1 && !clipped) bad.push(`${el.tagName}.${String(el.className).slice(0, 40)} right=${Math.round(r.right)} modal=${Math.round(box.right)}`)
    }
    const scroll = document.querySelector('.settings-scroll')
    return {
      bad: bad.slice(0, 5),
      modalRight: box.right <= innerWidth + 1,
      modalBottom: box.bottom <= innerHeight + 1,
      scrollX: scroll.scrollWidth - scroll.clientWidth,
      modalX: modal.scrollWidth - modal.clientWidth,
    }
  })

  for (const [width, height] of [[1400, 900], [800, 600]]) {
    await page.setViewportSize({ width, height })
    for (const [label, id] of THEMES) {
      await openSettings()
      await page.locator('.settings-nav nav button', { hasText: 'Darstellung' }).first().click()
      await page.locator('.theme-choice', { hasText: label }).first().click()
      await page.waitForFunction((theme) => document.body.classList.contains(`app-theme-${theme}`), id)
      const sections = await page.locator('.settings-nav nav button').count()
      assert.ok(sections >= 8, `${sections} sections listed`)
      for (let index = 0; index < sections; index += 1) {
        const button = page.locator('.settings-nav nav button').nth(index)
        await button.scrollIntoViewIfNeeded()
        await button.click()
        const state = await overflow()
        const tag = `${width}px ${id} section ${index}`
        assert.deepEqual(state.bad, [], `${tag}: elements outside the dialog`)
        assert.ok(state.modalRight && state.modalBottom, `${tag}: dialog fits the window`)
        assert.ok(state.scrollX <= 1 && state.modalX <= 1, `${tag}: horizontal overflow ${state.scrollX}/${state.modalX}`)
        const content = await page.evaluate(() => ({
          title: document.querySelector('.settings-content h2')?.textContent?.trim() ?? '',
          cards: document.querySelectorAll('.settings-scroll .setting-card, .settings-scroll .setting-callout, .settings-scroll > *').length,
          scrollable: (() => { const s = document.querySelector('.settings-scroll'); return s.scrollHeight >= s.clientHeight })(),
          active: document.querySelectorAll('.settings-nav nav button.active').length,
        }))
        assert.ok(content.title && content.cards > 0 && content.scrollable && content.active === 1, `${tag}: section renders ${JSON.stringify(content)}`)
        if (shots && index === 0) await page.screenshot({ path: join(shots, `settings-${width}-${id}.png`) })
      }
      if (id === 'oled') {
        await page.locator('.settings-nav nav button', { hasText: 'Darstellung' }).first().click()
        const paint = await page.evaluate(() => {
          const color = (selector) => { const el = document.querySelector(selector); return el ? getComputedStyle(el).backgroundColor : null }
          const modal = document.querySelector('.settings-modal')
          return {
            body: color('body'), shell: color('.app-shell'), modal: color('.settings-modal'), nav: color('.settings-nav'),
            card: color('.setting-card'), sidebar: color('.sidebar'), backdrop: color('.settings-backdrop'),
            shadow: getComputedStyle(modal).boxShadow, blur: getComputedStyle(document.querySelector('.settings-backdrop')).backdropFilter,
            html: document.documentElement.dataset.theme,
          }
        })
        for (const [key, value] of Object.entries(paint)) {
          if (['body', 'shell', 'modal', 'nav', 'card', 'sidebar', 'backdrop'].includes(key) && value !== null) assert.equal(value, 'rgb(0, 0, 0)', `OLED ${key} background`)
        }
        assert.equal(paint.shadow, 'none', 'OLED dialog has no shadow')
        assert.ok(paint.blur === 'none' || paint.blur === '', 'OLED scrim has no blur')
        assert.equal(paint.html, 'dark')
      }
      await page.keyboard.press('Escape')
      await page.locator('.settings-modal').waitFor({ state: 'detached' }).catch(async () => {
        await page.locator('.settings-content > header .icon-button').click()
      })
    }
  }

  // OLED is remembered and applied before React mounts.
  const stored = await page.evaluate(() => localStorage.getItem('fanotes.theme'))
  assert.equal(stored, 'oled', 'theme stored for first paint')
  const early = await context.newPage()
  await early.route('**/*.{ts,tsx}', (route) => route.abort())
  await early.goto(base, { waitUntil: 'domcontentloaded' })
  const boot = await early.evaluate(() => ({ html: document.documentElement.style.background, body: getComputedStyle(document.body).backgroundColor }))
  assert.match(boot.html, /rgb\(0, 0, 0\)|#000/u, 'html background is black at DOMContentLoaded')
  assert.equal(boot.body, 'rgb(0, 0, 0)', 'body background is black before the app mounts')
  console.log('settings layout and OLED checks ok')
} catch (error) {
  failed = true
  console.error(error)
} finally {
  await browser.close()
  await server.close()
}
process.exit(failed ? 1 : 0)
