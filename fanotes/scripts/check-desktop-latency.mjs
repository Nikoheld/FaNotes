// Desktop latency + memory check (QA-036, QA-032). Launches the built renderer in Electron under
// Xvfb with a temp profile and a synthetic vault (250 notes incl. Unicode names, a daily note,
// 5/40/250-page PDFs, a scanned PDF, .famd notes, a calendar with events), clicks through the
// slow spots and records main-thread long tasks per click, then opens many notes and rebuilds the
// search index while sampling the renderer heap.
//   node scripts/check-desktop-latency.mjs                 assert generous thresholds (skips without xvfb/dist/playwright)
//   FANOTES_LATENCY_REPORT=1                               print every click and the memory table
//   FANOTES_LATENCY_PROFILE=<dir>                          save a CPU profile for every click above 300 ms
//   FANOTES_LATENCY_HEAP=<dir>                             save heap snapshots (after warm-up, after opening notes, after rebuild)
// Needs `vite build` (dist/), xvfb-run and playwright-core (PLAYWRIGHT_CORE).
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildVault, UNICODE_NOTE, todayStem } from './lib-latency-vault.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const electron = path.join(root, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron')
const xvfb = spawnSync('sh', ['-c', 'command -v xvfb-run'], { encoding: 'utf8' }).stdout.trim()
const skip = (why) => { console.log(`desktop latency: skipped (${why})`); process.exit(0) }
if (process.env.FANOTES_SKIP_BROWSER === '1') skip('FANOTES_SKIP_BROWSER=1')
if (!xvfb) skip('no xvfb-run')
if (!fs.existsSync(electron)) skip('no electron')
if (!fs.existsSync(path.join(root, 'dist', 'index.html'))) skip('no dist/ (run vite build)')
let playwright
try { playwright = await import(process.env.PLAYWRIGHT_CORE || 'playwright-core') } catch { skip('no playwright-core; set PLAYWRIGHT_CORE') }
const chromium = playwright.chromium ?? playwright.default.chromium

const report = process.env.FANOTES_LATENCY_REPORT === '1'
const profileDir = process.env.FANOTES_LATENCY_PROFILE
const heapDir = process.env.FANOTES_LATENCY_HEAP
for (const dir of [profileDir, heapDir]) if (dir) fs.mkdirSync(dir, { recursive: true })
// Generous limits: CI runners are slow and noisy. The QA run saw 0.5-2.4 s on a fast laptop.
const MAX_CLICK_BLOCK_MS = Number(process.env.FANOTES_LATENCY_MAX_BLOCK_MS || 1200)
const MAX_HEAP_MB = Number(process.env.FANOTES_LATENCY_MAX_HEAP_MB || 700)
// CPU throttle in the renderer so a fast CI box behaves like the slower laptops of the QA run (1 = off).
const CPU_THROTTLE = Number(process.env.FANOTES_LATENCY_THROTTLE || 4)
const MAX_HEAP_GROWTH_MB = Number(process.env.FANOTES_LATENCY_MAX_HEAP_GROWTH_MB || 120)
const NOTES_TO_OPEN = Number(process.env.FANOTES_LATENCY_NOTES || 60)

const temporary = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'fanotes-latency-'))
const home = path.join(temporary, 'home')
const configHome = path.join(temporary, 'config')
const runtime = path.join(temporary, 'runtime')
const vault = path.join(home, 'Notizen')
const userData = path.join(configHome, 'FaNotes')
for (const directory of [home, configHome, runtime, vault, userData]) fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
buildVault(vault)
fs.writeFileSync(path.join(userData, 'config.json'), `${JSON.stringify({
  version: 3,
  vaultPath: vault,
  settings: { uiLanguage: 'de', autoCheckUpdates: false, autoDownloadUpdates: false },
  onboarding: { version: 1, completed: true },
}, null, 2)}\n`, { mode: 0o600 })

const port = 19_900 + Math.floor(Math.random() * 90)
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
const fail = (message) => { console.error(`${message}\nelectron output (tail):\n${output.slice(-1500)}`); cleanup(); process.exit(1) }
const watchdog = setTimeout(() => fail('watchdog: check did not finish in time'), Number(process.env.FANOTES_LATENCY_WATCHDOG_MS) || 8 * 60_000)

