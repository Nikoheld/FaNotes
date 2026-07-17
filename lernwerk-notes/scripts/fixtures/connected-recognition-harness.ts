import { BASE_CATALOG } from '../../../src/data/catalog'
import {
  buildRecognitionModel,
  connectedTextSegmentationHypotheses,
  estimatePenLiftTextCharacterCount,
  groupRecognitionLines,
  recognizeAutomaticExpression,
  recognizeExpression,
  recognizeMathDocument,
  recognizedLatex,
  recognizedSentence,
  resegmentTextTokensForCorrection,
  segmentStrokes,
  textCutCandidatesForTests,
} from '../../../src/lib/recognition'
import { createStandardRecognitionSamples } from '../../../src/lib/standardRecognition'
import type { LabelDefinition, Sample, Stroke, StrokePoint } from '../../../src/types'
import { fusePersonalizedTextRecognition } from '../../src/lib/personalizedTextRecognition'
import { recognizePersonalizedTextLine } from '../../src/lib/personalizedLineRecognition'

const SOURCE_WIDTH = 900
const SOURCE_HEIGHT = 560
const IMAGE_SIZE = 256

type LocalPath = [number, number][]
type LetterShape = { main: LocalPath; accessories?: LocalPath[] }

const shapes: Record<string, LetterShape> = {
  a: {
    main: [[0, .68], [.14, .51], [.42, .3], [.7, .35], [.76, .56], [.59, .78], [.28, .76], [.18, .56], [.4, .34], [.7, .35], [.69, .77], [1, .66]],
  },
  c: {
    main: [[0, .67], [.2, .46], [.45, .3], [.72, .32], [.84, .43], [.62, .34], [.31, .43], [.22, .65], [.4, .8], [.72, .78], [1, .66]],
  },
  t: {
    main: [[0, .7], [.22, .64], [.44, .08], [.48, .82], [.72, .72], [1, .67]],
    accessories: [[[.24, .35], [.72, .34]]],
  },
  e: {
    main: [[0, .68], [.22, .51], [.72, .49], [.64, .27], [.25, .25], [.1, .48], [.18, .76], [.65, .82], [1, .65]],
  },
  s: {
    main: [[0, .65], [.28, .31], [.73, .3], [.84, .45], [.25, .66], [.2, .78], [.48, .87], [.86, .75], [1, .66]],
  },
  h: {
    main: [[0, .68], [.17, .62], [.34, .1], [.43, .05], [.48, .25], [.42, .78], [.47, .48], [.64, .34], [.8, .44], [.78, .76], [1, .66]],
  },
  l: {
    main: [[0, .68], [.2, .6], [.38, .12], [.54, .06], [.6, .24], [.48, .68], [.57, .8], [.78, .76], [1, .66]],
  },
  m: {
    main: [[0, .68], [.18, .61], [.22, .38], [.24, .76], [.29, .48], [.43, .35], [.57, .45], [.55, .76], [.61, .46], [.75, .35], [.88, .45], [.87, .76], [1, .66]],
  },
  n: {
    main: [[0, .68], [.2, .61], [.24, .38], [.25, .76], [.31, .49], [.53, .34], [.72, .45], [.7, .76], [1, .66]],
  },
  o: {
    main: [[0, .68], [.18, .5], [.42, .31], [.7, .36], [.78, .57], [.6, .78], [.33, .77], [.2, .57], [.42, .34], [.72, .37], [1, .66]],
  },
  p: {
    main: [[0, .68], [.2, .61], [.27, .38], [.26, .98], [.25, .44], [.48, .31], [.72, .39], [.76, .61], [.57, .76], [.29, .66], [1, .66]],
  },
  r: {
    main: [[0, .68], [.2, .61], [.27, .39], [.29, .75], [.34, .48], [.51, .34], [.7, .45], [.82, .55], [1, .66]],
  },
  u: {
    main: [[0, .52], [.18, .43], [.18, .71], [.31, .8], [.52, .72], [.66, .42], [.65, .76], [1, .66]],
  },
}

const sentenceOnlyShapes: Record<string, LetterShape> = {
  i: {
    main: [[0, .68], [.2, .62], [.35, .35], [.36, .76], [.68, .76], [1, .66]],
    accessories: [[[.35, .14], [.35, .15]]],
  },
}

const mathShapes: Record<string, LocalPath[]> = {
  digit_0: [[[.5, .12], [.28, .16], [.16, .39], [.17, .68], [.34, .86], [.61, .85], [.8, .65], [.79, .34], [.66, .14], [.5, .12]]],
  digit_1: [[[.29, .29], [.49, .12], [.5, .83]], [[.29, .84], [.7, .84]]],
  digit_2: [[[.19, .31], [.28, .16], [.55, .11], [.77, .24], [.76, .4], [.58, .56], [.22, .83], [.8, .83]]],
  digit_3: [[[.2, .23], [.39, .12], [.68, .16], [.76, .34], [.62, .49], [.43, .5], [.65, .51], [.79, .66], [.67, .84], [.36, .88], [.19, .76]]],
  digit_4: [[[.68, .88], [.68, .12], [.18, .64], [.82, .64]]],
  digit_5: [[[.76, .14], [.3, .14], [.24, .47], [.52, .42], [.74, .54], [.73, .75], [.56, .87], [.3, .84], [.18, .74]]],
  digit_6: [[[.7, .18], [.5, .11], [.3, .24], [.2, .53], [.24, .78], [.43, .88], [.67, .81], [.75, .62], [.62, .48], [.39, .46], [.22, .58]]],
  digit_7: [[[.17, .16], [.81, .16], [.62, .4], [.48, .63], [.39, .88]]],
  digit_8: [[[.49, .49], [.29, .37], [.3, .18], [.5, .1], [.7, .2], [.67, .39], [.49, .49], [.28, .61], [.27, .79], [.48, .9], [.7, .79], [.69, .6], [.49, .49]]],
  digit_9: [[[.75, .45], [.61, .54], [.36, .51], [.23, .34], [.31, .14], [.57, .1], [.76, .28], [.73, .57], [.57, .82], [.36, .89]]],
  operator_plus: [[[.14, .5], [.86, .5]], [[.5, .16], [.5, .84]]],
  operator_minus: [[[.13, .51], [.87, .49]]],
  operator_multiply: [[[.2, .2], [.8, .8]], [[.79, .19], [.2, .81]]],
  relation_equal: [[[.13, .37], [.87, .36]], [[.12, .64], [.88, .63]]],
  operator_sqrt: [[[.08, .56], [.23, .69], [.34, .82], [.48, .17], [.9, .17]]],
  operator_integral: [[[.73, .12], [.58, .08], [.47, .18], [.43, .39], [.45, .62], [.39, .84], [.25, .91], [.13, .86]]],
  operator_sum: [[[.79, .14], [.22, .14], [.56, .5], [.2, .86], [.81, .86]]],
  operator_product: [[[.27, .8], [.27, .2], [.73, .2], [.73, .8]], [[.18, .2], [.82, .2]]],
}

