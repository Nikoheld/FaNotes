import { BASE_CATALOG } from '../../../src/data/catalog'
import {
  buildRecognitionModel,
  connectedTextSegmentationHypotheses,
  recognizeExpression,
  recognizedSentence,
  segmentStrokes,
} from '../../../src/lib/recognition'
import { createStandardRecognitionSamples } from '../../../src/lib/standardRecognition'
import type { LabelDefinition, Sample, Stroke, StrokePoint } from '../../../src/types'

const SOURCE_WIDTH = 900
const SOURCE_HEIGHT = 560
const IMAGE_SIZE = 256
const VARIANTS_PER_LABEL = 12

const clonePoint = (point: StrokePoint): StrokePoint => ({ ...point })
const cloneStroke = (stroke: Stroke): Stroke => ({
  ...stroke,
  points: stroke.points.map(clonePoint),
})

const boundsOf = (strokes: Stroke[]) => {
  const points = strokes.flatMap((stroke) => stroke.points)
  return {
    minX: Math.min(...points.map((point) => point.x)),
    minY: Math.min(...points.map((point) => point.y)),
    maxX: Math.max(...points.map((point) => point.x)),
    maxY: Math.max(...points.map((point) => point.y)),
  }
}

const transformStrokes = (
  source: Stroke[],
  variant: number,
  holdout = false,
): Stroke[] => {
  const strokes = source.map(cloneStroke)
  const bounds = boundsOf(strokes)
  const centerX = (bounds.minX + bounds.maxX) / 2
  const centerY = (bounds.minY + bounds.maxY) / 2
  const phase = variant * 1.61803398875 + (holdout ? 4.7 : 0)
  const scaleX = 1 + Math.sin(phase * 1.7) * (holdout ? 0.16 : 0.09)
  const scaleY = 1 + Math.cos(phase * 1.3) * (holdout ? 0.13 : 0.075)
  const shear = Math.sin(phase * 0.91) * (holdout ? 0.19 : 0.11)
  const angle = Math.cos(phase * 1.11) * (holdout ? 0.085 : 0.045)
  const cosine = Math.cos(angle)
  const sine = Math.sin(angle)
  const offsetX = Math.sin(phase * 0.73) * 0.012
  const offsetY = Math.cos(phase * 0.67) * 0.009
  strokes.forEach((stroke, strokeIndex) => {
    stroke.baseWidth = Math.max(2.4, stroke.baseWidth * (1 + Math.sin(phase + strokeIndex) * 0.12))
    stroke.points.forEach((point, pointIndex) => {
      const localX = (point.x - centerX) * scaleX
      const localY = (point.y - centerY) * scaleY
      const warpedX = localX + localY * shear
      const wave = Math.sin((pointIndex + 1) * 0.83 + phase + strokeIndex) * (holdout ? 0.0042 : 0.0021)
      point.x = centerX + warpedX * cosine - localY * sine + offsetX
      point.y = centerY + warpedX * sine + localY * cosine + offsetY + wave
      point.t = strokeIndex * 1000 + pointIndex
      point.pressure = 0.48 + ((pointIndex + strokeIndex + variant) % 5) * 0.07
      point.pointerType = 'pen'
    })
    if ((variant + strokeIndex) % 4 === 1) stroke.points.reverse()
  })

  // Closed loops may naturally start at a different point even for the same
  // writer. Rotate their sequence without changing the visible ink.
  strokes.forEach((stroke, strokeIndex) => {
    if (stroke.points.length < 10) return
    const first = stroke.points[0]
    const last = stroke.points.at(-1)!
    if (Math.hypot(first.x - last.x, first.y - last.y) > 0.04) return
    const shift = (variant * 3 + strokeIndex * 5 + (holdout ? 7 : 0)) % (stroke.points.length - 1)
    if (!shift) return
    const body = stroke.points.slice(0, -1)
    const rotated = [...body.slice(shift), ...body.slice(0, shift)]
    stroke.points = [...rotated, { ...rotated[0] }]
  })

  // Change pen-lift habits. Training contains occasional split strokes; the
  // holdout applies the split more aggressively to expose classifiers which
  // memorize stroke count instead of shape.
  const split: Stroke[] = []
  strokes.forEach((stroke, strokeIndex) => {
    const shouldSplit = stroke.points.length >= 10 && (
      holdout ? strokeIndex % 2 === 0 : (variant + strokeIndex) % 5 === 2
    )
    if (!shouldSplit) {
      split.push(stroke)
      return
    }
    const cut = Math.max(3, Math.min(stroke.points.length - 3, Math.round(stroke.points.length * (holdout ? 0.57 : 0.48))))
    split.push(
      { ...stroke, points: stroke.points.slice(0, cut + 1).map(clonePoint) },
      { ...stroke, points: stroke.points.slice(cut).map(clonePoint) },
    )
  })
  return split
}

const render = (strokes: Stroke[]) => {
  const points = strokes.flatMap((stroke) => stroke.points)
  const minX = Math.min(...points.map((point) => point.x * SOURCE_WIDTH)) - 9
  const maxX = Math.max(...points.map((point) => point.x * SOURCE_WIDTH)) + 9
  const minY = Math.min(...points.map((point) => point.y * SOURCE_HEIGHT)) - 9
  const maxY = Math.max(...points.map((point) => point.y * SOURCE_HEIGHT)) + 9
  const width = Math.max(18, maxX - minX)
  const height = Math.max(18, maxY - minY)
  const scale = Math.min(204 / width, 204 / height)
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
    mapped.forEach((point, index) => index ? context.lineTo(point.x, point.y) : context.moveTo(point.x, point.y))
    context.stroke()
  })
  return canvas.toDataURL('image/png')
}

