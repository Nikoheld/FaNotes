'use strict'

// Starts the packaged Linux app twice with fresh profiles. First, no process of the app holds ONNX
// Runtime or the PyLaia model until the first conversion; that conversion starts exactly one
// fanotes-ocr sidecar with the packaged runtime; the keep-alive setting and quitting end it. Second,
// a page written and converted through the UI goes through fanotes-ocr and never loads
// onnxruntime-web, which would mean the renderer fell back to WASM. Needs an X display.

const assert = require('node:assert/strict')
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
const unpacked = path.join(root, 'release', 'linux-unpacked')
const runtimeLibrary = fs.realpathSync(path.join(unpacked, 'resources', 'native-ocr', 'libonnxruntime.so.1'))
const sidecarPath = fs.realpathSync(path.join(unpacked, 'resources', 'native-ocr', 'fanotes-ocr'))
const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))

assert.ok(process.env.DISPLAY, 'check:packaged-native-ocr startet die gepackte App und braucht ein X-Display (DISPLAY).')

function processTree(rootPid) {
  const children = new Map()
  for (const entry of fs.readdirSync('/proc')) {
    if (!/^\d+$/u.test(entry)) continue
    let stat = ''
    try {
      stat = fs.readFileSync(`/proc/${entry}/stat`, 'utf8')
    } catch {
      continue
    }
    const parent = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1])
    if (!children.has(parent)) children.set(parent, [])
    children.get(parent).push(Number(entry))
  }
  const tree = []
  const queue = [rootPid]
  while (queue.length) {
    const pid = queue.shift()
    tree.push(pid)
    queue.push(...(children.get(pid) ?? []))
  }
  const read = (pid, file) => {
    try {
      return fs.readFileSync(`/proc/${pid}/${file}`, 'utf8')
    } catch {
      return ''
    }
  }
  return tree.map((pid) => {
    let executable = ''
    try {
      executable = fs.readlinkSync(`/proc/${pid}/exe`)
    } catch {
      executable = ''
    }
    const stat = read(pid, 'stat')
    return {
      pid,
      executable,
      maps: read(pid, 'maps'),
      rssKb: Number(read(pid, 'status').match(/^VmRSS:\s+(\d+)/mu)?.[1] ?? 0),
      parent: Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]),
    }
  }).filter((entry) => entry.executable)
}

const sidecarsOf = (pid) => processTree(pid).filter((entry) => entry.executable === sidecarPath)

async function connect(port) {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    let page = null
    try {
      page = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json())
        .find((candidate) => candidate.type === 'page' && candidate.url.includes('index.html'))
    } catch {
      page = null
    }
    if (page) {
      const socket = new WebSocket(page.webSocketDebuggerUrl)
      await new Promise((resolve, reject) => {
        socket.addEventListener('open', resolve, { once: true })
        socket.addEventListener('error', reject, { once: true })
      })
      let sequence = 0
      const pending = new Map()
      const listeners = new Map()
      socket.addEventListener('message', (event) => {
        const message = JSON.parse(event.data)
        if (message.method) listeners.get(message.method)?.(message.params)
        const callback = message.id && pending.get(message.id)
        if (!callback) return
        pending.delete(message.id)
        if (message.error) callback.reject(new Error(message.error.message))
        else callback.resolve(message.result)
      })
      const send = (method, params = {}) => new Promise((resolve, reject) => {
        const id = ++sequence
        pending.set(id, { resolve, reject })
        socket.send(JSON.stringify({ id, method, params }))
      })
      const evaluate = async (expression) => {
        const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
        if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text)
        return result.result.value
      }
      const until = async (expression, label, attempts = 150) => {
        for (let index = 0; index < attempts; index += 1) {
          if (await evaluate(expression).catch(() => false)) return
          await wait(200)
        }
        throw new Error(`Zeitüberschreitung: ${label}`)
      }
      return { send, evaluate, until, on: (method, listener) => listeners.set(method, listener), close: () => socket.close() }
    }
    await wait(200)
  }
  throw new Error('Das gepackte FaNotes-Fenster ist nicht erschienen.')
}

async function launch() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fanotes-native-ocr-home-'))
  const port = 24_000 + Math.floor(Math.random() * 4_000)
  const xauthority = process.env.XAUTHORITY || path.join(os.homedir(), '.Xauthority')
  const app = spawn(path.join(unpacked, 'fanotes'), [`--remote-debugging-port=${port}`], {
    env: {
      ...process.env,
      HOME: home,
      XDG_CONFIG_HOME: path.join(home, '.config'),
      XDG_DATA_HOME: path.join(home, '.local', 'share'),
      ...(fs.existsSync(xauthority) ? { XAUTHORITY: xauthority } : {}),
    },
    stdio: 'ignore',
  })
  let devtools = null
  const dispose = async () => {
    devtools?.close()
    if (app.exitCode === null && app.signalCode === null) {
      app.kill('SIGTERM')
      await Promise.race([new Promise((resolve) => app.once('exit', resolve)), wait(5_000)])
      if (app.exitCode === null && app.signalCode === null) app.kill('SIGKILL')
    }
    fs.rmSync(home, { recursive: true, force: true })
  }
  try {
    devtools = await connect(port)
    await devtools.until('Boolean(window.fanotes?.recognizeNativeHandwritingLine)', 'Preload')
    return { app, devtools, dispose }
  } catch (error) {
    await dispose()
    throw error
  }
}

