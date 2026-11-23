// Regression check for "the app freezes for a second or two every few seconds" (owner report, 2026.11.3 Linux).
// Launches the built renderer in Electron under Xvfb with a temp profile and a synthetic vault (hundreds of notes,
// long notes, ink notes incl. one with thousands of strokes, PDFs), and watches the main window for a few minutes:
//   - idle with a note open: no main-thread task over IDLE_MAX_MS (a periodic job would show up here);
//   - a use loop (open, type, scroll, draw, close): no task over USE_MAX_MS;
//   - the JS heap after a GC does not keep growing while the same notes are opened and closed again and again
//     (a retained drawing document of the heavy ink note is ~5 MB per open, so a leak is obvious);
//   - the document's CSS rule count stays flat (every editor used to mount a new theme that CodeMirror never unmounts).
//   node scripts/check-no-periodic-stalls.mjs      (skips without xvfb, dist/, playwright)
//   FANOTES_STALLS_REPORT=1                        print every long task and the heap table
//   FANOTES_STALLS_IDLE_S / FANOTES_STALLS_USE_S   phase lengths in seconds (default 40 / 100)
// Needs `vite build` (dist/), xvfb-run and playwright-core (PLAYWRIGHT_CORE).
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildVault } from './lib-latency-vault.mjs'
import { famdV1, inkDrawing, markdownNote, prng } from './bench-desktop/lib/fixture-formats.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const electron = path.join(root, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron')
const skip = (why) => { console.log(`no periodic stalls: skipped (${why})`); process.exit(0) }
if (process.env.FANOTES_SKIP_BROWSER === '1') skip('FANOTES_SKIP_BROWSER=1')
if (!spawnSync('sh', ['-c', 'command -v xvfb-run'], { encoding: 'utf8' }).stdout.trim()) skip('no xvfb-run')
if (!fs.existsSync(electron)) skip('no electron')
if (!fs.existsSync(path.join(root, 'dist', 'index.html'))) skip('no dist/ (run vite build)')
let playwright
try { playwright = await import(process.env.PLAYWRIGHT_CORE || 'playwright-core') } catch { skip('no playwright-core; set PLAYWRIGHT_CORE') }
const chromium = playwright.chromium ?? playwright.default.chromium

const report = process.env.FANOTES_STALLS_REPORT === '1'
const IDLE_S = Number(process.env.FANOTES_STALLS_IDLE_S || 40)
const USE_S = Number(process.env.FANOTES_STALLS_USE_S || 100)
// Generous: CI runners are slow and noisy. The owner saw ~2 s stalls; anything in this range is a regression.
const IDLE_MAX_MS = Number(process.env.FANOTES_STALLS_IDLE_MAX_MS || 250)
const USE_MAX_MS = Number(process.env.FANOTES_STALLS_USE_MAX_MS || 900)
const MAX_HEAP_GROWTH_MB = Number(process.env.FANOTES_STALLS_MAX_HEAP_GROWTH_MB || 14)
const MAX_RULE_GROWTH = Number(process.env.FANOTES_STALLS_MAX_RULE_GROWTH || 40)

const temporary = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'fanotes-stalls-'))
const home = path.join(temporary, 'home')
const configHome = path.join(temporary, 'config')
const runtime = path.join(temporary, 'runtime')
const vault = path.join(home, 'Notizen')
const userData = path.join(configHome, 'FaNotes')
for (const directory of [home, configHome, runtime, vault, userData]) fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
buildVault(vault, { notes: 300 })
{
  // One heavy ink note (~4 MB of stroke JSON): a document kept alive after the note is closed shows up as MB per open.
  const at = '2026-11-01T08:00:00.000Z'
  const ink = inkDrawing(prng(4242), 'famd-heavy', 'Schwer', 3000, at)
  fs.writeFileSync(path.join(vault, 'Handschrift', 'Schwer 3000.famd'), famdV1(markdownNote(prng(9), 'Schwer', 800), ink, at), { mode: 0o600 })
}
fs.writeFileSync(path.join(userData, 'config.json'), `${JSON.stringify({
  version: 3,
  vaultPath: vault,
  settings: { uiLanguage: 'de', autoCheckUpdates: false, autoDownloadUpdates: false, diagnosticsEnabled: true, diagnosticsCrashes: true, diagnosticsLogs: true, diagnosticsPerf: true, diagnosticsUsage: true, diagnosticsSettingsVersion: 1, diagnosticsNoticeSeen: true },
  onboarding: { version: 1, completed: true },
}, null, 2)}\n`, { mode: 0o600 })

