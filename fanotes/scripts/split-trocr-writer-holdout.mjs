import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const [source, calibrationOutput, evaluationOutput, requestedSalt = 'fanotes-trocr-v1'] = process.argv.slice(2)
if (!source || !calibrationOutput || !evaluationOutput) {
  throw new Error('Usage: node scripts/split-trocr-writer-holdout.mjs SOURCE.json CALIBRATION.json EVALUATION.json [SALT]')
}

const benchmark = JSON.parse(fs.readFileSync(path.resolve(source), 'utf8'))
if (!Array.isArray(benchmark.predictions) || benchmark.predictions.length < 2) {
  throw new Error('The benchmark contains no usable predictions.')
}
if (benchmark.source?.writerDisjoint !== true || benchmark.source?.grouping !== 'scads-page-id') {
  throw new Error('The benchmark does not provide writer-disjoint ScaDS page groups.')
}
if (typeof requestedSalt !== 'string' || requestedSalt.length < 3 || requestedSalt.length > 80) {
  throw new Error('The split salt is invalid.')
}

const editDistance = (first, second) => {
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

const foldForGroup = (groupId) => crypto
  .createHash('sha256')
  .update(`${requestedSalt}:${groupId}`)
  .digest()[0] % 2

const groups = new Map()
for (const prediction of benchmark.predictions) {
  if (typeof prediction?.groupId !== 'string' || !/^[A-Za-z0-9._-]{1,80}$/u.test(prediction.groupId)) {
    throw new Error('A benchmark prediction has no valid writer group.')
  }
  const fold = foldForGroup(prediction.groupId)
  const previous = groups.get(prediction.groupId)
  if (previous !== undefined && previous !== fold) throw new Error('A writer group crosses both folds.')
  groups.set(prediction.groupId, fold)
}

const subset = (fold, role) => {
  const predictions = benchmark.predictions.filter((prediction) => groups.get(prediction.groupId) === fold)
  const characters = predictions.reduce((sum, prediction) => sum + Array.from(String(prediction.truth ?? '')).length, 0)
  const characterEdits = predictions.reduce((sum, prediction) => (
    sum + editDistance(String(prediction.truth ?? ''), String(prediction.candidates?.[0] ?? prediction.prediction ?? ''))
  ), 0)
  const groupIds = [...new Set(predictions.map((prediction) => prediction.groupId))].sort()
  return {
    model: benchmark.model,
    runtime: benchmark.runtime,
    source: {
      ...benchmark.source,
      parentRole: benchmark.source.role,
      role,
      groupSplit: 'sha256-salted-page-id-mod2',
      splitSalt: requestedSalt,
      groups: groupIds.length,
    },
    numBeams: benchmark.numBeams,
    numReturnSequences: benchmark.numReturnSequences,
    sampleCount: predictions.length,
    characters,
    characterEdits,
    cer: characterEdits / Math.max(1, characters),
    predictions,
  }
}

const calibration = subset(0, 'calibration')
const evaluation = subset(1, 'evaluation')
if (!calibration.sampleCount || !evaluation.sampleCount) throw new Error('The deterministic writer split produced an empty fold.')
const calibrationGroups = new Set(calibration.predictions.map((prediction) => prediction.groupId))
if (evaluation.predictions.some((prediction) => calibrationGroups.has(prediction.groupId))) {
  throw new Error('Writer leakage detected between calibration and evaluation.')
}

fs.writeFileSync(path.resolve(calibrationOutput), `${JSON.stringify(calibration, null, 2)}\n`, { mode: 0o600 })
fs.writeFileSync(path.resolve(evaluationOutput), `${JSON.stringify(evaluation, null, 2)}\n`, { mode: 0o600 })
console.log(`Writer-disjoint split: ${calibration.source.groups} groups/${calibration.sampleCount} lines calibration; ${evaluation.source.groups} groups/${evaluation.sampleCount} lines evaluation.`)
