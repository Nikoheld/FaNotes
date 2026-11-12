// Captures every image of the /about/ page from the demo mode (synthetic data, fixed clock Wed 11 Nov 2026 10:02).
//   desktop 1440x900, light + dark:  <view>-desktop.webp / <view>-desktop-dark.webp   (heute, stundenplan, noten, pendeln)
//   phone   390 wide, light:         <view>.webp                                      (heute, stundenplan, noten)
// File names and pixel sizes are stable, so re-running this script refreshes the landing page without touching its markup.
// Usage: PORT=<port> PLAYWRIGHT_BROWSERS_PATH=... node scripts/capture-screenshots.mjs
// Starts a Vite dev server unless BASE_URL is set. Needs ImageMagick (`magick`). Output: public/about/img/*.webp
import { spawn, execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from '@playwright/test'

const root = new URL('..', import.meta.url).pathname
const out = join(root, 'public/about/img')
mkdirSync(out, { recursive: true })
const work = mkdtempSync(join(tmpdir(), 'kanti-shots-'))
const port = Number(process.env.PORT || 47931)
const base = process.env.BASE_URL || `http://127.0.0.1:${port}`
const CLOCK = process.env.CLOCK || '2026-11-11T10:02:00+01:00'

// name, path, heading shown in the top bar
const views = [
  ['heute', '/?demo', 'Heute'],
  ['stundenplan', '/stundenplan?demo', 'Stundenplan'],
  ['noten', '/noten?demo', 'Noten'],
  ['pendeln', '/pendeln?demo', 'Pendeln'],
]
const jobs = [
  // desktop: keep 1440x900, budget 120 KB each
  ...views.flatMap(([name, path, heading]) => [
    { name: `${name}-desktop`, path, heading, scheme: 'light', phone: false, budget: 120_000 },
    { name: `${name}-desktop-dark`, path, heading, scheme: 'dark', phone: false, budget: 120_000 },
  ]),
  // phone: captured at 2x, stored at 540x1080, budget 50 KB each
  ...views.slice(0, 3).map(([name, path, heading]) => ({ name, path, heading, scheme: 'light', phone: true, budget: 50_000 })),
]

let server
if (!process.env.BASE_URL) {
  server = spawn('npx', ['vite', '--port', String(port), '--strictPort', '--host', '127.0.0.1'], { cwd: root, stdio: 'ignore', detached: true })
  for (let i = 0; i < 60; i += 1) {
    try { if ((await fetch(base)).ok) break } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 500))
  }
}

/** Encodes the PNG as WebP at the highest quality that fits the byte budget. */
const encode = (png, webp, phone, budget) => {
  const resize = phone ? ['-resize', '540x1080'] : []
  for (const quality of [84, 78, 72, 66, 60, 54, 48, 42]) {
    execFileSync('magick', [png, ...resize, '-strip', '-quality', String(quality), '-define', 'webp:method=6', webp])
    if (statSync(webp).size <= budget) return quality
  }
  return 0
}

const browser = await chromium.launch()
let total = 0
try {
  for (const scheme of ['light', 'dark']) {
    for (const phone of [false, true]) {
      const wanted = jobs.filter((job) => job.scheme === scheme && job.phone === phone)
      if (!wanted.length) continue
      const context = await browser.newContext({
        ...(phone ? { viewport: { width: 390, height: 780 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true } : { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 }),
        locale: 'de-CH', timezoneId: 'Europe/Zurich', colorScheme: scheme, reducedMotion: 'reduce',
      })
      await context.addInitScript(() => { try { localStorage.setItem('kanti-web:prefs', JSON.stringify({ onboarded: true, snowfall: false })) } catch { /* storage blocked */ } })
      const page = await context.newPage()
      await page.clock.install({ time: new Date(CLOCK) })
      for (const job of wanted) {
        await page.goto(base + job.path)
        await page.locator('.topbar-title h1', { hasText: job.heading }).first().waitFor()
        await page.waitForLoadState('networkidle').catch(() => {})
        await page.waitForTimeout(900)
        const png = join(work, `${job.name}.png`)
        await page.screenshot({ path: png })
        const webp = join(out, `${job.name}.webp`)
        const quality = encode(png, webp, job.phone, job.budget)
        const size = statSync(webp).size
        total += size
        console.log(job.name.padEnd(28), String(size).padStart(7), 'bytes', quality ? `q${quality}` : 'OVER BUDGET')
      }
      await context.close()
    }
  }
} finally {
  await browser.close()
  // npx starts vite as a child: end the whole process group, or the dev server outlives the script.
  if (server?.pid) try { process.kill(-server.pid) } catch { /* already gone */ }
  rmSync(work, { recursive: true, force: true })
}
console.log('total', total, 'bytes')
