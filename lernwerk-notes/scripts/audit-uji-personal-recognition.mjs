import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'vite'

// UJI Pen Characters v2, CC BY 4.0, DOI 10.24432/C5FG8S.
// The benchmark downloads its pinned 2.2 MiB archive into a temporary folder;
// the research data is not bundled into FaNotes or its release packages.
const DATASET_URL = 'https://archive.ics.uci.edu/static/public/177/uji+pen+characters+version+2.zip'
const DATASET_SHA256 = '0881b522911b99d9922820289441b50fd3d307f71cd7f9cc70e86872424a5f90'
const MAX_ARCHIVE_BYTES = 5 * 1024 * 1024
const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const workspaceRoot = path.resolve(appRoot, '..')
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'fanotes-uji-audit-'))
const archive = path.join(temporary, 'uji.zip')
const dataset = path.join(temporary, 'ujipenchars2.txt')
const output = path.join(temporary, 'dist')
const profile = path.join(temporary, 'chromium')

const downloadDataset = async () => {
  const local = process.env.FANOTES_UJI_DATASET?.trim()
  if (local) {
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
      assert.equal(values.length, count * 2, `UJI-Punktzahl stimmt bei Zeile ${cursor + 1} nicht.`)
      strokes.push(Array.from({ length: count }, (_, index) => [values[index * 2], values[index * 2 + 1]]))
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

try {
  await downloadDataset()
  const records = parseDataset(fs.readFileSync(dataset, 'utf8'))
  assert.equal(records.length, 7_440, 'Der vollständige alphanumerische UJI-Satz wurde nicht gelesen.')
  const dataPath = path.join(temporary, 'uji-data.json')
  const entryPath = path.join(temporary, 'entry.ts')
  fs.writeFileSync(dataPath, JSON.stringify(records))
  fs.writeFileSync(entryPath, [
    `import records from ${JSON.stringify(pathToFileURL(dataPath).href)}`,
    `import { runUjiPersonalRecognitionAudit } from ${JSON.stringify(pathToFileURL(path.join(appRoot, 'scripts/fixtures/uji-personal-recognition-harness.ts')).href)}`,
    'runUjiPersonalRecognitionAudit(records).then((result) => {',
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
  fs.writeFileSync(path.join(output, 'index.html'), '<!doctype html><html><body><script type="module" src="./audit.js"></script></body></html>')
  const chromium = spawn('chromium', [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
    '--js-flags=--max-old-space-size=1536',
    '--allow-file-access-from-files', `--user-data-dir=${profile}`, '--virtual-time-budget=90000',
    '--dump-dom', pathToFileURL(path.join(output, 'index.html')).href,
  ], { stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = ''
  let stderr = ''
  chromium.stdout.on('data', (chunk) => { stdout += chunk })
  chromium.stderr.on('data', (chunk) => { stderr += chunk })
  const exitCode = await new Promise((resolve) => chromium.on('close', resolve))
  assert.equal(exitCode, 0, `Chromium konnte den UJI-Audit nicht ausführen: ${stderr}`)
  const error = /<pre id="error">([\s\S]*?)<\/pre>/u.exec(stdout)?.[1]
  assert.equal(error, undefined, error)
  const encoded = /<pre id="result">([\s\S]*?)<\/pre>/u.exec(stdout)?.[1]
  assert.ok(encoded, `Kein UJI-Ergebnis: ${stdout.slice(-1800)}`)
  const result = JSON.parse(encoded.replaceAll('&quot;', '"').replaceAll('&amp;', '&'))
  console.log(JSON.stringify(process.env.FANOTES_UJI_AUDIT_SUMMARY === '1' ? {
    datasetSamples: result.datasetSamples,
    datasetWriters: result.datasetWriters,
    personal: {
      writer: result.personal.writer,
      trainingSamples: result.personal.trainingSamples,
      samples: result.personal.samples,
      buildMs: result.personal.buildMs,
      accuracy: result.personal.accuracy,
      unhintedAccuracy: result.personal.unhintedAccuracy,
      caseNormalizedAccuracy: result.personal.caseNormalizedAccuracy,
      top3Accuracy: result.personal.top3Accuracy,
      top8Accuracy: result.personal.top8Accuracy,
      topConfusions: result.personal.topConfusions,
    },
    writerIndependent: {
      trainingWriters: result.writerIndependent.trainingWriters,
      holdoutWriter: result.writerIndependent.holdoutWriter,
      trainingSamples: result.writerIndependent.trainingSamples,
      samples: result.writerIndependent.samples,
      buildMs: result.writerIndependent.buildMs,
      accuracy: result.writerIndependent.accuracy,
      unhintedAccuracy: result.writerIndependent.unhintedAccuracy,
      caseNormalizedAccuracy: result.writerIndependent.caseNormalizedAccuracy,
      top3Accuracy: result.writerIndependent.top3Accuracy,
      top8Accuracy: result.writerIndependent.top8Accuracy,
      topConfusions: result.writerIndependent.topConfusions,
    },
  } : result, null, 2))
  if (process.env.FANOTES_UJI_AUDIT_STRICT === '1') {
    assert.ok(result.personal.accuracy >= 90, `Sitzungsübergreifende Personalisierung ist zu schwach: ${JSON.stringify(result.personal)}`)
    assert.ok(result.writerIndependent.accuracy >= 90, `Der 992-Beispiele-Holdout ist zu schwach: ${JSON.stringify(result.writerIndependent)}`)
    assert.ok(result.personal.unhintedAccuracy >= 88, `Die Segmentierung isolierter Zeichen ist zu schwach: ${JSON.stringify(result.personal)}`)
  }
} finally {
  fs.rmSync(temporary, { recursive: true, force: true, maxRetries: 12, retryDelay: 100 })
}
