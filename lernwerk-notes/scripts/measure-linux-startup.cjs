'use strict'

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawn } = require('node:child_process')
const { spawnSync } = require('node:child_process')

const args = Object.fromEntries(process.argv.slice(2).flatMap((value, index, values) => value.startsWith('--') ? [[value.slice(2), values[index + 1]]] : []))
const executable = path.resolve(args.executable || path.join(__dirname, '..', 'release', 'linux-unpacked', 'fanotes'))
const noteCount = Math.max(1, Math.min(10_000, Number(args.notes) || 2_000))
const runs = Math.max(1, Math.min(6, Number(args.runs) || 2))
const budgetMs = Math.max(1000, Math.min(10_000, Number(args.budget) || 3000))
const cpuBudgetSeconds = Math.max(0.25, Math.min(30, Number(args['cpu-budget']) || 3))
const startupWindowMs = Math.max(3_000, Math.min(30_000, Number(args.window) || 3_000))
const inkStrokeCount = Math.max(0, Math.min(5_000, Number(args.ink) || 0))
const trainingSampleCount = Math.max(0, Math.min(12_000, Number(args.training) || 0))
const timeoutMs = 20_000
const clockTicks = Number(spawnSync('getconf', ['CLK_TCK'], { encoding: 'utf8' }).stdout.trim()) || 100

if (process.platform !== 'linux') throw new Error('Die Linux-Startmessung kann nur unter Linux ausgeführt werden.')
if (!fs.statSync(executable).isFile()) throw new Error(`FaNotes-Programm nicht gefunden: ${executable}`)

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'fanotes-startup-measure-'))
const home = path.join(temporary, 'home')
const configHome = path.join(temporary, 'config')
const runtime = path.join(temporary, 'runtime')
const vault = path.join(home, 'Startup-Vault')
const userData = path.join(configHome, 'FaNotes')
fs.mkdirSync(vault, { recursive: true, mode: 0o700 })
fs.mkdirSync(userData, { recursive: true, mode: 0o700 })
fs.mkdirSync(runtime, { recursive: true, mode: 0o700 })
if (inkStrokeCount > 0) {
  const assets = path.join(vault, '.lernwerk', 'assets')
  fs.mkdirSync(assets, { recursive: true, mode: 0o700 })
  const strokes = Array.from({ length: inkStrokeCount }, (_, index) => {
    const row = Math.floor(index / 24)
    const column = index % 24
    const startX = 0.06 + column * 0.036
    const startY = 0.07 + (row % 42) * 0.019
    return {
      color: '#202333',
      baseWidth: 3.5,
      pressureEnabled: true,
      purpose: 'handwriting',
      points: Array.from({ length: 9 }, (__, point) => ({
        x: Math.min(0.96, startX + point * 0.00125),
        y: Math.min(0.96, startY + Math.sin(point * 0.72 + index * 0.11) * 0.003),
        t: index * 50 + point * 5,
        pressure: 0.5 + (point % 3) * 0.05,
        tiltX: 0,
        tiltY: 0,
        pointerType: 'pen',
      })),
    }
  })
  fs.writeFileSync(path.join(vault, 'Willkommen.md'), '# Willkommen\n\nStartmessung mit Handschrift.\n\n<!-- fanotes-ink:startup-ink -->\n')
  fs.writeFileSync(path.join(assets, 'startup-ink.json'), JSON.stringify({
    schemaVersion: 1,
    id: 'startup-ink',
    title: 'Startmessung',
    paperStyle: 'dots',
    sourceWidth: 900,
    sourceHeight: 1273,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    strokes,
    searchTranscript: 'Startmessung mit Handschrift',
    transcriptMode: 'text-and-math',
    recognitionPreference: 'auto',
    detectedRecognitionMode: 'text',
  }))
} else {
  fs.writeFileSync(path.join(vault, 'Willkommen.md'), '# Willkommen\n\nStartmessung.\n')
}
for (let index = 0; index < noteCount; index += 1) {
  const folder = path.join(vault, `Fach-${String(Math.floor(index / 100)).padStart(3, '0')}`)
  if (index % 100 === 0) fs.mkdirSync(folder, { recursive: true, mode: 0o700 })
  fs.writeFileSync(path.join(folder, `Notiz-${String(index).padStart(5, '0')}.md`), `# Notiz ${index}\n`)
}
fs.writeFileSync(path.join(userData, 'config.json'), `${JSON.stringify({
  version: 3,
  vaultPath: vault,
  settings: { autoCheckUpdates: false, autoDownloadUpdates: false, spellcheck: true },
  onboarding: { version: 1, completed: true },
}, null, 2)}\n`, { mode: 0o600 })

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))

