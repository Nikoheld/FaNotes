import fs from 'node:fs'
import path from 'node:path'
import { createServer } from 'vite'

const source = process.argv[2]
if (!source) throw new Error('Aufruf: node scripts/analyze-trocr-sequence-scores.mjs BENCHMARK.json [de|en]')
const language = process.argv[3] === 'de' ? 'de' : 'en'
const benchmark = JSON.parse(fs.readFileSync(path.resolve(source), 'utf8'))
if (!Array.isArray(benchmark.predictions)) throw new Error('Der Benchmark enthält keine N-Best-Vorhersagen.')

const distance = (first, second) => {
  const left = Array.from(first)
  const right = Array.from(second)
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index)
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex]
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      current.push(Math.min(
        previous[rightIndex] + 1,
        current[rightIndex - 1] + 1,
        previous[rightIndex - 1] + Number(left[leftIndex - 1] !== right[rightIndex - 1]),
      ))
    }
    previous.splice(0, previous.length, ...current)
  }
  return previous[right.length]
}

const scales = [0, 2, 4, 6, 8, 10, 12, 16, 20, 25, 30, 40, 50, 60, 80, 100, 120, 160, 200, 300]
const emptyMetric = () => ({ characters: 0, edits: 0, exact: 0, changed: 0, improved: 0, worsened: 0 })
const scoreMetrics = new Map(scales.map((scale) => [scale, [emptyMetric(), emptyMetric(), emptyMetric()]]))
const currentMetrics = [emptyMetric(), emptyMetric(), emptyMetric()]
const visualMetrics = [emptyMetric(), emptyMetric(), emptyMetric()]
const candidateLimitMetrics = new Map([1, 2, 3, 4].map((limit) => (
  [limit, [emptyMetric(), emptyMetric(), emptyMetric()]]
)))
const contextualCandidateLimitMetrics = new Map([1, 2].map((limit) => (
  [limit, [emptyMetric(), emptyMetric(), emptyMetric()]]
)))
const records = []

const server = await createServer({
  appType: 'custom',
  logLevel: 'error',
  optimizeDeps: { noDiscovery: true },
  server: { middlewareMode: true, hmr: false },
})

