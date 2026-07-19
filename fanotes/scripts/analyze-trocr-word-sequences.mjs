import fs from 'node:fs'
import path from 'node:path'
import { createServer } from 'vite'

const source = process.argv[2]
if (!source) throw new Error('Aufruf: node scripts/analyze-trocr-word-sequences.mjs BENCHMARK.json [de|en]')
const language = process.argv[3] === 'de' ? 'de' : 'en'
const benchmark = JSON.parse(fs.readFileSync(path.resolve(source), 'utf8'))
if (!Array.isArray(benchmark.predictions)) throw new Error('Der Benchmark enthält keine N-Best-Vorhersagen.')

const corpusRoot = language === 'de'
  ? '/srv/codex-web/model-work/fanotes-ocr/corpora/deu_mixed-typical_2011_100K'
  : '/srv/codex-web/model-work/fanotes-ocr/corpora/eng_news_2024_100K'
const corpusPrefix = language === 'de' ? 'deu_mixed-typical_2011_100K' : 'eng_news_2024_100K'
const normalizeWord = (value) => value
  .normalize('NFC')
  .toLocaleLowerCase(language === 'de' ? 'de-CH' : 'en-US')
  .replaceAll('ß', 'ss')

const wordsById = []
const wordCounts = new Map()
for (const line of fs.readFileSync(path.join(corpusRoot, `${corpusPrefix}-words.txt`), 'utf8').split('\n')) {
  if (!line) continue
  const [rawId, rawWord, rawCount] = line.split('\t')
  const id = Number(rawId)
  const word = normalizeWord(rawWord ?? '')
  const count = Number(rawCount) || 0
  if (!Number.isSafeInteger(id) || !word) continue
  wordsById[id] = word
  wordCounts.set(word, (wordCounts.get(word) ?? 0) + count)
}

const pairStats = new Map()
for (const line of fs.readFileSync(path.join(corpusRoot, `${corpusPrefix}-co_n.txt`), 'utf8').split('\n')) {
  if (!line) continue
  const [rawLeft, rawRight, rawCount, rawSignificance] = line.split('\t')
  const left = wordsById[Number(rawLeft)]
  const right = wordsById[Number(rawRight)]
  if (!left || !right || !/^\p{L}/u.test(left) || !/^\p{L}/u.test(right)) continue
  const key = `${left}\u0000${right}`
  const previous = pairStats.get(key) ?? { count: 0, significance: 0 }
  previous.count += Number(rawCount) || 0
  previous.significance += Number(rawSignificance) || 0
  pairStats.set(key, previous)
}

