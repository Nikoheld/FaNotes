import { BASE_CATALOG } from '../../../src/data/catalog'
import {
  buildRecognitionModel,
  recognizeExpression,
  recognizedSentence,
  type RecognitionAlternative,
  type RecognitionToken,
} from '../../../src/lib/recognition'
import { createStandardRecognitionSamples } from '../../../src/lib/standardRecognition'
import type { Stroke } from '../../../src/types'
import {
  normalizedUjiStrokes,
  ujiPersonalSample,
  type UjiRecord,
} from './uji-personal-recognition-harness'

type PairVariant = 'separated' | 'connected'
type PairSubset = 'all' | 'digits' | 'lowercase' | 'uppercase' | 'letters' | 'mixed'

export type UjiPairSelectionOptions = {
  writer?: string
  pairLimit?: number
  pairSubset?: PairSubset
  topN?: number
  segmentationCandidates?: number
  includeCases?: boolean
}

type RankedChoice = {
  char: string
  labelId: string
  score: number
}

type RankedSequence = {
  text: string
  score: number
}

type PairSelectionCase = {
  writer: string
  variant: PairVariant
  expected: string
  recognized: string
  visibleTokenCount: number
  outputCharacterCount: number
  exactTop1: boolean
  caseNormalizedTop1: boolean
  exactCharacterCount: boolean
  collapsed: boolean
  expanded: boolean
  topNOracle: boolean
  topNCaseNormalizedOracle: boolean
  boundedSearchOracle: boolean
  boundedSearchCaseNormalizedOracle: boolean
  topNCandidates: string[]
  boundedSearchCandidates: string[]
  ink: {
    physicalWidth: number
    physicalHeight: number
    physicalAspect: number
    strokeCount: number
    pointCount: number
  }
  boundedPaths: Array<{
    segmentationIndex: number
    recognized: string
    visibleTokenCount: number
    averageConfidence: number
    visualText: string
  }>
  tokens: Array<{
    char: string
    visualChar: string
    confidence: number
    personalConfidence: number
    personalSupport: number
    alternatives: Array<{
      char: string
      confidence: number
      baseConfidence: number
      personalConfidence: number
      personalSupport: number
    }>
  }>
}

const SOURCE_WIDTH = 900
const SOURCE_HEIGHT = 560
const GLYPH_HEIGHT = 0.16
const TOP = 0.22
const labelCharacters = new Set(BASE_CATALOG.map((label) => label.char))

const asciiCompare = (first: string, second: string) => (
  (first.codePointAt(0) ?? 0) - (second.codePointAt(0) ?? 0)
)

const rate = (matches: number, samples: number) => (
  Math.round(matches / Math.max(1, samples) * 10_000) / 100
)

const pointsOf = (strokes: Stroke[]) => strokes.flatMap((stroke) => stroke.points)

const positionGlyph = (
  record: UjiRecord,
  left: number,
  timeStart: number,
) => {
  const source = normalizedUjiStrokes(record)
  const points = pointsOf(source)
  const minX = Math.min(...points.map((point) => point.x))
  const maxX = Math.max(...points.map((point) => point.x))
  const minY = Math.min(...points.map((point) => point.y))
  const maxY = Math.max(...points.map((point) => point.y))
  const scale = GLYPH_HEIGHT / Math.max(0.001, maxY - minY)
  let time = timeStart
  const strokes = source.map((stroke) => ({
    ...stroke,
    points: stroke.points.map((point) => ({
      ...point,
      x: left + (point.x - minX) * scale,
      y: TOP + (point.y - minY) * scale,
      t: time++,
    })),
  }))
  return {
    strokes,
    width: Math.max(0.004, (maxX - minX) * scale),
    nextTime: time + 8,
  }
}

const strokePathLength = (stroke: Stroke) => stroke.points.slice(1).reduce((sum, point, index) => {
  const previous = stroke.points[index]
  return sum + Math.hypot(
    (point.x - previous.x) * SOURCE_WIDTH,
    (point.y - previous.y) * SOURCE_HEIGHT,
  )
}, 0)

const primaryStrokeIndex = (strokes: Stroke[]) => strokes
  .map((stroke, index) => ({ index, length: strokePathLength(stroke) }))
  .sort((first, second) => second.length - first.length)[0]?.index ?? 0

const orientStroke = (stroke: Stroke, endpoint: 'left' | 'right') => {
  const points = stroke.points.map((point) => ({ ...point }))
  if (points.length < 2) return points
  const first = points[0]
  const last = points.at(-1)!
  const shouldReverse = endpoint === 'right' ? last.x < first.x : first.x > last.x
  return shouldReverse ? points.reverse() : points
}

