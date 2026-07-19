import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'

const [gatePath, arpaPath, language = 'en', outputPath] = process.argv.slice(2)
if (!gatePath || !arpaPath || !['de', 'en'].includes(language)) {
  throw new Error('Aufruf: node scripts/analyze-trocr-char-lm-ranking.mjs GATES.json MODEL.arpa de|en [OUTPUT.json]')
}

const payload = JSON.parse(fs.readFileSync(path.resolve(gatePath), 'utf8'))
if (!Array.isArray(payload.records)) throw new Error('Die Beam-2-Diagnose enthält keine Datensätze.')

const probabilities = Array.from({ length: 7 }, () => new Map())
const backoffs = Array.from({ length: 7 }, () => new Map())
let order = 0
const input = fs.createReadStream(path.resolve(arpaPath), { encoding: 'utf8' })
const lines = readline.createInterface({ input, crlfDelay: Infinity })
for await (const line of lines) {
  const section = /^\\(\d+)-grams:$/u.exec(line.trim())
  if (section) {
    order = Number(section[1])
    continue
  }
  if (!order || !line || line.startsWith('\\')) continue
  const fields = line.split('\t')
  if (fields.length < 2) continue
  const probability = Number(fields[0])
  const tokens = fields[1].split(' ')
  if (!Number.isFinite(probability) || tokens.length !== order) continue
  const key = tokens.join('\u0000')
  probabilities[order].set(key, probability)
  const backoff = Number(fields[2])
  if (Number.isFinite(backoff)) backoffs[order].set(key, backoff)
}

const maximumOrder = probabilities.reduce((best, entries, index) => entries.size ? index : best, 0)
const vocabulary = probabilities[1]
const normalize = (value) => {
  const plain = String(value)
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .replaceAll('ß', 'ss')
    .replace(/\s+/gu, ' ')
    .trim()
  const tokens = []
  for (const character of Array.from(plain)) {
    const token = character === ' ' ? '⎵' : character
    tokens.push(vocabulary.has(token) ? token : '<unk>')
  }
  return tokens
}

const conditionalScore = (history, token) => {
  let accumulatedBackoff = 0
  const usable = history.slice(-Math.max(0, maximumOrder - 1))
  for (let length = usable.length; length >= 0; length -= 1) {
    const context = length ? usable.slice(-length) : []
    const gram = [...context, token]
    const probability = probabilities[gram.length].get(gram.join('\u0000'))
    if (probability !== undefined) return accumulatedBackoff + probability
    if (context.length) accumulatedBackoff += backoffs[context.length].get(context.join('\u0000')) ?? 0
  }
  return accumulatedBackoff + (probabilities[1].get('<unk>') ?? -10)
}

const score = (value) => {
  const tokens = ['<s>', ...normalize(value), '</s>']
  let total = 0
  for (let index = 1; index < tokens.length; index += 1) {
    total += conditionalScore(tokens.slice(0, index), tokens[index])
  }
  return { total, mean: total / Math.max(1, tokens.length - 1), characters: tokens.length - 2 }
}

const records = payload.records.map((record) => {
  const first = score(record.first)
  const second = score(record.second)
  return {
    ...record,
    charLm: {
      first,
      second,
      totalLead: second.total - first.total,
      meanLead: second.mean - first.mean,
    },
  }
})

const currentChoiceDistance = (record) => record.productionSelectsSecond
  ? record.secondContextDistance
  : record.firstContextDistance
const summarize = (selected, decide) => {
  let current = 0
  let proposed = 0
  let promoted = 0
  let improved = 0
  let worsened = 0
  for (const record of selected) {
    const promote = !record.productionSelectsSecond && decide(record)
    const before = currentChoiceDistance(record)
    const after = record.productionSelectsSecond || promote
      ? record.secondContextDistance
      : record.firstContextDistance
    current += before
    proposed += after
    if (promote) promoted += 1
    if (after < before) improved += 1
    if (after > before) worsened += 1
  }
  return { lines: selected.length, current, proposed, gain: current - proposed, promoted, improved, worsened }
}

const thresholdsFor = (feature) => {
  const values = [...new Set(records
    .filter((record) => !record.productionSelectsSecond)
    .map((record) => record.charLm[feature])
    .filter(Number.isFinite))].sort((left, right) => left - right)
  return [-Infinity, ...values.flatMap((value, index) => (
    values[index + 1] === undefined ? [value] : [value, (value + values[index + 1]) / 2]
  )), Infinity]
}

const configurations = []
for (const feature of ['totalLead', 'meanLead']) {
  for (const threshold of thresholdsFor(feature)) {
    const decide = (record) => record.charLm[feature] > threshold
    configurations.push({
      feature,
      threshold,
      fold0: summarize(records.filter((record) => record.fold === 0), decide),
      fold1: summarize(records.filter((record) => record.fold === 1), decide),
      total: summarize(records, decide),
    })
  }
}
const robust = configurations
  .filter((entry) => entry.fold0.gain > 0 && entry.fold1.gain > 0)
  .sort((first, second) => (
    second.total.gain - first.total.gain ||
    first.total.worsened - second.total.worsened ||
    first.total.promoted - second.total.promoted
  ))
  .slice(0, 40)

const output = JSON.stringify({
  language,
  model: {
    maximumOrder,
    ngrams: probabilities.reduce((sum, entries) => sum + entries.size, 0),
  },
  baseline: summarize(records, () => false),
  robust,
  records,
}, null, 2)
if (outputPath) {
  fs.writeFileSync(path.resolve(outputPath), `${output}\n`, { mode: 0o600 })
  console.log(`Zeichenmodell-Diagnose gespeichert: ${outputPath}`)
} else {
  console.log(output)
}