const point = (x: number, y: number, t: number): StrokePoint => ({
  x, y, t, pressure: .61, tiltX: 0, tiltY: 0, pointerType: 'pen',
})

const mappedPath = (
  path: LocalPath,
  left: number,
  top: number,
  width: number,
  height: number,
  timeOffset: number,
  variation = 0,
) => path.map(([x, y], index) => point(
  left + x * width,
  top + y * height + Math.sin((index + 1) * 1.7) * variation,
  timeOffset + index,
))

const isolatedLetter = (char: keyof typeof shapes, variation = 0): Stroke[] => {
  const shape = shapes[char]
  const left = .38
  const top = .3
  const width = .065
  const height = .18
  return [shape.main, ...(shape.accessories ?? [])].map((path, index) => ({
    baseWidth: 3.7,
    pressureEnabled: true,
    points: mappedPath(path, left, top, width, height, index * 100, variation),
  }))
}

const mathAt = (
  labelId: keyof typeof mathShapes,
  left: number,
  top: number,
  width: number,
  height: number,
  variation = 0,
): Stroke[] => (
  mathShapes[labelId].map((path, index) => ({
    baseWidth: 3.9,
    pressureEnabled: true,
    points: mappedPath(path, left, top, width, height, index * 100, variation),
  }))
)

const isolatedMath = (labelId: keyof typeof mathShapes, variation = 0): Stroke[] => (
  mathAt(labelId, .38, .26, .075, .22, variation)
)

const connectedWord = (value: string, variation = 0): Stroke[] => {
  const left = .12
  const top = .28
  const width = .052
  const height = .16
  const connector = .008
  const main: StrokePoint[] = []
  const accessories: Stroke[] = []
  let time = 0
  ;[...value].forEach((char, index) => {
    const shape = shapes[char] ?? sentenceOnlyShapes[char]
    if (!shape) throw new Error(`Keine Testform für ${char} vorhanden.`)
    const letterLeft = left + index * (width + connector)
    const current = mappedPath(shape.main, letterLeft, top, width, height, time, variation)
    if (main.length) {
      const previous = main.at(-1)!
      const next = current[0]
      main.push(point((previous.x + next.x) / 2, (previous.y + next.y) / 2, ++time))
    }
    current.forEach((entry) => main.push({ ...entry, t: ++time }))
    ;(shape.accessories ?? []).forEach((path, accessoryIndex) => accessories.push({
      baseWidth: 3.7,
      pressureEnabled: true,
      points: mappedPath(path, letterLeft, top, width, height, 10_000 + index * 100 + accessoryIndex * 10, variation),
    }))
  })
  return [{ baseWidth: 3.7, pressureEnabled: true, points: main }, ...accessories]
}

const translatedStrokes = (strokes: Stroke[], offsetX: number, offsetY = 0): Stroke[] => (
  strokes.map((stroke) => ({
    ...stroke,
    points: stroke.points.map((entry) => ({
      ...entry,
      x: entry.x + offsetX,
      y: entry.y + offsetY,
    })),
  }))
)

const separatelyWrittenWord = (value: string, variation = 0): Stroke[] => (
  [...value].flatMap((character, index) => translatedStrokes(
    isolatedLetter(character as keyof typeof shapes, variation + index * .00003),
    .12 + index * .06 - .38,
    -.02,
  ))
)

const connectedSentence = (words: string[], variation = 0): Stroke[] => {
  let cursor = .025
  return words.flatMap((word, index) => {
    const strokes = translatedStrokes(
      connectedWord(word, variation + index * .00013),
      cursor - .12,
    )
    cursor += word.length * .06 + .05
    return strokes
  })
}

const renderSample = (strokes: Stroke[]) => {
  const points = strokes.flatMap((stroke) => stroke.points)
  const minX = Math.min(...points.map((entry) => entry.x * SOURCE_WIDTH)) - 7
  const maxX = Math.max(...points.map((entry) => entry.x * SOURCE_WIDTH)) + 7
  const minY = Math.min(...points.map((entry) => entry.y * SOURCE_HEIGHT)) - 7
  const maxY = Math.max(...points.map((entry) => entry.y * SOURCE_HEIGHT)) + 7
  const width = Math.max(14, maxX - minX)
  const height = Math.max(14, maxY - minY)
  const scale = Math.min(202 / width, 202 / height)
  const offsetX = (IMAGE_SIZE - width * scale) / 2
  const offsetY = (IMAGE_SIZE - height * scale) / 2
  const canvas = document.createElement('canvas')
  canvas.width = IMAGE_SIZE
  canvas.height = IMAGE_SIZE
  const context = canvas.getContext('2d')!
  context.fillStyle = '#fff'
  context.fillRect(0, 0, IMAGE_SIZE, IMAGE_SIZE)
  context.strokeStyle = '#142b2a'
  context.lineCap = 'round'
  context.lineJoin = 'round'
  strokes.forEach((stroke) => {
    context.beginPath()
    stroke.points.forEach((entry, index) => {
      const x = offsetX + (entry.x * SOURCE_WIDTH - minX) * scale
      const y = offsetY + (entry.y * SOURCE_HEIGHT - minY) * scale
      if (index) context.lineTo(x, y)
      else context.moveTo(x, y)
    })
    context.lineWidth = stroke.baseWidth * scale
    context.stroke()
  })
  return canvas.toDataURL('image/png')
}