/**
 * Places two genuine session-2 glyphs next to one another without modifying
 * either pen trajectory. A small positive gap keeps their body strokes
 * genuinely separate while still looking like an ordinary letter pair.
 */
const separatedPairStrokes = (first: UjiRecord, second: UjiRecord) => {
  const left = positionGlyph(first, 0.18, 0)
  const right = positionGlyph(second, 0.18 + left.width + 3 / SOURCE_WIDTH, left.nextTime)
  return [...left.strokes, ...right.strokes]
}

/**
 * Joins only the dominant body strokes. Dots, crossbars and other accessory
 * strokes stay complete and are written after the shared body. This mirrors
 * connected handwriting without using the holdout labels during recognition.
 */
const connectedPairStrokes = (first: UjiRecord, second: UjiRecord) => {
  const left = positionGlyph(first, 0.18, 0)
  const right = positionGlyph(second, 0.18 + left.width - 3 / SOURCE_WIDTH, left.nextTime)
  const leftPrimary = primaryStrokeIndex(left.strokes)
  const rightPrimary = primaryStrokeIndex(right.strokes)
  const leftBody = orientStroke(left.strokes[leftPrimary], 'right')
  const rightBody = orientStroke(right.strokes[rightPrimary], 'left')
  const connector = {
    ...leftBody.at(-1)!,
    x: (leftBody.at(-1)!.x + rightBody[0].x) / 2,
    y: (leftBody.at(-1)!.y + rightBody[0].y) / 2,
  }
  let time = 0
  const body: Stroke = {
    baseWidth: 3.7,
    pressureEnabled: false,
    points: [...leftBody, connector, ...rightBody].map((point) => ({ ...point, t: time++ })),
  }
  const accessories = [
    ...left.strokes.filter((_stroke, index) => index !== leftPrimary),
    ...right.strokes.filter((_stroke, index) => index !== rightPrimary),
  ].map((stroke) => {
    time += 7
    return {
      ...stroke,
      points: stroke.points.map((point) => ({ ...point, t: time++ })),
    }
  })
  return [body, ...accessories]
}

const confidenceScore = (
  candidate: Pick<RecognitionAlternative, 'confidence' | 'personalConfidence' | 'personalSupport'>,
) => (
  candidate.confidence +
  (candidate.personalConfidence ?? 0) * 0.18 +
  Math.min(12, (candidate.personalSupport ?? 0) * 1.5)
)

const choicesForToken = (token: RecognitionToken, limit: number): RankedChoice[] => {
  const choices = [{
    char: token.char,
    labelId: token.labelId,
    score: confidenceScore(token),
  }, ...token.alternatives.map((alternative) => ({
    char: alternative.char,
    labelId: alternative.labelId,
    score: confidenceScore(alternative),
  }))]
  const unique = new Map<string, RankedChoice>()
  choices.forEach((choice) => {
    const current = unique.get(choice.char)
    if (!current || choice.score > current.score) unique.set(choice.char, choice)
  })
  return [...unique.values()]
    .sort((first, second) => second.score - first.score || first.char.localeCompare(second.char, 'en'))
    .slice(0, Math.max(1, limit))
}

/** N-best label sequences for the segmentation selected by production. */
const rankedTokenSequences = (tokens: RecognitionToken[], limit: number): RankedSequence[] => {
  const visible = tokens.filter((token) => !token.isLayout)
  if (!visible.length) return []
  const beamLimit = Math.max(16, limit * 4)
  let beams: Array<{ choices: RankedChoice[]; score: number }> = [{ choices: [], score: 0 }]
  visible.forEach((token) => {
    const choices = choicesForToken(token, limit)
    beams = beams.flatMap((beam) => choices.map((choice) => ({
      choices: [...beam.choices, choice],
      score: beam.score + choice.score,
    })))
      .sort((first, second) => second.score - first.score)
      .slice(0, beamLimit)
  })
  const ranked = beams.map((beam) => ({
    text: recognizedSentence(visible.map((token, index) => ({
      ...token,
      char: beam.choices[index]?.char ?? token.char,
      labelId: beam.choices[index]?.labelId ?? token.labelId,
    }))),
    score: beam.score,
  }))
  const actual = recognizedSentence(visible)
  const unique = new Map<string, RankedSequence>()
  unique.set(actual, { text: actual, score: Number.POSITIVE_INFINITY })
  ranked.forEach((candidate) => {
    const current = unique.get(candidate.text)
    if (!current || candidate.score > current.score) unique.set(candidate.text, candidate)
  })
  return [...unique.values()]
    .sort((first, second) => second.score - first.score || first.text.localeCompare(second.text, 'en'))
    .slice(0, limit)
}

