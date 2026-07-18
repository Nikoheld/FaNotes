import { loadBrowserHandwritingRecognitionResources } from '../../src/lib/handwritingRecognitionResources'
import {
  applyNeuralWordContext,
  groupNeuralTextLines,
  preferNeuralContextCandidateForTests,
  recognizeNeuralText,
} from '../../src/lib/neuralTextRecognition'
import type { Stroke, StrokePoint } from '../../../src/types'
import iamOnlineFixture from './iam-online-a01-001z-01.json'
import { loadBrowserSpellingResources, loadBrowserSpellingWordCandidates } from '../../src/lib/spellingResources'

const SOURCE_WIDTH = 900
const SOURCE_HEIGHT = 560

type LocalPath = [number, number][]
type LetterShape = { main: LocalPath; accessories?: LocalPath[] }

const shapes: Record<string, LetterShape> = {
  a: { main: [[0, .68], [.14, .51], [.42, .3], [.7, .35], [.76, .56], [.59, .78], [.28, .76], [.18, .56], [.4, .34], [.7, .35], [.69, .77], [1, .66]] },
  c: { main: [[0, .67], [.2, .46], [.45, .3], [.72, .32], [.84, .43], [.62, .34], [.31, .43], [.22, .65], [.4, .8], [.72, .78], [1, .66]] },
  t: { main: [[0, .7], [.22, .64], [.44, .08], [.48, .82], [.72, .72], [1, .67]], accessories: [[[.24, .35], [.72, .34]]] },
  e: { main: [[0, .68], [.22, .51], [.72, .49], [.64, .27], [.25, .25], [.1, .48], [.18, .76], [.65, .82], [1, .65]] },
  s: { main: [[0, .65], [.28, .31], [.73, .3], [.84, .45], [.25, .66], [.2, .78], [.48, .87], [.86, .75], [1, .66]] },
  h: { main: [[0, .68], [.17, .62], [.34, .1], [.43, .05], [.48, .25], [.42, .78], [.47, .48], [.64, .34], [.8, .44], [.78, .76], [1, .66]] },
  l: { main: [[0, .68], [.2, .6], [.38, .12], [.54, .06], [.6, .24], [.48, .68], [.57, .8], [.78, .76], [1, .66]] },
  m: { main: [[0, .68], [.18, .61], [.22, .38], [.24, .76], [.29, .48], [.43, .35], [.57, .45], [.55, .76], [.61, .46], [.75, .35], [.88, .45], [.87, .76], [1, .66]] },
  n: { main: [[0, .68], [.2, .61], [.24, .38], [.25, .76], [.31, .49], [.53, .34], [.72, .45], [.7, .76], [1, .66]] },
  o: { main: [[0, .68], [.18, .5], [.42, .31], [.7, .36], [.78, .57], [.6, .78], [.33, .77], [.2, .57], [.42, .34], [.72, .37], [1, .66]] },
  p: { main: [[0, .68], [.2, .61], [.27, .38], [.26, .98], [.25, .44], [.48, .31], [.72, .39], [.76, .61], [.57, .76], [.29, .66], [1, .66]] },
  r: { main: [[0, .68], [.2, .61], [.27, .39], [.29, .75], [.34, .48], [.51, .34], [.7, .45], [.82, .55], [1, .66]] },
  u: { main: [[0, .52], [.18, .43], [.18, .71], [.31, .8], [.52, .72], [.66, .42], [.65, .76], [1, .66]] },
}

const point = (x: number, y: number, t: number): StrokePoint => ({
  x, y, t, pressure: .62, tiltX: 0, tiltY: 0, pointerType: 'pen',
})