// Resident set of every renderer in the tree, in MB (all windows, including hidden ones).
const rendererRssMb = () => {
  const children = new Map()
  for (const name of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue
    try { children.set(Number(name), Number(fs.readFileSync(`/proc/${name}/stat`, 'utf8').split(')').pop().trim().split(' ')[1])) } catch { /* gone */ }
  }
  const tree = new Set([child.pid])
  for (let grew = true; grew;) { grew = false; for (const [pid, ppid] of children) if (tree.has(ppid) && !tree.has(pid)) { tree.add(pid); grew = true } }
  let total = 0
  const each = []
  for (const pid of tree) {
    try {
      if (!/--type=renderer/.test(fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8'))) continue
      const mb = Number(/VmRSS:\s*(\d+)/.exec(fs.readFileSync(`/proc/${pid}/status`, 'utf8'))?.[1] ?? 0) / 1024
      total += mb
      each.push(Math.round(mb))
    } catch { /* gone */ }
  }
  rendererRssMb.each = each.sort((a, b) => b - a)
  return Math.round(total)
}

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
  window.__long = []
  new PerformanceObserver((list) => { for (const entry of list.getEntries()) window.__long.push({ at: entry.startTime, ms: entry.duration }) }).observe({ type: 'longtask', buffered: false })
})
const cdp = await page.context().newCDPSession(page)
await cdp.send('Profiler.enable')
await cdp.send('HeapProfiler.enable')
await cdp.send('Performance.enable')
const metrics = async () => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map((metric) => [metric.name, metric.value]))
if (CPU_THROTTLE > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: CPU_THROTTLE })
await sleep(2500) // let startup work (tree scan, indexing kick-off) finish before measuring clicks

// Expand every folder (bottom-up so row positions above stay put).
for (const folder of ['Ünï Fächer', 'Tagesnotizen', 'Gross', 'PDFs', 'Mathe', 'Inbox', 'Handschrift', 'Geschichte', 'Biologie']) {
  await page.locator('[role=treeitem]', { hasText: folder }).first().click({ timeout: 8000 }).catch(() => {})
  await sleep(150)
}
if (report) console.log('tree rows after expanding:', await page.locator('[role=treeitem]').count())

const clicks = []
const act = async (name, run, settleMs = 1400) => {
  await sleep(250)
  await page.evaluate(() => { window.__long.length = 0 })
  const profiling = Boolean(profileDir)
  if (profiling) { await cdp.send('Profiler.setSamplingInterval', { interval: 500 }); await cdp.send('Profiler.start') }
  const metricsBefore = await metrics()
  const started = Date.now()
  let error = ''
  try { await run() } catch (caught) { error = String(caught.message ?? caught).split('\n')[0] }
  await sleep(settleMs)
  const long = await page.evaluate(() => window.__long.slice())
  const blockMs = Math.round(Math.max(0, ...long.map((entry) => entry.ms)))
  const totalMs = Math.round(long.reduce((sum, entry) => sum + entry.ms, 0))
  if (profiling) {
    const { profile } = await cdp.send('Profiler.stop')
    if (blockMs > 300) fs.writeFileSync(path.join(profileDir, `${String(clicks.length).padStart(2, '0')}-${name.replace(/[^\w]+/g, '_').slice(0, 50)}.cpuprofile`), JSON.stringify(profile))
  }
  const metricsAfter = await metrics()
  const spent = (key) => Math.round((metricsAfter[key] - metricsBefore[key]) * 1000)
  const parts = { scriptMs: spent('ScriptDuration'), layoutMs: spent('LayoutDuration'), styleMs: spent('RecalcStyleDuration') }
  clicks.push({ name, blockMs, totalMs, tasks: long.length, error, wall: Date.now() - started, ...parts })
  if (report) console.log(`${String(blockMs).padStart(5)} ms  total ${String(totalMs).padStart(5)}  tasks ${long.length}  js ${parts.scriptMs} layout ${parts.layoutMs} style ${parts.styleMs}  ${name}${error ? `  ERROR ${error}` : ''}`)
}

