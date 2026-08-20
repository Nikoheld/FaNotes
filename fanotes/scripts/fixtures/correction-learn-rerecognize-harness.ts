import {
  learnFromRecognitionCorrection,
  loadRecognitionResources,
} from '../../src/lib/handwritingDb'
import { recognizePersonalizedTextLine } from '../../src/lib/personalizedLineRecognition'
import type { NeuralTextRecognitionResult } from '../../src/lib/neuralTextRecognition'
import type { Stroke, StrokePoint } from '../../../src/types'

type LocalPath = [number, number][]
type LetterShape = { main: LocalPath; accessories?: LocalPath[] }

const shapes: Record<string, LetterShape> = {
  e: { main: [[0, .68], [.22, .51], [.72, .49], [.64, .27], [.25, .25], [.1, .48], [.18, .76], [.65, .82], [1, .65]] },
  h: { main: [[0, .68], [.17, .62], [.34, .1], [.43, .05], [.48, .25], [.42, .78], [.47, .48], [.64, .34], [.8, .44], [.78, .76], [1, .66]] },
  m: { main: [[0, .68], [.18, .61], [.22, .38], [.24, .76], [.29, .48], [.43, .35], [.57, .45], [.55, .76], [.61, .46], [.75, .35], [.88, .45], [.87, .76], [1, .66]] },
  t: { main: [[0, .7], [.22, .64], [.44, .08], [.48, .82], [.72, .72], [1, .67]], accessories: [[[.24, .35], [.72, .34]]] },
  u: { main: [[0, .52], [.18, .43], [.18, .71], [.31, .8], [.52, .72], [.66, .42], [.65, .76], [1, .66]] },
}

const point = (x: number, y: number, t: number): StrokePoint => ({
  x, y, t, pressure: .62, tiltX: 0, tiltY: 0, pointerType: 'pen',
})

const connectedWord = (value: string, left: number, top: number): Stroke[] => {
  const width = 0.052
  const height = 0.16
  const connector = 0.008
  const main: StrokePoint[] = []
  const accessories: Stroke[] = []
  let time = 0
  ;[...value].forEach((character, characterIndex) => {
    const shape = shapes[character]
    const letterLeft = left + characterIndex * (width + connector)
    const map = (path: LocalPath, offset: number) => path.map(([x, y], pointIndex) => point(
      letterLeft + x * width,
      top + y * height,
      offset + pointIndex,
    ))
    const current = map(shape.main, time)
    if (main.length) {
      const previous = main.at(-1)!
      main.push(point((previous.x + current[0].x) / 2, (previous.y + current[0].y) / 2, ++time))
    }
    current.forEach((entry) => main.push({ ...entry, t: ++time }))
    ;(shape.accessories ?? []).forEach((path, accessoryIndex) => accessories.push({
      baseWidth: 3.7,
      pressureEnabled: true,
      points: map(path, 10_000 + characterIndex * 100 + accessoryIndex * 10),
    }))
  })
  return [{ baseWidth: 3.7, pressureEnabled: true, points: main }, ...accessories]
}

const neuralMisread = (text: string, confidence: number): NeuralTextRecognitionResult => {
  const visible = Array.from(text).filter((character) => !/\s/u.test(character))
  return {
    text,
    confidence,
    engine: 'pylaia-iam',
    wordCount: 1,
    knownWordRatio: 1,
    lines: [{
      text,
      rawText: text,
      confidence,
      bbox: [0.1, 0.18, 0.4, 0.16],
      characters: visible.map((char, index) => ({
        char,
        confidence,
        start: index / visible.length,
        end: (index + 1) / visible.length,
      })),
    }],
  }
}

const run = async () => {
  const strokes = connectedWord('meute', 0.1, 0.18)
  const correction = 'meute'
  const wrongNeural = neuralMisread('heute', 88)
  const resources = await loadRecognitionResources()
  const before = await recognizePersonalizedTextLine(strokes, resources, wrongNeural, 'de')
  const beforeText = before.fusion.text.trim().toLocaleLowerCase('de-CH')
  const learning = await learnFromRecognitionCorrection(
    before.tokens,
    correction,
    'text',
    resources.labels,
    resources.layoutExamples,
  )
  const refreshed = await loadRecognitionResources(true)
  const after = await recognizePersonalizedTextLine(strokes, refreshed, wrongNeural, 'de')
  const afterText = after.fusion.text.trim().toLocaleLowerCase('de-CH')
  return {
    beforeText,
    afterText,
    correction,
    learnedSamples: learning.learnedSamples,
    reason: learning.reason ?? null,
    beforeSource: before.fusion.source,
    afterSource: after.fusion.source,
    afterPersonalized: after.fusion.personalizedCharacters,
    sampleCount: refreshed.sampleCount,
  }
}

void run().then((result) => {
  const node = document.createElement('pre')
  node.id = 'result'
  node.textContent = JSON.stringify(result)
  document.body.append(node)
}).catch((error) => {
  const node = document.createElement('pre')
  node.id = 'error'
  node.textContent = error instanceof Error ? error.stack ?? error.message : String(error)
  document.body.append(node)
})