const connectedWord = (
  value: string,
  left: number,
  top: number,
  width = .052,
  height = .16,
  variation = 0,
): Stroke[] => {
  const connector = .008
  const main: StrokePoint[] = []
  const accessories: Stroke[] = []
  let time = 0
  ;[...value].forEach((character, characterIndex) => {
    const shape = shapes[character]
    const letterLeft = left + characterIndex * (width + connector)
    const map = (path: LocalPath, offset: number) => path.map(([x, y], pointIndex) => point(
      letterLeft + x * width,
      top + y * height + Math.sin((pointIndex + 1) * 1.71 + characterIndex) * variation,
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

const sentence = (first: string, second: string, top = .16) => [
  ...connectedWord(first, .08, top, .043, .13, .0015),
  ...connectedWord(second, .08 + first.length * .051 + .075, top, .043, .13, .0011),
]

Object.assign(window, {
  fanotes: {
    platform: 'web',
    loadHandwritingRecognitionResources: loadBrowserHandwritingRecognitionResources,
    loadSpellingResources: loadBrowserSpellingResources,
    loadSpellingWordCandidates: loadBrowserSpellingWordCandidates,
  },
})

const run = async () => {
  const cases = [
    { expected: 'test', strokes: connectedWord('test', .1, .18, .052, .16, .0012), language: 'de' as const },
    { expected: 'hallo', strokes: connectedWord('hallo', .1, .18, .052, .16, .0015), language: 'de' as const },
    { expected: 'lernen', strokes: connectedWord('lernen', .1, .18, .052, .16, .0018), language: 'de' as const },
    { expected: 'mathe', strokes: connectedWord('mathe', .1, .18, .052, .16, .0013), language: 'de' as const },
    { expected: 'computer', strokes: connectedWord('computer', .08, .18, .046, .15, .001), language: 'en' as const },
    { expected: 'hallo test', strokes: sentence('hallo', 'test'), language: 'de' as const },
    { expected: 'computer test', strokes: sentence('computer', 'test'), language: 'en' as const },
  ]
  const words = []
  for (const item of cases) {
    const startedAt = performance.now()
    const result = await recognizeNeuralText(item.strokes, item.language, SOURCE_WIDTH, SOURCE_HEIGHT)
    words.push({
      expected: item.expected,
      recognized: result.text.toLocaleLowerCase(item.language),
      raw: result.lines.map((line) => line.rawText).join('\n').toLocaleLowerCase(item.language),
      confidence: result.confidence,
      lines: result.lines.length,
      engine: result.engine,
      durationMs: Math.round(performance.now() - startedAt),
    })
  }
  const twoLines = [
    ...sentence('hallo', 'test', .12),
    ...sentence('lernen', 'macht', .48),
  ]
  const multiline = await recognizeNeuralText(twoLines, 'de', SOURCE_WIDTH, SOURCE_HEIGHT)
  const iamOnlineStrokes = (baseWidth: number): Stroke[] => iamOnlineFixture.strokes.map((points) => ({
    baseWidth,
    pressureEnabled: true,
    points: points.map(([x, y, t]) => ({
      x,
      y,
      t,
      pressure: .62,
      tiltX: 0,
      tiltY: 0,
      pointerType: 'pen' as const,
    })),
  }))
  const iamStartedAt = performance.now()
  const iamOnline = await recognizeNeuralText(
    iamOnlineStrokes(3.7),
    'en',
    iamOnlineFixture.sourceWidth,
    iamOnlineFixture.sourceHeight,
  )
  return {
    words,
    multiline: multiline.text.toLocaleLowerCase('de'),
    multilineConfidence: multiline.confidence,
    groupedLines: groupNeuralTextLines(twoLines, SOURCE_WIDTH, SOURCE_HEIGHT).length,
    iamOnline: {
      expected: iamOnlineFixture.truth,
      recognized: iamOnline.text,
      rawText: iamOnline.lines[0]?.rawText,
      beamText: iamOnline.lines[0]?.beamText,
      greedyText: iamOnline.lines[0]?.greedyText,
      confidence: iamOnline.confidence,
      engine: iamOnline.engine,
      trocrFailures: iamOnline.trocrFailures,
      durationMs: Math.round(performance.now() - iamStartedAt),
    },
    preservedUnknownWords: applyNeuralWordContext('FaNotes Niko Fabio Livia Aylin OpenCode', 'de'),
    repairedWords: [
      applyNeuralWordContext('Tost', 'de'),
      applyNeuralWordContext('tst', 'de'),
      applyNeuralWordContext('lernn', 'de'),
    ],
    ensembleGuards: {
      preservesUnknownName: !preferNeuralContextCandidateForTests('Fabio', 84, 'radio', 86, 'de', true),
      preservesMixedCaseTerm: !preferNeuralContextCandidateForTests('OpenCode', 82, 'open code', 86, 'en', true),
      acceptsClearFallback: preferNeuralContextCandidateForTests('xqzz', 54, 'test', 86, 'de'),
    },
  }
}

run().then((result) => {
  document.body.innerHTML = `<pre id="result">${JSON.stringify(result)}</pre>`
}).catch((error) => {
  document.body.innerHTML = `<pre id="error">${String(error?.stack || error)}</pre>`
})
