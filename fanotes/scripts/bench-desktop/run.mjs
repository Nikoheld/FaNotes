#!/usr/bin/env node
// Desktop benchmarks for one host: startup (cold, warm), memory, typing latency
// and large-document scrolling. Run inside fanotes-bench:1 under Xvfb (see
// run-in-container.sh); both hosts are driven the same way:
//   • the harness starts the app binary through fanotes-execstamp (CLOCK_MONOTONIC
//     at exec = "process start"),
//   • page control: CDP (Electron) or WebDriver attached to the running app (Tauri),
//     only to inject lib/page-agent.js and read its results,
//   • input: XTest key/mouse events from fanotes-xinject, for both,
//   • every time is taken in the page (performance.now) or from CLOCK_MONOTONIC;
//     page time is mapped to CLOCK_MONOTONIC with the smallest-RTT ping.
//
//   node run.mjs --host electron|tauri --app <binary> --fixture <vault> [--runs 5]
//                [--suites startup-cold,session] [--variant markdown|writing] [--keys 500]
//                [--out results/<host>.json]
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { connectCdp, connectWebDriver, startXInput } from './lib/drivers.mjs'
import { alive, evict, filesUnder, killTree, mappedFiles, memory, residency } from './lib/procs.mjs'
import { loadAverage, machine, percentile, round, summarize } from './lib/stats.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const args = Object.fromEntries(process.argv.slice(2).flatMap((value, index, values) => (value.startsWith('--') ? [[value.slice(2), values[index + 1]?.startsWith('--') ? 'true' : values[index + 1]]] : [])))
const host = args.host
if (!['electron', 'tauri'].includes(host)) throw new Error('--host electron|tauri')
const app = path.resolve(args.app || '')
const fixture = path.resolve(args.fixture || '')
if (!fs.existsSync(app) || !fs.existsSync(fixture)) throw new Error('--app <binary> and --fixture <vault> are required')
const runs = Math.max(1, Number(args.runs) || 5)
const suites = new Set((args.suites || 'startup-cold,session').split(','))
const variant = args.variant || 'markdown'
const keyCount = Number(args.keys) || 500
const tests = new Set((args.tests || 'typing,long,pdf').split(','))
const keyPaceMs = Number(args['key-pace']) || 60
const maxLoad = Number(args['max-load']) || os.cpus().length - 1
const label = args.label || host
const outFile = path.resolve(args.out || path.join(here, 'results', `${label}-${variant}.json`))
const work = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), `fanotes-bench-${host}-`))
const agentSource = fs.readFileSync(path.join(here, 'lib', 'page-agent.js'), 'utf8')
const SCREEN = { width: 1440, height: 900 }
const LAST_NOTE = 'Start/Letzte Notiz.md'
const TYPING_NOTE = 'Start/Tippen.md'
const LONG_NOTE = 'Gross/Langes Dokument.md'
const BIG_PDF = args.pdf || 'Skripte/Skript 200 Seiten.pdf'
const PDF_PAGES = Number(args['pdf-pages']) || 200
const STORY = 'Schreiben/Roman.story'

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const monoMs = () => Number(process.hrtime.bigint()) / 1e6
const log = (...values) => console.log(`[${host}${variant === 'writing' ? '/writing' : ''}]`, ...values)

const waitForCalm = async () => {
  const deadline = Date.now() + 180_000
  while (os.loadavg()[0] > maxLoad && Date.now() < deadline) await wait(5_000)
  return loadAverage()
}

// ── Profiles ────────────────────────────────────────────────────────────────

const settings = { uiLanguage: 'de', autoCheckUpdates: false, autoDownloadUpdates: false, spellcheck: false, lastOpenNotePath: LAST_NOTE }

