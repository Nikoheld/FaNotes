import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'vite'

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const holdoutRoot = path.resolve(process.env.FANOTES_NAS_HOLDOUT ?? '/mnt/truenas/Fabio/FaNotes Tests')
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'fanotes-nas-holdout-'))
const output = path.join(temporary, 'dist')
const profile = path.join(temporary, 'chromium')
const entryPath = path.join(temporary, 'entry.ts')
const trainingRoot = path.join(temporary, 'training')
const mime = new Map([
  ['.html', 'text/html; charset=utf-8'], ['.js', 'text/javascript; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'], ['.json', 'application/json; charset=utf-8'],
  ['.png', 'image/png'], ['.wasm', 'application/wasm'], ['.onnx', 'application/octet-stream'],
])

const editDistance = (first, second) => {
  let previous = Array.from({ length: second.length + 1 }, (_, index) => index)
  for (let firstIndex = 1; firstIndex <= first.length; firstIndex += 1) {
    const current = [firstIndex]
    for (let secondIndex = 1; secondIndex <= second.length; secondIndex += 1) {
      current.push(Math.min(
        previous[secondIndex] + 1,
        current[secondIndex - 1] + 1,
        previous[secondIndex - 1] + Number(first[firstIndex - 1] !== second[secondIndex - 1]),
      ))
    }
    previous = current
  }
  return previous[second.length]
}

const normalize = (value) => value.normalize('NFC').replace(/\s+/gu, '').trim()
const sha256File = (filePath) => {
  const digest = crypto.createHash('sha256')
  digest.update(fs.readFileSync(filePath))
  return digest.digest('hex')
}
const imageFiles = fs.readdirSync(holdoutRoot, { withFileTypes: true })
  .filter((entry) => entry.isFile() && entry.name.toLocaleLowerCase('en').endsWith('.png'))
  .map((entry) => entry.name)
  .sort((first, second) => first.localeCompare(second, 'de'))
assert.ok(imageFiles.length > 0, `Keine PNG-Dateien in ${holdoutRoot} gefunden.`)

// The recognizer receives opaque IDs and image URLs only. Expected text stays
// in this outer evaluator and is joined back after inference has completed.
const cases = imageFiles.map((fileName, index) => ({
  id: `holdout-${String(index + 1).padStart(4, '0')}`,
  image: `/holdout/${String(index + 1).padStart(4, '0')}.png`,
}))
const expectedById = new Map(imageFiles.map((fileName, index) => [
  `holdout-${String(index + 1).padStart(4, '0')}`,
  path.basename(fileName, path.extname(fileName)),
]))
const fileByRoute = new Map(imageFiles.map((fileName, index) => [
  `/holdout/${String(index + 1).padStart(4, '0')}.png`,
  path.join(holdoutRoot, fileName),
]))

const glyphenwerkExport = path.resolve(
  process.env.FANOTES_GLYPHENWERK_EXPORT
    ?? path.join(holdoutRoot, 'glyphenwerk-datensatz-2026-07-17.zip'),
)
assert.ok(fs.statSync(glyphenwerkExport).isFile(), `GlyphenWerk-Export nicht gefunden: ${glyphenwerkExport}`)

const run = (command, arguments_) => new Promise((resolve, reject) => {
  const child = spawn(command, arguments_, { stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk) => { stdout += chunk })
  child.stderr.on('data', (chunk) => { stderr += chunk })
  child.once('error', reject)
  child.once('close', (code) => code === 0
    ? resolve(stdout)
    : reject(new Error(`${command} wurde mit ${code} beendet: ${stderr.slice(-2_000)}`)))
})

