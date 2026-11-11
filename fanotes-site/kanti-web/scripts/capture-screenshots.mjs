// Captures the demo-mode screenshots for the /about/ page (phone width, light theme, synthetic data).
// Usage: PLAYWRIGHT_BROWSERS_PATH=... node scripts/capture-screenshots.mjs
// Starts a Vite dev server unless BASE_URL is set. Output: public/about/img/*.webp
import { spawn, execFileSync } from 'node:child_process'
import { mkdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from '@playwright/test'

const root = new URL('..', import.meta.url).pathname
const out = join(root, 'public/about/img')
mkdirSync(out, { recursive: true })
const port = 47931
const base = process.env.BASE_URL || `http://127.0.0.1:${port}`

const shots = [
  ['heute', '/?demo', 'Heute'],
  ['stundenplan', '/stundenplan?demo', 'Stundenplan'],
  ['noten', '/noten?demo', 'Noten'],
  ['termine', '/termine?demo', 'Prüfungen'],
  ['absenzen', '/absenzen?demo', 'Absenzen'],
  ['pendeln', '/pendeln?demo', 'Pendeln'],
]

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
  const context = await browser.newContext({
    viewport: { width: 390, height: 780 }, deviceScaleFactor: 2, locale: 'de-CH', timezoneId: 'Europe/Zurich',
    colorScheme: 'light', isMobile: true, hasTouch: true,
  })
  const page = await context.newPage()
  for (const [name, path, heading] of shots) {
    await page.goto(base + path)
    await page.getByRole('heading', { name: heading }).first().waitFor()
    await page.waitForLoadState('networkidle')
    await page.waitForTimeout(600)
    const png = join(tmpdir(), `kanti-${name}.png`)
    await page.screenshot({ path: png })
    const webp = join(out, `${name}.webp`)
    execFileSync('magick', [png, '-strip', '-quality', '72', '-define', 'webp:method=6', webp])
    rmSync(png)
    console.log(name, statSync(webp).size)
  }
} finally {
  await browser.close()
  server?.kill()
}
