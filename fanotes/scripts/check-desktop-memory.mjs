// QA-032: memory of the hidden OCR host (the second renderer that appears while scanned pages are indexed).
// Launches the built renderer in Electron under Xvfb with a temp profile and a small synthetic vault with
// scanned PDFs, lets the background index read them, and samples the resident set of every process:
//   - the OCR host (found by its --fanotes-ocr-workers argument) stays under a generous ceiling;
//   - the whole process tree stays under a generous ceiling;
//   - the host is closed again soon after its last line (the indexing keep-alive is capped at 30 s, the
//     interactive keep-alive of 120 s used to keep ~1 GB resident for two minutes after every pass);
//   - the main window's renderer does not grow while the host works (no model copy in the UI process).
//   node scripts/check-desktop-memory.mjs          (skips without xvfb, dist/, playwright, or the OCR model)
//   FANOTES_MEMORY_REPORT=1                        print the numbers
// Needs `vite build` (dist/), xvfb-run and playwright-core (PLAYWRIGHT_CORE).
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildOcrIndexVault } from './ocr-index-fixture.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const electron = path.join(root, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron')
const skip = (why) => { console.log(`desktop memory: skipped (${why})`); process.exit(0) }
if (process.env.FANOTES_SKIP_BROWSER === '1') skip('FANOTES_SKIP_BROWSER=1')
if (process.platform !== 'linux') skip('needs /proc (Linux)')
if (!spawnSync('sh', ['-c', 'command -v xvfb-run'], { encoding: 'utf8' }).stdout.trim()) skip('no xvfb-run')
if (!fs.existsSync(electron)) skip('no electron')
if (!fs.existsSync(path.join(root, 'dist', 'index.html'))) skip('no dist/ (run vite build)')
if (!fs.existsSync(path.join(root, 'dist', 'ocr', 'fanotes-trocr', 'onnx', 'encoder_model.onnx'))) skip('no OCR model in dist/ocr')
let playwright
try { playwright = await import(process.env.PLAYWRIGHT_CORE || 'playwright-core') } catch { skip('no playwright-core; set PLAYWRIGHT_CORE') }
const chromium = playwright.chromium ?? playwright.default.chromium

const report = process.env.FANOTES_MEMORY_REPORT === '1'
const MAX_HOST_MB = Number(process.env.FANOTES_MEMORY_MAX_HOST_MB || 1500)
const MAX_TREE_MB = Number(process.env.FANOTES_MEMORY_MAX_TREE_MB || 3300)
const MAX_WINDOW_GROWTH_MB = Number(process.env.FANOTES_MEMORY_MAX_WINDOW_GROWTH_MB || 400)
const MAX_HOST_LINGER_S = Number(process.env.FANOTES_MEMORY_MAX_LINGER_S || 75)
const clock = Number(spawnSync('getconf', ['CLK_TCK'], { encoding: 'utf8' }).stdout) || 100

const temporary = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'fanotes-memory-'))
const home = path.join(temporary, 'home')
const configHome = path.join(temporary, 'config')
const runtime = path.join(temporary, 'runtime')
const vault = path.join(home, 'Notizen')
const userData = path.join(configHome, 'FaNotes')
for (const directory of [home, configHome, runtime, vault, userData]) fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
const manifest = await buildOcrIndexVault(vault, { textPdfs: 2, scannedPdfs: 2, mixedPdfs: 1, copies: 0, inkNotes: 10, scanLines: 5 })
fs.writeFileSync(path.join(userData, 'config.json'), `${JSON.stringify({
  version: 3,
  vaultPath: vault,
  settings: { uiLanguage: 'de', autoCheckUpdates: false, autoDownloadUpdates: false, reduceMotion: true },
  onboarding: { version: 1, completed: true },
}, null, 2)}\n`, { mode: 0o600 })