function descendants(rootPid) {
  const result = new Set([rootPid])
  const pending = [rootPid]
  while (pending.length) {
    const pid = pending.pop()
    try {
      const children = fs.readFileSync(`/proc/${pid}/task/${pid}/children`, 'utf8').trim().split(/\s+/u)
      for (const raw of children) {
        const child = Number(raw)
        if (!child || result.has(child)) continue
        result.add(child)
        pending.push(child)
      }
    } catch {
      // A helper may terminate between samples.
    }
  }
  return result
}

function cpuSeconds(rootPid) {
  let ticks = 0
  for (const pid of descendants(rootPid)) {
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8')
      const fields = stat.slice(stat.lastIndexOf(') ') + 2).trim().split(/\s+/u)
      ticks += Number(fields[11]) + Number(fields[12])
    } catch {
      // A short-lived process may disappear during the sample.
    }
  }
  return ticks / clockTicks
}

async function connect(port, child) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`FaNotes wurde zu früh mit Code ${child.exitCode} beendet.`)
    try {
      const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
      const page = pages.find((candidate) => candidate.type === 'page')
      if (page?.webSocketDebuggerUrl) {
        const socket = new WebSocket(page.webSocketDebuggerUrl)
        await new Promise((resolve, reject) => {
          socket.addEventListener('open', resolve, { once: true })
          socket.addEventListener('error', reject, { once: true })
        })
        return socket
      }
    } catch {
      // Chromium has not opened the debugging endpoint yet.
    }
    await wait(20)
  }
  throw new Error('FaNotes hat den Renderer nicht rechtzeitig gestartet.')
}

function evaluator(socket) {
  let sequence = 0
  return (expression, awaitPromise = false) => new Promise((resolve, reject) => {
    const id = ++sequence
    const listener = (event) => {
      const message = JSON.parse(event.data)
      if (message.id !== id) return
      socket.removeEventListener('message', listener)
      if (message.error) reject(new Error(message.error.message))
      else resolve(message.result?.result?.value)
    }
    socket.addEventListener('message', listener)
    socket.send(JSON.stringify({
      id,
      method: 'Runtime.evaluate',
      params: { expression, awaitPromise, returnByValue: true },
    }))
  })
}

