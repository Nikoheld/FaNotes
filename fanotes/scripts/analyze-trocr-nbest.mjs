import fs from 'node:fs'
import path from 'node:path'
import { createServer } from 'vite'

const source = process.argv[2]
if (!source) throw new Error('Aufruf: node scripts/analyze-trocr-nbest.mjs BENCHMARK.json [de|en]')
const language = process.argv[3] === 'de' ? 'de' : 'en'
const benchmark = JSON.parse(fs.readFileSync(path.resolve(source), 'utf8'))
if (!Array.isArray(benchmark.predictions)) throw new Error('Der Benchmark enthält keine N-Best-Vorhersagen.')

const distance = (first, second) => {
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

const server = await createServer({
  appType: 'custom',
  logLevel: 'error',
  optimizeDeps: { noDiscovery: true },
  server: { middlewareMode: true },
})

try {
  const { rankTrocrCandidateTextsForTests } = await server.ssrLoadModule('/src/lib/neuralTextRecognition.ts')
  const { installNeuralWordContextCandidates } = await server.ssrLoadModule('/src/lib/neuralWordContext.ts')
  const words = fs.readFileSync(path.resolve(`public/spell/${language}.words`), 'utf8').trimEnd().split('\n')
  const dictionary = new Set(words)
  installNeuralWordContextCandidates(language, words)
  const wordMembership = (word) => dictionary.has(word.toLocaleLowerCase(language === 'de' ? 'de-CH' : 'en-US'))
  let characters = 0
  let topEdits = 0
  let rerankedEdits = 0
  let oracleEdits = 0
  let topExact = 0
  let rerankedExact = 0
  const changed = []
  const rankPenalties = [0.1, 0.2, 0.3, 0.4, 0.5, 0.65, 0.8, 1, 1.25, 1.5, 2, 3]
  const penaltyMetrics = new Map(rankPenalties.map((penalty) => [penalty, { edits: 0, exact: 0, changed: 0 }]))
  for (const record of benchmark.predictions) {
    const truth = String(record.truth ?? '')
    const candidates = Array.isArray(record.candidates) ? record.candidates.map(String) : []
    if (!truth || !candidates.length) continue
    const ranked = rankTrocrCandidateTextsForTests(candidates, language, wordMembership)
    const baseScores = ranked.map((entry) => ({
      ...entry,
      visualRank: entry.visualRank ?? candidates.indexOf(entry.rawText),
      baseScore: entry.baseScore ?? entry.score,
    }))
    const top = candidates[0]
    const selected = ranked[0]?.rawText ?? top
    const topDistance = distance(truth, top)
    const selectedDistance = distance(truth, selected)
    const oracleDistance = Math.min(...candidates.map((candidate) => distance(truth, candidate)))
    characters += truth.length
    topEdits += topDistance
    rerankedEdits += selectedDistance
    oracleEdits += oracleDistance
    topExact += Number(top === truth)
    rerankedExact += Number(selected === truth)
    rankPenalties.forEach((penalty) => {
      const candidate = [...baseScores].sort((first, second) => (
        (second.baseScore - Math.max(0, second.visualRank) * penalty) -
        (first.baseScore - Math.max(0, first.visualRank) * penalty)
      ))[0]?.rawText ?? top
      const metrics = penaltyMetrics.get(penalty)
      metrics.edits += distance(truth, candidate)
      metrics.exact += Number(candidate === truth)
      metrics.changed += Number(candidate !== top)
    })
    if (selected !== top) changed.push({
      delta: topDistance - selectedDistance,
      truth,
      top,
      selected,
      ranking: ranked.map((entry) => ({ text: entry.rawText, score: Math.round(entry.score * 100) / 100 })),
    })
  }
  const lines = benchmark.predictions.length
  console.log(JSON.stringify({
    lines,
    topCer: topEdits / Math.max(1, characters),
    rerankedCer: rerankedEdits / Math.max(1, characters),
    oracleCer: oracleEdits / Math.max(1, characters),
    topExactRate: topExact / Math.max(1, lines),
    rerankedExactRate: rerankedExact / Math.max(1, lines),
    changed: changed.length,
    improved: changed.filter((entry) => entry.delta > 0).length,
    worsened: changed.filter((entry) => entry.delta < 0).length,
    penaltySweep: rankPenalties.map((penalty) => ({
      penalty,
      cer: penaltyMetrics.get(penalty).edits / Math.max(1, characters),
      exactRate: penaltyMetrics.get(penalty).exact / Math.max(1, lines),
      changed: penaltyMetrics.get(penalty).changed,
    })),
  }, null, 2))
  changed
    .sort((first, second) => second.delta - first.delta)
    .slice(0, 16)
    .forEach((entry) => console.log(`+${entry.delta} ${JSON.stringify(entry)}`))
  changed
    .filter((entry) => entry.delta < 0)
    .sort((first, second) => first.delta - second.delta)
    .slice(0, 16)
    .forEach((entry) => console.log(`${entry.delta} ${JSON.stringify(entry)}`))
} finally {
  await server.close()
}