const sampleFromLabel = (
  label: LabelDefinition,
  strokes: Stroke[],
  id: string,
): Sample => {
  return {
    id,
    labelId: label.id,
    label: label.char,
    labelName: label.name,
    latex: label.latex,
    category: label.category,
    writerId: 'Regression',
    sessionId: 'few-shot-connected-regression',
    createdAt: '2026-07-16T00:00:00.000Z',
    imageData: renderSample(strokes),
    imageWidth: IMAGE_SIZE,
    imageHeight: IMAGE_SIZE,
    sourceCanvas: { width: SOURCE_WIDTH, height: SOURCE_HEIGHT, devicePixelRatio: 1 },
    bbox: [0, 0, 1, 1],
    strokes,
    strokeCount: strokes.length,
    pointCount: strokes.reduce((sum, stroke) => sum + stroke.points.length, 0),
    schemaVersion: 1,
  }
}

const sampleFromStrokes = (
  labelChar: string,
  strokes: Stroke[],
  id: string,
) => sampleFromLabel(
  BASE_CATALOG.find((entry) => entry.char === labelChar) as LabelDefinition,
  strokes,
  id,
)

const sampleFor = (char: keyof typeof shapes, index: number): Sample => (
  sampleFromStrokes(char, isolatedLetter(char), `few-shot-${char}-${index}`)
)

