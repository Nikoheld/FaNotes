#!/usr/bin/env node
// Desktop startup benchmark (Electron under xvfb, temp profile, copy of a fixture vault).
//
//   node scripts/measure-startup.mjs --vault <fixture dir> [--runs 5] [--label x] [--xvfb] [--cpus 0,1]
//                                    [--packaged <path to unpacked app binary>] [--resources]
//
// Phases, in ms after spawn: target (CDP page target exists), fcp (first contentful paint),
// ribbon (navigation toolbar), tree (first vault entries in the sidebar), editor (last note's
// CodeMirror content). Prints one JSON line per run and a median row.
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { connectCdp } from './bench-desktop/lib/drivers.mjs'

const args = Object.fromEntries(process.argv.slice(2).flatMap((value, index, values) => (value.startsWith('--') ? [[value.slice(2), (values[index + 1] ?? '--').startsWith('--') ? 'true' : values[index + 1]]] : [])))
const root = path.resolve(args.root || path.join(path.dirname(fileURLToPath(import.meta.url)), '..'))
const fixture = path.resolve(args.vault || '')
if (!args.vault) throw new Error('--vault <dir> is required')
const runs = Number(args.runs) || 5
const LAST_NOTE = args.note || 'Start/Letzte Notiz.md'
const electron = args.packaged ? path.resolve(args.packaged) : path.join(root, 'node_modules', 'electron', 'dist', 'electron')
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const median = (values) => { const sorted = [...values].sort((a, b) => a - b); return sorted[Math.floor(sorted.length / 2)] }

const PROBE = `(() => {
  const fcp = performance.getEntriesByName('first-contentful-paint')[0]
  return {
    fcp: fcp ? Math.round(performance.timeOrigin + fcp.startTime) : null,
    paint: JSON.stringify(performance.getEntriesByType('paint')),
    ribbon: Boolean(document.querySelector('.ribbon button')),
    tree: document.querySelectorAll('.file-tree__entry-button').length > 3,
    editor: Boolean(document.querySelector('.markdown-editor .cm-content')?.textContent.length > 20),
  }
})()`

// Total CPU seconds (user+system) consumed so far by every process below `pid`: load-independent.
function treeCpuMs(pid, breakdown) {
  const rows = new Map()
  for (const name of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue
    try {
      const stat = fs.readFileSync(`/proc/${name}/stat`, 'utf8')
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
      let kind = ''
      if (breakdown) { const cmd = fs.readFileSync(`/proc/${name}/cmdline`, 'utf8'); kind = /--type=(\w[\w-]*)/.exec(cmd)?.[1] || (/Xvfb|xvfb/.test(cmd) ? 'xvfb' : 'browser') }
      rows.set(Number(name), { ppid: Number(fields[1]), ticks: Number(fields[11]) + Number(fields[12]), kind })
    } catch { /* process ended */ }
  }
  let total = 0
  const walk = (id) => { const row = rows.get(id); if (row) { total += row.ticks; if (breakdown) breakdown[row.kind] = (breakdown[row.kind] || 0) + row.ticks * 10 } for (const [child, other] of rows) if (other.ppid === id) walk(child) }
  walk(pid)
  return Math.round(total * 1000 / 100)
}

