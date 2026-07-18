import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'vite'

const dataset = process.env.FANOTES_UJI_DATASET?.trim()
assert.ok(dataset && fs.statSync(dataset).isFile(), 'FANOTES_UJI_DATASET muss auf den geprüften UJI-Datensatz zeigen.')

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const workspaceRoot = path.resolve(appRoot, '..')
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'fanotes-uji-pairs-'))
const output = path.join(temporary, 'dist')
const profile = path.join(temporary, 'chromium')

const parseDataset = (source) => {
  const lines = source.split(/\r?\n/u)
  const records = []
  for (let cursor = 0; cursor < lines.length; cursor += 1) {
    const header = /^WORD\s+(\S+)\s+((?:trn|tst)_(?:UJI|UPV)_W\d+)-(0[12])$/u.exec(lines[cursor].trim())
    if (!header || !/^[A-Za-z0-9]$/u.test(header[1])) continue
    const strokeCount = Number(/^NUMSTROKES\s+(\d+)$/u.exec((lines[++cursor] ?? '').trim())?.[1])
    const strokes = []
    for (let strokeIndex = 0; strokeIndex < strokeCount; strokeIndex += 1) {
      const match = /^POINTS\s+(\d+)\s+#\s+(.+)$/u.exec((lines[++cursor] ?? '').trim())
      assert.ok(match, `Ungültiger UJI-Stiftzug bei Zeile ${cursor + 1}.`)
      const count = Number(match[1])
      const values = match[2].trim().split(/\s+/u).map(Number)
      strokes.push(Array.from({ length: count }, (_, index) => [values[index * 2], values[index * 2 + 1]]))
    }
    records.push({ char: header[1], writer: header[2], session: Number(header[3]), strokes })
  }
  return records
}

try {
  const all = parseDataset(fs.readFileSync(dataset, 'utf8'))
  const requestedWriters = Math.max(1, Math.min(60, Number(process.env.FANOTES_UJI_PAIR_WRITERS) || 12))
  const writers = [...new Set(all.map((entry) => entry.writer))].sort().slice(0, requestedWriters)
  const records = all.filter((entry) => writers.includes(entry.writer) && entry.session === 1)
  const dataPath = path.join(temporary, 'uji-pairs.json')
  const entryPath = path.join(temporary, 'entry.ts')
  fs.writeFileSync(dataPath, JSON.stringify(records))
  fs.writeFileSync(entryPath, [
    `import records from ${JSON.stringify(pathToFileURL(dataPath).href)}`,
    `import { runUjiPairSegmentationAudit } from ${JSON.stringify(pathToFileURL(path.join(appRoot, 'scripts/fixtures/uji-pair-segmentation-harness.ts')).href)}`,
    'try {',
    '  const result = runUjiPairSegmentationAudit(records)',
    '  document.body.innerHTML = `<pre id="result">${JSON.stringify(result)}</pre>`',
    '} catch (error) {',
    '  document.body.innerHTML = `<pre id="error">${String(error?.stack || error)}</pre>`',
    '}',
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
    '--js-flags=--max-old-space-size=768', '--allow-file-access-from-files',
    `--user-data-dir=${profile}`, '--virtual-time-budget=45000', '--dump-dom',
    pathToFileURL(path.join(output, 'index.html')).href,
  ], { stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = ''
  let stderr = ''
  chromium.stdout.on('data', (chunk) => { stdout += chunk })
  chromium.stderr.on('data', (chunk) => { stderr += chunk })
  const exitCode = await new Promise((resolve) => chromium.on('close', resolve))
  assert.equal(exitCode, 0, `Chromium konnte den Paar-Audit nicht ausführen: ${stderr}`)
  const error = /<pre id="error">([\s\S]*?)<\/pre>/u.exec(stdout)?.[1]
  assert.equal(error, undefined, error)
  const encoded = /<pre id="result">([\s\S]*?)<\/pre>/u.exec(stdout)?.[1]
  assert.ok(encoded, `Kein Paar-Ergebnis: ${stdout.slice(-1800)}`)
  const result = JSON.parse(encoded.replaceAll('&quot;', '"').replaceAll('&amp;', '&'))
  console.log(JSON.stringify(process.env.FANOTES_UJI_PAIR_SUMMARY === '1' ? {
    writers: result.writers,
    characters: result.characters,
    singles: {
      samples: result.singles.samples,
      safety: result.singles.safety,
    },
    separated: {
      pairs: result.pairs,
      availability: result.availability,
    },
    connected: {
      pairs: result.connected.pairs,
      availability: result.connected.availability,
      unfragmentedRate: result.connected.unfragmentedRate,
      ownerCorrectRate: result.connected.ownerCorrectRate,
      failures: result.connected.failures.slice(0, 20).map(({ writer, expected }) => ({ writer, expected })),
      fragmentationFailures: result.connected.fragmentationFailures
        .slice(0, 20)
        .map(({ writer, expected }) => ({ writer, expected })),
      ownershipFailures: result.connected.ownershipFailures.slice(0, 80).map((entry) => ({
        writer: entry.writer,
        expected: entry.expected,
        strokeCounts: entry.strokeCounts,
        joinX: entry.joinX,
        delayedOwners: entry.delayedStrokeBounds.map(({ owner }) => owner),
        delayedStrokeBounds: entry.delayedStrokeBounds,
        cutCandidates: entry.cutCandidates,
        longestBodySegments: entry.longestBodySegments,
        hypothesisAllocations: entry.hypothesisAllocations,
      })),
    },
  } : result, null, 2))
  if (process.env.FANOTES_UJI_PAIR_STRICT === '1') {
    assert.equal(result.singles.safety, 100, `Einzelbuchstaben werden fälschlich aufgetrennt: ${JSON.stringify(result.singles.failures.slice(0, 20))}`)
    assert.equal(result.availability, 100, `Echte Buchstabenpaare besitzen nicht immer einen Zwei-Zeichen-Pfad: ${JSON.stringify(result.failures.slice(0, 20))}`)
    assert.equal(result.connected.availability, 100, `Durchgehend verbundene Buchstabenpaare besitzen nicht immer einen Zwei-Zeichen-Pfad: ${JSON.stringify(result.connected.failures.slice(0, 20))}`)
    assert.equal(result.connected.unfragmentedRate, 100, `Verspätete Zubehörstriche werden in verbundenen Paaren zerschnitten: ${JSON.stringify(result.connected.fragmentationFailures.slice(0, 20))}`)
    assert.equal(result.connected.ownerCorrectRate, 100, `Jeder vollständige Zubehörstrich muss eine Segmentierung mit dem richtigen Buchstaben besitzen: ${JSON.stringify(result.connected.ownershipFailures.slice(0, 20))}`)
  }
} finally {
  fs.rmSync(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
}