const tree = (text) => page.locator('[role=treeitem]', { hasText: text }).first()
const openTreeItem = (text) => async () => { await tree(text).click({ timeout: 8000 }) }
const closeTab = () => async () => { await page.locator('.note-tab-main[aria-current="true"] + .tab-close').first().click({ timeout: 8000 }) }
const ribbon = (label) => async () => { await page.locator(`button[aria-label="${label}"]`).first().click({ timeout: 8000 }) }

// --- QA-036: click latency ---------------------------------------------------
await act('open note: plain note', openTreeItem('Notiz 003'))
await act('open note: Unicode name', openTreeItem(UNICODE_NOTE))
await act('close tab: Unicode note', closeTab())
await act('Tools menu (expand)', ribbon('Zusätzliche Werkzeuge ausklappen'))
await act('open daily note', ribbon('Heutige Tagesnotiz öffnen'))
await act('Tools menu (collapse)', ribbon('Zusätzliche Werkzeuge einklappen'))
await act('close tab: daily note', closeTab())
for (const [label, name] of [['Klein 5 Seiten', 'PDF 5 pages'], ['Mittel 40 Seiten', 'PDF 40 pages'], ['Gross 250 Seiten', 'PDF 250 pages'], ['Gescannt', 'PDF scanned']]) {
  await act(`open ${name}`, openTreeItem(label), 2500)
  await act(`close ${name}`, closeTab())
}
await act('open note: 50,000 lines', openTreeItem('Lang 50000'), 2500)
await act('close note: 50,000 lines', closeTab())
await act('open .famd note', openTreeItem('Hand 3'), 2000)
await act('close .famd note', closeTab())
await act('open calendar', ribbon('Kalender öffnen'), 2000)
await act('calendar: add calendar', async () => {
  await page.locator('.cal-add input, form input[placeholder]').last().fill('Neuer Kalender').catch(() => {})
  await page.locator('button[aria-label="Kalender hinzufügen"]').click({ timeout: 8000 })
})
await act('close calendar', ribbon('Kalender öffnen'))
await act('open note for pen tools', openTreeItem('Notiz 005'))
await act('pen mode (Ctrl+D)', async () => { await page.keyboard.press('Control+d') }, 2500)
for (const title of ['Handschrift schreiben', 'Handschrift einrahmen', 'Lineal einblenden', 'Geodreieck einblenden', 'Radierer']) {
  await act(`pen tool: ${title}`, async () => { await page.locator(`[title^="${title}"]`).first().click({ timeout: 5000 }) })
}
await act('pen mode off (Ctrl+D)', async () => { await page.keyboard.press('Control+d') }, 1500)
await act('open Aufgaben', ribbon('Aufgaben: Hausaufgaben und Termine öffnen'), 2000)
await act('close Aufgaben', async () => { await page.locator('.homework-close').click({ timeout: 8000 }) })

