'use strict'

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawn, spawnSync } = require('node:child_process')

const args = Object.fromEntries(process.argv.slice(2).flatMap((value, index, values) => value.startsWith('--') ? [[value.slice(2), values[index + 1]]] : []))
const executable = path.resolve(args.executable || path.join(__dirname, '..', 'release', 'linux-unpacked', 'fanotes'))
const strokeCount = Math.max(100, Math.min(5_000, Number(args.strokes) || 2_000))
const useDefaultEffects = args.effects === 'default'
const timeoutMs = 25_000
const clockTicks = Number(spawnSync('getconf', ['CLK_TCK'], { encoding: 'utf8' }).stdout.trim()) || 100
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'fanotes-efficiency-measure-'))
const home = path.join(temporary, 'home')
const configHome = path.join(temporary, 'config')
const runtime = path.join(temporary, 'runtime')
const vault = path.join(home, 'Efficiency-Vault')
const userData = path.join(configHome, 'FaNotes')
const assets = path.join(vault, '.fanotes', 'assets')

for (const directory of [vault, userData, runtime, assets]) fs.mkdirSync(directory, { recursive: true, mode: 0o700 })

const strokes = Array.from({ length: strokeCount }, (_, index) => {
  const row = Math.floor(index / 40)
  const column = index % 40
  const startX = 0.055 + column * 0.022
  const startY = 0.045 + (row % 50) * 0.018
  return {
    color: '#202333',
    baseWidth: 3.5,
    pressureEnabled: true,
    points: Array.from({ length: 14 }, (__, point) => ({
      x: Math.min(0.97, startX + point * 0.00075),
      y: Math.min(0.97, startY + Math.sin(point * 0.65) * 0.0024),
      t: index * 20 + point * 4,
      pressure: 0.52 + (point % 3) * 0.04,
      tiltX: 0,
      tiltY: 0,
      pointerType: 'pen',
    })),
  }
})
const drawing = {
  schemaVersion: 1,
  title: 'Effizienztest',
  paperStyle: 'dots',
  sourceWidth: 900,
  sourceHeight: 1273,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  strokes,
  searchTranscript: '',
  transcriptMode: 'text-and-math',
  recognitionPreference: 'auto',
  detectedRecognitionMode: 'text',
}
fs.writeFileSync(path.join(vault, 'Effizienztest.md'), '# Effizienztest\n\n<!-- fanotes-ink:efficiency -->\n')
fs.writeFileSync(path.join(assets, 'efficiency.json'), JSON.stringify(drawing))
const initialPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64')
fs.writeFileSync(path.join(assets, 'efficiency.png'), initialPng)
fs.writeFileSync(path.join(userData, 'config.json'), `${JSON.stringify({
  version: 3,
  vaultPath: vault,
  settings: {
    autoCheckUpdates: false,
    autoDownloadUpdates: false,
    spellcheck: false,
    ...(useDefaultEffects ? {} : { reduceMotion: true, glassEffects: false }),
  },
  onboarding: { version: 1, completed: true },
}, null, 2)}\n`, { mode: 0o600 })

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))

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
      // Chromium is still opening its debugging endpoint.
    }
    await wait(20)
  }
  throw new Error('FaNotes hat den Renderer nicht rechtzeitig gestartet.')
}

function createCdp(socket) {
  let sequence = 0
  const pending = new Map()
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data)
    if (!message.id) return
    const callback = pending.get(message.id)
    if (!callback) return
    pending.delete(message.id)
    if (message.error) callback.reject(new Error(message.error.message))
    else callback.resolve(message.result)
  })
  return {
    send(method, params = {}) {
      return new Promise((resolve, reject) => {
        const id = ++sequence
        pending.set(id, { resolve, reject })
        socket.send(JSON.stringify({ id, method, params }))
      })
    },
    async evaluate(expression) {
      const result = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || 'Renderer-Auswertung fehlgeschlagen.')
      return result.result?.value
    },
  }
}

async function waitFor(cdp, expression, description) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await cdp.evaluate(expression)) return
    await wait(35)
  }
  throw new Error(`${description} wurde nicht rechtzeitig bereit.`)
}

function descendants(rootPid) {
  const result = new Set([rootPid])
  const pending = [rootPid]
  while (pending.length) {
    const pid = pending.pop()
    let children = ''
    try {
      children = fs.readFileSync(`/proc/${pid}/task/${pid}/children`, 'utf8')
    } catch {
      continue
    }
    for (const raw of children.trim().split(/\s+/u)) {
      const child = Number(raw)
      if (!child || result.has(child)) continue
      result.add(child)
      pending.push(child)
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
      // A short-lived helper process may exit while the sample is read.
    }
  }
  return ticks / clockTicks
}