const port = 20_100 + Math.floor(Math.random() * 90)
const child = spawn('xvfb-run', ['-a', '-s', '-screen 0 1440x1000x24', electron, root, `--remote-debugging-port=${port}`, '--no-sandbox'], {
  env: { ...process.env, HOME: home, XDG_CONFIG_HOME: configHome, XDG_RUNTIME_DIR: runtime },
  stdio: ['ignore', 'pipe', 'pipe'],
  detached: true,
})
let output = ''
child.stdout.on('data', (chunk) => { output += chunk })
child.stderr.on('data', (chunk) => { output += chunk })
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const cleanup = () => { try { process.kill(-child.pid, 'SIGKILL') } catch { /* gone */ } fs.rmSync(temporary, { recursive: true, force: true }) }
const fail = (message) => { console.error(`${message}\nelectron output (tail):\n${output.slice(-1200)}`); cleanup(); process.exit(1) }
const watchdog = setTimeout(() => fail('watchdog: check did not finish in time'), (IDLE_S + USE_S) * 1000 + 4 * 60_000)

let browser = null
for (let attempt = 0; attempt < 90 && !browser; attempt += 1) {
  try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`) } catch { await sleep(1000) }
}
if (!browser) fail('could not connect to Electron')
let page = null
for (let attempt = 0; attempt < 90 && !page; attempt += 1) {
  page = browser.contexts().flatMap((context) => context.pages()).find((candidate) => /index\.html|^file:|localhost/.test(candidate.url()) && !/ocr-host|recognition/.test(candidate.url())) ?? null
  if (!page) await sleep(1000)
}
if (!page) fail('no app window')
await page.waitForSelector('[role=treeitem]', { timeout: 90_000 }).catch(() => fail('file tree did not appear'))
await page.evaluate(() => {
  window.__stalls = []
  window.__phase = 'startup'
  new PerformanceObserver((list) => { for (const entry of list.getEntries()) window.__stalls.push({ phase: window.__phase, at: Math.round(entry.startTime), ms: Math.round(entry.duration) }) }).observe({ type: 'longtask' })
})
const cdp = await page.context().newCDPSession(page)
await cdp.send('HeapProfiler.enable')
const heapMb = async () => {
  await cdp.send('HeapProfiler.collectGarbage')
  return Math.round((await cdp.send('Runtime.getHeapUsage')).usedSize / 1048576)
}
const cssRules = () => page.evaluate(() => {
  let count = 0
  for (const sheet of document.styleSheets) { try { count += sheet.cssRules.length } catch { /* cross-origin sheet */ } }
  return count
})
const phase = (name) => page.evaluate((value) => { window.__phase = value }, name)
const tree = (text) => page.locator('[role=treeitem]', { hasText: text }).first()
const closeTab = () => page.locator('.note-tab-main[aria-current="true"] + .tab-close').first().click({ timeout: 3000 }).catch(() => {})
for (const folder of ['Ünï Fächer', 'Tagesnotizen', 'Gross', 'PDFs', 'Mathe', 'Inbox', 'Handschrift', 'Geschichte', 'Biologie']) {
  await tree(folder).click({ timeout: 8000 }).catch(() => {})
  await sleep(100)
}
const names = await page.evaluate(() => [...document.querySelectorAll('[role=treeitem]')].map((element) => element.textContent.trim()))
const notes = names.filter((text) => /^(Notiz|Nötiz)/.test(text))
const inkNotes = names.filter((text) => /^Hand \d/.test(text))
assert.ok(notes.length > 50 && inkNotes.length > 3, 'synthetic vault did not show up in the file tree')
await sleep(6000) // startup work (tree scan, index kick-off) is not part of the measurement

// --- idle with a note open ---------------------------------------------------
await tree(notes[3]).click({ timeout: 8000 })
await sleep(2500)
await phase('idle')
await sleep(IDLE_S * 1000)

// --- use loop ------------------------------------------------------------------
await phase('use')
const heap = []
const rules = []
let cycle = 0
const sample = async () => { heap.push(await heapMb()); rules.push(await cssRules()) }
const started = Date.now()
const warmCycles = 6
while (Date.now() - started < USE_S * 1000 || cycle < warmCycles + 6) {
  if (Date.now() - started > (USE_S + 120) * 1000) break
  try {
    const kind = cycle % 3
    if (kind === 0) {
      await tree(notes[(cycle * 7) % notes.length]).click({ timeout: 4000 })
      await sleep(500)
      await page.keyboard.type('hello world the quick brown fox ', { delay: 20 })
      await page.mouse.wheel(0, 600)
      await sleep(400)
    } else {
      await tree(kind === 1 ? 'Schwer 3000' : inkNotes[cycle % inkNotes.length]).click({ timeout: 4000 })
      await sleep(1500)
      const box = await page.locator('canvas').first().boundingBox().catch(() => null)
      if (box) {
        await page.mouse.move(box.x + 100, box.y + 100)
        await page.mouse.down()
        for (let step = 0; step < 30; step += 1) await page.mouse.move(box.x + 100 + step * 8, box.y + 100 + Math.sin(step / 3) * 30)
        await page.mouse.up()
      }
      await sleep(600)
    }
    await closeTab()
  } catch (error) { if (report) console.log(`step ${cycle}: ${String(error.message).split('\n')[0]}`) }
  cycle += 1
  if (cycle === warmCycles) await sample()
}
await sleep(1500)
await sample()
await phase('done')
// The anonymous stall statistics: a deliberate 700 ms task shows up as counts and durations only.
// (a timer task: code run by the debugger's evaluate is not a page task and is never reported)
await page.evaluate(() => new Promise((resolve) => setTimeout(() => { const end = performance.now() + 700; while (performance.now() < end) { /* busy */ } resolve(null) }, 0)))
await sleep(1500)
const preview = await page.evaluate(() => window.fanotes?.diagnostics?.preview?.().catch(() => null))
const reported = preview?.perf?.stalls
assert.ok(reported && reported.count >= 1 && reported.maxMs >= 600, `the stall statistics did not record a 700 ms task: ${JSON.stringify(preview?.perf)}`)
assert.deepEqual(Object.keys(reported).sort(), ['byPhase', 'count', 'mainLag', 'maxMs', 'p95Ms'])
const stalls = (await page.evaluate(() => window.__stalls.slice())).filter((entry) => entry.phase !== 'done')
clearTimeout(watchdog)
cleanup()

const idle = stalls.filter((entry) => entry.phase === 'idle')
const use = stalls.filter((entry) => entry.phase === 'use')
const worst = (list) => Math.max(0, ...list.map((entry) => entry.ms))
const minutes = (IDLE_S + USE_S) / 60
console.log(JSON.stringify({
  cycles: cycle,
  idleSeconds: IDLE_S,
  idleLongTasks: idle.length,
  idleWorstMs: worst(idle),
  useSeconds: USE_S,
  useLongTasks: use.length,
  useOver250: use.filter((entry) => entry.ms > 250).length,
  useWorstMs: worst(use),
  heapMb: heap,
  cssRules: rules,
  perTenMinutes: { stallsOver250: Math.round((stalls.filter((entry) => entry.ms > 250).length / minutes) * 10) },
}))
if (report) for (const entry of stalls.filter((candidate) => candidate.ms > 100)) console.log(`${entry.phase} +${Math.round(entry.at / 1000)} s  ${entry.ms} ms`)
clearTimeout(watchdog)
assert.ok(worst(idle) <= IDLE_MAX_MS, `a main-thread task of ${worst(idle)} ms while idle (limit ${IDLE_MAX_MS} ms): ${JSON.stringify(idle.filter((entry) => entry.ms > IDLE_MAX_MS))}`)
assert.ok(worst(use) <= USE_MAX_MS, `a main-thread task of ${worst(use)} ms while using the app (limit ${USE_MAX_MS} ms)`)
assert.ok(cycle > warmCycles + 3, `only ${cycle} use cycles ran`)
assert.ok(heap.at(-1) - heap[0] <= MAX_HEAP_GROWTH_MB, `JS heap kept growing while the same notes were opened and closed: ${heap.join(' -> ')} MB (limit +${MAX_HEAP_GROWTH_MB} MB)`)
assert.ok(rules.at(-1) - rules[0] <= MAX_RULE_GROWTH, `CSS rule count kept growing: ${rules.join(' -> ')} (limit +${MAX_RULE_GROWTH})`)
console.log('no periodic stalls: ok')