async function once(index, reuse) {
  const work = reuse?.work ?? fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'fanotes-start-'))
  const home = path.join(work, 'home')
  const config = path.join(work, 'config', 'FaNotes')
  const vault = path.join(home, 'Notizen')
  if (!reuse?.reuse) {
    for (const dir of [home, config, path.join(work, 'data'), path.join(work, 'cache'), path.join(work, 'runtime')]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    fs.cpSync(fixture, vault, { recursive: true, preserveTimestamps: true })
    fs.writeFileSync(path.join(config, 'config.json'), JSON.stringify({ version: 3, vaultPath: vault, settings: { uiLanguage: args.lang || 'en', autoCheckUpdates: false, autoDownloadUpdates: false, lastOpenNotePath: LAST_NOTE }, onboarding: { version: 1, completed: true } }))
  }
  const port = 20_000 + Math.floor(Math.random() * 20_000)
  const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(work, 'config'), XDG_DATA_HOME: path.join(work, 'data'), XDG_CACHE_HOME: path.join(work, 'cache'), XDG_RUNTIME_DIR: path.join(work, 'runtime'), NO_AT_BRIDGE: '1' }
  const argv = [...(args.packaged ? [] : ['.']), `--remote-debugging-port=${port}`, '--no-sandbox', '--disable-gpu', '--ozone-platform=x11']
  const inner = args.cpus ? ['taskset', '-c', args.cpus, electron, ...argv] : [electron, ...argv]
  const command = args.xvfb ? 'xvfb-run' : inner[0]
  const commandArgs = args.xvfb ? ['-a', '-s', '-screen 0 1920x1080x24', ...inner] : inner.slice(1)
  const t0 = performance.now()
  const wall0 = Date.now()
  const child = spawn(command, commandArgs, { cwd: root, env, stdio: ['ignore', 'ignore', 'pipe'], detached: true })
  let stderr = ''
  child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-3000) })
  const result = { run: index }
  let driver
  try {
    try { driver = await connectCdp(port, { alive: () => child.exitCode === null }) } catch (error) { throw new Error(`${error.message}: ${stderr.slice(-600)}`) }
    result.target = Math.round(performance.now() - t0)
    if (args.rprof) { await driver.send('Profiler.enable'); await driver.send('Profiler.setSamplingInterval', { interval: 300 }); await driver.send('Profiler.start') }
    const traceEvents = []
    if (args.trace) {
      driver.onMessage((message) => { if (message.method === 'Tracing.dataCollected') traceEvents.push(...message.params.value) })
      await driver.send('Tracing.start', { traceConfig: { includedCategories: ['devtools.timeline', 'v8', 'blink.user_timing', 'loading', 'disabled-by-default-devtools.timeline'] }, transferMode: 'ReportEvents' })
    }
    const deadline = performance.now() + 90_000
    while (performance.now() < deadline && !(result.ribbon && result.tree && result.editor)) {
      let probe
      try { probe = await driver.evaluate(PROBE) } catch { await wait(20); continue }
      const now = Math.round(performance.now() - t0)
      if (probe.fcp && result.fcp === undefined) result.fcp = probe.fcp - wall0; 
      for (const key of ['ribbon', 'tree', 'editor']) if (probe[key] && result[key] === undefined) result[key] = now
      await wait(10)
    }
    const breakdown = {}
    result.cpuMs = treeCpuMs(child.pid, breakdown)
    if (args.procs) result.procs = breakdown
    if (args.resources) {
      await wait(500)
      result.resources = await driver.evaluate(`JSON.stringify({ nav: Math.round(performance.timeOrigin - ${wall0}), res: performance.getEntriesByType('resource').map((e) => [Math.round(e.startTime), Math.round(e.responseEnd), Math.round(e.transferSize || e.encodedBodySize), e.name.replace(/.*\\//, '')]), marks: performance.getEntriesByType('mark').map((e) => [Math.round(e.startTime), e.name]) })`)
    }
    if (args.settle || reuse?.seed) await wait(reuse?.seed ? 4000 : Number(args.settle))
    if (args.rprof) fs.writeFileSync(path.resolve(args.rprof), JSON.stringify((await driver.send('Profiler.stop')).profile))
    if (args.trace) {
      const done = new Promise((resolve) => driver.onMessage((message) => { if (message.method === 'Tracing.tracingComplete') resolve() }))
      await driver.send('Tracing.end')
      await done
      fs.writeFileSync(path.resolve(args.trace), JSON.stringify(traceEvents))
    }
  } finally {
    const exited = () => new Promise((resolve) => { if (child.exitCode !== null || child.signalCode !== null) resolve(); else { child.once('exit', resolve); setTimeout(resolve, 8000) } })
    if (reuse?.seed) { void driver?.send('Browser.close').catch(() => {}); await exited() }
    try { driver?.close() } catch { /* closed */ }
    const killGroup = (signal) => { try { process.kill(-child.pid, signal) } catch { /* gone */ } }
    killGroup('SIGTERM')
    await exited()
    killGroup('SIGKILL')
    if (!reuse?.keep) { await wait(300); fs.rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }) }
  }
  if (result.editor === undefined) result.stderr = stderr.slice(-400)
  return result
}

const rows = []
for (let index = 0; index < runs; index += 1) {
  let row
  if (args.warm) {
    // Warm start: the same profile and vault for a first (unmeasured) launch that writes the caches, then the measured one.
    const work = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'fanotes-start-'))
    await once(index, { work, keep: true, seed: true }).catch(() => {})
    row = await once(index, { work, reuse: true })
    fs.rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  } else row = await once(index)
  rows.push(row)
  console.log(JSON.stringify(row))
}
const summary = { label: args.label || '', median: {} }
for (const key of ['target', 'ribbon', 'tree', 'editor', 'cpuMs']) summary.median[key] = median(rows.map((row) => row[key]).filter((v) => typeof v === 'number'))
console.log(JSON.stringify(summary))