async function seedTrainingSamples() {
  if (trainingSampleCount <= 0) return
  const port = 19_000 + Math.floor(Math.random() * 20_000)
  const child = spawn(executable, [`--remote-debugging-port=${port}`], {
    env: {
      ...process.env,
      HOME: home,
      XDG_CONFIG_HOME: configHome,
      XDG_RUNTIME_DIR: runtime,
      FANOTES_STARTUP_MEASUREMENT: '1',
    },
    stdio: ['ignore', 'ignore', 'ignore'],
  })
  let socket
  try {
    socket = await connect(port, child)
    const evaluate = evaluator(socket)
    const seeded = await evaluate(`(async () => new Promise((resolve, reject) => {
      const request = indexedDB.open('lernwerk-notes-handwriting', 1)
      request.onupgradeneeded = () => {
        const database = request.result
        if (!database.objectStoreNames.contains('samples')) {
          const samples = database.createObjectStore('samples', { keyPath: 'id' })
          samples.createIndex('labelId', 'labelId', { unique: false })
          samples.createIndex('createdAt', 'createdAt', { unique: false })
        }
        if (!database.objectStoreNames.contains('layoutExamples')) {
          const layouts = database.createObjectStore('layoutExamples', { keyPath: 'id' })
          layouts.createIndex('anchorLabelId', 'anchorLabelId', { unique: false })
          layouts.createIndex('createdAt', 'createdAt', { unique: false })
        }
        if (!database.objectStoreNames.contains('labels')) database.createObjectStore('labels', { keyPath: 'id' })
      }
      request.onerror = () => reject(request.error)
      request.onsuccess = () => {
        const database = request.result
        const transaction = database.transaction('samples', 'readwrite')
        const store = transaction.objectStore('samples')
        const imageData = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
        for (let index = 0; index < ${trainingSampleCount}; index += 1) {
          const char = String.fromCharCode(97 + (index % 26))
          const phase = index * 0.071
          const points = Array.from({ length: 14 }, (_, point) => ({
            x: 0.12 + point / 18 + Math.sin(phase + point * 0.83) * 0.012,
            y: 0.16 + (point % 7) / 10 + Math.cos(phase * 1.3 + point * 0.57) * 0.012,
            t: index * 100 + point * 6,
            pressure: 0.46 + (point % 4) * 0.08,
            tiltX: 0,
            tiltY: 0,
            pointerType: 'pen',
          }))
          store.put({
            id: 'startup-training-' + index,
            labelId: 'latin_lower_' + char,
            label: char,
            labelName: 'Kleines ' + char.toUpperCase(),
            latex: char,
            category: 'lowercase',
            writerId: 'startup-benchmark',
            sessionId: 'startup-benchmark',
            createdAt: new Date(1700000000000 + index * 1000).toISOString(),
            imageData,
            imageWidth: 1,
            imageHeight: 1,
            sourceCanvas: { width: 900, height: 1273, devicePixelRatio: 1 },
            bbox: [0.1, 0.1, 0.8, 0.8],
            strokes: [{ points, baseWidth: 3.5, pressureEnabled: true }],
            strokeCount: 1,
            pointCount: points.length,
            schemaVersion: 1,
          })
        }
        transaction.oncomplete = () => {
          database.close()
          resolve(${trainingSampleCount})
        }
        transaction.onerror = () => reject(transaction.error)
        transaction.onabort = () => reject(transaction.error)
      }
    }))()`, true)
    console.log(`Vorbereitung: ${seeded} persönliche Trainingsbeispiele im Testprofil gespeichert.`)
    await evaluate('window.lernwerk.requestClose()')
    await Promise.race([new Promise((resolve) => child.once('exit', resolve)), wait(1200)])
  } finally {
    socket?.close()
    if (child.exitCode === null) child.kill('SIGKILL')
  }
}