const roundRobinCandidates = (paths: RankedSequence[][], limit: number) => {
  const result: string[] = []
  const seen = new Set<string>()
  const maximumDepth = Math.max(0, ...paths.map((path) => path.length))
  for (let depth = 0; depth < maximumDepth && result.length < limit; depth += 1) {
    for (const path of paths) {
      const text = path[depth]?.text
      if (text === undefined || seen.has(text)) continue
      seen.add(text)
      result.push(text)
      if (result.length >= limit) break
    }
  }
  return result
}

const normalized = (value: string) => value.toLocaleLowerCase('en')

const inkMetrics = (strokes: Stroke[]) => {
  const points = pointsOf(strokes)
  const minX = Math.min(...points.map((point) => point.x))
  const maxX = Math.max(...points.map((point) => point.x))
  const minY = Math.min(...points.map((point) => point.y))
  const maxY = Math.max(...points.map((point) => point.y))
  const physicalWidth = Math.max(0, (maxX - minX) * SOURCE_WIDTH)
  const physicalHeight = Math.max(1, (maxY - minY) * SOURCE_HEIGHT)
  return {
    physicalWidth: Math.round(physicalWidth * 100) / 100,
    physicalHeight: Math.round(physicalHeight * 100) / 100,
    physicalAspect: Math.round(physicalWidth / physicalHeight * 10_000) / 10_000,
    strokeCount: strokes.length,
    pointCount: points.length,
  }
}

const createPairSpecs = (characters: string[], limit: number, subset: PairSubset) => {
  const pairs = characters.flatMap((first) => characters.flatMap((second) => (
    first === second ? [] : [{ first, second, expected: `${first}${second}` }]
  ))).filter(({ first, second }) => {
    const firstDigit = /^\d$/u.test(first)
    const secondDigit = /^\d$/u.test(second)
    const firstLower = /^[a-z]$/u.test(first)
    const secondLower = /^[a-z]$/u.test(second)
    const firstUpper = /^[A-Z]$/u.test(first)
    const secondUpper = /^[A-Z]$/u.test(second)
    if (subset === 'digits') return firstDigit && secondDigit
    if (subset === 'lowercase') return firstLower && secondLower
    if (subset === 'uppercase') return firstUpper && secondUpper
    if (subset === 'letters') return (firstLower || firstUpper) && (secondLower || secondUpper)
    if (subset === 'mixed') return firstDigit !== secondDigit
    return true
  })
  const stableHash = (value: string) => [...value].reduce(
    (hash, character) => Math.imul(hash ^ (character.codePointAt(0) ?? 0), 16_777_619) >>> 0,
    2_166_136_261,
  )
  return pairs
    .sort((first, second) => (
      stableHash(first.expected) - stableHash(second.expected) ||
      first.expected.localeCompare(second.expected, 'en')
    ))
    .slice(0, limit)
}

const summarize = (cases: PairSelectionCase[]) => {
  const top1 = cases.filter((entry) => entry.exactTop1).length
  const normalizedTop1 = cases.filter((entry) => entry.caseNormalizedTop1).length
  const exactCount = cases.filter((entry) => entry.exactCharacterCount).length
  const collapsed = cases.filter((entry) => entry.collapsed).length
  const expanded = cases.filter((entry) => entry.expanded).length
  const oracle = cases.filter((entry) => entry.topNOracle).length
  const normalizedOracle = cases.filter((entry) => entry.topNCaseNormalizedOracle).length
  const boundedOracle = cases.filter((entry) => entry.boundedSearchOracle).length
  const boundedNormalizedOracle = cases.filter((entry) => entry.boundedSearchCaseNormalizedOracle).length
  const confusions = new Map<string, number>()
  cases.filter((entry) => !entry.exactTop1).forEach((entry) => {
    const key = `${entry.expected}→${entry.recognized || '∅'}`
    confusions.set(key, (confusions.get(key) ?? 0) + 1)
  })
  return {
    samples: cases.length,
    top1: {
      exact: top1,
      accuracy: rate(top1, cases.length),
      caseNormalizedExact: normalizedTop1,
      caseNormalizedAccuracy: rate(normalizedTop1, cases.length),
    },
    characterCount: {
      exact: exactCount,
      accuracy: rate(exactCount, cases.length),
      collapsed,
      collapseRate: rate(collapsed, cases.length),
      expanded,
      expansionRate: rate(expanded, cases.length),
    },
    topNOracle: {
      exact: oracle,
      accuracy: rate(oracle, cases.length),
      caseNormalizedExact: normalizedOracle,
      caseNormalizedAccuracy: rate(normalizedOracle, cases.length),
    },
    boundedSegmentationSearchOracle: {
      exact: boundedOracle,
      accuracy: rate(boundedOracle, cases.length),
      caseNormalizedExact: boundedNormalizedOracle,
      caseNormalizedAccuracy: rate(boundedNormalizedOracle, cases.length),
    },
    topConfusions: [...confusions.entries()]
      .sort((first, second) => second[1] - first[1] || first[0].localeCompare(second[0], 'en'))
      .slice(0, 30),
    failures: cases.filter((entry) => !entry.exactTop1).slice(0, 40),
  }
}

