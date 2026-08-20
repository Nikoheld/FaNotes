import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

const dataset = process.env.FANOTES_UJI_DATASET?.trim()
assert.ok(dataset && fs.statSync(dataset).isFile(), 'FANOTES_UJI_DATASET muss auf den geprüften UJI-Datensatz zeigen.')

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

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

const server = await createServer({
  root: appRoot,
  appType: 'custom',
  logLevel: 'error',
  optimizeDeps: { noDiscovery: true },
  server: { middlewareMode: true },
})

try {
  const all = parseDataset(fs.readFileSync(dataset, 'utf8'))
  const requestedWriters = Math.max(1, Math.min(60, Number(process.env.FANOTES_UJI_PAIR_WRITERS) || 12))
  const writers = [...new Set(all.map((entry) => entry.writer))].sort().slice(0, requestedWriters)
  const records = all.filter((entry) => writers.includes(entry.writer) && entry.session === 1)
  const { runUjiPairSegmentationAudit } = await server.ssrLoadModule(
    '/scripts/fixtures/uji-pair-segmentation-harness.ts',
  )
  const result = runUjiPairSegmentationAudit(records)
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
  await server.close()
}
