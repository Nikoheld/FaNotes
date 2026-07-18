import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const executable = path.join(root, 'release/linux-unpacked/fanotes')
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'fanotes-packaged-neural-'))
const debugPort = 29_000 + Math.floor(Math.random() * 5_000)
const liveUrl = process.env.FANOTES_NEURAL_URL?.trim()
const asset = fs.readdirSync(path.join(root, 'dist/assets'))
  .find((name) => /^neuralTextRecognition-.*\.js$/u.test(name))
const iamOnlineFixture = JSON.parse(fs.readFileSync(
  path.join(root, 'scripts/fixtures/iam-online-a01-001z-01.json'),
  'utf8',
))

if (!liveUrl) assert.ok(fs.existsSync(executable), 'Die entpackte Linux-App fehlt. Zuerst den Linux-Build erstellen.')
assert.ok(asset, 'Das gebaute Modul der neuronalen Texterkennung fehlt.')

const wait = (duration) => new Promise((resolve) => setTimeout(resolve, duration))
const editDistance = (first, second) => {
  const previous = Array.from({ length: second.length + 1 }, (_, index) => index)
  for (let firstIndex = 1; firstIndex <= first.length; firstIndex += 1) {
    const current = [firstIndex]
    for (let secondIndex = 1; secondIndex <= second.length; secondIndex += 1) {
      current.push(Math.min(
        previous[secondIndex] + 1,
        current[secondIndex - 1] + 1,
        previous[secondIndex - 1] + Number(first[firstIndex - 1] !== second[secondIndex - 1]),
      ))
    }
    previous.splice(0, previous.length, ...current)
  }
  return previous[second.length]
}

const shapes = {
  t: { main: [[0, .7], [.22, .64], [.44, .08], [.48, .82], [.72, .72], [1, .67]], accessories: [[[.24, .35], [.72, .34]]] },
  e: { main: [[0, .68], [.22, .51], [.72, .49], [.64, .27], [.25, .25], [.1, .48], [.18, .76], [.65, .82], [1, .65]] },
  s: { main: [[0, .65], [.28, .31], [.73, .3], [.84, .45], [.25, .66], [.2, .78], [.48, .87], [.86, .75], [1, .66]] },
}

const connectedWord = (value, left, top, width, height, variation) => {
  const connector = .008
  const main = []
  const accessories = []
  let time = 0
  ;[...value].forEach((character, characterIndex) => {
    const shape = shapes[character]
    const letterLeft = left + characterIndex * (width + connector)
    const map = (points, offset) => points.map(([x, y], pointIndex) => ({
      x: letterLeft + x * width,
      y: top + y * height + Math.sin((pointIndex + 1) * 1.71 + characterIndex) * variation,
      t: offset + pointIndex,
      pressure: .62,
      tiltX: 0,
      tiltY: 0,
      pointerType: 'pen',
    }))
    const current = map(shape.main, time)
    if (main.length) {
      const previous = main.at(-1)
      main.push({
        x: (previous.x + current[0].x) / 2,
        y: (previous.y + current[0].y) / 2,
        t: ++time,
        pressure: .62,
        tiltX: 0,
        tiltY: 0,
        pointerType: 'pen',
      })
    }
    current.forEach((entry) => main.push({ ...entry, t: ++time }))
    ;(shape.accessories ?? []).forEach((points, accessoryIndex) => accessories.push({
      baseWidth: 3.7,
      pressureEnabled: true,
      points: map(points, 10_000 + characterIndex * 100 + accessoryIndex * 10),
    }))
  })
  return [{ baseWidth: 3.7, pressureEnabled: true, points: main }, ...accessories]
}