const createProfile = (name) => {
  const root = path.join(work, name)
  const dirs = { root, home: path.join(root, 'home'), config: path.join(root, 'config'), data: path.join(root, 'data'), cache: path.join(root, 'cache'), runtime: path.join(root, 'runtime') }
  for (const directory of Object.values(dirs)) fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
  dirs.vault = path.join(dirs.home, 'Notizen')
  fs.cpSync(fixture, dirs.vault, { recursive: true, preserveTimestamps: true })
  if (host === 'electron') {
    fs.mkdirSync(path.join(dirs.config, 'FaNotes'), { recursive: true, mode: 0o700 })
    fs.writeFileSync(path.join(dirs.config, 'FaNotes', 'config.json'), `${JSON.stringify({ version: 3, vaultPath: dirs.vault, settings, onboarding: { version: 1, completed: true } }, null, 2)}\n`, { mode: 0o600 })
  } else {
    // The Tauri host's own profile (fanotes-host: settings.json + vault-path), no Electron import.
    const appData = path.join(dirs.data, args['tauri-identifier'] || 'de.fanotes.app')
    fs.mkdirSync(appData, { recursive: true, mode: 0o700 })
    fs.writeFileSync(path.join(appData, 'settings.json'), `${JSON.stringify(settings)}\n`, { mode: 0o600 })
    fs.writeFileSync(path.join(appData, 'vault-path'), `${dirs.vault}\n`, { mode: 0o600 })
    fs.writeFileSync(path.join(appData, '.fanotes-legacy-migration-v1-complete'), '', { mode: 0o600 })
  }
  return dirs
}

/** Every session starts on the same note: the previous session ended on another one. */
const resetLastNote = (profile) => {
  const file = host === 'electron'
    ? path.join(profile.config, 'FaNotes', 'config.json')
    : path.join(profile.data, args['tauri-identifier'] || 'de.fanotes.app', 'settings.json')
  const stored = JSON.parse(fs.readFileSync(file, 'utf8'))
  const target = host === 'electron' ? (stored.settings ||= {}) : stored
  target.lastOpenNotePath = LAST_NOTE
  fs.writeFileSync(file, `${JSON.stringify(stored, null, 2)}\n`, { mode: 0o600 })
}

const resetTypingNote = (profile) => {
  const source = path.join(fixture, ...TYPING_NOTE.split('/'))
  const target = path.join(profile.vault, ...TYPING_NOTE.split('/'))
  fs.copyFileSync(source, target)
  const { atime, mtime } = fs.statSync(source)
  fs.utimesSync(target, atime, mtime)
}

// ── Launch ──────────────────────────────────────────────────────────────────

const launch = async (profile) => {
  const stamp = path.join(profile.root, `exec-${Date.now()}.stamp`)
  const port = 20_000 + Math.floor(Math.random() * 20_000)
  const env = {
    ...process.env,
    HOME: profile.home,
    XDG_CONFIG_HOME: profile.config,
    XDG_DATA_HOME: profile.data,
    XDG_CACHE_HOME: profile.cache,
    XDG_RUNTIME_DIR: profile.runtime,
    NO_AT_BRIDGE: '1',
  }
  let argv
  if (host === 'electron') {
    // The AppImage's exec line adds the two ozone flags; there is no user namespace in the container.
    argv = [app, `--remote-debugging-port=${port}`, '--no-sandbox', '--ozone-platform=x11', '--ozone-platform-hint=x11']
  } else {
    env.WEBKIT_INSPECTOR_SERVER = `127.0.0.1:${port}`
    env.TAURI_WEBVIEW_AUTOMATION = 'true'
    env.WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS = '1'
    argv = [app]
  }
  const child = spawn('fanotes-execstamp', [stamp, ...argv], { env, stdio: ['ignore', 'ignore', 'pipe'] })
  let stderr = ''
  child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-6000) })
  const isAlive = () => child.exitCode === null
  let driver
  try {
    driver = host === 'electron'
      ? await connectCdp(port, { alive: isAlive })
      : await connectWebDriver({ inspectorPort: port, alive: isAlive })
  } catch (error) {
    killTree(child.pid)
    throw new Error(`${error.message}\n${stderr.slice(-1500)}`)
  }
  const [stampNs, pid] = fs.readFileSync(stamp, 'utf8').trim().split(' ')
  const session = { child, pid: Number(pid), driver, execMono: Number(BigInt(stampNs)) / 1e6, stderr: () => stderr }
  session.evaluate = (expression) => driver.evaluate(expression)
  session.agent = async () => {
    for (let tries = 0; tries < 400; tries += 1) {
      try {
        await driver.evaluate(agentSource)
        if (await driver.evaluate('Boolean(window.__fanotesBench)')) return
      } catch {
        // The page is still navigating.
      }
      await wait(25)
    }
    throw new Error('could not inject the page agent')
  }
  return session
}

/** Page clock → CLOCK_MONOTONIC (ms): offset with the smallest round trip. */
const clockOffset = async (session, samples = 15) => {
  let best = { rtt: Infinity, offset: 0 }
  for (let index = 0; index < samples; index += 1) {
    const before = monoMs()
    const page = await session.evaluate('window.__fanotesBench.now()')
    const after = monoMs()
    if (after - before < best.rtt) best = { rtt: after - before, offset: (before + after) / 2 - page }
  }
  return best
}