const saveSettings = (devtools, changes) => devtools.evaluate(`(async () => {
  const bootstrap = await window.fanotes.bootstrap()
  if (bootstrap.onboardingRequired) {
    await window.fanotes.completeOnboarding((bootstrap.starterSubjects ?? []).slice(0, 1).map((subject) => subject?.name ?? subject))
  }
  const { settings } = await window.fanotes.bootstrap()
  await window.fanotes.saveSettings({ ...settings, ...${JSON.stringify(changes)} })
  return (await window.fanotes.bootstrap()).settings
})()`)

// `accepted` is the test recognizeCtcLine applies before it trusts a native result instead of
// falling back to WASM (src/lib/neuralTextRecognition.ts).
const convert = `window.fanotes.recognizeNativeHandwritingLine({ input: new Float32Array(32 * 128), width: 32, height: 128, threads: 2 })
  .then((native) => ({
    accepted: !(
      native.engine !== 'fanotes-ort-cpu'
      || !(native.probabilities instanceof Float32Array)
      || !Array.isArray(native.dims)
      || !Array.isArray(native.characters)
      || native.characters.some((character) => typeof character !== 'string' || Array.from(character).length !== 1)
    ),
    engine: native.engine,
    dims: native.dims,
    characters: native.characters.length,
    finite: Array.from(native.probabilities).every(Number.isFinite),
  }))`

async function firstConversionOnly() {
  const { app, devtools, dispose } = await launch()
  try {
    await wait(3_000)
    const startup = processTree(app.pid)
    assert.ok(startup.length >= 3, 'Die App sollte Haupt-, GPU- und Rendererprozess haben.')
    assert.ok(!startup.some((entry) => entry.executable === sidecarPath), 'fanotes-ocr darf beim Start nicht laufen.')
    assert.ok(!startup.some((entry) => entry.maps.includes('libonnxruntime')), 'Kein FaNotes-Prozess darf beim Start ONNX Runtime laden.')

    assert.deepEqual(await devtools.evaluate(convert), { accepted: true, engine: 'fanotes-ort-cpu', dims: [1, 4, 81], characters: 80, finite: true })
    const converted = processTree(app.pid)
    const sidecars = converted.filter((entry) => entry.executable === sidecarPath)
    assert.equal(sidecars.length, 1, 'Die erste Umwandlung startet genau einen fanotes-ocr-Prozess.')
    const [sidecar] = sidecars
    assert.equal(sidecar.parent, app.pid, 'fanotes-ocr ist ein Kindprozess des Electron-Hauptprozesses.')
    assert.ok(sidecar.maps.includes(runtimeLibrary), 'fanotes-ocr lädt die mitgelieferte ONNX Runtime.')
    assert.ok(sidecar.rssKb > 40 * 1024, `Nach der ersten Umwandlung hält fanotes-ocr das Modell (${sidecar.rssKb} kB).`)
    assert.ok(!converted.some((entry) => entry.executable !== sidecarPath && entry.maps.includes('libonnxruntime')), 'Electron selbst lädt keine ONNX Runtime.')

    await devtools.evaluate(convert)
    assert.deepEqual(sidecarsOf(app.pid).map((entry) => entry.pid), [sidecar.pid], 'Weitere Zeilen nutzen denselben Prozess.')

    // The keep-alive setting (0 = release right away) frees the model; the next conversion loads it again.
    assert.equal((await saveSettings(devtools, { ocrModelKeepAliveSeconds: 0 })).ocrModelKeepAliveSeconds, 0)
    await devtools.evaluate(convert)
    let released = false
    for (let attempt = 0; attempt < 50 && !released; attempt += 1) {
      await wait(200)
      released = sidecarsOf(app.pid).length === 0
    }
    assert.ok(released, 'Nach der Haltezeit gibt FaNotes das Modell frei.')
    await saveSettings(devtools, { ocrModelKeepAliveSeconds: 120 })
    assert.equal((await devtools.evaluate(convert)).engine, 'fanotes-ort-cpu')
    const restarted = sidecarsOf(app.pid)[0]
    assert.ok(restarted && restarted.pid !== sidecar.pid, 'Die nächste Umwandlung lädt das Modell erneut.')

    app.kill('SIGTERM')
    await new Promise((resolve) => app.once('exit', resolve))
    let orphan = true
    for (let attempt = 0; attempt < 25 && orphan; attempt += 1) {
      await wait(200)
      orphan = fs.existsSync(`/proc/${restarted.pid}`) && fs.readFileSync(`/proc/${restarted.pid}/stat`, 'utf8').includes('(fanotes-ocr)')
    }
    assert.ok(!orphan, 'Beim Beenden darf kein fanotes-ocr-Prozess zurückbleiben.')
    return { processes: startup.length, sidecarMb: Math.round(sidecar.rssKb / 1024) }
  } finally {
    await dispose()
  }
}