const child = liveUrl
  ? spawn('chromium', [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
    '--remote-debugging-address=127.0.0.1', `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${profile}`, liveUrl,
  ], {
    cwd: root,
    detached: process.platform !== 'win32',
    env: { ...process.env, HOME: profile },
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  : spawn('xvfb-run', [
    '-a', executable,
    '--no-sandbox', '--disable-dev-shm-usage', '--remote-debugging-address=127.0.0.1',
    `--remote-debugging-port=${debugPort}`, `--user-data-dir=${profile}`,
  ], {
  cwd: root,
  detached: process.platform !== 'win32',
  env: { ...process.env, HOME: profile },
  stdio: ['ignore', 'ignore', 'pipe'],
  })
let stderr = ''
child.stderr.on('data', (chunk) => { stderr += chunk })

let socket
try {
  let pages = []
  for (let attempt = 0; attempt < 160 && !pages.length; attempt += 1) {
    pages = await fetch(`http://127.0.0.1:${debugPort}/json`)
      .then((response) => response.json())
      .catch(() => [])
    if (!pages.length) await wait(100)
  }
  const page = pages.find((entry) => entry.type === 'page')
  assert.ok(page?.webSocketDebuggerUrl, `Die verpackte App wurde nicht bereit: ${stderr.slice(-3000)}`)

  socket = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true })
    socket.addEventListener('error', reject, { once: true })
  })
  let sequence = 0
  const pending = new Map()
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data)
    const handler = pending.get(message.id)
    if (!handler) return
    pending.delete(message.id)
    message.error ? handler.reject(new Error(message.error.message)) : handler.resolve(message.result)
  })
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence
    pending.set(id, { resolve, reject })
    socket.send(JSON.stringify({ id, method, params }))
  })
  const evaluate = async (expression) => {
    const response = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (response.exceptionDetails) {
      throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text)
    }
    return response.result.value
  }
  await call('Runtime.enable')
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await evaluate(`Boolean(window.fanotes?.loadHandwritingRecognitionResources)`)) break
    await wait(100)
  }
  const protocolProbe = liveUrl ? null : await evaluate(`(async () => {
    const url = 'fanotes-model://local/trocr-runtime/ort-wasm-simd-threaded.mjs'
    try {
      const response = await fetch(url)
      return { ok: response.ok, status: response.status, type: response.type, contentType: response.headers.get('content-type'), cors: response.headers.get('access-control-allow-origin'), bytes: (await response.arrayBuffer()).byteLength }
    } catch (error) {
      return { error: error?.message || String(error) }
    }
  })()`)
  const strokes = iamOnlineFixture.strokes.map((points) => ({
    baseWidth: 3.7,
    pressureEnabled: true,
    points: points.map(([x, y, t]) => ({
      x, y, t, pressure: .62, tiltX: 0, tiltY: 0, pointerType: 'pen',
    })),
  }))
  const result = await evaluate(`(async () => {
    const module = await import(new URL('./assets/${asset}', location.href).href)
    const startedAt = performance.now()
    const recognized = await module.recognizeNeuralText(
      ${JSON.stringify(strokes)},
      'en',
      ${iamOnlineFixture.sourceWidth},
      ${iamOnlineFixture.sourceHeight}
    )
    return { ...recognized, durationMs: Math.round(performance.now() - startedAt) }
  })()`)
  const characterErrorRate = editDistance(result.text, iamOnlineFixture.truth) / iamOnlineFixture.truth.length
  assert.equal(result.engine, 'trocr-bilingual', `Die neuronale Erkennung fiel unbemerkt auf eine schwächere Engine zurück: ${JSON.stringify(result)}`)
  assert.ok(!result.trocrFailures?.length, `TrOCR meldete Laufzeitfehler: ${JSON.stringify(result.trocrFailures)}`)
  assert.ok(characterErrorRate <= .08, `Verpackte App erkannte die echte IAM-OnDB-Stiftzeile zu ungenau: ${JSON.stringify({ ...result, expected: iamOnlineFixture.truth, characterErrorRate })}`)
  assert.ok(result.confidence >= 80, `Verpackte Erkennung ist zu unsicher: ${JSON.stringify(result)}`)
  if (!liveUrl) {
    assert.doesNotMatch(stderr, /gpu process (?:failed|crash)|fatal gpu|vulkan/iu, `GPU-/Vulkan-Fehler: ${stderr.slice(-3000)}`)
  }
  console.log(`${liveUrl ? 'Live-Web' : 'Verpackte'} neuronale Erkennung: ${result.text} mit ${(characterErrorRate * 100).toFixed(2)} % CER und ${result.confidence} % in ${result.durationMs} ms · ${result.engine} · ${JSON.stringify({ protocolProbe, lines: result.lines?.map((line) => ({ raw: line.rawText, beam: line.beamText, greedy: line.greedyText })), trocrFailures: result.trocrFailures })}`)
} finally {
  socket?.close()
  const stop = (signal) => {
    try {
      if (process.platform !== 'win32') process.kill(-child.pid, signal)
      else child.kill(signal)
    } catch {
      child.kill(signal)
    }
  }
  stop('SIGTERM')
  const closed = new Promise((resolve) => child.once('close', resolve))
  const stopped = await Promise.race([closed.then(() => true), wait(2_000).then(() => false)])
  if (!stopped) {
    stop('SIGKILL')
    await Promise.race([closed, wait(1_000)])
  }
  fs.rmSync(profile, { recursive: true, force: true })
}