const close = async (session) => {
  try { await session.evaluate('(window.fanotes && window.fanotes.requestClose ? window.fanotes.requestClose() : null, true)') } catch { /* the page may go away mid-call */ }
  const deadline = Date.now() + 6_000
  while (alive(session.pid) && Date.now() < deadline) await wait(100)
  await Promise.resolve().then(() => session.driver.close()).catch(() => undefined)
  if (alive(session.pid)) killTree(session.pid, 'SIGTERM')
  await wait(500)
  killTree(session.pid, 'SIGKILL')
  await wait(300)
}

const waitStartup = async (session, timeoutMs = 90_000) => {
  await session.agent()
  const deadline = Date.now() + timeoutMs
  let marks
  while (Date.now() < deadline) {
    // The agent may have landed in the document before the app's own page loaded: inject again.
    marks = await session.evaluate('window.__fanotesBench ? window.__fanotesBench.marks() : null').catch(() => null)
    if (!marks) await session.agent()
    // A build without the startup marks (feature/writing-mode) only waits for the DOM.
    if (marks?.ready && ((marks.tree !== null && marks.note !== null) || variant === 'writing')) break
    await wait(50)
  }
  if (!marks?.ready || (variant !== 'writing' && (marks.tree === null || marks.note === null))) throw new Error(`startup did not finish: ${JSON.stringify(marks)}\n${session.stderr().slice(-800)}`)
  const clock = await clockOffset(session)
  const toMono = (pageMs) => pageMs + clock.offset
  return {
    startupMs: toMono(Math.max(marks.tree, marks.note)) - session.execMono,
    treeMs: toMono(marks.tree) - session.execMono,
    noteMs: toMono(marks.note) - session.execMono,
    pageOriginMs: toMono(0) - session.execMono,
    clockRttMs: clock.rtt,
    clock,
    userAgent: marks.userAgent,
  }
}

const sampleMemory = async (session, settleMs) => {
  await wait(settleMs)
  const samples = []
  for (let index = 0; index < 3; index += 1) {
    samples.push(memory(session.pid))
    await wait(1_000)
  }
  const pick = samples.sort((a, b) => a.rssMb - b.rssMb)[1]
  return { rssMb: round(pick.rssMb, 1), pssMb: round(pick.pssMb, 1), processes: pick.processes.map((item) => ({ name: item.name, rssMb: round(item.rssMb, 1), pssMb: round(item.pssMb, 1) })) }
}

// ── Tests inside one session ────────────────────────────────────────────────

const TEXT = 'der schnelle braune fuchs springt ueber den faulen hund und schreibt eine notiz '
const keysymOf = (char) => (char === ' ' ? 'space' : char)

