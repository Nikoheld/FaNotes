// Renders the compass (Zirkel) in the real Electron app under Xvfb and saves screenshots:
// light / dark / OLED x 100% / 200% zoom x idle / drawing an arc.
//   node scripts/capture-compass.mjs <outDir> <prefix>
// Needs `vite build` (dist/), xvfb-run and playwright-core (PLAYWRIGHT_CORE).
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const [outDir = path.join(os.tmpdir(), 'compass-shots'), prefix = 'shot'] = process.argv.slice(2)
fs.mkdirSync(outDir, { recursive: true })
const electron = path.join(root, 'node_modules', 'electron', 'dist', 'electron')
const pw = await import(process.env.PLAYWRIGHT_CORE || 'playwright-core')
const chromium = pw.chromium ?? pw.default.chromium
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const tmp = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'fanotes-compass-'))
const home = path.join(tmp, 'home'); const cfg = path.join(tmp, 'config'); const run = path.join(tmp, 'run')
const vault = path.join(home, 'Notizen'); const userData = path.join(cfg, 'FaNotes')
for (const d of [home, cfg, run, vault, userData]) fs.mkdirSync(d, { recursive: true, mode: 0o700 })
fs.writeFileSync(path.join(vault, 'Geometrie.md'), '# Geometrie\n\nKonstruktion.\n\n'.repeat(1))
const writeConfig = (theme) => fs.writeFileSync(path.join(userData, 'config.json'), JSON.stringify({
  version: 3, vaultPath: vault,
  settings: { uiLanguage: 'de', theme, autoCheckUpdates: false, autoDownloadUpdates: false },
  onboarding: { version: 1, completed: true },
}))
const port = 19_800 + Math.floor(Math.random() * 90)
let child = null
const launch = async (theme) => {
  for (const entry of fs.readdirSync(userData)) fs.rmSync(path.join(userData, entry), { recursive: true, force: true })
  writeConfig(theme)
  child = spawn('xvfb-run', ['-a', '-s', '-screen 0 1440x1000x24', electron, root, `--remote-debugging-port=${port}`, '--no-sandbox'], {
    env: { ...process.env, HOME: home, XDG_CONFIG_HOME: cfg, XDG_RUNTIME_DIR: run }, stdio: 'ignore', detached: true })
  let browser = null
  for (let i = 0; i < 90 && !browser; i += 1) { try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`) } catch { await sleep(1000) } }
  let page = null
  for (let i = 0; i < 90 && !page; i += 1) { page = browser.contexts().flatMap((c) => c.pages()).find((p) => /index\.html|^file:/.test(p.url()) && !/ocr|recognition/.test(p.url())) ?? null; if (!page) await sleep(500) }
  await page.waitForSelector('[role=treeitem]', { timeout: 90_000 })
  return { browser, page }
}
const stop = () => { try { process.kill(-child.pid, 'SIGKILL') } catch { /* gone */ } }
process.on('exit', stop)

for (const theme of ['light', 'dark', 'oled']) {
  const { browser, page } = await launch(theme)
  try {
    await page.locator('[role=treeitem]', { hasText: 'Geometrie' }).first().click()
    await sleep(1200)
    await page.locator('button', { hasText: /^\s*Stift\s*$/ }).last().click()
    await sleep(1200)
    await page.getByRole('button', { name: 'OK', exact: true }).click({ timeout: 3000 }).catch(() => {})
    for (const label of (process.env.COMPASS_TOOLS || 'Zirkel').split(',')) {
      await page.locator('button[aria-pressed]', { hasText: label }).first().click()
      await sleep(500)
    }
    const options = page.locator('button[aria-pressed="true"]', { hasText: 'Optionen' })
    if (await options.count()) await options.first().click()
    await sleep(600)
    for (const zoom of [1, 2]) {
      if (zoom === 2) {
        const sheet = await page.locator('.lw-drafting-layer').first().boundingBox()
        await page.mouse.move(sheet.x + sheet.width / 2, sheet.y + sheet.height / 2)
        await page.keyboard.down('Control')
        for (let i = 0; i < 120; i += 1) {
          const now = Number((await page.locator('button', { hasText: /^\d+%$/ }).first().textContent()).replace('%', ''))
          if (now >= 200) break
          await page.mouse.wheel(0, -6); await sleep(350)
        }
        await page.keyboard.up('Control')
        await sleep(800)
      }
      const shot = async (name) => page.screenshot({ path: path.join(outDir, `${prefix}-${theme}-${zoom * 100}-${name}.png`) })
      console.log(theme, zoom, await page.locator('button', { hasText: /^\d+%$/ }).first().textContent().catch(() => '?'))
      await shot('idle')
      const hits = await page.evaluate(() => [...document.querySelectorAll('.lw-compass-hit')].map((e) => { const r = e.getBoundingClientRect(); return `${Math.round(r.width)}x${Math.round(r.height)}` }))
      console.log(theme, zoom, 'hit areas (screen px):', hits.join(' '))
      if (theme === 'light') {
        const chip = await page.locator('.lw-compass-readout .lw-compass-hit').boundingBox()
        await page.mouse.move(chip.x + chip.width / 2, chip.y + chip.height / 2); await page.mouse.down()
        await page.mouse.move(chip.x + chip.width / 2 + 60, chip.y + chip.height / 2 + 60, { steps: 8 }); await page.mouse.up()
        console.log('radius after drag:', await page.locator('.lw-compass-chip-text').textContent())
        await page.keyboard.press('Control+z')
      }
      const nb = await page.locator('.lw-drafting-draw, .lw-compass-lead-ring').first().boundingBox()
      if (nb) {
        const cx = nb.x + nb.width / 2; const cy = nb.y + nb.height / 2
        await page.mouse.move(cx, cy); await page.mouse.down()
        for (let i = 1; i <= 25; i += 1) await page.mouse.move(cx - i * 4, cy + i * 5)
        await sleep(200)
        await shot('arc')
        await page.mouse.up(); await sleep(300)
        await page.keyboard.press('Control+z'); await sleep(300)
      } else console.log('no draw handle')
    }
  } finally { await browser.close().catch(() => {}); stop(); await sleep(1500) }
}
fs.rmSync(tmp, { recursive: true, force: true })