const run = async () => {
  const standard = await createStandardRecognitionSamples(BASE_CATALOG)
  const wordStrokes = connectedWord('test', .0018)
  const baseClusters = segmentStrokes(wordStrokes, 'text')
  const hypotheses = connectedTextSegmentationHypotheses(baseClusters[0])
  const baselineModel = await buildRecognitionModel(standard)
  const reusedIdOriginal = sampleFromStrokes('a', isolatedLetter('a'), 'reused-import-sample-id')
  const reusedIdUpdated = sampleFromStrokes('a', isolatedLetter('c', .0011), 'reused-import-sample-id')
  const reusedIdFirstModel = await buildRecognitionModel([reusedIdOriginal])
  const reusedIdSecondModel = await buildRecognitionModel([reusedIdUpdated])
  const reusedIdFeatureDistance = reusedIdFirstModel[0].raster.reduce((sum, value, index) => (
    sum + Math.abs(value - reusedIdSecondModel[0].raster[index])
  ), 0) / reusedIdFirstModel[0].raster.length
  const sentenceStrokes = connectedSentence(['hallo', 'mathe'], .0021)
  const dottedSentenceStrokes = connectedSentence(['minimum', 'ist', 'neun'], .0019)
  const baselineSentenceAutomatic = recognizeAutomaticExpression(
    sentenceStrokes,
    baselineModel,
    BASE_CATALOG,
    [],
    'de',
    'math',
  )
  const baselineDottedSentenceAutomatic = recognizeAutomaticExpression(
    dottedSentenceStrokes,
    baselineModel,
    BASE_CATALOG,
    [],
    'de',
    'math',
  )
  const automaticTextCases = [
    { expected: 'summe ist neun', words: ['summe', 'ist', 'neun'], language: 'de' as const },
    { expected: 'mathe ist toll', words: ['mathe', 'ist', 'toll'], language: 'de' as const },
    { expected: 'hello math', words: ['hello', 'math'], language: 'en' as const },
    { expected: 'hello computer', words: ['hello', 'computer'], language: 'en' as const },
  ].map((test, index) => {
    const recognition = recognizeAutomaticExpression(
      connectedSentence(test.words, .0018 + index * .00017),
      baselineModel,
      BASE_CATALOG,
      [],
      test.language,
      'math',
    )
    return {
      expected: test.expected,
      mode: recognition.mode,
      value: recognition.value,
      reason: recognition.reason,
      textScore: recognition.textScore,
      mathScore: recognition.mathScore,
      textValue: recognition.textValue,
    }
  })
  const incrementalTextCases = ['t', 'te', 'tes', 'test'].map((expected, index) => {
    const incrementalStrokes = separatelyWrittenWord(expected, .0027)
    const recognition = recognizeAutomaticExpression(
      incrementalStrokes,
      baselineModel,
      BASE_CATALOG,
      [],
      'de',
      'text',
      expected.length > 1 ? expected.length : undefined,
      expected.length > 1 ? expected : undefined,
    )
    return {
      expected,
      mode: recognition.mode,
      value: recognition.value,
      textValue: recognition.textValue,
      mathValue: recognition.mathValue,
      reason: recognition.reason,
      textScore: recognition.textScore,
      mathScore: recognition.mathScore,
      textTokens: recognition.textValue.length,
      cutCandidates: textCutCandidatesForTests(incrementalStrokes),
      segmentationSizes: segmentStrokes(incrementalStrokes, 'text').flatMap((cluster) => (
        connectedTextSegmentationHypotheses(cluster).map((hypothesis) => hypothesis.length)
      )),
      guidedSegmentationSizes: segmentStrokes(incrementalStrokes, 'text').flatMap((cluster) => (
        connectedTextSegmentationHypotheses(cluster, expected.length).map((hypothesis) => hypothesis.length)
      )),
      detachedConnectorRanges: segmentStrokes(incrementalStrokes, 'text').flatMap((cluster) => (
        cluster.detachedTextConnectorRanges ?? []
      )),
    }
  })
  const incrementalTextRecovery = recognizeAutomaticExpression(
    separatelyWrittenWord('te', .0027),
    baselineModel,
    BASE_CATALOG,
    [],
    'de',
    'math',
    2,
    'te',
  )
  const rapidClosePairs = ['te', 'ac', 'os', 'st'].map((expected, index) => {
    const pairStrokes = separatelyWrittenWord(expected, .0031 + index * .00011)
    const recognition = recognizeAutomaticExpression(
      pairStrokes,
      baselineModel,
      BASE_CATALOG,
      [],
      'de',
      'text',
    )
    return {
      expected,
      mode: recognition.mode,
      value: recognition.value,
      textValue: recognition.textValue,
      mathValue: recognition.mathValue,
      tokenCount: recognition.tokens.filter((entry) => !entry.isLayout).length,
      baseClusters: segmentStrokes(pairStrokes, 'text').length,
      hypothesisSizes: segmentStrokes(pairStrokes, 'text').flatMap((cluster) => (
        connectedTextSegmentationHypotheses(cluster).map((entry) => entry.length)
      )),
      estimatedPenLiftCount: estimatePenLiftTextCharacterCount(pairStrokes),
    }
  })
  const automaticEquation = recognizeAutomaticExpression([
    ...mathAt('digit_1', .22, .3, .06, .18),
    ...mathAt('operator_plus', .34, .3, .06, .18),
    ...mathAt('digit_2', .46, .3, .06, .18),
    ...mathAt('relation_equal', .58, .3, .06, .18),
    ...mathAt('digit_3', .7, .3, .06, .18),
  ], baselineModel, BASE_CATALOG, [], 'de', 'text')
  const normalUppercaseT: Stroke[] = [
    {
      baseWidth: 3.8,
      pressureEnabled: true,
      points: [point(.36, .25, 0), point(.46, .25, 1)],
    },
    {
      baseWidth: 3.8,
      pressureEnabled: true,
      points: [point(.41, .25, 2), point(.41, .49, 3)],
    },
  ]
  const wideTTopBar: Stroke = {
    baseWidth: 3.8,
    pressureEnabled: true,
    points: [
      point(.3, .25, 0),
      point(.345, .248, 1),
      point(.39, .251, 2),
      point(.435, .249, 3),
      point(.48, .252, 4),
    ],
  }
  const wideTStem: Stroke = {
    baseWidth: 3.8,
    pressureEnabled: true,
    points: [
      point(.39, .25, 6),
      point(.389, .31, 7),
      point(.391, .37, 8),
      point(.389, .435, 9),
      point(.39, .5, 10),
    ],
  }
  const closeFollowingE = translatedStrokes(isolatedLetter('e', .0005), .075, -.02)
    .map((stroke) => ({
      ...stroke,
      points: stroke.points.map((entry) => ({ ...entry, t: entry.t + 40 })),
    }))
  const wideTWithCloseE = [wideTTopBar, wideTStem, ...closeFollowingE]
  const wideTWithCloseEClusters = segmentStrokes(wideTWithCloseE, 'text')
  const wideTWithCloseEHypotheses = wideTWithCloseEClusters.flatMap((cluster) => (
    connectedTextSegmentationHypotheses(cluster, 2)
  ))
  const completeTopBarTimes = wideTTopBar.points.map((entry) => entry.t)
  const preservesCompleteTTopBar = (parts: Array<{ strokes: Stroke[] }>) => {
    const matches = parts.flatMap((part, partIndex) => part.strokes.flatMap((stroke) => {
      const touchesTopBar = stroke.points.some((entry) => entry.t >= 0 && entry.t <= 4)
      return touchesTopBar ? [{ partIndex, stroke }] : []
    }))
    if (matches.length !== 1) return false
    const match = matches[0]
    const intact = (
      match.stroke.points.length === wideTTopBar.points.length &&
      match.stroke.points.every((entry, index) => entry.t === completeTopBarTimes[index])
    )
    const sharesTStem = parts[match.partIndex].strokes.some((stroke) => (
      stroke.points.some((entry) => entry.t >= 6 && entry.t <= 10)
    ))
    return intact && sharesTStem
  }
  const wideTWithCloseETwoPartHypotheses = wideTWithCloseEHypotheses
    .filter((hypothesis) => hypothesis.length === 2)
  const normalTMathTokens = recognizeExpression(
    normalUppercaseT,
    baselineModel,
    BASE_CATALOG,
    'math',
    [],
    'de',
  )
  const normalTAutomatic = recognizeAutomaticExpression(
    normalUppercaseT,
    baselineModel,
    BASE_CATALOG,
    [],
    'de',
    'math',
  )
  const correctedTModel = await buildRecognitionModel([
    sampleFromStrokes('T', normalUppercaseT, 'confirmed-uppercase-t'),
    ...standard,
  ])
  const correctedTAutomatic = recognizeAutomaticExpression(
    normalUppercaseT,
    correctedTModel,
    BASE_CATALOG,
    [],
    'de',
    'math',
  )
  const wideTWithCloseETokens = recognizeExpression(
    wideTWithCloseE,
    correctedTModel,
    BASE_CATALOG,
    'text',
    [],
    'de',
    2,
    'Te',
  )
  const doubleIntegralLabel = BASE_CATALOG.find((entry) => entry.id === 'operator_double_integral')!
  const staleWrongT = {
    ...sampleFromStrokes(doubleIntegralLabel.char, normalUppercaseT, 'stale-wrong-double-integral'),
    labelId: doubleIntegralLabel.id,
    label: doubleIntegralLabel.char,
    labelName: doubleIntegralLabel.name,
    latex: doubleIntegralLabel.latex,
    sessionId: 'old-imported-training',
    createdAt: '2025-01-01T00:00:00.000Z',
  }
  const latestCorrectT = {
    ...sampleFromStrokes('T', normalUppercaseT, 'latest-confirmed-uppercase-t'),
    sessionId: 'recognized-corrections',
    createdAt: '2026-07-16T00:00:00.000Z',
  }
  const conflictResolvedModel = await buildRecognitionModel([
    staleWrongT,
    latestCorrectT,
    ...standard,
  ])
  const conflictResolvedT = recognizeAutomaticExpression(
    normalUppercaseT,
    conflictResolvedModel,
    BASE_CATALOG,
    [],
    'de',
    'math',
  )
  const realDoubleIntegral = [
    ...mathAt('operator_integral', .36, .24, .035, .25, .00008),
    ...mathAt('operator_integral', .384, .24, .035, .25, .00006),
  ]
  const realDoubleIntegralTokens = recognizeExpression(
    realDoubleIntegral,
    baselineModel,
    BASE_CATALOG,
    'math',
    [],
    'de',
  )
  const realDoubleIntegralAutomatic = recognizeAutomaticExpression(
    realDoubleIntegral,
    baselineModel,
    BASE_CATALOG,
    [],
    'de',
    'text',
  )
  const baselineTokens = recognizeExpression(wordStrokes, baselineModel, BASE_CATALOG, 'text', [], 'de')
  const mergedCorrectionToken = {
    ...baselineTokens[0],
    id: 'merged-word-token',
    strokes: wordStrokes,
    bbox: [
      Math.min(...baselineTokens.map((token) => token.bbox[0])),
      Math.min(...baselineTokens.map((token) => token.bbox[1])),
      Math.max(...baselineTokens.map((token) => token.bbox[0] + token.bbox[2])) -
        Math.min(...baselineTokens.map((token) => token.bbox[0])),
      Math.max(...baselineTokens.map((token) => token.bbox[1] + token.bbox[3])) -
        Math.min(...baselineTokens.map((token) => token.bbox[1])),
    ] as [number, number, number, number],
  }
  const correctionResegmentation = resegmentTextTokensForCorrection([mergedCorrectionToken], [4])
  const zeroShotIsolated = Object.keys(shapes).map((expected, index) => ({
    expected,
    recognized: recognizedSentence(recognizeExpression(
      isolatedLetter(expected, .0009 + index * .00007),
      baselineModel,
      BASE_CATALOG,
      'text',
      [],
      'de',
    )).toLocaleLowerCase('de'),
  }))
  const zeroShotWords = ['test', 'hallo', 'lernen', 'mathe', 'computer'].map((expected, index) => {
    const tokens = recognizeExpression(
      connectedWord(expected, .0011 + index * .00017),
      baselineModel,
      BASE_CATALOG,
      'text',
      [],
      'de',
    )
    return {
      expected,
      recognized: recognizedSentence(tokens).toLocaleLowerCase('de'),
      tokens: tokens.map((token) => ({
        char: token.char,
        confidence: token.confidence,
        alternatives: token.alternatives.slice(0, 12).map((alternative) => ({
          char: alternative.char,
          confidence: alternative.confidence,
        })),
      })),
    }
  })
  const zeroShotMath = Object.keys(mathShapes).map((expected, index) => {
    const tokens = recognizeExpression(
      isolatedMath(expected, .0003 + index * .000021),
      baselineModel,
      BASE_CATALOG,
      'math',
      [],
      'de',
    )
    return {
      expected,
      recognized: tokens.filter((token) => !token.isLayout).map((token) => token.labelId),
      latex: recognizedLatex(tokens),
      tokens: tokens.map((token) => ({
        labelId: token.labelId,
        char: token.char,
        confidence: token.confidence,
        alternatives: token.alternatives.slice(0, 8),
      })),
    }
  })
  const personalMathSamples = (Object.keys(mathShapes) as (keyof typeof mathShapes)[]).flatMap((labelId, labelIndex) => {
    const label = BASE_CATALOG.find((entry) => entry.id === labelId)!
    return Array.from({ length: 12 }, (_, index) => sampleFromLabel(
      label,
      isolatedMath(labelId, (index - 6) * .00018 + labelIndex * .000004),
      `personal-math-${labelId}-${index}`,
    ))
  })
  const personalMathModel = await buildRecognitionModel([...personalMathSamples, ...standard])
  const personalMathHoldouts = (Object.keys(mathShapes) as (keyof typeof mathShapes)[]).map((expected, index) => ({
    expected,
    recognized: recognizeExpression(
      isolatedMath(expected, .0025 + index * .00006),
      personalMathModel,
      BASE_CATALOG,
      'math',
      [],
      'de',
    ).filter((token) => !token.isLayout).map((token) => token.labelId),
  }))
  const radicalTokens = recognizeExpression([
    ...mathAt('operator_sqrt', .18, .2, .22, .28, .00027),
    ...mathAt('digit_7', .29, .25, .045, .14, .00019),
  ], baselineModel, BASE_CATALOG, 'math', [], 'de')
  const fractionBar: Stroke = {
    baseWidth: 3.9,
    pressureEnabled: true,
    points: [point(.405, .49, 0), point(.565, .489, 1)],
  }
  const fractionTokens = recognizeExpression([
    ...mathAt('digit_2', .455, .31, .045, .12, .00017),
    fractionBar,
    ...mathAt('digit_3', .455, .55, .045, .12, .00013),
  ], baselineModel, BASE_CATALOG, 'math', [], 'de')
  const personalModel = await buildRecognitionModel([
    sampleFor('t', 0), sampleFor('e', 0), sampleFor('s', 0),
    ...standard,
  ])
  const personalTokens = recognizeExpression(wordStrokes, personalModel, BASE_CATALOG, 'text', [], 'de')
  const densePersonalSamples = (['t', 'e', 's'] as const).flatMap((character) => (
    Array.from({ length: 16 }, (_, index) => sampleFromStrokes(
      character,
      isolatedLetter(character, (index - 8) * .00016),
      `dense-personal-${character}-${index}`,
    ))
  ))
  const densePersonalModel = await buildRecognitionModel([...densePersonalSamples, ...standard])
  const densePersonalTokens = recognizeExpression(wordStrokes, densePersonalModel, BASE_CATALOG, 'text', [], 'de')
  const compressedWordStrokes = connectedWord('test', .00023).map((stroke) => ({
    ...stroke,
    points: stroke.points.map((entry) => ({
      ...entry,
      x: .12 + (entry.x - .12) * .52,
    })),
  }))
  const compressedUnguidedTokens = recognizeExpression(
    compressedWordStrokes,
    densePersonalModel,
    BASE_CATALOG,
    'text',
    [],
    'de',
  )
  const compressedGuidedTokens = recognizeExpression(
    compressedWordStrokes,
    densePersonalModel,
    BASE_CATALOG,
    'text',
    [],
    'de',
    4,
    'test',
  )
  const neuralTost = {
    text: 'tost',
    confidence: 94,
    engine: 'pylaia-iam' as const,
    lines: [{
      text: 'tost',
      rawText: 'tost',
      confidence: 94,
      bbox: [0.1, 0.28, 0.24, 0.16] as [number, number, number, number],
      characters: Array.from('tost').map((char, index) => ({
        char,
        confidence: 94,
        start: index / 4,
        end: (index + 1) / 4,
      })),
    }],
  }
  const personalizedFusion = fusePersonalizedTextRecognition(
    densePersonalTokens,
    neuralTost,
    'de',
  )
  const largePersonalSamples = (Object.keys(shapes) as (keyof typeof shapes)[]).flatMap((character, characterIndex) => (
    Array.from({ length: 77 }, (_, index) => sampleFromStrokes(
      character,
      isolatedLetter(character, (index - 38) * .0001 + characterIndex * .000003),
      `large-personal-${character}-${index}`,
    ))
  ))
  const largeModelStartedAt = performance.now()
  const largePersonalModel = await buildRecognitionModel([...largePersonalSamples, ...standard])
  const largeModelDurationMs = Math.round(performance.now() - largeModelStartedAt)
  const personalSentenceAutomatic = recognizeAutomaticExpression(
    sentenceStrokes,
    largePersonalModel,
    BASE_CATALOG,
    [],
    'de',
    'math',
  )
  const largeHoldoutCases = ['test', 'hallo', 'lernen', 'mathe', 'computer'].map((expected, index) => ({
    expected,
    strokes: connectedWord(expected, .0042 + index * .00017),
  }))
  const largeHoldoutWords = largeHoldoutCases.map(({ expected, strokes }) => {
    const recognitionStartedAt = performance.now()
    const tokens = recognizeExpression(
      strokes,
      largePersonalModel,
      BASE_CATALOG,
      'text',
      [],
      'de',
    )
    const durationMs = Math.round(performance.now() - recognitionStartedAt)
    return {
      expected,
      recognized: recognizedSentence(tokens).toLocaleLowerCase('de'),
      durationMs,
      tokens: tokens.map((token) => ({
        char: token.char,
        confidence: token.confidence,
        bbox: token.bbox,
        personalSupport: token.personalSupport,
        personalConfidence: token.personalConfidence,
        alternatives: token.alternatives.slice(0, 8),
      })),
    }
  })
  const largePersonalLineFusion = await recognizePersonalizedTextLine(
    largeHoldoutCases[0].strokes,
    {
      model: largePersonalModel,
      samples: largePersonalSamples,
      labels: BASE_CATALOG,
      layoutExamples: [],
      sampleCount: largePersonalSamples.length,
      classCount: new Set(largePersonalSamples.map((sample) => sample.labelId)).size,
      baselineSampleCount: standard.length,
      modelClassCount: new Set(largePersonalModel.map((entry) => entry.labelId)).size,
    },
    {
      text: 'ort',
      confidence: 86,
      engine: 'trocr-bilingual',
      lines: [{
        text: 'ort',
        rawText: 'ort',
        confidence: 86,
        bbox: [.12, .28, .24, .16],
        characters: Array.from('ort').map((char, index) => ({
          char,
          confidence: 86,
          start: index / 3,
          end: (index + 1) / 3,
        })),
      }],
    },
    'de',
  )
  const halloForcedParts = resegmentTextTokensForCorrection([{
    ...baselineTokens[0],
    id: 'forced-hallo',
    strokes: largeHoldoutCases[1].strokes,
  }], [5]) ?? []
  const halloForcedFive = halloForcedParts.map((token) => recognizedSentence(recognizeExpression(
    token.strokes,
    largePersonalModel,
    BASE_CATALOG,
    'text',
    [],
    'de',
  ))).join('')
  const largeHoldoutLetters = (Object.keys(shapes) as (keyof typeof shapes)[]).map((expected, index) => ({
    expected,
    recognized: recognizedSentence(recognizeExpression(
      isolatedLetter(expected, .0045 + index * .0001),
      largePersonalModel,
      BASE_CATALOG,
      'text',
      [],
      'de',
    )).toLocaleLowerCase('de'),
  }))
  const personalizedAppearanceModel = await buildRecognitionModel([
    sampleFromStrokes('a', isolatedLetter('c', .0004), 'personal-style-a-shaped-like-c'),
    ...standard,
  ])
  const personalizedAppearanceTokens = recognizeExpression(
    isolatedLetter('c', .00065),
    personalizedAppearanceModel,
    BASE_CATALOG,
    'text',
    [],
    'de',
  )
  const personalizedAppearanceValue = recognizedSentence(personalizedAppearanceTokens)
  const weakPersonalFusion = fusePersonalizedTextRecognition(
    personalizedAppearanceTokens,
    {
      text: 'c',
      confidence: 96,
      engine: 'pylaia-iam',
      lines: [{
        text: 'c',
        rawText: 'c',
        confidence: 96,
        bbox: [.38, .3, .065, .18],
        characters: [{ char: 'c', confidence: 96, start: 0, end: 1 }],
      }],
    },
    'de',
  )
  const germanSpecialFusion = fusePersonalizedTextRecognition(
    [{
      ...personalizedAppearanceTokens[0],
      char: 'ü',
      name: 'ü',
      latex: 'ü',
      confidence: 86,
      personalSupport: 0,
      personalConfidence: 0,
      alternatives: personalizedAppearanceTokens[0].alternatives,
    }],
    {
      text: 'u',
      confidence: 91,
      engine: 'pylaia-iam',
      lines: [{
        text: 'u',
        rawText: 'u',
        confidence: 91,
        bbox: [.38, .3, .065, .18],
        characters: [{ char: 'u', confidence: 91, start: 0, end: 1 }],
      }],
    },
    'de',
  )
  const noisyPersonalModel = await buildRecognitionModel([
    ...Array.from({ length: 18 }, (_, index) => sampleFromStrokes(
      'a',
      isolatedLetter('a', (index - 9) * .00013),
      `noise-correct-a-${index}`,
    )),
    ...Array.from({ length: 18 }, (_, index) => sampleFromStrokes(
      'o',
      isolatedLetter('o', (index - 9) * .00013),
      `noise-correct-o-${index}`,
    )),
    ...Array.from({ length: 24 }, (_, index) => ({
      ...sampleFromStrokes(
        'o',
        isolatedLetter('a', (index - 12) * .00019 + .00007),
        `noise-wrong-a-as-o-${index}`,
      ),
      sessionId: 'legacy-noisy-import',
      createdAt: `2025-01-${String((index % 24) + 1).padStart(2, '0')}T00:00:00.000Z`,
    })),
    ...standard,
  ])
  const noisyPersonalValue = recognizedSentence(recognizeExpression(
    isolatedLetter('a', .0039),
    noisyPersonalModel,
    BASE_CATALOG,
    'text',
    [],
    'de',
  ))
  const wideLetter: Stroke = {
    baseWidth: 3.7,
    pressureEnabled: true,
    points: [[.2, .3], [.22, .48], [.25, .37], [.28, .48], [.31, .3]].map(([x, y], index) => point(x, y, index)),
  }
  const wideCluster = segmentStrokes([wideLetter], 'text')[0]
  const dottedI = [
    {
      baseWidth: 3.7,
      pressureEnabled: true,
      points: [point(.42, .35, 0), point(.42, .49, 1)],
    },
    {
      baseWidth: 3.7,
      pressureEnabled: true,
      points: [point(.42, .295, 2)],
    },
  ]
  const detachedExitA = [
    ...isolatedLetter('a', .0007),
    {
      baseWidth: 3.7,
      pressureEnabled: true,
      points: [
        point(.46, .419, 300),
        point(.468, .416, 301),
        point(.48, .411, 302),
      ],
    },
  ]
  const detachedExitValue = recognizedSentence(recognizeExpression(
    detachedExitA,
    baselineModel,
    BASE_CATALOG,
    'text',
    [],
    'de',
  ))
  const multiLineMathStrokes = [
    ...mathAt('digit_1', .12, .08, .075, .22),
    ...mathAt('operator_plus', .23, .08, .075, .22),
    ...mathAt('digit_2', .34, .08, .075, .22),
    ...mathAt('digit_3', .12, .56, .075, .22),
    ...mathAt('relation_equal', .23, .56, .075, .22),
    ...mathAt('digit_3', .34, .56, .075, .22),
  ]
  const multiLineMathTokens = recognizeMathDocument(
    multiLineMathStrokes,
    baselineModel,
    BASE_CATALOG,
    [],
    'de',
  )
  const integralWithLimits = [
    ...mathAt('operator_integral', .28, .22, .07, .3, .00021),
    ...mathAt('digit_5', .3, .1, .05, .12, .00008),
    ...mathAt('digit_1', .3, .54, .05, .12, .00006),
  ]
  const integralLimitTokens = recognizeMathDocument(
    integralWithLimits,
    baselineModel,
    BASE_CATALOG,
    [],
    'de',
  )
  const sumWithLimits = [
    ...mathAt('operator_sum', .28, .22, .075, .3, .00018),
    ...mathAt('digit_5', .295, .1, .05, .12, .00007),
    ...mathAt('digit_1', .295, .54, .05, .12, .00005),
  ]
  const sumLimitTokens = recognizeMathDocument(
    sumWithLimits,
    baselineModel,
    BASE_CATALOG,
    [],
    'de',
  )
  const productWithLimits = [
    ...mathAt('operator_product', .28, .22, .075, .3, .00016),
    ...mathAt('digit_5', .295, .1, .05, .12, .00006),
    ...mathAt('digit_1', .295, .54, .05, .12, .00004),
  ]
  const productLimitTokens = recognizeMathDocument(
    productWithLimits,
    baselineModel,
    BASE_CATALOG,
    [],
    'de',
  )
  const tripleIntegral = [
    ...mathAt('operator_integral', .34, .24, .034, .25, .00008),
    ...mathAt('operator_integral', .365, .24, .034, .25, .00006),
    ...mathAt('operator_integral', .39, .24, .034, .25, .00004),
  ]
  const tripleIntegralTokens = recognizeExpression(
    tripleIntegral,
    baselineModel,
    BASE_CATALOG,
    'math',
    [],
    'de',
  )
  const ordinaryScripts = [
    ...mathAt('digit_2', .3, .3, .065, .2, .00009),
    ...mathAt('digit_3', .37, .205, .038, .09, .00004),
    ...mathAt('digit_4', .37, .505, .038, .09, .00003),
  ]
  const ordinaryScriptTokens = recognizeMathDocument(
    ordinaryScripts,
    baselineModel,
    BASE_CATALOG,
    [],
    'de',
  )
  return {
    baseClusterCount: baseClusters.length,
    hypothesisSizes: hypotheses.map((entry) => entry.length),
    baseCutCandidates: textCutCandidatesForTests(wordStrokes),
    baseStrokeBounds: {
      minX: Math.min(...wordStrokes.flatMap((stroke) => stroke.points.map((entry) => entry.x))),
      maxX: Math.max(...wordStrokes.flatMap((stroke) => stroke.points.map((entry) => entry.x))),
      minY: Math.min(...wordStrokes.flatMap((stroke) => stroke.points.map((entry) => entry.y))),
      maxY: Math.max(...wordStrokes.flatMap((stroke) => stroke.points.map((entry) => entry.y))),
    },
    baselineValue: recognizedSentence(baselineTokens),
    baselineTokenCount: baselineTokens.length,
    reusedIdFeatureDistance,
    correctionResegmentationCount: correctionResegmentation?.length ?? 0,
    normalTMathLabels: normalTMathTokens.map((token) => token.labelId),
    normalTAutomatic: {
      mode: normalTAutomatic.mode,
      value: normalTAutomatic.value,
      reason: normalTAutomatic.reason,
      labels: normalTAutomatic.tokens.map((token) => token.labelId),
    },
    correctedTAutomatic: {
      mode: correctedTAutomatic.mode,
      value: correctedTAutomatic.value,
      labels: correctedTAutomatic.tokens.map((token) => token.labelId),
    },
    wideTWithCloseE: {
      baseClusters: wideTWithCloseEClusters.length,
      estimatedCount: estimatePenLiftTextCharacterCount(wideTWithCloseE),
      twoPartHypotheses: wideTWithCloseETwoPartHypotheses.length,
      completeTopBarHypotheses: wideTWithCloseETwoPartHypotheses
        .filter((hypothesis) => preservesCompleteTTopBar(hypothesis)).length,
      value: recognizedSentence(wideTWithCloseETokens),
      labels: wideTWithCloseETokens.map((token) => token.labelId),
      tokenCount: wideTWithCloseETokens.length,
      selectedTopBarComplete: preservesCompleteTTopBar(wideTWithCloseETokens),
    },
    conflictResolvedT: {
      mode: conflictResolvedT.mode,
      value: conflictResolvedT.value,
      labels: conflictResolvedT.tokens.map((token) => token.labelId),
      staleWrongExamples: conflictResolvedModel.filter((entry) => (
        !entry.standard && entry.labelId === 'operator_double_integral'
      )).length,
    },
    realDoubleIntegralLabels: realDoubleIntegralTokens.map((token) => token.labelId),
    realDoubleIntegralAutomatic: {
      mode: realDoubleIntegralAutomatic.mode,
      value: realDoubleIntegralAutomatic.value,
      textValue: realDoubleIntegralAutomatic.textValue,
      mathValue: realDoubleIntegralAutomatic.mathValue,
      textScore: realDoubleIntegralAutomatic.textScore,
      mathScore: realDoubleIntegralAutomatic.mathScore,
    },
    zeroShotIsolated,
    zeroShotWords,
    baselineSentenceAutomatic: {
      mode: baselineSentenceAutomatic.mode,
      value: baselineSentenceAutomatic.value,
      reason: baselineSentenceAutomatic.reason,
      textScore: baselineSentenceAutomatic.textScore,
      mathScore: baselineSentenceAutomatic.mathScore,
      textValue: baselineSentenceAutomatic.textValue,
    },
    baselineDottedSentenceAutomatic: {
      mode: baselineDottedSentenceAutomatic.mode,
      value: baselineDottedSentenceAutomatic.value,
      reason: baselineDottedSentenceAutomatic.reason,
      textScore: baselineDottedSentenceAutomatic.textScore,
      mathScore: baselineDottedSentenceAutomatic.mathScore,
      textValue: baselineDottedSentenceAutomatic.textValue,
    },
    automaticTextCases,
    incrementalTextCases,
    rapidClosePairs,
    incrementalTextRecovery: {
      mode: incrementalTextRecovery.mode,
      value: incrementalTextRecovery.value,
      textValue: incrementalTextRecovery.textValue,
      mathValue: incrementalTextRecovery.mathValue,
      reason: incrementalTextRecovery.reason,
      textScore: incrementalTextRecovery.textScore,
      mathScore: incrementalTextRecovery.mathScore,
    },
    automaticEquation: {
      mode: automaticEquation.mode,
      value: automaticEquation.value,
      reason: automaticEquation.reason,
      textScore: automaticEquation.textScore,
      mathScore: automaticEquation.mathScore,
    },
    zeroShotMath,
    personalMathBenchmark: {
      suppliedSamples: personalMathSamples.length,
      retainedSamples: personalMathModel.filter((entry) => !entry.standard).length,
      holdouts: personalMathHoldouts,
    },
    zeroShotStructures: {
      radical: recognizedLatex(radicalTokens),
      radicalLabels: radicalTokens.map((token) => token.labelId),
      fraction: recognizedLatex(fractionTokens),
      fractionLabels: fractionTokens.map((token) => token.labelId),
    },
    baselineTokens: baselineTokens.map((token) => ({
      char: token.char,
      confidence: token.confidence,
      bbox: token.bbox,
      alternatives: token.alternatives.slice(0, 32).map((alternative) => ({
        char: alternative.char,
        confidence: alternative.confidence,
      })),
    })),
    personalValue: recognizedSentence(personalTokens),
    personalTokenCount: personalTokens.length,
    personalConfidences: personalTokens.map((token) => token.confidence),
    densePersonalValue: recognizedSentence(densePersonalTokens),
    compressedNeuralGuidance: {
      unguided: recognizedSentence(compressedUnguidedTokens),
      guided: recognizedSentence(compressedGuidedTokens),
      guidedTokenCount: compressedGuidedTokens.length,
      preferredHypothesisSizes: connectedTextSegmentationHypotheses(
        segmentStrokes(compressedWordStrokes, 'text')[0],
        4,
      ).map((entry) => entry.length),
    },
    personalizedFusion,
    largePersonalBenchmark: {
      suppliedSamples: largePersonalSamples.length,
      retainedSamples: largePersonalModel.filter((entry) => !entry.standard).length,
      classifierSamples: largePersonalModel.classifierEntries.filter((entry) => !entry.standard).length,
      prototypeClasses: largePersonalModel.prototypeSets.size,
      estimatedAccuracy: largePersonalModel.estimatedAccuracy,
      evaluatedSamples: largePersonalModel.evaluatedSamples,
      durationMs: largeModelDurationMs,
      sentenceAutomatic: {
        mode: personalSentenceAutomatic.mode,
        value: personalSentenceAutomatic.value,
        reason: personalSentenceAutomatic.reason,
        textScore: personalSentenceAutomatic.textScore,
        mathScore: personalSentenceAutomatic.mathScore,
        textValue: personalSentenceAutomatic.textValue,
      },
      words: largeHoldoutWords,
      integratedFusion: largePersonalLineFusion.fusion,
      integratedTokens: largePersonalLineFusion.tokens.map((token) => ({
        char: token.char,
        confidence: token.confidence,
        personalSupport: token.personalSupport,
        personalConfidence: token.personalConfidence,
        alternatives: token.alternatives.slice(0, 12).map((alternative) => ({
          char: alternative.char,
          confidence: alternative.confidence,
          personalSupport: alternative.personalSupport,
          personalConfidence: alternative.personalConfidence,
        })),
      })),
      halloForcedFive,
      halloHypothesisSizes: connectedTextSegmentationHypotheses(
        segmentStrokes(largeHoldoutCases[1].strokes, 'text')[0],
      ).map((entry) => entry.length),
      letters: largeHoldoutLetters,
    },
    personalizedAppearanceValue,
    weakPersonalFusion,
    germanSpecialFusion,
    noisyPersonalValue,
    noisyPersonalStats: {
      a: noisyPersonalModel.labelStats.get('latin_lower_a'),
      o: noisyPersonalModel.labelStats.get('latin_lower_o'),
    },
    personalPrototypeLabels: [...personalModel.prototypes.keys()].filter((id) => ['latin_lower_t', 'latin_lower_e', 'latin_lower_s'].includes(id)),
    wideLetterHypotheses: connectedTextSegmentationHypotheses(wideCluster).map((entry) => entry.length),
    dottedIClusterCount: segmentStrokes(dottedI, 'text').length,
    detachedExitClusterCount: segmentStrokes(detachedExitA, 'text').length,
    detachedExitValue,
    mathLineCount: groupRecognitionLines(multiLineMathStrokes).length,
    multiLineMath: recognizedLatex(multiLineMathTokens),
    integralLimitLineCount: groupRecognitionLines(integralWithLimits).length,
    integralWithLimits: recognizedLatex(integralLimitTokens),
    sumLimitLineCount: groupRecognitionLines(sumWithLimits).length,
    sumWithLimits: recognizedLatex(sumLimitTokens),
    productLimitLineCount: groupRecognitionLines(productWithLimits).length,
    productWithLimits: recognizedLatex(productLimitTokens),
    tripleIntegralLabels: tripleIntegralTokens.map((token) => token.labelId),
    tripleIntegral: recognizedLatex(tripleIntegralTokens),
    ordinaryScriptLineCount: groupRecognitionLines(ordinaryScripts).length,
    ordinaryScripts: recognizedLatex(ordinaryScriptTokens),
    ordinaryScriptTokens: ordinaryScriptTokens.filter((token) => !token.isLayout).map((token) => ({
      char: token.char,
      labelId: token.labelId,
      confidence: token.confidence,
      bbox: token.bbox,
      alternatives: token.alternatives.slice(0, 20).map((alternative) => ({
        char: alternative.char,
        labelId: alternative.labelId,
        confidence: alternative.confidence,
      })),
    })),
    standardCount: standard.length,
  }
}

run().then((result) => {
  document.body.innerHTML = `<pre id="result">${JSON.stringify(result)}</pre>`
}).catch((error) => {
  document.body.innerHTML = `<pre id="error">${String(error?.stack || error)}</pre>`
})
