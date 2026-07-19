import fs from 'node:fs'
import path from 'node:path'
import { createServer } from 'vite'

const [source, requestedLanguage, output] = process.argv.slice(2)
if (!source || !output || !['de', 'en'].includes(requestedLanguage)) {
  throw new Error('Aufruf: node scripts/extract-trocr-production-changes.mjs BENCHMARK.json de|en OUTPUT.json')
}
const language = requestedLanguage
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

const server = await createServer({
  appType: 'custom',
  logLevel: 'error',
  optimizeDeps: { noDiscovery: true },
  server: { middlewareMode: true, hmr: false },
})

try {
  const { rankTrocrCandidateTextsForTests } = await server.ssrLoadModule('/src/lib/neuralTextRecognition.ts')
  const { installNeuralWordContextCandidates } = await server.ssrLoadModule('/src/lib/neuralWordContext.ts')
  const words = fs.readFileSync(path.resolve(`public/spell/${language}.words`), 'utf8').trimEnd().split('\n')
  const dictionary = new Set(words)
  installNeuralWordContextCandidates(language, words)
  const locale = language === 'de' ? 'de-CH' : 'en-US'
  const wordMembership = (word) => dictionary.has(word.toLocaleLowerCase(locale).replaceAll('ß', 'ss'))
  const changes = []
  let characters = 0
  let visualEdits = 0
  let productionEdits = 0

  for (const [index, record] of benchmark.predictions.entries()) {
    const truth = String(record.truth ?? '')
    const candidates = Array.isArray(record.candidates) ? record.candidates.map(String) : []
    if (!truth || !candidates.length) throw new Error(`Ungültige N-Best-Zeile ${index + 1}.`)
    const ranking = rankTrocrCandidateTextsForTests(candidates, language, wordMembership)
    const visual = candidates[0]
    const current = ranking[0]?.rawText ?? visual
    const visualDistance = distance(truth, visual)
    const currentDistance = distance(truth, current)
    characters += Array.from(truth).length
    visualEdits += visualDistance
    productionEdits += currentDistance
    if (current === visual) continue
    changes.push({
      delta: visualDistance - currentDistance,
      truth,
      visual,
      current,
      ranking: ranking.map((entry) => ({
        text: entry.rawText,
        score: Math.round(entry.score * 100) / 100,
        base: Math.round(entry.baseScore * 100) / 100,
      })),
    })
  }
  changes.sort((first, second) => first.delta - second.delta)
  fs.writeFileSync(path.resolve(output), `${JSON.stringify({
    language,
    lines: benchmark.predictions.length,
    characters,
    visualEdits,
    productionEdits,
    improved: changes.filter((entry) => entry.delta > 0).length,
    worsened: changes.filter((entry) => entry.delta < 0).length,
    neutral: changes.filter((entry) => entry.delta === 0).length,
    changes,
  }, null, 2)}\n`, { mode: 0o600 })
  console.log(`${language}: ${changes.length} produktive Wechsel, ${visualEdits} → ${productionEdits} Zeichenfehler.`)
} finally {
  await server.close()
}
