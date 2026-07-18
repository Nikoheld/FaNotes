import { BASE_CATALOG } from '../../../src/data/catalog'
import {
  buildRecognitionModel,
  connectedTextSegmentationHypotheses,
  recognizeExpression,
  recognizedSentence,
  segmentStrokes,
} from '../../../src/lib/recognition'
import { createStandardRecognitionSamples } from '../../../src/lib/standardRecognition'
import type { Sample, Stroke, StrokePoint } from '../../../src/types'
import { recognizePersonalizedTextLine } from '../../src/lib/personalizedLineRecognition'

type Path = [number, number][]
const SOURCE_WIDTH = 900
const SOURCE_HEIGHT = 560
const shapes: Record<string, { main: Path; accessories?: Path[] }> = {
  t: {
    main: [[0, .7], [.22, .64], [.44, .08], [.48, .82], [.72, .72], [1, .67]],
    accessories: [[[.24, .35], [.72, .34]]],
  },
  e: { main: [[0, .68], [.22, .51], [.72, .49], [.64, .27], [.25, .25], [.1, .48], [.18, .76], [.65, .82], [1, .65]] },
  s: { main: [[0, .65], [.28, .31], [.73, .3], [.84, .45], [.25, .66], [.2, .78], [.48, .87], [.86, .75], [1, .66]] },
}

const point = (x: number, y: number, t: number): StrokePoint => ({
  x, y, t, pressure: .61, tiltX: 0, tiltY: 0, pointerType: 'pen',
})

const mapped = (path: Path, left: number, width: number, time: number, variation = 0) => (
  path.map(([x, y], index) => point(
    left + x * width,
    .28 + y * .16 + Math.sin(index * 1.41) * variation,
    time + index,
  ))
)

const isolated = (char: string, variation = 0): Stroke[] => {
  const shape = shapes[char]
  return [shape.main, ...(shape.accessories ?? [])].map((path, index) => ({
    baseWidth: 3.7,
    pressureEnabled: true,
    points: mapped(path, .38, .052, index * 100, variation),
  }))
}

const connected = (value: string, variation = 0): Stroke[] => {
  const width = .052
  const connector = .008
  const main: StrokePoint[] = []
  const accessories: Stroke[] = []
  let time = 0
  Array.from(value).forEach((char, index) => {
    const shape = shapes[char]
    const left = .12 + index * (width + connector)
    const current = mapped(shape.main, left, width, time, variation)
    if (main.length) {
      const previous = main.at(-1)!
      main.push(point((previous.x + current[0].x) / 2, (previous.y + current[0].y) / 2, ++time))
    }
    current.forEach((entry) => main.push({ ...entry, t: ++time }))
    ;(shape.accessories ?? []).forEach((path, accessory) => accessories.push({
      baseWidth: 3.7,
      pressureEnabled: true,
      points: mapped(path, left, width, 10_000 + index * 100 + accessory * 10, variation),
    }))
  })
  return [{ baseWidth: 3.7, pressureEnabled: true, points: main }, ...accessories]
}

const render = (strokes: Stroke[]) => {
  const points = strokes.flatMap((stroke) => stroke.points)
  const minX = Math.min(...points.map((entry) => entry.x * SOURCE_WIDTH)) - 7
  const maxX = Math.max(...points.map((entry) => entry.x * SOURCE_WIDTH)) + 7
  const minY = Math.min(...points.map((entry) => entry.y * SOURCE_HEIGHT)) - 7
  const maxY = Math.max(...points.map((entry) => entry.y * SOURCE_HEIGHT)) + 7
  const width = Math.max(14, maxX - minX)
  const height = Math.max(14, maxY - minY)
  const scale = Math.min(202 / width, 202 / height)
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
      index ? context.lineTo(x, y) : context.moveTo(x, y)
    })
    context.lineWidth = stroke.baseWidth * scale
    context.stroke()
  })
  return canvas.toDataURL('image/png')
}

const sample = (char: string, index: number): Sample => {
  const label = BASE_CATALOG.find((entry) => entry.char === char)!
  const strokes = isolated(char, (index - 8) * .00016)
  return {
    id: `guided-${char}-${index}`,
    labelId: label.id,
    label: label.char,
    labelName: label.name,
    latex: label.latex,
    category: label.category,
    writerId: 'Guided regression',
    sessionId: 'guided-regression',
    createdAt: new Date(Date.UTC(2026, 6, 17, 0, 0, index)).toISOString(),
    imageData: render(strokes),
    imageWidth: 256,
    imageHeight: 256,
    sourceCanvas: { width: SOURCE_WIDTH, height: SOURCE_HEIGHT, devicePixelRatio: 1 },
    bbox: [0, 0, 1, 1],
    strokes,
    strokeCount: strokes.length,
    pointCount: strokes.reduce((sum, stroke) => sum + stroke.points.length, 0),
    schemaVersion: 1,
  }
}