const typingTest = async (session, xin, clock, { open, rootSelector, clickSelector }) => {
  await open()
  await wait(1_500)
  const rect = await session.evaluate(`window.__fanotesBench.rect(${JSON.stringify(clickSelector)})`)
  if (!rect) throw new Error(`no ${clickSelector} to click`)
  const x = rect.screenX + rect.x + Math.min(rect.width / 2, 300)
  const y = rect.screenY + rect.y + Math.min(rect.height / 2, 200)
  await xin.focus(session.pid)
  await xin.move(x, y)
  await xin.click(1)
  await wait(300)
  // Navigation only: if the click did not leave the caret in the editor, focus it from the page. The keys stay XTest.
  const focusedBefore = await session.evaluate(`(() => { const root = [...document.querySelectorAll(${JSON.stringify(rootSelector)})].find((element) => element.contains(document.activeElement)); if (root) return true; const target = [...document.querySelectorAll(${JSON.stringify(clickSelector)})].filter((element) => element.getClientRects().length).at(-1); (document.querySelector(${JSON.stringify(`${rootSelector} textarea`)}) || target)?.focus(); return false })()`)
  await xin.key('End', 'Control_L')
  await xin.key('Return')
  await xin.key('Return')
  await wait(500)
  const lengthBefore = await session.evaluate(`window.__fanotesBench.textLength(${JSON.stringify(rootSelector)})`)
  await session.evaluate(`window.__fanotesBench.typingStart(${JSON.stringify(rootSelector)})`)
  const injected = []
  const started = monoMs()
  for (let index = 0; index < keyCount; index += 1) {
    const char = TEXT[index % TEXT.length]
    const due = started + index * keyPaceMs
    while (monoMs() < due - 2) await wait(1)
    while (monoMs() < due) { /* spin the last 2 ms */ }
    injected.push(Number(await xin.key(index % 100 === 99 ? 'Return' : keysymOf(char))) / 1e6)
  }
  await wait(1_500)
  const samples = await session.evaluate('window.__fanotesBench.typingStop()')
  const lengthAfter = await session.evaluate(`window.__fanotesBench.textLength(${JSON.stringify(rootSelector)})`)
  const pageLatency = samples.map((sample) => sample.painted - sample.eventTime)
  const handlerLatency = samples.map((sample) => sample.painted - sample.handlerTime)
  const endToEnd = samples.length === injected.length ? samples.map((sample, index) => sample.painted + clock.offset - injected[index]) : []
  return {
    keys: keyCount,
    paceMs: keyPaceMs,
    measured: samples.length,
    clickFocused: focusedBefore,
    textGrowth: lengthAfter - lengthBefore,
    changedFrames: samples.filter((sample) => sample.changed).length,
    framesToChange: { p50: percentile(samples.map((sample) => sample.frames), 50), max: Math.max(...samples.map((sample) => sample.frames)) },
    eventToPaint: { p50: round(percentile(pageLatency, 50), 2), p95: round(percentile(pageLatency, 95), 2), max: round(Math.max(...pageLatency), 2) },
    handlerToPaint: { p50: round(percentile(handlerLatency, 50), 2), p95: round(percentile(handlerLatency, 95), 2) },
    injectToPaint: endToEnd.length ? { p50: round(percentile(endToEnd, 50), 2), p95: round(percentile(endToEnd, 95), 2), clockRttMs: round(clock.rtt, 2) } : null,
  }
}

const frameStats = (result, refresh) => {
  const intervals = result.intervals
  const budget = refresh * 1.5
  return {
    frames: intervals.length,
    durationMs: round(result.durationMs, 0),
    scrollHeight: result.scrollHeight,
    scroller: result.scroller,
    refreshMs: round(refresh, 2),
    p50: round(percentile(intervals, 50), 2),
    p95: round(percentile(intervals, 95), 2),
    p99: round(percentile(intervals, 99), 2),
    max: round(Math.max(...intervals), 1),
    dropped: intervals.reduce((sum, value) => sum + (value > budget ? Math.max(1, Math.round(value / refresh) - 1) : 0), 0),
    over50ms: intervals.filter((value) => value > 50).length,
  }
}

const scrollTest = async (session, { open, seedSelector, settleMs = 2_000 }) => {
  const openMs = await open()
  await wait(settleMs)
  const idle = await session.evaluate('window.__fanotesBench.idleFrames(120)')
  const refresh = percentile(idle, 50)
  const result = await session.evaluate(`window.__fanotesBench.scroll(${JSON.stringify(seedSelector)}, { targetFrames: 600, minStep: 40 })`)
  return { openMs: round(openMs, 0), ...frameStats(result, refresh) }
}

const openPath = (session, target, readyExpression) => () => session.evaluate(`window.__fanotesBench.open(${JSON.stringify(target)}, () => (${readyExpression}))`)
const editorShows = (text) => `Boolean(document.querySelector('.markdown-editor .cm-content')?.textContent.includes(${JSON.stringify(text)}))`

// ── Suites ──────────────────────────────────────────────────────────────────

const appFiles = (pid) => [...new Set([...mappedFiles(pid), ...filesUnder(path.dirname(app))])]

const report = {
  metric: 'desktop',
  host,
  label,
  variant,
  app,
  date: new Date().toISOString(),
  machine: machine(),
  screen: SCREEN,
  fixture,
  settings,
  coldEvictionFiles: 0,
  startupCold: [],
  startupWarm: [],
  memoryIdle: [],
  memoryIdleCold: [],
  memoryLongNote: [],
  memoryPdf: [],
  memoryStory: [],
  typing: [],
  scrollLongNote: [],
  scrollPdf: [],
  scrollStory: [],
  errors: [],
}

