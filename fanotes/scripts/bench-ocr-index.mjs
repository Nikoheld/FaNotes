// Benchmark of background document indexing in the real desktop app (Electron under Xvfb) on a
// synthetic vault: CPU seconds (all processes), wall time, busiest thread, cores used, peak RSS,
// main-thread long tasks. Optional second launch after a restart and after renaming scanned PDFs.
//   node scripts/bench-ocr-index.mjs --out /path/result.json [--scenario cold|restart|move] [--small]
// Needs a built renderer (`vite build`), xvfb-run, and PLAYWRIGHT_CORE (path to playwright-core).
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildOcrIndexVault } from './ocr-index-fixture.mjs'

const { chromium } = await import(process.env.PLAYWRIGHT_CORE || 'playwright-core')
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? (process.argv[i + 1] ?? true) : fallback }
const outFile = arg('out', null)
const small = process.argv.includes('--small')
const keep = process.argv.includes('--keep')
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const tmp = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'fanotes-bench-ocr-'))
const home = path.join(tmp, 'home')
const configHome = path.join(tmp, 'config')
const runtime = path.join(tmp, 'runtime')
const vault = path.join(home, 'Notizen')
const userData = path.join(configHome, 'FaNotes')
for (const d of [home, configHome, runtime, vault, userData]) fs.mkdirSync(d, { recursive: true, mode: 0o700 })
fs.writeFileSync(path.join(userData, 'config.json'), `${JSON.stringify({
  version: 3, vaultPath: vault,
  settings: { uiLanguage: 'de', autoCheckUpdates: false, autoDownloadUpdates: false, reduceMotion: true, ...JSON.parse(process.env.FANOTES_BENCH_SETTINGS || '{}') },
  onboarding: { version: 1, completed: true },
}, null, 2)}\n`, { mode: 0o600 })

const manifest = await buildOcrIndexVault(vault, process.argv.includes('--empty')
  ? { textPdfs: 0, scannedPdfs: 0, mixedPdfs: 0, copies: 0, inkNotes: 0 }
  : small
  ? { textPdfs: 2, scannedPdfs: 2, mixedPdfs: 1, copies: 1, inkNotes: 10, scanLines: 5 }
  : {})
const expectedDocs = manifest.pdfs.length + manifest.inkNotes
console.log(`vault: ${manifest.pdfs.length} PDFs (${manifest.scannedPages} scanned pages), ${manifest.inkNotes} ink notes`)

