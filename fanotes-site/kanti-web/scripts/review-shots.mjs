// Review screenshots of every view in demo mode (synthetic data), for design checks.
// Usage: PLAYWRIGHT_BROWSERS_PATH=... node scripts/review-shots.mjs <out-dir> [filter]
// Starts a Vite dev server unless BASE_URL is set. Writes <view>-<size>-<theme>.png.
import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { chromium } from '@playwright/test'

const root = new URL('..', import.meta.url).pathname
const out = process.argv[2] || join(root, '.shots')
const filter = process.argv[3] || ''
mkdirSync(out, { recursive: true })
const port = Number(process.env.PORT || 47932)
const base = process.env.BASE_URL || `http://127.0.0.1:${port}`

const views = [
  ['heute', '/?demo'],
  ['stundenplan', '/stundenplan?demo'],
  ['noten', '/noten?demo'],
  ['termine', '/termine?demo'],
  ['absenzen', '/absenzen?demo'],
  ['mitteilungen', '/mitteilungen?demo'],
  ['pendeln', '/pendeln?demo'],
  ['einstellungen', '/einstellungen?demo'],
  ['anmelden', '/'],
  ['about', '/about/'],
  ['404', '/404.html'],
]
const sizes = { desktop: { width: 1440, height: 900 }, tablet: { width: 820, height: 1100 }, phone: { width: 390, height: 780 } }
const wanted = (process.env.SIZES || 'desktop').split(',')
const themes = (process.env.THEMES || 'light,dark').split(',')

let server
if (!process.env.BASE_URL) {
  server = spawn('npx', ['vite', '--port', String(port), '--strictPort', '--host', '127.0.0.1'], { cwd: root, stdio: 'ignore' })
  for (let i = 0; i < 60; i += 1) {
    try { if ((await fetch(base)).ok) break } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 500))
  }
}
const browser = await chromium.launch()
try {
  for (const size of wanted) for (const theme of themes) {
    const context = await browser.newContext({ viewport: sizes[size], locale: 'de-CH', timezoneId: 'Europe/Zurich', colorScheme: theme, reducedMotion: 'reduce' })
    const page = await context.newPage()
    // A fixed school morning, so the dashboard shows a running lesson and the shots compare.
    await page.clock.install({ time: new Date(process.env.CLOCK || '2026-11-11T10:02:00+01:00') })
    for (const [name, path] of views) {
      if (filter && !filter.split(',').includes(name)) continue
      await page.goto(base + path)
      await page.waitForLoadState('networkidle').catch(() => {})
      await page.waitForTimeout(500)
      await page.screenshot({ path: join(out, `${name}-${size}-${theme}.png`), fullPage: process.env.FULL !== '0' })
    }
    await context.close()
  }
} finally {
  await browser.close()
  server?.kill()
}