const sequenceWords = (text) => (text.match(/\p{L}+(?:['’]\p{L}+)*/gu) ?? [])
  .map(normalizeWord)
  .filter(Boolean)

const pairSupport = (left, right) => {
  const pair = pairStats.get(`${left}\u0000${right}`)
  if (!pair) return 0
  // co_n is already pruned to statistically relevant direct neighbours.
  // Presence is useful evidence; frequency and association only refine it.
  const frequency = Math.min(1, Math.log1p(pair.count) / Math.log(80))
  const association = Math.min(1, Math.log1p(pair.significance) / Math.log(2_500))
  return 0.42 + frequency * 0.34 + association * 0.24
}

const wordSequenceScore = (text) => {
  const words = sequenceWords(text)
  let score = 0
  for (let index = 1; index < words.length; index += 1) {
    score += pairSupport(words[index - 1], words[index])
  }
  return score
}

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

const weights = [0, 0.15, 0.25, 0.35, 0.5, 0.65, 0.8, 1, 1.25, 1.5, 1.75, 2, 2.5, 3]
const metric = () => ({ characters: 0, edits: 0, exact: 0, changed: 0, improved: 0, worsened: 0 })
const metrics = new Map(weights.map((weight) => [weight, [metric(), metric(), metric()]]))
const records = []

const server = await createServer({
  appType: 'custom',
  logLevel: 'error',
  optimizeDeps: { noDiscovery: true },
  server: { middlewareMode: true },
})

try {
  const { rankTrocrCandidateTextsForTests } = await server.ssrLoadModule('/src/lib/neuralTextRecognition.ts')
  const { installNeuralWordContextCandidates } = await server.ssrLoadModule('/src/lib/neuralWordContext.ts')
  const dictionaryWords = fs.readFileSync(path.resolve(`public/spell/${language}.words`), 'utf8').trimEnd().split('\n')
  const dictionary = new Set(dictionaryWords)
  installNeuralWordContextCandidates(language, dictionaryWords)
  const wordMembership = (word) => dictionary.has(normalizeWord(word))

  for (const [recordIndex, record] of benchmark.predictions.entries()) {
    const truth = String(record.truth ?? '')
    const candidates = Array.isArray(record.candidates) ? record.candidates.map(String) : []
    if (!truth || !candidates.length) continue
    const ranked = rankTrocrCandidateTextsForTests(candidates, language, wordMembership)
      .map((entry) => ({ ...entry, sequenceScore: wordSequenceScore(entry.text) }))
    const top = ranked[0]?.rawText ?? candidates[0]
    const topDistance = distance(truth, top)
    const fold = recordIndex % 2
    for (const weight of weights) {
      const selected = [...ranked].sort((first, second) => (
        (second.score + second.sequenceScore * weight) -
        (first.score + first.sequenceScore * weight)
      ))[0]?.rawText ?? top
      const selectedDistance = distance(truth, selected)
      for (const bucket of [0, fold + 1]) {
        const current = metrics.get(weight)[bucket]
        current.characters += Array.from(truth).length
        current.edits += selectedDistance
        current.exact += Number(selected === truth)
        current.changed += Number(selected !== top)
        current.improved += Number(selectedDistance < topDistance)
        current.worsened += Number(selectedDistance > topDistance)
      }
    }
    records.push({ truth, top, topDistance, ranked })
  }

  const summarized = (value) => ({
    cer: value.edits / Math.max(1, value.characters),
    exact: value.exact,
    changed: value.changed,
    improved: value.improved,
    worsened: value.worsened,
  })
  const result = weights.map((weight) => ({
    weight,
    all: summarized(metrics.get(weight)[0]),
    even: summarized(metrics.get(weight)[1]),
    odd: summarized(metrics.get(weight)[2]),
  }))
  const bestFor = (bucket) => [...result].sort((first, second) => (
    first[bucket].cer - second[bucket].cer ||
    second[bucket].exact - first[bucket].exact ||
    first.weight - second.weight
  ))[0]
  const tunedOnEven = bestFor('even')
  const tunedOnOdd = bestFor('odd')
  console.log(JSON.stringify({
    language,
    lines: records.length,
    corpusWords: wordCounts.size,
    corpusPairs: pairStats.size,
    weights: result,
    crossValidation: {
      tunedOnEven: { weight: tunedOnEven.weight, evaluationOnOdd: tunedOnEven.odd },
      tunedOnOdd: { weight: tunedOnOdd.weight, evaluationOnEven: tunedOnOdd.even },
    },
  }, null, 2))

  const requestedWeight = Number(process.env.FANOTES_WORDSEQ_WEIGHT)
  const selectedWeight = weights.includes(requestedWeight) ? requestedWeight : bestFor('all').weight
  records.flatMap((record) => {
    const selected = [...record.ranked].sort((first, second) => (
      (second.score + second.sequenceScore * selectedWeight) -
      (first.score + first.sequenceScore * selectedWeight)
    ))[0]
    if (!selected || selected.rawText === record.top) return []
    return [{
      delta: record.topDistance - distance(record.truth, selected.rawText),
      truth: record.truth,
      top: record.top,
      selected: selected.rawText,
      ranking: record.ranked.map((entry) => ({
        text: entry.rawText,
        visual: Math.round(entry.score * 100) / 100,
        sequence: Math.round(entry.sequenceScore * 100) / 100,
      })),
    }]
  })
    .sort((first, second) => second.delta - first.delta)
    .slice(0, 30)
    .forEach((entry) => console.log(`${entry.delta >= 0 ? '+' : ''}${entry.delta} ${JSON.stringify(entry)}`))
} finally {
  await server.close()
}
