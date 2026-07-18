import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'fanotes-neural-text-'))
const output = path.join(temporary, 'dist')
const profile = path.join(temporary, 'chromium')
const mime = new Map([
  ['.html', 'text/html; charset=utf-8'], ['.js', 'text/javascript; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'], ['.json', 'application/json; charset=utf-8'],
  ['.wasm', 'application/wasm'], ['.onnx', 'application/octet-stream'],
])
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

let server
try {
  await build({
    root: appRoot,
    publicDir: path.join(appRoot, 'public'),
    logLevel: 'error',
    build: {
      outDir: output,
      emptyOutDir: true,
      lib: {
        entry: path.join(appRoot, 'scripts/fixtures/neural-text-recognition-harness.ts'),
        formats: ['es'],
        fileName: () => 'harness.js',
      },
    },
  })
  fs.writeFileSync(path.join(output, 'index.html'), '<!doctype html><html><body><script type="module" src="./harness.js"></script></body></html>')
  server = http.createServer((request, response) => {
    const relative = decodeURIComponent(new URL(request.url ?? '/', 'http://localhost').pathname).replace(/^\/+|\.\./gu, '') || 'index.html'
    const target = path.join(output, relative)
    if (!target.startsWith(output) || !fs.existsSync(target) || !fs.statSync(target).isFile()) {
      response.writeHead(404).end('Not found')
      return
    }
    response.setHeader('Content-Type', mime.get(path.extname(target)) ?? 'application/octet-stream')
    response.setHeader('Content-Length', fs.statSync(target).size)
    response.setHeader('Cross-Origin-Opener-Policy', 'same-origin')
    response.setHeader('Cross-Origin-Embedder-Policy', 'require-corp')
    response.setHeader('Cross-Origin-Resource-Policy', 'same-origin')
    fs.createReadStream(target).pipe(response)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  const chromium = spawn('chromium', [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
    '--disable-background-networking', '--disable-component-update', '--disable-sync',
    '--metrics-recording-only', '--no-first-run',
    `--user-data-dir=${profile}`, '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0',
    `http://127.0.0.1:${port}/`,
  ], { stdio: ['ignore', 'pipe', 'pipe'] })
  let stderr = ''
  chromium.stderr.on('data', (chunk) => { stderr += chunk })
  const activePortFile = path.join(profile, 'DevToolsActivePort')
  for (let attempt = 0; attempt < 100 && !fs.existsSync(activePortFile); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  assert.ok(fs.existsSync(activePortFile), `Chromium-Debugging wurde nicht bereit: ${stderr}`)
  const debugPort = fs.readFileSync(activePortFile, 'utf8').split(/\r?\n/u)[0]
  let pages = []
  let page
  for (let attempt = 0; attempt < 80 && !page; attempt += 1) {
    pages = await fetch(`http://127.0.0.1:${debugPort}/json`).then((response) => response.json()).catch(() => [])
    page = pages.find((entry) => (
      entry.type === 'page'
      && typeof entry.url === 'string'
      && entry.url.startsWith(`http://127.0.0.1:${port}/`)
    ))
    if (!page) await new Promise((resolve) => setTimeout(resolve, 50))
  }
  assert.ok(page?.webSocketDebuggerUrl, `Kein Chromium-Tab für die Erkennungsprüfung: ${stderr}`)
  const socket = new WebSocket(page.webSocketDebuggerUrl)
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
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text)
    return response.result.value
  }
  await call('Runtime.enable')
  let state = null
  // A resource-capped CI run may deliberately compile the ONNX/WebAssembly
  // graph much more slowly than an end-user machine. Wait for the complete
  // fixture instead of turning that throttling into an empty-result failure;
  // the per-recognition assertions below still enforce the actual cold/warm
  // latency budgets reported by the browser.
  for (let attempt = 0; attempt < 720; attempt += 1) {
    state = await evaluate(`(() => ({ result: document.querySelector('#result')?.textContent ?? '', error: document.querySelector('#error')?.textContent ?? '' }))()`)
    if (state.result || state.error) break
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  socket.close()
  const chromiumClosed = new Promise((resolve) => chromium.once('close', resolve))
  chromium.kill('SIGTERM')
  await Promise.race([chromiumClosed, new Promise((resolve) => setTimeout(resolve, 2_000))])
  assert.equal(state?.error, '', state?.error)
  assert.ok(state?.result, `Kein Ergebnis der neuronalen Erkennung: ${stderr.slice(-3000)}`)
  const result = JSON.parse(state.result)
  const iamCharacterErrorRate = editDistance(
    result.iamOnline.recognized,
    result.iamOnline.expected,
  ) / result.iamOnline.expected.length
  assert.ok(
    iamCharacterErrorRate <= .24,
    `Die echte, bisher ungesehene IAM-OnDB-Stiftzeile ist zu ungenau: ${JSON.stringify({ ...result.iamOnline, iamCharacterErrorRate })}`,
  )
  assert.ok(result.iamOnline.confidence >= 80, `Die echte IAM-OnDB-Stiftzeile ist zu unsicher: ${JSON.stringify(result.iamOnline)}`)
  if (result.iamOnline.engine === 'pylaia-iam') {
    assert.match(
      result.iamOnline.beamText,
      /^By Trevor/u,
      `Der CTC-Strahl muss eine visuell plausible Namensalternative zurückholen: ${JSON.stringify(result.iamOnline)}`,
    )
  } else {
    assert.match(
      result.iamOnline.recognized,
      /^By Trevor/u,
      `Das bilinguale TrOCR-Modell muss den ungesehenen Namen erhalten: ${JSON.stringify(result.iamOnline)}`,
    )
  }
  assert.equal(
    result.words.find((entry) => entry.expected === 'mathe')?.recognized,
    'mathe',
    `Der Browserpfad muss eine vollständige verbundene Testform lesen: ${JSON.stringify(result.words)}`,
  )
  assert.deepEqual(
    result.words.map((entry) => entry.recognized),
    result.words.map((entry) => entry.expected),
    `Die kontrollierten verbundenen Textzeilen müssen vollständig erkannt werden: ${JSON.stringify(result.words)}`,
  )
  assert.ok(
    result.words.every((entry) => entry.recognized.length >= 2 && entry.lines === 1),
    `Alle gerenderten Stiftzeilen müssen einen zusammenhängenden Textpfad liefern: ${JSON.stringify(result.words)}`,
  )
  assert.ok(result.words.every((entry) => entry.confidence >= 65), `Mindestens eine Textzeile ist zu unsicher: ${JSON.stringify(result.words)}`)
  assert.equal(result.groupedLines, 2, 'Zwei physische Schreibzeilen müssen getrennt verarbeitet werden.')
  assert.equal(result.multiline.split('\n').length, 2, `Mehrzeilige Handschrift wurde nicht als zwei Textzeilen geliefert: ${result.multiline}`)
  assert.ok(result.multilineConfidence >= 75, `Die mehrzeilige Erkennung ist zu unsicher: ${result.multilineConfidence}`)
  assert.equal(
    result.preservedUnknownWords,
    'FaNotes Niko Fabio Livia Aylin OpenCode',
    'Eigennamen und unbekannte Fachbegriffe dürfen nicht aggressiv durch Wörterbuchtreffer ersetzt werden.',
  )
  assert.deepEqual(
    result.repairedWords,
    ['Test', 'ist', 'lernen'],
    `Nahe, nicht sinnvolle Wortformen müssen iterativ und konservativ repariert werden: ${JSON.stringify(result.repairedWords)}`,
  )
  assert.deepEqual(
    result.ensembleGuards,
    {
      preservesUnknownName: true,
      preservesMixedCaseTerm: true,
      acceptsClearFallback: true,
    },
    `Die visuelle und kontextuelle Texterkennung muss Namen/Fachbegriffe schützen und zugleich klaren Modell-Fallback zulassen: ${JSON.stringify(result.ensembleGuards)}`,
  )
  const warmAverage = Math.round(result.words.slice(1).reduce((sum, entry) => sum + entry.durationMs, 0) / (result.words.length - 1))
  console.log(`IAM-Dekodierung: ${JSON.stringify(result.iamOnline)}`)
  console.log(`Neuronale Handschrifterkennung: echte IAM-OnDB-Zeile mit ${(iamCharacterErrorRate * 100).toFixed(2)} % CER · ${result.words.map((entry) => entry.recognized).join(' · ')} · zwei Zeilen mit ${result.multilineConfidence} % · kalt ${result.words[0].durationMs} ms, warm ${warmAverage} ms.`)
  // Keep performance assertions last so a slow/contended CI host cannot hide
  // a preceding recognition-quality regression from the diagnostic output.
  assert.ok(result.words[0].durationMs < 10_000, `Das bedarfsgeladene Modell startet zu langsam: ${result.words[0].durationMs} ms`)
  assert.ok(result.words.slice(1).every((entry) => entry.durationMs < 1_500), `Eine warme Textzeile ist zu langsam: ${JSON.stringify(result.words)}`)
} finally {
  if (server) await new Promise((resolve) => server.close(resolve))
  // Chromium may finish after its profile writer has queued one final file.
  // Cleanup is best-effort and must never hide the actual recognition result.
  await new Promise((resolve) => setTimeout(resolve, 250))
  try {
    fs.rmSync(temporary, {
      recursive: true,
      force: true,
      maxRetries: 24,
      retryDelay: 100,
    })
  } catch (error) {
    console.warn(`Temporäres Chromium-Profil wird später bereinigt: ${error.code ?? error}`)
  }
}
