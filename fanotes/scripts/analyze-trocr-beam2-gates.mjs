import fs from 'node:fs'
import path from 'node:path'
import { createServer } from 'vite'

const source = process.argv[2]
if (!source) throw new Error('Aufruf: node scripts/analyze-trocr-beam2-gates.mjs BENCHMARK.json [de|en] [OUTPUT.json]')
const language = process.argv[3] === 'de' ? 'de' : 'en'
const outputPath = process.argv[4]
const benchmark = JSON.parse(fs.readFileSync(path.resolve(source), 'utf8'))
if (!Array.isArray(benchmark.predictions)) throw new Error('Der Benchmark enthält keine N-Best-Vorhersagen.')

const distance = (first, second) => {
  const left = Array.from(first)
  const right = Array.from(second)
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index)
  let current = new Array(right.length + 1).fill(0)
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    current[0] = leftIndex
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      current[rightIndex] = Math.min(
        previous[rightIndex] + 1,
        current[rightIndex - 1] + 1,
        previous[rightIndex - 1] + Number(left[leftIndex - 1] !== right[rightIndex - 1]),
      )
    }
    ;[previous, current] = [current, previous]
  }
  return previous[right.length]
}

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
  const wordPattern = language === 'de' ? /[A-Za-zÄÖÜäöü]+/gu : /[A-Za-z]+/gu
  const surfaces = (value) => (value.match(wordPattern) ?? [])
  const knownCount = (value) => surfaces(value).filter((word) => wordMembership(word)).length
  const punctuationSurface = (value) => value.replace(/[\p{L}\d\s]/gu, '')

  const records = benchmark.predictions.flatMap((record, index) => {
    const truth = String(record.truth ?? '')
    const candidates = Array.isArray(record.candidates) ? record.candidates.map(String) : []
    const sequenceScores = Array.isArray(record.candidateScores) ? record.candidateScores.map(Number) : []
    if (!truth || candidates.length < 2 || sequenceScores.length < 2) return []
    const ranked = rankTrocrCandidateTextsForTests(candidates.slice(0, 2), language, wordMembership)
    const first = ranked.find((entry) => entry.visualRank === 0)
    const second = ranked.find((entry) => entry.visualRank === 1)
    if (!first || !second) return []
    const firstDistance = distance(truth, first.rawText)
    const secondDistance = distance(truth, second.rawText)
    const firstContext = applyFinalNeuralWordContext(applyNeuralWordContext(first.rawText, language), language)
    const secondContext = applyFinalNeuralWordContext(applyNeuralWordContext(second.rawText, language), language)
    const selectedContext = ranked[0]?.visualRank === 1 ? secondContext : firstContext
    const firstContextDistance = distance(truth, firstContext)
    const secondContextDistance = distance(truth, secondContext)
    const firstWords = surfaces(first.rawText)
    const secondWords = surfaces(second.rawText)
    return [{
      index,
      fold: index % 2,
      truth,
      first: first.rawText,
      second: second.rawText,
      firstDistance,
      secondDistance,
      oracleGain: firstDistance - secondDistance,
      firstContext,
      secondContext,
      firstContextDistance,
      secondContextDistance,
      contextualGain: firstContextDistance - secondContextDistance,
      productionContextDistance: distance(truth, selectedContext),
      baseLead: second.baseScore - first.baseScore,
      sequenceDelta: sequenceScores[1] - sequenceScores[0],
      candidateDistance: distance(first.rawText, second.rawText),
      lengthDelta: Array.from(second.rawText).length - Array.from(first.rawText).length,
      wordCountDelta: secondWords.length - firstWords.length,
      knownLead: knownCount(second.rawText) - knownCount(first.rawText),
      punctuationChanged: punctuationSurface(first.rawText) !== punctuationSurface(second.rawText),
      capitalizationOnly: first.rawText.toLocaleLowerCase(locale) === second.rawText.toLocaleLowerCase(locale),
      productionSelectsSecond: ranked[0]?.visualRank === 1,
    }]
  })
  const output = `${JSON.stringify({ language, records }, null, 2)}\n`
  if (outputPath) {
    fs.writeFileSync(path.resolve(outputPath), output, { mode: 0o600 })
    console.log(`Beam-2-Diagnose gespeichert: ${outputPath}`)
  } else {
    process.stdout.write(output)
  }
} finally {
  await server.close()
}
