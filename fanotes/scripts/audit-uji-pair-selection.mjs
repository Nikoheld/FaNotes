import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'vite'

// UJI Pen Characters v2, CC BY 4.0, DOI 10.24432/C5FG8S.
// Data is copied or downloaded only into this process' temporary directory.
const DATASET_URL = 'https://archive.ics.uci.edu/static/public/177/uji+pen+characters+version+2.zip'
const DATASET_SHA256 = '0881b522911b99d9922820289441b50fd3d307f71cd7f9cc70e86872424a5f90'
const MAX_ARCHIVE_BYTES = 5 * 1024 * 1024
const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const workspaceRoot = path.resolve(appRoot, '..')
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'fanotes-uji-pair-selection-'))
const archive = path.join(temporary, 'uji.zip')
const dataset = path.join(temporary, 'ujipenchars2.txt')
const output = path.join(temporary, 'dist')
const profile = path.join(temporary, 'chromium')

const boundedInteger = (name, fallback, minimum, maximum) => {
  const requested = Number(process.env[name])
  return Number.isFinite(requested)
    ? Math.max(minimum, Math.min(maximum, Math.round(requested)))
    : fallback
}

const pairLimit = boundedInteger('FANOTES_UJI_PAIR_SELECTION_PAIRS', 32, 1, 512)
const topN = boundedInteger('FANOTES_UJI_PAIR_SELECTION_TOP_N', 8, 1, 16)
const segmentationCandidates = boundedInteger(
  'FANOTES_UJI_PAIR_SELECTION_SEGMENTATIONS',
  3,
  1,
  6,
)
const chromiumHeap = boundedInteger('FANOTES_UJI_CHROMIUM_HEAP_MB', 768, 384, 1_536)
const timeoutMs = boundedInteger('FANOTES_UJI_PAIR_SELECTION_TIMEOUT_MS', 120_000, 30_000, 240_000)
const pairSubset = process.env.FANOTES_UJI_PAIR_SELECTION_SUBSET?.trim() || 'all'
assert.ok(
  ['all', 'digits', 'lowercase', 'uppercase', 'letters', 'mixed'].includes(pairSubset),
  'FANOTES_UJI_PAIR_SELECTION_SUBSET ist ungültig.',
)
const writer = process.env.FANOTES_UJI_PAIR_SELECTION_WRITER?.trim() || undefined
if (writer) {
  assert.match(writer, /^(?:trn|tst)_(?:UJI|UPV)_W\d+$/u, 'Ungültiger UJI-Schreibendenname.')
}

const downloadDataset = async () => {
  const local = process.env.FANOTES_UJI_DATASET?.trim()
  if (local) {
    assert.ok(fs.statSync(local).isFile(), 'FANOTES_UJI_DATASET muss auf eine Datei zeigen.')
    fs.copyFileSync(local, dataset)
    return
  }
  const response = await fetch(DATASET_URL)
  assert.equal(response.status, 200, 'Der UJI-Datensatz konnte nicht geladen werden.')
  const bytes = new Uint8Array(await response.arrayBuffer())
  assert.ok(bytes.byteLength > 0 && bytes.byteLength <= MAX_ARCHIVE_BYTES, 'Das UJI-Archiv hat eine unerwartete Grösse.')
  assert.equal(createHash('sha256').update(bytes).digest('hex'), DATASET_SHA256, 'Die UJI-Prüfsumme stimmt nicht.')
  fs.writeFileSync(archive, bytes)
  const unzip = spawn('unzip', ['-q', archive, 'ujipenchars2.txt', '-d', temporary], { stdio: 'inherit' })
  assert.equal(await new Promise((resolve) => unzip.on('close', resolve)), 0, 'Das UJI-Archiv konnte nicht entpackt werden.')
}

const parseDataset = (source) => {
  const lines = source.split(/\r?\n/u)
  const records = []
  for (let cursor = 0; cursor < lines.length; cursor += 1) {
    const header = /^WORD\s+(\S+)\s+((?:trn|tst)_(?:UJI|UPV)_W\d+)-(0[12])$/u.exec(lines[cursor].trim())
    if (!header || !/^[A-Za-z0-9]$/u.test(header[1])) continue
    const strokeHeader = /^NUMSTROKES\s+(\d+)$/u.exec((lines[++cursor] ?? '').trim())
    assert.ok(strokeHeader, `Ungültiger UJI-Stiftkopf bei Zeile ${cursor + 1}.`)
    const strokeCount = Number(strokeHeader[1])
    const strokes = []
    for (let strokeIndex = 0; strokeIndex < strokeCount; strokeIndex += 1) {
      const match = /^POINTS\s+(\d+)\s+#\s+(.+)$/u.exec((lines[++cursor] ?? '').trim())
      assert.ok(match, `Ungültiger UJI-Stiftzug bei Zeile ${cursor + 1}.`)
      const count = Number(match[1])
      const values = match[2].trim().split(/\s+/u).map(Number)
      assert.equal(values.length, count * 2, `Falsche UJI-Punktzahl bei Zeile ${cursor + 1}.`)
      strokes.push(Array.from({ length: count }, (_, index) => [
        values[index * 2],
        values[index * 2 + 1],
      ]))
    }
    records.push({
      char: header[1],
      writer: header[2],
      session: Number(header[3]),
      strokes,
    })
  }
  return records
}

const compactSummary = (result) => ({
  dataset: result.dataset,
  isolation: result.isolation,
  configuration: result.configuration,
  model: result.model,
  overall: result.overall,
  separated: result.separated,
  connected: result.connected,
})

