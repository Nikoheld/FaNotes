// Battery check: the desktop app must not keep waking up while it is idle or hidden.
// Launches the built renderer in Electron (Xvfb) with a temp profile and a synthetic
// vault, instruments timers / rAF / IPC / MutationObserver in the page, and measures
// the CPU time of the whole process tree for several idle scenarios.
//   node scripts/check-idle-wakeups.mjs            assert thresholds (skips without xvfb/dist/playwright)
//   FANOTES_IDLE_SECONDS=60 FANOTES_IDLE_REPORT=1  print the full table (for before/after numbers)
// Needs a built renderer (`vite build`), xvfb-run and playwright-core (PLAYWRIGHT_CORE).
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const electron = path.join(root, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron')
const xvfb = spawnSync('sh', ['-c', 'command -v xvfb-run'], { encoding: 'utf8' }).stdout.trim()
const skip = (why) => { console.log(`idle wakeups: skipped (${why})`); process.exit(0) }
if (process.env.FANOTES_SKIP_BROWSER === '1') skip('FANOTES_SKIP_BROWSER=1')
if (!xvfb) skip('no xvfb-run')
if (!fs.existsSync(electron)) skip('no electron')
if (!fs.existsSync(path.join(root, 'dist', 'index.html'))) skip('no dist/ (run vite build)')
let playwright
try { playwright = await import(process.env.PLAYWRIGHT_CORE || 'playwright-core') } catch { skip('no playwright-core; set PLAYWRIGHT_CORE') }
const chromium = playwright.chromium ?? playwright.default.chromium

const seconds = Number(process.env.FANOTES_IDLE_SECONDS || 12)
const report = process.env.FANOTES_IDLE_REPORT === '1'
const temporary = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'fanotes-idle-'))
const home = path.join(temporary, 'home')
const configHome = path.join(temporary, 'config')
const runtime = path.join(temporary, 'runtime')
const vault = path.join(home, 'Notizen')
const userData = path.join(configHome, 'FaNotes')
for (const directory of [home, configHome, runtime, vault, userData, path.join(vault, 'Biologie')]) fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
fs.writeFileSync(path.join(vault, 'Biologie', 'Notiz.md'), '# Zelle\n\nSynthetic text note.\n\n- one\n- two\n')
const makePdf = () => {
  const text = 'BT /F1 24 Tf 40 60 Td (Seite 1) Tj ET'
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${text.length} >>\nstream\n${text}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ]
  let out = '%PDF-1.4\n'
  const offsets = []
  objects.forEach((body, index) => { offsets.push(out.length); out += `${index + 1} 0 obj\n${body}\nendobj\n` })
  const xref = out.length
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}`
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(out, 'latin1')
}
fs.writeFileSync(path.join(vault, 'Biologie', 'Blatt.pdf'), makePdf())
fs.writeFileSync(path.join(userData, 'config.json'), `${JSON.stringify({
  version: 3,
  vaultPath: vault,
  settings: { uiLanguage: 'de', autoCheckUpdates: false, autoDownloadUpdates: false },
  onboarding: { version: 1, completed: true },
}, null, 2)}\n`, { mode: 0o600 })

// Page instrumentation: counts what the renderer schedules, grouped by callback source.
const probe = () => {
  const stats = { raf: new Map(), interval: new Map(), timeout: new Map(), mutations: 0, ipc: 0 }
  const label = (fn) => { try { return String(fn).replace(/\s+/g, ' ').slice(0, 90) } catch { return '?' } }
  const bump = (map, fn) => { const key = label(fn); map.set(key, (map.get(key) || 0) + 1) }
  const raf = window.requestAnimationFrame.bind(window)
  window.requestAnimationFrame = (fn) => raf((t) => { bump(stats.raf, fn); return fn(t) })
  const si = window.setInterval.bind(window)
  window.setInterval = (fn, ms, ...rest) => si((...a) => { bump(stats.interval, fn); return typeof fn === 'function' ? fn(...a) : undefined }, ms, ...rest)
  const st = window.setTimeout.bind(window)
  window.setTimeout = (fn, ms, ...rest) => {
    if (typeof fn !== 'function') return st(fn, ms, ...rest)
    const origin = /\[native code\]/.test(String(fn)) ? (new Error().stack || '').split('\n').slice(2, 4).map((line) => line.trim().replace(/^at /, '').slice(-70)).join(' < ') : ''
    return st((...a) => { bump(stats.timeout, origin ? { toString: () => `native from ${origin}` } : fn); return fn(...a) }, ms, ...rest)
  }
  new MutationObserver((records) => { stats.mutations += records.length }).observe(document, { subtree: true, childList: true, attributes: true, characterData: true })
  window.__idleStats = stats
  window.__idleSnapshot = () => ({
    raf: Object.fromEntries(stats.raf), interval: Object.fromEntries(stats.interval), timeout: Object.fromEntries(stats.timeout), mutations: stats.mutations,
    animations: document.getAnimations().filter((a) => a.playState === 'running').length,
    animationNames: document.getAnimations().filter((a) => a.playState === 'running').map((a) => `${a.animationName || a.transitionProperty || 'js'} on ${(a.effect?.target?.className?.baseVal ?? a.effect?.target?.className ?? a.effect?.target?.tagName ?? '').toString().slice(0, 60)}`),
  })
  window.__idleReset = () => { stats.raf.clear(); stats.interval.clear(); stats.timeout.clear(); stats.mutations = 0 }
}

const port = 19_700 + Math.floor(Math.random() * 200)
const child = spawn('xvfb-run', ['-a', '-s', '-screen 0 1440x1000x24', electron, root, `--remote-debugging-port=${port}`, '--no-sandbox'], {
  env: { ...process.env, HOME: home, XDG_CONFIG_HOME: configHome, XDG_RUNTIME_DIR: runtime },
  stdio: ['ignore', 'pipe', 'pipe'],
  detached: true,
})
let output = ''
child.stdout.on('data', (chunk) => { output += chunk })
child.stderr.on('data', (chunk) => { output += chunk })

// CPU seconds of every process below the launcher (browser, renderer, GPU, utility).
const treePids = () => {
  const children = new Map()
  for (const name of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue
    try {
      const stat = fs.readFileSync(`/proc/${name}/stat`, 'utf8')
      const ppid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1])
      children.set(Number(name), ppid)
    } catch { /* gone */ }
  }
  const out = new Set([child.pid])
  for (let grew = true; grew;) {
    grew = false
    for (const [pid, ppid] of children) if (out.has(ppid) && !out.has(pid)) { out.add(pid); grew = true }
  }
  return [...out]
}
const processInfo = () => {
  const info = new Map()
  for (const pid of treePids()) {
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8')
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
      const cmd = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8')
      const type = /--type=([\w-]+)/.exec(cmd)?.[1] ?? (/electron/.test(cmd) && !/xvfb|Xvfb/i.test(cmd.split('\0')[0]) ? 'browser' : 'other')
      const ctx = /--(?:renderer|utility)-sub-type=([\w.]+)/.exec(cmd)?.[1] ?? ''
      let wake = 0
      try { const status = fs.readFileSync(`/proc/${pid}/status`, 'utf8'); wake = Number(/voluntary_ctxt_switches:\s*(\d+)/.exec(status)?.[1] ?? 0) } catch { /* ignore */ }
      info.set(pid, { type: ctx ? `${type}:${ctx}` : type, ticks: Number(fields[11]) + Number(fields[12]), wake })
    } catch { /* gone */ }
  }
  return info
}
const threadTicks = () => {
  const out = {}
  for (const pid of treePids()) {
    let kind = ''
    try { kind = /--type=([\w-]+)/.exec(fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8'))?.[1] ?? 'browser' } catch { continue }
    try {
      for (const tid of fs.readdirSync(`/proc/${pid}/task`)) {
        const stat = fs.readFileSync(`/proc/${pid}/task/${tid}/stat`, 'utf8')
        const comm = stat.slice(stat.indexOf('(') + 1, stat.lastIndexOf(')'))
        const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
        const key = `${kind}/${comm}`
        out[key] = (out[key] || 0) + Number(fields[11]) + Number(fields[12])
      }
    } catch { /* gone */ }
  }
  return out
}
const clockTicks = Number(spawnSync('getconf', ['CLK_TCK'], { encoding: 'utf8' }).stdout) || 100

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const measure = async (page, name) => {
  await page.evaluate(() => window.__idleReset())
  const before = processInfo()
  const threadsBefore = threadTicks()
  const started = Date.now()
  await sleep(seconds * 1000)
  const elapsed = (Date.now() - started) / 1000
  const after = processInfo()
  const threadsAfter = threadTicks()
  const snap = await page.evaluate(() => window.__idleSnapshot())
  const byType = {}
  let wakeups = 0
  for (const [pid, now] of after) {
    const was = before.get(pid)
    if (!was) continue
    const cpu = ((now.ticks - was.ticks) / clockTicks / elapsed) * 100
    byType[now.type] = (byType[now.type] || 0) + cpu
    wakeups += Math.max(0, now.wake - was.wake)
  }
  const sum = (obj) => Object.values(obj).reduce((a, b) => a + b, 0)
  const result = {
    name,
    cpuPercent: Number(Object.values(byType).reduce((a, b) => a + b, 0).toFixed(2)),
    rendererCpu: Number((Object.entries(byType).filter(([k]) => k.startsWith('renderer')).reduce((a, [, v]) => a + v, 0)).toFixed(2)),
    byType: Object.fromEntries(Object.entries(byType).map(([k, v]) => [k, Number(v.toFixed(2))])),
    wakeupsPerMin: Math.round((wakeups / elapsed) * 60),
    rafPerMin: Math.round((sum(snap.raf) / elapsed) * 60),
    intervalPerMin: Math.round((sum(snap.interval) / elapsed) * 60),
    timeoutPerMin: Math.round((sum(snap.timeout) / elapsed) * 60),
    domMutationsPerMin: Math.round((snap.mutations / elapsed) * 60),
    runningAnimations: snap.animations,
    animationNames: snap.animationNames,
    threads: Object.fromEntries(Object.entries(threadsAfter).map(([k, v]) => [k, Number((((v - (threadsBefore[k] || 0)) / clockTicks / elapsed) * 100).toFixed(2))]).filter(([, v]) => v >= 0.1).sort((a, b) => b[1] - a[1]).slice(0, 8)),
    top: { raf: snap.raf, interval: snap.interval, timeout: snap.timeout },
  }
  return result
}

const results = []
let browser = null
try {
  const deadline = Date.now() + 60_000
  while (!browser && Date.now() < deadline) {
    try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`) } catch { await sleep(250) }
    if (child.exitCode !== null) throw new Error(`Electron exited: ${output.slice(-400)}`)
  }
  assert.ok(browser, 'Electron did not open a debugging port')
  let page = null
  for (let tries = 0; tries < 120 && !page; tries += 1) {
    page = browser.contexts().flatMap((context) => context.pages()).find((candidate) => !candidate.url().startsWith('devtools')) ?? null
    if (!page) await sleep(250)
  }
  assert.ok(page, 'no renderer page')
  await page.addInitScript(probe)
  await page.reload({ waitUntil: 'commit', timeout: 60_000 })
  await page.waitForFunction(() => Boolean(window.fanotes && document.querySelector('.file-tree__row')), null, { timeout: 60_000 })
  await sleep(15_000) // let startup work finish
  const cdp = await page.context().newCDPSession(page)

  results.push(await measure(page, 'idle (start view)'))

  const openRow = async (text) => {
    const row = page.locator('.file-tree__row', { hasText: text }).first()
    for (let attempt = 0; attempt < 3 && !(await row.isVisible().catch(() => false)); attempt += 1) {
      await page.locator('.file-tree__row[data-kind="folder"]', { hasText: 'Biologie' }).first().click()
      await row.waitFor({ state: 'visible', timeout: 4000 }).catch(() => {})
    }
    await row.click()
  }
  await openRow('Notiz')
  await page.waitForSelector('.cm-editor, .note-editor, .markdown-editor', { timeout: 20_000 }).catch(() => {})
  await sleep(2500)
  results.push(await measure(page, 'idle with a note open'))

  await openRow('Blatt')
  await page.waitForFunction(() => [...document.querySelectorAll('[data-pdf-page="1"] canvas')].some((canvas) => canvas.width > 0), null, { timeout: 60_000 })
  await sleep(8000) // pdf.js, thumbnails and indexing settle
  if (process.env.FANOTES_IDLE_PROFILE === '1') await cdp.send('Profiler.enable').then(() => cdp.send('Profiler.start'))
  results.push(await measure(page, 'idle with a PDF open'))
  if (process.env.FANOTES_IDLE_REPEAT_PDF === '1') { results.push(await measure(page, 'PDF again')); results.push(await measure(page, 'PDF again 2')) }
  if (process.env.FANOTES_IDLE_PROFILE === '1') {
    const { profile } = await cdp.send('Profiler.stop')
    const self = new Map()
    const dt = profile.timeDeltas
    const byId = new Map(profile.nodes.map((node) => [node.id, node]))
    profile.samples.forEach((id, index) => {
      const f = byId.get(id).callFrame
      const key = `${f.functionName || '(anon)'} ${f.url.split('/').pop()}:${f.lineNumber}`
      self.set(key, (self.get(key) || 0) + (dt[index] || 0))
    })
    console.log('PROFILE (self ms)', JSON.stringify([...self].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([k, v]) => [k, Math.round(v / 1000)])))
  }

  // Window hidden: Electron's CDP cannot minimise the window, so the page is told it is hidden the
  // way Chromium does (visibilityState + visibilitychange). Chromium's own timer throttling is not
  // simulated; this checks that the app itself stops scheduling frame work.
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' })
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true })
    document.dispatchEvent(new Event('visibilitychange'))
  })
  await sleep(1000)
  const hiddenResult = await measure(page, 'window hidden (simulated visibilitychange)')
  hiddenResult.hidden = true
  results.push(hiddenResult)
} finally {
  await browser?.close().catch(() => {})
  try { process.kill(-child.pid, 'SIGTERM') } catch { /* gone */ }
  await sleep(800)
  fs.rmSync(temporary, { recursive: true, force: true })
}

