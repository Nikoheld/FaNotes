import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'vite'

const DATASET_URL = 'https://archive.ics.uci.edu/static/public/177/uji+pen+characters+version+2.zip'
const DATASET_SHA256 = '0881b522911b99d9922820289441b50fd3d307f71cd7f9cc70e86872424a5f90'
const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const personalizedAudit = process.env.FANOTES_TROCR_AUDIT_MODE === 'personalized'
const harnessFile = personalizedAudit
  ? 'uji-personalized-line-harness.ts'
  : 'trocr-preprocessing-sweep-harness.ts'
const harnessFunction = personalizedAudit
  ? 'runUjiPersonalizedLineAudit'
  : 'runTrocrPreprocessingSweep'
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'fanotes-trocr-sweep-'))
const archive = path.join(temporary, 'uji.zip')
const dataset = path.join(temporary, 'ujipenchars2.txt')
const output = path.join(temporary, 'dist')
const profile = path.join(temporary, 'chromium')
const requestedHeapMb = Number(process.env.FANOTES_UJI_CHROMIUM_HEAP_MB ?? '1024')
const chromiumHeapMb = Number.isFinite(requestedHeapMb)
  ? Math.max(512, Math.min(1536, Math.round(requestedHeapMb)))
  : 1024
const mime = new Map([
  ['.html', 'text/html; charset=utf-8'], ['.js', 'text/javascript; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'], ['.json', 'application/json; charset=utf-8'],
  ['.wasm', 'application/wasm'], ['.onnx', 'application/octet-stream'],
])

const obtainDataset = async () => {
  const local = process.env.FANOTES_UJI_DATASET?.trim()
  if (local) {
    fs.copyFileSync(local, dataset)
    return
  }
  const response = await fetch(DATASET_URL)
  assert.equal(response.status, 200)
  const bytes = new Uint8Array(await response.arrayBuffer())
  assert.equal(createHash('sha256').update(bytes).digest('hex'), DATASET_SHA256)
  fs.writeFileSync(archive, bytes)
  const unzip = spawn('unzip', ['-q', archive, 'ujipenchars2.txt', '-d', temporary], { stdio: 'inherit' })
  assert.equal(await new Promise((resolve) => unzip.on('close', resolve)), 0)
}

const parseDataset = (source) => {
  const lines = source.split(/\r?\n/u)
  const records = []
  for (let cursor = 0; cursor < lines.length; cursor += 1) {
    const header = /^WORD\s+(\S+)\s+((?:trn|tst)_(?:UJI|UPV)_W\d+)-(0[12])$/u.exec(lines[cursor].trim())
    if (!header || !/^[A-Za-z0-9]$/u.test(header[1])) continue
    const countHeader = /^NUMSTROKES\s+(\d+)$/u.exec((lines[++cursor] ?? '').trim())
    assert.ok(countHeader)
    const strokes = []
    for (let strokeIndex = 0; strokeIndex < Number(countHeader[1]); strokeIndex += 1) {
      const points = /^POINTS\s+(\d+)\s+#\s+(.+)$/u.exec((lines[++cursor] ?? '').trim())
      assert.ok(points)
      const values = points[2].trim().split(/\s+/u).map(Number)
      assert.equal(values.length, Number(points[1]) * 2)
      strokes.push(Array.from({ length: Number(points[1]) }, (_, index) => [values[index * 2], values[index * 2 + 1]]))
    }
    records.push({ char: header[1], writer: header[2], session: Number(header[3]), strokes })
  }
  return records
}