try {
  const { rankTrocrCandidateTextsForTests } = await server.ssrLoadModule('/src/lib/neuralTextRecognition.ts')
  const {
    applyFinalNeuralWordContext,
    applyNeuralWordContext,
    installNeuralWordContextCandidates,
  } = await server.ssrLoadModule('/src/lib/neuralWordContext.ts')
  const words = fs.readFileSync(path.resolve(`public/spell/${language}.words`), 'utf8').trimEnd().split('\n')
  const dictionary = new Set(words)
  installNeuralWordContextCandidates(language, words)
  const locale = language === 'de' ? 'de-CH' : 'en-US'
  const wordMembership = (word) => dictionary.has(word.toLocaleLowerCase(locale).replaceAll('ß', 'ss'))

  for (const [recordIndex, record] of benchmark.predictions.entries()) {
    const truth = String(record.truth ?? '')
    const candidates = Array.isArray(record.candidates) ? record.candidates.map(String) : []
    const candidateScores = Array.isArray(record.candidateScores) ? record.candidateScores.map(Number) : []
    if (!truth || !candidates.length || candidateScores.length !== candidates.length || candidateScores.some((score) => !Number.isFinite(score))) {
      throw new Error(`Ungültige Sequenzscores in Zeile ${recordIndex + 1}.`)
    }
    const productionRanked = rankTrocrCandidateTextsForTests(candidates, language, wordMembership)
    const scoreByText = new Map(candidates.map((candidate, index) => [candidate, candidateScores[index]]))
    const topSequenceScore = candidateScores[0]
    const ranked = productionRanked.map((entry) => ({
      ...entry,
      sequenceScore: scoreByText.get(entry.rawText) ?? Number.NEGATIVE_INFINITY,
    }))
    const visual = candidates[0]
    const current = productionRanked[0]?.rawText ?? visual
    const visualDistance = distance(truth, visual)
    const currentDistance = distance(truth, current)
    const fold = recordIndex % 2
    const characterCount = Array.from(truth).length

    for (const bucket of [0, fold + 1]) {
      visualMetrics[bucket].characters += characterCount
      visualMetrics[bucket].edits += visualDistance
      visualMetrics[bucket].exact += Number(visual === truth)
      currentMetrics[bucket].characters += characterCount
      currentMetrics[bucket].edits += currentDistance
      currentMetrics[bucket].exact += Number(current === truth)
      currentMetrics[bucket].changed += Number(current !== visual)
      currentMetrics[bucket].improved += Number(currentDistance < visualDistance)
      currentMetrics[bucket].worsened += Number(currentDistance > visualDistance)
    }

    const limitedSelections = [...candidateLimitMetrics.keys()].map((limit) => {
      const limited = rankTrocrCandidateTextsForTests(candidates.slice(0, limit), language, wordMembership)
      const selected = limited[0]?.rawText ?? visual
      const contextualized = contextualCandidateLimitMetrics.has(limit)
        // The deterministic rank hook uses an empty synthetic stroke line and
        // therefore cannot prove whether terminal punctuation has ink. Apply
        // word context to the literal decoder candidate here; punctuation is
        // evaluated by the real line geometry in production.
        ? applyFinalNeuralWordContext(applyNeuralWordContext(selected, language), language)
        : ''
      return { limit, selected, contextualized }
    })
    const contextualBaselineDistance = distance(truth, limitedSelections[0].contextualized)
    for (const { limit, selected, contextualized } of limitedSelections) {
      const selectedDistance = distance(truth, selected)
      const contextualDistance = distance(truth, contextualized)
      for (const bucket of [0, fold + 1]) {
        const metric = candidateLimitMetrics.get(limit)[bucket]
        metric.characters += characterCount
        metric.edits += selectedDistance
        metric.exact += Number(selected === truth)
        metric.changed += Number(selected !== visual)
        metric.improved += Number(selectedDistance < visualDistance)
        metric.worsened += Number(selectedDistance > visualDistance)
        const contextualMetric = contextualCandidateLimitMetrics.get(limit)?.[bucket]
        if (contextualMetric) {
          contextualMetric.characters += characterCount
          contextualMetric.edits += contextualDistance
          contextualMetric.exact += Number(contextualized === truth)
          contextualMetric.changed += Number(contextualized !== limitedSelections[0].contextualized)
          contextualMetric.improved += Number(contextualDistance < contextualBaselineDistance)
          contextualMetric.worsened += Number(contextualDistance > contextualBaselineDistance)
        }
      }
    }

    for (const scale of scales) {
      const selected = [...ranked].sort((first, second) => (
        (second.baseScore + (second.sequenceScore - topSequenceScore) * scale) -
        (first.baseScore + (first.sequenceScore - topSequenceScore) * scale)
      ))[0]?.rawText ?? visual
      const selectedDistance = distance(truth, selected)
      for (const bucket of [0, fold + 1]) {
        const metric = scoreMetrics.get(scale)[bucket]
        metric.characters += characterCount
        metric.edits += selectedDistance
        metric.exact += Number(selected === truth)
        metric.changed += Number(selected !== current)
        metric.improved += Number(selectedDistance < currentDistance)
        metric.worsened += Number(selectedDistance > currentDistance)
      }
    }
    records.push({ truth, visual, current, currentDistance, topSequenceScore, ranked, fold, characterCount })
  }

  const summarize = (metric) => ({
    cer: metric.edits / Math.max(1, metric.characters),
    exact: metric.exact,
    changed: metric.changed,
    improved: metric.improved,
    worsened: metric.worsened,
  })
  const results = scales.map((scale) => ({
    scale,
    all: summarize(scoreMetrics.get(scale)[0]),
    even: summarize(scoreMetrics.get(scale)[1]),
    odd: summarize(scoreMetrics.get(scale)[2]),
  }))
  const bestFor = (bucket) => [...results].sort((first, second) => (
    first[bucket].cer - second[bucket].cer ||
    second[bucket].exact - first[bucket].exact ||
    first[bucket].worsened - second[bucket].worsened ||
    second.scale - first.scale
  ))[0]
  const tunedOnEven = bestFor('even')
  const tunedOnOdd = bestFor('odd')
  const best = bestFor('all')
  const calibrationPenalties = [0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4]
  const calibrationScales = [0, 2, 5, 10, 20, 40, 60, 100]
  const calibrationGrid = calibrationPenalties.flatMap((rankPenalty) => (
    calibrationScales.map((sequenceScale) => {
      const buckets = [emptyMetric(), emptyMetric(), emptyMetric()]
      records.forEach((record) => {
        const selected = [...record.ranked].sort((first, second) => (
          (
            second.baseScore - second.visualRank * rankPenalty +
            (second.sequenceScore - record.topSequenceScore) * sequenceScale
          ) - (
            first.baseScore - first.visualRank * rankPenalty +
            (first.sequenceScore - record.topSequenceScore) * sequenceScale
          )
        ))[0]?.rawText ?? record.visual
        const selectedDistance = distance(record.truth, selected)
        for (const bucket of [0, record.fold + 1]) {
          const metric = buckets[bucket]
          metric.characters += record.characterCount
          metric.edits += selectedDistance
          metric.exact += Number(selected === record.truth)
          metric.changed += Number(selected !== record.current)
          metric.improved += Number(selectedDistance < record.currentDistance)
          metric.worsened += Number(selectedDistance > record.currentDistance)
        }
      })
      return {
        rankPenalty,
        sequenceScale,
        all: summarize(buckets[0]),
        even: summarize(buckets[1]),
        odd: summarize(buckets[2]),
      }
    })
  ))
  console.log(JSON.stringify({
    language,
    lines: records.length,
    visual: { all: summarize(visualMetrics[0]), even: summarize(visualMetrics[1]), odd: summarize(visualMetrics[2]) },
    currentProduction: { all: summarize(currentMetrics[0]), even: summarize(currentMetrics[1]), odd: summarize(currentMetrics[2]) },
    candidateLimits: Object.fromEntries([...candidateLimitMetrics].map(([limit, metrics]) => [limit, {
      all: summarize(metrics[0]),
      even: summarize(metrics[1]),
      odd: summarize(metrics[2]),
    }])),
    contextualCandidateLimits: Object.fromEntries([...contextualCandidateLimitMetrics].map(([limit, metrics]) => [limit, {
      all: summarize(metrics[0]),
      even: summarize(metrics[1]),
      odd: summarize(metrics[2]),
    }])),
    scales: results,
    bestAll: best,
    crossValidation: {
      tunedOnEven: { scale: tunedOnEven.scale, evaluationOnOdd: tunedOnEven.odd },
      tunedOnOdd: { scale: tunedOnOdd.scale, evaluationOnEven: tunedOnOdd.even },
    },
    calibrationGrid,
  }, null, 2))

  records.flatMap((record) => {
    const selected = [...record.ranked].sort((first, second) => (
      (second.baseScore + (second.sequenceScore - record.topSequenceScore) * best.scale) -
      (first.baseScore + (first.sequenceScore - record.topSequenceScore) * best.scale)
    ))[0]
    if (!selected || selected.rawText === record.current) return []
    return [{
      delta: record.currentDistance - distance(record.truth, selected.rawText),
      truth: record.truth,
      visual: record.visual,
      current: record.current,
      selected: selected.rawText,
      ranking: record.ranked.map((entry) => ({
        text: entry.rawText,
        base: Math.round(entry.baseScore * 100) / 100,
        sequence: Math.round(entry.sequenceScore * 10_000) / 10_000,
      })),
    }]
  })
    .sort((first, second) => second.delta - first.delta)
    .forEach((entry) => console.log(`${entry.delta >= 0 ? '+' : ''}${entry.delta} ${JSON.stringify(entry)}`))
} finally {
  await server.close()
}
