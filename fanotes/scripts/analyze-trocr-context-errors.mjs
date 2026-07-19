import fs from 'node:fs'
import path from 'node:path'
import { createServer } from 'vite'

const source = process.argv[2]
if (!source) throw new Error('Aufruf: node scripts/analyze-trocr-context-errors.mjs BENCHMARK.json [de|en]')
const language = process.argv[3] === 'de' ? 'de' : 'en'
const benchmark = JSON.parse(fs.readFileSync(path.resolve(source), 'utf8'))
if (!Array.isArray(benchmark.predictions)) throw new Error('Der Benchmark enthält keine Vorhersagen.')

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

const folded = (value) => value.toLocaleLowerCase(language === 'de' ? 'de-CH' : 'en-US')
const lettersAndDigits = (value) => folded(value).replace(/[^\p{L}\d]/gu, '')
const normalizeSurface = (value) => String(value ?? '')
  .normalize('NFC')
  .replace(/[ \t]{2,}/gu, ' ')
  .replace(/\s+([,.;:!?])/gu, '$1')
  .trim()
const classify = (truth, prediction) => {
  if (truth === prediction) return 'exact'
  if (folded(truth) === folded(prediction)) return 'case-only'
  if (truth.replace(/\s+/gu, '') === prediction.replace(/\s+/gu, '')) return 'spacing-only'
  if (lettersAndDigits(truth) === lettersAndDigits(prediction)) return 'punctuation-or-spacing'
  return 'content'
}

const metric = () => ({ characters: 0, edits: 0, exact: 0 })
const add = (target, truth, prediction) => {
  target.characters += Array.from(truth).length
  target.edits += distance(truth, prediction)
  target.exact += Number(truth === prediction)
}
const summarize = (target, lines) => ({
  cer: target.edits / Math.max(1, target.characters),
  exact: target.exact,
  exactRate: target.exact / Math.max(1, lines),
})

const server = await createServer({
  appType: 'custom',
  logLevel: 'error',
  optimizeDeps: { noDiscovery: true },
  server: { middlewareMode: true },
})

try {
  const {
    applyFinalNeuralWordContext,
    applyNeuralWordContext,
    installNeuralWordContextCandidates,
  } = await server.ssrLoadModule('/src/lib/neuralWordContext.ts')
  const words = fs.readFileSync(path.resolve(`public/spell/${language}.words`), 'utf8').trimEnd().split('\n')
  installNeuralWordContextCandidates(language, words)

  const rawMetric = metric()
  const localMetric = metric()
  const finalMetric = metric()
  const categories = new Map()
  const changes = []
  benchmark.predictions.forEach((record) => {
    const truth = normalizeSurface(record.truth)
    const raw = normalizeSurface(record.prediction ?? record.candidates?.[0])
    if (!truth || !raw) return
    const local = applyNeuralWordContext(raw, language)
    const final = applyFinalNeuralWordContext(local, language)
    add(rawMetric, truth, raw)
    add(localMetric, truth, local)
    add(finalMetric, truth, final)
    const category = classify(truth, final)
    categories.set(category, (categories.get(category) ?? 0) + 1)
    if (raw !== final) changes.push({
      delta: distance(truth, raw) - distance(truth, final),
      truth,
      raw,
      local,
      final,
    })
  })

  const lines = benchmark.predictions.length
  console.log(JSON.stringify({
    language,
    lines,
    raw: summarize(rawMetric, lines),
    commonLexiconContext: summarize(localMetric, lines),
    fullDictionaryContext: summarize(finalMetric, lines),
    changes: {
      total: changes.length,
      improved: changes.filter((entry) => entry.delta > 0).length,
      neutral: changes.filter((entry) => entry.delta === 0).length,
      worsened: changes.filter((entry) => entry.delta < 0).length,
    },
    remainingErrorCategories: Object.fromEntries([...categories].sort()),
  }, null, 2))
  changes
    .sort((first, second) => second.delta - first.delta)
    .forEach((entry) => console.log(`${entry.delta >= 0 ? '+' : ''}${entry.delta} ${JSON.stringify(entry)}`))
  console.log('REMAINING')
  benchmark.predictions
    .map((record) => {
      const truth = normalizeSurface(record.truth)
      const raw = normalizeSurface(record.prediction ?? record.candidates?.[0])
      const final = applyFinalNeuralWordContext(applyNeuralWordContext(raw, language), language)
      return { edits: distance(truth, final), category: classify(truth, final), truth, raw, final }
    })
    .filter((entry) => entry.edits > 0)
    .sort((first, second) => second.edits - first.edits)
    .slice(0, Math.max(1, Number.parseInt(process.env.FANOTES_CONTEXT_REMAINING_LIMIT ?? '40', 10) || 40))
    .forEach((entry) => console.log(`${entry.edits} ${entry.category} ${JSON.stringify(entry)}`))
} finally {
  await server.close()
}