async function pageConversionUsesTheSidecar() {
  const { app, devtools, dispose } = await launch()
  try {
    const settings = await saveSettings(devtools, { experimentalHandwritingToText: true, desktopOcrModel: 'compact' })
    assert.equal(settings.desktopOcrModel, 'compact')
    await devtools.send('Page.reload')
    await wait(1_000)
    await devtools.until('Boolean(document.querySelector(".file-tree__entry-button"))', 'Dateibaum')
    await devtools.evaluate(`[...document.querySelectorAll('.file-tree__entry-button')].find((entry) => entry.textContent?.trim() === 'Welcome')?.click()`)
    await devtools.until('Boolean(document.querySelector(".unified-paper .cm-line"))', 'Notiz')
    await devtools.evaluate(`[...document.querySelectorAll('button')].filter((button) => button.textContent?.trim() === 'Pen').sort((a, b) => b.getBoundingClientRect().y - a.getBoundingClientRect().y)[0]?.click()`)
    await devtools.until('Boolean(document.querySelector(".lw-drawing-board.is-input-active"))', 'Stiftmodus')
    const paper = await devtools.evaluate(`(() => { const r = document.querySelector('.unified-paper').getBoundingClientRect(); return { x: r.left, y: r.top, bottom: innerHeight } })()`)
    const left = paper.x + 200
    const top = Math.min(paper.y + 260, paper.bottom - 260)
    for (const [[x0, y0], [x1, y1]] of [[[0, 0], [0, 80]], [[40, 0], [40, 80]], [[0, 40], [40, 40]], [[70, 30], [70, 80]], [[70, 12], [71, 13]]]) {
      await devtools.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: left + x0, y: top + y0 })
      await devtools.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: left + x0, y: top + y0, button: 'left', buttons: 1, clickCount: 1 })
      for (let step = 1; step <= 24; step += 1) {
        await devtools.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: left + x0 + ((x1 - x0) * step) / 24, y: top + y0 + ((y1 - y0) * step) / 24, button: 'left', buttons: 1 })
        await wait(8)
      }
      await devtools.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: left + x1, y: top + y1, button: 'left', buttons: 0, clickCount: 1 })
      await wait(250)
    }
    await wait(1_000)
    assert.equal(sidecarsOf(app.pid).length, 0, 'Schreiben allein lädt das Modell nicht.')

    const requested = []
    devtools.on('Network.requestWillBeSent', ({ request }) => {
      if (!request.url.startsWith('data:')) requested.push(request.url)
    })
    await devtools.send('Network.enable')
    await devtools.evaluate(`document.querySelector('.lw-convert-action').click()`)
    await devtools.until(`Boolean(document.querySelector('.lw-conversion-panel .lw-correction-field textarea')?.value.trim())`, 'Erkennung')
    await devtools.evaluate(`[...document.querySelectorAll('.lw-conversion-panel .lw-mode-switch button')].find((button) => button.textContent?.trim() === 'Text').click()`)
    await devtools.until(`(() => {
      const panel = document.querySelector('.lw-conversion-panel')
      return Boolean(panel.querySelector('.lw-correction-field textarea')?.value.trim()) && !panel.querySelector('.lw-spin') && /Text insert|Als Text einfügen/u.test(panel.innerText)
    })()`, 'Texterkennung')
    const text = await devtools.evaluate(`document.querySelector('.lw-conversion-panel .lw-correction-field textarea').value`)

    assert.ok(text.trim(), 'Die Seitenumwandlung liefert Text.')
    assert.equal(sidecarsOf(app.pid).length, 1, 'Die Seitenumwandlung startet fanotes-ocr.')
    assert.ok(requested.some((url) => /neuralTextRecognition-[\w-]+\.js$/u.test(url)), 'Der Netzwerkmitschnitt sieht die erst jetzt geladenen Erkennungsmodule.')
    assert.deepEqual(requested.filter((url) => /onnxruntime|ort-wasm/iu.test(url)), [], 'Der Renderer darf nicht auf onnxruntime-web ausweichen.')
    return { text: text.trim() }
  } finally {
    await dispose()
  }
}

async function main() {
  const startup = await firstConversionOnly()
  const page = await pageConversionUsesTheSidecar()
  console.log(`Gepackte App: beim Start kein ONNX Runtime/Modell in ${startup.processes} Prozessen; die erste Umwandlung startet fanotes-ocr (${startup.sidecarMb} MB), die Haltezeit gibt es frei, Beenden räumt auf; eine geschriebene Seite wird über fanotes-ocr ohne onnxruntime-web erkannt („${page.text}“).`)
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
