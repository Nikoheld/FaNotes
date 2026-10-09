/**
 * Letter-span holdout. Isolated glyphs use a matching GlyphenWerk sample.
 * The replaced stage is the index slice of a line string (ß expanded to ss).
 * IAM-online is the checked-in line. UJI-format pairs are the small synthetic
 * connected set in uji-letter-pairs.json; the full UJI archive is not bundled.
 */
import { BASE_CATALOG } from '../../../src/data/catalog'
import {
  decideLetterSpans,
  reconcileLetterReading,
  segmentHandwritingLetters,
} from '../../../src/lib/letterSegmentation'
import { normalizeGermanSharpS, preservedReadingCharacters } from '../../../src/lib/orthography'
import {
  buildRecognitionModel,
  recognizeExpression,
  recognizedSentence,
  type RecognitionToken,
} from '../../../src/lib/recognition'
import { createStandardRecognitionSamples } from '../../../src/lib/standardRecognition'
import type { LabelDefinition, Sample, Stroke, StrokePoint } from '../../../src/types'
import iamLine from './iam-online-a01-001z-01.json'
import ujiPairs from './uji-letter-pairs.json'

const SOURCE_WIDTH = 900
const SOURCE_HEIGHT = 560
const COVERED_IDS = new Set([
  'decimal_point',
  'decimal_comma',
  'punctuation_colon',
  'punctuation_semicolon',
  'punctuation_question',
  'punctuation_apostrophe',
  'punctuation_quote',
  'operator_factorial',
  'operator_minus',
  'bracket_left_round',
  'bracket_right_round',
  'bracket_left_square',
  'bracket_right_square',
])

const point = (x: number, y: number, t: number): StrokePoint => ({
  x, y, t, pressure: 0.6, tiltX: 0, tiltY: 0, pointerType: 'pen',
})

const glyphStrokes = (char: string, left = 0.28, top = 0.3): Stroke[] => {
  const code = Array.from(char)[0]?.codePointAt(0) ?? 63
  const width = 0.046
  const height = code >= 65 && code <= 90 ? 0.2 : 0.145
  const body: StrokePoint[] = []
  let time = 0
  for (let row = 0; row < 4; row += 1) {
    for (let column = 0; column < 4; column += 1) {
      if (((code >> ((row * 4 + column) % 15)) & 1) === 0) continue
      body.push(point(
        left + (column + 0.45) / 4 * width,
        top + (row + 0.4) / 4 * height,
        time,
      ))
      time += 1
    }
  }
  if (body.length < 2) {
    body.push(point(left + width * 0.2, top + height * 0.2, time))
    time += 1
    body.push(point(left + width * 0.75, top + height * (0.35 + (code % 5) * 0.1), time))
    time += 1
  }
  body.push(point(left + width * (0.25 + (code % 4) * 0.12), top + height * 0.82, time))
  return [{ baseWidth: 3.4, pressureEnabled: false, points: body }]
}

const render = (strokes: Stroke[]) => {
  const points = strokes.flatMap((stroke) => stroke.points)
  const minX = Math.min(...points.map((entry) => entry.x * SOURCE_WIDTH)) - 8
  const maxX = Math.max(...points.map((entry) => entry.x * SOURCE_WIDTH)) + 8
  const minY = Math.min(...points.map((entry) => entry.y * SOURCE_HEIGHT)) - 8
  const maxY = Math.max(...points.map((entry) => entry.y * SOURCE_HEIGHT)) + 8
  const width = Math.max(16, maxX - minX)
  const height = Math.max(16, maxY - minY)
  const scale = Math.min(200 / width, 200 / height)
  const canvas = document.createElement('canvas')
  canvas.width = 256
  canvas.height = 256
  const context = canvas.getContext('2d')!
  context.fillStyle = '#fff'
  context.fillRect(0, 0, 256, 256)
  context.strokeStyle = '#142b2a'
  context.lineCap = 'round'
  context.lineJoin = 'round'
  strokes.forEach((stroke) => {
    context.beginPath()
    stroke.points.forEach((entry, index) => {
      const x = (256 - width * scale) / 2 + (entry.x * SOURCE_WIDTH - minX) * scale
      const y = (256 - height * scale) / 2 + (entry.y * SOURCE_HEIGHT - minY) * scale
      if (index === 0) context.moveTo(x, y)
      else context.lineTo(x, y)
    })
    context.lineWidth = Math.max(1.4, stroke.baseWidth * scale * 0.45)
    context.stroke()
  })
  return canvas.toDataURL('image/png')
}