const xin = startXInput()
let evictionList = []
try {
  // Prime once: learns which files the app maps (for the cold runs) and fills the warm profile.
  const warmProfile = createProfile('warm')
  {
    const load = await waitForCalm()
    const session = await launch(warmProfile)
    try {
      const startup = await waitStartup(session)
      log(`prime: ${round(startup.startupMs, 0)} ms (discarded) · load ${load.join(' ')}`)
      await wait(8_000)
      evictionList = appFiles(session.pid)
    } finally {
      await close(session)
    }
  }

  if (suites.has('startup-cold')) {
    for (let run = 1; run <= runs; run += 1) {
      const profile = createProfile(`cold-${run}`)
      const files = [...new Set([...evictionList, ...filesUnder(profile.vault)])]
      const before = residency(files)
      evict(files)
      const after = residency(files)
      report.coldEvictionFiles = files.length
      const load = await waitForCalm()
      const session = await launch(profile)
      try {
        const startup = await waitStartup(session)
        report.startupCold.push({ run, ...roundStartup(startup), cachedBefore: round(before, 3), cachedAfterEvict: round(after, 3), load })
        log(`cold ${run}: ${round(startup.startupMs, 0)} ms (tree ${round(startup.treeMs, 0)}, note ${round(startup.noteMs, 0)}) · cache ${round(before * 100, 0)}% → ${round(after * 100, 0)}% · load ${load.join(' ')}`)
        const mem = await sampleMemory(session, 8_000)
        report.memoryIdleCold.push({ run, ...mem })
      } catch (error) {
        report.errors.push({ suite: 'startup-cold', run, error: String(error.message).slice(0, 600) })
        log(`cold ${run} failed: ${error.message.slice(0, 300)}`)
      } finally {
        await close(session)
        fs.rmSync(profile.root, { recursive: true, force: true })
      }
    }
  }

  if (suites.has('session')) {
    for (let run = 1; run <= runs; run += 1) {
      resetTypingNote(warmProfile)
      resetLastNote(warmProfile)
      const load = await waitForCalm()
      const session = await launch(warmProfile)
      const step = async (name, task) => {
        try {
          return await task()
        } catch (error) {
          report.errors.push({ suite: name, run, error: String(error.message).slice(0, 600), stderr: session.stderr().slice(-1200) })
          log(`${name} ${run} failed: ${error.message.slice(0, 300)}`)
          return null
        }
      }
      try {
        const startup = await waitStartup(session)
        report.startupWarm.push({ run, ...roundStartup(startup), load })
        log(`warm ${run}: ${round(startup.startupMs, 0)} ms (tree ${round(startup.treeMs, 0)}, note ${round(startup.noteMs, 0)}) · load ${load.join(' ')}`)
        for (let tries = 0; ; tries += 1) {
          try { await xin.place(session.pid, 0, 0, SCREEN.width, SCREEN.height); break } catch (error) { if (tries > 100) throw error; await wait(100) }
        }
        const idle = await sampleMemory(session, 8_000)
        report.memoryIdle.push({ run, ...idle })
        log(`memory idle ${run}: RSS ${idle.rssMb} MB · PSS ${idle.pssMb} MB`)
        if (variant === 'markdown') {
          const typing = !tests.has('typing') ? null : await step('typing', () => typingTest(session, xin, startup.clock, {
            open: openPath(session, TYPING_NOTE, editorShows('# Tippen')),
            rootSelector: '.markdown-editor .cm-content',
            clickSelector: '.markdown-editor .cm-content',
          }))
          if (typing) {
            report.typing.push({ run, ...typing, load: loadAverage() })
            log(`typing ${run}: event→paint p50 ${typing.eventToPaint.p50} p95 ${typing.eventToPaint.p95} ms · inject→paint p50 ${typing.injectToPaint?.p50} p95 ${typing.injectToPaint?.p95} ms · ${typing.measured}/${typing.keys} keys`)
          }
          const longNote = !tests.has('long') ? null : await step('scroll-long-note', () => scrollTest(session, { open: openPath(session, LONG_NOTE, editorShows('# Langes Dokument')), seedSelector: '.markdown-editor .cm-content' }))
          if (longNote) {
            report.scrollLongNote.push({ run, ...longNote, load: loadAverage() })
            log(`scroll long note ${run}: p95 ${longNote.p95} ms · dropped ${longNote.dropped}/${longNote.frames}`)
            report.memoryLongNote.push({ run, ...(await sampleMemory(session, 2_000)) })
          }
          const pdf = !tests.has('pdf') ? null : await step('scroll-pdf', () => scrollTest(session, { open: openPath(session, BIG_PDF, `document.querySelectorAll('.pdf-note-page').length >= ${PDF_PAGES}`), seedSelector: '.pdf-note-pages', settleMs: 3_000 }))
          if (pdf) {
            report.scrollPdf.push({ run, ...pdf, load: loadAverage() })
            log(`scroll pdf ${run}: p95 ${pdf.p95} ms · dropped ${pdf.dropped}/${pdf.frames}`)
            report.memoryPdf.push({ run, ...(await sampleMemory(session, 2_000)) })
          }
        } else {
          const storyReady = "document.querySelectorAll('.wm-page').length > 0"
          let opened = false
          const openStory = async () => {
            if (opened) return 0
            opened = true
            return session.evaluate(`window.__fanotesBench.open(${JSON.stringify(STORY)}, () => (${storyReady}))`)
          }
          const story = await step('scroll-story', async () => {
            const result = await scrollTest(session, { open: openStory, seedSelector: '.wm-page', settleMs: 5_000 })
            result.pages = await session.evaluate("document.querySelectorAll('.wm-page').length")
            result.pageLabel = await session.evaluate("(document.querySelector('.wm-root')?.innerText.match(/(\\d[\\d’'., ]*)\\s*(Seiten|pages)/u) || [])[0] || null")
            return result
          })
          if (story) {
            report.scrollStory.push({ run, ...story, load: loadAverage() })
            log(`scroll story ${run}: p95 ${story.p95} ms · dropped ${story.dropped}/${story.frames} · ${story.pageLabel ?? `${story.pages} page elements`}`)
            report.memoryStory.push({ run, ...(await sampleMemory(session, 2_000)) })
          }
          const typing = await step('typing-story', () => typingTest(session, xin, startup.clock, {
            open: openStory,
            rootSelector: '.wm-root',
            clickSelector: '.wm-page',
          }))
          if (typing) {
            report.typing.push({ run, ...typing, load: loadAverage() })
            log(`typing story ${run}: event→paint p50 ${typing.eventToPaint.p50} p95 ${typing.eventToPaint.p95} ms · ${typing.measured}/${typing.keys} keys, ${typing.changedFrames} with a change`)
          }
        }
      } catch (error) {
        report.errors.push({ suite: 'session', run, error: String(error.message).slice(0, 600) })
        log(`session ${run} failed: ${error.message.slice(0, 400)}`)
      } finally {
        await close(session)
      }
    }
  }
} finally {
  xin.close()
  fs.rmSync(work, { recursive: true, force: true })
}

