import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'

const [gatePath, sentencePath, language = 'en', outputPath] = process.argv.slice(2)
if (!gatePath || !sentencePath || !['de', 'en'].includes(language)) {
  throw new Error('Aufruf: node scripts/analyze-trocr-corpus-ranking.mjs GATES.json SENTENCES.txt de|en')
}

const payload = JSON.parse(fs.readFileSync(path.resolve(gatePath), 'utf8'))
if (!Array.isArray(payload.records)) throw new Error('Die Beam-2-Diagnose enthält keine Datensätze.')

const locale = language === 'de' ? 'de-CH' : 'en-US'
const wordPattern = language === 'de'
  ? /[A-Za-zÄÖÜäöü]+(?:['’-][A-Za-zÄÖÜäöü]+)*/gu
  : /[A-Za-z]+(?:['’-][A-Za-z]+)*/gu
const normalizeWord = (word) => word
  .normalize('NFC')
  .toLocaleLowerCase(locale)
  .replaceAll('ß', 'ss')
  .replaceAll('’', "'")
const words = (value) => (String(value).match(wordPattern) ?? []).map(normalizeWord)
const sequence = (value) => ['<s>', ...words(value), '</s>']
const pairKey = (left, right) => `${left}\u0000${right}`

const requestedWords = new Set(['<s>', '</s>'])
const requestedPairs = new Set()
for (const record of payload.records) {
  for (const candidate of [record.first, record.second]) {
    const tokens = sequence(candidate)
    tokens.forEach((word) => requestedWords.add(word))
    for (let index = 1; index < tokens.length; index += 1) {
      requestedPairs.add(pairKey(tokens[index - 1], tokens[index]))
    }
  }
}

const unigramCounts = new Map([...requestedWords].map((word) => [word, 0]))
const pairCounts = new Map([...requestedPairs].map((pair) => [pair, 0]))
let totalWords = 0
let sentenceCount = 0

const input = fs.createReadStream(path.resolve(sentencePath), { encoding: 'utf8' })
const lines = readline.createInterface({ input, crlfDelay: Infinity })
for await (const line of lines) {
  const tab = line.indexOf('\t')
  const text = tab >= 0 ? line.slice(tab + 1) : line
  const tokens = words(text)
  if (!tokens.length) continue
  sentenceCount += 1
  totalWords += tokens.length
  unigramCounts.set('<s>', (unigramCounts.get('<s>') ?? 0) + 1)
  unigramCounts.set('</s>', (unigramCounts.get('</s>') ?? 0) + 1)
  for (const word of tokens) {
    if (requestedWords.has(word)) unigramCounts.set(word, (unigramCounts.get(word) ?? 0) + 1)
  }
  const bounded = ['<s>', ...tokens, '</s>']
  for (let index = 1; index < bounded.length; index += 1) {
    const key = pairKey(bounded[index - 1], bounded[index])
    if (requestedPairs.has(key)) pairCounts.set(key, (pairCounts.get(key) ?? 0) + 1)
  }
}

const candidateFeatures = (value) => {
  const tokens = sequence(value)
  const lexical = tokens.slice(1, -1)
  const unigramLog = lexical.reduce((sum, word) => sum + Math.log1p(unigramCounts.get(word) ?? 0), 0)
  let conditionalLog = 0
  let supportedPairs = 0
  let pairLog = 0
  let pmi = 0
  for (let index = 1; index < tokens.length; index += 1) {
    const previous = tokens[index - 1]
    const current = tokens[index]
    const pair = pairCounts.get(pairKey(previous, current)) ?? 0
    const previousCount = Math.max(1, unigramCounts.get(previous) ?? 0)
    const currentCount = Math.max(0, unigramCounts.get(current) ?? 0)
    const unigramProbability = (currentCount + 0.25) / (totalWords + sentenceCount * 2 + 0.25 * 200_000)
    const backedOff = pair > 0
      ? 0.82 * pair / previousCount + 0.18 * unigramProbability
      : 0.16 * unigramProbability
    conditionalLog += Math.log(Math.max(1e-12, backedOff))
    if (pair > 0) supportedPairs += 1
    pairLog += Math.log1p(pair)
    pmi += Math.log((pair + 0.08) * Math.max(1, totalWords) / ((previousCount + 1) * (currentCount + 1)))
  }
  return {
    words: lexical.length,
    unigramLog,
    unigramMean: unigramLog / Math.max(1, lexical.length),
    conditionalLog,
    conditionalMean: conditionalLog / Math.max(1, tokens.length - 1),
    supportedPairs,
    pairLog,
    pmi,
  }
}

const records = payload.records.map((record) => {
  const firstFeatures = candidateFeatures(record.first)
  const secondFeatures = candidateFeatures(record.second)
  const lead = Object.fromEntries(Object.keys(firstFeatures).flatMap((key) => (
    key === 'words' ? [] : [[key, secondFeatures[key] - firstFeatures[key]]]
  )))
  return { ...record, corpus: { first: firstFeatures, second: secondFeatures, lead } }
})

const currentChoiceDistance = (record) => record.productionSelectsSecond
  ? record.secondContextDistance
  : record.firstContextDistance
const proposedDistance = (record, promoteSecond) => (
  record.productionSelectsSecond || promoteSecond ? record.secondContextDistance : record.firstContextDistance
)
const summarize = (selected, decide) => {
  let current = 0
  let proposed = 0
  let promoted = 0
  let improved = 0
  let worsened = 0
  for (const record of selected) {
    const promote = !record.productionSelectsSecond && decide(record)
    const before = currentChoiceDistance(record)
    const after = proposedDistance(record, promote)
    current += before
    proposed += after
    if (promote) promoted += 1
    if (after < before) improved += 1
    if (after > before) worsened += 1
  }
  return { lines: selected.length, current, proposed, gain: current - proposed, promoted, improved, worsened }
}

const features = ['unigramLog', 'unigramMean', 'conditionalLog', 'conditionalMean', 'supportedPairs', 'pairLog', 'pmi']
const candidates = []
for (const feature of features) {
  const values = [...new Set(records
    .filter((record) => !record.productionSelectsSecond)
    .map((record) => record.corpus.lead[feature])
    .filter(Number.isFinite))].sort((a, b) => a - b)
  const thresholds = [-Infinity, ...values.flatMap((value, index) => {
    const next = values[index + 1]
    return next === undefined ? [value] : [value, (value + next) / 2]
  }), Infinity]
  for (const threshold of thresholds) {
    const decide = (record) => record.corpus.lead[feature] > threshold
    const fold0 = summarize(records.filter((record) => record.fold === 0), decide)
    const fold1 = summarize(records.filter((record) => record.fold === 1), decide)
    const total = summarize(records, decide)
    candidates.push({ feature, threshold, fold0, fold1, total })
  }
}

const robust = candidates
  .filter((candidate) => candidate.fold0.gain > 0 && candidate.fold1.gain > 0)
  .sort((first, second) => (
    second.total.gain - first.total.gain ||
    first.total.worsened - second.total.worsened ||
    first.total.promoted - second.total.promoted
  ))
  .slice(0, 30)

const output = JSON.stringify({
  language,
  corpus: { sentenceCount, totalWords, requestedWords: requestedWords.size, requestedPairs: requestedPairs.size },
  baseline: summarize(records, () => false),
  robust,
  records,
}, null, 2)
if (outputPath) {
  fs.writeFileSync(path.resolve(outputPath), `${output}\n`, { mode: 0o600 })
  console.log(`Korpusdiagnose gespeichert: ${outputPath}`)
} else {
  console.log(output)
}