const sampleFor = (label: LabelDefinition, strokes: Stroke[], id: string): Sample => ({
  id,
  labelId: label.id,
  label: label.char,
  labelName: label.name,
  latex: label.latex,
  category: label.category,
  writerId: 'letter-holdout',
  sessionId: 'letter-holdout',
  createdAt: '2026-10-08T12:00:00.000Z',
  imageData: render(strokes),
  imageWidth: 256,
  imageHeight: 256,
  sourceCanvas: { width: SOURCE_WIDTH, height: SOURCE_HEIGHT, devicePixelRatio: 1 },
  bbox: [0, 0, 1, 1],
  strokes,
  strokeCount: strokes.length,
  pointCount: strokes.reduce((sum, stroke) => sum + stroke.points.length, 0),
  schemaVersion: 1,
})

const coveredLabels = BASE_CATALOG.filter((label) => (
  label.category === 'uppercase'
  || label.category === 'lowercase'
  || label.category === 'german'
  || label.category === 'digits'
  || COVERED_IDS.has(label.id)
))

const legacySlice = (tokens: RecognitionToken[], lineText: string) => {
  const chars = Array.from(normalizeGermanSharpS(lineText).normalize('NFC'))
    .filter((character) => !/\s/u.test(character))
  return tokens
    .filter((token) => !token.isLayout)
    .slice(0, chars.length)
    .map((token, index) => chars[index] ?? '')
    .filter((character) => character.length > 0)
}

const predictedCharacters = (tokens: RecognitionToken[]) => (
  tokens
    .filter((token) => !token.isLayout && token.letterStatus !== 'undecidable')
    .map((token) => token.char)
)

const levenshtein = (left: string, right: string) => {
  const a = Array.from(left)
  const b = Array.from(right)
  const row = Array.from({ length: b.length + 1 }, (_, index) => index)
  a.forEach((char, i) => {
    let diagonal = row[0]
    row[0] = i + 1
    b.forEach((other, j) => {
      const saved = row[j + 1]
      const cost = char === other ? 0 : 1
      row[j + 1] = Math.min(row[j + 1] + 1, row[j] + 1, diagonal + cost)
      diagonal = saved
    })
  })
  return row[b.length]
}

const cer = (truth: string, hypothesis: string) => {
  const length = Array.from(truth).length
  if (length === 0) return hypothesis.length ? 1 : 0
  return levenshtein(truth, hypothesis) / length
}

const countsFor = (cases: Array<{ truth: string | null; predicted: string | null }>) => {
  let truePositive = 0
  let falsePositive = 0
  let falseNegative = 0
  const misses: Array<{ truth: string | null; predicted: string | null }> = []
  cases.forEach((entry) => {
    if (entry.truth && entry.predicted === entry.truth) truePositive += 1
    else if (entry.truth && entry.predicted) {
      falsePositive += 1
      falseNegative += 1
      misses.push(entry)
    } else if (entry.truth) {
      falseNegative += 1
      misses.push(entry)
    } else if (entry.predicted) {
      falsePositive += 1
      misses.push(entry)
    }
  })
  const precision = truePositive + falsePositive === 0 ? 1 : truePositive / (truePositive + falsePositive)
  const recall = truePositive + falseNegative === 0 ? 1 : truePositive / (truePositive + falseNegative)
  const labeled = cases.filter((entry) => entry.truth)
  const accuracy = labeled.length === 0
    ? 1
    : labeled.filter((entry) => entry.predicted === entry.truth).length / labeled.length
  return { truePositive, falsePositive, falseNegative, precision, recall, accuracy, misses }
}