const run = async () => {
  const standard = await createStandardRecognitionSamples(BASE_CATALOG)
  const personal = ['t', 'e', 's'].flatMap((char) => Array.from({ length: 16 }, (_, index) => sample(char, index)))
  const model = await buildRecognitionModel([...personal, ...standard])
  const strokes = connected('test', .00023).map((stroke) => ({
    ...stroke,
    points: stroke.points.map((entry) => ({ ...entry, x: .12 + (entry.x - .12) * .52 })),
  }))
  const unguided = recognizeExpression(strokes, model, BASE_CATALOG, 'text', [], 'de')
  const guided = recognizeExpression(strokes, model, BASE_CATALOG, 'text', [], 'de', 4, 'test')
  const integrated = await recognizePersonalizedTextLine(
    strokes,
    {
      model,
      samples: personal,
      labels: BASE_CATALOG,
      layoutExamples: [],
      sampleCount: personal.length,
      classCount: 3,
      baselineSampleCount: standard.length,
      modelClassCount: new Set(model.map((entry) => entry.labelId)).size,
    },
    {
      text: 'test',
      confidence: 91,
      engine: 'trocr-bilingual',
      lines: [{
        text: 'test',
        rawText: 'test',
        confidence: 91,
        bbox: [.12, .28, .13, .16],
        characters: Array.from('test').map((char, index) => ({
          char,
          confidence: 91,
          start: index / 4,
          end: (index + 1) / 4,
        })),
      }],
    },
    'de',
    false,
    SOURCE_WIDTH,
    SOURCE_HEIGHT,
    4,
    'test',
  )
  const misleadingMathIntegrated = await recognizePersonalizedTextLine(
    strokes,
    {
      model,
      samples: personal,
      labels: BASE_CATALOG,
      layoutExamples: [],
      sampleCount: personal.length,
      classCount: 3,
      baselineSampleCount: standard.length,
      modelClassCount: new Set(model.map((entry) => entry.labelId)).size,
    },
    {
      text: '∫∫',
      confidence: 88,
      engine: 'trocr-bilingual',
      wordCount: 0,
      knownWordRatio: 0,
      lines: [{
        text: '∫∫',
        rawText: '∫∫',
        confidence: 88,
        bbox: [.12, .28, .13, .16],
        characters: Array.from('∫∫').map((char, index) => ({
          char,
          confidence: 88,
          start: index / 2,
          end: (index + 1) / 2,
        })),
      }],
    },
    'de',
    false,
    SOURCE_WIDTH,
    SOURCE_HEIGHT,
    4,
    'test',
  )
  const phraseStrokes = [
    ...strokes,
    ...strokes.map((stroke) => ({
      ...stroke,
      points: stroke.points.map((entry) => ({ ...entry, x: entry.x + .25, t: entry.t + 20_000 })),
    })),
  ]
  const phraseIntegrated = await recognizePersonalizedTextLine(
    phraseStrokes,
    {
      model,
      samples: personal,
      labels: BASE_CATALOG,
      layoutExamples: [],
      sampleCount: personal.length,
      classCount: 3,
      baselineSampleCount: standard.length,
      modelClassCount: new Set(model.map((entry) => entry.labelId)).size,
    },
    {
      text: 'test test',
      confidence: 91,
      engine: 'trocr-bilingual',
      lines: [{
        text: 'test test',
        rawText: 'test test',
        confidence: 91,
        bbox: [.12, .28, .38, .16],
        characters: Array.from('testtest').map((char, index) => ({
          char,
          confidence: 91,
          start: index / 8,
          end: (index + 1) / 8,
        })),
      }],
    },
    'de',
  )
  const multiLineStrokes = [
    ...strokes,
    ...strokes.map((stroke) => ({
      ...stroke,
      points: stroke.points.map((entry) => ({ ...entry, y: entry.y + .35, t: entry.t + 40_000 })),
    })),
  ]
  const multiLineIntegrated = await recognizePersonalizedTextLine(
    multiLineStrokes,
    {
      model,
      samples: personal,
      labels: BASE_CATALOG,
      layoutExamples: [],
      sampleCount: personal.length,
      classCount: 3,
      baselineSampleCount: standard.length,
      modelClassCount: new Set(model.map((entry) => entry.labelId)).size,
    },
    {
      text: 'test\ntest',
      confidence: 91,
      engine: 'trocr-bilingual',
      // Compatibility-provider regression: text contains the real page
      // break, but structured metadata was flattened into a single line.
      lines: [{
        text: 'test\ntest',
        rawText: 'test\ntest',
        confidence: 91,
        bbox: [.12, .28, .13, .51],
        characters: Array.from('testtest').map((char, index) => ({
          char,
          confidence: 91,
          start: index / 8,
          end: (index + 1) / 8,
        })),
      }],
    },
    'de',
  )
  const cluster = segmentStrokes(strokes, 'text')[0]
  return {
    unguided: recognizedSentence(unguided),
    guided: recognizedSentence(guided),
    guidedTokenCount: guided.length,
    guidedTokens: guided.map((token) => ({
      char: token.char,
      confidence: token.confidence,
      alternatives: token.alternatives.slice(0, 8),
    })),
    integratedText: integrated.fusion.text,
    integratedSource: integrated.fusion.source,
    integratedTokenCount: integrated.tokens.length,
    misleadingMathIntegratedText: misleadingMathIntegrated.fusion.text,
    misleadingMathIntegratedSource: misleadingMathIntegrated.fusion.source,
    misleadingMathIntegratedTokenCount: misleadingMathIntegrated.tokens.length,
    phraseIntegratedText: phraseIntegrated.fusion.text,
    phraseIntegratedTokenCount: phraseIntegrated.tokens.length,
    multiLineIntegratedText: multiLineIntegrated.fusion.text,
    multiLineIntegratedTokenCount: multiLineIntegrated.tokens.length,
    preferredHypothesisSizes: connectedTextSegmentationHypotheses(cluster, 4).map((entry) => entry.length),
  }
}

run().then((result) => {
  document.body.innerHTML = `<pre id="result">${JSON.stringify(result)}</pre>`
}).catch((error) => {
  document.body.innerHTML = `<pre id="error">${String(error?.stack || error)}</pre>`
})