let server
let chromium
try {
  const archiveEntries = String(await run('unzip', ['-Z1', glyphenwerkExport])).split(/\r?\n/u).filter(Boolean)
  assert.ok(archiveEntries.length > 0 && archiveEntries.length <= 5_000, 'Der GlyphenWerk-Export besitzt eine ungültige Dateianzahl.')
  archiveEntries.forEach((entry) => {
    assert.ok(
      !entry.startsWith('/')
      && !entry.split('/').includes('..')
      && (/^(?:images\/[a-f0-9-]+\.png|manifest\.jsonl|layout_examples\.jsonl|labels\.(?:json|csv)|README\.txt|images\/)$/u.test(entry)),
      `Unsicherer Eintrag im GlyphenWerk-Export: ${entry}`,
    )
  })
  fs.mkdirSync(trainingRoot)
  await run('unzip', ['-q', glyphenwerkExport, '-d', trainingRoot])
  const trainingImageHashes = new Set(
    fs.readdirSync(path.join(trainingRoot, 'images'), { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.png'))
      .map((entry) => sha256File(path.join(trainingRoot, 'images', entry.name))),
  )
  const holdoutHashes = new Map(imageFiles.map((fileName) => [
    fileName,
    sha256File(path.join(holdoutRoot, fileName)),
  ]))
  const exactImageOverlap = [...holdoutHashes.values()].filter((hash) => trainingImageHashes.has(hash))
  assert.deepEqual(exactImageOverlap, [], 'Ein NAS-Holdoutbild ist bytegleich in der Trainings-ZIP enthalten.')
  fs.writeFileSync(entryPath, [
    `import { runNasHandwritingHoldout } from ${JSON.stringify(pathToFileURL(path.join(appRoot, 'scripts/fixtures/nas-handwriting-holdout-harness.ts')).href)}`,
    `runNasHandwritingHoldout(${JSON.stringify(cases)}, './training/export.zip').then((result) => {`,
    ' document.body.innerHTML = `<pre id="result">${JSON.stringify(result)}</pre>`',
    '}).catch((error) => {',
    ' document.body.innerHTML = `<pre id="error">${String(error?.stack || error)}</pre>`',
    '})',
  ].join('\n'))
  await build({
    root: appRoot,
    publicDir: false,
    logLevel: 'error',
    build: {
      outDir: output,
      emptyOutDir: true,
      lib: { entry: entryPath, formats: ['es'], fileName: () => 'audit.js' },
    },
  })
  fs.writeFileSync(path.join(output, 'index.html'), '<!doctype html><html><body><script type="module" src="./audit.js"></script></body></html>')
  server = http.createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost')
    const holdoutFile = fileByRoute.get(url.pathname)
    const trainingArchive = url.pathname === '/training/export.zip' ? glyphenwerkExport : null
    const relative = decodeURIComponent(url.pathname).replace(/^\/+|\.\./gu, '') || 'index.html'
    const root = relative.startsWith('ocr/') || relative.startsWith('spell/')
      ? path.join(appRoot, 'public')
      : output
    const target = holdoutFile ?? trainingArchive ?? path.join(root, relative)
    if (
      (!holdoutFile && !trainingArchive && !target.startsWith(root))
      || !fs.existsSync(target)
      || !fs.statSync(target).isFile()
    ) return response.writeHead(404).end()
    response.setHeader('Content-Type', mime.get(path.extname(target)) ?? 'application/octet-stream')
    response.setHeader('Content-Length', fs.statSync(target).size)
    response.setHeader('Cross-Origin-Opener-Policy', 'same-origin')
    response.setHeader('Cross-Origin-Embedder-Policy', 'require-corp')
    response.setHeader('Cross-Origin-Resource-Policy', 'same-origin')
    fs.createReadStream(target).pipe(response)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  chromium = spawn('chromium', [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
    '--js-flags=--max-old-space-size=1024', `--user-data-dir=${profile}`,
    '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0',
    `http://127.0.0.1:${port}/`,
  ], { stdio: ['ignore', 'pipe', 'pipe'] })
  let stderr = ''
  chromium.stderr.on('data', (chunk) => { stderr += chunk })
  const activePortFile = path.join(profile, 'DevToolsActivePort')
  for (let attempt = 0; attempt < 240 && !fs.existsSync(activePortFile); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  assert.ok(fs.existsSync(activePortFile), stderr)
  const debugPort = fs.readFileSync(activePortFile, 'utf8').split(/\r?\n/u)[0]
  let page
  for (let attempt = 0; attempt < 120 && !page; attempt += 1) {
    const pages = await fetch(`http://127.0.0.1:${debugPort}/json`).then((response) => response.json()).catch(() => [])
    page = pages.find((entry) => entry.type === 'page' && entry.url.startsWith(`http://127.0.0.1:${port}/`))
    if (!page) await new Promise((resolve) => setTimeout(resolve, 50))
  }
  assert.ok(page?.webSocketDebuggerUrl)
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
  await call('Runtime.enable')
  let state
  for (let attempt = 0; attempt < 960; attempt += 1) {
    const response = await call('Runtime.evaluate', {
      expression: `({ result: document.querySelector('#result')?.textContent ?? '', error: document.querySelector('#error')?.textContent ?? '' })`,
      returnByValue: true,
    }).catch(() => null)
    state = response?.result?.value
    if (state?.result || state?.error) break
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  socket.close()
  assert.equal(state?.error, '', state?.error)
  assert.ok(state?.result, stderr.slice(-3_000))
  const predictions = JSON.parse(state.result)
  const results = predictions.cases.map((entry) => {
    const expected = expectedById.get(entry.id)
    assert.ok(expected, `Unbekannte Holdout-ID ${entry.id}.`)
    const neuralEdits = editDistance(normalize(expected), normalize(entry.prediction))
    const edits = editDistance(normalize(expected), normalize(entry.personalizedPrediction))
    const blindEdits = editDistance(normalize(expected), normalize(entry.blindPrediction))
    return { ...entry, expected, neuralEdits, edits, blindEdits }
  })
  const edits = results.reduce((sum, entry) => sum + entry.edits, 0)
  const blindEdits = results.reduce((sum, entry) => sum + entry.blindEdits, 0)
  const characters = results.reduce((sum, entry) => sum + Array.from(normalize(entry.expected)).length, 0)
  const summary = {
    dataIsolation: {
      trainingArchive: { sha256: sha256File(glyphenwerkExport), imageCount: trainingImageHashes.size },
      holdouts: Object.fromEntries(holdoutHashes),
      exactImageOverlap: exactImageOverlap.length,
      expectedTextExposedToRecognizer: false,
    },
    importResult: predictions.importResult,
    resources: predictions.resources,
    edits,
    blindEdits,
    characters,
    cer: edits / Math.max(1, characters),
    blindCer: blindEdits / Math.max(1, characters),
    cases: results,
  }
  console.log(JSON.stringify(summary, null, 2))
  if (process.env.FANOTES_NAS_HOLDOUT_STRICT === '1') {
    assert.equal(edits, 0, `Der NAS-Holdout enthält noch ${edits} Zeichenfehler mit normalem Modellprior.`)
  }
  // This diagnostic deliberately replaces the independent text model with
  // the impossible value "∫∫" for every multi-letter word. It measures a
  // personal-template-only fallback, not the production recognition stack.
  // Keep it observable and optionally gate it separately; the real strict
  // holdout above must never be weakened by or confused with this ablation.
  if (process.env.FANOTES_NAS_HOLDOUT_BLIND_STRICT === '1') {
    assert.equal(blindEdits, 0, `Der NAS-Holdout enthält noch ${blindEdits} Zeichenfehler nach einer absichtlich falschen Mathematikvorhersage.`)
  }
} finally {
  if (chromium && chromium.exitCode === null) {
    const closed = new Promise((resolve) => chromium.once('close', resolve))
    chromium.kill('SIGTERM')
    await Promise.race([closed, new Promise((resolve) => setTimeout(resolve, 2_000))])
  }
  if (server) await new Promise((resolve) => server.close(resolve))
  fs.rmSync(temporary, { recursive: true, force: true, maxRetries: 24, retryDelay: 100 })
}
