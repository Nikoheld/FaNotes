import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

/**
 * Offline, writer-disjoint calibration audit for detailed UJI pair traces.
 *
 * The producer is intentionally separate: run audit-uji-pair-selection.mjs
 * once per writer with FANOTES_UJI_PAIR_SELECTION_CASES=1 and retain those
 * JSON files. This analyzer never starts Chromium, loads a recognition model,
 * or reads pen trajectories. It can only re-rank already recorded token
 * alternatives using their recorded visual/base/personal evidence.
 *
 * Usage:
 *   node scripts/analyze-uji-pair-selection-calibration.mjs writer-*.json
 *
 * A directory argument expands to its immediate *.json children. Set
 * FANOTES_UJI_PAIR_CALIBRATION_STRICT=1 to return a failing exit status unless
 * a candidate is both acceptance-eligible and accepted on untouched writers.
 */

const MINIMUM_ACCEPTANCE_WRITERS = 6
const MINIMUM_WRITERS_PER_SPLIT = 3
const MINIMUM_PAIRS_PER_WRITER = 16
const MINIMUM_VALIDATION_CHANGES = 10
const SPLIT_SALT = 'fanotes-uji-pair-selection-calibration-v1'
const variants = ['separated', 'connected']
const subsets = ['all', 'digits', 'lowercase', 'uppercase', 'letters', 'mixed']

