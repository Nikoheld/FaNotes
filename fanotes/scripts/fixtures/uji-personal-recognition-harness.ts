import { BASE_CATALOG } from '../../../src/data/catalog'
import {
  buildRecognitionModel,
  recognizeExpression,
  recognizedSentence,
} from '../../../src/lib/recognition'
import { createStandardRecognitionSamples } from '../../../src/lib/standardRecognition'
import type { LabelDefinition, Sample, Stroke } from '../../../src/types'

type RawStroke = [number, number][]

export type UjiRecord = {
  char: string
  writer: string
  session: 1 | 2
  strokes: RawStroke[]
}

type AuditCase = {
  expected: string
  recognized: string
  recognizedWithoutHint: string
  confidence: number
  personalConfidence: number
  personalSupport: number
  alternatives: {
    char: string
    confidence: number
    personalConfidence: number
    personalSupport: number
  }[]
}

const SOURCE_WIDTH = 900
const SOURCE_HEIGHT = 560
const IMAGE_SIZE = 256
const IMAGE_MARGIN = 24

const labelByChar = new Map(BASE_CATALOG.map((label) => [label.char, label]))

export const normalizedUjiStrokes = (record: UjiRecord): Stroke[] => {
  const points = record.strokes.flat()
  const minX = Math.min(...points.map(([x]) => x))
  const maxX = Math.max(...points.map(([x]) => x))
  const minY = Math.min(...points.map(([, y]) => y))
  const maxY = Math.max(...points.map(([, y]) => y))
  const width = Math.max(1, maxX - minX)
  const height = Math.max(1, maxY - minY)
  // UJI and UPV used different tablet-unit scales. A single isotropic scale
  // preserves the writer's true aspect ratio while removing that site offset.
  const scale = Math.min(310 / width, 300 / height)
  const centerX = (minX + maxX) / 2
  const centerY = (minY + maxY) / 2
  let time = 0
  return record.strokes.map((raw) => ({
    baseWidth: 3.7,
    pressureEnabled: false,
    points: raw
      .filter(([x, y], index) => index === 0 || x !== raw[index - 1][0] || y !== raw[index - 1][1])
      .map(([x, y]) => ({
        x: 0.5 + (x - centerX) * scale / SOURCE_WIDTH,
        y: 0.5 + (y - centerY) * scale / SOURCE_HEIGHT,
        t: time++,
        pressure: 0.62,
        tiltX: 0,
        tiltY: 0,
        pointerType: 'pen',
      })),
  })).filter((stroke) => stroke.points.length)
}

/** Recompose genuine UJI pen trajectories into a deterministic text line. */
export const createUjiWordStrokes = (
  records: UjiRecord[],
  writer: string,
  session: 1 | 2,
  value: string,
  left = 0.08,
  top = 0.18,
  glyphHeight = 0.16,
  gap = 0.009,
): Stroke[] => {
  let cursor = left
  let time = 0
  return [...value].flatMap((char) => {
    if (/\s/u.test(char)) {
      // A normal word space is deliberately several times wider than the
      // inter-letter gap, but still narrower than an exaggerated synthetic
      // separator. This exercises the same spacing decision as a real line.
      cursor += glyphHeight * 0.52
      return []
    }
    const record = records.find((entry) => (
      entry.writer === writer && entry.session === session && entry.char === char
    ))
    if (!record) return []
    const source = normalizedUjiStrokes(record)
    const points = source.flatMap((stroke) => stroke.points)
    const minX = Math.min(...points.map((point) => point.x))
    const minY = Math.min(...points.map((point) => point.y))
    const maxX = Math.max(...points.map((point) => point.x))
    const maxY = Math.max(...points.map((point) => point.y))
    const scale = glyphHeight / Math.max(0.001, maxY - minY)
    const width = Math.max(0.012, (maxX - minX) * scale)
    const positioned = source.map((stroke) => ({
      ...stroke,
      points: stroke.points.map((point) => ({
        ...point,
        x: cursor + (point.x - minX) * scale,
        y: top + (point.y - minY) * scale,
        t: time++,
      })),
    }))
    cursor += width + gap
    return positioned
  })
}

