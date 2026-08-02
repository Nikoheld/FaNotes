import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

/**
 * Lightweight, offline personal/base calibration audit.
 *
 * This script deliberately does not start Chromium and does not load an OCR
 * model.  It consumes the detailed JSON emitted once by
 * audit-uji-personal-recognition.mjs with FANOTES_UJI_INCLUDE_CASES=1, then
 * evaluates all calibration parameters in memory.  Writers, rather than
 * individual glyphs, form the split boundary so one writer's second session
 * can never leak into the final validation set.
 *
 * Usage:
 *   node fanotes/scripts/analyze-uji-personal-base-calibration.mjs audit.json
 *
 * Set FANOTES_CALIBRATION_STRICT=1 to fail unless the untouched validation
 * writers pass every acceptance gate below.
 */

const input = path.resolve(process.argv[2] ?? process.env.FANOTES_UJI_CALIBRATION_INPUT ?? '')
assert.ok(process.argv[2] || process.env.FANOTES_UJI_CALIBRATION_INPUT, [
  'Usage: node fanotes/scripts/analyze-uji-personal-base-calibration.mjs <detailed-uji-audit.json>',
  'The input must contain writerIndependent.cases (run the producer with FANOTES_UJI_INCLUDE_CASES=1).',
].join('\n'))
assert.ok(fs.existsSync(input), `Calibration input does not exist: ${input}`)

const payload = JSON.parse(fs.readFileSync(input, 'utf8'))
const genericCases = payload?.writerIndependent?.cases
const personalCases = payload?.personal?.cases ?? []
assert.ok(Array.isArray(genericCases) && genericCases.length > 0, [
  'The audit has no writerIndependent.cases.',
  'Generate one detailed trace with FANOTES_UJI_INCLUDE_CASES=1, then reuse it for every sweep.',
].join(' '))