// ---- /proc sampling (benchmark tooling only; the app itself never polls) ----
const clk = 100
const readStat = (pid) => {
  try {
    const raw = fs.readFileSync(`/proc/${pid}/stat`, 'utf8')
    const rest = raw.slice(raw.lastIndexOf(')') + 2).split(' ')
    return { ppid: Number(rest[1]), utime: Number(rest[11]), stime: Number(rest[12]), cpu: Number(rest[36]), nice: Number(rest[16]) }
  } catch { return null }
}
const descendants = (rootPid) => {
  const all = new Map()
  for (const name of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue
    const stat = readStat(name)
    if (stat) all.set(Number(name), stat.ppid)
  }
  const out = new Set([rootPid])
  let grew = true
  while (grew) {
    grew = false
    for (const [pid, ppid] of all) if (!out.has(pid) && out.has(ppid)) { out.add(pid); grew = true }
  }
  return [...out]
}
const processKind = (pid) => { try { return /--type=([\w-]+)/.exec(fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8'))?.[1] ?? 'main' } catch { return '?' } }
const rssKb = (pid) => { try { return Number(/VmRSS:\s+(\d+)/.exec(fs.readFileSync(`/proc/${pid}/status`, 'utf8'))?.[1] ?? 0) } catch { return 0 } }
const findElectron = () => {
  for (const name of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue
    try {
      const cmd = fs.readFileSync(`/proc/${name}/cmdline`, 'utf8').split('\0')
      if (cmd[0]?.endsWith('/node_modules/electron/dist/electron') && cmd.includes(root) && !cmd.some((part) => part.startsWith('--type='))) return Number(name)
    } catch { /* gone */ }
  }
  return null
}

const launch = async (label) => {
  const port = 19_700 + Math.floor(Math.random() * 300)
  const executable = path.join(root, 'node_modules', 'electron', 'dist', 'electron')
  const child = spawn('xvfb-run', ['-a', '-s', '-screen 0 1440x900x24', executable, root, `--remote-debugging-port=${port}`, '--no-sandbox', ...(process.env.FANOTES_BENCH_ELECTRON_ARGS ? process.env.FANOTES_BENCH_ELECTRON_ARGS.split(' ') : [])], {
    env: { ...process.env, HOME: home, XDG_CONFIG_HOME: configHome, XDG_RUNTIME_DIR: runtime },
    stdio: ['ignore', 'pipe', 'pipe'], detached: true,
  })
  let output = ''
  child.stdout.on('data', (c) => { output += c })
  child.stderr.on('data', (c) => { output += c })
  let browser = null
  const deadline = Date.now() + 90_000
  while (Date.now() < deadline && !browser) {
    try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`) } catch { await sleep(250) }
    if (child.exitCode !== null) throw new Error(`Electron exited: ${output.slice(-400)}`)
  }
  let page = null
  while (!page && Date.now() < deadline) {
    page = browser.contexts().flatMap((c) => c.pages()).find((p) => !p.url().startsWith('devtools')) ?? null
    if (!page) await sleep(250)
  }
  await page.waitForFunction(() => Boolean(window.fanotes && document.querySelector('.file-tree__row')), null, { timeout: 90_000 })
  const pid = findElectron()
  return { child, browser, page, pid, label, output: () => output }
}

const idbSummary = (page) => page.evaluate(async () => {
  const names = (await indexedDB.databases()).map((d) => d.name).filter((n) => n?.startsWith('fanotes-doc-search-'))
  if (!names.length) return { docs: 0, partial: 0, units: 0, statuses: {} }
  const db = await new Promise((resolve, reject) => { const r = indexedDB.open(names[0]); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error) })
  try {
    const docs = await new Promise((resolve) => { const r = db.transaction('docs').objectStore('docs').getAll(); r.onsuccess = () => resolve(r.result) })
    const statuses = {}
    for (const doc of docs) statuses[doc.status] = (statuses[doc.status] ?? 0) + 1
    return { docs: docs.length, partial: statuses.partial ?? 0, statuses }
  } finally { db.close() }
})

const dumpIndex = (page) => page.evaluate(async () => {
  const names = (await indexedDB.databases()).map((d) => d.name).filter((n) => n?.startsWith('fanotes-doc-search-'))
  const db = await new Promise((resolve, reject) => { const r = indexedDB.open(names[0]); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error) })
  try {
    const units = await new Promise((resolve) => { const r = db.transaction('units').objectStore('units').getAll(); r.onsuccess = () => resolve(r.result) })
    const docs = await new Promise((resolve) => { const r = db.transaction('docs').objectStore('docs').getAll(); r.onsuccess = () => resolve(r.result) })
    return { units, docs }
  } finally { db.close() }
})

/** Runs one app session until every document is settled (or the time limit), sampling CPU. */
const session = async (label, { probe = false, limitMs = 1_800_000, settleMs = 8000 } = {}) => {
  const app = await launch(label)
  app.page.on('console', (m) => { if (m.text().startsWith('[ocr-debug]')) console.log(m.text()) })
  await app.page.evaluate(() => {
    window.__bench = { long: [], frames: 0, maxGap: 0, last: 0, events: [] }
    try { new PerformanceObserver((list) => { for (const e of list.getEntries()) window.__bench.long.push(e.duration) }).observe({ type: 'longtask', buffered: true }) } catch { /* unsupported */ }
    try { new PerformanceObserver((list) => { for (const e of list.getEntries()) window.__bench.events.push([e.name, e.processingStart - e.startTime, e.duration]) }).observe({ type: 'event', durationThreshold: 16, buffered: true }) } catch { /* unsupported */ }
  })
  const started = Date.now()
  const base = new Map()
  const last = new Map()
  let peakRss = 0
  const peakByProcess = new Map()
  let maxThreadShare = 0
  const busyThreads = new Set()
  const threadPrev = new Map()
  const threadTotal = new Map()
  let samples = 0
  let sumBusy = 0
  let lastSample = Date.now()
  const sample = () => {
    const now = Date.now()
    const dt = Math.max(1, now - lastSample) / 1000
    lastSample = now
    const pids = descendants(app.pid)
    let rss = 0
    for (const pid of pids) {
      const stat = readStat(pid)
      if (!stat) continue
      const total = stat.utime + stat.stime
      if (!base.has(pid)) base.set(pid, total)
      last.set(pid, total)
      const processRss = rssKb(pid)
      rss += processRss
      const seen = peakByProcess.get(pid) ?? { kind: processKind(pid), peakKb: 0 }
      seen.peakKb = Math.max(seen.peakKb, processRss)
      peakByProcess.set(pid, seen)
      try {
        for (const tid of fs.readdirSync(`/proc/${pid}/task`)) {
          const t = readStat(`${pid}/task/${tid}`)
          if (!t) continue
          const tt = t.utime + t.stime
          const key = `${pid}:${tid}`
          const prev = threadPrev.get(key)
          threadPrev.set(key, tt)
          threadTotal.set(key, { total: tt, name: (() => { try { return fs.readFileSync(`/proc/${pid}/task/${tid}/comm`, 'utf8').trim() } catch { return '?' } })() })
          if (prev === undefined) continue
          const share = (tt - prev) / clk / dt
          if (share > maxThreadShare) maxThreadShare = share
          if (share > 0.7) busyThreads.add(key)
        }
      } catch { /* exited */ }
    }
    peakRss = Math.max(peakRss, rss)
    samples += 1
    // busy cores right now = delta of total cpu
    return rss
  }
  sample()
  let prevTotal = 0
  const totalCpu = () => { let s = 0; for (const [pid, v] of last) s += v - (base.get(pid) ?? 0); return s / clk }
  let probeTimer = null
  if (probe) {
    probeTimer = setInterval(() => { app.page.keyboard.press('Shift').catch(() => {}) }, 5000)
  }
  let settledSince = 0
  let lastCpu = 0
  let ended = false
  const timeline = []
  while (Date.now() - started < limitMs) {
    sample()
    const summary = await idbSummary(app.page).catch(() => ({ docs: 0, partial: 0 }))
    const cpu = totalCpu()
    sumBusy += (cpu - prevTotal)
    timeline.push([Math.round((Date.now() - started) / 1000), Math.round(cpu * 10) / 10, summary.docs])
    prevTotal = cpu
    const idle = (cpu - lastCpu) < 0.15 * 2
    lastCpu = cpu
    if (summary.docs >= expectedDocs && summary.partial === 0 && !('pending' in summary && summary.pending)) {
      if (!settledSince) settledSince = Date.now()
      if (Date.now() - settledSince > settleMs && idle) { ended = true; break }
    } else settledSince = 0
    await sleep(2000)
  }
  const wallMs = Date.now() - started - (ended ? settleMs : 0)
  if (probeTimer) clearInterval(probeTimer)
  const bench = await app.page.evaluate(() => window.__bench)
  const index = await dumpIndex(app.page).catch(() => ({ units: [], docs: [] }))
  const cpuByProcess = []
  for (const [pid, v] of last) cpuByProcess.push([pid, Math.round(((v - (base.get(pid) ?? 0)) / clk) * 100) / 100])
  const long = bench?.long ?? []
  const delays = (bench?.events ?? []).map((e) => e[1]).sort((a, b) => a - b)
  const result = {
    label, settled: ended,
    cpuSeconds: Math.round(totalCpu() * 10) / 10,
    wallSeconds: Math.round(wallMs / 100) / 10,
    avgCores: Math.round((totalCpu() / Math.max(1, wallMs / 1000)) * 100) / 100,
    busiestThreadShare: Math.round(maxThreadShare * 100) / 100,
    threadsOver70pct: busyThreads.size,
    peakRssMb: Math.round(peakRss / 1024),
    peakProcessesMb: [...peakByProcess.values()].map((entry) => [entry.kind, Math.round(entry.peakKb / 1024)]).filter((entry) => entry[1] >= 60).sort((a, b) => b[1] - a[1]),
    longTasks: long.length, longTaskTotalMs: Math.round(long.reduce((a, b) => a + b, 0)), longTaskMaxMs: Math.round(Math.max(0, ...long)),
    inputDelayMsP95: delays.length ? Math.round(delays[Math.floor(delays.length * 0.95)]) : 0,
    inputDelayMsMax: delays.length ? Math.round(delays.at(-1)) : 0, inputEventsOver16ms: delays.length,
    docs: index.docs.length, units: index.units.length,
    ocrUnits: index.units.filter((u) => u.source === 'ocr').length,
    timeline: timeline.filter((_, i) => i % 5 === 0),
    topThreads: [...threadTotal.entries()].sort((a, b) => b[1].total - a[1].total).slice(0, 6).map(([k, v]) => [k, v.name, Math.round(v.total / clk * 10) / 10]),
    topProcesses: cpuByProcess.sort((a, b) => b[1] - a[1]).slice(0, 4),
  }
  await app.browser.close().catch(() => {})
  try { process.kill(-app.child.pid, 'SIGTERM') } catch { /* gone */ }
  await sleep(1500)
  return { result, index }
}

const scenario = arg('scenario', 'cold')
const out = { scenario, vault: { pdfs: manifest.pdfs.length, scannedPages: manifest.scannedPages, inkNotes: manifest.inkNotes }, runs: [] }
const probe = process.argv.includes('--probe')
const cold = await session('cold', { probe })
out.runs.push(cold.result)
console.log(JSON.stringify(cold.result))
const dump = (name, index) => {
  if (!outFile) return
  const normal = index.units.map((u) => ({ id: u.id, path: u.path, kind: u.kind, page: u.page ?? null, source: u.source, text: u.text })).sort((a, b) => (a.id < b.id ? -1 : 1))
  fs.writeFileSync(`${outFile}.${name}.units.json`, JSON.stringify(normal))
  fs.writeFileSync(`${outFile}.${name}.issues.json`, JSON.stringify(index.docs.filter((d) => d.issues.length || d.status !== 'indexed').map((d) => [d.path, d.status, d.issues])))
}
dump('cold', cold.index)
if (scenario === 'restart' || scenario === 'move') {
  if (scenario === 'move') {
    // Rename two scanned PDFs: same bytes, new path.
    fs.mkdirSync(path.join(vault, 'Archiv'), { recursive: true })
    for (const rel of manifest.scannedPaths.slice(0, 2)) fs.renameSync(path.join(vault, rel), path.join(vault, 'Archiv', path.basename(rel)))
  }
  const again = await session(scenario, { settleMs: 6000 })
  out.runs.push(again.result)
  console.log(JSON.stringify(again.result))
  dump(scenario, again.index)
}
if (outFile) fs.writeFileSync(outFile, JSON.stringify(out, null, 2))
if (!keep) fs.rmSync(tmp, { recursive: true, force: true })
console.log('done')