const shift = (strokes: Stroke[], dx: number, timeOffset: number): Stroke[] => (
  strokes.map((stroke) => ({
    ...stroke,
    points: stroke.points.map((entry) => ({ ...entry, x: entry.x + dx, t: entry.t + timeOffset })),
  }))
)

const inkFromPairs = (value: string) => {
  const parts = Array.from(value)
  return parts.flatMap((char, index) => shift(glyphStrokes(char, 0.16), index * 0.07, index * 40))
}

const iamStrokes = (): Stroke[] => (iamLine.strokes as number[][][]).map((raw) => ({
  baseWidth: 2.2,
  pressureEnabled: false,
  points: raw.map(([x, y, t]) => point(x, y, t)),
}))

const ujiStroke = (raw: number[][]): Stroke => ({
  baseWidth: 3.2,
  pressureEnabled: false,
  points: raw.map(([x, y], index) => point(0.2 + x * 0.0004, 0.25 + y * 0.00035, index)),
})

const run = async () => {
  const standard = await createStandardRecognitionSamples(BASE_CATALOG)
  const trained = coveredLabels.filter((label) => label.char !== 'q')
  const personal = trained.map((label) => sampleFor(label, glyphStrokes(label.char), `holdout-${label.id}`))
  const model = await buildRecognitionModel([...personal, ...standard])
  const cleanCases = trained.map((label) => {
    const recognized = segmentHandwritingLetters(glyphStrokes(label.char), model, BASE_CATALOG, 'de')
    const predicted = predictedCharacters(recognized.tokens)
    return {
      truth: label.char,
      predicted: predicted.length === 1 ? predicted[0] : predicted.join(''),
    }
  })
  const misleadingCases = trained.map((label) => {
    const raw = recognizeExpression(glyphStrokes(label.char), model, BASE_CATALOG, 'text', [], 'de')
    const misleading = label.char === 'ß' ? 'ß' : `${label.char === 'a' ? 'e' : 'a'}${label.char}`
    const before = legacySlice(raw, misleading).join('')
    const afterTokens = reconcileLetterReading(raw, raw, misleading)
    const after = predictedCharacters(afterTokens).join('')
    return {
      truth: label.char,
      before: before || null,
      after: after || null,
    }
  })
  const withheldStrokes: Stroke[] = [{
    baseWidth: 3.2,
    pressureEnabled: false,
    points: [
      point(0.34, 0.36, 0),
      point(0.4, 0.33, 1),
      point(0.44, 0.4, 2),
      point(0.38, 0.46, 3),
      point(0.33, 0.41, 4),
      point(0.37, 0.37, 5),
      point(0.42, 0.42, 6),
    ],
  }]
  const withheld = segmentHandwritingLetters(withheldStrokes, model, BASE_CATALOG, 'de')
  const withheldPredicted = predictedCharacters(withheld.tokens)
  const scribble: Stroke[] = [{
    baseWidth: 3,
    pressureEnabled: false,
    points: Array.from({ length: 18 }, (_, index) => point(
      0.3 + (index % 3) * 0.03,
      0.28 + ((index * 5) % 7) * 0.02,
      index,
    )),
  }]
  const scribbleResult = segmentHandwritingLetters(scribble, model, BASE_CATALOG, 'de')
  const scribblePredicted = predictedCharacters(scribbleResult.tokens)
  const wideWave: Stroke[] = [{
    baseWidth: 3.2,
    pressureEnabled: false,
    points: Array.from({ length: 16 }, (_, index) => point(
      0.18 + index * 0.018,
      0.4 + Math.sin(index * 0.55) * 0.03,
      index,
    )),
  }]
  const wideWaveResult = segmentHandwritingLetters(wideWave, model, BASE_CATALOG, 'de')

  const retrained = await buildRecognitionModel([
    ...personal,
    sampleFor(BASE_CATALOG.find((label) => label.char === 'q')!, withheldStrokes, 'holdout-q'),
    ...standard,
  ])
  const rerecognized = segmentHandwritingLetters(withheldStrokes, retrained, BASE_CATALOG, 'de')

  const pairCases = (ujiPairs as Array<{ text: string; strokes: number[][][] }>).map((entry) => ({
    truth: entry.text,
    strokes: entry.strokes.map(ujiStroke),
  }))
  const syntheticPairs = ['ab', 'Te', 'ßa'].map((text) => ({ truth: text, strokes: inkFromPairs(text) }))
  const lines = [
    { name: 'iam-online-a01-001z-01', truth: iamLine.truth, strokes: iamStrokes() },
    ...[...pairCases, ...syntheticPairs].map((entry) => ({ name: entry.truth, ...entry })),
  ]
  const lineReports = lines.map((entry) => {
    const raw = recognizeExpression(entry.strokes, model, BASE_CATALOG, 'text', [], 'de')
    const beforeText = recognizedSentence(raw)
    const after = decideLetterSpans(raw)
    const afterText = recognizedSentence(after)
    return {
      name: entry.name,
      truth: entry.truth,
      before: beforeText,
      after: afterText,
      beforeCer: cer(entry.truth, beforeText),
      afterCer: cer(entry.truth, afterText),
      letters: after.filter((token) => !token.isLayout).map((token) => ({
        char: token.letterStatus === 'undecidable' ? '' : token.char,
        status: token.letterStatus ?? 'labeled',
        confidence: token.confidence,
        cutConfidence: token.cutConfidence ?? 0,
      })),
    }
  })

  const clean = countsFor(cleanCases.map((entry) => ({
    truth: entry.truth,
    predicted: entry.predicted || null,
  })))
  const beforeSlice = countsFor(misleadingCases.map((entry) => ({
    truth: entry.truth,
    predicted: entry.before,
  })))
  const afterSlice = countsFor(misleadingCases.map((entry) => ({
    truth: entry.truth,
    predicted: entry.after,
  })))
  const average = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length)

  const report = {
    stage: 'index slice of a line string after ß → ss',
    clean,
    misleadingLine: { before: beforeSlice, after: afterSlice },
    withheldQ: {
      predicted: withheldPredicted.join(''),
      status: withheld.letters.map((letter) => letter.status),
      confidence: withheld.letters.map((letter) => letter.confidence),
      cutConfidence: withheld.letters.map((letter) => letter.cutConfidence),
    },
    scribble: {
      predicted: scribblePredicted.join(''),
      status: scribbleResult.letters.map((letter) => letter.status),
    },
    wideWave: {
      predicted: predictedCharacters(wideWaveResult.tokens).join(''),
      status: wideWaveResult.letters.map((letter) => letter.status),
    },
    rerecognizedQ: predictedCharacters(rerecognized.tokens).join(''),
    lines: lineReports.map((entry) => ({
      name: entry.name,
      truth: entry.truth,
      before: entry.before,
      after: entry.after,
      beforeCer: Math.round(entry.beforeCer * 1000) / 1000,
      afterCer: Math.round(entry.afterCer * 1000) / 1000,
    })),
    lineCer: {
      before: average(lineReports.map((entry) => entry.beforeCer)),
      after: average(lineReports.map((entry) => entry.afterCer)),
      iamBefore: lineReports[0].beforeCer,
      iamAfter: lineReports[0].afterCer,
    },
    sharpSReading: preservedReadingCharacters('Straße'),
    expandedSharpS: Array.from(normalizeGermanSharpS('Straße')),
  }
  document.body.innerHTML = `<pre id="result">${JSON.stringify(report).replaceAll('&', '&amp;').replaceAll('<', '&lt;')}</pre>`
}

run().catch((error) => {
  document.body.innerHTML = `<pre id="error">${String(error?.stack || error).replaceAll('&', '&amp;').replaceAll('<', '&lt;')}</pre>`
})