const round = (value, digits = 4) => {
  if (!Number.isFinite(value)) return null
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

const rate = (matches, samples) => (
  samples ? round(matches / samples * 100) : null
)

const lower = (value) => String(value ?? '').toLocaleLowerCase('en')
const compactCharacters = (value) => Array.from(String(value ?? ''))
  .filter((character) => !/\s/u.test(character))

const stableHash = (value) => Array.from(`${SPLIT_SALT}\u0000${value}`).reduce(
  (hash, character) => Math.imul(hash ^ (character.codePointAt(0) ?? 0), 16_777_619) >>> 0,
  2_166_136_261,
)

const inputArguments = process.argv.slice(2)
const environmentInputs = (process.env.FANOTES_UJI_PAIR_CALIBRATION_INPUTS ?? '')
  .split(/[\n,]/u)
  .map((entry) => entry.trim())
  .filter(Boolean)
const requestedInputs = inputArguments.length ? inputArguments : environmentInputs

assert.ok(requestedInputs.length, [
  'Usage: node scripts/analyze-uji-pair-selection-calibration.mjs <detailed-writer.json> [...]',
  'Generate each trace with FANOTES_UJI_PAIR_SELECTION_CASES=1.',
].join('\n'))

const expandInput = (requested) => {
  const resolved = path.resolve(requested)
  assert.ok(fs.existsSync(resolved), `Input does not exist: ${resolved}`)
  if (!fs.statSync(resolved).isDirectory()) return [resolved]
  return fs.readdirSync(resolved, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => path.join(resolved, entry.name))
    .sort((first, second) => first.localeCompare(second, 'en'))
}

const inputFiles = [...new Set(requestedInputs.flatMap(expandInput))]
assert.ok(inputFiles.length, 'No JSON input files were found.')

const finiteEvidence = (value) => {
  if (value === null || value === undefined || value === '') return null
  const numeric = Number(value)
  return Number.isFinite(numeric) ? numeric : null
}

const evidenceValue = (source, field) => finiteEvidence(
  source?.[field] ?? source?.evidence?.[field],
)

const candidateFrom = (source, fallback = {}) => ({
  char: String(source?.char ?? fallback.char ?? ''),
  confidence: evidenceValue(source, 'confidence') ?? fallback.confidence ?? null,
  baseConfidence: evidenceValue(source, 'baseConfidence') ?? fallback.baseConfidence ?? null,
  personalConfidence: evidenceValue(source, 'personalConfidence') ?? fallback.personalConfidence ?? null,
  personalSupport: evidenceValue(source, 'personalSupport') ?? fallback.personalSupport ?? null,
})

const preparedToken = (token) => {
  const alternatives = Array.isArray(token?.alternatives) ? token.alternatives : []
  const selectedAlternative = alternatives
    .map((alternative) => candidateFrom(alternative))
    .filter((candidate) => candidate.char === token.char)
    .sort((first, second) => (
      (second.confidence ?? Number.NEGATIVE_INFINITY) -
      (first.confidence ?? Number.NEGATIVE_INFINITY)
    ))[0]
  const selected = candidateFrom(token, selectedAlternative ?? {})
  const byCharacter = new Map()
  ;[selected, ...alternatives.map((alternative) => candidateFrom(alternative))]
    .filter((candidate) => candidate.char)
    .forEach((candidate) => {
      const previous = byCharacter.get(candidate.char)
      if (!previous || (
        (candidate.confidence ?? Number.NEGATIVE_INFINITY) >
        (previous.confidence ?? Number.NEGATIVE_INFINITY)
      )) byCharacter.set(candidate.char, candidate)
    })
  return {
    selected,
    visualChar: String(token?.visualChar ?? token?.visual?.char ?? ''),
    candidates: [...byCharacter.values()],
  }
}

const isolationFields = {
  trainingSession: 1,
  holdoutSession: 2,
  persistentWrites: false,
  sharedRecordObjects: 0,
  sharedTrajectories: 0,
  trainingSessionContamination: 0,
  holdoutSessionContamination: 0,
}

const sources = inputFiles.map((file) => {
  let payload
  try {
    payload = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (error) {
    throw new Error(`Invalid JSON in ${file}: ${error instanceof Error ? error.message : error}`)
  }
  assert.ok(Array.isArray(payload?.cases) && payload.cases.length, [
    `No detailed cases in ${file}.`,
    'Re-run its producer with FANOTES_UJI_PAIR_SELECTION_CASES=1; summary failures are not a calibration dataset.',
  ].join(' '))
  const isolationFailures = Object.entries(isolationFields)
    .filter(([field, expected]) => payload?.isolation?.[field] !== expected)
    .map(([field, expected]) => ({ field, expected, actual: payload?.isolation?.[field] }))
  return {
    file,
    payload,
    isolationFailures,
  }
})

const caseOrigin = new Map()
let duplicateCases = 0
const preparedCases = []

sources.forEach(({ file, payload }) => {
  payload.cases.forEach((entry, index) => {
    assert.ok(typeof entry?.writer === 'string' && entry.writer, `Missing writer in ${file} case ${index}.`)
    assert.ok(variants.includes(entry.variant), `Invalid variant in ${file} case ${index}.`)
    assert.match(String(entry.expected ?? ''), /^[A-Za-z0-9]{2}$/u, `Invalid expected pair in ${file} case ${index}.`)
    assert.ok(typeof entry.recognized === 'string', `Missing recognized text in ${file} case ${index}.`)
    assert.ok(Array.isArray(entry.tokens), `Missing token details in ${file} case ${index}.`)
    assert.equal(
      entry.tokens.length,
      entry.visibleTokenCount,
      `Visible token count mismatch in ${file} case ${index}.`,
    )
    const prepared = {
      writer: entry.writer,
      variant: entry.variant,
      expected: entry.expected,
      recognized: entry.recognized,
      tokens: entry.tokens.map(preparedToken),
    }
    const key = `${entry.writer}\u0000${entry.variant}\u0000${entry.expected}`
    const fingerprint = JSON.stringify(prepared)
    const previous = caseOrigin.get(key)
    if (previous) {
      assert.equal(
        fingerprint,
        previous.fingerprint,
        `Conflicting duplicate ${entry.writer}/${entry.variant}/${entry.expected} in ${previous.file} and ${file}.`,
      )
      duplicateCases += 1
      return
    }
    caseOrigin.set(key, { file, fingerprint })
    preparedCases.push({
      ...prepared,
      source: file,
    })
  })
})

assert.ok(preparedCases.length, 'No unique detailed pair cases remain after input validation.')

const writerNames = [...new Set(preparedCases.map((entry) => entry.writer))]
  .sort((first, second) => stableHash(first) - stableHash(second) || first.localeCompare(second, 'en'))
const developmentWriters = writerNames.filter((_writer, index) => index % 2 === 0)
const validationWriters = writerNames.filter((_writer, index) => index % 2 === 1)
const developmentSet = new Set(developmentWriters)
const validationSet = new Set(validationWriters)
const developmentCases = preparedCases.filter((entry) => developmentSet.has(entry.writer))
const validationCases = preparedCases.filter((entry) => validationSet.has(entry.writer))

assert.equal(
  developmentWriters.some((writer) => validationSet.has(writer)),
  false,
  'Writer split overlap detected.',
)

const subsetMatches = (entry, subset) => {
  if (subset === 'all') return true
  const characters = Array.from(entry.expected)
  const allDigits = characters.every((character) => /^\d$/u.test(character))
  const allLowercase = characters.every((character) => /^[a-z]$/u.test(character))
  const allUppercase = characters.every((character) => /^[A-Z]$/u.test(character))
  const allLetters = characters.every((character) => /^[A-Za-z]$/u.test(character))
  if (subset === 'digits') return allDigits
  if (subset === 'lowercase') return allLowercase
  if (subset === 'uppercase') return allUppercase
  if (subset === 'letters') return allLetters
  return characters.some((character) => /^\d$/u.test(character)) &&
    characters.some((character) => /^[A-Za-z]$/u.test(character))
}

// Evidence channels are pairwise missing-aware. Older traces sometimes omit
// baseConfidence on the selected token; treating that omission as zero would
// create a fake reason to switch to every alternative that records the field.
const evidenceDifference = (candidate, selected, field) => (
  candidate[field] === null || selected[field] === null
    ? 0
    : candidate[field] - selected[field]
)

const candidateAdvantage = (candidate, selected, token, parameters) => (
  evidenceDifference(candidate, selected, 'confidence') +
  parameters.baseWeight * evidenceDifference(candidate, selected, 'baseConfidence') +
  parameters.personalWeight * evidenceDifference(candidate, selected, 'personalConfidence') +
  parameters.supportWeight * Math.max(-4, Math.min(
    4,
    evidenceDifference(candidate, selected, 'personalSupport'),
  )) +
  parameters.visualBonus * (
    Number(Boolean(token.visualChar) && candidate.char === token.visualChar) -
    Number(Boolean(token.visualChar) && selected.char === token.visualChar)
  )
)

const chooseToken = (token, parameters) => {
  if (!parameters) return token.selected.char
  let winner = token.selected
  let winningAdvantage = parameters.switchMargin
  token.candidates.forEach((candidate) => {
    if (candidate.char === token.selected.char) return
    const advantage = candidateAdvantage(candidate, token.selected, token, parameters)
    if (
      advantage > winningAdvantage ||
      (
        winner !== token.selected &&
        advantage === winningAdvantage &&
        candidate.char.localeCompare(winner.char, 'en') < 0
      )
    ) {
      winner = candidate
      winningAdvantage = advantage
    }
  })
  return winner.char
}

const replaceVisibleCharacters = (source, replacements) => {
  const characters = Array.from(source)
  const visibleIndices = characters
    .map((character, index) => ({ character, index }))
    .filter(({ character }) => !/\s/u.test(character))
    .map(({ index }) => index)
  // Re-ranking cannot repair a collapsed/expanded segmentation or reconstruct
  // whitespace that is absent from this trace. Preserve the real Top-1 output.
  if (visibleIndices.length !== replacements.length) return source
  visibleIndices.forEach((sourceIndex, replacementIndex) => {
    characters[sourceIndex] = replacements[replacementIndex]
  })
  return characters.join('')
}

const decide = (entry, parameters) => {
  const replacements = entry.tokens.map((token) => chooseToken(token, parameters))
  const recognized = replaceVisibleCharacters(entry.recognized, replacements)
  return {
    recognized,
    changed: recognized !== entry.recognized,
    exact: recognized === entry.expected,
    caseNormalized: lower(recognized) === lower(entry.expected),
    characterCount: compactCharacters(recognized).length === compactCharacters(entry.expected).length,
  }
}

const summarizeDecisions = (entries, decisions) => {
  let exact = 0
  let caseNormalized = 0
  let characterCount = 0
  let changes = 0
  let wins = 0
  let regressions = 0
  entries.forEach((entry, index) => {
    const decision = decisions[index]
    const baselineCorrect = entry.recognized === entry.expected
    if (decision.exact) exact += 1
    if (decision.caseNormalized) caseNormalized += 1
    if (decision.characterCount) characterCount += 1
    if (decision.changed) changes += 1
    if (decision.exact && !baselineCorrect) wins += 1
    if (!decision.exact && baselineCorrect) regressions += 1
  })
  return {
    samples: entries.length,
    exact: { matches: exact, accuracy: rate(exact, entries.length) },
    caseNormalized: { matches: caseNormalized, accuracy: rate(caseNormalized, entries.length) },
    characterCount: { matches: characterCount, accuracy: rate(characterCount, entries.length) },
    changes,
    wins,
    regressions,
    netWins: wins - regressions,
  }
}

const summarize = (entries, parameters) => summarizeDecisions(
  entries,
  entries.map((entry) => decide(entry, parameters)),
)

const metricDelta = (candidate, baseline) => ({
  exactAccuracy: round((candidate.exact.accuracy ?? 0) - (baseline.exact.accuracy ?? 0)),
  caseNormalizedAccuracy: round(
    (candidate.caseNormalized.accuracy ?? 0) - (baseline.caseNormalized.accuracy ?? 0),
  ),
  characterCountAccuracy: round(
    (candidate.characterCount.accuracy ?? 0) - (baseline.characterCount.accuracy ?? 0),
  ),
})

const summaryCell = (entries, parameters) => {
  const baseline = summarize(entries, null)
  if (!parameters) return { baseline, candidate: null, delta: null }
  const candidate = summarize(entries, parameters)
  return { baseline, candidate, delta: metricDelta(candidate, baseline) }
}

const breakdown = (entries, parameters) => ['all', ...variants].flatMap((variant) => (
  subsets.flatMap((subset) => {
    const selected = entries.filter((entry) => (
      (variant === 'all' || entry.variant === variant) && subsetMatches(entry, subset)
    ))
    return selected.length ? [{ variant, subset, ...summaryCell(selected, parameters) }] : []
  })
))

const writerSummary = (entries, parameters) => [...new Set(entries.map((entry) => entry.writer))]
  .sort((first, second) => first.localeCompare(second, 'en'))
  .map((writer) => ({ writer, ...summaryCell(entries.filter((entry) => entry.writer === writer), parameters) }))

const parameterGrid = {
  baseWeight: [0, 0.08, 0.16, 0.24],
  personalWeight: [0, 0.08, 0.16],
  supportWeight: [0, 0.5],
  visualBonus: [0, 2, 4],
  switchMargin: [0, 1.5, 3],
}

const parameters = parameterGrid.baseWeight.flatMap((baseWeight) => (
  parameterGrid.personalWeight.flatMap((personalWeight) => (
    parameterGrid.supportWeight.flatMap((supportWeight) => (
      parameterGrid.visualBonus.flatMap((visualBonus) => (
        parameterGrid.switchMargin.map((switchMargin) => ({
          baseWeight,
          personalWeight,
          supportWeight,
          visualBonus,
          switchMargin,
        }))
      ))
    ))
  ))
))

const nonRegressingDevelopmentCells = (parameters) => breakdown(developmentCases, parameters)
  .filter((cell) => cell.subset === 'all' || cell.baseline.samples >= 12)
  .every((cell) => (
    (cell.delta?.caseNormalizedAccuracy ?? Number.NEGATIVE_INFINITY) >= 0 &&
    (cell.delta?.characterCountAccuracy ?? Number.NEGATIVE_INFINITY) >= 0 &&
    (cell.variant === 'all' || (cell.delta?.exactAccuracy ?? Number.NEGATIVE_INFINITY) >= 0)
  ))

const developmentBaseline = summarize(developmentCases, null)
const rankedCandidates = developmentCases.length ? parameters.map((candidateParameters) => {
  const summary = summarize(developmentCases, candidateParameters)
  const perWriter = writerSummary(developmentCases, candidateParameters)
  const macroWriterExact = perWriter.reduce((sum, writer) => (
    sum + (writer.candidate?.exact.accuracy ?? 0)
  ), 0) / Math.max(1, perWriter.length)
  return {
    parameters: candidateParameters,
    summary,
    delta: metricDelta(summary, developmentBaseline),
    macroWriterExact: round(macroWriterExact),
    safeCells: nonRegressingDevelopmentCells(candidateParameters),
  }
}).filter((candidate) => (
  candidate.delta.exactAccuracy > 0 &&
  candidate.delta.caseNormalizedAccuracy >= 0 &&
  candidate.delta.characterCountAccuracy >= 0 &&
  candidate.safeCells
)).sort((first, second) => (
  second.summary.exact.accuracy - first.summary.exact.accuracy ||
  second.macroWriterExact - first.macroWriterExact ||
  second.summary.caseNormalized.accuracy - first.summary.caseNormalized.accuracy ||
  second.summary.netWins - first.summary.netWins ||
  first.summary.regressions - second.summary.regressions ||
  (
    first.parameters.baseWeight + first.parameters.personalWeight +
    first.parameters.supportWeight + first.parameters.visualBonus
  ) - (
    second.parameters.baseWeight + second.parameters.personalWeight +
    second.parameters.supportWeight + second.parameters.visualBonus
  ) ||
  second.parameters.switchMargin - first.parameters.switchMargin
)) : []

const selectedDevelopment = writerNames.length >= 2 ? rankedCandidates[0] ?? null : null
const selectedParameters = selectedDevelopment?.parameters ?? null
const development = {
  baseline: developmentBaseline,
  selected: selectedDevelopment,
  breakdown: breakdown(developmentCases, selectedParameters),
  writers: writerSummary(developmentCases, selectedParameters),
}
const validation = validationCases.length ? {
  ...summaryCell(validationCases, selectedParameters),
  breakdown: breakdown(validationCases, selectedParameters),
  writers: writerSummary(validationCases, selectedParameters),
} : null

const casesByWriter = new Map(writerNames.map((writer) => [
  writer,
  preparedCases.filter((entry) => entry.writer === writer),
]))
const caseMatrix = writerNames.map((writer) => ({
  writer,
  keys: [...new Set((casesByWriter.get(writer) ?? []).map((entry) => `${entry.variant}:${entry.expected}`))].sort(),
}))
const referenceMatrix = JSON.stringify(caseMatrix[0]?.keys ?? [])
const comparableCaseMatrix = caseMatrix.every((entry) => JSON.stringify(entry.keys) === referenceMatrix)
const balancedVariants = writerNames.every((writer) => {
  const entries = casesByWriter.get(writer) ?? []
  return variants.every((variant) => entries.filter((entry) => entry.variant === variant).length === entries.length / 2)
})
const minimumPairsPresent = writerNames.every((writer) => (
  new Set((casesByWriter.get(writer) ?? []).map((entry) => entry.expected)).size >= MINIMUM_PAIRS_PER_WRITER
))
const allSourcesIsolated = sources.every((source) => source.isolationFailures.length === 0)
const datasetWritersMatchCases = sources.every((source) => {
  const datasetWriter = source.payload?.dataset?.writer
  const caseWriters = new Set(source.payload.cases.map((entry) => entry.writer))
  return typeof datasetWriter === 'string' && caseWriters.size === 1 && caseWriters.has(datasetWriter)
})

const eligibilityGates = {
  atLeastSixWriters: writerNames.length >= MINIMUM_ACCEPTANCE_WRITERS,
  atLeastThreeDevelopmentWriters: developmentWriters.length >= MINIMUM_WRITERS_PER_SPLIT,
  atLeastThreeValidationWriters: validationWriters.length >= MINIMUM_WRITERS_PER_SPLIT,
  allSourcesProveSessionIsolation: allSourcesIsolated,
  everySourceWriterMatchesItsCases: datasetWritersMatchCases,
  identicalPairMatrixAcrossWriters: comparableCaseMatrix,
  separatedAndConnectedBalancedPerWriter: balancedVariants,
  atLeastSixteenPairsPerWriter: minimumPairsPresent,
}
const acceptanceEligible = Object.values(eligibilityGates).every(Boolean)

const binomialTail = (wins, regressions) => {
  const trials = wins + regressions
  if (!trials) return 1
  if (wins <= trials / 2) return 1
  // Start at P(X = wins), then accumulate the contiguous upper tail.  The
  // previous formulation initialized P(X = regressions) and jumped straight
  // to X = wins + 1, which understated/overstated the tail depending on the
  // asymmetry and could make an unsafe calibration appear significant.
  const shorterSide = Math.min(wins, trials - wins)
  let logCombination = 0
  for (let index = 1; index <= shorterSide; index += 1) {
    logCombination += Math.log(trials - shorterSide + index) - Math.log(index)
  }
  let term = Math.exp(logCombination - trials * Math.log(2))
  let probability = term
  for (let successes = wins + 1; successes <= trials; successes += 1) {
    term *= (trials - successes + 1) / successes
    probability += term
  }
  return Math.min(1, probability)
}

const validationCells = validation?.breakdown ?? []
const validationVariantCells = validationCells.filter((cell) => (
  cell.subset === 'all' && cell.variant !== 'all'
))
const populatedValidationSubsetCells = validationCells.filter((cell) => (
  cell.variant === 'all' && cell.subset !== 'all' &&
  cell.baseline.samples >= Math.max(20, validationWriters.length * 4)
))
const writerNetWins = validation?.writers.map((entry) => ({
  writer: entry.writer,
  netWins: entry.candidate?.netWins ?? 0,
  exactDelta: entry.delta?.exactAccuracy ?? 0,
})) ?? []
const changedValidationPredictions = (validation?.candidate?.wins ?? 0) +
  (validation?.candidate?.regressions ?? 0)
const pairedSignP = validation?.candidate
  ? binomialTail(validation.candidate.wins, validation.candidate.regressions)
  : 1

const outcomeGates = {
  developmentCandidateExists: Boolean(selectedDevelopment),
  validationHasAtLeastTenChangedCorrectnessOutcomes: (
    changedValidationPredictions >= MINIMUM_VALIDATION_CHANGES
  ),
  validationExactGainAtLeast025pp: (validation?.delta?.exactAccuracy ?? Number.NEGATIVE_INFINITY) >= 0.25,
  validationCaseAccuracyNonRegressing: (
    validation?.delta?.caseNormalizedAccuracy ?? Number.NEGATIVE_INFINITY
  ) >= 0,
  validationCharacterCountNonRegressing: (
    validation?.delta?.characterCountAccuracy ?? Number.NEGATIVE_INFINITY
  ) >= 0,
  separatedAndConnectedExactNonRegressing: validationVariantCells.length === variants.length &&
    validationVariantCells.every((cell) => (cell.delta?.exactAccuracy ?? Number.NEGATIVE_INFINITY) >= 0),
  populatedSubsetsExactNonRegressing: populatedValidationSubsetCells.every((cell) => (
    (cell.delta?.exactAccuracy ?? Number.NEGATIVE_INFINITY) >= 0
  )),
  validationWinsExceedRegressions: (
    (validation?.candidate?.wins ?? 0) > (validation?.candidate?.regressions ?? 0)
  ),
  pairedOneSidedSignTestAtMost010: pairedSignP <= 0.1,
  atLeastHalfValidationWritersNonRegressing: writerNetWins.filter((entry) => entry.netWins >= 0).length >=
    Math.ceil(validationWriters.length / 2),
  noValidationWriterLosesMoreThanOnePair: writerNetWins.every((entry) => entry.netWins >= -1),
}

const accepted = acceptanceEligible
  ? Object.values(outcomeGates).every(Boolean)
  : null
const mode = writerNames.length < 2
  ? 'descriptive-only'
  : acceptanceEligible ? 'acceptance' : 'exploratory-writer-disjoint'

const result = {
  analyzer: 'uji-pair-selection-offline-calibration-v1',
  mode,
  inputs: {
    files: inputFiles,
    sources: sources.map((source) => ({
      file: source.file,
      detailedCases: source.payload.cases.length,
      datasetWriter: source.payload?.dataset?.writer ?? null,
      isolationFailures: source.isolationFailures,
    })),
    uniqueCases: preparedCases.length,
    duplicateCasesIgnored: duplicateCases,
  },
  isolation: {
    splitUnit: 'writer',
    splitAlgorithm: 'stable salted FNV-1a ordering, alternating development/validation',
    splitSalt: SPLIT_SALT,
    modelTrainingSession: 1,
    pairHoldoutSession: 2,
    validationUsedDuringSweep: false,
    expectedLabelsUsedByDecisionRule: false,
    persistedEvidenceOnly: [
      'token.char',
      'token.visualChar',
      'token.alternatives',
      'confidence',
      'baseConfidence',
      'personalConfidence',
      'personalSupport',
    ],
  },
  split: {
    writers: writerNames.length,
    developmentWriters,
    validationWriters,
    developmentCases: developmentCases.length,
    validationCases: validationCases.length,
  },
  sweep: {
    grid: parameterGrid,
    candidates: parameters.length,
    eligibleDevelopmentCandidates: rankedCandidates.length,
    selectedParameters,
  },
  development,
  validation: validation ? {
    ...validation,
    statistics: {
      changedCorrectnessOutcomes: changedValidationPredictions,
      pairedOneSidedSignP: round(pairedSignP, 6),
      writerNetWins,
    },
  } : null,
  acceptance: {
    eligible: acceptanceEligible,
    evaluated: acceptanceEligible,
    accepted,
    eligibilityGates,
    outcomeGates: acceptanceEligible ? outcomeGates : null,
  },
  note: writerNames.length < 2
    ? 'Only one writer is present. No parameter was selected and no acceptance result exists.'
    : !acceptanceEligible
      ? `Exploratory only: acceptance requires at least ${MINIMUM_ACCEPTANCE_WRITERS} writers (${MINIMUM_WRITERS_PER_SPLIT} per split), comparable pair matrices, and complete session-isolation evidence.`
      : accepted
        ? 'The development-selected candidate passed every gate on untouched validation writers.'
        : 'Do not change production calibration: at least one untouched-writer acceptance gate failed.',
}

console.log(JSON.stringify(result, null, 2))

if (process.env.FANOTES_UJI_PAIR_CALIBRATION_STRICT === '1') {
  assert.equal(
    accepted,
    true,
    `Pair calibration was not accepted (${mode}): ${JSON.stringify({ eligibilityGates, outcomeGates })}`,
  )
}