let server
try {
  await obtainDataset()
  const records = parseDataset(fs.readFileSync(dataset, 'utf8'))
  assert.equal(records.length, 7_440)
  const entryPath = path.join(temporary, 'entry.ts')
  fs.writeFileSync(entryPath, [
    `import { ${harnessFunction} } from ${JSON.stringify(pathToFileURL(path.join(appRoot, 'scripts/fixtures', harnessFile)).href)}`,
    `fetch('./uji-data.json').then((response) => response.json()).then(${harnessFunction}).then((result) => {`,
    ' document.body.innerHTML = `<pre id="result">${JSON.stringify(result)}</pre>`',
    '}).catch((error) => {',
    ' document.body.innerHTML = `<pre id="error">${String(error?.stack || error)}</pre>`',
    '})',
  ].join('\n'))
  await build({
    root: appRoot, publicDir: false, logLevel: 'error',
    build: { outDir: output, emptyOutDir: true, lib: { entry: entryPath, formats: ['es'], fileName: () => 'sweep.js' } },
  })
  fs.writeFileSync(path.join(output, 'uji-data.json'), JSON.stringify(records))
  fs.writeFileSync(path.join(output, 'index.html'), '<!doctype html><html><body><script type="module" src="./sweep.js"></script></body></html>')
  server = http.createServer((request, response) => {
    const relative = decodeURIComponent(new URL(request.url ?? '/', 'http://localhost').pathname).replace(/^\/+|\.\./gu, '') || 'index.html'
    const root = relative.startsWith('ocr/') || relative.startsWith('spell/')
      ? path.join(appRoot, 'public')
      : output
    const target = path.join(root, relative)
    if (!target.startsWith(root) || !fs.existsSync(target) || !fs.statSync(target).isFile()) return response.writeHead(404).end()
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
    `--js-flags=--max-old-space-size=${chromiumHeapMb}`, `--user-data-dir=${profile}`,
    '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0',
    `http://127.0.0.1:${port}/?${new URLSearchParams({
      ...(process.env.FANOTES_UJI_WRITER ? { writer: process.env.FANOTES_UJI_WRITER } : {}),
      ...(process.env.FANOTES_UJI_ALL_WRITERS === '1' ? { scope: 'all' } : {}),
      ...(process.env.FANOTES_UJI_WRITER_LIMIT ? { limit: process.env.FANOTES_UJI_WRITER_LIMIT } : {}),
      ...(process.env.FANOTES_UJI_WRITER_OFFSET
        ? { 'writer-offset': process.env.FANOTES_UJI_WRITER_OFFSET }
        : {}),
      ...(process.env.FANOTES_UJI_WORDS_PER_WRITER
        ? { 'words-per-writer': process.env.FANOTES_UJI_WORDS_PER_WRITER }
        : {}),
      ...(process.env.FANOTES_UJI_WORD_OFFSET
        ? { 'word-offset': process.env.FANOTES_UJI_WORD_OFFSET }
        : {}),
      ...(process.env.FANOTES_UJI_CORPUS
        ? { corpus: process.env.FANOTES_UJI_CORPUS }
        : {}),
      ...(process.env.FANOTES_UJI_DIAGNOSTICS === '0' ? { diagnostics: '0' } : {}),
      ...(process.env.FANOTES_UJI_WORD_DIAGNOSTICS === '1' ? { 'word-diagnostics': '1' } : {}),
      ...(process.env.FANOTES_UJI_BLIND_RASTER === '1' ? { 'blind-raster': '1' } : {}),
      ...(process.env.FANOTES_UJI_DIAGNOSTIC_EXPECTED_COUNT === '1'
        ? { 'diagnostic-count': 'expected' }
        : {}),
      ...(process.env.FANOTES_UJI_DIAGNOSTIC_INDEX
        ? { 'diagnostic-index': process.env.FANOTES_UJI_DIAGNOSTIC_INDEX }
        : {}),
      ...(process.env.FANOTES_UJI_MOCK_NEURAL === '1' ? { 'mock-neural': '1' } : {}),
    })}`,
  ], { stdio: ['ignore', 'pipe', 'pipe'] })
  let stderr = ''
  chromium.stderr.on('data', (chunk) => { stderr += chunk })
  const activePortFile = path.join(profile, 'DevToolsActivePort')
  for (let attempt = 0; attempt < 160 && !fs.existsSync(activePortFile); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 50))
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
  const evaluate = (expression) => call('Runtime.evaluate', { expression, returnByValue: true })
  await call('Runtime.enable')
  let state
  for (let attempt = 0; attempt < 720; attempt += 1) {
    const response = await evaluate(`({ result: document.querySelector('#result')?.textContent ?? '', error: document.querySelector('#error')?.textContent ?? '' })`)
      .catch(() => null)
    if (!response?.result?.value) {
      await new Promise((resolve) => setTimeout(resolve, 250))
      continue
    }
    state = response.result.value
    if (state.result || state.error) break
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  socket.close()
  const chromiumClosed = new Promise((resolve) => chromium.once('close', resolve))
  chromium.kill('SIGTERM')
  await Promise.race([chromiumClosed, new Promise((resolve) => setTimeout(resolve, 2_000))])
  assert.equal(state?.error, '', state?.error)
  assert.ok(state?.result, stderr.slice(-3_000))
  const result = JSON.parse(state.result)
  if (process.env.FANOTES_UJI_STRICT === '1') {
    assert.equal(
      result.fusedEdits,
      0,
      `Die personalisierte UJI-Fusion enthält noch Zeichenfehler: ${JSON.stringify(result.cases?.filter((entry) => entry.fusedEdits > 0))}`,
    )
  }
  const printable = process.env.FANOTES_UJI_SEGMENTATION_COMPACT === '1'
    ? {
        characters: result.characters,
        neuralEdits: result.neuralEdits,
        fusedEdits: result.fusedEdits,
        cases: result.cases?.map((entry) => ({
          writer: entry.writer,
          expected: entry.expected,
          neural: entry.neural,
          neuralLines: entry.neuralLines,
          fused: entry.fused,
          fusion: entry.fusion,
          candidateScores: entry.candidateScores,
          rasterDecision: entry.rasterDecision,
          penLiftCharacterCount: entry.penLiftCharacterCount,
          blindRaster: entry.blindRaster,
          segmentationCandidates: entry.segmentationCandidates?.map((candidate) => ({
            count: candidate.count,
            segmentationIndex: candidate.segmentationIndex,
            recognized: candidate.recognized,
            fused: candidate.fused,
            dictionaryCandidate: candidate.dictionaryCandidate && {
              text: candidate.dictionaryCandidate.text,
              changes: candidate.dictionaryCandidate.changes,
            },
            compactDictionaryCandidate: candidate.compactDictionaryCandidate && {
              text: candidate.compactDictionaryCandidate.text,
              changes: candidate.compactDictionaryCandidate.changes,
            },
            contextualDictionaryCandidate: candidate.contextualDictionaryCandidate && {
              text: candidate.contextualDictionaryCandidate.text,
              changes: candidate.contextualDictionaryCandidate.changes,
            },
            score: candidate.score,
            tokenCount: candidate.tokenCount,
            tokens: candidate.tokens?.map((token) => ({
              char: token.char,
              confidence: token.confidence,
              personalSupport: token.personalSupport,
              personalConfidence: token.personalConfidence,
            })),
          })),
        })),
      }
    : process.env.FANOTES_UJI_WORD_DIAGNOSTICS_COMPACT === '1'
    ? {
        neuralCer: result.neuralCer,
        fusedCer: result.fusedCer,
        cases: result.cases?.map((entry) => ({
          writer: entry.writer,
          expected: entry.expected,
          neural: entry.neural,
          fused: entry.fused,
          fusion: entry.fusion,
          candidateScores: entry.candidateScores,
          rasterDecision: entry.rasterDecision,
          blindRaster: entry.blindRaster,
          expectedWordCandidates: entry.expectedWordCandidates?.map((word) => ({
            expected: word.expected,
            neuralWord: word.neuralWord,
            neuralDictionaryCandidate: word.neuralDictionaryCandidate,
          })),
        })),
      }
    : result
  console.log(JSON.stringify(printable, null, 2))
} finally {
  if (server) await new Promise((resolve) => server.close(resolve))
  await new Promise((resolve) => setTimeout(resolve, 250))
  try {
    fs.rmSync(temporary, { recursive: true, force: true, maxRetries: 24, retryDelay: 100 })
  } catch (error) {
    console.warn(`Temporäres TrOCR-Profil wird später entfernt: ${error.code ?? error}`)
  }
}