function roundStartup(startup) {
  return {
    startupMs: round(startup.startupMs, 1),
    treeMs: round(startup.treeMs, 1),
    noteMs: round(startup.noteMs, 1),
    pageOriginMs: round(startup.pageOriginMs, 1),
    clockRttMs: round(startup.clockRttMs, 2),
    userAgent: startup.userAgent,
  }
}

const pick = (list, getter) => summarize(list.map(getter).filter(Number.isFinite))
report.summary = {
  startupColdMs: pick(report.startupCold, (item) => item.startupMs),
  startupWarmMs: pick(report.startupWarm, (item) => item.startupMs),
  memoryIdleRssMb: pick(report.memoryIdle, (item) => item.rssMb),
  memoryIdlePssMb: pick(report.memoryIdle, (item) => item.pssMb),
  memoryLongNoteRssMb: pick(report.memoryLongNote, (item) => item.rssMb),
  memoryPdfRssMb: pick(report.memoryPdf, (item) => item.rssMb),
  memoryPdfPssMb: pick(report.memoryPdf, (item) => item.pssMb),
  memoryStoryRssMb: pick(report.memoryStory, (item) => item.rssMb),
  typingP50Ms: pick(report.typing, (item) => item.eventToPaint.p50),
  typingP95Ms: pick(report.typing, (item) => item.eventToPaint.p95),
  typingInjectP50Ms: pick(report.typing, (item) => item.injectToPaint?.p50),
  typingInjectP95Ms: pick(report.typing, (item) => item.injectToPaint?.p95),
  scrollLongNoteP95Ms: pick(report.scrollLongNote, (item) => item.p95),
  scrollLongNoteDropped: pick(report.scrollLongNote, (item) => item.dropped),
  scrollPdfP95Ms: pick(report.scrollPdf, (item) => item.p95),
  scrollPdfDropped: pick(report.scrollPdf, (item) => item.dropped),
  scrollStoryP95Ms: pick(report.scrollStory, (item) => item.p95),
  scrollStoryDropped: pick(report.scrollStory, (item) => item.dropped),
}
fs.mkdirSync(path.dirname(outFile), { recursive: true })
fs.writeFileSync(outFile, `${JSON.stringify(report, null, 1)}\n`)
log(`errors: ${report.errors.length} · wrote ${outFile}`)
