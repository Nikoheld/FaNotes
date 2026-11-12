// Screenshots of the connection detail in demo mode (synthetic data, fixed clock), for design checks.
// Usage: PORT=47961 PLAYWRIGHT_BROWSERS_PATH=... node scripts/detail-shots.mjs <out-dir>
// Expects a Vite dev server on PORT (or BASE_URL). Writes detail-<route>-<size>-<theme>-<collapsed|expanded>.png.
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { chromium } from '@playwright/test'

const out = process.argv[2] || '.shots'
mkdirSync(out, { recursive: true })
const base = process.env.BASE_URL || `http://127.0.0.1:${Number(process.env.PORT || 47961)}`
const sizes = { desktop: { width: 1440, height: 900 }, phone: { width: 390, height: 780 } }
// Board trips to open: the delayed S-Bahn + tram, and the lake trip that is under way (ship, S-Bahn, IR).
const cases = [['school', 'Schule', 0], ['lake', 'Seeweg', 0]]

const browser = await chromium.launch()
// The whole run must finish in two minutes (it once hung for hours on an endless loop).
const watchdog = setTimeout(() => { console.error('detail-shots: timed out'); process.exit(2) }, 120_000)
watchdog.unref()
try {
  for (const [size, viewport] of Object.entries(sizes)) for (const theme of ['light', 'dark']) {
    const context = await browser.newContext({ viewport, locale: 'de-CH', timezoneId: 'Europe/Zurich', colorScheme: theme, reducedMotion: 'reduce' })
    const page = await context.newPage()
    await page.clock.install({ time: new Date('2026-11-11T10:02:00+01:00') })
    for (const [name, tab, index] of cases) {
      await page.goto(`${base}/pendeln?demo`)
      await page.waitForLoadState('networkidle').catch(() => {})
      if (tab !== 'Schule') await page.getByRole('tab', { name: tab }).click()
      await page.locator('.trip-head').nth(index).click()
      await page.getByRole('dialog').waitFor()
      await page.waitForTimeout(500)
      await page.screenshot({ path: join(out, `detail-${name}-${size}-${theme}-collapsed.png`) })
      // Unfold every leg; bounded, and each click times out quickly, so a stuck toggle cannot hang the run.
      const toggles = page.locator('.rail-gap .rail-toggle')
      for (let round = 0; round < 6 && await toggles.count(); round += 1) await toggles.first().click({ timeout: 5000 })
      await page.waitForTimeout(300)
      await page.screenshot({ path: join(out, `detail-${name}-${size}-${theme}-expanded.png`) })
    }
    await context.close()
  }
} finally {
  await browser.close()
}
