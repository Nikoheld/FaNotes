'use strict'

// Starts the packaged Linux app and checks that no process of it holds ONNX Runtime or the PyLaia
// model until the first conversion, that the conversion starts exactly one fanotes-ocr sidecar with
// the packaged runtime, and that the keep-alive setting and quitting end it. Needs an X display.

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
    const close = stat.lastIndexOf(')')
    const parent = Number(stat.slice(close + 2).split(' ')[1])
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
  return tree.map((pid) => {
    const read = (file) => {
      try {
        return fs.readFileSync(`/proc/${pid}/${file}`, 'utf8')
      } catch {
        return ''
      }
    }
    let executable = ''
    try {
      executable = fs.readlinkSync(`/proc/${pid}/exe`)
    } catch {
      executable = ''
    }
    const rss = Number(read('status').match(/^VmRSS:\s+(\d+)/mu)?.[1] ?? 0)
    return { pid, executable, maps: read('maps'), rssKb: rss, parent: Number(read('stat').slice(read('stat').lastIndexOf(')') + 2).split(' ')[1]) }
  }).filter((entry) => entry.executable)
}

async function connect(port) {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    try {
      const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
      const page = pages.find((candidate) => candidate.type === 'page' && candidate.url.includes('index.html'))
      if (page) {
        const socket = new WebSocket(page.webSocketDebuggerUrl)
        await new Promise((resolve, reject) => {
          socket.addEventListener('open', resolve, { once: true })
          socket.addEventListener('error', reject, { once: true })
        })
        let sequence = 0
        const pending = new Map()
        socket.addEventListener('message', (event) => {
          const message = JSON.parse(event.data)
          const callback = message.id && pending.get(message.id)
          if (!callback) return
          pending.delete(message.id)
          if (message.error) callback.reject(new Error(message.error.message))
          else callback.resolve(message.result)
        })
        const evaluate = async (expression) => {
          const id = ++sequence
          const result = await new Promise((resolve, reject) => {
            pending.set(id, { resolve, reject })
            socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }))
          })
          if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text)
          return result.result.value
        }
        return { evaluate, close: () => socket.close() }
      }
    } catch {
      // The window is still starting.
    }
    await wait(200)
  }
  throw new Error('Das gepackte FaNotes-Fenster ist nicht erschienen.')
}

const convert = `window.fanotes.recognizeNativeHandwritingLine({ input: new Float32Array(32 * 128), width: 32, height: 128, threads: 2 })
  .then((result) => ({ engine: result.engine, dims: result.dims, characters: result.characters.length, finite: Array.from(result.probabilities).every(Number.isFinite) }))`

async function main() {
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
  try {
    devtools = await connect(port)
    for (let attempt = 0; attempt < 100 && !(await devtools.evaluate('Boolean(window.fanotes?.recognizeNativeHandwritingLine)')); attempt += 1) await wait(100)
    await wait(3_000)

    const startup = processTree(app.pid)
    assert.ok(startup.length >= 3, 'Die App sollte Haupt-, GPU- und Rendererprozess haben.')
    assert.ok(!startup.some((entry) => entry.executable === sidecarPath), 'fanotes-ocr darf beim Start nicht laufen.')
    assert.ok(!startup.some((entry) => entry.maps.includes('libonnxruntime')), 'Kein FaNotes-Prozess darf beim Start ONNX Runtime laden.')

    const first = await devtools.evaluate(convert)
    assert.deepEqual(first, { engine: 'fanotes-ort-cpu', dims: [1, 4, 81], characters: 80, finite: true })
    const converted = processTree(app.pid)
    const sidecars = converted.filter((entry) => entry.executable === sidecarPath)
    assert.equal(sidecars.length, 1, 'Die erste Umwandlung startet genau einen fanotes-ocr-Prozess.')
    const [sidecar] = sidecars
    assert.equal(sidecar.parent, app.pid, 'fanotes-ocr ist ein Kindprozess des Electron-Hauptprozesses.')
    assert.ok(sidecar.maps.includes(runtimeLibrary), 'fanotes-ocr lädt die mitgelieferte ONNX Runtime.')
    assert.ok(sidecar.rssKb > 40 * 1024, `Nach der ersten Umwandlung hält fanotes-ocr das Modell (${sidecar.rssKb} kB).`)
    assert.ok(!converted.some((entry) => entry.executable !== sidecarPath && entry.maps.includes('libonnxruntime')), 'Electron selbst lädt keine ONNX Runtime.')

    await devtools.evaluate(convert)
    assert.deepEqual(processTree(app.pid).filter((entry) => entry.executable === sidecarPath).map((entry) => entry.pid), [sidecar.pid], 'Weitere Zeilen nutzen denselben Prozess.')

    // The keep-alive setting releases the model; the next conversion loads it again. A fresh profile
    // has to finish the first-run setup before settings can be saved.
    await devtools.evaluate(`(async () => {
      const bootstrap = await window.fanotes.bootstrap()
      if (bootstrap.onboardingRequired) {
        await window.fanotes.completeOnboarding((bootstrap.starterSubjects ?? []).slice(0, 1).map((subject) => subject?.name ?? subject))
      }
      const { settings } = await window.fanotes.bootstrap()
      await window.fanotes.saveSettings({ ...settings, ocrModelKeepAliveSeconds: 0 })
      return (await window.fanotes.bootstrap()).settings.ocrModelKeepAliveSeconds
    })()`).then((keepAlive) => assert.equal(keepAlive, 0))
    await devtools.evaluate(convert)
    let released = false
    for (let attempt = 0; attempt < 50 && !released; attempt += 1) {
      await wait(200)
      released = !processTree(app.pid).some((entry) => entry.executable === sidecarPath)
    }
    assert.ok(released, 'Nach der Haltezeit gibt FaNotes das Modell frei.')
    await devtools.evaluate(`(async () => {
      const { settings } = await window.fanotes.bootstrap()
      await window.fanotes.saveSettings({ ...settings, ocrModelKeepAliveSeconds: 120 })
    })()`)
    const reloaded = await devtools.evaluate(convert)
    assert.equal(reloaded.engine, 'fanotes-ort-cpu')
    const restarted = processTree(app.pid).find((entry) => entry.executable === sidecarPath)
    assert.ok(restarted && restarted.pid !== sidecar.pid, 'Die nächste Umwandlung lädt das Modell erneut.')

    devtools.close()
    devtools = null
    app.kill('SIGTERM')
    await new Promise((resolve) => app.once('exit', resolve))
    let orphan = true
    for (let attempt = 0; attempt < 25 && orphan; attempt += 1) {
      await wait(200)
      orphan = fs.existsSync(`/proc/${restarted.pid}`) && fs.readFileSync(`/proc/${restarted.pid}/stat`, 'utf8').includes('(fanotes-ocr)')
    }
    assert.ok(!orphan, 'Beim Beenden darf kein fanotes-ocr-Prozess zurückbleiben.')
    console.log(`Gepackte App: beim Start kein ONNX Runtime/Modell in ${startup.length} Prozessen; die erste Umwandlung startet fanotes-ocr (${Math.round(sidecar.rssKb / 1024)} MB), die Haltezeit gibt es frei, Beenden räumt auf.`)
  } finally {
    devtools?.close()
    if (app.exitCode === null && app.signalCode === null) app.kill('SIGKILL')
    fs.rmSync(home, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
