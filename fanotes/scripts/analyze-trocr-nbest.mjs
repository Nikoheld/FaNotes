import fs from 'node:fs'
import path from 'node:path'
import { createServer } from 'vite'

const source = process.argv[2]
if (!source) throw new Error('Aufruf: node scripts/analyze-trocr-nbest.mjs BENCHMARK.json [de|en] [--summary-only]')
const language = process.argv.slice(3).find((argument) => argument === 'de' || argument === 'en') === 'de' ? 'de' : 'en'
const summaryOnly = process.argv.includes('--summary-only')
const detailContext = process.argv.includes('--detail-context')
const detailPenaltyArgument = process.argv.find((argument) => argument.startsWith('--detail-penalty='))
const detailPenalty = detailPenaltyArgument
  ? Number(detailPenaltyArgument.slice('--detail-penalty='.length))
  : null
if (detailPenaltyArgument && !Number.isFinite(detailPenalty)) throw new Error('Ungültige Detail-Strafe.')
if (summaryOnly && detailPenalty !== null) throw new Error('--summary-only und --detail-penalty sind nicht kombinierbar.')
if (summaryOnly && detailContext) throw new Error('--summary-only und --detail-context sind nicht kombinierbar.')
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
  const {
    rankTrocrCandidateTextsForTests,
    trocrSafeWordRepairBonusForTests,
    trocrVisualRankPenaltyForTests,
  } = await server.ssrLoadModule('/src/lib/neuralTextRecognition.ts')
  const {
    applyFinalNeuralLineContext,
    applyNeuralWordContext,
    installNeuralWordContextCandidates,
  } = await server.ssrLoadModule('/src/lib/neuralWordContext.ts')
  const words = fs.readFileSync(path.resolve(`public/spell/${language}.words`), 'utf8').trimEnd().split('\n')
  const dictionary = new Set(words)
  installNeuralWordContextCandidates(language, words)
  const wordMembership = (word) => dictionary.has(word.toLocaleLowerCase(language === 'de' ? 'de-CH' : 'en-US'))
  let characters = 0
  let topEdits = 0
  let rerankedEdits = 0
  let rawFinalContextEdits = 0
  let aggressiveContextEdits = 0
  let aggressiveFinalContextEdits = 0
  let oracleEdits = 0
  let topExact = 0
  let rerankedExact = 0
  let rawFinalContextExact = 0
  let aggressiveContextExact = 0
  let aggressiveFinalContextExact = 0
  const changed = []
  const aggressiveContextChanges = []
  const aggressiveFinalContextChanges = []
  const rawFinalContextChanges = []
  const detailPenaltyChanges = []
  const rankPenalties = [0.1, 0.2, 0.3, 0.4, 0.5, 0.65, 0.8, 1, 1.25, 1.5, 2, 3]
  const safeRepairBonuses = [0, 1, 2, 2.5, 3, 3.5, 4]
  const penaltyMetrics = new Map(rankPenalties.map((penalty) => [penalty, {
    edits: 0,
    exact: 0,
    changed: 0,
    improved: 0,
    worsened: 0,
  }]))
  const safeRepairMetrics = new Map(safeRepairBonuses.map((bonus) => [bonus, {
    edits: 0,
    exact: 0,
    changed: 0,
    improved: 0,
    worsened: 0,
  }]))
  for (const record of benchmark.predictions) {
    const truth = String(record.truth ?? '')
    const candidates = Array.isArray(record.candidates) ? record.candidates.map(String) : []
    if (!truth || !candidates.length) continue
    const ranked = rankTrocrCandidateTextsForTests(candidates, language, wordMembership)
    const penaltySweepScores = ranked.map((entry) => ({
      ...entry,
      visualRank: entry.visualRank ?? candidates.indexOf(entry.rawText),
      // Remove only the currently configured visual-rank penalty. Structural,
      // lexical, name and punctuation evidence must remain in the simulation;
      // using baseScore here previously discarded all of those safeguards.
      scoreWithoutVisualPenalty: entry.score + Math.max(0, entry.visualRank)
        * trocrVisualRankPenaltyForTests,
    }))
    const top = candidates[0]
    const selected = ranked[0]?.rawText ?? top
    const rawFinalContext = applyFinalNeuralLineContext(selected, language)
    // The ranked `.text` also applies ink-dependent terminal punctuation
    // cleanup. N-best benchmark JSON has no stroke geometry, so comparing it
    // here would count synthetic punctuation removal as a word-context error.
    // Measure the lexical stages directly on the selected decoder surface.
    const aggressiveContext = applyNeuralWordContext(selected, language)
    const aggressiveFinalContext = applyFinalNeuralLineContext(aggressiveContext, language)
    const topDistance = distance(truth, top)
    const selectedDistance = distance(truth, selected)
    const rawFinalContextDistance = distance(truth, rawFinalContext)
    const aggressiveContextDistance = distance(truth, aggressiveContext)
    const aggressiveFinalContextDistance = distance(truth, aggressiveFinalContext)
    const oracleDistance = Math.min(...candidates.map((candidate) => distance(truth, candidate)))
    characters += truth.length
    topEdits += topDistance
    rerankedEdits += selectedDistance
    rawFinalContextEdits += rawFinalContextDistance
    aggressiveContextEdits += aggressiveContextDistance
    aggressiveFinalContextEdits += aggressiveFinalContextDistance
    oracleEdits += oracleDistance
    topExact += Number(top === truth)
    rerankedExact += Number(selected === truth)
    rawFinalContextExact += Number(rawFinalContext === truth)
    aggressiveContextExact += Number(aggressiveContext === truth)
    aggressiveFinalContextExact += Number(aggressiveFinalContext === truth)
    rankPenalties.forEach((penalty) => {
      const candidate = [...penaltySweepScores].sort((first, second) => (
        (second.scoreWithoutVisualPenalty - Math.max(0, second.visualRank) * penalty) -
        (first.scoreWithoutVisualPenalty - Math.max(0, first.visualRank) * penalty)
      ))[0]?.rawText ?? top
      const metrics = penaltyMetrics.get(penalty)
      const candidateDistance = distance(truth, candidate)
      metrics.edits += candidateDistance
      metrics.exact += Number(candidate === truth)
      metrics.changed += Number(candidate !== top)
      metrics.improved += Number(candidateDistance < topDistance)
      metrics.worsened += Number(candidateDistance > topDistance)
      if (
        detailPenalty !== null &&
        Math.abs(penalty - detailPenalty) < 1e-9 &&
        candidate !== top
      ) detailPenaltyChanges.push({
        delta: topDistance - candidateDistance,
        truth,
        top,
        candidate,
      })
    })
    safeRepairBonuses.forEach((bonus) => {
      const candidate = [...ranked].sort((first, second) => {
        const adjustedScore = (entry) => entry.score + (
          entry.repairDisposition === 'safe'
            ? bonus - trocrSafeWordRepairBonusForTests
            : 0
        )
        return adjustedScore(second) - adjustedScore(first)
      })[0]?.rawText ?? top
      const metrics = safeRepairMetrics.get(bonus)
      const candidateDistance = distance(truth, candidate)
      metrics.edits += candidateDistance
      metrics.exact += Number(candidate === truth)
      metrics.changed += Number(candidate !== top)
      metrics.improved += Number(candidateDistance < topDistance)
      metrics.worsened += Number(candidateDistance > topDistance)
    })
    if (selected !== top) changed.push({
      delta: topDistance - selectedDistance,
      truth,
      top,
      selected,
      ranking: ranked.map((entry) => ({ text: entry.rawText, score: Math.round(entry.score * 100) / 100 })),
    })
    if (aggressiveContext !== selected) aggressiveContextChanges.push({
      delta: selectedDistance - aggressiveContextDistance,
      truth,
      selected,
      aggressiveContext,
    })
    if (aggressiveFinalContext !== aggressiveContext) aggressiveFinalContextChanges.push({
      delta: aggressiveContextDistance - aggressiveFinalContextDistance,
      truth,
      selected: aggressiveContext,
      aggressiveFinalContext,
    })
    if (rawFinalContext !== selected) rawFinalContextChanges.push({
      delta: selectedDistance - rawFinalContextDistance,
      truth,
      selected,
      rawFinalContext,
    })
  }
  const lines = benchmark.predictions.length
  console.log(JSON.stringify({
    lines,
    topCer: topEdits / Math.max(1, characters),
    rerankedCer: rerankedEdits / Math.max(1, characters),
    rawFinalContextCer: rawFinalContextEdits / Math.max(1, characters),
    aggressiveContextCer: aggressiveContextEdits / Math.max(1, characters),
    aggressiveFinalContextCer: aggressiveFinalContextEdits / Math.max(1, characters),
    oracleCer: oracleEdits / Math.max(1, characters),
    topExactRate: topExact / Math.max(1, lines),
    rerankedExactRate: rerankedExact / Math.max(1, lines),
    rawFinalContextExactRate: rawFinalContextExact / Math.max(1, lines),
    aggressiveContextExactRate: aggressiveContextExact / Math.max(1, lines),
    aggressiveFinalContextExactRate: aggressiveFinalContextExact / Math.max(1, lines),
    changed: changed.length,
    improved: changed.filter((entry) => entry.delta > 0).length,
    worsened: changed.filter((entry) => entry.delta < 0).length,
    aggressiveContext: {
      changed: aggressiveContextChanges.length,
      improved: aggressiveContextChanges.filter((entry) => entry.delta > 0).length,
      worsened: aggressiveContextChanges.filter((entry) => entry.delta < 0).length,
      neutral: aggressiveContextChanges.filter((entry) => entry.delta === 0).length,
    },
    aggressiveFinalContext: {
      changed: aggressiveFinalContextChanges.length,
      improved: aggressiveFinalContextChanges.filter((entry) => entry.delta > 0).length,
      worsened: aggressiveFinalContextChanges.filter((entry) => entry.delta < 0).length,
      neutral: aggressiveFinalContextChanges.filter((entry) => entry.delta === 0).length,
    },
    rawFinalContext: {
      changed: rawFinalContextChanges.length,
      improved: rawFinalContextChanges.filter((entry) => entry.delta > 0).length,
      worsened: rawFinalContextChanges.filter((entry) => entry.delta < 0).length,
      neutral: rawFinalContextChanges.filter((entry) => entry.delta === 0).length,
    },
    penaltySweep: rankPenalties.map((penalty) => ({
      penalty,
      cer: penaltyMetrics.get(penalty).edits / Math.max(1, characters),
      exactRate: penaltyMetrics.get(penalty).exact / Math.max(1, lines),
      changed: penaltyMetrics.get(penalty).changed,
      improved: penaltyMetrics.get(penalty).improved,
      worsened: penaltyMetrics.get(penalty).worsened,
    })),
    safeRepairBonusSweep: safeRepairBonuses.map((bonus) => ({
      bonus,
      cer: safeRepairMetrics.get(bonus).edits / Math.max(1, characters),
      exactRate: safeRepairMetrics.get(bonus).exact / Math.max(1, lines),
      changed: safeRepairMetrics.get(bonus).changed,
      improved: safeRepairMetrics.get(bonus).improved,
      worsened: safeRepairMetrics.get(bonus).worsened,
    })),
  }, null, 2))
  if (!summaryOnly) {
    changed
      .sort((first, second) => second.delta - first.delta)
      .slice(0, 16)
      .forEach((entry) => console.log(`+${entry.delta} ${JSON.stringify(entry)}`))
    changed
      .filter((entry) => entry.delta < 0)
      .sort((first, second) => first.delta - second.delta)
      .slice(0, 16)
      .forEach((entry) => console.log(`${entry.delta} ${JSON.stringify(entry)}`))
    aggressiveContextChanges
      .sort((first, second) => second.delta - first.delta)
      .slice(0, 16)
      .forEach((entry) => console.log(`context +${entry.delta} ${JSON.stringify(entry)}`))
    aggressiveContextChanges
      .filter((entry) => entry.delta < 0)
      .sort((first, second) => first.delta - second.delta)
      .slice(0, 16)
      .forEach((entry) => console.log(`context ${entry.delta} ${JSON.stringify(entry)}`))
    aggressiveFinalContextChanges
      .filter((entry) => entry.delta < 0)
      .sort((first, second) => first.delta - second.delta)
      .slice(0, 16)
      .forEach((entry) => console.log(`final-context ${entry.delta} ${JSON.stringify(entry)}`))
    rawFinalContextChanges
      .filter((entry) => entry.delta < 0)
      .sort((first, second) => first.delta - second.delta)
      .slice(0, 16)
      .forEach((entry) => console.log(`raw-context ${entry.delta} ${JSON.stringify(entry)}`))
    if (detailContext) rawFinalContextChanges
      .sort((first, second) => second.delta - first.delta)
      .forEach((entry) => console.log(`raw-context-detail ${entry.delta >= 0 ? '+' : ''}${entry.delta} ${JSON.stringify(entry)}`))
    detailPenaltyChanges
      .sort((first, second) => second.delta - first.delta)
      .forEach((entry) => console.log(`penalty-${detailPenalty} ${entry.delta >= 0 ? '+' : ''}${entry.delta} ${JSON.stringify(entry)}`))
  }
} finally {
  await server.close()
}