const render = (strokes: Stroke[]) => {
  const points = strokes.flatMap((stroke) => stroke.points)
  const minX = Math.min(...points.map((point) => point.x * SOURCE_WIDTH)) - 8
  const maxX = Math.max(...points.map((point) => point.x * SOURCE_WIDTH)) + 8
  const minY = Math.min(...points.map((point) => point.y * SOURCE_HEIGHT)) - 8
  const maxY = Math.max(...points.map((point) => point.y * SOURCE_HEIGHT)) + 8
  const width = Math.max(12, maxX - minX)
  const height = Math.max(12, maxY - minY)
  const scale = Math.min(
    (IMAGE_SIZE - IMAGE_MARGIN * 2) / width,
    (IMAGE_SIZE - IMAGE_MARGIN * 2) / height,
  )
  const offsetX = (IMAGE_SIZE - width * scale) / 2
  const offsetY = (IMAGE_SIZE - height * scale) / 2
  const canvas = document.createElement('canvas')
  canvas.width = IMAGE_SIZE
  canvas.height = IMAGE_SIZE
  const context = canvas.getContext('2d')!
  context.fillStyle = '#fff'
  context.fillRect(0, 0, IMAGE_SIZE, IMAGE_SIZE)
  context.strokeStyle = '#142b2a'
  context.fillStyle = '#142b2a'
  context.lineCap = 'round'
  context.lineJoin = 'round'
  strokes.forEach((stroke) => {
    const mapped = stroke.points.map((point) => ({
      x: offsetX + (point.x * SOURCE_WIDTH - minX) * scale,
      y: offsetY + (point.y * SOURCE_HEIGHT - minY) * scale,
    }))
    context.lineWidth = Math.max(1, stroke.baseWidth * scale)
    if (mapped.length === 1) {
      context.beginPath()
      context.arc(mapped[0].x, mapped[0].y, context.lineWidth / 2, 0, Math.PI * 2)
      context.fill()
      return
    }
    context.beginPath()
    mapped.forEach((point, index) => index
      ? context.lineTo(point.x, point.y)
      : context.moveTo(point.x, point.y))
    context.stroke()
  })
  return canvas.toDataURL('image/png')
}

export const ujiPersonalSample = (record: UjiRecord, index: number): Sample => {
  const label = labelByChar.get(record.char)!
  const strokes = normalizedUjiStrokes(record)
  const points = strokes.flatMap((stroke) => stroke.points)
  const minX = Math.min(...points.map((point) => point.x))
  const minY = Math.min(...points.map((point) => point.y))
  const maxX = Math.max(...points.map((point) => point.x))
  const maxY = Math.max(...points.map((point) => point.y))
  return {
    id: `uji-${record.writer}-${record.session}-${label.id}-${index}`,
    labelId: label.id,
    label: label.char,
    labelName: label.name,
    latex: label.latex,
    category: label.category,
    writerId: record.writer,
    sessionId: `${record.writer}-${record.session}`,
    createdAt: new Date(Date.UTC(2026, 0, record.session, 0, 0, index % 60)).toISOString(),
    imageData: render(strokes),
    imageWidth: IMAGE_SIZE,
    imageHeight: IMAGE_SIZE,
    sourceCanvas: { width: SOURCE_WIDTH, height: SOURCE_HEIGHT, devicePixelRatio: 1 },
    bbox: [minX, minY, maxX - minX, maxY - minY],
    strokes,
    strokeCount: strokes.length,
    pointCount: points.length,
    schemaVersion: 1,
  }
}

const summarize = (cases: AuditCase[]) => {
  const failures = cases.filter((entry) => entry.recognized !== entry.expected)
  const rawFailures = cases.filter((entry) => entry.recognizedWithoutHint !== entry.expected)
  const caseNormalizedFailures = cases.filter((entry) => (
    entry.recognized.toLocaleLowerCase('en') !== entry.expected.toLocaleLowerCase('en')
  ))
  const rankedCandidates = (entry: AuditCase) => [...new Set([
    entry.recognized,
    ...entry.alternatives.map((candidate) => candidate.char),
  ].filter(Boolean))]
  const topThreeFailures = cases.filter((entry) => !rankedCandidates(entry).slice(0, 3).includes(entry.expected))
  const topEightFailures = cases.filter((entry) => !rankedCandidates(entry).slice(0, 8).includes(entry.expected))
  const confusions = new Map<string, number>()
  failures.forEach((entry) => {
    const key = `${entry.expected}→${entry.recognized || '∅'}`
    confusions.set(key, (confusions.get(key) ?? 0) + 1)
  })
  return {
    samples: cases.length,
    accuracy: Math.round((cases.length - failures.length) / Math.max(1, cases.length) * 10_000) / 100,
    unhintedAccuracy: Math.round((cases.length - rawFailures.length) / Math.max(1, cases.length) * 10_000) / 100,
    caseNormalizedAccuracy: Math.round((cases.length - caseNormalizedFailures.length) / Math.max(1, cases.length) * 10_000) / 100,
    top3Accuracy: Math.round((cases.length - topThreeFailures.length) / Math.max(1, cases.length) * 10_000) / 100,
    top8Accuracy: Math.round((cases.length - topEightFailures.length) / Math.max(1, cases.length) * 10_000) / 100,
    exactErrors: failures.length,
    caseErrors: failures.length - caseNormalizedFailures.length,
    top3Errors: topThreeFailures.length,
    top8Errors: topEightFailures.length,
    topConfusions: [...confusions.entries()]
      .sort((first, second) => second[1] - first[1] || first[0].localeCompare(second[0]))
      .slice(0, 20),
    failures: failures.slice(0, 30),
  }
}