for (const r of results) {
  console.log(`${r.name}: cpu ${r.cpuPercent}% (renderer ${r.rendererCpu}%), process wakeups/min ${r.wakeupsPerMin}, rAF/min ${r.rafPerMin}, interval/min ${r.intervalPerMin}, timeout/min ${r.timeoutPerMin}, DOM mutations/min ${r.domMutationsPerMin}, running CSS animations ${r.runningAnimations}`)
  if (report) console.log(JSON.stringify({ byType: r.byType, animations: r.animationNames, threads: r.threads, top: r.top }, null, 1).slice(0, 4000))
}

// Thresholds: generous for CI noise, strict about the things that burn battery.
for (const r of results) {
  const hidden = r.name.startsWith('window hidden')
  assert.ok(r.rafPerMin <= 60, `${r.name}: ${r.rafPerMin} rAF callbacks/min while idle`)
  assert.equal(r.runningAnimations, 0, `${r.name}: ${r.runningAnimations} CSS/JS animations still running while idle (${r.animationNames.join(', ')})`)
  if (hidden) {
    assert.equal(r.rafPerMin, 0, `${r.name}: rAF must not run while the window is hidden`)
  }
  assert.ok(r.intervalPerMin <= 120, `${r.name}: ${r.intervalPerMin} setInterval ticks/min while idle`)
}
console.log('idle wakeups: ok')