async function cpuWindow(rootPid, action) {
  const startedAt = performance.now()
  const before = cpuSeconds(rootPid)
  await action()
  const wallSeconds = (performance.now() - startedAt) / 1000
  const cpu = Math.max(0, cpuSeconds(rootPid) - before)
  return { cpu, wallSeconds, averagePercent: cpu / wallSeconds * 100 }
}

const percentile = (values, fraction) => {
  if (!values.length) return 0
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))]
}

void (async () => {
  if (process.platform !== 'linux') throw new Error('Die Linux-Effizienzmessung kann nur unter Linux ausgeführt werden.')
  if (!fs.existsSync(executable)) throw new Error(`FaNotes-Programm nicht gefunden: ${executable}`)

  const port = 19_000 + Math.floor(Math.random() * 20_000)
  const child = spawn(executable, [`--remote-debugging-port=${port}`], {
    env: { ...process.env, HOME: home, XDG_CONFIG_HOME: configHome, XDG_RUNTIME_DIR: runtime },
    stdio: ['ignore', 'ignore', 'ignore'],
  })
  let socket
  try {
    socket = await connect(port, child)
    const cdp = createCdp(socket)
    await cdp.send('Performance.enable')
    await waitFor(cdp, `Boolean(document.querySelector('.markdown-editor .cm-content'))`, 'Der Editor')
    await waitFor(cdp, `Boolean(document.querySelector('.lw-drawing-board.is-inline'))`, 'Die gespeicherte Stiftebene')
    await wait(3_500)

    const idle = await cpuWindow(child.pid, () => wait(4_000))

    await cdp.evaluate(`document.querySelector('button[title^="Auf derselben Seite"]').click()`)
    await waitFor(cdp, `Boolean(document.querySelector('.lw-tablet-canvas.is-input-active'))`, 'Der aktive Stiftmodus')
    const bounds = await cdp.evaluate(`(() => { const rect = document.querySelector('.lw-tablet-canvas').getBoundingClientRect(); return { left: rect.left, top: rect.top, width: rect.width, height: rect.height } })()`)
    const hitTarget = await cdp.evaluate(`(() => { const rect = document.querySelector('.lw-tablet-canvas').getBoundingClientRect(); const y = Math.min(rect.bottom - 20, innerHeight - 80, rect.top + rect.height * .35); const node = document.elementFromPoint(rect.left + rect.width * .5, y); return { tag: node?.tagName, className: node?.className ?? '', viewportHeight: innerHeight, y, bounds: { left: rect.left, top: rect.top, width: rect.width, height: rect.height } } })()`)
    const beforeMetrics = await cdp.send('Performance.getMetrics')
    const metric = (result, name) => result.metrics.find((entry) => entry.name === name)?.value ?? 0
    await cdp.evaluate(`(() => {
      window.__fanotesFrameTimes = []
      window.__fanotesFrameActive = true
      window.__fanotesPointerEvents = { down: 0, move: 0, up: 0, cancel: 0 }
      const liveCanvas = document.querySelector('.lw-tablet-canvas.is-input-active')
      liveCanvas.addEventListener('pointerdown', () => { window.__fanotesPointerEvents.down += 1 })
      liveCanvas.addEventListener('pointermove', () => { window.__fanotesPointerEvents.move += 1 })
      liveCanvas.addEventListener('pointerup', () => { window.__fanotesPointerEvents.up += 1 })
      liveCanvas.addEventListener('pointercancel', () => { window.__fanotesPointerEvents.cancel += 1 })
      let previous = performance.now()
      const frame = (now) => {
        if (!window.__fanotesFrameActive) return
        window.__fanotesFrameTimes.push(now - previous)
        previous = now
        requestAnimationFrame(frame)
      }
      requestAnimationFrame(frame)
      return true
    })()`)

    const interaction = await cpuWindow(child.pid, async () => {
      const startX = bounds.left + bounds.width * 0.18
      const endX = bounds.left + bounds.width * 0.82
      const centerY = Math.min(bounds.top + bounds.height * 0.35, 700)
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: startX, y: centerY, button: 'left', buttons: 1, clickCount: 1 })
      for (let index = 1; index <= 260; index += 1) {
        const progress = index / 260
        await cdp.send('Input.dispatchMouseEvent', {
          type: 'mouseMoved',
          x: startX + (endX - startX) * progress,
          y: centerY + Math.sin(progress * Math.PI * 5) * bounds.height * 0.018,
          button: 'left',
          buttons: 1,
        })
      }
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: endX, y: centerY, button: 'left', buttons: 0, clickCount: 1 })
      await wait(1_600)
    })
    const afterInteractionMetrics = await cdp.send('Performance.getMetrics')

    // Covers the delayed, invisible search transcript as well. It is expected
    // to stay dormant while the user actively works in the focused window.
    const backgroundIndex = await cpuWindow(child.pid, () => wait(8_000))
    const frameTimes = await cdp.evaluate(`window.__fanotesFrameActive = false; window.__fanotesFrameTimes`)
    const unfocusedIndex = await cpuWindow(child.pid, async () => {
      await cdp.evaluate(`(() => {
        window.__fanotesOriginalHasFocus = document.hasFocus.bind(document)
        Object.defineProperty(document, 'hasFocus', { configurable: true, value: () => false })
        window.dispatchEvent(new Event('blur'))
      })()`)
      await wait(8_000)
    })
    await cdp.evaluate(`(() => {
      Object.defineProperty(document, 'hasFocus', { configurable: true, value: window.__fanotesOriginalHasFocus })
      window.dispatchEvent(new Event('focus'))
    })()`)
    await wait(400)

    const finalMetrics = await cdp.send('Performance.getMetrics')
    const taskMs = (metric(afterInteractionMetrics, 'TaskDuration') - metric(beforeMetrics, 'TaskDuration')) * 1_000
    const heapMb = metric(finalMetrics, 'JSHeapUsedSize') / 1024 / 1024
    console.log(`Leerlauf: ${idle.cpu.toFixed(3)} CPU-s in ${idle.wallSeconds.toFixed(2)} s · ${idle.averagePercent.toFixed(1)} % eines Kerns`)
    console.log(`Stift + Autosave: ${interaction.cpu.toFixed(3)} CPU-s in ${interaction.wallSeconds.toFixed(2)} s · Renderer-Tasks ${taskMs.toFixed(0)} ms`)
    console.log(`Fokussierte Hintergrundphase: ${backgroundIndex.cpu.toFixed(3)} CPU-s in ${backgroundIndex.wallSeconds.toFixed(2)} s · ${backgroundIndex.averagePercent.toFixed(1)} % eines Kerns`)
    console.log(`Unfokussierte Suchindex-Phase: ${unfocusedIndex.cpu.toFixed(3)} CPU-s in ${unfocusedIndex.wallSeconds.toFixed(2)} s · ${unfocusedIndex.averagePercent.toFixed(1)} % eines Kerns`)
    console.log(`Frames: p95 ${percentile(frameTimes, 0.95).toFixed(1)} ms · Maximum ${Math.max(...frameTimes).toFixed(1)} ms · >25 ms ${frameTimes.filter((value) => value > 25).length}`)
    console.log(`JS-Heap nach Last: ${heapMb.toFixed(1)} MiB · Ausgangsseite ${strokeCount} Striche`)
    const savedDrawing = JSON.parse(fs.readFileSync(path.join(assets, 'efficiency.json'), 'utf8'))
    const pngUnchanged = fs.readFileSync(path.join(assets, 'efficiency.png')).equals(initialPng)
    const drawingStatus = await cdp.evaluate(`document.querySelector('.lw-draw-title small')?.textContent ?? ''`)
    const pointerEvents = await cdp.evaluate(`window.__fanotesPointerEvents`)
    console.log(`Autosave: ${savedDrawing.strokes?.length ?? 0} Striche in JSON · ${savedDrawing.searchTranscript?.length ?? 0} Suchzeichen · Vorschau-PNG ${pngUnchanged ? 'nicht neu berechnet' : 'neu berechnet'} · Status „${drawingStatus}“ · Pointer ${JSON.stringify(pointerEvents)} · Hit ${JSON.stringify(hitTarget)}`)
    await cdp.evaluate('window.fanotes.requestClose()')
    await Promise.race([new Promise((resolve) => child.once('exit', resolve)), wait(1000)])
  } finally {
    socket?.close()
    if (child.exitCode === null) child.kill('SIGKILL')
    fs.rmSync(temporary, { recursive: true, force: true })
  }
})().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error))
  process.exitCode = 1
})