const lower = (value) => String(value ?? '').toLocaleLowerCase('en')
const round = (value, digits = 4) => {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

const candidateForSelected = (entry) => {
  const alternatives = Array.isArray(entry.alternatives) ? entry.alternatives : []
  const match = alternatives.find((candidate) => candidate.char === entry.recognized)
  return match ?? {
    char: entry.recognized,
    confidence: entry.confidence ?? 0,
    baseConfidence: entry.baseConfidence ?? 0,
    personalConfidence: entry.personalConfidence ?? 0,
    personalSupport: entry.personalSupport ?? 0,
  }
}

const candidatesFor = (entry) => {
  const selected = candidateForSelected(entry)
  const byCharacter = new Map()
  ;[selected, ...(entry.alternatives ?? [])].forEach((candidate) => {
    if (!candidate?.char) return
    const previous = byCharacter.get(candidate.char)
    if (!previous || (candidate.confidence ?? 0) > (previous.confidence ?? 0)) {
      byCharacter.set(candidate.char, candidate)
    }
  })
  return { selected, candidates: [...byCharacter.values()] }
}

const parameterValues = {
  baseWeight: [0, 0.05, 0.1, 0.15, 0.2, 0.25, 0.3],
  personalWeight: [0, 0.05, 0.1, 0.15, 0.2, 0.25, 0.3],
  consensusWeight: [0, 0.1, 0.2],
  switchMargin: [0, 1, 2, 3, 4, 5, 6],
}

const parameters = parameterValues.baseWeight.flatMap((baseWeight) => (
  parameterValues.personalWeight.flatMap((personalWeight) => (
    parameterValues.consensusWeight.flatMap((consensusWeight) => (
      parameterValues.switchMargin.map((switchMargin) => ({
        baseWeight,
        personalWeight,
        consensusWeight,
        switchMargin,
      }))
    ))
  ))
))

// An actual user's explicit GlyphenWerk/correction evidence is a late overlay,
// not another generic ensemble member.  This guard is intentionally absolute:
// a generic calibration candidate may be measured, but it may not replace a
// selected label on a same-writer personal holdout that has direct support.
const isExplicitlyProtected = (entry, selected, source) => (
  source === 'personal' &&
  (selected.personalSupport ?? entry.personalSupport ?? 0) > 0 &&
  (selected.personalConfidence ?? entry.personalConfidence ?? 0) > 0
)

const choose = (entry, calibration, source = 'generic') => {
  const { selected, candidates } = candidatesFor(entry)
  if (isExplicitlyProtected(entry, selected, source)) {
    return { candidate: selected, changed: false, protected: true }
  }
  const selectedConsensus = Math.min(
    selected.baseConfidence ?? 0,
    selected.personalConfidence ?? 0,
  )
  let winner = selected
  let winnerAdvantage = calibration.switchMargin
  candidates.forEach((candidate) => {
    if (candidate.char === selected.char) return
    const advantage =
      (candidate.confidence ?? 0) - (selected.confidence ?? 0) +
      calibration.baseWeight * (
        (candidate.baseConfidence ?? 0) - (selected.baseConfidence ?? 0)
      ) +
      calibration.personalWeight * (
        (candidate.personalConfidence ?? 0) - (selected.personalConfidence ?? 0)
      ) +
      calibration.consensusWeight * (
        Math.min(candidate.baseConfidence ?? 0, candidate.personalConfidence ?? 0) -
        selectedConsensus
      )
    if (advantage > winnerAdvantage) {
      winner = candidate
      winnerAdvantage = advantage
    }
  })
  return {
    candidate: winner,
    changed: winner.char !== selected.char,
    protected: false,
  }
}

const baselineCalibration = {
  baseWeight: 0,
  personalWeight: 0,
  consensusWeight: 0,
  switchMargin: Number.POSITIVE_INFINITY,
}

const summarize = (cases, calibration, source = 'generic') => {
  let exact = 0
  let caseNormalized = 0
  let wins = 0
  let regressions = 0
  let changes = 0
  let protectedCases = 0
  let protectedChanges = 0
  let expectedCovered = 0
  const byExpected = new Map()
  const byWriter = new Map()

  cases.forEach((entry) => {
    const baseline = entry.recognized ?? ''
    const decision = choose(entry, calibration, source)
    const recognized = decision.candidate?.char ?? baseline
    const baselineCorrect = baseline === entry.expected
    const correct = recognized === entry.expected
    if (correct) exact += 1
    if (lower(recognized) === lower(entry.expected)) caseNormalized += 1
    if (correct && !baselineCorrect) wins += 1
    if (!correct && baselineCorrect) regressions += 1
    if (recognized !== baseline) changes += 1
    if (decision.protected) protectedCases += 1
    if (decision.protected && recognized !== baseline) protectedChanges += 1
    if ((entry.alternatives ?? []).some((candidate) => candidate.char === entry.expected)) expectedCovered += 1

    const classResult = byExpected.get(entry.expected) ?? { correct: 0, count: 0 }
    classResult.count += 1
    if (correct) classResult.correct += 1
    byExpected.set(entry.expected, classResult)

    const writerResult = byWriter.get(entry.writer) ?? { correct: 0, count: 0 }
    writerResult.count += 1
    if (correct) writerResult.correct += 1
    byWriter.set(entry.writer, writerResult)
  })

  const classAccuracies = [...byExpected.values()].map((entry) => entry.correct / entry.count)
  const perWriter = [...byWriter.entries()].map(([writer, entry]) => ({
    writer,
    samples: entry.count,
    exactAccuracy: round(entry.correct / entry.count * 100),
  })).sort((first, second) => first.writer.localeCompare(second.writer))
  return {
    samples: cases.length,
    exactAccuracy: round(exact / Math.max(1, cases.length) * 100),
    caseNormalizedAccuracy: round(caseNormalized / Math.max(1, cases.length) * 100),
    macroCharacterAccuracy: round(
      classAccuracies.reduce((sum, value) => sum + value, 0) /
      Math.max(1, classAccuracies.length) * 100,
    ),
    candidateCoverage: round(expectedCovered / Math.max(1, cases.length) * 100),
    changes,
    wins,
    regressions,
    netWins: wins - regressions,
    protectedCases,
    protectedChanges,
    perWriter,
  }
}

const delta = (candidate, baseline) => ({
  exactAccuracy: round(candidate.exactAccuracy - baseline.exactAccuracy),
  caseNormalizedAccuracy: round(
    candidate.caseNormalizedAccuracy - baseline.caseNormalizedAccuracy,
  ),
  macroCharacterAccuracy: round(
    candidate.macroCharacterAccuracy - baseline.macroCharacterAccuracy,
  ),
})

const writers = [...new Set(genericCases.map((entry) => entry.writer))].sort()
assert.ok(writers.length >= 4, `At least four independent writers are required; found ${writers.length}.`)
// Alternating sorted writer IDs keeps UJI and UPV contributors represented on
// both sides for the standard twelve-writer audit while remaining deterministic.
const developmentWriters = writers.filter((_writer, index) => index % 2 === 0)
const validationWriters = writers.filter((_writer, index) => index % 2 === 1)
const developmentSet = new Set(developmentWriters)
const validationSet = new Set(validationWriters)
const tuningCases = genericCases.filter((entry) => (
  developmentSet.has(entry.writer) && entry.session === 1
))
const driftCases = genericCases.filter((entry) => (
  developmentSet.has(entry.writer) && entry.session === 2
))
const validationCases = genericCases.filter((entry) => validationSet.has(entry.writer))
assert.ok(tuningCases.length && driftCases.length && validationCases.length, 'The writer/session split is incomplete.')

const baseline = {
  tuning: summarize(tuningCases, baselineCalibration),
  sessionDrift: summarize(driftCases, baselineCalibration),
  validation: summarize(validationCases, baselineCalibration),
  personalSafeguard: summarize(personalCases, baselineCalibration, 'personal'),
}

const ranked = parameters.map((calibration) => {
  const tuning = summarize(tuningCases, calibration)
  const sessionDrift = summarize(driftCases, calibration)
  const personalSafeguard = summarize(personalCases, calibration, 'personal')
  return {
    calibration,
    tuning,
    sessionDrift,
    personalSafeguard,
    tuningDelta: delta(tuning, baseline.tuning),
    driftDelta: delta(sessionDrift, baseline.sessionDrift),
  }
}).filter((entry) => (
  entry.tuningDelta.exactAccuracy > 0 &&
  entry.driftDelta.exactAccuracy >= 0 &&
  entry.driftDelta.caseNormalizedAccuracy >= 0 &&
  entry.personalSafeguard.protectedChanges === 0 &&
  entry.personalSafeguard.exactAccuracy >= baseline.personalSafeguard.exactAccuracy &&
  entry.personalSafeguard.caseNormalizedAccuracy >= baseline.personalSafeguard.caseNormalizedAccuracy
)).sort((first, second) => (
  second.tuning.exactAccuracy - first.tuning.exactAccuracy ||
  second.sessionDrift.exactAccuracy - first.sessionDrift.exactAccuracy ||
  second.tuning.macroCharacterAccuracy - first.tuning.macroCharacterAccuracy ||
  first.tuning.regressions - second.tuning.regressions ||
  (
    first.calibration.baseWeight +
    first.calibration.personalWeight +
    first.calibration.consensusWeight
  ) - (
    second.calibration.baseWeight +
    second.calibration.personalWeight +
    second.calibration.consensusWeight
  ) ||
  second.calibration.switchMargin - first.calibration.switchMargin
))

const selectedDevelopmentCandidate = ranked[0] ?? null
const selectedCalibration = selectedDevelopmentCandidate?.calibration ?? baselineCalibration
const validation = summarize(validationCases, selectedCalibration)
const personalSafeguard = summarize(personalCases, selectedCalibration, 'personal')
const validationDelta = delta(validation, baseline.validation)

const baselineWriterAccuracy = new Map(
  baseline.validation.perWriter.map((entry) => [entry.writer, entry.exactAccuracy]),
)
const perWriterDeltas = validation.perWriter.map((entry) => ({
  writer: entry.writer,
  exactAccuracy: round(entry.exactAccuracy - (baselineWriterAccuracy.get(entry.writer) ?? 0)),
}))
const nonRegressingWriters = perWriterDeltas.filter((entry) => entry.exactAccuracy >= 0).length
const worstWriterDelta = Math.min(...perWriterDeltas.map((entry) => entry.exactAccuracy))

// Exact one-sided sign-test tail for the paired changed predictions.  It is
// intentionally evaluated only on untouched validation writers.
const binomialTail = (wins, regressions) => {
  const count = wins + regressions
  if (!count) return 1
  let probability = 2 ** -count
  let term = probability
  for (let successes = 1; successes <= count; successes += 1) {
    term *= (count - successes + 1) / successes
    if (successes >= wins) probability += term
  }
  return Math.min(1, probability)
}
const pairedSignP = binomialTail(validation.wins, validation.regressions)

const gates = {
  developmentCandidateExists: Boolean(selectedDevelopmentCandidate),
  validationExactGainAtLeast025pp: validationDelta.exactAccuracy >= 0.25,
  validationCaseAccuracyNonRegressing: validationDelta.caseNormalizedAccuracy >= 0,
  validationMacroAccuracyNonRegressing: validationDelta.macroCharacterAccuracy >= 0,
  validationNetWinsPositive: validation.netWins > 0,
  pairedSignTestAtMost010: pairedSignP <= 0.1,
  atLeastHalfValidationWritersNonRegressing: nonRegressingWriters >= Math.ceil(validationWriters.length / 2),
  noValidationWriterLosesMoreThanOnePoint: worstWriterDelta >= -1,
  explicitPersonalOverridesZero: personalSafeguard.protectedChanges === 0,
  personalExactAccuracyNonRegressing: personalSafeguard.exactAccuracy >= baseline.personalSafeguard.exactAccuracy,
  personalCaseAccuracyNonRegressing: (
    personalSafeguard.caseNormalizedAccuracy >= baseline.personalSafeguard.caseNormalizedAccuracy
  ),
  personalSafeguardHasMultipleWriters: new Set(personalCases.map((entry) => entry.writer)).size >= 4,
}
const accepted = Object.values(gates).every(Boolean)

const result = {
  input,
  candidateParameters: parameters.length,
  split: {
    modelTrainingWriters: payload?.writerIndependent?.trainingWriters ?? [],
    developmentWriters,
    tuningSession: 1,
    sessionDriftSession: 2,
    validationWriters,
    validationSessions: [1, 2],
  },
  baseline,
  selectedCalibration: Number.isFinite(selectedCalibration.switchMargin)
    ? selectedCalibration
    : null,
  development: selectedDevelopmentCandidate,
  validation,
  validationDelta,
  validationStatistics: {
    pairedSignP: round(pairedSignP, 6),
    nonRegressingWriters,
    validationWriters: validationWriters.length,
    worstWriterDelta: round(worstWriterDelta),
    perWriterDeltas,
  },
  personalSafeguard,
  gates,
  accepted,
  note: accepted
    ? 'The candidate passed the disjoint-writer and explicit-personal safeguards.'
    : 'No production calibration should be changed from this result; at least one acceptance gate is unproven.',
}

console.log(JSON.stringify(result, null, 2))
if (process.env.FANOTES_CALIBRATION_STRICT === '1') {
  assert.ok(accepted, `Personal/base calibration was not accepted: ${JSON.stringify(gates)}`)
}