const port = 19_800 + Math.floor(Math.random() * 90)
const child = spawn('xvfb-run', ['-a', '-s', '-screen 0 1440x900x24', electron, root, `--remote-debugging-port=${port}`, '--no-sandbox'], {
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
const watchdog = setTimeout(() => fail('watchdog: check did not finish in time'), Number(process.env.FANOTES_MEMORY_WATCHDOG_MS) || 7 * 60_000)

const processes = () => {
  const parents = new Map()
  for (const name of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue
    try { parents.set(Number(name), Number(fs.readFileSync(`/proc/${name}/stat`, 'utf8').split(')').pop().trim().split(' ')[1])) } catch { /* gone */ }
  }
  const tree = new Set([child.pid])
  for (let grew = true; grew;) { grew = false; for (const [pid, ppid] of parents) if (tree.has(ppid) && !tree.has(pid)) { tree.add(pid); grew = true } }
  const found = []
  for (const pid of tree) {
    try {
      const cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8')
      const status = fs.readFileSync(`/proc/${pid}/status`, 'utf8')
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8').split(')').pop().trim().split(' ')
      found.push({
        pid,
        kind: /--type=([\w-]+)/.exec(cmdline)?.[1] ?? 'main',
        host: cmdline.includes('--fanotes-ocr-workers'),
        mb: Number(/VmRSS:\s*(\d+)/.exec(status)?.[1] ?? 0) / 1024,
        cpu: (Number(stat[11]) + Number(stat[12])) / clock,
      })
    } catch { /* gone */ }
  }
  return found
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

const started = Date.now()
const seconds = () => Math.round((Date.now() - started) / 1000)
let peakHost = 0
let peakTree = 0
let windowBefore = 0
let windowPeak = 0
let hostSeenAt = null
let hostGoneAt = null
let lastBusyAt = null
let previousCpu = 0
const LIMIT_MS = Number(process.env.FANOTES_MEMORY_LIMIT_MS) || 5 * 60_000
while (Date.now() - started < LIMIT_MS) {
  const all = processes()
  const host = all.find((entry) => entry.host)
  const window = all.filter((entry) => entry.kind === 'renderer' && !entry.host).sort((a, b) => b.mb - a.mb)[0]
  peakTree = Math.max(peakTree, all.reduce((sum, entry) => sum + entry.mb, 0))
  if (window) { if (!hostSeenAt) windowBefore = Math.max(windowBefore, window.mb); windowPeak = Math.max(windowPeak, window.mb) }
  if (host) {
    if (!hostSeenAt) hostSeenAt = seconds()
    peakHost = Math.max(peakHost, host.mb)
    if (host.cpu - previousCpu > 0.3) lastBusyAt = seconds()
    previousCpu = host.cpu
  } else if (hostSeenAt && !hostGoneAt) {
    hostGoneAt = seconds()
    break
  }
  await sleep(1000)
}
clearTimeout(watchdog)
cleanup()
const linger = hostGoneAt !== null && lastBusyAt !== null ? hostGoneAt - lastBusyAt : null
const numbers = {
  scannedPages: manifest.scannedPages,
  hostSeenAtS: hostSeenAt,
  hostGoneAtS: hostGoneAt,
  hostLingerAfterLastOcrS: linger,
  peakHostMb: Math.round(peakHost),
  peakTreeMb: Math.round(peakTree),
  windowRendererMb: `${Math.round(windowBefore)} -> ${Math.round(windowPeak)}`,
}
if (report) console.log(JSON.stringify(numbers))
assert.ok(hostSeenAt !== null, 'the OCR host started (scanned pages need OCR)')
assert.ok(peakHost <= MAX_HOST_MB, `OCR host peaked at ${Math.round(peakHost)} MB (limit ${MAX_HOST_MB} MB)`)
assert.ok(peakTree <= MAX_TREE_MB, `process tree peaked at ${Math.round(peakTree)} MB (limit ${MAX_TREE_MB} MB)`)
assert.ok(windowPeak - windowBefore <= MAX_WINDOW_GROWTH_MB, `window renderer grew by ${Math.round(windowPeak - windowBefore)} MB while OCR ran (limit ${MAX_WINDOW_GROWTH_MB} MB)`)
assert.ok(hostGoneAt !== null, `the OCR host was still running ${Math.round(LIMIT_MS / 1000)} s into the check`)
assert.ok(linger !== null && linger <= MAX_HOST_LINGER_S, `the OCR host stayed ${linger} s after its last line (limit ${MAX_HOST_LINGER_S} s)`)
console.log(`desktop memory: ok (OCR host peak ${numbers.peakHostMb} MB, closed ${linger} s after its last line, tree peak ${numbers.peakTreeMb} MB)`)