async function measure(run) {
  const port = 19_000 + Math.floor(Math.random() * 20_000)
  const startedAt = performance.now()
  const child = spawn(executable, [`--remote-debugging-port=${port}`], {
    env: {
      ...process.env,
      HOME: home,
      XDG_CONFIG_HOME: configHome,
      XDG_RUNTIME_DIR: runtime,
      FANOTES_STARTUP_MEASUREMENT: '1',
    },
    stdio: ['ignore', 'ignore', 'ignore'],
  })
  const cpuAtLaunch = cpuSeconds(child.pid)
  let socket
  try {
    socket = await connect(port, child)
    const evaluate = evaluator(socket)
    const shellDeadline = Date.now() + timeoutMs
    let shellMs = null
    let editorMs = null
    let rendererMs = null
    while (Date.now() < shellDeadline) {
      const state = await evaluate(`({
        shell: Boolean(document.querySelector('.app-shell')),
        editor: Boolean(document.querySelector('.markdown-editor .cm-content')),
        rendererMs: performance.now()
      })`)
      if (state?.shell && shellMs === null) shellMs = performance.now() - startedAt
      if (state?.editor) {
        editorMs = performance.now() - startedAt
        rendererMs = state.rendererMs
        break
      }
      await wait(16)
    }
    if (editorMs === null) throw new Error('Der Markdown-Editor wurde nicht rechtzeitig interaktiv.')
    const cpuAtEditor = Math.max(0, cpuSeconds(child.pid) - cpuAtLaunch)
    const samples = [{ at: performance.now() - startedAt, cpu: cpuAtEditor }]
    while (performance.now() - startedAt < startupWindowMs) {
      await wait(Math.min(250, startupWindowMs - (performance.now() - startedAt)))
      samples.push({
        at: performance.now() - startedAt,
        cpu: Math.max(0, cpuSeconds(child.pid) - cpuAtLaunch),
      })
    }
    const cpuAtStartupWindow = samples.at(-1).cpu
    let peakCpuPercent = 0
    for (let end = 1; end < samples.length; end += 1) {
      let start = end - 1
      while (start > 0 && samples[end].at - samples[start - 1].at <= 1000) start -= 1
      const wallSeconds = (samples[end].at - samples[start].at) / 1000
      if (wallSeconds > 0) {
        peakCpuPercent = Math.max(peakCpuPercent, (samples[end].cpu - samples[start].cpu) / wallSeconds * 100)
      }
    }
    console.log(`Lauf ${run}: Shell ${shellMs.toFixed(0)} ms · Editor ${editorMs.toFixed(0)} ms · Renderer ${rendererMs.toFixed(0)} ms · CPU bis Editor ${cpuAtEditor.toFixed(2)} s · CPU im ${(startupWindowMs / 1000).toFixed(0)}-s-Fenster ${cpuAtStartupWindow.toFixed(2)} s · CPU-Spitze ${peakCpuPercent.toFixed(0)} %`)
    if (run === 1 && runs > 1) {
      // The first process refreshes the verified local tree cache after the
      // editor is usable. Keep timing stopped, but let that maintenance finish
      // so later runs measure the real warm-start path used by NAS vaults.
      const cacheDirectory = path.join(userData, 'tree-cache-v1')
      const cacheDeadline = Date.now() + 5_000
      while (Date.now() < cacheDeadline) {
        const cacheFiles = await fs.promises.readdir(cacheDirectory).catch(() => [])
        if (cacheFiles.some((name) => name.endsWith('.json'))) break
        await wait(50)
      }
    }
    await evaluate('window.lernwerk.requestClose()')
    await Promise.race([new Promise((resolve) => child.once('exit', resolve)), wait(1200)])
    if (child.exitCode === null) child.kill('SIGTERM')
    return { shellMs, editorMs, rendererMs, cpuAtEditor, cpuAtStartupWindow, peakCpuPercent }
  } finally {
    socket?.close()
    if (child.exitCode === null) child.kill('SIGKILL')
  }
}

void (async () => {
  try {
    await seedTrainingSamples()
    const results = []
    for (let run = 1; run <= runs; run += 1) results.push(await measure(run))
    const average = (key) => results.reduce((sum, result) => sum + result[key], 0) / results.length
    const slowestEditor = Math.max(...results.map((result) => result.editorMs))
    const highestStartupCpu = Math.max(...results.map((result) => result.cpuAtEditor))
    console.log(`Mittel: Shell ${average('shellMs').toFixed(0)} ms · Editor ${average('editorMs').toFixed(0)} ms · CPU bis Editor ${average('cpuAtEditor').toFixed(2)} s · CPU im ${(startupWindowMs / 1000).toFixed(0)}-s-Fenster ${average('cpuAtStartupWindow').toFixed(2)} s · CPU-Spitze ${average('peakCpuPercent').toFixed(0)} % (${noteCount} Notizen${inkStrokeCount ? ` · ${inkStrokeCount} Tintenstriche` : ''}${trainingSampleCount ? ` · ${trainingSampleCount} Trainingsbeispiele` : ''})`)
    if (slowestEditor >= budgetMs) throw new Error(`Startbudget überschritten: langsamster Editor ${slowestEditor.toFixed(0)} ms, Ziel < ${budgetMs} ms.`)
    if (highestStartupCpu >= cpuBudgetSeconds) throw new Error(`CPU-Startbudget überschritten: höchster Lauf ${highestStartupCpu.toFixed(2)} s, Ziel < ${cpuBudgetSeconds.toFixed(2)} s.`)
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true })
  }
})().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error))
  process.exitCode = 1
})