// --- QA-032: memory ------------------------------------------------------------
const heapMb = async () => {
  await cdp.send('HeapProfiler.collectGarbage')
  const usage = await cdp.send('Runtime.getHeapUsage')
  return Math.round(usage.usedSize / 1048576)
}
const snapshot = async (name) => {
  if (!heapDir) return
  const chunks = []
  const onChunk = (event) => chunks.push(event.chunk)
  cdp.on('HeapProfiler.addHeapSnapshotChunk', onChunk)
  await cdp.send('HeapProfiler.takeHeapSnapshot', { reportProgress: false })
  cdp.off('HeapProfiler.addHeapSnapshotChunk', onChunk)
  fs.writeFileSync(path.join(heapDir, `${name}.heapsnapshot`), chunks.join(''))
}
const memory = []
const sample = async (label) => {
  const row = { label, heapMb: await heapMb(), rendererRssMb: rendererRssMb(), nodes: await page.evaluate(() => document.getElementsByTagName('*').length) }
  memory.push(row)
  if (report) console.log(`memory ${label.padEnd(28)} heap ${row.heapMb} MB  renderer RSS ${row.rendererRssMb} MB (${rendererRssMb.each.join('+')})  DOM ${row.nodes}`)
  return row
}
await sample('baseline')
await snapshot('1-baseline')
await tree('Lang 50000').click({ timeout: 8000 }).catch(() => {})
await sleep(2500)
await sample('50,000-line note open')
await page.locator('.note-tab-main[aria-current="true"] + .tab-close').first().click({ timeout: 4000 }).catch(() => {})
await sleep(800)
const noteNames = await page.evaluate(() => [...document.querySelectorAll("[role=treeitem]")].map((el) => el.textContent.trim()).filter((text) => /^(Notiz|Nötiz)/.test(text)))
let peakHeap = 0
for (let round = 0; round < 3; round += 1) {
  for (const label of ['Klein 5 Seiten', 'Mittel 40 Seiten', 'Gross 250 Seiten', 'Gescannt']) {
    await tree(label).click({ timeout: 8000 }).catch(() => {})
    await sleep(1200)
    await page.locator('.note-tab-main[aria-current="true"] + .tab-close').first().click({ timeout: 4000 }).catch(() => {})
    await sleep(300)
  }
}
await sleep(1500)
await sample('after 12 PDF open/close')
const samplePeak = setInterval(() => { cdp.send('Runtime.getHeapUsage').then((usage) => { peakHeap = Math.max(peakHeap, Math.round(usage.usedSize / 1048576)) }).catch(() => {}) }, 200)
let opened = 0
for (const text of noteNames.slice(0, NOTES_TO_OPEN)) {
  try { await tree(text).click({ timeout: 4000 }); opened += 1 } catch { /* row scrolled away */ }
  await sleep(120)
  if (opened % 10 === 0 && opened) await page.keyboard.press('Control+w').catch(() => {})
}
await sleep(1500)
await sample(`after opening ${opened} notes`)
await snapshot('2-after-notes')
// Full rebuild of the search index from the search panel.
await page.keyboard.press('Control+Shift+F').catch(() => {})
await sleep(600)
await page.locator('.doc-search-issues-toggle').first().click({ timeout: 3000 }).catch(() => {})
const rebuild = page.locator('button', { hasText: 'Index neu aufbauen' }).first()
if (await rebuild.count()) {
  await rebuild.click().catch(() => {})
  await sleep(Number(process.env.FANOTES_LATENCY_REBUILD_MS || 15_000))
} else if (report) console.log('rebuild button not found')
clearInterval(samplePeak)
await sample('after index rebuild')
await snapshot('3-after-rebuild')
if (report) console.log(`peak heap while opening notes + rebuild: ${peakHeap} MB`)

const heaviest = clicks.filter((click) => click.blockMs > MAX_CLICK_BLOCK_MS)
const summary = { clicks: clicks.length, worstClick: clicks.reduce((a, b) => (b.blockMs > a.blockMs ? b : a), clicks[0]), memory, peakHeap }
console.log(JSON.stringify({ ...summary, clicks: undefined, over: heaviest.map((click) => `${click.name} ${click.blockMs} ms`) }))
clearTimeout(watchdog)
cleanup()
assert.equal(clicks.filter((click) => click.error && !/ERROR_OK/.test(click.error)).length, 0, `clicks failed: ${clicks.filter((click) => click.error).map((click) => `${click.name}: ${click.error}`).join('; ')}`)
assert.deepEqual(heaviest.map((click) => `${click.name} ${click.blockMs} ms`), [], `clicks block the main thread for more than ${MAX_CLICK_BLOCK_MS} ms`)
const settled = memory.at(-1).heapMb
const startHeap = memory[0].heapMb
assert.ok(settled <= startHeap + MAX_HEAP_GROWTH_MB, `renderer heap grew from ${startHeap} MB to ${settled} MB after opening ${opened} notes, 12 PDFs and rebuilding the index (limit +${MAX_HEAP_GROWTH_MB} MB)`)
assert.ok(peakHeap <= MAX_HEAP_MB, `renderer heap peaked at ${peakHeap} MB (limit ${MAX_HEAP_MB} MB)`)
console.log('desktop latency: ok')