const runCases = (
  records: UjiRecord[],
  model: Awaited<ReturnType<typeof buildRecognitionModel>>,
): AuditCase[] => records.map((record) => {
  const strokes = normalizedUjiStrokes(record)
  const hinted = recognizeExpression(strokes, model, BASE_CATALOG, 'text', [], 'en', 1)
  const unhinted = recognizeExpression(strokes, model, BASE_CATALOG, 'text', [], 'en')
  return {
    expected: record.char,
    recognized: recognizedSentence(hinted),
    recognizedWithoutHint: recognizedSentence(unhinted),
    confidence: hinted[0]?.confidence ?? 0,
    personalConfidence: hinted[0]?.personalConfidence ?? 0,
    personalSupport: hinted[0]?.personalSupport ?? 0,
    alternatives: hinted[0]?.alternatives.slice(0, 8).map((entry) => ({
      char: entry.char,
      confidence: entry.confidence,
      personalConfidence: entry.personalConfidence ?? 0,
      personalSupport: entry.personalSupport ?? 0,
    })) ?? [],
  }
})

const supported = (record: UjiRecord) => /^[A-Za-z0-9]$/u.test(record.char) && labelByChar.has(record.char)

export const runUjiPersonalRecognitionAudit = async (records: UjiRecord[]) => {
  const usable = records.filter(supported)
  const writers = [...new Set(usable.map((entry) => entry.writer))].sort()
  const standard = await createStandardRecognitionSamples(BASE_CATALOG)

  const personalWriter = writers.find((writer) => writer === 'trn_UJI_W01') ?? writers[0]
  const personalTrainingRecords = usable.filter((entry) => entry.writer === personalWriter && entry.session === 1)
  const personalHoldout = usable.filter((entry) => entry.writer === personalWriter && entry.session === 2)
  const personalSamples = personalTrainingRecords.map(ujiPersonalSample)
  const personalStartedAt = performance.now()
  const personalModel = await buildRecognitionModel([...personalSamples, ...standard])
  const personalBuildMs = Math.round(performance.now() - personalStartedAt)
  const personalCases = runCases(personalHoldout, personalModel)

  const trainingWriters = writers.filter((writer) => writer.startsWith('trn_')).slice(0, 8)
  const writerIndependentCandidates = writers.filter((writer) => !trainingWriters.includes(writer))
  const holdoutWriter = writerIndependentCandidates.find((writer) => writer.startsWith('tst_'))
    ?? writerIndependentCandidates[0]
  const largeTrainingRecords = usable.filter((entry) => trainingWriters.includes(entry.writer))
  const largeHoldout = usable.filter((entry) => entry.writer === holdoutWriter)
  const largeSamples = largeTrainingRecords.map(ujiPersonalSample)
  const largeStartedAt = performance.now()
  const largeModel = await buildRecognitionModel([...largeSamples, ...standard])
  const largeBuildMs = Math.round(performance.now() - largeStartedAt)
  const largeCases = runCases(largeHoldout, largeModel)

  return {
    datasetSamples: usable.length,
    datasetWriters: writers.length,
    personal: {
      writer: personalWriter,
      trainingSamples: personalSamples.length,
      holdoutSamples: personalHoldout.length,
      retainedSamples: personalModel.filter((entry) => !entry.standard).length,
      buildMs: personalBuildMs,
      estimatedAccuracy: personalModel.estimatedAccuracy,
      evaluatedSamples: personalModel.evaluatedSamples,
      ...summarize(personalCases),
    },
    writerIndependent: {
      trainingWriters,
      holdoutWriter,
      trainingSamples: largeSamples.length,
      holdoutSamples: largeHoldout.length,
      retainedSamples: largeModel.filter((entry) => !entry.standard).length,
      buildMs: largeBuildMs,
      estimatedAccuracy: largeModel.estimatedAccuracy,
      evaluatedSamples: largeModel.evaluatedSamples,
      ...summarize(largeCases),
    },
  }
}
