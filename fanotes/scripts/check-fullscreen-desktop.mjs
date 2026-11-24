// Real desktop app (Electron under Xvfb): the toolbar fullscreen button fills the window with the document at several
// window sizes (no black slab), leaving restores the layout, and the sidebar collapse-all button sits in the search row.
// Needs a built renderer (`vite build`), xvfb-run and PLAYWRIGHT_CORE. Without a window manager the window may not reach the full screen; the check compares the document with the actual window.
// Usage: FANOTES_SCREEN=1920x1080 PLAYWRIGHT_CORE=... xvfb-run -a node scripts/check-fullscreen-desktop.mjs
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Playwright is not an app dependency: set PLAYWRIGHT_CORE to its entry file, or install it next to the app.
const { chromium } = await import(process.env.PLAYWRIGHT_CORE || 'playwright-core')
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const executable = path.join(root, 'node_modules', 'electron', 'dist', 'electron')
const temporary = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'fanotes-fullscreen-'))
const home = path.join(temporary, 'home')
const configHome = path.join(temporary, 'config')
const runtime = path.join(temporary, 'runtime')
const vault = path.join(home, 'Notizen')
const userData = path.join(configHome, 'FaNotes')
for (const directory of [home, configHome, runtime, vault, userData, vault]) fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
for (const dir of ['C', 'D/E', 'G', 'H/Inner', 'I', 'J', 'K']) fs.mkdirSync(path.join(vault, dir), { recursive: true })
fs.writeFileSync(path.join(vault, 'Loose.md'), '# loose\n')
fs.writeFileSync(path.join(vault, 'Loose2.md'), '# loose2\n')
fs.writeFileSync(path.join(userData, 'config.json'), `${JSON.stringify({
  version: 3,
  vaultPath: vault,
  settings: { uiLanguage: 'de', autoCheckUpdates: false, autoDownloadUpdates: false, reduceMotion: true },
  onboarding: { version: 1, completed: true },
}, null, 2)}\n`, { mode: 0o600 })


fs.writeFileSync(path.join(vault, 'Note.md'), '# note\n')
const screen = process.env.FANOTES_SCREEN || '1440x900'
const port = 19_300 + Math.floor(Math.random() * 400)
const child = spawn('xvfb-run', ['-a', '-s', `-screen 0 ${screen}x24`, executable, root, `--remote-debugging-port=${port}`, '--no-sandbox'], {
  env: { ...process.env, HOME: home, XDG_CONFIG_HOME: configHome, XDG_RUNTIME_DIR: runtime },
  stdio: ['ignore', 'pipe', 'pipe'],
  detached: true,
})
let output = ''
child.stdout.on('data', (chunk) => { output += chunk })
child.stderr.on('data', (chunk) => { output += chunk })
const results = []
const ok = (name, pass, detail = '') => { results.push(pass); console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail !== '' ? ` → ${String(detail).slice(0, 240)}` : ''}`) }
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const read = (name) => fs.readFileSync(path.join(vault, name), 'utf8')
const files = () => fs.readdirSync(vault).sort()
const copiesOf = (stem) => files().filter((file) => file.startsWith(`${stem} (Konflikt`))
const until = async (check, timeout = 15_000) => {
  const end = Date.now() + timeout
  while (Date.now() < end) { if (await check()) return true; await sleep(150) }
  return false
}

let browser
try {
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`); break } catch { await sleep(250) }
    if (child.exitCode !== null) throw new Error(`Electron exited (${child.exitCode}): ${output.slice(-500)}`)
  }
  assert.ok(browser, 'Electron did not open a debugging port')
  let page = null
  for (let tries = 0; tries < 120 && !page; tries += 1) {
    page = browser.contexts().flatMap((context) => context.pages()).find((candidate) => !/^devtools|ocr-host|recognition\.html|fanotes-note-export/u.test(candidate.url())) ?? null
    if (!page) await sleep(250)
  }
  assert.ok(page, 'no renderer page')
  await page.waitForFunction(() => Boolean(window.fanotes && document.querySelector('.file-tree__row')), null, { timeout: 60_000 })
  const metrics = () => page.evaluate(() => {
    const rect = (selector) => { const el = document.querySelector(selector); if (!el) return null; const r = el.getBoundingClientRect(); return { left: r.left, width: r.width, height: r.height, top: r.top } }
    return { inner: { width: window.innerWidth, height: window.innerHeight }, workspace: rect('.workspace'), sidebar: rect('.sidebar'), search: rect('.sidebar-search'), tree: rect('.file-tree-wrap'), foldInSearch: Boolean(document.querySelector('.sidebar-search .file-tree__fold-button')), foldRow: Boolean(document.querySelector('.file-tree__fold')) }
  })
  const normal = await metrics()
  ok('collapse-all button is inside the search row', normal.foldInSearch && !normal.foldRow)
  ok('tree starts right below the search bar', normal.tree.top - (normal.search.top + normal.search.height) <= 12, JSON.stringify([normal.tree.top, normal.search.top + normal.search.height]))
  const button = page.locator('button[aria-label="Vollbild"]')
  // The Xvfb screen is the fullscreen target; FANOTES_SCREEN=WxH picks its size (default 1440x900).
  const before = normal
  await page.locator('button[aria-label="Vollbild"]').click()
  ok(`${screen}: toolbar fullscreen entered`, await until(() => page.evaluate(() => document.querySelector('.app-shell.toolbar-fullscreen') !== null)))
  await sleep(500)
  const full = await metrics()
  ok(`${screen}: document fills the window`, full.workspace.left === 0 && Math.abs(full.workspace.width - full.inner.width) <= 1, JSON.stringify([full.workspace, full.inner]))
  await page.keyboard.press('Escape')
  ok(`${screen}: Esc leaves fullscreen`, await until(() => page.evaluate(() => document.querySelector('.app-shell.toolbar-fullscreen') === null)))
  await sleep(800)
  const after = await metrics()
  ok(`${screen}: layout restored`, Math.abs(after.workspace.width - before.workspace.width) <= 1 && Math.abs(after.sidebar.width - before.sidebar.width) <= 1, JSON.stringify([before.workspace, after.workspace]))
} catch (error) {
  ok('run finished', false, `${error.stack}\n${output.slice(-800)}`)
} finally {
  await browser?.close().catch(() => undefined)
  try { process.kill(-child.pid, 'SIGTERM') } catch { child.kill('SIGTERM') }
  await sleep(800)
  try { process.kill(-child.pid, 'SIGKILL') } catch { /* already gone */ }
  fs.rmSync(temporary, { recursive: true, force: true })
}
console.log(`${results.filter(Boolean).length}/${results.length} passed`)
process.exit(results.some((pass) => !pass) ? 1 : 0)