const optionalThreshold = (name) => {
  if (process.env[name] === undefined) return null
  const value = Number(process.env[name])
  assert.ok(Number.isFinite(value) && value >= 0 && value <= 100, `${name} muss zwischen 0 und 100 liegen.`)
  return value
}

try {
  await downloadDataset()
  const records = parseDataset(fs.readFileSync(dataset, 'utf8'))
  assert.equal(records.length, 7_440, 'Der vollständige alphanumerische UJI-Satz wurde nicht gelesen.')
  const dataPath = path.join(temporary, 'uji-data.json')
  const entryPath = path.join(temporary, 'entry.ts')
  fs.writeFileSync(dataPath, JSON.stringify(records))
  fs.writeFileSync(entryPath, [
    `import records from ${JSON.stringify(pathToFileURL(dataPath).href)}`,
    `import { runUjiPairSelectionAudit } from ${JSON.stringify(pathToFileURL(path.join(appRoot, 'scripts/fixtures/uji-pair-selection-harness.ts')).href)}`,
    `runUjiPairSelectionAudit(records, ${JSON.stringify({
      writer,
      pairLimit,
      pairSubset,
      topN,
      segmentationCandidates,
      includeCases: process.env.FANOTES_UJI_PAIR_SELECTION_CASES === '1',
    })}).then((result) => {`,
    '  document.body.innerHTML = `<pre id="result">${JSON.stringify(result)}</pre>`',
    '}).catch((error) => {',
    '  document.body.innerHTML = `<pre id="error">${String(error?.stack || error)}</pre>`',
    '})',
  ].join('\n'))
  await build({
    root: workspaceRoot,
    logLevel: 'error',
    build: {
      outDir: output,
      emptyOutDir: true,
      lib: { entry: entryPath, formats: ['es'], fileName: () => 'audit.js' },
    },
  })
  fs.writeFileSync(
    path.join(output, 'index.html'),
    '<!doctype html><html><body><script type="module" src="./audit.js"></script></body></html>',
  )
  const chromium = spawn('chromium', [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
    '--disable-background-networking', '--renderer-process-limit=1',
    `--js-flags=--max-old-space-size=${chromiumHeap}`,
    '--allow-file-access-from-files', `--user-data-dir=${profile}`,
    `--virtual-time-budget=${timeoutMs}`, '--dump-dom',
    pathToFileURL(path.join(output, 'index.html')).href,
  ], { stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = ''
  let stderr = ''
  let timedOut = false
  chromium.stdout.on('data', (chunk) => { stdout += chunk })
  chromium.stderr.on('data', (chunk) => { stderr += chunk })
  const timeout = setTimeout(() => {
    timedOut = true
    chromium.kill('SIGKILL')
  }, timeoutMs)
  const exitCode = await new Promise((resolve) => chromium.on('close', resolve))
  clearTimeout(timeout)
  assert.equal(timedOut, false, `Der UJI-Paaraudit überschritt ${timeoutMs} ms.`)
  assert.equal(exitCode, 0, `Chromium konnte den UJI-Paaraudit nicht ausführen: ${stderr}`)
  const error = /<pre id="error">([\s\S]*?)<\/pre>/u.exec(stdout)?.[1]
  assert.equal(error, undefined, error)
  const encoded = /<pre id="result">([\s\S]*?)<\/pre>/u.exec(stdout)?.[1]
  assert.ok(encoded, `Kein UJI-Paarergebnis: ${stdout.slice(-1_800)}`)
  const result = JSON.parse(encoded.replaceAll('&quot;', '"').replaceAll('&amp;', '&'))
  assert.equal(result.isolation.trainingSession, 1)
  assert.equal(result.isolation.holdoutSession, 2)
  assert.equal(result.isolation.persistentWrites, false)
  assert.equal(result.isolation.sharedRecordObjects, 0)
  assert.equal(result.isolation.sharedTrajectories, 0)
  assert.equal(result.isolation.trainingSessionContamination, 0)
  assert.equal(result.isolation.holdoutSessionContamination, 0)
  assert.equal(result.separated.samples, result.connected.samples)

  const minimumTop1 = optionalThreshold('FANOTES_UJI_PAIR_SELECTION_MIN_TOP1')
  const minimumTopN = optionalThreshold('FANOTES_UJI_PAIR_SELECTION_MIN_TOP_N')
  const maximumCollapse = optionalThreshold('FANOTES_UJI_PAIR_SELECTION_MAX_COLLAPSE')
  if (minimumTop1 !== null) {
    assert.ok(result.overall.top1.accuracy >= minimumTop1, `Top-1 ${result.overall.top1.accuracy}% < ${minimumTop1}%.`)
  }
  if (minimumTopN !== null) {
    assert.ok(result.overall.topNOracle.accuracy >= minimumTopN, `Top-${topN} ${result.overall.topNOracle.accuracy}% < ${minimumTopN}%.`)
  }
  if (maximumCollapse !== null) {
    assert.ok(result.overall.characterCount.collapseRate <= maximumCollapse, `Collapse ${result.overall.characterCount.collapseRate}% > ${maximumCollapse}%.`)
  }
  console.log(JSON.stringify(
    process.env.FANOTES_UJI_PAIR_SELECTION_CASES === '1' ? result : compactSummary(result),
    null,
    2,
  ))
} finally {
  fs.rmSync(temporary, { recursive: true, force: true, maxRetries: 12, retryDelay: 100 })
}