const personalSample = (
  label: LabelDefinition,
  strokes: Stroke[],
  index: number,
): Sample => ({
  id: `personal-audit-${label.id}-${index}`,
  labelId: label.id,
  label: label.char,
  labelName: label.name,
  latex: label.latex,
  category: label.category,
  writerId: 'Adversarial Holdout Writer',
  sessionId: 'glyphenwerk-personal-audit',
  createdAt: new Date(Date.UTC(2026, 6, 1, 0, index)).toISOString(),
  imageData: render(strokes),
  imageWidth: IMAGE_SIZE,
  imageHeight: IMAGE_SIZE,
  sourceCanvas: { width: SOURCE_WIDTH, height: SOURCE_HEIGHT, devicePixelRatio: 1 },
  bbox: [0, 0, 1, 1],
  strokes,
  strokeCount: strokes.length,
  pointCount: strokes.reduce((sum, stroke) => sum + stroke.points.length, 0),
  schemaVersion: 1,
})

const run = async () => {
  const standard = await createStandardRecognitionSamples(BASE_CATALOG)
  const labels = BASE_CATALOG.filter((label) => (
    label.category === 'uppercase' ||
    label.category === 'lowercase' ||
    label.category === 'digits'
  ))
  const bases = labels.map((label) => {
    const candidates = standard
      .filter((sample) => sample.labelId === label.id)
      .filter((sample) => sample.pointCount >= 6 && sample.strokes.some((stroke) => stroke.points.length >= 4))
      .sort((first, second) => second.pointCount - first.pointCount)
    return { label, base: candidates[0] }
  }).filter((entry): entry is { label: LabelDefinition; base: Sample } => Boolean(entry.base))

  const personal = bases.flatMap(({ label, base }, labelIndex) => (
    Array.from({ length: VARIANTS_PER_LABEL }, (_, variant) => personalSample(
      label,
      transformStrokes(base.strokes, variant, false),
      labelIndex * VARIANTS_PER_LABEL + variant,
    ))
  ))
  const startedAt = performance.now()
  const model = await buildRecognitionModel([...personal, ...standard])
  const modelDurationMs = Math.round(performance.now() - startedAt)
  const results = bases.map(({ label, base }, index) => {
    const strokes = transformStrokes(base.strokes, 100 + index, true)
    const strokeBounds = boundsOf(strokes)
    const physicalAspect = (
      (strokeBounds.maxX - strokeBounds.minX) * SOURCE_WIDTH /
      Math.max(1, (strokeBounds.maxY - strokeBounds.minY) * SOURCE_HEIGHT)
    )
    const clusters = segmentStrokes(strokes, 'text')
    const hypothesisPartCounts = clusters.map((cluster) => (
      connectedTextSegmentationHypotheses(cluster).map((hypothesis) => hypothesis.length)
    ))
    const tokens = recognizeExpression(strokes, model, BASE_CATALOG, 'text', [], 'de')
    const hintedTokens = recognizeExpression(strokes, model, BASE_CATALOG, 'text', [], 'de', 1)
    return {
      expected: label.char,
      expectedId: label.id,
      recognized: recognizedSentence(tokens),
      recognizedWithSingleCharacterHint: recognizedSentence(hintedTokens),
      hintedConfidence: hintedTokens[0]?.confidence ?? 0,
      hintedPersonalConfidence: hintedTokens[0]?.personalConfidence ?? 0,
      hintedPersonalSupport: hintedTokens[0]?.personalSupport ?? 0,
      hintedVisualLabelId: hintedTokens[0]?.visualLabelId ?? '',
      hintedAlternatives: hintedTokens[0]?.alternatives.slice(0, 8) ?? [],
      labels: tokens.map((token) => token.labelId),
      confidence: tokens[0]?.confidence ?? 0,
      personalConfidence: tokens[0]?.personalConfidence ?? 0,
      strokeCount: strokes.length,
      physicalAspect: Math.round(physicalAspect * 1_000) / 1_000,
      clusterCount: clusters.length,
      hypothesisPartCounts,
      alternatives: tokens[0]?.alternatives.slice(0, 6).map((entry) => ({
        char: entry.char,
        labelId: entry.labelId,
        confidence: entry.confidence,
        personalConfidence: entry.personalConfidence,
      })) ?? [],
    }
  })
  const failures = results.filter((entry) => entry.recognized !== entry.expected)
  const hintedFailures = results.filter((entry) => entry.recognizedWithSingleCharacterHint !== entry.expected)
  const caseFailures = failures.filter((entry) => (
    entry.recognized.toLocaleLowerCase('de') === entry.expected.toLocaleLowerCase('de')
  ))
  return {
    labels: bases.length,
    suppliedSamples: personal.length,
    retainedSamples: model.filter((entry) => !entry.standard).length,
    prototypeClasses: model.prototypeSets.size,
    modelDurationMs,
    estimatedAccuracy: model.estimatedAccuracy,
    evaluatedSamples: model.evaluatedSamples,
    adaptiveWeights: model.weights,
    accuracy: Math.round((results.length - failures.length) / Math.max(1, results.length) * 10_000) / 100,
    hintedAccuracy: Math.round((results.length - hintedFailures.length) / Math.max(1, results.length) * 10_000) / 100,
    failures,
    hintedFailures,
    caseFailures,
  }
}

run().then((result) => {
  document.body.innerHTML = `<pre id="result">${JSON.stringify(result)}</pre>`
}).catch((error) => {
  document.body.innerHTML = `<pre id="error">${String(error?.stack || error)}</pre>`
})