const supportedRecord = (record: UjiRecord) => (
  /^[A-Za-z0-9]$/u.test(record.char) && labelCharacters.has(record.char)
)

const trajectoryFingerprint = (record: UjiRecord) => record.strokes
  .map((stroke) => stroke.map(([x, y]) => `${x},${y}`).join(';'))
  .join('|')

export const runUjiPairSelectionAudit = async (
  records: UjiRecord[],
  options: UjiPairSelectionOptions = {},
) => {
  const usable = records.filter(supportedRecord)
  const writers = [...new Set(usable.map((record) => record.writer))].sort()
  const writer = options.writer && writers.includes(options.writer)
    ? options.writer
    : writers.find((candidate) => candidate === 'trn_UJI_W01') ?? writers[0]
  if (!writer) throw new Error('Der UJI-Datensatz enthält keinen unterstützten Schreibenden.')

  const pairLimit = Math.max(1, Math.min(512, Math.round(options.pairLimit ?? 32)))
  const pairSubset = options.pairSubset ?? 'all'
  const topN = Math.max(1, Math.min(16, Math.round(options.topN ?? 8)))
  const segmentationCandidates = Math.max(
    1,
    Math.min(6, Math.round(options.segmentationCandidates ?? 3)),
  )
  const trainingRecords = usable.filter((record) => record.writer === writer && record.session === 1)
  const holdoutRecords = usable.filter((record) => record.writer === writer && record.session === 2)
  const trainingTrajectories = new Set(trainingRecords.map(trajectoryFingerprint))
  const trainingCharacters = new Set(trainingRecords.map((record) => record.char))
  const characters = [...new Set(holdoutRecords
    .map((record) => record.char)
    .filter((character) => trainingCharacters.has(character)))]
    .sort(asciiCompare)
  if (characters.length < 2) throw new Error(`Zu wenige sitzungsgetrennte Zeichen für ${writer}.`)

  const trainingSamples = trainingRecords.map(ujiPersonalSample)
  const standardSamples = await createStandardRecognitionSamples(BASE_CATALOG)
  const buildStartedAt = performance.now()
  const model = await buildRecognitionModel([...trainingSamples, ...standardSamples])
  const buildMs = Math.round(performance.now() - buildStartedAt)
  const holdoutByCharacter = new Map(holdoutRecords.map((record) => [record.char, record]))
  const pairSpecs = createPairSpecs(characters, pairLimit, pairSubset)
  const cases: PairSelectionCase[] = []

  for (const pair of pairSpecs) {
    const first = holdoutByCharacter.get(pair.first)
    const second = holdoutByCharacter.get(pair.second)
    if (!first || !second) continue
    const variants: Array<{ variant: PairVariant; strokes: Stroke[] }> = [
      { variant: 'separated', strokes: separatedPairStrokes(first, second) },
      { variant: 'connected', strokes: connectedPairStrokes(first, second) },
    ]
    for (const { variant, strokes } of variants) {
      // This is the actual end selection: no character-count or text hint.
      const tokens = recognizeExpression(strokes, model, BASE_CATALOG, 'text', [], 'en')
      const visible = tokens.filter((token) => !token.isLayout)
      const recognized = recognizedSentence(tokens)
      const topNCandidates = rankedTokenSequences(tokens, topN).map((candidate) => candidate.text)

      // Diagnostic upper bound only. The true count is supplied exclusively
      // after the unhinted Top-1 decision above and never enters training.
      const exactCountPaths: RankedSequence[][] = []
      const boundedPaths: PairSelectionCase['boundedPaths'] = []
      let previousFingerprint = ''
      for (let segmentationIndex = 0; segmentationIndex < segmentationCandidates; segmentationIndex += 1) {
        const pathTokens = recognizeExpression(
          strokes,
          model,
          BASE_CATALOG,
          'text',
          [],
          'en',
          2,
          undefined,
          segmentationIndex,
        )
        const path = rankedTokenSequences(pathTokens, topN)
        const fingerprint = path.map((candidate) => candidate.text).join('\u0000')
        if (fingerprint === previousFingerprint) break
        previousFingerprint = fingerprint
        const pathVisible = pathTokens.filter((token) => !token.isLayout)
        boundedPaths.push({
          segmentationIndex,
          recognized: recognizedSentence(pathTokens),
          visibleTokenCount: pathVisible.length,
          averageConfidence: Math.round(pathVisible.reduce((sum, token) => (
            sum + token.confidence
          ), 0) / Math.max(1, pathVisible.length) * 100) / 100,
          visualText: pathVisible.map((token) => BASE_CATALOG.find((label) => (
            label.id === (token.visualLabelId ?? token.labelId)
          ))?.char ?? token.char).join(''),
        })
        if (path.length) exactCountPaths.push(path)
      }
      const boundedSearchCandidates = roundRobinCandidates(
        [rankedTokenSequences(tokens, topN), ...exactCountPaths],
        topN,
      )
      const outputCharacterCount = Array.from(recognized).filter((character) => !/\s/u.test(character)).length
      cases.push({
        writer,
        variant,
        expected: pair.expected,
        recognized,
        visibleTokenCount: visible.length,
        outputCharacterCount,
        exactTop1: recognized === pair.expected,
        caseNormalizedTop1: normalized(recognized) === normalized(pair.expected),
        exactCharacterCount: visible.length === 2 && outputCharacterCount === 2,
        collapsed: visible.length < 2 || outputCharacterCount < 2,
        expanded: visible.length > 2 || outputCharacterCount > 2,
        topNOracle: topNCandidates.includes(pair.expected),
        topNCaseNormalizedOracle: topNCandidates.some((candidate) => (
          normalized(candidate) === normalized(pair.expected)
        )),
        boundedSearchOracle: boundedSearchCandidates.includes(pair.expected),
        boundedSearchCaseNormalizedOracle: boundedSearchCandidates.some((candidate) => (
          normalized(candidate) === normalized(pair.expected)
        )),
        topNCandidates,
        boundedSearchCandidates,
        ink: inkMetrics(strokes),
        boundedPaths,
        tokens: visible.map((token) => ({
          char: token.char,
          visualChar: BASE_CATALOG.find((label) => (
            label.id === (token.visualLabelId ?? token.labelId)
          ))?.char ?? token.char,
          confidence: token.confidence,
          personalConfidence: token.personalConfidence ?? 0,
          personalSupport: token.personalSupport ?? 0,
          alternatives: token.alternatives.slice(0, topN).map((alternative) => ({
            char: alternative.char,
            confidence: alternative.confidence,
            baseConfidence: alternative.baseConfidence ?? 0,
            personalConfidence: alternative.personalConfidence ?? 0,
            personalSupport: alternative.personalSupport ?? 0,
          })),
        })),
      })
    }
  }

  const separated = cases.filter((entry) => entry.variant === 'separated')
  const connected = cases.filter((entry) => entry.variant === 'connected')
  return {
    dataset: {
      writers: writers.length,
      writer,
      supportedCharacters: characters.length,
    },
    isolation: {
      trainingSession: 1,
      holdoutSession: 2,
      trainingSamples: trainingSamples.length,
      holdoutGlyphs: holdoutRecords.length,
      persistentWrites: false,
      sharedRecordObjects: trainingRecords.filter((record) => holdoutRecords.includes(record)).length,
      sharedTrajectories: holdoutRecords.filter((record) => (
        trainingTrajectories.has(trajectoryFingerprint(record))
      )).length,
      trainingSessionContamination: trainingRecords.filter((record) => record.session !== 1).length,
      holdoutSessionContamination: holdoutRecords.filter((record) => record.session !== 2).length,
    },
    configuration: {
      requestedPairs: pairLimit,
      evaluatedPairs: pairSpecs.length,
      pairSubset,
      variantsPerPair: 2,
      topN,
      segmentationCandidates,
    },
    model: {
      buildMs,
      retainedPersonalSamples: model.filter((entry) => !entry.standard).length,
      estimatedAccuracy: model.estimatedAccuracy,
      evaluatedSamples: model.evaluatedSamples,
      weights: model.weights,
    },
    overall: summarize(cases),
    separated: summarize(separated),
    connected: summarize(connected),
    cases: options.includeCases ? cases : undefined,
  }
}
