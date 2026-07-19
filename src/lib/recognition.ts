import type { LabelDefinition, Sample, Stroke } from '../types'
import {
  GERMAN_COMMON_BIGRAMS,
  GERMAN_COMMON_TRIGRAMS,
  GERMAN_COMMON_WORDS,
} from '../data/germanLanguage'
import {
  ENGLISH_COMMON_BIGRAMS,
  ENGLISH_COMMON_TRIGRAMS,
  ENGLISH_COMMON_WORDS,
} from '../data/englishLanguage'
import { isStandardRecognitionSample } from './standardRecognition'
import { normalizeGermanSharpS } from './orthography'

const SOURCE_WIDTH = 900
const SOURCE_HEIGHT = 560
const OUTPUT_SIZE = 256
const OUTPUT_MARGIN = 26
const FEATURE_SIZE = 24
const ANALYSIS_SIZE = 96
const HOG_CELLS = 3
const HOG_BINS = 6
const DIRECTION_BINS = 8
const TRAJECTORY_POINTS = 24
const MAX_EXAMPLES_PER_LABEL = 96
const MAX_FEATURE_EXAMPLES_PER_LABEL = 1_024
const MAX_CLASSIFIER_EXAMPLES_PER_LABEL = 48
// Three deliberately spread generic styles are enough to measure an
// independent baseline beside a trained class without re-running the full
// generic catalogue for every segment of a connected word.
const MAX_BASE_CLASSIFIER_EXAMPLES_PER_LABEL = 3
const MAX_CONTEXT_EXAMPLES_PER_LABEL = 16
const MAX_TEXT_SEGMENTATION_HYPOTHESES = 18
const PERSONAL_SAMPLE_DISTANCE_BONUS = 0.058
const PERSONAL_PROTOTYPE_WEIGHT = 0.92

type FeatureVector = {
  raster: Float32Array
  projectionX: Float32Array
  projectionY: Float32Array
  hog: Float32Array
  shape: Float32Array
  holes: number
}

type StrokeGeometry = {
  directions: Float32Array
  normalizedLength: number
  closedness: number
  cornerness: number
  trajectory: Float32Array[]
}

type FeatureWeights = {
  raster: number
  hog: number
  projections: number
  shape: number
  directions: number
  geometry: number
  trajectory: number
  holes: number
  strokes: number
}

const DEFAULT_WEIGHTS: FeatureWeights = {
  raster: 0.34,
  hog: 0.13,
  projections: 0.07,
  shape: 0.07,
  directions: 0.07,
  geometry: 0.06,
  trajectory: 0.18,
  holes: 0.04,
  strokes: 0.04,
}

// Font-derived reference glyphs have no truthful pen order. Their classifier
// therefore relies on the normalized visual form only. Personal GlyphenWerk
// samples keep the richer direction, pressure-independent geometry and stroke
// channels above.
const STANDARD_WEIGHTS: FeatureWeights = {
  raster: 0.5,
  hog: 0.22,
  projections: 0.11,
  shape: 0.1,
  directions: 0,
  geometry: 0,
  trajectory: 0,
  holes: 0.07,
  strokes: 0,
}

export type RecognitionModelEntry = FeatureVector & {
  sampleId: string
  sessionId: string
  labelId: string
  strokeCount: number
  /** Physical width/height before the glyph crop is normalized. */
  physicalAspect: number
  geometry: StrokeGeometry
  variants: FeatureVector[]
  standard: boolean
  trust: number
  createdAt: number
}

export type RecognitionLabelStats = {
  personalCount: number
  trustedCount: number
  radius: number
  reliability: number
  /** Robust personal width/height prior in logarithmic space. */
  aspectMedian: number
  aspectSpread: number
}

type RecognitionAspectStats = {
  median: number
  spread: number
  personal: boolean
}

export type RecognitionModel = RecognitionModelEntry[] & {
  weights: FeatureWeights
  classifierEntries: RecognitionModelEntry[]
  prototypes: Map<string, RecognitionModelEntry>
  prototypeSets: Map<string, RecognitionModelEntry[]>
  labelStats: Map<string, RecognitionLabelStats>
  aspectStats: Map<string, RecognitionAspectStats>
  estimatedAccuracy: number | null
  evaluatedSamples: number
}

export type RecognitionAlternative = {
  labelId: string
  char: string
  name: string
  confidence: number
  /** Independent confidence of the generic, unpersonalized base model. */
  baseConfidence?: number
  personalSupport?: number
  personalConfidence?: number
}

export type RecognitionMode = 'math' | 'text'
export type RecognitionLanguage = 'de' | 'en'

export type MathRelationRole = 'upper_limit' | 'lower_limit' | 'superscript' | 'subscript'

export type MathLayoutExample = {
  id: string
  anchorLabelId: string
  childLabelId: string
  role: MathRelationRole
  relativeCenterX: number
  relativeCenterY: number
  relativeWidth: number
  relativeHeight: number
  createdAt: string
}

export type MathLayoutAssignment = {
  tokenId: string
  anchorId: string
  role: MathRelationRole
}

export type RecognitionToken = {
  id: string
  strokes: Stroke[]
  imageData: string
  bbox: [number, number, number, number]
  labelId: string
  char: string
  name: string
  latex: string
  confidence: number
  alternatives: RecognitionAlternative[]
  /** Visual decision before the local language model considers the word. */
  visualLabelId?: string
  visualConfidence?: number
  /** Independent evidence from the unpersonalized base recognizer. */
  baseConfidence?: number
  /** Direct evidence from this writer's trusted GlyphenWerk examples. */
  personalSupport?: number
  personalConfidence?: number
  /** Evidence left by the language model for safe, local self-training. */
  context?: {
    word: string
    knownWord: boolean
    changed: boolean
    scoreMargin: number
    autoLearn: boolean
  }
  spaceBefore?: boolean
  lineBreakBefore?: boolean
  isLayout?: boolean
  layout?: {
    type: 'fraction'
    groupId: string
    role: 'bar' | 'numerator' | 'denominator'
  }
}

type StrokeCluster = {
  strokes: Stroke[]
  minX: number
  minY: number
  maxX: number
  maxY: number
  detachedTextConnectorRanges?: [number, number][]
  detachedTextConnectorStrokes?: Stroke[]
  fraction?: RecognitionToken['layout']
}

const featureCache = new Map<string, FeatureVector[]>()

export const createEmptyRecognitionModel = (): RecognitionModel => {
  const model = [] as unknown as RecognitionModel
  model.weights = { ...DEFAULT_WEIGHTS }
  model.classifierEntries = []
  model.prototypes = new Map()
  model.prototypeSets = new Map()
  model.labelStats = new Map()
  model.aspectStats = new Map()
  model.estimatedAccuracy = null
  model.evaluatedSamples = 0
  return model
}

const clamp = (value: number, min = 0, max = 1) => Math.max(min, Math.min(max, value))

export type PersonalBaseEvidenceCalibration = {
  authority: number
  scoreAdjustment: number
  consensus: boolean
  conflict: boolean
  decisive: boolean
}

/**
 * Calibrates personal evidence without treating either source as universally
 * correct. Agreement between the independent base model and GlyphenWerk is
 * stronger than either source alone. A single conflicting example remains
 * deliberately conservative, while repeated close personal samples can
 * still teach a genuinely different writing style.
 */
export const calibratePersonalBaseEvidence = (
  evidence: Pick<RecognitionAlternative, 'confidence' | 'baseConfidence' | 'personalSupport' | 'personalConfidence'>,
  strongestBaseConfidence: number,
): PersonalBaseEvidenceCalibration => {
  const support = Math.max(0, evidence.personalSupport ?? 0)
  if (!support) return {
    authority: 0,
    scoreAdjustment: 0,
    consensus: false,
    conflict: false,
    decisive: false,
  }
  const fit = clamp((evidence.personalConfidence ?? 0) / 100)
  const visual = clamp(evidence.confidence / 100)
  const base = clamp((evidence.baseConfidence ?? 0) / 100)
  const basePeak = clamp(strongestBaseConfidence / 100)
  const baseGap = Math.max(0, basePeak - base)
  const consensus = base >= 0.42 && baseGap <= 0.09
  const conflict = basePeak >= 0.68 && baseGap >= 0.24
  const supportStrength = clamp(Math.log2(support + 1) / 4)
  const authority = clamp(
    fit * 0.46 +
    supportStrength * 0.34 +
    visual * 0.2 +
    (consensus ? 0.12 : 0) -
    (conflict ? (support < 3 ? 0.2 : 0.06) : 0),
  )
  const decisive = (
    (support >= 8 && fit >= 0.34) ||
    (support >= 3 && fit >= 0.54) ||
    (support >= 1 && fit >= 0.82 && visual >= 0.72)
  )
  const scoreAdjustment = consensus
    ? 0.08 + authority * 0.1
    : decisive
      ? 0.02 + authority * 0.08
      : authority * 0.04 - Math.min(0.2, baseGap * (support < 3 ? 0.34 : 0.12))
  return { authority, scoreAdjustment, consensus, conflict, decisive }
}

const selectedTokenPersonalCalibration = (token: RecognitionToken) => {
  const strongestBaseConfidence = [
    token.baseConfidence ?? 0,
    ...token.alternatives.map((alternative) => alternative.baseConfidence ?? 0),
  ].reduce((peak, confidence) => Math.max(peak, confidence), 0)
  return calibratePersonalBaseEvidence({
    confidence: token.confidence,
    baseConfidence: token.baseConfidence,
    personalSupport: token.personalSupport,
    personalConfidence: token.personalConfidence,
  }, strongestBaseConfidence)
}

const hasReliableSelectedPersonalEvidence = (token: RecognitionToken) => {
  const calibration = selectedTokenPersonalCalibration(token)
  return !calibration.conflict || (
    (token.personalSupport ?? 0) >= 3 && calibration.decisive
  )
}

const relationVector = (
  anchor: [number, number, number, number],
  child: [number, number, number, number],
) => {
  const [anchorX, anchorY, anchorWidth, anchorHeight] = anchor
  const [childX, childY, childWidth, childHeight] = child
  return {
    relativeCenterX: (childX + childWidth / 2 - (anchorX + anchorWidth / 2)) / Math.max(0.01, anchorWidth),
    relativeCenterY: (childY + childHeight / 2 - (anchorY + anchorHeight / 2)) / Math.max(0.01, anchorHeight),
    relativeWidth: childWidth / Math.max(0.01, anchorWidth),
    relativeHeight: childHeight / Math.max(0.01, anchorHeight),
  }
}

const learnedRelationDistance = (
  anchorLabelId: string | undefined,
  childLabelId: string | undefined,
  anchor: [number, number, number, number],
  child: [number, number, number, number],
  role: MathRelationRole,
  examples: MathLayoutExample[],
) => {
  if (!anchorLabelId) return Number.POSITIVE_INFINITY
  const vector = relationVector(anchor, child)
  const matches = examples.filter((example) => (
    example.anchorLabelId === anchorLabelId &&
    example.role === role &&
    (!childLabelId || example.childLabelId === childLabelId || example.childLabelId === '*')
  ))
  const fallback = matches.length ? matches : examples.filter((example) => (
    example.anchorLabelId === anchorLabelId && example.role === role
  ))
  return fallback.reduce((best, example) => {
    const distance = Math.hypot(
      (vector.relativeCenterX - example.relativeCenterX) * 0.55,
      (vector.relativeCenterY - example.relativeCenterY) * 1.25,
      (vector.relativeWidth - example.relativeWidth) * 0.18,
      (vector.relativeHeight - example.relativeHeight) * 0.35,
    )
    return Math.min(best, distance)
  }, Number.POSITIVE_INFINITY)
}

const pressureWidth = (stroke: Stroke, pressure: number) => {
  if (!stroke.pressureEnabled) return stroke.baseWidth
  return stroke.baseWidth * (0.45 + Math.max(0.08, pressure) * 1.05)
}

const cloneStrokes = (strokes: Stroke[]): Stroke[] =>
  strokes.map((stroke) => ({
    ...stroke,
    points: stroke.points.map((point) => ({ ...point })),
  }))

const normalizeVector = (vector: Float32Array) => {
  const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0))
  if (magnitude > 0.000001) {
    for (let index = 0; index < vector.length; index += 1) vector[index] /= magnitude
  }
  return vector
}

const computeHog = (raster: Float32Array) => {
  const hog = new Float32Array(HOG_CELLS * HOG_CELLS * HOG_BINS)
  for (let y = 1; y < FEATURE_SIZE - 1; y += 1) {
    for (let x = 1; x < FEATURE_SIZE - 1; x += 1) {
      const gradientX = raster[y * FEATURE_SIZE + x + 1] - raster[y * FEATURE_SIZE + x - 1]
      const gradientY = raster[(y + 1) * FEATURE_SIZE + x] - raster[(y - 1) * FEATURE_SIZE + x]
      const magnitude = Math.hypot(gradientX, gradientY)
      if (magnitude < 0.015) continue
      const angle = (Math.atan2(gradientY, gradientX) + Math.PI) % Math.PI
      const bin = Math.min(HOG_BINS - 1, Math.floor((angle / Math.PI) * HOG_BINS))
      const cellX = Math.min(HOG_CELLS - 1, Math.floor((x / FEATURE_SIZE) * HOG_CELLS))
      const cellY = Math.min(HOG_CELLS - 1, Math.floor((y / FEATURE_SIZE) * HOG_CELLS))
      hog[(cellY * HOG_CELLS + cellX) * HOG_BINS + bin] += magnitude
    }
  }
  return normalizeVector(hog)
}

const countHoles = (raster: Float32Array) => {
  const visited = new Uint8Array(FEATURE_SIZE * FEATURE_SIZE)
  let holes = 0
  for (let startY = 0; startY < FEATURE_SIZE; startY += 1) {
    for (let startX = 0; startX < FEATURE_SIZE; startX += 1) {
      const start = startY * FEATURE_SIZE + startX
      if (visited[start] || raster[start] >= 0.18) continue
      const queue = [start]
      visited[start] = 1
      let touchesBorder = false
      let area = 0
      for (let cursor = 0; cursor < queue.length; cursor += 1) {
        const current = queue[cursor]
        const x = current % FEATURE_SIZE
        const y = Math.floor(current / FEATURE_SIZE)
        area += 1
        if (x === 0 || y === 0 || x === FEATURE_SIZE - 1 || y === FEATURE_SIZE - 1) touchesBorder = true
        const neighbours = [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]]
        neighbours.forEach(([nextX, nextY]) => {
          if (nextX < 0 || nextY < 0 || nextX >= FEATURE_SIZE || nextY >= FEATURE_SIZE) return
          const next = nextY * FEATURE_SIZE + nextX
          if (visited[next] || raster[next] >= 0.18) return
          visited[next] = 1
          queue.push(next)
        })
      }
      if (!touchesBorder && area >= 2) holes += 1
    }
  }
  return Math.min(3, holes)
}

const computeShape = (raster: Float32Array) => {
  let minX = FEATURE_SIZE
  let minY = FEATURE_SIZE
  let maxX = -1
  let maxY = -1
  let ink = 0
  let weightedX = 0
  let weightedY = 0
  let verticalDifference = 0
  let horizontalDifference = 0

  for (let y = 0; y < FEATURE_SIZE; y += 1) {
    for (let x = 0; x < FEATURE_SIZE; x += 1) {
      const value = raster[y * FEATURE_SIZE + x]
      if (value > 0.08) {
        minX = Math.min(minX, x)
        minY = Math.min(minY, y)
        maxX = Math.max(maxX, x)
        maxY = Math.max(maxY, y)
      }
      ink += value
      weightedX += x * value
      weightedY += y * value
      verticalDifference += Math.abs(value - raster[y * FEATURE_SIZE + (FEATURE_SIZE - 1 - x)])
      horizontalDifference += Math.abs(value - raster[(FEATURE_SIZE - 1 - y) * FEATURE_SIZE + x])
    }
  }

  const width = Math.max(1, maxX - minX + 1)
  const height = Math.max(1, maxY - minY + 1)
  const area = width * height
  return new Float32Array([
    Math.atan(width / height) / (Math.PI / 2),
    clamp(ink / Math.max(1, area)),
    ink ? weightedX / ink / (FEATURE_SIZE - 1) : 0.5,
    ink ? weightedY / ink / (FEATURE_SIZE - 1) : 0.5,
    clamp(1 - verticalDifference / Math.max(0.001, ink * 2)),
    clamp(1 - horizontalDifference / Math.max(0.001, ink * 2)),
  ])
}

const resampleTrajectory = (
  points: Stroke['points'],
  normalizePoint: (point: Stroke['points'][number]) => [number, number],
) => {
  if (!points.length) return new Float32Array(TRAJECTORY_POINTS * 4)
  const normalized = points.map(normalizePoint)
  const cumulative = new Float32Array(normalized.length)
  for (let index = 1; index < normalized.length; index += 1) {
    cumulative[index] = cumulative[index - 1] + Math.hypot(
      normalized[index][0] - normalized[index - 1][0],
      normalized[index][1] - normalized[index - 1][1],
    )
  }
  const total = cumulative.at(-1) ?? 0
  const output = new Float32Array(TRAJECTORY_POINTS * 4)
  for (let index = 0; index < TRAJECTORY_POINTS; index += 1) {
    const target = total * index / Math.max(1, TRAJECTORY_POINTS - 1)
    let right = 1
    while (right < cumulative.length && cumulative[right] < target) right += 1
    const left = Math.max(0, right - 1)
    right = Math.min(cumulative.length - 1, right)
    const span = cumulative[right] - cumulative[left]
    const progress = span > 0.000001 ? (target - cumulative[left]) / span : 0
    const x = normalized[left][0] + (normalized[right][0] - normalized[left][0]) * progress
    const y = normalized[left][1] + (normalized[right][1] - normalized[left][1]) * progress
    const tangentStart = normalized[Math.max(0, left - 1)]
    const tangentEnd = normalized[Math.min(normalized.length - 1, right + 1)]
    const tangentLength = Math.max(0.000001, Math.hypot(
      tangentEnd[0] - tangentStart[0],
      tangentEnd[1] - tangentStart[1],
    ))
    output[index * 4] = x
    output[index * 4 + 1] = y
    output[index * 4 + 2] = (tangentEnd[0] - tangentStart[0]) / tangentLength
    output[index * 4 + 3] = (tangentEnd[1] - tangentStart[1]) / tangentLength
  }
  return output
}

const geometryFromStrokes = (strokes: Stroke[]): StrokeGeometry => {
  const directions = new Float32Array(DIRECTION_BINS)
  const points = strokes.flatMap((stroke) => stroke.points)
  if (points.length === 0) {
    return { directions, normalizedLength: 0, closedness: 0, cornerness: 0, trajectory: [] }
  }
  const pixelX = (x: number) => x * SOURCE_WIDTH
  const pixelY = (y: number) => y * SOURCE_HEIGHT
  const minX = Math.min(...points.map((point) => pixelX(point.x)))
  const maxX = Math.max(...points.map((point) => pixelX(point.x)))
  const minY = Math.min(...points.map((point) => pixelY(point.y)))
  const maxY = Math.max(...points.map((point) => pixelY(point.y)))
  const diagonal = Math.max(1, Math.hypot(maxX - minX, maxY - minY))
  const centerX = (minX + maxX) / 2
  const centerY = (minY + maxY) / 2
  const normalizePoint = (point: Stroke['points'][number]): [number, number] => [
    (pixelX(point.x) - centerX) / diagonal,
    (pixelY(point.y) - centerY) / diagonal,
  ]
  let totalLength = 0
  let closedness = 0
  let cornerness = 0
  let cornerCount = 0

  strokes.forEach((stroke) => {
    for (let index = 1; index < stroke.points.length; index += 1) {
      const previous = stroke.points[index - 1]
      const point = stroke.points[index]
      const deltaX = pixelX(point.x - previous.x)
      const deltaY = pixelY(point.y - previous.y)
      const length = Math.hypot(deltaX, deltaY)
      if (length < 0.05) continue
      totalLength += length
      const angle = (Math.atan2(deltaY, deltaX) + Math.PI) % Math.PI
      const bin = Math.min(DIRECTION_BINS - 1, Math.floor((angle / Math.PI) * DIRECTION_BINS))
      directions[bin] += length
    }
    for (let index = 2; index < stroke.points.length; index += 1) {
      const first = stroke.points[index - 2]
      const middle = stroke.points[index - 1]
      const last = stroke.points[index]
      const firstAngle = Math.atan2(pixelY(middle.y - first.y), pixelX(middle.x - first.x))
      const secondAngle = Math.atan2(pixelY(last.y - middle.y), pixelX(last.x - middle.x))
      let turn = Math.abs(secondAngle - firstAngle)
      if (turn > Math.PI) turn = Math.PI * 2 - turn
      cornerness += turn / Math.PI
      cornerCount += 1
    }
    if (stroke.points.length > 1) {
      const first = stroke.points[0]
      const last = stroke.points.at(-1)!
      closedness += 1 - clamp(Math.hypot(pixelX(last.x - first.x), pixelY(last.y - first.y)) / diagonal)
    }
  })

  normalizeVector(directions)
  return {
    directions,
    normalizedLength: clamp(totalLength / (diagonal * 4)),
    closedness: strokes.length ? closedness / strokes.length : 0,
    cornerness: cornerCount ? clamp(cornerness / cornerCount * 2) : 0,
    trajectory: strokes
      .filter((stroke) => stroke.points.length)
      .map((stroke) => resampleTrajectory(stroke.points, normalizePoint)),
  }
}

/**
 * Keeps the original writing proportions that disappear when every glyph is
 * rendered into the same square classifier crop. Two adjacent letters can
 * look deceptively similar to one trained glyph after that normalization;
 * their physical aspect ratio still exposes the accidental merge.
 */
const physicalInkAspect = (strokes: Stroke[]) => {
  const points = strokes.flatMap((stroke) => stroke.points)
  if (!points.length) return 1
  const width = (
    Math.max(...points.map((point) => point.x)) -
    Math.min(...points.map((point) => point.x))
  ) * SOURCE_WIDTH
  const height = (
    Math.max(...points.map((point) => point.y)) -
    Math.min(...points.map((point) => point.y))
  ) * SOURCE_HEIGHT
  return clamp(width / Math.max(1, height), 0.035, 12)
}

const featureFromCanvas = (source: HTMLCanvasElement): FeatureVector => {
  const canvas = document.createElement('canvas')
  canvas.width = ANALYSIS_SIZE
  canvas.height = ANALYSIS_SIZE
  const context = canvas.getContext('2d', { willReadFrequently: true })!
  context.fillStyle = '#ffffff'
  context.fillRect(0, 0, ANALYSIS_SIZE, ANALYSIS_SIZE)
  context.drawImage(source, 0, 0, ANALYSIS_SIZE, ANALYSIS_SIZE)
  const pixels = context.getImageData(0, 0, ANALYSIS_SIZE, ANALYSIS_SIZE).data
  const raster = new Float32Array(FEATURE_SIZE * FEATURE_SIZE)
  const projectionX = new Float32Array(FEATURE_SIZE)
  const projectionY = new Float32Array(FEATURE_SIZE)
  const poolSize = ANALYSIS_SIZE / FEATURE_SIZE

  for (let y = 0; y < FEATURE_SIZE; y += 1) {
    for (let x = 0; x < FEATURE_SIZE; x += 1) {
      let strongestInk = 0
      let totalInk = 0
      for (let poolY = 0; poolY < poolSize; poolY += 1) {
        for (let poolX = 0; poolX < poolSize; poolX += 1) {
          const sourceX = x * poolSize + poolX
          const sourceY = y * poolSize + poolY
          const offset = (sourceY * ANALYSIS_SIZE + sourceX) * 4
          const luminance = (pixels[offset] + pixels[offset + 1] + pixels[offset + 2]) / (3 * 255)
          const ink = clamp((1 - luminance) * 1.25)
          strongestInk = Math.max(strongestInk, ink)
          totalInk += ink
        }
      }
      const averageInk = totalInk / (poolSize * poolSize)
      const pooledInk = strongestInk * 0.72 + averageInk * 0.28
      const value = pooledInk < 0.025 ? 0 : pooledInk
      raster[y * FEATURE_SIZE + x] = value
      projectionX[x] += value
      projectionY[y] += value
    }
  }

  const maxX = Math.max(...projectionX, 0.0001)
  const maxY = Math.max(...projectionY, 0.0001)
  for (let index = 0; index < FEATURE_SIZE; index += 1) {
    projectionX[index] /= maxX
    projectionY[index] /= maxY
  }

  return {
    raster,
    projectionX,
    projectionY,
    hog: computeHog(raster),
    shape: computeShape(raster),
    holes: countHoles(raster),
  }
}

const featureFromDataUrl = (dataUrl: string, augment = true): Promise<FeatureVector[]> =>
  new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => {
      const makeCanvas = (rotation = 0, shear = 0) => {
        const canvas = document.createElement('canvas')
        canvas.width = OUTPUT_SIZE
        canvas.height = OUTPUT_SIZE
        const context = canvas.getContext('2d')!
        context.fillStyle = '#ffffff'
        context.fillRect(0, 0, OUTPUT_SIZE, OUTPUT_SIZE)
        context.save()
        context.translate(OUTPUT_SIZE / 2, OUTPUT_SIZE / 2)
        context.transform(1, 0, shear, 1, 0, 0)
        context.rotate(rotation)
        context.drawImage(image, -OUTPUT_SIZE / 2, -OUTPUT_SIZE / 2, OUTPUT_SIZE, OUTPUT_SIZE)
        context.restore()
        return canvas
      }
      resolve(augment
        ? [
            featureFromCanvas(makeCanvas()),
            featureFromCanvas(makeCanvas(-Math.PI / 60, -0.045)),
            featureFromCanvas(makeCanvas(Math.PI / 60, 0.045)),
          ]
        : [featureFromCanvas(makeCanvas())])
    }
    image.onerror = () => reject(new Error('Trainingsbild konnte nicht gelesen werden.'))
    image.src = dataUrl
  })

const sampleTrust = (sample: Sample) => {
  if (isStandardRecognitionSample(sample)) return 0
  if (sample.sessionId === 'recognized-corrections') return 1
  if (sample.sessionId.startsWith('fanotes-context-')) return 0.34
  return 0.88
}

const sampleTimestamp = (sample: Sample) => {
  const timestamp = Date.parse(sample.createdAt)
  return Number.isFinite(timestamp) ? timestamp : 0
}

const inkFingerprint = (sample: Sample) => {
  let hash = 0x811c9dc5
  const mix = (value: number) => {
    hash ^= value | 0
    hash = Math.imul(hash, 0x01000193)
  }
  sample.strokes.forEach((stroke, strokeIndex) => {
    mix(strokeIndex)
    mix(stroke.points.length)
    stroke.points.forEach((point) => {
      mix(Math.round(point.x * 1_000_000))
      mix(Math.round(point.y * 1_000_000))
    })
  })
  return `${sample.strokeCount}:${sample.pointCount}:${(hash >>> 0).toString(16)}`
}

const resolveConflictingPersonalLabels = (samples: Sample[]) => {
  const standard: Sample[] = []
  const groups = new Map<string, Sample[]>()
  samples.forEach((sample) => {
    if (isStandardRecognitionSample(sample)) {
      standard.push(sample)
      return
    }
    const fingerprint = inkFingerprint(sample)
    const group = groups.get(fingerprint) ?? []
    group.push(sample)
    groups.set(fingerprint, group)
  })
  const personal = [...groups.values()].flatMap((group) => {
    const labels = new Set(group.map((sample) => sample.labelId))
    if (labels.size <= 1) return group
    // An explicit correction of this exact ink snapshot supersedes stale
    // imports or earlier wrong corrections. Keeping both labels would make
    // the same sample vote for mutually exclusive characters forever.
    const winner = [...group].sort((first, second) => (
      sampleTrust(second) - sampleTrust(first) ||
      sampleTimestamp(second) - sampleTimestamp(first)
    ))[0]
    return group.filter((sample) => sample.labelId === winner.labelId)
  })
  return [...personal, ...standard]
}

const spreadAcrossHistory = <T,>(samples: T[], maximum: number): T[] => {
  if (samples.length <= maximum) return samples
  const recentCount = Math.min(samples.length, Math.ceil(maximum * 0.58))
  const selected = samples.slice(0, recentCount)
  const history = samples.slice(recentCount)
  const remaining = maximum - selected.length
  for (let index = 0; index < remaining; index += 1) {
    const sourceIndex = Math.min(
      history.length - 1,
      Math.floor((index + 0.5) * history.length / remaining),
    )
    selected.push(history[sourceIndex])
  }
  return selected
}

const evenlySpaced = <T,>(values: T[], maximum: number): T[] => {
  if (values.length <= maximum) return values
  if (maximum <= 1) return values.slice(0, Math.max(0, maximum))
  return Array.from({ length: maximum }, (_, index) => (
    values[Math.round(index * (values.length - 1) / (maximum - 1))]
  ))
}

export const buildRecognitionModel = async (samples: Sample[]): Promise<RecognitionModel> => {
  const resolvedSamples = resolveConflictingPersonalLabels(samples)
  const labelTotals = new Map<string, number>()
  resolvedSamples.forEach((sample) => labelTotals.set(sample.labelId, (labelTotals.get(sample.labelId) ?? 0) + 1))
  // Explicit GlyphenWerk examples and confirmed corrections always take
  // precedence. Context-derived pseudo labels are deliberately capped so an
  // incorrect language guess can never crowd out the user's trusted samples.
  const groups = new Map<string, Sample[]>()
  resolvedSamples.forEach((sample) => {
    const group = groups.get(sample.labelId) ?? []
    group.push(sample)
    groups.set(sample.labelId, group)
  })
  const selected = [...groups.values()].flatMap((group) => {
    const ordered = [...group].sort((first, second) => (
      sampleTrust(second) - sampleTrust(first) ||
      sampleTimestamp(second) - sampleTimestamp(first)
    ))
    const standard = ordered.filter(isStandardRecognitionSample)
    const context = ordered
      .filter((sample) => sample.sessionId.startsWith('fanotes-context-'))
      .slice(0, MAX_CONTEXT_EXAMPLES_PER_LABEL)
    const trusted = ordered.filter((sample) => (
      !isStandardRecognitionSample(sample) &&
      !sample.sessionId.startsWith('fanotes-context-')
    ))
    return [
      ...spreadAcrossHistory(
        trusted,
        Math.max(1, MAX_FEATURE_EXAMPLES_PER_LABEL - MAX_CONTEXT_EXAMPLES_PER_LABEL),
      ),
      ...context,
      ...standard,
    ]
  })

  const entries = await Promise.all(
    selected.map(async (sample) => {
      const standard = isStandardRecognitionSample(sample)
      const cacheKey = `${sample.id}:${sample.labelId}:${inkFingerprint(sample)}:${sample.imageData.length}`
      let features = featureCache.get(cacheKey)
      if (!features) {
        features = await featureFromDataUrl(
          sample.imageData,
          !standard && (labelTotals.get(sample.labelId) ?? 0) <= 4,
        )
        featureCache.set(cacheKey, features)
        if (featureCache.size > 8_192) featureCache.delete(featureCache.keys().next().value!)
      }
      const [feature, ...augmented] = features
      return {
        ...feature,
        sampleId: sample.id,
        sessionId: sample.sessionId,
        labelId: sample.labelId,
        strokeCount: sample.strokeCount,
        physicalAspect: physicalInkAspect(sample.strokes),
        geometry: geometryFromStrokes(sample.strokes),
        variants: (labelTotals.get(sample.labelId) ?? 0) <= 4 ? augmented : [],
        standard,
        trust: sampleTrust(sample),
        createdAt: sampleTimestamp(sample),
      }
    }),
  )
  suppressSupersededPersonalConflicts(entries)
  const personalEntries = entries.filter((entry) => !entry.standard)
  const classifierGroups = new Map<string, RecognitionModelEntry[]>()
  personalEntries.forEach((entry) => {
    const group = classifierGroups.get(entry.labelId) ?? []
    group.push(entry)
    classifierGroups.set(entry.labelId, group)
  })
  const classifierPersonalEntries = [...classifierGroups.values()].flatMap((group) => (
    spreadAcrossHistory(
      [...group].sort((first, second) => (
        second.trust - first.trust ||
        second.createdAt - first.createdAt
      )),
      MAX_EXAMPLES_PER_LABEL,
    )
  ))
  const model = [
    ...classifierPersonalEntries,
    ...entries.filter((entry) => entry.standard),
  ] as RecognitionModel
  const defaultWeights = { ...DEFAULT_WEIGHTS }
  let modelEvaluation: ReturnType<typeof estimateModelAccuracy> | null = null
  if (personalEntries.length >= 4) {
    const adaptiveWeights = learnAdaptiveWeights(personalEntries)
    const adaptiveEvaluation = estimateModelAccuracy(personalEntries, adaptiveWeights)
    const defaultEvaluation = estimateModelAccuracy(personalEntries, defaultWeights)
    // A large but imbalanced or noisy import must never make the feature space
    // objectively worse than the robust baseline. The same class-balanced,
    // preferably cross-session holdout decides which weights are published.
    const adaptiveWins = adaptiveEvaluation.score >= defaultEvaluation.score
    model.weights = adaptiveWins ? adaptiveWeights : defaultWeights
    modelEvaluation = adaptiveWins ? adaptiveEvaluation : defaultEvaluation
  } else {
    model.weights = defaultWeights
  }
  model.prototypes = buildClassPrototypes(entries)
  model.prototypeSets = buildClassPrototypeSets(entries, model.weights)
  model.classifierEntries = buildClassifierEntries(entries, model.prototypeSets)
  model.labelStats = buildLabelStats(personalEntries, model.prototypeSets, model.weights)
  model.aspectStats = buildAspectStats(entries)
  const evaluation = modelEvaluation ?? estimateModelAccuracy(personalEntries, model.weights)
  model.estimatedAccuracy = evaluation.accuracy
  model.evaluatedSamples = evaluation.count
  return model
}

const strokeBounds = (stroke: Stroke) => {
  const points = stroke.points
  const paddingX = Math.max(0.0015, stroke.baseWidth / SOURCE_WIDTH)
  const paddingY = Math.max(0.0025, stroke.baseWidth / SOURCE_HEIGHT)
  return {
    minX: Math.max(0, Math.min(...points.map((point) => point.x)) - paddingX),
    minY: Math.max(0, Math.min(...points.map((point) => point.y)) - paddingY),
    maxX: Math.min(1, Math.max(...points.map((point) => point.x)) + paddingX),
    maxY: Math.min(1, Math.max(...points.map((point) => point.y)) + paddingY),
  }
}

const isRadicalContainer = (
  candidate: { stroke: Stroke; bounds: ReturnType<typeof strokeBounds> },
  others: { stroke: Stroke; bounds: ReturnType<typeof strokeBounds> }[],
) => {
  const { stroke, bounds } = candidate
  const width = bounds.maxX - bounds.minX
  const height = bounds.maxY - bounds.minY
  if (stroke.points.length < 4 || width < 0.07 || height < 0.08) return false

  const topBand = bounds.minY + height * 0.3
  let topHorizontalTravel = 0
  for (let index = 1; index < stroke.points.length; index += 1) {
    const previous = stroke.points[index - 1]
    const point = stroke.points[index]
    const deltaX = Math.abs(point.x - previous.x)
    const deltaY = Math.abs(point.y - previous.y)
    if ((point.y + previous.y) / 2 <= topBand && deltaX > deltaY * 1.6) {
      topHorizontalTravel += deltaX
    }
  }

  const hasTopBar = topHorizontalTravel >= width * 0.24
  const hasLowerHook = stroke.points.some((point) =>
    point.y >= bounds.minY + height * 0.67 && point.x <= bounds.minX + width * 0.55,
  )
  const reachesUpperRight = stroke.points.some((point) =>
    point.y <= bounds.minY + height * 0.32 && point.x >= bounds.minX + width * 0.38,
  )
  if (!hasTopBar || !hasLowerHook || !reachesUpperRight) return false

  return others.some(({ bounds: inner }) => {
    const centerX = (inner.minX + inner.maxX) / 2
    const centerY = (inner.minY + inner.maxY) / 2
    const innerWidth = inner.maxX - inner.minX
    const innerHeight = inner.maxY - inner.minY
    return (
      centerX >= bounds.minX + width * 0.24 &&
      centerX <= bounds.maxX - width * 0.025 &&
      centerY >= bounds.minY + height * 0.13 &&
      centerY <= bounds.maxY + height * 0.04 &&
      innerWidth <= width * 0.72 &&
      innerHeight <= height * 0.92
    )
  })
}

const liesInsideRadical = (
  radical: ReturnType<typeof strokeBounds>,
  inner: ReturnType<typeof strokeBounds>,
) => {
  const width = radical.maxX - radical.minX
  const height = radical.maxY - radical.minY
  const centerX = (inner.minX + inner.maxX) / 2
  const centerY = (inner.minY + inner.maxY) / 2
  const innerWidth = inner.maxX - inner.minX
  const innerHeight = inner.maxY - inner.minY
  return (
    centerX >= radical.minX + width * 0.24 &&
    centerX <= radical.maxX - width * 0.025 &&
    centerY >= radical.minY + height * 0.13 &&
    centerY <= radical.maxY + height * 0.04 &&
    innerWidth <= width * 0.72 &&
    innerHeight <= height * 0.92
  )
}

const isRadicalHookStroke = (candidate: { bounds: ReturnType<typeof strokeBounds>; stroke: Stroke }) => {
  const { bounds, stroke } = candidate
  const width = bounds.maxX - bounds.minX
  const height = bounds.maxY - bounds.minY
  if (stroke.points.length < 3 || width < 0.035 || height < 0.08) return false
  const hasLowerHook = stroke.points.some((point) =>
    point.y >= bounds.minY + height * 0.67 && point.x <= bounds.minX + width * 0.72,
  )
  const reachesUpperRight = stroke.points.some((point) =>
    point.y <= bounds.minY + height * 0.22 && point.x >= bounds.minX + width * 0.72,
  )
  return hasLowerHook && reachesUpperRight
}

const isHorizontalBarStroke = (bounds: ReturnType<typeof strokeBounds>) => {
  const width = bounds.maxX - bounds.minX
  const height = bounds.maxY - bounds.minY
  return width >= 0.065 && width >= height * 3.2
}

/** Bounding-box aspect alone is insufficient for crossbars: a complete
 * cursive word is often wider than it is tall as well. A genuine detached
 * bar has predominantly horizontal travel and nearly spans its own box. */
const resemblesStraightHorizontalAccessoryStroke = (
  stroke: Stroke,
  bounds = strokeBounds(stroke),
) => {
  if (stroke.points.length < 2) return false
  const width = (bounds.maxX - bounds.minX) * SOURCE_WIDTH
  const height = (bounds.maxY - bounds.minY) * SOURCE_HEIGHT
  if (width < 8 || width / Math.max(1, height) < 1.75) return false
  let horizontalTravel = 0
  let verticalTravel = 0
  stroke.points.slice(1).forEach((point, index) => {
    horizontalTravel += Math.abs(point.x - stroke.points[index].x) * SOURCE_WIDTH
    verticalTravel += Math.abs(point.y - stroke.points[index].y) * SOURCE_HEIGHT
  })
  const endpointSpan = Math.abs(stroke.points.at(-1)!.x - stroke.points[0].x) * SOURCE_WIDTH
  return (
    // Some writers start a bar near its centre, sweep to one edge and then
    // finish at the other. Its endpoints therefore need not span the full
    // box even though the trajectory remains overwhelmingly horizontal.
    endpointSpan >= width * 0.34 &&
    horizontalTravel <= width * 2.8 + 10 &&
    verticalTravel <= Math.max(14, horizontalTravel * 0.42)
  )
}

const combinedBounds = (
  first: ReturnType<typeof strokeBounds>,
  second: ReturnType<typeof strokeBounds>,
) => ({
  minX: Math.min(first.minX, second.minX),
  minY: Math.min(first.minY, second.minY),
  maxX: Math.max(first.maxX, second.maxX),
  maxY: Math.max(first.maxY, second.maxY),
})

type TextCutCandidate = {
  x: number
  score: number
  source: 'density' | 'ink-gap' | 'pen-lift'
}

const interpolateStrokePoint = (
  first: Stroke['points'][number],
  second: Stroke['points'][number],
  progress: number,
): Stroke['points'][number] => ({
  x: first.x + (second.x - first.x) * progress,
  y: first.y + (second.y - first.y) * progress,
  t: first.t + (second.t - first.t) * progress,
  pressure: first.pressure + (second.pressure - first.pressure) * progress,
  tiltX: first.tiltX + (second.tiltX - first.tiltX) * progress,
  tiltY: first.tiltY + (second.tiltY - first.tiltY) * progress,
  pointerType: first.pointerType || second.pointerType,
})

const clusterFromStrokes = (strokes: Stroke[]): StrokeCluster | null => {
  const usable = strokes.filter((stroke) => stroke.points.length)
  if (!usable.length) return null
  const bounds = usable.map(strokeBounds)
  return {
    strokes: usable,
    minX: Math.min(...bounds.map((entry) => entry.minX)),
    minY: Math.min(...bounds.map((entry) => entry.minY)),
    maxX: Math.max(...bounds.map((entry) => entry.maxX)),
    maxY: Math.max(...bounds.map((entry) => entry.maxY)),
  }
}

const textStrokePathLength = (stroke: Stroke) => stroke.points.slice(1).reduce((sum, point, index) => (
  sum + Math.hypot(
    (point.x - stroke.points[index].x) * SOURCE_WIDTH,
    (point.y - stroke.points[index].y) * SOURCE_HEIGHT,
  )
), 0)

const textStrokeStartTime = (stroke: Stroke) => Math.min(
  ...stroke.points.map((point) => Number.isFinite(point.t) ? point.t : Number.MAX_SAFE_INTEGER),
)

/** The earliest full-height stroke is normally the uninterrupted cursive
 * body. It is the only stroke that must always be cut spatially; later
 * crossbars, dots and secondary bodies remain complete owner candidates. */
const primaryContinuousTextStroke = (cluster: StrokeCluster) => [...cluster.strokes]
  .filter((stroke) => stroke.points.length >= 2)
  .filter((stroke) => {
    if (!resemblesStraightHorizontalAccessoryStroke(stroke)) return true
    const bounds = strokeBounds(stroke)
    const strokeHeight = (bounds.maxY - bounds.minY) * SOURCE_HEIGHT
    const clusterHeight = Math.max(1, (cluster.maxY - cluster.minY) * SOURCE_HEIGHT)
    return strokeHeight >= Math.max(22, clusterHeight * 0.42)
  })
  .sort((first, second) => (
    textStrokeStartTime(first) - textStrokeStartTime(second) ||
    (strokeBounds(second).maxX - strokeBounds(second).minX) -
      (strokeBounds(first).maxX - strokeBounds(first).minX) ||
    textStrokePathLength(second) - textStrokePathLength(first)
  ))[0]

const splitTextCluster = (cluster: StrokeCluster, boundaries: number[]) => {
  const cuts = [...boundaries].sort((first, second) => first - second)
  const groups: Stroke[][] = Array.from({ length: cuts.length + 1 }, () => [])
  const bandFor = (x: number) => cuts.findIndex((cut) => x < cut)
  const normalizedBand = (x: number) => {
    const index = bandFor(x)
    return index < 0 ? cuts.length : index
  }
  const primaryContinuousStroke = primaryContinuousTextStroke(cluster)

  /**
   * A crossbar or dot can be drawn after an entire cursive word. In that
   * case its body is one long stroke and its global bounding box no longer
   * resembles a narrow stem. Find the *local* stem/contact instead. This
   * keeps the accessory stroke indivisible even for a candidate cut passing
   * through it; the candidate may still lose on recognition score, but it
   * can never manufacture an extra glyph from half a T bar.
   */
  const localAccessoryOwnerBand = (
    accessoryStroke: Stroke,
    accessoryBounds: ReturnType<typeof strokeBounds>,
  ) => {
    const width = (accessoryBounds.maxX - accessoryBounds.minX) * SOURCE_WIDTH
    const height = (accessoryBounds.maxY - accessoryBounds.minY) * SOURCE_HEIGHT
    const clusterHeight = Math.max(1, (cluster.maxY - cluster.minY) * SOURCE_HEIGHT)
    const horizontal = resemblesStraightHorizontalAccessoryStroke(accessoryStroke, accessoryBounds) &&
      width >= 8 && width <= Math.max(160, clusterHeight * 2.6)
    const compact = Math.max(width, height) <= Math.max(66, clusterHeight * 0.56) &&
      width / Math.max(1, height) <= 2.8
    if (!horizontal && !compact) return null

    const centerX = (accessoryBounds.minX + accessoryBounds.maxX) / 2
    const centerY = (accessoryBounds.minY + accessoryBounds.maxY) / 2
    const candidates: Array<{ band: number; score: number }> = []
    cluster.strokes.forEach((bodyStroke) => {
      if (bodyStroke === accessoryStroke || bodyStroke.points.length < 2) return
      bodyStroke.points.slice(1).forEach((second, pointIndex) => {
        const first = bodyStroke.points[pointIndex]
        const deltaX = (second.x - first.x) * SOURCE_WIDTH
        const deltaY = (second.y - first.y) * SOURCE_HEIGHT
        const segmentHeight = Math.abs(deltaY)
        const segmentWidth = Math.abs(deltaX)
        if (horizontal) {
          // A t/T crossbar is owned by a locally tall stroke that actually
          // reaches its y-level. Merely lying underneath the bar is not
          // enough and would let a following round e steal an overhang.
          const minimumY = Math.min(first.y, second.y) - 5 / SOURCE_HEIGHT
          const maximumY = Math.max(first.y, second.y) + 5 / SOURCE_HEIGHT
          if (
            segmentHeight < Math.max(9, clusterHeight * 0.075) ||
            segmentHeight / Math.max(1, segmentWidth) < 0.72 ||
            centerY < minimumY || centerY > maximumY
          ) return
          const progress = Math.abs(second.y - first.y) < Number.EPSILON
            ? 0.5
            : clamp((centerY - first.y) / (second.y - first.y))
          const intersectionX = first.x + (second.x - first.x) * progress
          const horizontalGap = Math.max(
            0,
            accessoryBounds.minX - intersectionX,
            intersectionX - accessoryBounds.maxX,
          ) * SOURCE_WIDTH
          if (horizontalGap > Math.max(8, width * 0.16)) return
          candidates.push({
            band: normalizedBand(intersectionX),
            score: horizontalGap * 2.4 + segmentWidth * 0.08 - segmentHeight * 0.16,
          })
          return
        }

        // Detached i/j/umlaut dots sit above their body. Attribute a dot to
        // the closest locally lower segment, while rejecting neighbouring
        // crossbars and body-sized loops through the compactness guard above.
        const segmentCenterX = (first.x + second.x) / 2
        const horizontalDistance = Math.abs(segmentCenterX - centerX) * SOURCE_WIDTH
        const segmentTop = Math.min(first.y, second.y)
        const verticalGap = Math.max(0, segmentTop - accessoryBounds.maxY) * SOURCE_HEIGHT
        if (
          horizontalDistance > Math.max(34, clusterHeight * 0.42) ||
          verticalGap > Math.max(90, clusterHeight * 1.15)
        ) return
        candidates.push({
          band: normalizedBand(segmentCenterX),
          score: horizontalDistance + verticalGap * 0.58 - segmentHeight * 0.035,
        })
      })
    })
    return candidates.sort((first, second) => first.score - second.score)[0]?.band ?? null
  }

  /** Keeps a complete pen-lift stroke with its letter when only a tiny
   * overhang crosses a proposed boundary. This is common for the right arm of
   * T/W/x and prevents that arm from becoming a separate character. The long
   * cursive body itself is still split because it carries substantial ink on
   * both sides of the boundary. */
  const dominantStrokeOwnerBand = (
    stroke: Stroke,
    bounds: ReturnType<typeof strokeBounds>,
  ) => {
    if (stroke.points.length < 2 || cuts.length === 0) return null
    const weights = groups.map(() => 0)
    stroke.points.slice(1).forEach((second, pointIndex) => {
      const first = stroke.points[pointIndex]
      const deltaX = (second.x - first.x) * SOURCE_WIDTH
      const deltaY = (second.y - first.y) * SOURCE_HEIGHT
      const length = Math.hypot(deltaX, deltaY)
      const steps = Math.max(1, Math.ceil(Math.max(Math.abs(deltaX), Math.abs(deltaY)) / 3))
      for (let step = 0; step < steps; step += 1) {
        const progress = (step + 0.5) / steps
        weights[normalizedBand(first.x + (second.x - first.x) * progress)] += length / steps
      }
    })
    const total = weights.reduce((sum, weight) => sum + weight, 0)
    if (total <= Number.EPSILON) return null
    const dominant = weights
      .map((weight, band) => ({ band, weight }))
      .sort((first, second) => second.weight - first.weight)[0]
    if (!dominant || dominant.weight / total < 0.66) return null
    const lowerBoundary = dominant.band === 0 ? -Infinity : cuts[dominant.band - 1]
    const upperBoundary = dominant.band === cuts.length ? Infinity : cuts[dominant.band]
    const leftOverhang = Number.isFinite(lowerBoundary)
      ? Math.max(0, lowerBoundary - bounds.minX) * SOURCE_WIDTH
      : 0
    const rightOverhang = Number.isFinite(upperBoundary)
      ? Math.max(0, bounds.maxX - upperBoundary) * SOURCE_WIDTH
      : 0
    const clusterHeight = Math.max(1, (cluster.maxY - cluster.minY) * SOURCE_HEIGHT)
    if (Math.max(leftOverhang, rightOverhang) > Math.max(18, clusterHeight * 0.22)) return null
    return dominant.band
  }

  cluster.strokes.forEach((stroke) => {
    const bounds = strokeBounds(stroke)
    const crossesBoundary = cuts.some((cut) => cut > bounds.minX && cut < bounds.maxX)
    if (crossesBoundary) {
      const crossingWidth = (bounds.maxX - bounds.minX) * SOURCE_WIDTH
      const crossingHeight = (bounds.maxY - bounds.minY) * SOURCE_HEIGHT
      const crossingExtent = Math.max(crossingWidth, crossingHeight)
      const wholeLineBody = stroke === primaryContinuousStroke &&
        crossingWidth >= (cluster.maxX - cluster.minX) * SOURCE_WIDTH * 0.68
      const attachedBody = cluster.strokes
        .filter((candidate) => candidate !== stroke && candidate.points.length)
        .map((candidate) => ({
          candidate,
          bounds: strokeBounds(candidate),
        }))
        .filter((candidate) => {
          if (wholeLineBody) return false
          const candidateWidth = (candidate.bounds.maxX - candidate.bounds.minX) * SOURCE_WIDTH
          const candidateHeight = (candidate.bounds.maxY - candidate.bounds.minY) * SOURCE_HEIGHT
          const candidateExtent = Math.max(candidateWidth, candidateHeight)
          const crossingIsCrossbar = (
            resemblesStraightHorizontalAccessoryStroke(stroke, bounds) &&
            resemblesTextCrossbarPair(bounds, candidate.bounds)
          )
          const crossingIsDot = (
            crossingExtent <= candidateExtent * 0.72 &&
            crossingHeight <= candidateHeight * 0.58 &&
            resemblesTextDotPair(bounds, candidate.bounds)
          )
          return crossingIsCrossbar || crossingIsDot
        })
        .sort((first, second) => {
          return textAccessoryAttachmentScore(bounds, first.bounds) -
            textAccessoryAttachmentScore(bounds, second.bounds)
        })[0]
      if (attachedBody) {
        const bodyCenter = (attachedBody.bounds.minX + attachedBody.bounds.maxX) / 2
        groups[normalizedBand(bodyCenter)].push({
          ...stroke,
          points: stroke.points.map((point) => ({ ...point })),
        })
        return
      }
      const localOwnerBand = wholeLineBody ? null : localAccessoryOwnerBand(stroke, bounds)
      if (localOwnerBand !== null) {
        groups[localOwnerBand].push({
          ...stroke,
          points: stroke.points.map((point) => ({ ...point })),
        })
        return
      }
      const dominantOwnerBand = wholeLineBody ? null : dominantStrokeOwnerBand(stroke, bounds)
      if (dominantOwnerBand !== null) {
        groups[dominantOwnerBand].push({
          ...stroke,
          points: stroke.points.map((point) => ({ ...point })),
        })
        return
      }
    }
    if (stroke.points.length === 1) {
      groups[normalizedBand(stroke.points[0].x)].push({ ...stroke, points: [{ ...stroke.points[0] }] })
      return
    }
    let currentBand = normalizedBand(stroke.points[0].x)
    let currentPoints: Stroke['points'] = [{ ...stroke.points[0] }]
    const commit = () => {
      if (!currentPoints.length) return
      groups[currentBand].push({ ...stroke, points: currentPoints })
    }

    for (let pointIndex = 1; pointIndex < stroke.points.length; pointIndex += 1) {
      const first = stroke.points[pointIndex - 1]
      const second = stroke.points[pointIndex]
      const deltaX = second.x - first.x
      const crossed = Math.abs(deltaX) < 0.0000001
        ? []
        : cuts
          .filter((cut) => cut > Math.min(first.x, second.x) && cut < Math.max(first.x, second.x))
          .sort((left, right) => deltaX > 0 ? left - right : right - left)

      crossed.forEach((cut) => {
        const crossing = interpolateStrokePoint(first, second, (cut - first.x) / deltaX)
        currentPoints.push(crossing)
        commit()
        currentBand += deltaX > 0 ? 1 : -1
        currentPoints = [{ ...crossing }]
      })

      const nextBand = normalizedBand(second.x)
      if (nextBand !== currentBand) {
        commit()
        currentBand = nextBand
        currentPoints = [{ ...second }]
      } else {
        currentPoints.push({ ...second })
      }
    }
    commit()
  })

  return groups.flatMap((strokes) => {
    const result = clusterFromStrokes(strokes)
    return result ? [result] : []
  })
}

const textStrokePointKey = (point: Stroke['points'][number]) => (
  `${Math.round(point.x * 10_000_000)}:${Math.round(point.y * 10_000_000)}:${Math.round(point.t * 1_000)}`
)

/**
 * A connected word can be written as one long body followed by several
 * delayed pen lifts: the bar of the first `T`, the dot of an `i`, or the
 * second diagonal of an `X`. A single nearest-box decision is insufficient
 * when such a complete stroke lies on the boundary. Keep the spatial split,
 * but enumerate a tiny beam of whole-stroke owner assignments. No original
 * pen lift is cut or duplicated; the normal personal classifier chooses the
 * visually coherent pair afterwards.
 */
const twoPartStrokeOwnershipVariants = (
  cluster: StrokeCluster,
  boundary: number,
  base: StrokeCluster[],
) => {
  if (base.length !== 2) return [base]
  const primary = primaryContinuousTextStroke(cluster)
  const physicalHeight = Math.max(1, (cluster.maxY - cluster.minY) * SOURCE_HEIGHT)
  const partCenters = base.map((part) => (part.minX + part.maxX) / 2)

  const movable = cluster.strokes.flatMap((stroke) => {
    if (stroke === primary || !stroke.points.length) return []
    const bounds = strokeBounds(stroke)
    const width = (bounds.maxX - bounds.minX) * SOURCE_WIDTH
    const height = (bounds.maxY - bounds.minY) * SOURCE_HEIGHT
    const centerX = (bounds.minX + bounds.maxX) / 2

    const keys = new Set(stroke.points.map(textStrokePointKey))
    const matchingParts = base.flatMap((part, partIndex) => (
      part.strokes.some((candidate) => candidate.points.some((point) => keys.has(textStrokePointKey(point))))
        ? [partIndex]
        : []
    ))
    if (!matchingParts.length) return []

    const weights = [0, 0]
    stroke.points.slice(1).forEach((second, index) => {
      const first = stroke.points[index]
      const length = Math.hypot(
        (second.x - first.x) * SOURCE_WIDTH,
        (second.y - first.y) * SOURCE_HEIGHT,
      )
      const midpoint = (first.x + second.x) / 2
      weights[midpoint < boundary ? 0 : 1] += length
    })
    if (weights[0] + weights[1] < 0.1) weights[centerX < boundary ? 0 : 1] = 1
    const horizontal = resemblesStraightHorizontalAccessoryStroke(stroke, bounds)
    const compact = Math.max(width, height) <= Math.max(66, physicalHeight * 0.58)
    const optionScores = [0, 1].map((owner) => {
      const share = weights[owner] / Math.max(0.1, weights[0] + weights[1])
      const centerDistance = Math.abs(centerX - partCenters[owner]) * SOURCE_WIDTH / physicalHeight
      const attachment = textAccessoryAttachmentScore(bounds, {
        minX: base[owner].minX,
        minY: base[owner].minY,
        maxX: base[owner].maxX,
        maxY: base[owner].maxY,
      }) / physicalHeight
      return share * (horizontal || compact ? 0.9 : 1.55) - centerDistance * 0.16 -
        attachment * (horizontal || compact ? 0.34 : 0.08)
    })
    // An exceptionally wide, straight T bar with a proven local stem must
    // never be offered to the following letter merely because it overhangs
    // the candidate cut. Shorter f/F bars remain ambiguous and are handled
    // by the bounded owner beam below.
    const allowedOwners = horizontal &&
      width >= Math.max(140, physicalHeight * 1.1) &&
      matchingParts.length === 1
      ? matchingParts
      : [0, 1]
    return [{ stroke, keys, optionScores, allowedOwners }]
  }).slice(0, 5)
  if (!movable.length) return [base]

  type OwnershipBeam = { owners: number[]; score: number }
  let beams: OwnershipBeam[] = [{ owners: [], score: 0 }]
  movable.forEach(({ optionScores, allowedOwners }) => {
    beams = beams.flatMap((beam) => allowedOwners.map((owner) => ({
      owners: [...beam.owners, owner],
      score: beam.score + optionScores[owner],
    }))).sort((first, second) => second.score - first.score).slice(0, 8)
  })

  // Delayed accessories are normally completed from left to right: all
  // remaining strokes of the first letter, then those of the second. Keep
  // every possible transition in that real pen order. This guarantees that
  // `I` top/bottom bars, both arms of `k`, or the second diagonal of `x`
  // remain assignable even when an internal blank band proposed a poor cut.
  // The scored geometric beam still covers non-monotonic writing orders.
  const monotonicBeams: OwnershipBeam[] = Array.from(
    { length: movable.length + 1 },
    (_, cut) => {
      const owners = movable.map((_, index) => index < cut ? 0 : 1)
      return {
        owners,
        score: owners.reduce<number>(
          (sum, owner, index) => sum + movable[index].optionScores[owner],
          0,
        ),
      }
    },
  )
  const ownerAssignments = [...monotonicBeams, ...beams]
    .filter((beam) => beam.owners.every((owner, index) => (
      movable[index].allowedOwners.includes(owner)
    )))
    .filter((beam, index, entries) => entries.findIndex((candidate) => (
      candidate.owners.join('') === beam.owners.join('')
    )) === index)
    .slice(0, 8)

  const signature = (parts: StrokeCluster[]) => parts.map((part) => part.strokes.map((stroke) => (
    stroke.points.map(textStrokePointKey).join(',')
  )).sort().join('|')).join('::')
  const seen = new Set<string>()
  return ownerAssignments.flatMap((beam) => {
    const reassigned = base.map((part) => part.strokes.map((stroke) => ({
      ...stroke,
      points: stroke.points.map((point) => ({ ...point })),
    })))
    movable.forEach(({ stroke, keys }, index) => {
      reassigned.forEach((strokes, partIndex) => {
        reassigned[partIndex] = strokes.filter((candidate) => (
          !candidate.points.some((point) => keys.has(textStrokePointKey(point)))
        ))
      })
      reassigned[beam.owners[index]].push({
        ...stroke,
        points: stroke.points.map((point) => ({ ...point })),
      })
    })
    const parts = reassigned.flatMap((strokes) => {
      const part = clusterFromStrokes(strokes)
      return part ? [part] : []
    })
    if (parts.length !== 2) return []
    const key = signature(parts)
    if (seen.has(key)) return []
    seen.add(key)
    return [parts]
  })
}

const textCutCandidates = (cluster: StrokeCluster): TextCutCandidate[] => {
  const points = cluster.strokes.flatMap((stroke) => stroke.points)
  if (points.length < 8) return []
  const minX = Math.min(...points.map((point) => point.x))
  const maxX = Math.max(...points.map((point) => point.x))
  const minY = Math.min(...points.map((point) => point.y))
  const maxY = Math.max(...points.map((point) => point.y))
  const width = Math.max(0.0001, maxX - minX)
  const physicalWidth = width * SOURCE_WIDTH
  const physicalHeight = Math.max(1, (maxY - minY) * SOURCE_HEIGHT)
  const aspect = physicalWidth / physicalHeight
  if (physicalWidth < 34 || aspect < 0.9) return []

  const bins = Math.max(32, Math.min(112, Math.round(physicalWidth / 3)))
  const density = new Float32Array(bins)
  const horizontal = new Float32Array(bins)
  const directionWeight = new Float32Array(bins)
  const localMinY = new Float32Array(bins).fill(Number.POSITIVE_INFINITY)
  const localMaxY = new Float32Array(bins).fill(Number.NEGATIVE_INFINITY)

  cluster.strokes.forEach((stroke) => {
    for (let index = 1; index < stroke.points.length; index += 1) {
      const first = stroke.points[index - 1]
      const second = stroke.points[index]
      const deltaPhysicalX = (second.x - first.x) * SOURCE_WIDTH
      const deltaPhysicalY = (second.y - first.y) * SOURCE_HEIGHT
      const length = Math.max(0.1, Math.hypot(deltaPhysicalX, deltaPhysicalY))
      const horizontalness = Math.abs(deltaPhysicalX) / (Math.abs(deltaPhysicalX) + Math.abs(deltaPhysicalY) + 0.0001)
      const steps = Math.max(1, Math.min(160, Math.ceil(length / 2.4)))
      for (let step = 0; step <= steps; step += 1) {
        const progress = step / steps
        const x = first.x + (second.x - first.x) * progress
        const y = first.y + (second.y - first.y) * progress
        const bin = Math.max(0, Math.min(bins - 1, Math.floor((x - minX) / width * bins)))
        density[bin] += length / steps
        horizontal[bin] += horizontalness * length / steps
        directionWeight[bin] += length / steps
        localMinY[bin] = Math.min(localMinY[bin], y)
        localMaxY[bin] = Math.max(localMaxY[bin], y)
      }
    }
  })

  const positiveDensity = [...density].filter((value) => value > 0).sort((first, second) => first - second)
  const densityReference = positiveDensity[Math.floor(positiveDensity.length * 0.78)] || 1
  const scores = Array.from({ length: bins }, (_, index) => {
    const span = Number.isFinite(localMinY[index])
      ? (localMaxY[index] - localMinY[index]) * SOURCE_HEIGHT / physicalHeight
      : 0
    const horizontalness = directionWeight[index] ? horizontal[index] / directionWeight[index] : 1
    const densityScore = clamp(density[index] / Math.max(0.001, densityReference))
    return densityScore * 0.32 + clamp(span) * 0.38 + (1 - horizontalness) * 0.3
  })
  // A percentage of the complete word is not a valid edge guard: in a long
  // word it can hide an entire narrow first/last glyph (for example f or i).
  // Keep only a small raster-width guard against the canvas border.
  const edge = Math.max(2, Math.min(5, Math.round(bins * 0.035)))
  const candidates: TextCutCandidate[] = []
  for (let index = edge; index < bins - edge; index += 1) {
    const score = scores[index]
    const local = scores.slice(Math.max(edge, index - 2), Math.min(bins - edge, index + 3))
    const horizontalness = directionWeight[index] ? horizontal[index] / directionWeight[index] : 1
    const span = Number.isFinite(localMinY[index])
      ? (localMaxY[index] - localMinY[index]) * SOURCE_HEIGHT / physicalHeight
      : 0
    if (score > 0.64 || score > Math.min(...local) + 0.035) continue
    if (horizontalness < 0.32 && span > 0.18) continue
    candidates.push({ x: minX + (index + 0.5) / bins * width, score, source: 'density' })
  }

  // Separate pen lifts often leave a real whitespace gap even when adjacent
  // letters are close enough to belong to the same word cluster. Raster bins
  // can miss a narrow first glyph because the gap occupies less than one bin;
  // explicit stroke-interval gaps remain exact and cost almost nothing.
  const intervals = cluster.strokes
    .filter((stroke) => stroke.points.length)
    .map((stroke) => {
      const radius = Math.max(0.5, stroke.baseWidth / 2) / SOURCE_WIDTH
      return {
        min: Math.min(...stroke.points.map((point) => point.x)) - radius,
        max: Math.max(...stroke.points.map((point) => point.x)) + radius,
      }
    })
    .sort((first, second) => first.min - second.min)
  const mergedIntervals: Array<{ min: number; max: number }> = []
  intervals.forEach((interval) => {
    const previous = mergedIntervals.at(-1)
    if (previous && interval.min <= previous.max + 1.25 / SOURCE_WIDTH) {
      previous.max = Math.max(previous.max, interval.max)
    } else mergedIntervals.push({ ...interval })
  })
  const minimumInkGap = Math.max(2.5, physicalHeight * 0.025)
  for (let index = 1; index < mergedIntervals.length; index += 1) {
    const previous = mergedIntervals[index - 1]
    const next = mergedIntervals[index]
    const gap = (next.min - previous.max) * SOURCE_WIDTH
    if (gap < minimumInkGap) continue
    const x = (previous.max + next.min) / 2
    if ((x - minX) * SOURCE_WIDTH < Math.max(5, physicalHeight * 0.06)) continue
    if ((maxX - x) * SOURCE_WIDTH < Math.max(5, physicalHeight * 0.06)) continue
    const score = Math.max(0, 0.04 - gap / physicalHeight * 0.3)
    const nearby = candidates.find((candidate) => Math.abs(candidate.x - x) * SOURCE_WIDTH <= Math.max(3, gap * 0.6))
    if (nearby) {
      nearby.score = Math.min(nearby.score, score)
      nearby.source = 'ink-gap'
    }
    else candidates.push({ x, score, source: 'ink-gap' })
  }
  return candidates.sort((first, second) => first.x - second.x)
}

/**
 * Returns only valleys that can leave a complete letter-sized body on both
 * sides. This does not force a cut; it merely opens a competing hypothesis.
 * The classifier, the learned personal aspect and the complete word decoder
 * still decide whether the valley was an inter-letter connector or an inner
 * passage of a broad single glyph.
 */
const strongInternalTextBoundaries = (
  cluster: StrokeCluster,
  candidates = textCutCandidates(cluster),
) => {
  const physicalHeight = Math.max(1, (cluster.maxY - cluster.minY) * SOURCE_HEIGHT)
  const physicalWidth = Math.max(1, (cluster.maxX - cluster.minX) * SOURCE_WIDTH)
  // Below this ratio there is not enough horizontal room for two ordinary
  // text bodies. Loops inside a, c, m, o or u can still contain deep raster
  // valleys, but they must never turn an isolated glyph into a short word.
  if (physicalWidth / physicalHeight < 0.9) return []
  const minimumWidth = Math.max(4.5, physicalHeight * 0.055)
  const minimumHeight = Math.max(13, physicalHeight * 0.36)
  const edgeGuard = Math.max(5, physicalHeight * 0.065)
  return candidates.filter((candidate) => {
    if (candidate.source === 'density' && candidate.score > 0.3) return false
    if ((candidate.x - cluster.minX) * SOURCE_WIDTH < edgeGuard) return false
    if ((cluster.maxX - candidate.x) * SOURCE_WIDTH < edgeGuard) return false
    if (cluster.detachedTextConnectorRanges?.some(([minX, maxX]) => (
      candidate.x >= minX - 0.004 && candidate.x <= maxX + 0.004
    ))) return false
    const parts = splitTextCluster(cluster, [candidate.x])
    if (parts.length !== 2) return false
    return parts.every((part) => (
      (part.maxX - part.minX) * SOURCE_WIDTH >= minimumWidth &&
      (part.maxY - part.minY) * SOURCE_HEIGHT >= minimumHeight
    ))
  })
}

const textSegmentationEvidence = (
  source: StrokeCluster,
  parts: StrokeCluster[],
  candidates = textCutCandidates(source),
) => {
  if (parts.length < 2) return 0
  const physicalHeight = Math.max(1, (source.maxY - source.minY) * SOURCE_HEIGHT)
  const physicalAspect = (source.maxX - source.minX) * SOURCE_WIDTH / physicalHeight
  const compactDensityScale = clamp((physicalAspect - 1.16) / 0.5)
  const tolerance = Math.max(4, physicalHeight * 0.055) / SOURCE_WIDTH
  let evidence = 0
  for (let index = 1; index < parts.length; index += 1) {
    const boundary = (parts[index - 1].maxX + parts[index].minX) / 2
    const match = candidates
      .filter((candidate) => Math.abs(candidate.x - boundary) <= tolerance)
      .sort((first, second) => (
        Math.abs(first.x - boundary) - Math.abs(second.x - boundary) ||
        first.score - second.score
      ))[0]
    if (!match) continue
    evidence += match.source === 'ink-gap'
      ? 0.54
      : clamp((0.34 - match.score) / 0.34) * 0.34 * compactDensityScale
  }
  return Math.min(0.74, evidence / Math.max(1, parts.length - 1))
}

const distinctInkGapBoundaries = (
  cluster: StrokeCluster,
  candidates = textCutCandidates(cluster),
) => {
  const physicalHeight = Math.max(1, (cluster.maxY - cluster.minY) * SOURCE_HEIGHT)
  const minimumSpacing = Math.max(0.012, physicalHeight * 0.18 / SOURCE_WIDTH)
  const distinct: TextCutCandidate[] = []
  candidates
    .filter((candidate) => candidate.source === 'ink-gap')
    .filter((candidate) => {
      const strokes = cluster.strokes
        .filter((stroke) => stroke.points.length)
        .map((stroke) => ({ stroke, bounds: strokeBounds(stroke) }))
      const left = strokes
        .filter((entry) => (entry.bounds.minX + entry.bounds.maxX) / 2 < candidate.x)
        .sort((first, second) => second.bounds.maxX - first.bounds.maxX)[0]
      const right = strokes
        .filter((entry) => (entry.bounds.minX + entry.bounds.maxX) / 2 >= candidate.x)
        .sort((first, second) => first.bounds.minX - second.bounds.minX)[0]
      if (!left || !right) return true
      const sharedCrossbar = strokes.some((entry) => (
        entry !== left && entry !== right &&
        resemblesTextCrossbarPair(entry.bounds, left.bounds) &&
        resemblesTextCrossbarPair(entry.bounds, right.bounds)
      ))
      return !(
        sharedCrossbar ||
        resemblesTimedTextContinuation(left.stroke, left.bounds, right.stroke, right.bounds) ||
        resemblesTextCrossbarPair(left.bounds, right.bounds) ||
        resemblesTextDotPair(left.bounds, right.bounds)
      )
    })
    .sort((first, second) => first.x - second.x)
    .forEach((candidate) => {
      const previous = distinct.at(-1)
      if (!previous || candidate.x - previous.x >= minimumSpacing) {
        distinct.push(candidate)
      } else if (candidate.score < previous.score) {
        distinct[distinct.length - 1] = candidate
      }
    })
  return distinct.map((candidate) => candidate.x)
}

/** Finds boundaries between separately lifted, full-height letter bodies even
 * when their entry/exit strokes touch by a few pixels. Dots, crossbars and
 * tightly parallel integral strokes are deliberately excluded. */
const distinctPenLiftBodyBoundaries = (cluster: StrokeCluster) => {
  const physicalHeight = Math.max(1, (cluster.maxY - cluster.minY) * SOURCE_HEIGHT)
  const physicalWidth = Math.max(1, (cluster.maxX - cluster.minX) * SOURCE_WIDTH)
  if (physicalWidth / physicalHeight < 0.88) return []
  const bodies = cluster.strokes
    .filter((stroke) => stroke.points.length >= 2)
    .map((stroke) => {
      const bounds = strokeBounds(stroke)
      const width = (bounds.maxX - bounds.minX) * SOURCE_WIDTH
      const height = (bounds.maxY - bounds.minY) * SOURCE_HEIGHT
      return {
        stroke,
        bounds,
        width,
        height,
        centerX: (bounds.minX + bounds.maxX) / 2,
      }
    })
    .filter((entry) => (
      entry.height >= Math.max(18, physicalHeight * 0.58) &&
      entry.width >= Math.max(5, physicalHeight * 0.08)
    ))
    .sort((first, second) => first.centerX - second.centerX)

  const boundaries: number[] = []
  for (let index = 1; index < bodies.length; index += 1) {
    const first = bodies[index - 1]
    const second = bodies[index]
    const sharedCrossbar = cluster.strokes.some((stroke) => {
      if (stroke === first.stroke || stroke === second.stroke) return false
      const bounds = strokeBounds(stroke)
      return (
        resemblesTextCrossbarPair(bounds, first.bounds) &&
        resemblesTextCrossbarPair(bounds, second.bounds)
      )
    })
    if (
      sharedCrossbar ||
      resemblesTimedTextContinuation(first.stroke, first.bounds, second.stroke, second.bounds) ||
      resemblesTextCrossbarPair(first.bounds, second.bounds) ||
      resemblesTextDotPair(first.bounds, second.bounds)
    ) continue
    const centerDistance = (second.centerX - first.centerX) * SOURCE_WIDTH
    if (centerDistance < Math.max(9, physicalHeight * 0.2)) continue
    const overlap = Math.max(
      0,
      (Math.min(first.bounds.maxX, second.bounds.maxX) -
        Math.max(first.bounds.minX, second.bounds.minX)) * SOURCE_WIDTH,
    )
    if (overlap > Math.min(first.width, second.width) * 0.28) continue
    const verticalOverlap = (
      Math.min(first.bounds.maxY, second.bounds.maxY) -
      Math.max(first.bounds.minY, second.bounds.minY)
    ) * SOURCE_HEIGHT
    if (verticalOverlap < Math.min(first.height, second.height) * 0.42) continue
    const boundary = (first.bounds.maxX + second.bounds.minX) / 2
    if ((boundary - cluster.minX) * SOURCE_WIDTH < Math.max(5, physicalHeight * 0.06)) continue
    if ((cluster.maxX - boundary) * SOURCE_WIDTH < Math.max(5, physicalHeight * 0.06)) continue
    const previous = boundaries.at(-1)
    if (previous === undefined || (boundary - previous) * SOURCE_WIDTH >= Math.max(9, physicalHeight * 0.16)) {
      boundaries.push(boundary)
    }
  }
  return boundaries
}

const penLiftTextBodyClusters = (cluster: StrokeCluster) => {
  const boundaries = distinctPenLiftBodyBoundaries(cluster)
  if (!boundaries.length) return []
  const bodyCandidates = cluster.strokes
    .filter((stroke) => stroke.points.length >= 2)
    .map((stroke) => {
      const bounds = strokeBounds(stroke)
      return {
        stroke,
        bounds,
        width: (bounds.maxX - bounds.minX) * SOURCE_WIDTH,
        height: (bounds.maxY - bounds.minY) * SOURCE_HEIGHT,
        centerX: (bounds.minX + bounds.maxX) / 2,
      }
    })
  const physicalHeight = Math.max(1, (cluster.maxY - cluster.minY) * SOURCE_HEIGHT)
  const bodies = bodyCandidates
    .filter((entry) => (
      entry.height >= Math.max(18, physicalHeight * 0.58) &&
      entry.width >= Math.max(5, physicalHeight * 0.08)
    ))
    .sort((first, second) => first.centerX - second.centerX)
  if (bodies.length !== boundaries.length + 1 || bodies.length > 10) return []

  const groups = bodies.map((body) => [body.stroke])
  const bodyStrokes = new Set(bodies.map((body) => body.stroke))
  bodyCandidates.filter((entry) => !bodyStrokes.has(entry.stroke)).forEach((accessory) => {
    const centerX = (accessory.bounds.minX + accessory.bounds.maxX) / 2
    const centerY = (accessory.bounds.minY + accessory.bounds.maxY) / 2
    const closest = bodies
      .map((body, index) => {
        const dx = centerX < body.bounds.minX
          ? body.bounds.minX - centerX
          : centerX > body.bounds.maxX ? centerX - body.bounds.maxX : 0
        const dy = centerY < body.bounds.minY
          ? body.bounds.minY - centerY
          : centerY > body.bounds.maxY ? centerY - body.bounds.maxY : 0
        return { index, distance: dx * SOURCE_WIDTH + dy * SOURCE_HEIGHT * 0.35 }
      })
      .sort((first, second) => first.distance - second.distance)[0]
    if (closest) groups[closest.index].push(accessory.stroke)
  })
  const clusters = groups.flatMap((strokes) => {
    const grouped = clusterFromStrokes(strokes)
    return grouped ? [grouped] : []
  })
  return clusters.length === bodies.length ? clusters : []
}

/** Keeps complete strokes together and uses their real drawing order to find
 * a boundary between two separately written characters. This is deliberately
 * complementary to raster valleys: a narrow `I`, `i` or `l` can disappear in
 * a density bin, while the pen-up sequence still proves that a new glyph was
 * started. Crossbars and dots remain in the temporal group of their letter. */
const temporalPenLiftTextPartitions = (
  cluster: StrokeCluster,
  preferredParts?: number,
) => {
  if (cluster.strokes.length < 2 || (preferredParts !== undefined && preferredParts !== 2)) return []
  const timed = cluster.strokes
    .map((stroke, originalIndex) => {
      const times = stroke.points.map((point) => point.t).filter(Number.isFinite)
      return {
        stroke,
        originalIndex,
        start: times.length ? Math.min(...times) : originalIndex,
        end: times.length ? Math.max(...times) : originalIndex,
      }
    })
    .sort((first, second) => first.start - second.start || first.originalIndex - second.originalIndex)
  const pointIntervals = timed.flatMap(({ stroke }) => stroke.points.slice(1).flatMap((point, index) => {
    const difference = point.t - stroke.points[index].t
    return Number.isFinite(difference) && difference > 0 ? [difference] : []
  })).sort((first, second) => first - second)
  const samplingInterval = pointIntervals.length
    ? pointIntervals[Math.floor(pointIntervals.length / 2)]
    : 1
  const physicalHeight = Math.max(1, (cluster.maxY - cluster.minY) * SOURCE_HEIGHT)
  const candidates: Array<{ parts: StrokeCluster[]; score: number }> = []

  for (let cut = 1; cut < timed.length; cut += 1) {
    const first = clusterFromStrokes(timed.slice(0, cut).map((entry) => entry.stroke))
    const second = clusterFromStrokes(timed.slice(cut).map((entry) => entry.stroke))
    if (!first || !second) continue
    const firstWidth = Math.max(1, (first.maxX - first.minX) * SOURCE_WIDTH)
    const secondWidth = Math.max(1, (second.maxX - second.minX) * SOURCE_WIDTH)
    const firstHeight = Math.max(1, (first.maxY - first.minY) * SOURCE_HEIGHT)
    const secondHeight = Math.max(1, (second.maxY - second.minY) * SOURCE_HEIGHT)
    // A top bar, i-dot or other accessory is never a complete character on
    // its own. Both sides must contain a substantial vertical letter body.
    if (
      firstHeight < Math.max(15, physicalHeight * 0.36) ||
      secondHeight < Math.max(15, physicalHeight * 0.36) ||
      firstWidth < Math.max(3.5, physicalHeight * 0.035) ||
      secondWidth < Math.max(3.5, physicalHeight * 0.035)
    ) continue

    const firstCenterX = (first.minX + first.maxX) / 2
    const secondCenterX = (second.minX + second.maxX) / 2
    const centerDistance = (secondCenterX - firstCenterX) * SOURCE_WIDTH
    const rawGap = Math.max(0, timed[cut].start - timed[cut - 1].end)
    const normalizedGap = rawGap / Math.max(0.5, samplingInterval)
    const strongTemporalBreak = normalizedGap >= 2.25 || rawGap >= 24
    const minimumCenterProgress = strongTemporalBreak
      ? 0.5
      : Math.max(3.5, physicalHeight * 0.055)
    const minimumEdgeProgress = strongTemporalBreak
      ? -3
      : Math.max(3.5, physicalHeight * 0.055)
    if (centerDistance < minimumCenterProgress) continue
    if (
      (second.maxX - first.maxX) * SOURCE_WIDTH < minimumEdgeProgress ||
      (second.minX - first.minX) * SOURCE_WIDTH < minimumEdgeProgress
    ) continue
    const overlap = Math.max(
      0,
      (Math.min(first.maxX, second.maxX) - Math.max(first.minX, second.minX)) * SOURCE_WIDTH,
    )
    const overlapRatio = overlap / Math.max(1, Math.min(firstWidth, secondWidth))
    if (overlapRatio > (strongTemporalBreak ? 1.02 : 0.74)) continue
    const verticalOverlap = (
      Math.min(first.maxY, second.maxY) - Math.max(first.minY, second.minY)
    ) * SOURCE_HEIGHT
    if (verticalOverlap < Math.min(firstHeight, secondHeight) * 0.1) continue

    // Without an external line-length prior, a genuine pause between glyphs
    // is required. With a neural/personal count of two, geometry may open the
    // alternative even when a tablet reports coarse or reset timestamps.
    if (preferredParts !== 2 && !strongTemporalBreak) continue
    const parts = [first, second]
    candidates.push({
      parts,
      score: normalizedGap * 0.12 + centerDistance / physicalHeight * 0.42 - overlapRatio * 0.58,
    })
  }

  return candidates
    .sort((first, second) => second.score - first.score)
    .slice(0, 4)
    .map((entry) => entry.parts)
}

/** Deterministic diagnostics for independent pen-data segmentation audits. */
export const textCutCandidatesForTests = (strokes: Stroke[]) => {
  const cluster = clusterFromStrokes(strokes)
  if (!cluster) return []
  return textCutCandidates(cluster).map((candidate) => ({
    x: candidate.x,
    score: candidate.score,
    source: candidate.source,
  }))
}

/** Estimates separated-letter count from true whitespace between pen lifts. */
export const estimatePenLiftTextCharacterCount = (strokes: Stroke[]) => {
  const cluster = clusterFromStrokes(strokes)
  if (!cluster) return null
  const physicalHeight = Math.max(1, (cluster.maxY - cluster.minY) * SOURCE_HEIGHT)
  const minimumSpacing = Math.max(8, physicalHeight * 0.15)
  const boundaries: number[] = []
  ;[
    ...distinctInkGapBoundaries(cluster),
    ...distinctPenLiftBodyBoundaries(cluster),
  ].sort((first, second) => first - second).forEach((boundary) => {
    if (!boundaries.length || (boundary - boundaries.at(-1)!) * SOURCE_WIDTH >= minimumSpacing) {
      boundaries.push(boundary)
    }
  })
  const count = boundaries.length + 1
  return count >= 2 && count <= 160 ? count : null
}

const snappedTextBoundaries = (
  candidates: TextCutCandidate[],
  minX: number,
  maxX: number,
  parts: number,
) => {
  const width = maxX - minX
  const targetWidth = width / parts
  const selected: TextCutCandidate[] = []
  for (let index = 1; index < parts; index += 1) {
    const target = minX + targetWidth * index
    const match = candidates
      .filter((candidate) => Math.abs(candidate.x - target) <= targetWidth * 0.58)
      .filter((candidate) => selected.every((entry) => Math.abs(entry.x - candidate.x) >= targetWidth * 0.36))
      .sort((first, second) => (
        first.score + Math.abs(first.x - target) / targetWidth * 0.22 -
        second.score - Math.abs(second.x - target) / targetWidth * 0.22
      ))[0]
    if (!match) return []
    selected.push(match)
  }
  return selected.sort((first, second) => first.x - second.x).map((candidate) => candidate.x)
}

/**
 * A connected pair may share one uninterrupted body while its delayed
 * crossbars/dots still expose the transition between the letters. This is
 * especially important for `fF`: the raster valley lies inside both bars,
 * but the right edge of the first f-bar and the separately drawn F stem form
 * a precise ownership boundary. The candidates are only enabled by an
 * explicit two-character prior and never split an isolated glyph on their
 * own.
 */
const guidedTwoPartDelayedStrokeBoundaries = (cluster: StrokeCluster) => {
  const primary = primaryContinuousTextStroke(cluster)
  if (!primary) return []
  const physicalHeight = Math.max(1, (cluster.maxY - cluster.minY) * SOURCE_HEIGHT)
  const edgeGuard = Math.max(5, physicalHeight * 0.06) / SOURCE_WIDTH
  const delayed = cluster.strokes
    .filter((stroke) => stroke !== primary && stroke.points.length >= 2)
    .map((stroke) => {
      const bounds = strokeBounds(stroke)
      return {
        bounds,
        centerX: (bounds.minX + bounds.maxX) / 2,
      }
    })
    .sort((first, second) => first.centerX - second.centerX)
  if (delayed.length < 2) return []

  const candidates: Array<{ x: number; score: number }> = []
  for (let index = 1; index < delayed.length; index += 1) {
    const left = delayed[index - 1]
    const right = delayed[index]
    const centerDistance = (right.centerX - left.centerX) * SOURCE_WIDTH
    if (centerDistance < Math.max(4, physicalHeight * 0.035)) continue
    const gap = Math.max(0, (right.bounds.minX - left.bounds.maxX) * SOURCE_WIDTH)
    const overlap = Math.max(0, (left.bounds.maxX - right.bounds.minX) * SOURCE_WIDTH)
    const boundary = gap > 0
      ? (left.bounds.maxX + right.bounds.minX) / 2
      : (left.centerX + right.centerX) / 2
    if (
      boundary <= cluster.minX + edgeGuard ||
      boundary >= cluster.maxX - edgeGuard
    ) continue
    candidates.push({
      x: boundary,
      // A real blank band between delayed strokes is substantially stronger
      // evidence than their centre distance alone. Overlapping strokes still
      // remain as low-priority alternatives for unusual writing order.
      score: (
        (gap > 0 ? 3 : 0) -
        Math.abs(boundary - (cluster.minX + cluster.maxX) / 2) * SOURCE_WIDTH / physicalHeight * 0.9 -
        overlap / physicalHeight * 0.75
      ),
    })
  }

  const minimumSpacing = Math.max(4, physicalHeight * 0.045) / SOURCE_WIDTH
  const selected: Array<{ x: number; score: number }> = []
  candidates.sort((first, second) => second.score - first.score).forEach((candidate) => {
    if (selected.some((entry) => Math.abs(entry.x - candidate.x) < minimumSpacing)) return
    selected.push(candidate)
  })
  return selected.slice(0, 2).map((entry) => entry.x)
}

/**
 * Tablet drivers can coalesce a narrow pair such as `Ei`, `jJ` or `x1` so
 * aggressively that the rendered raster contains no density valley at all.
 * The pen trajectory still exposes a transition: connector segments are
 * locally long and usually make forward x progress. These candidates are
 * evaluated only with an explicit two-character prior; they never trigger a
 * speculative split of an isolated glyph.
 */
const guidedTwoPartTrajectoryBoundaries = (cluster: StrokeCluster) => {
  const physicalHeight = Math.max(1, (cluster.maxY - cluster.minY) * SOURCE_HEIGHT)
  const edgeGuard = Math.max(5, physicalHeight * 0.06) / SOURCE_WIDTH
  const stroke = [...cluster.strokes]
    .filter((entry) => entry.points.length >= 3)
    .map((entry) => ({
      stroke: entry,
      length: entry.points.slice(1).reduce((sum, point, index) => sum + Math.hypot(
        (point.x - entry.points[index].x) * SOURCE_WIDTH,
        (point.y - entry.points[index].y) * SOURCE_HEIGHT,
      ), 0),
    }))
    .sort((first, second) => second.length - first.length)[0]?.stroke
  if (!stroke) return []
  const segments = stroke.points.slice(1).map((point, index) => {
    const previous = stroke.points[index]
    return {
      index,
      x: (previous.x + point.x) / 2,
      deltaX: (point.x - previous.x) * SOURCE_WIDTH,
      length: Math.hypot(
        (point.x - previous.x) * SOURCE_WIDTH,
        (point.y - previous.y) * SOURCE_HEIGHT,
      ),
    }
  }).filter((entry) => entry.length > 0.2)
  if (!segments.length) return []
  const typicalLength = Math.max(1, median(segments.map((entry) => entry.length)))
  const candidates: Array<{ x: number; score: number }> = []
  segments.forEach((segment) => {
    const interior = segment.x > cluster.minX + edgeGuard && segment.x < cluster.maxX - edgeGuard
    if (!interior || segment.length < Math.max(5, typicalLength * 1.55)) return
    candidates.push({
      x: segment.x,
      score: segment.length / typicalLength + Math.max(0, segment.deltaX) / physicalHeight * 0.8,
    })
  })
  for (let index = 1; index < segments.length; index += 1) {
    const incoming = segments[index - 1]
    const outgoing = segments[index]
    const point = stroke.points[incoming.index + 1]
    if (
      point.x <= cluster.minX + edgeGuard ||
      point.x >= cluster.maxX - edgeGuard ||
      Math.min(incoming.length, outgoing.length) < Math.max(4, typicalLength * 1.35)
    ) continue
    const balance = Math.min(incoming.length, outgoing.length) /
      Math.max(incoming.length, outgoing.length)
    const forwardProgress = Math.max(0, incoming.deltaX + outgoing.deltaX)
    candidates.push({
      x: point.x,
      score: (
        Math.min(incoming.length, outgoing.length) / typicalLength * 0.75 +
        balance * 0.65 +
        forwardProgress / physicalHeight * 0.9
      ),
    })
  }
  const minimumSpacing = Math.max(4, physicalHeight * 0.045) / SOURCE_WIDTH
  const selected: Array<{ x: number; score: number }> = []
  candidates.sort((first, second) => second.score - first.score).forEach((candidate) => {
    if (selected.some((entry) => Math.abs(entry.x - candidate.x) < minimumSpacing)) return
    selected.push(candidate)
  })
  return selected.slice(0, 6).map((entry) => entry.x)
}

/** Returns the untouched cluster plus a small, bounded set of cursive splits. */
export const connectedTextSegmentationHypotheses = (
  cluster: StrokeCluster,
  preferredParts?: number,
  allowCompactDensitySplit = false,
): StrokeCluster[][] => {
  const points = cluster.strokes.flatMap((stroke) => stroke.points)
  const temporalPartitions = temporalPenLiftTextPartitions(cluster, preferredParts)
  // Very economical handwriting can encode two letters in only four to
  // seven sampled points (especially when a tablet driver coalesces events).
  // An explicit line-model/count prior must still be able to open a spatial
  // split. Without such a prior the conservative single-glyph behaviour is
  // retained, so sparse I/l/T strokes are never split speculatively.
  if (points.length < 4 || (points.length < 8 && preferredParts === undefined)) {
    return [[cluster], ...temporalPartitions]
  }
  const minX = Math.min(...points.map((point) => point.x))
  const maxX = Math.max(...points.map((point) => point.x))
  const minY = Math.min(...points.map((point) => point.y))
  const maxY = Math.max(...points.map((point) => point.y))
  const physicalWidth = (maxX - minX) * SOURCE_WIDTH
  const physicalHeight = Math.max(1, (maxY - minY) * SOURCE_HEIGHT)
  const aspect = physicalWidth / physicalHeight
  const usablePreferredParts = Number.isInteger(preferredParts) && preferredParts! >= 2 && preferredParts! <= 10
    ? preferredParts!
    : null
  const firstDetachedConnector = cluster.detachedTextConnectorRanges
    ?.map(([connectorMinX]) => connectorMinX)
    .sort((first, second) => first - second)[0]
  const bodyAspectBeforeConnector = firstDetachedConnector === undefined
    ? aspect
    : (firstDetachedConnector - minX) * SOURCE_WIDTH / physicalHeight
  // A normal single glyph can become artificially "wide" solely because its
  // separately drawn exit stroke extends the bounding box. In that case there
  // is no connected multi-letter body to segment in the first place.
  if (
    firstDetachedConnector !== undefined &&
    bodyAspectBeforeConnector < 1.62 &&
    usablePreferredParts === null
  ) {
    return [[cluster], ...temporalPartitions]
  }
  const penLiftBodyBoundaries = distinctPenLiftBodyBoundaries(cluster)
  const penLiftBodyParts = penLiftTextBodyClusters(cluster)
  const candidates = textCutCandidates(cluster)
  const strongInternalBoundaries = strongInternalTextBoundaries(cluster, candidates)
  if (
    !candidates.length &&
    usablePreferredParts === null &&
    !penLiftBodyParts.length &&
    !temporalPartitions.length
  ) return [[cluster]]
  // A single round or broad handwritten glyph (a, m, w, …) often contains
  // thin internal passages. Those are not word connectors. Actual connected
  // pairs normally exceed this physical aspect threshold; their competing
  // splits are now decided using the complete surrounding word below.
  if (
    aspect < 1.62 &&
    usablePreferredParts === null &&
    !penLiftBodyBoundaries.length &&
    !temporalPartitions.length &&
    !(allowCompactDensitySplit && strongInternalBoundaries.length)
  ) return [[cluster]]

  // Real blank ink bands between separately written letters are much
  // stronger boundaries than the many low-density valleys inside loops and
  // arches.  When their count exactly agrees with an external length prior,
  // use that deterministic split directly instead of enumerating thousands
  // of valley combinations.  Dots and crossbars overlap their letter body in
  // x and therefore do not create an extra ink-gap boundary here.
  const inkGapBoundaries = distinctInkGapBoundaries(cluster, candidates)
  if (usablePreferredParts !== null && inkGapBoundaries.length === usablePreferredParts - 1) {
    const split = splitTextCluster(cluster, inkGapBoundaries)
    // A blank band inside a multi-stroke k/K/H can leave a very narrow stem
    // on one side. That is not a reliable two-letter boundary and must keep
    // competing trajectory/delayed-stroke cuts. Well-sized blank-separated
    // glyphs retain the fast deterministic path used while writing.
    const minimumWidth = usablePreferredParts === 2
      ? Math.max(8, physicalHeight * 0.12)
      : Math.max(5, physicalHeight * 0.07)
    if (
      split.length === usablePreferredParts &&
      split.every((entry) => (entry.maxX - entry.minX) * SOURCE_WIDTH >= minimumWidth)
    ) return [
      [cluster],
      ...(usablePreferredParts === 2
        ? twoPartStrokeOwnershipVariants(cluster, inkGapBoundaries[0], split)
        : [split]),
    ]
  }

  // Connected school handwriting including its entry/exit strokes averages
  // roughly 0.78 physical width per x-height. The former 0.62 prior
  // systematically invented one or two extra letters in words such as
  // "hallo", even with hundreds of perfect personal examples.
  const estimatedParts = Math.max(2, Math.min(10, Math.round(aspect / 0.78)))
  const partCounts = [...new Set([
    ...(usablePreferredParts === null
      ? []
      : [usablePreferredParts, usablePreferredParts - 1, usablePreferredParts + 1]),
    estimatedParts,
    estimatedParts - 1,
    estimatedParts + 1,
    estimatedParts - 2,
    estimatedParts + 2,
  ])]
    .filter((count) => count >= 2 && count <= 10)
  const boundarySets = partCounts.flatMap((count) => {
    const snapped = snappedTextBoundaries(candidates, minX, maxX, count)
    const uniform = Array.from({ length: count - 1 }, (_, index) => (
      minX + (maxX - minX) * (index + 1) / count
    ))
    return [snapped, uniform].filter((boundaries) => boundaries.length)
  })
  const guidedTwoPartBoundaries = usablePreferredParts === 2
    ? [
        ...guidedTwoPartDelayedStrokeBoundaries(cluster),
        ...guidedTwoPartTrajectoryBoundaries(cluster),
      ].map((boundary) => [boundary])
    : []

  const minimumSpacing = Math.max(0.012, physicalHeight * 0.2 / SOURCE_WIDTH)
  const strong: TextCutCandidate[] = []
  ;[...candidates].sort((first, second) => first.score - second.score).forEach((candidate) => {
    if (candidate.score > 0.48 || strong.some((entry) => Math.abs(entry.x - candidate.x) < minimumSpacing)) return
    strong.push(candidate)
  })
  // True low-density valleys carry more information than equal-width cuts,
  // especially for words mixing narrow i/l/t with broad m/w characters.
  // Evaluate a bounded set of exact-length valley combinations before the
  // uniform fallbacks. The old nearest-uniform selection could split a broad
  // m three times while merging a narrow neighbouring f into the next glyph.
  const prioritizedBoundarySets: number[][] = []
  if (usablePreferredParts !== null && strong.length >= usablePreferredParts - 1) {
    const pool = strong
      .slice(0, 14)
      .sort((first, second) => first.x - second.x)
    const required = usablePreferredParts - 1
    const combinations: Array<{ boundaries: number[]; score: number }> = []
    const choose = (start: number, selected: TextCutCandidate[]) => {
      if (selected.length === required) {
        const boundaries = selected.map((candidate) => candidate.x)
        const edges = [minX, ...boundaries, maxX]
        const widths = edges.slice(1).map((edge, index) => (
          (edge - edges[index]) * SOURCE_WIDTH
        ))
        const minimumWidth = Math.max(5, physicalHeight * 0.07)
        if (widths.some((value) => value < minimumWidth)) return
        const extremeWidthPenalty = widths.reduce((sum, value) => {
          const relative = value / physicalHeight
          if (relative < 0.18) return sum + (0.18 - relative) * 0.8
          if (relative > 3.5) return sum + (relative - 3.5) * 0.25
          return sum
        }, 0)
        combinations.push({
          boundaries,
          score: selected.reduce((sum, candidate) => sum + candidate.score, 0) + extremeWidthPenalty,
        })
        return
      }
      const remaining = required - selected.length
      for (let index = start; index <= pool.length - remaining; index += 1) {
        choose(index + 1, [...selected, pool[index]])
      }
    }
    choose(0, [])
    prioritizedBoundarySets.push(...combinations
      .sort((first, second) => first.score - second.score)
      .slice(0, 8)
      .map((entry) => entry.boundaries))
  }
  if (strong.length) prioritizedBoundarySets.push(
    [...strong].sort((first, second) => first.x - second.x).slice(0, 9).map((candidate) => candidate.x),
  )
  boundarySets.unshift(...prioritizedBoundarySets)
  // A trajectory transition is the only evidence that survives a perfectly
  // continuous connector. Evaluate it before generic raster valleys so the
  // bounded hypothesis budget cannot be exhausted by inner loops first.
  boundarySets.unshift(...guidedTwoPartBoundaries)

  const seen = new Set<string>()
  const hypotheses: StrokeCluster[][] = [
    [cluster],
    ...(penLiftBodyParts.length >= 2 ? [penLiftBodyParts] : []),
    ...temporalPartitions,
  ]
  boundarySets.forEach((boundaries) => {
    const crossesProtectedConnector = usablePreferredParts === null && boundaries.some((boundary) => (
      cluster.detachedTextConnectorRanges?.some(([connectorMinX, connectorMaxX]) => {
        const protection = Math.max(0.012, physicalHeight * 0.18 / SOURCE_WIDTH)
        return boundary >= connectorMinX - protection && boundary <= connectorMaxX + protection * 0.35
      })
    ))
    if (crossesProtectedConnector) return
    const key = boundaries.map((value) => value.toFixed(4)).join(':')
    if (!key || seen.has(key) || hypotheses.length >= MAX_TEXT_SEGMENTATION_HYPOTHESES) return
    seen.add(key)
    const split = splitTextCluster(cluster, boundaries)
    if (split.length !== boundaries.length + 1) return
    const variants = usablePreferredParts === 2 && boundaries.length === 1
      ? twoPartStrokeOwnershipVariants(cluster, boundaries[0], split)
      : [split]
    variants.forEach((variant) => {
      if (hypotheses.length >= MAX_TEXT_SEGMENTATION_HYPOTHESES) return
      const widths = variant.map((entry) => (entry.maxX - entry.minX) * SOURCE_WIDTH)
      if (widths.some((width) => width < Math.max(5, physicalHeight * 0.07))) return
      hypotheses.push(variant)
    })
  })
  return hypotheses
}

const resemblesScriptPair = (
  first: ReturnType<typeof strokeBounds>,
  second: ReturnType<typeof strokeBounds>,
) => {
  const firstHeight = first.maxY - first.minY
  const secondHeight = second.maxY - second.minY
  const large = firstHeight >= secondHeight ? first : second
  const small = firstHeight >= secondHeight ? second : first
  const largeWidth = large.maxX - large.minX
  const largeHeight = large.maxY - large.minY
  const smallWidth = small.maxX - small.minX
  const smallHeight = small.maxY - small.minY
  if (smallHeight > largeHeight * 0.74) return false
  if (smallWidth < 0.018 && smallHeight < 0.035) return false

  const smallCenterX = (small.minX + small.maxX) / 2
  const smallCenterY = (small.minY + small.maxY) / 2
  const verticallyRaised = smallCenterY <= large.minY + largeHeight * 0.3
  const verticallyLowered = smallCenterY >= large.minY + largeHeight * 0.7
  const nearRightSide = (
    smallCenterX >= large.minX + largeWidth * 0.32 &&
    small.minX <= large.maxX + Math.max(0.11, largeWidth)
  )
  return nearRightSide && (verticallyRaised || verticallyLowered)
}

const resemblesCenteredLimitPair = (
  first: ReturnType<typeof strokeBounds>,
  second: ReturnType<typeof strokeBounds>,
) => {
  const firstHeight = first.maxY - first.minY
  const secondHeight = second.maxY - second.minY
  const large = firstHeight >= secondHeight ? first : second
  const small = firstHeight >= secondHeight ? second : first
  const largeWidth = large.maxX - large.minX
  const largeHeight = large.maxY - large.minY
  const smallWidth = small.maxX - small.minX
  const smallHeight = small.maxY - small.minY
  if (largeWidth < 0.032 || largeHeight < 0.13 || smallHeight > largeHeight * 0.7) return false
  if (smallWidth < 0.018 && smallHeight < 0.035) return false

  const smallCenterX = (small.minX + small.maxX) / 2
  const smallCenterY = (small.minY + small.maxY) / 2
  const horizontallyNear = (
    smallCenterX >= large.minX - largeWidth * 0.5 &&
    smallCenterX <= large.maxX + Math.max(0.075, largeWidth * 0.85)
  )
  const aboveOrBelow = (
    smallCenterY <= large.minY + largeHeight * 0.28 ||
    smallCenterY >= large.minY + largeHeight * 0.72
  )
  return horizontallyNear && aboveOrBelow
}

/** A separately drawn horizontal bar crossing a tall stem belongs to the
 * same text glyph (`T`, `t`, `F`, `H`, `A`). Compare the original strokes,
 * not only the growing cluster box, so a bar can bridge two stem clusters. */
const resemblesTextCrossbarPair = (
  first: ReturnType<typeof strokeBounds>,
  second: ReturnType<typeof strokeBounds>,
) => {
  const measure = (bounds: ReturnType<typeof strokeBounds>) => ({
    bounds,
    width: (bounds.maxX - bounds.minX) * SOURCE_WIDTH,
    height: (bounds.maxY - bounds.minY) * SOURCE_HEIGHT,
  })
  const firstMeasure = measure(first)
  const secondMeasure = measure(second)
  const horizontal = firstMeasure.width / Math.max(1, firstMeasure.height) >= 1.75
    ? firstMeasure
    : secondMeasure.width / Math.max(1, secondMeasure.height) >= 1.75 ? secondMeasure : null
  const vertical = horizontal === firstMeasure ? secondMeasure : firstMeasure
  if (
    !horizontal ||
    horizontal.width < 8 ||
    vertical.height < 18 ||
    vertical.height / Math.max(1, vertical.width) < 1.35 ||
    // A hand-drawn upper-case T often overhangs strongly on the side where
    // the next letter begins. It is still one indivisible top bar as long as
    // it really meets a tall stem. The old 1.55 limit caused the outer part
    // to be cut off and classified as an extra glyph.
    horizontal.width > Math.max(160, vertical.height * 2.6)
  ) return false
  const horizontalCenterX = (horizontal.bounds.minX + horizontal.bounds.maxX) / 2
  const verticalCenterX = (vertical.bounds.minX + vertical.bounds.maxX) / 2
  const centerAligned = Math.abs(horizontalCenterX - verticalCenterX) * SOURCE_WIDTH <=
    Math.max(20, horizontal.width * 0.38)
  const endpointNearStem = Math.min(
    Math.abs(horizontal.bounds.maxX - vertical.bounds.minX),
    Math.abs(horizontal.bounds.minX - vertical.bounds.maxX),
  ) * SOURCE_WIDTH <= 36
  if (!centerAligned && !endpointNearStem) return false
  const horizontalCenterY = (horizontal.bounds.minY + horizontal.bounds.maxY) / 2
  const verticalHeight = vertical.bounds.maxY - vertical.bounds.minY
  const relativeY = (horizontalCenterY - vertical.bounds.minY) / Math.max(0.0001, verticalHeight)
  const horizontalGap = Math.max(
    0,
    Math.max(horizontal.bounds.minX, vertical.bounds.minX) -
      Math.min(horizontal.bounds.maxX, vertical.bounds.maxX),
  ) * SOURCE_WIDTH
  const verticalGap = Math.max(
    0,
    Math.max(horizontal.bounds.minY, vertical.bounds.minY) -
      Math.min(horizontal.bounds.maxY, vertical.bounds.maxY),
  ) * SOURCE_HEIGHT
  return relativeY >= -0.2 && relativeY <= 0.78 && horizontalGap <= 18 && verticalGap <= 11
}

const resemblesTextDotPair = (
  first: ReturnType<typeof strokeBounds>,
  second: ReturnType<typeof strokeBounds>,
) => {
  const extent = (bounds: ReturnType<typeof strokeBounds>) => Math.max(
    (bounds.maxX - bounds.minX) * SOURCE_WIDTH,
    (bounds.maxY - bounds.minY) * SOURCE_HEIGHT,
  )
  const small = extent(first) <= extent(second) ? first : second
  const body = small === first ? second : first
  const smallWidth = (small.maxX - small.minX) * SOURCE_WIDTH
  const smallHeight = (small.maxY - small.minY) * SOURCE_HEIGHT
  const bodyWidth = (body.maxX - body.minX) * SOURCE_WIDTH
  const bodyHeight = (body.maxY - body.minY) * SOURCE_HEIGHT
  // Real tablet dots are often short hooks or tiny loops rather than points,
  // but they still remain materially smaller than the letter body. Without
  // this relative guard a complete neighbouring e can be mistaken for the
  // dot/accessory of a preceding t and the two letters collapse again.
  if (
    smallWidth > 66 ||
    smallHeight > 60 ||
    bodyHeight < 18 ||
    smallHeight > bodyHeight * 0.55 ||
    smallWidth / Math.max(1, smallHeight) > 2.8
  ) return false
  const smallCenterX = (small.minX + small.maxX) / 2
  // A dot may be slightly off-centre, but a neighbouring t/T crossbar must
  // never be stolen as the dot of the next letter during a word split.
  const horizontalTolerance = Math.max(0.07, (body.maxX - body.minX) * 0.72)
  if (smallCenterX < body.minX - horizontalTolerance || smallCenterX > body.maxX + horizontalTolerance) {
    return false
  }
  const bodyCenterY = (body.minY + body.maxY) / 2
  if (small.maxY > bodyCenterY) return false
  const verticalGap = Math.max(0, body.minY - small.maxY) * SOURCE_HEIGHT
  return (
    verticalGap <= Math.max(220, bodyHeight * 2.15) &&
    bodyWidth <= Math.max(290, bodyHeight * 2.35) &&
    bodyWidth / Math.max(1, bodyHeight) <= 2.25
  )
}

/**
 * Selects the body that genuinely owns a detached dot or crossbar. Merely
 * taking the nearest bounding-box centre is unsafe: a wide T bar can have its
 * centre inside the following letter even though it physically starts on the
 * T stem. The score favours a real vertical contact, the expected vertical
 * placement and, only then, horizontal proximity.
 */
const textAccessoryAttachmentScore = (
  accessory: ReturnType<typeof strokeBounds>,
  body: ReturnType<typeof strokeBounds>,
) => {
  const accessoryWidth = (accessory.maxX - accessory.minX) * SOURCE_WIDTH
  const accessoryHeight = (accessory.maxY - accessory.minY) * SOURCE_HEIGHT
  const bodyWidth = Math.max(1, (body.maxX - body.minX) * SOURCE_WIDTH)
  const bodyHeight = Math.max(1, (body.maxY - body.minY) * SOURCE_HEIGHT)
  const accessoryCenterX = (accessory.minX + accessory.maxX) / 2
  const bodyCenterX = (body.minX + body.maxX) / 2
  const horizontalDistance = Math.abs(accessoryCenterX - bodyCenterX) * SOURCE_WIDTH
  const horizontalOverlap = Math.max(
    0,
    (Math.min(accessory.maxX, body.maxX) - Math.max(accessory.minX, body.minX)) * SOURCE_WIDTH,
  )
  const verticalGap = Math.max(
    0,
    Math.max(accessory.minY, body.minY) - Math.min(accessory.maxY, body.maxY),
  ) * SOURCE_HEIGHT
  const horizontal = accessoryWidth / Math.max(1, accessoryHeight) >= 1.75
  if (!horizontal) {
    return horizontalDistance + verticalGap * 0.72
  }
  const accessoryCenterY = (accessory.minY + accessory.maxY) / 2
  const relativeY = (accessoryCenterY - body.minY) / Math.max(0.0001, body.maxY - body.minY)
  const verticalPlacementPenalty = relativeY < -0.22
    ? (-0.22 - relativeY) * bodyHeight
    : relativeY > 0.8 ? (relativeY - 0.8) * bodyHeight : 0
  const bodyAspect = bodyWidth / bodyHeight
  return (
    horizontalDistance * 0.22 +
    verticalGap * 2.1 +
    verticalPlacementPenalty * 0.72 +
    bodyAspect * 5.5 -
    Math.min(horizontalOverlap, bodyWidth) * 0.34
  )
}

const resemblesTimedTextContinuation = (
  firstStroke: Stroke,
  first: ReturnType<typeof strokeBounds>,
  secondStroke: Stroke,
  second: ReturnType<typeof strokeBounds>,
) => {
  const range = (stroke: Stroke) => {
    const times = stroke.points.map((point) => point.t).filter(Number.isFinite)
    return times.length ? { start: Math.min(...times), end: Math.max(...times) } : null
  }
  const firstRange = range(firstStroke)
  const secondRange = range(secondStroke)
  if (!firstRange || !secondRange) return false
  const earlier = firstRange.start <= secondRange.start ? firstRange : secondRange
  const later = firstRange.start <= secondRange.start ? secondRange : firstRange
  // Reset/overlapping legacy timestamps do not prove that two pen lifts form
  // one glyph. Treating them as a zero-duration pause merged independent
  // letters such as `te` and `st`. Real same-glyph continuations retain a
  // strictly increasing tablet timeline; dots/crossbars have spatial guards.
  if (later.start <= earlier.end) return false
  const intervals = [firstStroke, secondStroke].flatMap((stroke) => (
    stroke.points.slice(1).flatMap((point, index) => {
      const difference = point.t - stroke.points[index].t
      return Number.isFinite(difference) && difference > 0 ? [difference] : []
    })
  )).sort((left, right) => left - right)
  const sampling = intervals.length ? intervals[Math.floor(intervals.length / 2)] : 1
  const gap = Math.max(0, later.start - earlier.end)
  if (gap / Math.max(0.5, sampling) > 1.8 || gap > 10) return false

  const firstWidth = (first.maxX - first.minX) * SOURCE_WIDTH
  const secondWidth = (second.maxX - second.minX) * SOURCE_WIDTH
  const firstHeight = (first.maxY - first.minY) * SOURCE_HEIGHT
  const secondHeight = (second.maxY - second.minY) * SOURCE_HEIGHT
  const horizontalGap = Math.max(0, Math.max(first.minX, second.minX) - Math.min(first.maxX, second.maxX)) * SOURCE_WIDTH
  const verticalOverlap = (
    Math.min(first.maxY, second.maxY) - Math.max(first.minY, second.minY)
  ) * SOURCE_HEIGHT
  const combinedWidth = (Math.max(first.maxX, second.maxX) - Math.min(first.minX, second.minX)) * SOURCE_WIDTH
  const combinedHeight = Math.max(1, (Math.max(first.maxY, second.maxY) - Math.min(first.minY, second.minY)) * SOURCE_HEIGHT)
  return (
    horizontalGap <= Math.max(32, Math.max(firstHeight, secondHeight) * 0.13) &&
    verticalOverlap >= Math.min(firstHeight, secondHeight) * 0.18 &&
    // Some writers build one broad `w`/`W` from two immediately consecutive,
    // overlapping bodies. The strict time gate above still rejects separately
    // written neighbouring letters, whose pen-up pause is materially longer.
    combinedWidth / combinedHeight <= 2.55 &&
    Math.max(firstWidth, secondWidth) >= 4
  )
}

const resemblesTextAccessoryPair = (
  first: ReturnType<typeof strokeBounds>,
  second: ReturnType<typeof strokeBounds>,
) => {
  const firstExtent = Math.max(
    (first.maxX - first.minX) * SOURCE_WIDTH,
    (first.maxY - first.minY) * SOURCE_HEIGHT,
  )
  const secondExtent = Math.max(
    (second.maxX - second.minX) * SOURCE_WIDTH,
    (second.maxY - second.minY) * SOURCE_HEIGHT,
  )
  const small = firstExtent <= secondExtent ? first : second
  const large = firstExtent <= secondExtent ? second : first
  const smallWidth = (small.maxX - small.minX) * SOURCE_WIDTH
  const smallHeight = (small.maxY - small.minY) * SOURCE_HEIGHT
  const largeWidth = Math.max(1, (large.maxX - large.minX) * SOURCE_WIDTH)
  const largeHeight = Math.max(1, (large.maxY - large.minY) * SOURCE_HEIGHT)
  if (largeHeight < 18) return false
  if (smallWidth > Math.max(20, largeWidth * 0.52) || smallHeight > Math.max(17, largeHeight * 0.3)) {
    return false
  }

  const smallCenterX = (small.minX + small.maxX) / 2
  const largeCenterX = (large.minX + large.maxX) / 2
  const horizontalTolerance = Math.max(0.012, (large.maxX - large.minX) * 0.34)
  const horizontallyAligned = (
    smallCenterX >= large.minX - horizontalTolerance &&
    smallCenterX <= large.maxX + horizontalTolerance &&
    Math.abs(smallCenterX - largeCenterX) <= Math.max(0.03, (large.maxX - large.minX) * 0.72)
  )
  if (!horizontallyAligned) return false

  const above = small.maxY <= large.minY + (large.maxY - large.minY) * 0.34
  if (!above) return false
  const verticalGap = Math.max(0, large.minY - small.maxY)
  return verticalGap <= Math.max(0.052, (large.maxY - large.minY) * 0.62)
}

const resemblesDetachedTextConnector = (
  letter: ReturnType<typeof strokeBounds>,
  connector: { stroke: Stroke; bounds: ReturnType<typeof strokeBounds> },
) => {
  if (connector.stroke.points.length < 2) return false
  const letterWidth = Math.max(0.0001, letter.maxX - letter.minX)
  const letterHeight = Math.max(0.0001, letter.maxY - letter.minY)
  const connectorWidth = connector.bounds.maxX - connector.bounds.minX
  const connectorHeight = connector.bounds.maxY - connector.bounds.minY
  const letterWidthPixels = letterWidth * SOURCE_WIDTH
  const letterHeightPixels = letterHeight * SOURCE_HEIGHT
  const connectorWidthPixels = connectorWidth * SOURCE_WIDTH
  const connectorHeightPixels = connectorHeight * SOURCE_HEIGHT
  if (letterHeightPixels < 18 || connectorWidthPixels < 5) return false
  if (
    connectorWidthPixels > Math.max(34, letterWidthPixels * 0.72) ||
    connectorHeightPixels > Math.max(20, letterHeightPixels * 0.4)
  ) {
    return false
  }

  const horizontalGap = Math.max(0, connector.bounds.minX - letter.maxX)
  const connectorCenterY = (connector.bounds.minY + connector.bounds.maxY) / 2
  const relativeCenterY = (connectorCenterY - letter.minY) / letterHeight
  const besideRightEdge = (
    connector.bounds.maxX > letter.maxX &&
    connector.bounds.minX >= letter.minX + letterWidth * 0.48 &&
    horizontalGap <= Math.max(0.012, letterWidth * 0.28)
  )
  if (!besideRightEdge || relativeCenterY < 0.48 || relativeCenterY > 1.16) return false

  const firstPoint = connector.stroke.points[0]
  const lastPoint = connector.stroke.points.at(-1)!
  const leftEndpoint = firstPoint.x <= lastPoint.x ? firstPoint : lastPoint
  const rightEndpoint = firstPoint.x <= lastPoint.x ? lastPoint : firstPoint
  const endpointNearLetter = (
    leftEndpoint.x <= letter.maxX + Math.max(0.014, letterWidth * 0.3) &&
    leftEndpoint.x >= letter.minX + letterWidth * 0.42 &&
    leftEndpoint.y >= letter.minY + letterHeight * 0.42 &&
    leftEndpoint.y <= letter.maxY + letterHeight * 0.16
  )
  const extendsRight = rightEndpoint.x - leftEndpoint.x >= Math.max(0.0045, connectorWidth * 0.38)
  const connectorAspect = connectorWidthPixels / Math.max(1, connectorHeightPixels)
  return endpointNearLetter && extendsRight && connectorAspect >= 0.9
}

export const segmentStrokes = (strokes: Stroke[], mode: RecognitionMode = 'math'): StrokeCluster[] => {
  const candidates = strokes
    .filter((stroke) => stroke.points.length > 0)
    .map((stroke) => ({ stroke, bounds: strokeBounds(stroke) }))
    .sort((a, b) => a.bounds.minX - b.bounds.minX)

  const radicalGroups: { strokes: Set<Stroke>; bounds: ReturnType<typeof strokeBounds> }[] = mode === 'math'
    ? candidates
      .filter((candidate) => isRadicalContainer(candidate, candidates.filter((other) => other !== candidate)))
      .map((candidate) => ({ strokes: new Set([candidate.stroke]), bounds: candidate.bounds }))
    : []

  if (mode === 'math') candidates
    .filter((candidate) => !radicalGroups.some((group) => group.strokes.has(candidate.stroke)))
    .filter(isRadicalHookStroke)
    .forEach((hook) => {
      const hookWidth = hook.bounds.maxX - hook.bounds.minX
      const hookHeight = hook.bounds.maxY - hook.bounds.minY
      const bar = candidates
        .filter((candidate) => candidate !== hook)
        .filter((candidate) => isHorizontalBarStroke(candidate.bounds))
        .filter((candidate) => {
          const barCenterY = (candidate.bounds.minY + candidate.bounds.maxY) / 2
          return (
            candidate.bounds.minX >= hook.bounds.minX + hookWidth * 0.45 &&
            candidate.bounds.minX <= hook.bounds.maxX + 0.035 &&
            barCenterY <= hook.bounds.minY + hookHeight * 0.28
          )
        })
        .sort((a, b) => a.bounds.minX - b.bounds.minX)[0]
      if (!bar) return
      const bounds = combinedBounds(hook.bounds, bar.bounds)
      const hasInnerContent = candidates.some((candidate) =>
        candidate !== hook && candidate !== bar && liesInsideRadical(bounds, candidate.bounds),
      )
      if (hasInnerContent) radicalGroups.push({ strokes: new Set([hook.stroke, bar.stroke]), bounds })
    })

  const fractionGroups = mode === 'math' ? candidates.flatMap((bar, index) => {
    if (!isHorizontalBarStroke(bar.bounds)) return []
    const barWidth = bar.bounds.maxX - bar.bounds.minX
    const barCenterY = (bar.bounds.minY + bar.bounds.maxY) / 2
    const overlapsBar = (bounds: ReturnType<typeof strokeBounds>) => {
      const centerX = (bounds.minX + bounds.maxX) / 2
      return centerX >= bar.bounds.minX - barWidth * 0.04 && centerX <= bar.bounds.maxX + barWidth * 0.04
    }
    const isSubstantive = (bounds: ReturnType<typeof strokeBounds>) =>
      bounds.maxX - bounds.minX >= Math.max(0.018, barWidth * 0.08) || bounds.maxY - bounds.minY >= 0.035
    const numerator = candidates.filter((candidate) =>
      candidate !== bar &&
      overlapsBar(candidate.bounds) &&
      candidate.bounds.maxY < barCenterY - 0.006 &&
      isSubstantive(candidate.bounds),
    )
    const denominator = candidates.filter((candidate) =>
      candidate !== bar &&
      overlapsBar(candidate.bounds) &&
      candidate.bounds.minY > barCenterY + 0.006 &&
      isSubstantive(candidate.bounds),
    )
    if (numerator.length === 0 || denominator.length === 0) return []
    return [{
      id: `fraction-${index}`,
      bar: bar.stroke,
      numerator: new Set(numerator.map((candidate) => candidate.stroke)),
      denominator: new Set(denominator.map((candidate) => candidate.stroke)),
    }]
  }) : []

  const fractionRole = (stroke: Stroke, group: (typeof fractionGroups)[number]) => {
    if (group.bar === stroke) return 'bar' as const
    if (group.numerator.has(stroke)) return 'numerator' as const
    if (group.denominator.has(stroke)) return 'denominator' as const
    return null
  }

  const areOppositeScripts = (
    first: { stroke: Stroke; bounds: ReturnType<typeof strokeBounds> },
    second: { stroke: Stroke; bounds: ReturnType<typeof strokeBounds> },
  ) => candidates.some((anchor) => {
    if (anchor === first || anchor === second) return false
    if (!resemblesScriptPair(anchor.bounds, first.bounds) || !resemblesScriptPair(anchor.bounds, second.bounds)) {
      return false
    }
    const anchorCenterY = (anchor.bounds.minY + anchor.bounds.maxY) / 2
    const firstCenterY = (first.bounds.minY + first.bounds.maxY) / 2
    const secondCenterY = (second.bounds.minY + second.bounds.maxY) / 2
    return (
      (firstCenterY < anchorCenterY && secondCenterY > anchorCenterY) ||
      (secondCenterY < anchorCenterY && firstCenterY > anchorCenterY)
    )
  })

  const mustStaySeparate = (first: Stroke, second: Stroke) => {
    const firstCandidate = candidates.find((candidate) => candidate.stroke === first)
    const secondCandidate = candidates.find((candidate) => candidate.stroke === second)
    if (!firstCandidate || !secondCandidate) return false
    for (const group of fractionGroups) {
      const firstRole = fractionRole(first, group)
      const secondRole = fractionRole(second, group)
      if (firstRole && secondRole && firstRole !== secondRole) return true
    }
    for (const group of radicalGroups) {
      if (group.strokes.has(first) && group.strokes.has(second)) return false
      if (group.strokes.has(first) && liesInsideRadical(group.bounds, secondCandidate.bounds)) return true
      if (group.strokes.has(second) && liesInsideRadical(group.bounds, firstCandidate.bounds)) return true
    }
    const horizontalOverlap = Math.min(firstCandidate.bounds.maxX, secondCandidate.bounds.maxX) -
      Math.max(firstCandidate.bounds.minX, secondCandidate.bounds.minX)
    const verticalOverlap = Math.min(firstCandidate.bounds.maxY, secondCandidate.bounds.maxY) -
      Math.max(firstCandidate.bounds.minY, secondCandidate.bounds.minY)
    // Serifs, crossbars and equality/operator strokes that physically touch
    // are parts of the same glyph, never a super-/subscript relation.
    if (horizontalOverlap >= -0.004 && verticalOverlap >= -0.004) return false
    if (mode === 'math' && areOppositeScripts(firstCandidate, secondCandidate)) return true
    if (mode === 'math' && resemblesScriptPair(firstCandidate.bounds, secondCandidate.bounds)) return true
    if (mode === 'math' && resemblesCenteredLimitPair(firstCandidate.bounds, secondCandidate.bounds)) return true
    return false
  }

  const shareRadicalGroup = (first: Stroke, second: Stroke) =>
    radicalGroups.some((group) => group.strokes.has(first) && group.strokes.has(second))

  const clusters: StrokeCluster[] = []
  candidates.forEach(({ stroke, bounds }) => {
    const matching = clusters.filter((cluster) => {
      if (cluster.strokes.some((existing) => shareRadicalGroup(existing, stroke))) return true
      if (cluster.strokes.some((existing) => mustStaySeparate(existing, stroke))) return false
      const horizontalOverlap = Math.min(cluster.maxX, bounds.maxX) - Math.max(cluster.minX, bounds.minX)
      const horizontalGap = Math.max(bounds.minX - cluster.maxX, cluster.minX - bounds.maxX, 0)
      const verticalGap = Math.max(bounds.minY - cluster.maxY, cluster.minY - bounds.maxY, 0)
      if (mode === 'text') {
        const clusterBounds = {
          minX: cluster.minX,
          minY: cluster.minY,
          maxX: cluster.maxX,
          maxY: cluster.maxY,
        }
        if (resemblesTextAccessoryPair(clusterBounds, bounds)) return true
        if (cluster.strokes.some((existing) => (
          resemblesTextCrossbarPair(strokeBounds(existing), bounds) ||
          resemblesTextDotPair(strokeBounds(existing), bounds) ||
          resemblesTimedTextContinuation(existing, strokeBounds(existing), stroke, bounds)
        ))) return true
        if (resemblesDetachedTextConnector(clusterBounds, { stroke, bounds })) return true
        const clusterHeight = cluster.maxY - cluster.minY
        const strokeHeight = bounds.maxY - bounds.minY
        const allowedVerticalGap = Math.max(0.042, Math.max(clusterHeight, strokeHeight) * 0.5)
        if (verticalGap > allowedVerticalGap) return false
      } else {
        const clusterHeight = cluster.maxY - cluster.minY
        const strokeHeight = bounds.maxY - bounds.minY
        const allowedVerticalGap = Math.max(0.085, Math.max(clusterHeight, strokeHeight) * 0.85)
        if (verticalGap > allowedVerticalGap) return false
      }
      return horizontalOverlap >= -0.001 || horizontalGap < 0.004
    })

    if (matching.length === 0) {
      clusters.push({ strokes: [stroke], ...bounds })
      return
    }

    const target = matching[0]
    const detachedConnectorMatch = mode === 'text' && resemblesDetachedTextConnector(
      {
        minX: target.minX,
        minY: target.minY,
        maxX: target.maxX,
        maxY: target.maxY,
      },
      { stroke, bounds },
    )
    if (detachedConnectorMatch) {
      target.detachedTextConnectorRanges = [
        ...(target.detachedTextConnectorRanges ?? []),
        [bounds.minX, bounds.maxX],
      ]
      target.detachedTextConnectorStrokes = [
        ...(target.detachedTextConnectorStrokes ?? []),
        stroke,
      ]
    }
    target.strokes.push(stroke)
    target.minX = Math.min(target.minX, bounds.minX)
    target.minY = Math.min(target.minY, bounds.minY)
    target.maxX = Math.max(target.maxX, bounds.maxX)
    target.maxY = Math.max(target.maxY, bounds.maxY)

    matching.slice(1).forEach((cluster) => {
      target.strokes.push(...cluster.strokes)
      target.minX = Math.min(target.minX, cluster.minX)
      target.minY = Math.min(target.minY, cluster.minY)
      target.maxX = Math.max(target.maxX, cluster.maxX)
      target.maxY = Math.max(target.maxY, cluster.maxY)
      target.detachedTextConnectorRanges = [
        ...(target.detachedTextConnectorRanges ?? []),
        ...(cluster.detachedTextConnectorRanges ?? []),
      ]
      target.detachedTextConnectorStrokes = [
        ...(target.detachedTextConnectorStrokes ?? []),
        ...(cluster.detachedTextConnectorStrokes ?? []),
      ]
      clusters.splice(clusters.indexOf(cluster), 1)
    })
  })

  clusters.forEach((cluster) => {
    const ownBarGroup = fractionGroups.find((group) => cluster.strokes.includes(group.bar))
    if (ownBarGroup) {
      cluster.fraction = { type: 'fraction', groupId: ownBarGroup.id, role: 'bar' }
      return
    }
    for (const group of fractionGroups) {
      const roles = cluster.strokes.map((stroke) => fractionRole(stroke, group)).filter(Boolean)
      if (roles.length === 0) continue
      const role = roles[0]
      if (roles.every((entry) => entry === role) && role) {
        cluster.fraction = { type: 'fraction', groupId: group.id, role }
        break
      }
    }
  })

  return clusters.sort((a, b) => a.minX - b.minX)
}

type RecognitionInkLine = {
  strokes: Stroke[]
  minY: number
  maxY: number
  centerY: number
}

/**
 * Splits a page into physical writing rows while keeping stacked mathematical
 * structures (fractions, roots, limits and scripts) together.
 */
export const groupRecognitionLines = (strokes: Stroke[]): RecognitionInkLine[] => {
  const entries = strokes.flatMap((stroke) => {
    if (!stroke.points.length) return []
    const bounds = strokeBounds(stroke)
    const width = Math.max(1, (bounds.maxX - bounds.minX) * SOURCE_WIDTH)
    const height = Math.max(1, (bounds.maxY - bounds.minY) * SOURCE_HEIGHT)
    return [{
      stroke,
      ...bounds,
      width,
      height,
      centerX: (bounds.minX + bounds.maxX) / 2,
      centerY: (bounds.minY + bounds.maxY) / 2,
    }]
  })
  if (!entries.length) return []

  const gap = (firstStart: number, firstEnd: number, secondStart: number, secondEnd: number) => (
    Math.max(0, Math.max(firstStart, secondStart) - Math.min(firstEnd, secondEnd))
  )
  const related = (first: (typeof entries)[number], second: (typeof entries)[number]) => {
    const horizontalGap = gap(first.minX, first.maxX, second.minX, second.maxX) * SOURCE_WIDTH
    const verticalGap = gap(first.minY, first.maxY, second.minY, second.maxY) * SOURCE_HEIGHT
    const typicalHeight = Math.max(8, Math.min(55, (first.height + second.height) / 2))
    const largestHeight = Math.max(first.height, second.height)
    const horizontalNeighbour = (
      horizontalGap <= Math.max(36, typicalHeight * 1.35) &&
      verticalGap <= Math.max(10, typicalHeight * 0.42) &&
      Math.abs(first.centerY - second.centerY) * SOURCE_HEIGHT <= Math.max(15, largestHeight * 0.78)
    )
    const resemblesLongMathMark = (entry: (typeof entries)[number]) => (
      entry.width >= typicalHeight * 1.5 &&
      entry.height <= Math.max(12, typicalHeight * 0.62)
    )
    const longMathMark = (
      (resemblesLongMathMark(first) || resemblesLongMathMark(second)) &&
      horizontalGap <= Math.max(18, typicalHeight * 0.62) &&
      verticalGap <= Math.max(39, largestHeight * 1.7)
    )
    const large = first.height >= second.height ? first : second
    const small = first.height >= second.height ? second : first
    const smallCenterX = small.centerX * SOURCE_WIDTH
    const largeLeft = large.minX * SOURCE_WIDTH
    const largeRight = large.maxX * SOURCE_WIDTH
    const scriptOrLimit = (
      small.height <= large.height * 0.76 &&
      smallCenterX >= largeLeft - Math.max(24, large.width * 0.72) &&
      smallCenterX <= largeRight + Math.max(36, large.width * 1.8) &&
      verticalGap <= Math.max(38, large.height * 0.58)
    )
    return horizontalNeighbour || longMathMark || scriptOrLimit
  }

  const remaining = new Set(entries.map((_, index) => index))
  const components: number[][] = []
  while (remaining.size) {
    const seed = remaining.values().next().value as number
    remaining.delete(seed)
    const component = [seed]
    const queue = [seed]
    while (queue.length) {
      const current = queue.shift()!
      for (const candidate of [...remaining]) {
        if (!related(entries[current], entries[candidate])) continue
        remaining.delete(candidate)
        component.push(candidate)
        queue.push(candidate)
      }
    }
    components.push(component)
  }

  const componentBounds = (indexes: number[]) => {
    const selected = indexes.map((index) => entries[index])
    const minY = Math.min(...selected.map((entry) => entry.minY))
    const maxY = Math.max(...selected.map((entry) => entry.maxY))
    return {
      indexes,
      minY,
      maxY,
      centerY: (minY + maxY) / 2,
    }
  }
  const rows: Array<ReturnType<typeof componentBounds>> = []
  components
    .map(componentBounds)
    .sort((first, second) => first.centerY - second.centerY)
    .forEach((component) => {
      const componentHeight = (component.maxY - component.minY) * SOURCE_HEIGHT
      const matching = rows
        .map((row) => ({
          row,
          distance: Math.abs(row.centerY - component.centerY) * SOURCE_HEIGHT,
          rowHeight: (row.maxY - row.minY) * SOURCE_HEIGHT,
        }))
        .filter(({ rowHeight, distance }) => (
          distance <= Math.max(18, Math.min(rowHeight, componentHeight) * 0.68)
        ))
        .sort((first, second) => first.distance - second.distance)[0]
      if (!matching) {
        rows.push(component)
        return
      }
      matching.row.indexes.push(...component.indexes)
      const combined = componentBounds(matching.row.indexes)
      matching.row.minY = combined.minY
      matching.row.maxY = combined.maxY
      matching.row.centerY = combined.centerY
    })

  return rows
    .sort((first, second) => first.centerY - second.centerY)
    .map((row) => ({
      strokes: [...row.indexes]
        .sort((first, second) => first - second)
        .map((index) => entries[index].stroke),
      minY: row.minY,
      maxY: row.maxY,
      centerY: row.centerY,
    }))
}

const renderCluster = (cluster: StrokeCluster) => {
  const strokes = cluster.strokes
  const points = strokes.flatMap((stroke) => stroke.points)
  const widestStroke = Math.max(...strokes.map((stroke) => stroke.baseWidth * 1.5), 1)
  const minX = Math.max(0, Math.min(...points.map((point) => point.x * SOURCE_WIDTH)) - widestStroke)
  const maxX = Math.min(SOURCE_WIDTH, Math.max(...points.map((point) => point.x * SOURCE_WIDTH)) + widestStroke)
  const minY = Math.max(0, Math.min(...points.map((point) => point.y * SOURCE_HEIGHT)) - widestStroke)
  const maxY = Math.min(SOURCE_HEIGHT, Math.max(...points.map((point) => point.y * SOURCE_HEIGHT)) + widestStroke)
  const boxWidth = Math.max(maxX - minX, widestStroke * 2)
  const boxHeight = Math.max(maxY - minY, widestStroke * 2)
  const scale = Math.min(
    (OUTPUT_SIZE - OUTPUT_MARGIN * 2) / boxWidth,
    (OUTPUT_SIZE - OUTPUT_MARGIN * 2) / boxHeight,
  )
  const offsetX = (OUTPUT_SIZE - boxWidth * scale) / 2
  const offsetY = (OUTPUT_SIZE - boxHeight * scale) / 2
  const canvas = document.createElement('canvas')
  canvas.width = OUTPUT_SIZE
  canvas.height = OUTPUT_SIZE
  const context = canvas.getContext('2d')!
  context.fillStyle = '#ffffff'
  context.fillRect(0, 0, OUTPUT_SIZE, OUTPUT_SIZE)
  context.strokeStyle = '#142b2a'
  context.fillStyle = '#142b2a'
  context.lineCap = 'round'
  context.lineJoin = 'round'

  strokes.forEach((stroke) => {
    if (stroke.points.length === 1) {
      const point = stroke.points[0]
      context.beginPath()
      context.arc(
        offsetX + (point.x * SOURCE_WIDTH - minX) * scale,
        offsetY + (point.y * SOURCE_HEIGHT - minY) * scale,
        (pressureWidth(stroke, point.pressure) * scale) / 2,
        0,
        Math.PI * 2,
      )
      context.fill()
      return
    }

    for (let index = 1; index < stroke.points.length; index += 1) {
      const previous = stroke.points[index - 1]
      const point = stroke.points[index]
      context.beginPath()
      context.moveTo(
        offsetX + (previous.x * SOURCE_WIDTH - minX) * scale,
        offsetY + (previous.y * SOURCE_HEIGHT - minY) * scale,
      )
      context.lineTo(
        offsetX + (point.x * SOURCE_WIDTH - minX) * scale,
        offsetY + (point.y * SOURCE_HEIGHT - minY) * scale,
      )
      context.lineWidth = pressureWidth(stroke, (previous.pressure + point.pressure) / 2) * scale
      context.stroke()
    }
  })

  const bbox = [
    minX / SOURCE_WIDTH,
    minY / SOURCE_HEIGHT,
    boxWidth / SOURCE_WIDTH,
    boxHeight / SOURCE_HEIGHT,
  ].map((value) => Math.round(value * 100_000) / 100_000) as [number, number, number, number]

  return {
    canvas,
    imageData: canvas.toDataURL('image/png'),
    bbox,
  }
}

const shiftedCosineSimilarity = (first: Float32Array, second: Float32Array) => {
  let best = 0
  for (let shiftY = -1; shiftY <= 1; shiftY += 1) {
    for (let shiftX = -1; shiftX <= 1; shiftX += 1) {
      let product = 0
      let firstMagnitude = 0
      let secondMagnitude = 0
      for (let y = 0; y < FEATURE_SIZE; y += 1) {
        const shiftedY = y + shiftY
        if (shiftedY < 0 || shiftedY >= FEATURE_SIZE) continue
        for (let x = 0; x < FEATURE_SIZE; x += 1) {
          const shiftedX = x + shiftX
          if (shiftedX < 0 || shiftedX >= FEATURE_SIZE) continue
          const a = first[y * FEATURE_SIZE + x]
          const b = second[shiftedY * FEATURE_SIZE + shiftedX]
          product += a * b
          firstMagnitude += a * a
          secondMagnitude += b * b
        }
      }
      const similarity = product / Math.sqrt(Math.max(0.000001, firstMagnitude * secondMagnitude))
      best = Math.max(best, similarity)
    }
  }
  return best
}

const vectorCosineSimilarity = (first: Float32Array, second: Float32Array) => {
  let product = 0
  let firstMagnitude = 0
  let secondMagnitude = 0
  for (let index = 0; index < Math.min(first.length, second.length); index += 1) {
    product += first[index] * second[index]
    firstMagnitude += first[index] * first[index]
    secondMagnitude += second[index] * second[index]
  }
  if (firstMagnitude < 0.000001 && secondMagnitude < 0.000001) return 1
  if (firstMagnitude < 0.000001 || secondMagnitude < 0.000001) return 0
  return product / Math.sqrt(firstMagnitude * secondMagnitude)
}

const meanVectorDistance = (first: Float32Array, second: Float32Array) => {
  let distance = 0
  const length = Math.min(first.length, second.length)
  for (let index = 0; index < length; index += 1) distance += Math.abs(first[index] - second[index])
  return length ? distance / length : 0
}

const projectionDistance = (first: FeatureVector, second: FeatureVector) => {
  let distance = 0
  for (let index = 0; index < FEATURE_SIZE; index += 1) {
    distance += Math.abs(first.projectionX[index] - second.projectionX[index])
    distance += Math.abs(first.projectionY[index] - second.projectionY[index])
  }
  return distance / (FEATURE_SIZE * 2)
}

const trajectoryPathDistance = (
  first: Float32Array,
  second: Float32Array,
  reverseSecond = false,
) => {
  const points = Math.min(first.length, second.length) / 4
  if (!points) return 1
  let distance = 0
  for (let index = 0; index < points; index += 1) {
    const secondIndex = reverseSecond ? points - 1 - index : index
    const firstOffset = index * 4
    const secondOffset = secondIndex * 4
    const position = Math.hypot(
      first[firstOffset] - second[secondOffset],
      first[firstOffset + 1] - second[secondOffset + 1],
    )
    const tangentProduct = clamp(
      Math.abs(
        first[firstOffset + 2] * second[secondOffset + 2] +
        first[firstOffset + 3] * second[secondOffset + 3],
      ),
    )
    distance += clamp(position / 0.48) * 0.76 + (1 - tangentProduct) * 0.24
  }
  return distance / points
}

const trajectorySetDistance = (first: Float32Array[], second: Float32Array[]) => {
  if (!first.length && !second.length) return 0
  if (!first.length || !second.length) return 1
  const smaller = first.length <= second.length ? first : second
  const larger = first.length <= second.length ? second : first
  const costs = smaller.map((path) => larger.map((candidate) => Math.min(
    trajectoryPathDistance(path, candidate),
    trajectoryPathDistance(path, candidate, true),
  )))

  // Exact assignment for normal glyphs. Use a compact numeric DP instead of
  // allocating a Map and closures for every training-sample comparison: this
  // function is called hundreds of thousands of times for a large personal
  // model. The result is identical, but the hot path creates far less garbage
  // and therefore avoids long GC pauses while writing connected words.
  let matched = 0
  if (smaller.length === 1) {
    matched = Math.min(...costs[0])
  } else if (larger.length <= 8) {
    const stateCount = 1 << larger.length
    let states = new Float64Array(stateCount)
    states.fill(Number.POSITIVE_INFINITY)
    states[0] = 0
    costs.forEach((row) => {
      const next = new Float64Array(stateCount)
      next.fill(Number.POSITIVE_INFINITY)
      for (let mask = 0; mask < stateCount; mask += 1) {
        const score = states[mask]
        if (!Number.isFinite(score)) continue
        for (let index = 0; index < row.length; index += 1) {
          if (mask & (1 << index)) continue
          const nextMask = mask | (1 << index)
          next[nextMask] = Math.min(next[nextMask], score + row[index])
        }
      }
      states = next
    })
    matched = Number.POSITIVE_INFINITY
    for (let mask = 0; mask < stateCount; mask += 1) {
      matched = Math.min(matched, states[mask])
    }
  } else {
    const used = new Set<number>()
    costs.forEach((row) => {
      let bestIndex = -1
      let bestCost = Number.POSITIVE_INFINITY
      for (let index = 0; index < row.length; index += 1) {
        if (!used.has(index) && row[index] < bestCost) {
          bestIndex = index
          bestCost = row[index]
        }
      }
      if (bestIndex >= 0) {
        used.add(bestIndex)
        matched += bestCost
      }
    })
  }
  const unmatched = larger.length - smaller.length
  return clamp((matched + unmatched * 0.58) / larger.length)
}

const channelDistances = (
  first: FeatureVector,
  second: FeatureVector,
  firstGeometry: StrokeGeometry,
  secondGeometry: StrokeGeometry,
  firstStrokeCount: number,
  secondStrokeCount: number,
): FeatureWeights => ({
  raster: 1 - shiftedCosineSimilarity(first.raster, second.raster),
  hog: 1 - vectorCosineSimilarity(first.hog, second.hog),
  projections: projectionDistance(first, second),
  shape: meanVectorDistance(first.shape, second.shape),
  directions: 1 - vectorCosineSimilarity(firstGeometry.directions, secondGeometry.directions),
  geometry: (
    Math.abs(firstGeometry.normalizedLength - secondGeometry.normalizedLength) * 0.35 +
    Math.abs(firstGeometry.closedness - secondGeometry.closedness) * 0.4 +
    Math.abs(firstGeometry.cornerness - secondGeometry.cornerness) * 0.25
  ),
  trajectory: trajectorySetDistance(firstGeometry.trajectory, secondGeometry.trajectory),
  holes: Math.min(1, Math.abs(first.holes - second.holes) / 2),
  strokes: Math.min(1, Math.abs(firstStrokeCount - secondStrokeCount) / 3),
})

const weightedDistance = (channels: FeatureWeights, weights: FeatureWeights) => (
  channels.raster * weights.raster +
  channels.hog * weights.hog +
  channels.projections * weights.projections +
  channels.shape * weights.shape +
  channels.directions * weights.directions +
  channels.geometry * weights.geometry +
  channels.trajectory * weights.trajectory +
  channels.holes * weights.holes +
  channels.strokes * weights.strokes
)

const featureDistance = (
  feature: FeatureVector,
  training: RecognitionModelEntry,
  strokeCount: number,
  geometry: StrokeGeometry,
  weights: FeatureWeights,
) => {
  let distance = Number.POSITIVE_INFINITY
  const activeWeights = training.standard ? STANDARD_WEIGHTS : weights
  const variants = [training, ...training.variants]
  for (let index = 0; index < variants.length; index += 1) {
    distance = Math.min(distance, weightedDistance(
      channelDistances(feature, variants[index], geometry, training.geometry, strokeCount, training.strokeCount),
      activeWeights,
    ))
  }
  // A close personal match is more informative than a generic printed form.
  // The augmentation and shrinkage prototype keep this one-shot preference
  // bounded even when only a single personal sample exists.
  return training.standard ? distance : Math.max(0, distance - PERSONAL_SAMPLE_DISTANCE_BONUS)
}

const averageVector = (vectors: Float32Array[], normalize = false) => {
  const output = new Float32Array(vectors[0]?.length ?? 0)
  vectors.forEach((vector) => vector.forEach((value, index) => { output[index] += value }))
  if (vectors.length) {
    for (let index = 0; index < output.length; index += 1) output[index] /= vectors.length
  }
  return normalize ? normalizeVector(output) : output
}

const blendVectors = (
  personal: Float32Array,
  baseline: Float32Array,
  personalWeight = PERSONAL_PROTOTYPE_WEIGHT,
  normalize = false,
) => {
  const output = new Float32Array(Math.min(personal.length, baseline.length))
  for (let index = 0; index < output.length; index += 1) {
    output[index] = personal[index] * personalWeight + baseline[index] * (1 - personalWeight)
  }
  return normalize ? normalizeVector(output) : output
}

const buildClassPrototypes = (entries: RecognitionModelEntry[]) => {
  const groups = new Map<string, RecognitionModelEntry[]>()
  entries.forEach((entry) => {
    const group = groups.get(entry.labelId) ?? []
    group.push(entry)
    groups.set(entry.labelId, group)
  })
  const prototypes = new Map<string, RecognitionModelEntry>()
  groups.forEach((group, labelId) => {
    const personal = group.filter((entry) => !entry.standard)
    const standard = group.filter((entry) => entry.standard)
    const basis = personal.length ? personal : standard
    if (basis.length < 2 && !(personal.length === 1 && standard.length)) return
    const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length
    const personalFeature = personal.length === 1 ? personal[0] : null
    const standardFeature = personalFeature && standard.length
      ? {
          raster: averageVector(standard.map((entry) => entry.raster)),
          projectionX: averageVector(standard.map((entry) => entry.projectionX)),
          projectionY: averageVector(standard.map((entry) => entry.projectionY)),
          hog: averageVector(standard.map((entry) => entry.hog), true),
          shape: averageVector(standard.map((entry) => entry.shape)),
          holes: Math.round(mean(standard.map((entry) => entry.holes))),
        }
      : null
    const featureVector = (key: 'raster' | 'projectionX' | 'projectionY' | 'hog' | 'shape', normalize = false) => (
      personalFeature && standardFeature
        ? blendVectors(personalFeature[key], standardFeature[key], PERSONAL_PROTOTYPE_WEIGHT, normalize)
        : averageVector(basis.map((entry) => entry[key]), normalize)
    )
    prototypes.set(labelId, {
      sampleId: `prototype-${labelId}`,
      sessionId: personalFeature?.sessionId ?? basis[0].sessionId,
      labelId,
      raster: featureVector('raster'),
      projectionX: featureVector('projectionX'),
      projectionY: featureVector('projectionY'),
      hog: featureVector('hog', true),
      shape: featureVector('shape'),
      holes: personalFeature && standardFeature
        ? Math.round(
            personalFeature.holes * PERSONAL_PROTOTYPE_WEIGHT +
            standardFeature.holes * (1 - PERSONAL_PROTOTYPE_WEIGHT),
          )
        : Math.round(mean(basis.map((entry) => entry.holes))),
      strokeCount: Math.round(mean(basis.map((entry) => entry.strokeCount))),
      physicalAspect: Math.exp(mean(basis.map((entry) => Math.log(entry.physicalAspect)))),
      geometry: {
        directions: averageVector(basis.map((entry) => entry.geometry.directions), true),
        normalizedLength: mean(basis.map((entry) => entry.geometry.normalizedLength)),
        closedness: mean(basis.map((entry) => entry.geometry.closedness)),
        cornerness: mean(basis.map((entry) => entry.geometry.cornerness)),
        trajectory: personalFeature?.geometry.trajectory ?? basis[0].geometry.trajectory,
      },
      variants: [],
      standard: personal.length === 0,
      trust: personal.length ? Math.max(...personal.map((entry) => entry.trust)) : 0,
      createdAt: personal.length ? Math.max(...personal.map((entry) => entry.createdAt)) : 0,
    })
  })
  return prototypes
}

const buildClassPrototypeSets = (
  entries: RecognitionModelEntry[],
  weights: FeatureWeights,
) => {
  const groups = new Map<string, RecognitionModelEntry[]>()
  entries.filter((entry) => !entry.standard).forEach((entry) => {
    const group = groups.get(entry.labelId) ?? []
    group.push(entry)
    groups.set(entry.labelId, group)
  })
  const result = new Map<string, RecognitionModelEntry[]>()
  groups.forEach((group, labelId) => {
    if (!group.length) return
    const trusted = group.filter((entry) => entry.trust >= 0.3)
    const usable = trusted.length ? trusted : group
    const maximum = Math.min(5, Math.max(1, Math.ceil(Math.sqrt(usable.length / 3))))
    const ordered = [...usable].sort((first, second) => (
      second.trust - first.trust ||
      second.createdAt - first.createdAt
    ))
    const selected = [ordered[0]]
    while (selected.length < maximum && selected.length < ordered.length) {
      const next = ordered
        .filter((candidate) => !selected.includes(candidate))
        .map((candidate) => ({
          candidate,
          distance: Math.min(...selected.map((prototype) => weightedDistance(
            channelDistances(
              candidate,
              prototype,
              candidate.geometry,
              prototype.geometry,
              candidate.strokeCount,
              prototype.strokeCount,
            ),
            weights,
          ))),
        }))
        .sort((first, second) => (
          second.distance - first.distance ||
          second.candidate.trust - first.candidate.trust ||
          second.candidate.createdAt - first.candidate.createdAt
        ))[0]?.candidate
      if (!next) break
      selected.push(next)
    }
    result.set(labelId, selected)
  })
  return result
}

const buildClassifierEntries = (
  entries: RecognitionModelEntry[],
  prototypeSets: Map<string, RecognitionModelEntry[]>,
) => {
  const groups = new Map<string, RecognitionModelEntry[]>()
  entries.filter((entry) => !entry.standard).forEach((entry) => {
    const group = groups.get(entry.labelId) ?? []
    group.push(entry)
    groups.set(entry.labelId, group)
  })
  const standardGroups = new Map<string, RecognitionModelEntry[]>()
  entries.filter((entry) => entry.standard).forEach((entry) => {
    const group = standardGroups.get(entry.labelId) ?? []
    group.push(entry)
    standardGroups.set(entry.labelId, group)
  })
  const standard = [...standardGroups.entries()].flatMap(([labelId, group]) => (
    groups.has(labelId)
      // Keep a compact, style-spanning base reference beside trained classes.
      // The main classifier below still uses only personal examples for a
      // trained label; these entries exist solely as an independent baseline
      // for calibrated consensus/conflict decisions.
      ? evenlySpaced(group, MAX_BASE_CLASSIFIER_EXAMPLES_PER_LABEL)
      : group
  ))
  const personal = [...groups.entries()].flatMap(([labelId, group]) => {
    if (group.length <= MAX_CLASSIFIER_EXAMPLES_PER_LABEL) return group
    const prototypes = prototypeSets.get(labelId) ?? []
    const pinned = new Set(prototypes.map((entry) => entry.sampleId))
    const ordered = group
      .filter((entry) => !pinned.has(entry.sampleId))
      .sort((first, second) => (
        second.trust - first.trust ||
        second.createdAt - first.createdAt
      ))
    return [
      ...prototypes,
      ...spreadAcrossHistory(
        ordered,
        Math.max(0, MAX_CLASSIFIER_EXAMPLES_PER_LABEL - prototypes.length),
      ),
    ].slice(0, MAX_CLASSIFIER_EXAMPLES_PER_LABEL)
  })
  return [...personal, ...standard]
}

const directEntryDistance = (
  first: RecognitionModelEntry,
  second: RecognitionModelEntry,
  weights: FeatureWeights,
) => weightedDistance(
  channelDistances(
    first,
    second,
    first.geometry,
    second.geometry,
    first.strokeCount,
    second.strokeCount,
  ),
  weights,
)

const suppressSupersededPersonalConflicts = (entries: RecognitionModelEntry[]) => {
  const personal = entries
    .filter((entry) => !entry.standard)
    .sort((first, second) => (
      second.trust - first.trust ||
      second.createdAt - first.createdAt
    ))
  const representatives = new Map<string, RecognitionModelEntry[]>()
  personal.forEach((entry) => {
    const group = representatives.get(entry.labelId) ?? []
    if (group.length < 10) group.push(entry)
    representatives.set(entry.labelId, group)
  })
  personal.forEach((entry) => {
    const hasNewerDivergentOwnCore = (representatives.get(entry.labelId) ?? []).some((candidate) => (
      candidate.sessionId !== entry.sessionId &&
      candidate.createdAt > entry.createdAt + 60_000 &&
      directEntryDistance(entry, candidate, DEFAULT_WEIGHTS) >= 0.14
    ))
    const superseding = [...representatives.entries()]
      .filter(([labelId]) => labelId !== entry.labelId)
      .flatMap(([, group]) => group)
      .filter((candidate) => (
        (
          candidate.trust >= 0.99 &&
          entry.trust <= 0.9 &&
          candidate.createdAt >= entry.createdAt
        ) ||
        (
          entry.trust <= 0.34 &&
          candidate.trust >= 0.8
        ) ||
        (
          candidate.sessionId !== entry.sessionId &&
          candidate.createdAt > entry.createdAt + 60_000 &&
          hasNewerDivergentOwnCore
        )
      ))
      .filter((candidate) => Math.abs(candidate.strokeCount - entry.strokeCount) <= 1)
      .map((candidate) => ({
        candidate,
        distance: directEntryDistance(entry, candidate, DEFAULT_WEIGHTS),
      }))
      .filter(({ distance }) => distance <= 0.072)
      .sort((first, second) => (
        first.distance - second.distance ||
        second.candidate.trust - first.candidate.trust ||
        second.candidate.createdAt - first.candidate.createdAt
      ))[0]
    if (superseding) entry.trust = Math.min(entry.trust, 0.16)
  })
}

const percentile = (values: number[], fraction: number) => {
  if (!values.length) return 0
  const sorted = [...values].sort((first, second) => first - second)
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * fraction))]
}

const buildAspectStats = (entries: RecognitionModelEntry[]) => {
  const groups = new Map<string, RecognitionModelEntry[]>()
  entries.forEach((entry) => {
    const group = groups.get(entry.labelId) ?? []
    group.push(entry)
    groups.set(entry.labelId, group)
  })
  const result = new Map<string, RecognitionAspectStats>()
  groups.forEach((group, labelId) => {
    const personal = group.filter((entry) => !entry.standard && entry.trust >= 0.3)
    const basis = personal.length ? personal : group
    const logs = basis.map((entry) => Math.log(entry.physicalAspect))
    const center = percentile(logs, 0.5)
    const deviations = logs.map((value) => Math.abs(value - center))
    result.set(labelId, {
      median: Math.exp(center),
      spread: basis.length > 1
        ? clamp(percentile(deviations, 0.86) * 1.7 + 0.08, 0.14, personal.length ? 0.48 : 0.58)
        : personal.length ? 0.3 : 0.38,
      personal: personal.length > 0,
    })
  })
  return result
}

const buildLabelStats = (
  entries: RecognitionModelEntry[],
  prototypes: Map<string, RecognitionModelEntry[]>,
  weights: FeatureWeights,
) => {
  const groups = new Map<string, RecognitionModelEntry[]>()
  entries.forEach((entry) => {
    const group = groups.get(entry.labelId) ?? []
    group.push(entry)
    groups.set(entry.labelId, group)
  })
  const stats = new Map<string, RecognitionLabelStats>()
  groups.forEach((group, labelId) => {
    const withinDistances = group.flatMap((entry) => {
      const peers = group.filter((candidate) => candidate !== entry)
      return peers.length ? [Math.min(...peers.map((peer) => directEntryDistance(entry, peer, weights)))] : []
    })
    const radius = withinDistances.length
      ? clamp(percentile(withinDistances, 0.86) * 1.3 + 0.018, 0.055, 0.42)
      : 0.19
    const separationScores = group.map((entry) => {
      const same = group
        .filter((candidate) => candidate !== entry)
        .map((candidate) => directEntryDistance(entry, candidate, weights))
        .sort((first, second) => first - second)[0] ?? radius * 0.7
      const other = [...prototypes.entries()]
        .filter(([candidateLabel]) => candidateLabel !== labelId)
        .flatMap(([, candidates]) => candidates.map((candidate) => directEntryDistance(entry, candidate, weights)))
        .sort((first, second) => first - second)[0] ?? same + 0.18
      return clamp((other - same + 0.035) / 0.16)
    })
    const measuredReliability = separationScores.reduce((sum, value) => sum + value, 0) /
      Math.max(1, separationScores.length)
    const aspectLogs = group.map((entry) => Math.log(entry.physicalAspect))
    const aspectMedianLog = percentile(aspectLogs, 0.5)
    const aspectDeviations = aspectLogs.map((value) => Math.abs(value - aspectMedianLog))
    // A minimum spread accepts natural day-to-day size variation. A large
    // imported corpus may widen it, but never enough for a two-letter group
    // to become a normal example of one trained character.
    const aspectSpread = group.length > 1
      ? clamp(percentile(aspectDeviations, 0.86) * 1.7 + 0.08, 0.14, 0.48)
      : 0.3
    const trustedCount = group.filter((entry) => entry.trust >= 0.8).length
    const trustedRatio = trustedCount / Math.max(1, group.length)
    const reliability = measuredReliability * (0.42 + trustedRatio * 0.58)
    stats.set(labelId, {
      personalCount: group.length,
      trustedCount,
      radius,
      aspectMedian: Math.exp(aspectMedianLog),
      aspectSpread,
      reliability: group.length === 1
        ? Math.max(0.58, reliability)
        : clamp(reliability, 0.22, 1),
    })
  })
  return stats
}

const learnAdaptiveWeights = (entries: RecognitionModelEntry[]): FeatureWeights => {
  const groups = new Map<string, RecognitionModelEntry[]>()
  entries.forEach((entry) => {
    const group = groups.get(entry.labelId) ?? []
    group.push(entry)
    groups.set(entry.labelId, group)
  })
  groups.forEach((group) => group.sort((first, second) => (
    second.trust - first.trust ||
    second.createdAt - first.createdAt
  )))
  const selected: RecognitionModelEntry[] = []
  for (let depth = 0; selected.length < 180; depth += 1) {
    let added = false
    groups.forEach((group) => {
      if (selected.length >= 180 || !group[depth]) return
      selected.push(group[depth])
      added = true
    })
    if (!added) break
  }
  const within = Object.fromEntries(Object.keys(DEFAULT_WEIGHTS).map((key) => [key, 0])) as FeatureWeights
  const between = Object.fromEntries(Object.keys(DEFAULT_WEIGHTS).map((key) => [key, 0])) as FeatureWeights
  let withinCount = 0
  let betweenCount = 0

  for (let firstIndex = 0; firstIndex < selected.length; firstIndex += 1) {
    for (let secondIndex = firstIndex + 1; secondIndex < selected.length; secondIndex += 1) {
      if (betweenCount + withinCount > 5_000) break
      const first = selected[firstIndex]
      const second = selected[secondIndex]
      const distances = channelDistances(
        first,
        second,
        first.geometry,
        second.geometry,
        first.strokeCount,
        second.strokeCount,
      )
      const target = first.labelId === second.labelId ? within : between
      ;(Object.keys(target) as (keyof FeatureWeights)[]).forEach((key) => { target[key] += distances[key] })
      if (first.labelId === second.labelId) withinCount += 1
      else betweenCount += 1
    }
  }
  if (withinCount < 2 || betweenCount < 2) return { ...DEFAULT_WEIGHTS }

  const weights = { ...DEFAULT_WEIGHTS }
  ;(Object.keys(weights) as (keyof FeatureWeights)[]).forEach((key) => {
    const withinMean = within[key] / withinCount
    const betweenMean = between[key] / betweenCount
    const reliability = clamp((betweenMean + 0.035) / (withinMean + 0.035), 0.65, 1.7)
    weights[key] = DEFAULT_WEIGHTS[key] * reliability
  })
  const total = Object.values(weights).reduce((sum, value) => sum + value, 0)
  ;(Object.keys(weights) as (keyof FeatureWeights)[]).forEach((key) => { weights[key] /= total })
  return weights
}

const estimateModelAccuracy = (entries: RecognitionModelEntry[], weights: FeatureWeights) => {
  const groups = new Map<string, RecognitionModelEntry[]>()
  entries.forEach((entry) => {
    const group = groups.get(entry.labelId) ?? []
    group.push(entry)
    groups.set(entry.labelId, group)
  })
  const eligibleGroups = [...groups.values()]
    .filter((group) => group.length > 1)
    .map((group) => [...group].sort((first, second) => (
      second.trust - first.trust || second.createdAt - first.createdAt
    )))
  const evaluated: RecognitionModelEntry[] = []
  for (let depth = 0; evaluated.length < 128; depth += 1) {
    let added = false
    eligibleGroups.forEach((group) => {
      if (evaluated.length >= 128 || depth >= 4 || !group[depth]) return
      evaluated.push(group[depth])
      added = true
    })
    if (!added) break
  }
  if (evaluated.length < 4) return { accuracy: null, count: 0, score: -1 }
  const results = new Map<string, { correct: number; count: number }>()
  evaluated.forEach((entry) => {
    const alternatives = evaluated.filter((candidate) => candidate.sampleId !== entry.sampleId)
    const candidatesByLabel = new Map<string, RecognitionModelEntry[]>()
    alternatives.forEach((candidate) => {
      const group = candidatesByLabel.get(candidate.labelId) ?? []
      group.push(candidate)
      candidatesByLabel.set(candidate.labelId, group)
    })
    // Match the production classifier's robust local consensus. A single
    // atypical sample must not make an otherwise well learned class look bad.
    // Cross-session examples are preferred per class (not globally): a session
    // containing only some labels must never remove every valid candidate for
    // the other labels from the holdout evaluation.
    const consensusWeights = [0.62, 0.25, 0.13]
    const nearest = [...candidatesByLabel.entries()]
      .map(([labelId, labelCandidates]) => {
        const crossSession = labelCandidates.filter((candidate) => candidate.sessionId !== entry.sessionId)
        const usable = crossSession.length ? crossSession : labelCandidates
        const distances = usable
          .map((candidate) => weightedDistance(
            channelDistances(
              entry,
              candidate,
              entry.geometry,
              candidate.geometry,
              entry.strokeCount,
              candidate.strokeCount,
            ),
            weights,
          ))
          .sort((first, second) => first - second)
          .slice(0, consensusWeights.length)
        const weightTotal = consensusWeights
          .slice(0, distances.length)
          .reduce((sum, value) => sum + value, 0)
        return {
          labelId,
          distance: distances.reduce((sum, distance, index) => (
            sum + distance * consensusWeights[index]
          ), 0) / Math.max(Number.EPSILON, weightTotal),
        }
      })
      .sort((a, b) => a.distance - b.distance)[0]
    const result = results.get(entry.labelId) ?? { correct: 0, count: 0 }
    result.count += 1
    if (nearest?.labelId === entry.labelId) result.correct += 1
    results.set(entry.labelId, result)
  })
  const classScores = [...results.values()].map((result) => result.correct / Math.max(1, result.count))
  const score = classScores.reduce((sum, value) => sum + value, 0) / Math.max(1, classScores.length)
  return {
    accuracy: Math.round(score * 1_000) / 10,
    count: evaluated.length,
    score,
  }
}

const LARGE_OPERATOR_IDS = new Set([
  'operator_sum',
  'operator_product',
  'operator_integral',
  'operator_double_integral',
  'operator_triple_integral',
  'operator_contour_integral',
  'operator_big_union',
  'operator_big_intersection',
])

const resemblesProductOperatorStrokes = (strokes: Stroke[]) => {
  const points = strokes.flatMap((stroke) => stroke.points)
  if (points.length < 4) return false
  const minX = Math.min(...points.map((point) => point.x))
  const maxX = Math.max(...points.map((point) => point.x))
  const minY = Math.min(...points.map((point) => point.y))
  const maxY = Math.max(...points.map((point) => point.y))
  const widthPixels = Math.max(1, (maxX - minX) * SOURCE_WIDTH)
  const heightPixels = Math.max(1, (maxY - minY) * SOURCE_HEIGHT)
  if (widthPixels < 18 || heightPixels < 34) return false
  const segments = strokes.flatMap((stroke) => stroke.points.slice(1).map((point, index) => ({
    first: stroke.points[index],
    second: point,
  })))
  const verticals = segments.filter(({ first, second }) => {
    const deltaX = Math.abs(second.x - first.x) * SOURCE_WIDTH
    const deltaY = Math.abs(second.y - first.y) * SOURCE_HEIGHT
    return deltaY >= heightPixels * 0.42 && deltaX <= Math.max(12, deltaY * 0.28)
  }).map(({ first, second }) => (first.x + second.x) / 2)
  const separatedVerticals = verticals.some((firstX, firstIndex) => (
    verticals.slice(firstIndex + 1).some((secondX) => (
      Math.abs(secondX - firstX) * SOURCE_WIDTH >= widthPixels * 0.34
    ))
  ))
  const topBar = segments.some(({ first, second }) => {
    const deltaX = Math.abs(second.x - first.x) * SOURCE_WIDTH
    const deltaY = Math.abs(second.y - first.y) * SOURCE_HEIGHT
    const centerY = (first.y + second.y) / 2
    return deltaX >= widthPixels * 0.42 &&
      deltaY <= Math.max(12, deltaX * 0.3) &&
      centerY <= minY + (maxY - minY) * 0.32
  })
  return separatedVerticals && topBar
}

const applyContextualReranking = (
  tokens: RecognitionToken[],
  labels: LabelDefinition[],
  layoutExamples: MathLayoutExample[] = [],
) => {
  const result = tokens.map((token) => ({ ...token }))
  const groups = new Map<string, RecognitionToken[]>()
  result.filter((token) => !token.isLayout).forEach((token) => {
    const key = token.layout
      ? `${token.layout.groupId}:${token.layout.role}`
      : 'top-level'
    const group = groups.get(key) ?? []
    group.push(token)
    groups.set(key, group)
  })

  const useLabel = (token: RecognitionToken, labelId: string, exactGeometry = false) => {
    if (token.labelId === labelId) return
    const alternative = token.alternatives.find((entry) => entry.labelId === labelId)
    const label = labels.find((entry) => entry.id === labelId)
    if ((!alternative && !exactGeometry) || !label) return
    token.labelId = label.id
    token.char = label.char
    token.name = label.name
    token.latex = label.latex
    token.confidence = Math.max(token.confidence, alternative?.confidence ?? 74)
    if (!alternative) {
      token.alternatives = [{
        labelId: label.id,
        char: label.char,
        name: label.name,
        confidence: token.confidence,
      }, ...token.alternatives]
    }
  }

  const isDigit = (token?: RecognitionToken) => Boolean(token?.labelId.startsWith('digit_'))
  const isLetter = (token?: RecognitionToken) => Boolean(
    token?.labelId.startsWith('latin_') || token?.labelId.startsWith('greek_'),
  )
  const isDecimalMark = (token?: RecognitionToken) => Boolean(
    token?.labelId === 'decimal_point' || token?.labelId === 'decimal_comma',
  )
  const isOperand = (token?: RecognitionToken) => Boolean(
    token && (
      isDigit(token) ||
      isLetter(token) ||
      token.labelId === 'symbol_infinity' ||
      token.labelId === 'set_empty' ||
      token.labelId === 'bracket_right_round' ||
      token.labelId === 'bracket_right_square' ||
      token.labelId === 'bracket_right_curly' ||
      token.labelId === 'operator_factorial' ||
      token.labelId === 'operator_prime'
    ),
  )
  const isMathSyntax = (token?: RecognitionToken) => Boolean(token && (
    token.labelId.startsWith('operator_') ||
    token.labelId.startsWith('relation_') ||
    token.labelId.startsWith('arrow_')
  ))
  const protectedLimitTokenIds = new Set<string>()

  groups.forEach((group) => {
    group.sort((a, b) => a.bbox[0] - b.bbox[0])
    group.forEach((anchor) => {
      const existingLargeOperator = LARGE_OPERATOR_IDS.has(anchor.labelId)
        ? anchor.alternatives.find((entry) => entry.labelId === anchor.labelId)
        : undefined
      const largeOperatorCandidate = existingLargeOperator ?? anchor.alternatives
        .filter((entry) => LARGE_OPERATOR_IDS.has(entry.labelId))
        .sort((first, second) => second.confidence - first.confidence)[0]
      if (!largeOperatorCandidate) return
      const currentVisualConfidence = anchor.alternatives
        .find((entry) => entry.labelId === anchor.labelId)?.confidence ?? anchor.confidence
      const visuallyPlausibleLargeOperator = (
        LARGE_OPERATOR_IDS.has(anchor.labelId) ||
        largeOperatorCandidate.confidence >= currentVisualConfidence - 8 ||
        (
          largeOperatorCandidate.labelId === 'operator_product' &&
          resemblesProductOperatorStrokes(anchor.strokes)
        )
      )
      // Superscripts and subscripts are valid on ordinary variables and
      // numbers too. Their layout may confirm an already plausible large
      // operator, but must never turn a clear `2` (or another operand) into ∑.
      if (!visuallyPlausibleLargeOperator) return
      const [anchorX, anchorY, anchorWidth, anchorHeight] = anchor.bbox
      const spatialLimits = group.filter((candidate) => {
        if (candidate === anchor || candidate.isLayout || LARGE_OPERATOR_IDS.has(candidate.labelId)) return false
        const [x, y, width, height] = candidate.bbox
        if (height > anchorHeight * 0.78) return false
        const centerX = x + width / 2
        const centerY = y + height / 2
        const horizontallyNear = (
          centerX >= anchorX - anchorWidth * 0.5 &&
          centerX <= anchorX + anchorWidth * 2.1 + 0.025
        )
        const verticallyApart = (
          centerY <= anchorY + anchorHeight * 0.3 ||
          centerY >= anchorY + anchorHeight * 0.7
        )
        const learnedMatch = Math.min(
          learnedRelationDistance(
            largeOperatorCandidate.labelId,
            candidate.labelId,
            anchor.bbox,
            candidate.bbox,
            'upper_limit',
            layoutExamples,
          ),
          learnedRelationDistance(
            largeOperatorCandidate.labelId,
            candidate.labelId,
            anchor.bbox,
            candidate.bbox,
            'lower_limit',
            layoutExamples,
          ),
        ) < 0.72
        return (horizontallyNear && verticallyApart) || learnedMatch
      })
      if (spatialLimits.length) {
        useLabel(anchor, largeOperatorCandidate.labelId)
        spatialLimits.forEach((candidate) => {
          protectedLimitTokenIds.add(candidate.id)
          const shapes = candidate.strokes.map((stroke) => {
            const bounds = strokeBounds(stroke)
            return {
              bounds,
              aspect: (
                (bounds.maxX - bounds.minX) * SOURCE_WIDTH /
                Math.max(1, (bounds.maxY - bounds.minY) * SOURCE_HEIGHT)
              ),
            }
          })
          const horizontal = shapes.find((entry) => entry.aspect >= 2.2)
          const vertical = shapes.find((entry) => entry.aspect <= 0.48)
          const oneWithBase = Boolean(horizontal && vertical && (
            (horizontal.bounds.minY + horizontal.bounds.maxY) / 2 >=
            vertical.bounds.minY + (vertical.bounds.maxY - vertical.bounds.minY) * 0.68
          ))
          const ambiguousLimitShape = (
            candidate.labelId.startsWith('bracket_') ||
            candidate.labelId === 'geometry_perpendicular' ||
            candidate.labelId === 'absolute_bar'
          )
          if (!oneWithBase && !ambiguousLimitShape) return
          const digitCandidate = candidate.alternatives
            .filter((entry) => entry.labelId.startsWith('digit_'))
            .sort((first, second) => second.confidence - first.confidence)[0]
          const selectedDigit = oneWithBase
            ? candidate.alternatives.find((entry) => entry.labelId === 'digit_1') ?? digitCandidate
            : digitCandidate
          if (oneWithBase && !selectedDigit) {
            const digitOne = labels.find((entry) => entry.id === 'digit_1')
            if (digitOne) {
              candidate.labelId = digitOne.id
              candidate.char = digitOne.char
              candidate.name = digitOne.name
              candidate.latex = digitOne.latex
            }
          } else if (selectedDigit && (oneWithBase || selectedDigit.confidence >= candidate.confidence - 22)) {
            useLabel(candidate, selectedDigit.labelId)
          }
        })
      }
    })
    const absoluteCandidates = group.filter((token) => (
      token.alternatives.some((entry) => entry.labelId === 'absolute_bar') &&
      token.bbox[3] >= token.bbox[2] * 1.8
    ))
    for (let index = 0; index < absoluteCandidates.length - 1; index += 2) {
      const left = absoluteCandidates[index]
      const right = absoluteCandidates[index + 1]
      const hasContentBetween = group.some((token) => (
        token !== left && token !== right &&
        token.bbox[0] > left.bbox[0] &&
        token.bbox[0] + token.bbox[2] < right.bbox[0] + right.bbox[2]
      ))
      if (hasContentBetween) {
        useLabel(left, 'absolute_bar')
        useLabel(right, 'absolute_bar')
      }
    }
    group.forEach((token, index) => {
      const previous = group[index - 1]
      const next = group[index + 1]
      const alternatives = new Set(token.alternatives.map((entry) => entry.labelId))
      const strokeShapes = token.strokes.map((stroke) => {
        const bounds = strokeBounds(stroke)
        const width = (bounds.maxX - bounds.minX) * SOURCE_WIDTH
        const height = (bounds.maxY - bounds.minY) * SOURCE_HEIGHT
        return {
          bounds,
          aspect: width / Math.max(1, height),
        }
      })
      const horizontalStroke = strokeShapes.find((entry) => entry.aspect >= 2.2)
      const verticalStroke = strokeShapes.find((entry) => entry.aspect <= 0.48)
      const horizontalCenterY = horizontalStroke
        ? (horizontalStroke.bounds.minY + horizontalStroke.bounds.maxY) / 2
        : 0
      const verticalHeight = verticalStroke
        ? verticalStroke.bounds.maxY - verticalStroke.bounds.minY
        : 0
      const crossGeometry = Boolean(horizontalStroke && verticalStroke && (
        Math.min(horizontalStroke.bounds.maxX, verticalStroke.bounds.maxX) -
        Math.max(horizontalStroke.bounds.minX, verticalStroke.bounds.minX) >= -0.006
      ) && (
        Math.min(horizontalStroke.bounds.maxY, verticalStroke.bounds.maxY) -
        Math.max(horizontalStroke.bounds.minY, verticalStroke.bounds.minY) >= -0.006
      ) && (
        horizontalCenterY >= verticalStroke.bounds.minY + verticalHeight * 0.38 &&
        horizontalCenterY <= verticalStroke.bounds.maxY - verticalHeight * 0.32 &&
        (horizontalStroke.bounds.maxX - horizontalStroke.bounds.minX) * SOURCE_WIDTH >=
          verticalHeight * SOURCE_HEIGHT * 0.45
      ))
      if (
        crossGeometry &&
        isOperand(previous) &&
        isOperand(next)
      ) {
        // A centred horizontal/vertical crossing between two operands is a
        // structural plus even when the visual classifier's short candidate
        // list initially contains only l/I/1.  Geometry and two-sided context
        // are independent evidence and therefore may restore the missing
        // operator candidate.
        useLabel(token, 'operator_plus', true)
      }

      const horizontalBars = strokeShapes.filter((entry) => entry.aspect >= 2.2)
      const parallelBarGeometry = Boolean(
        token.strokes.length === 2 &&
        horizontalBars.length === 2 &&
        horizontalBars.every((entry, barIndex) => (
          resemblesStraightHorizontalAccessoryStroke(token.strokes[barIndex], entry.bounds)
        )) &&
        (() => {
          const [firstBar, secondBar] = horizontalBars
          const firstWidth = firstBar.bounds.maxX - firstBar.bounds.minX
          const secondWidth = secondBar.bounds.maxX - secondBar.bounds.minX
          const overlap = Math.min(firstBar.bounds.maxX, secondBar.bounds.maxX) -
            Math.max(firstBar.bounds.minX, secondBar.bounds.minX)
          const firstCenterY = (firstBar.bounds.minY + firstBar.bounds.maxY) / 2
          const secondCenterY = (secondBar.bounds.minY + secondBar.bounds.maxY) / 2
          return overlap >= Math.min(firstWidth, secondWidth) * 0.54 &&
            Math.abs(firstCenterY - secondCenterY) * SOURCE_HEIGHT >= 6
        })()
      )
      if (parallelBarGeometry && isOperand(previous) && isOperand(next)) {
        // The same protection applies to '=': two separated, overlapping
        // horizontal bars between operands cannot be allowed to collapse to
        // an o/e merely because the handwriting model omitted '=' from its
        // first visual shortlist.
        useLabel(token, 'relation_equal', true)
      }

      if (
        alternatives.has('operator_multiply') &&
        alternatives.has('latin_lower_x') &&
        isOperand(previous) &&
        isOperand(next) &&
        (isDigit(previous) || isDigit(next))
      ) {
        useLabel(token, 'operator_multiply')
      }

      const zeroCandidates = ['digit_0', 'latin_upper_O', 'latin_lower_o', 'greek_omicron']
      const zeroAlternative = token.alternatives.find((entry) => entry.labelId === 'digit_0')
      const looksRound = zeroCandidates.includes(token.labelId) || token.labelId === 'latin_upper_Q'
      const numericMathContext = isDigit(previous) || isDigit(next) || isMathSyntax(previous) || isMathSyntax(next)
      if (
        looksRound &&
        zeroAlternative &&
        numericMathContext &&
        zeroAlternative.confidence >= token.confidence - 9
      ) {
        useLabel(token, 'digit_0')
      } else if (zeroCandidates.filter((labelId) => alternatives.has(labelId)).length > 1 && (isLetter(previous) || isLetter(next))) {
        const letterCandidate = ['latin_lower_o', 'latin_upper_O', 'greek_omicron'].find((labelId) => alternatives.has(labelId))
        if (letterCandidate) useLabel(token, letterCandidate)
      }

      const oneCandidates = ['digit_1', 'latin_upper_I', 'latin_lower_l']
      if (
        !crossGeometry &&
        !LARGE_OPERATOR_IDS.has(token.labelId) &&
        oneCandidates.filter((labelId) => alternatives.has(labelId)).length > 1 &&
        (isDigit(previous) || isDigit(next))
      ) {
        useLabel(token, 'digit_1')
      } else if (
        !LARGE_OPERATOR_IDS.has(token.labelId) &&
        oneCandidates.filter((labelId) => alternatives.has(labelId)).length > 1 &&
        (isLetter(previous) || isLetter(next))
      ) {
        const letterCandidate = ['latin_lower_l', 'latin_upper_I'].find((labelId) => alternatives.has(labelId))
        if (letterCandidate) useLabel(token, letterCandidate)
      }

      if (
        (alternatives.has('decimal_point') || alternatives.has('decimal_comma')) &&
        isDigit(previous) &&
        isDigit(next)
      ) {
        const markCenterY = token.bbox[1] + token.bbox[3] / 2
        const neighbourCenterY = (
          previous!.bbox[1] + previous!.bbox[3] / 2 +
          next!.bbox[1] + next!.bbox[3] / 2
        ) / 2
        const neighbourHeight = (previous!.bbox[3] + next!.bbox[3]) / 2
        const isCenteredMultiplicationDot = (
          alternatives.has('operator_dot') &&
          markCenterY <= neighbourCenterY + neighbourHeight * 0.18
        )
        if (isCenteredMultiplicationDot) {
          useLabel(token, 'operator_dot')
        } else {
          const decimalCandidate = token.alternatives
            .filter((entry) => entry.labelId === 'decimal_point' || entry.labelId === 'decimal_comma')
            .sort((first, second) => second.confidence - first.confidence)[0]
          if (decimalCandidate) useLabel(token, decimalCandidate.labelId)
        }
      }

      if (
        !protectedLimitTokenIds.has(token.id) &&
        alternatives.has('operator_factorial') &&
        isOperand(previous) &&
        (!next || !isOperand(next))
      ) {
        useLabel(token, 'operator_factorial')
      }

      if (
        !protectedLimitTokenIds.has(token.id) &&
        alternatives.has('operator_percent') &&
        (isDigit(previous) || isDecimalMark(previous)) &&
        (!next || !isDigit(next))
      ) {
        useLabel(token, 'operator_percent')
      }

      const leftBrackets = ['bracket_left_round', 'bracket_left_square', 'bracket_left_curly']
      const rightBrackets = ['bracket_right_round', 'bracket_right_square', 'bracket_right_curly']
      const currentVisualConfidence = token.alternatives.find((entry) => entry.labelId === token.labelId)?.confidence ?? token.confidence
      const canOverrideWithBracket = (
        !LARGE_OPERATOR_IDS.has(token.labelId) &&
        !protectedLimitTokenIds.has(token.id)
      )
      if (canOverrideWithBracket && leftBrackets.some((labelId) => alternatives.has(labelId)) && (!previous || !isOperand(previous))) {
        const candidate = token.alternatives
          .filter((entry) => leftBrackets.includes(entry.labelId))
          .sort((first, second) => second.confidence - first.confidence)[0]
        const alreadyBracket = leftBrackets.includes(token.labelId)
        const hasClosingPartner = group.slice(index + 1).some((entry) =>
          entry.alternatives.some((alternative) => rightBrackets.includes(alternative.labelId)),
        )
        if (candidate && candidate.confidence >= currentVisualConfidence - 4 && (alreadyBracket || hasClosingPartner)) {
          useLabel(token, candidate.labelId)
        }
      }
      if (canOverrideWithBracket && rightBrackets.some((labelId) => alternatives.has(labelId)) && isOperand(previous) && (!next || !isOperand(next))) {
        const candidate = token.alternatives
          .filter((entry) => rightBrackets.includes(entry.labelId))
          .sort((first, second) => second.confidence - first.confidence)[0]
        const alreadyBracket = rightBrackets.includes(token.labelId)
        const hasOpeningPartner = group.slice(0, index).some((entry) =>
          entry.alternatives.some((alternative) => leftBrackets.includes(alternative.labelId)),
        )
        if (candidate && candidate.confidence >= currentVisualConfidence - 4 && (alreadyBracket || hasOpeningPartner)) {
          useLabel(token, candidate.labelId)
        }
      }
    })
  })

  return result
}

const resemblesUppercaseT = (cluster: StrokeCluster) => {
  if (cluster.strokes.length !== 2) return false
  const entries = cluster.strokes.map((stroke) => {
    const bounds = strokeBounds(stroke)
    const widthPixels = (bounds.maxX - bounds.minX) * SOURCE_WIDTH
    const heightPixels = (bounds.maxY - bounds.minY) * SOURCE_HEIGHT
    return {
      bounds,
      widthPixels,
      heightPixels,
      aspect: widthPixels / Math.max(1, heightPixels),
    }
  })
  const crossbar = entries.find((entry) => entry.aspect >= 2.6)
  // A product sign often has a separate top bar too, but its other stroke
  // spans two vertical legs and is therefore visibly wider than a true T
  // stem. Keeping this bound narrow protects T from integral confusion without
  // turning a handwritten Π/∏ into T.
  const stem = entries.find((entry) => entry.aspect <= 0.28)
  if (!crossbar || !stem || stem.heightPixels < 38 || crossbar.widthPixels < 20) return false
  const stemHeight = stem.bounds.maxY - stem.bounds.minY
  const stemCenterX = (stem.bounds.minX + stem.bounds.maxX) / 2
  const crossbarCenterY = (crossbar.bounds.minY + crossbar.bounds.maxY) / 2
  const crossbarContainsStem = (
    stemCenterX >= crossbar.bounds.minX - 0.008 &&
    stemCenterX <= crossbar.bounds.maxX + 0.008
  )
  const crossbarAtTop = (
    crossbarCenterY <= stem.bounds.minY + stemHeight * 0.2 &&
    crossbar.bounds.maxY <= stem.bounds.minY + stemHeight * 0.29
  )
  const stemExtendsBelow = stem.bounds.maxY - crossbarCenterY >= stemHeight * 0.72
  return crossbarContainsStem && crossbarAtTop && stemExtendsBelow
}

const textGeometryAdjustment = (labelId: string, cluster: StrokeCluster) => {
  if (!resemblesUppercaseT(cluster)) return 0
  if (labelId === 'latin_upper_T') return -0.54
  if (
    labelId === 'latin_lower_l' ||
    labelId === 'latin_lower_t' ||
    labelId === 'latin_lower_f' ||
    labelId === 'latin_upper_I'
  ) return 0.34
  return 0
}

const resemblesIntegralStroke = (stroke: Stroke) => {
  if (stroke.points.length < 4) return false
  const bounds = strokeBounds(stroke)
  const widthPixels = Math.max(1, (bounds.maxX - bounds.minX) * SOURCE_WIDTH)
  const heightPixels = Math.max(1, (bounds.maxY - bounds.minY) * SOURCE_HEIGHT)
  if (heightPixels < 54 || widthPixels / heightPixels > 0.72) return false
  const points = stroke.points
  const first = points[0]
  const last = points.at(-1)!
  const minX = Math.min(...points.map((point) => point.x))
  const maxX = Math.max(...points.map((point) => point.x))
  const minY = Math.min(...points.map((point) => point.y))
  const maxY = Math.max(...points.map((point) => point.y))
  const rawWidth = Math.max(0.0001, maxX - minX)
  const rawHeight = Math.max(0.0001, maxY - minY)
  const pathLength = points.slice(1).reduce((length, point, index) => {
    const previous = points[index]
    return length + Math.hypot(
      (point.x - previous.x) * SOURCE_WIDTH,
      (point.y - previous.y) * SOURCE_HEIGHT,
    )
  }, 0)
  const spansHeight = (
    Math.min(first.y, last.y) <= minY + rawHeight * 0.2 &&
    Math.max(first.y, last.y) >= maxY - rawHeight * 0.2
  )
  const oppositeEndpoints = (
    Math.abs(first.x - last.x) / rawWidth >= 0.24 &&
    ((first.y <= last.y && first.x > last.x) || (last.y <= first.y && last.x > first.x))
  )
  return spansHeight && oppositeEndpoints && pathLength >= heightPixels * 1.03
}

const mathGeometryAdjustment = (labelId: string, cluster: StrokeCluster) => {
  const width = Math.max(0.0001, cluster.maxX - cluster.minX)
  const height = Math.max(0.0001, cluster.maxY - cluster.minY)
  const pixelAspect = (width * SOURCE_WIDTH) / (height * SOURCE_HEIGHT)
  const strokeAspects = cluster.strokes.map((stroke) => {
    const bounds = strokeBounds(stroke)
    return ((bounds.maxX - bounds.minX) * SOURCE_WIDTH) /
      Math.max(1, (bounds.maxY - bounds.minY) * SOURCE_HEIGHT)
  })
  const pathLength = cluster.strokes.reduce((total, stroke) => total + stroke.points.reduce((length, point, index) => {
    const previous = stroke.points[index - 1]
    if (!previous) return length
    return length + Math.hypot(
      (point.x - previous.x) * SOURCE_WIDTH,
      (point.y - previous.y) * SOURCE_HEIGHT,
    )
  }, 0), 0)
  const horizontalStrokes = strokeAspects.filter((aspect) => aspect >= 3.2).length
  const verticalStrokes = strokeAspects.filter((aspect) => aspect <= 0.34).length
  const pointLike = cluster.strokes.length === 1 && pathLength <= 16 &&
    width * SOURCE_WIDTH <= 24 && height * SOURCE_HEIGHT <= 24
  const mostlyHorizontal = pixelAspect >= 4.2 && cluster.strokes.length === 1
  const mostlyVertical = pixelAspect <= 0.24 && cluster.strokes.length === 1
  const twoHorizontalBars = cluster.strokes.length === 2 && horizontalStrokes === 2
  const horizontalPlusStroke = cluster.strokes
    .map((stroke, index) => ({ bounds: strokeBounds(stroke), aspect: strokeAspects[index] }))
    .find((entry) => entry.aspect >= 3.2)
  const verticalPlusStroke = cluster.strokes
    .map((stroke, index) => ({ bounds: strokeBounds(stroke), aspect: strokeAspects[index] }))
    .find((entry) => entry.aspect <= 0.34)
  const horizontalPlusCenterY = horizontalPlusStroke
    ? (horizontalPlusStroke.bounds.minY + horizontalPlusStroke.bounds.maxY) / 2
    : 0
  const verticalPlusHeight = verticalPlusStroke
    ? verticalPlusStroke.bounds.maxY - verticalPlusStroke.bounds.minY
    : 0
  const plusShape = Boolean(
    cluster.strokes.length === 2 &&
    horizontalPlusStroke &&
    verticalPlusStroke &&
    horizontalPlusCenterY >= verticalPlusStroke.bounds.minY + verticalPlusHeight * 0.22 &&
    horizontalPlusCenterY <= verticalPlusStroke.bounds.maxY - verticalPlusHeight * 0.22
  )
  const productShape = resemblesProductOperatorStrokes(cluster.strokes)
  const uppercaseTShape = resemblesUppercaseT(cluster)
  const integralStrokeCount = cluster.strokes.filter(resemblesIntegralStroke).length
  const repeatedIntegralShape = (
    (cluster.strokes.length === 2 || cluster.strokes.length === 3) &&
    integralStrokeCount === cluster.strokes.length
  )
  const divisionShape = cluster.strokes.length === 3 && horizontalStrokes === 1 &&
    cluster.strokes.filter((stroke) => stroke.points.length <= 2).length >= 2
  const primaryStroke = cluster.strokes.length === 1 ? cluster.strokes[0] : null
  const primaryPoints = primaryStroke?.points ?? []
  const rawMinX = primaryPoints.length ? Math.min(...primaryPoints.map((point) => point.x)) : 0
  const rawMaxX = primaryPoints.length ? Math.max(...primaryPoints.map((point) => point.x)) : 0
  const rawWidth = Math.max(0.0001, rawMaxX - rawMinX)
  const firstPoint = primaryPoints[0]
  const lastPoint = primaryPoints.at(-1)
  const middlePoints = primaryPoints.slice(
    Math.floor(primaryPoints.length * 0.35),
    Math.max(Math.floor(primaryPoints.length * 0.65), Math.floor(primaryPoints.length * 0.35) + 1),
  )
  const middleX = middlePoints.length
    ? middlePoints.reduce((sum, point) => sum + point.x, 0) / middlePoints.length
    : 0
  const endpointMeanX = firstPoint && lastPoint ? (firstPoint.x + lastPoint.x) / 2 : 0
  const endpointSeparation = firstPoint && lastPoint ? Math.abs(firstPoint.x - lastPoint.x) / rawWidth : 0
  const middleBulge = (middleX - endpointMeanX) / rawWidth
  const rawMinY = primaryPoints.length ? Math.min(...primaryPoints.map((point) => point.y)) : 0
  const rawMaxY = primaryPoints.length ? Math.max(...primaryPoints.map((point) => point.y)) : 0
  const rawHeight = Math.max(0.0001, rawMaxY - rawMinY)
  const bottomPoint = primaryPoints.reduce<Stroke['points'][number] | null>((lowest, point) => (
    !lowest || point.y > lowest.y ? point : lowest
  ), null)
  const bottomIndex = bottomPoint ? primaryPoints.indexOf(bottomPoint) : -1
  const upperRightPoint = primaryPoints.reduce<Stroke['points'][number] | null>((rightmost, point) => (
    !rightmost || point.x > rightmost.x ? point : rightmost
  ), null)
  const topHorizontalTravel = primaryPoints.slice(1).reduce((travel, point, index) => {
    const previous = primaryPoints[index]
    const nearTop = (point.y + previous.y) / 2 <= rawMinY + rawHeight * 0.25
    const deltaX = Math.abs(point.x - previous.x)
    const deltaY = Math.abs(point.y - previous.y)
    return nearTop && deltaX >= deltaY * 1.55 ? travel + deltaX : travel
  }, 0)
  const radicalShape = Boolean(
    primaryPoints.length >= 5 &&
    bottomPoint && upperRightPoint &&
    bottomIndex >= 1 && bottomIndex <= primaryPoints.length - 3 &&
    bottomPoint.x <= rawMinX + rawWidth * 0.48 &&
    bottomPoint.y >= rawMinY + rawHeight * 0.7 &&
    upperRightPoint.y <= rawMinY + rawHeight * 0.25 &&
    topHorizontalTravel >= rawWidth * 0.3,
  )
  const tallCurvedStroke = Boolean(
    primaryStroke &&
    primaryPoints.length >= 4 &&
    height * SOURCE_HEIGHT >= 70 &&
    pixelAspect <= 0.78 &&
    pathLength >= height * SOURCE_HEIGHT * 1.04,
  )
  const integralCurve = (
    tallCurvedStroke &&
    firstPoint &&
    lastPoint &&
    Math.min(firstPoint.y, lastPoint.y) <= rawMinY + rawHeight * 0.18 &&
    Math.max(firstPoint.y, lastPoint.y) >= rawMaxY - rawHeight * 0.18 &&
    (firstPoint.y <= lastPoint.y
      ? firstPoint.x >= rawMinX + rawWidth * 0.52 && lastPoint.x <= rawMinX + rawWidth * 0.48
      : lastPoint.x >= rawMinX + rawWidth * 0.52 && firstPoint.x <= rawMinX + rawWidth * 0.48) &&
    endpointSeparation >= 0.28 &&
    topHorizontalTravel < rawWidth * 0.48 &&
    !radicalShape
  )
  const parenthesisCurve = tallCurvedStroke && endpointSeparation <= 0.24 && Math.abs(middleBulge) >= 0.16
  let adjustment = 0

  if (pointLike) {
    if (labelId === 'decimal_point') adjustment -= 0.05
    if (labelId === 'decimal_comma') adjustment -= 0.018
    if (labelId.startsWith('digit_') || labelId.startsWith('latin_')) adjustment += 0.018
  }
  if (mostlyHorizontal) {
    if (labelId === 'operator_minus') adjustment -= 0.045
    if (labelId === 'absolute_bar' || labelId === 'digit_1') adjustment += 0.04
  }
  if (mostlyVertical) {
    if (labelId === 'absolute_bar' || labelId === 'digit_1' || labelId === 'latin_upper_I') adjustment -= 0.018
    if (labelId === 'operator_minus') adjustment += 0.04
  }
  if (twoHorizontalBars) {
    if (labelId === 'relation_equal') adjustment -= 0.05
    if (labelId === 'operator_minus') adjustment += 0.035
  }
  if (plusShape) {
    if (labelId === 'operator_plus') adjustment -= 0.18
    if (labelId === 'digit_1' || labelId === 'absolute_bar' || labelId === 'operator_multiply') adjustment += 0.08
  }
  if (productShape) {
    if (labelId === 'operator_product') adjustment -= 0.36
    if (labelId === 'geometry_parallel' || labelId === 'latin_upper_T') adjustment += 0.28
  }
  if (uppercaseTShape) {
    if (labelId === 'latin_upper_T') adjustment -= 0.58
    if (
      labelId === 'operator_integral' ||
      labelId === 'operator_double_integral' ||
      labelId === 'operator_triple_integral' ||
      labelId === 'operator_contour_integral'
    ) adjustment += 0.68
    if (labelId === 'operator_plus') adjustment += 0.24
  }
  if (repeatedIntegralShape) {
    if (labelId === 'operator_double_integral' && integralStrokeCount === 2) adjustment -= 0.52
    if (labelId === 'operator_triple_integral' && integralStrokeCount === 3) adjustment -= 0.52
    if (labelId === 'geometry_parallel' || labelId === 'latin_upper_T') adjustment += 0.58
  } else if (labelId === 'operator_double_integral' || labelId === 'operator_triple_integral') {
    adjustment += 0.3
  }
  if (divisionShape && labelId === 'operator_divide') adjustment -= 0.045
  if (radicalShape) {
    if (labelId === 'operator_sqrt') adjustment -= 0.22
    if (labelId === 'operator_integral' || labelId === 'latin_lower_f' || labelId === 'latin_lower_t') adjustment += 0.1
  }
  if (integralCurve) {
    if (labelId === 'operator_integral') adjustment -= 0.42
    if (labelId === 'digit_1' || labelId === 'absolute_bar') adjustment += 0.12
    if (
      labelId === 'bracket_left_round' ||
      labelId === 'bracket_right_round' ||
      labelId === 'bracket_left_square' ||
      labelId === 'bracket_right_square' ||
      labelId === 'bracket_left_curly' ||
      labelId === 'bracket_right_curly'
    ) adjustment += 0.22
  }
  if (parenthesisCurve) {
    if (labelId === 'operator_integral') adjustment += 0.038
    if (middleBulge < 0 && labelId === 'bracket_left_round') adjustment -= 0.045
    if (middleBulge > 0 && labelId === 'bracket_right_round') adjustment -= 0.045
  }
  return adjustment
}

const TEXT_PUNCTUATION_IDS = new Set([
  'decimal_point',
  'decimal_comma',
  'punctuation_colon',
  'punctuation_semicolon',
  'punctuation_question',
  'punctuation_apostrophe',
  'punctuation_quote',
  'operator_factorial',
  'operator_minus',
  'punctuation_underscore',
  'operator_slash',
  'bracket_left_round',
  'bracket_right_round',
  'bracket_left_square',
  'bracket_right_square',
])

const isTextLabel = (label?: LabelDefinition) => Boolean(label && (
  label.category === 'uppercase' ||
  label.category === 'lowercase' ||
  label.category === 'german' ||
  label.category === 'digits' ||
  TEXT_PUNCTUATION_IDS.has(label.id) ||
  (label.category === 'custom' && Array.from(label.char).length === 1)
))

const isLetterLabel = (label?: LabelDefinition) => Boolean(label && (
  label.category === 'uppercase' || label.category === 'lowercase' || label.category === 'german'
))

const isDigitLabel = (label?: LabelDefinition) => label?.category === 'digits'

const median = (values: number[]) => {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

type TextLine = {
  tokens: RecognitionToken[]
  minY: number
  maxY: number
  centerY: number
  referenceHeight: number
}

type TextGapAnalysis = {
  gaps: number[]
  compactGap: number
  threshold: number
}

const analyzeTextGaps = (
  lineTokens: RecognitionToken[],
  closingPunctuation: Set<string>,
  openingPunctuation: Set<string>,
): TextGapAnalysis => {
  const substantive = lineTokens.filter((token) => (
    !closingPunctuation.has(token.char) && !openingPunctuation.has(token.char)
  ))
  const widths = substantive.map((token) => token.bbox[2]).filter((width) => width > 0.004)
  const heights = substantive.map((token) => token.bbox[3]).filter((height) => height > 0.008)
  const typicalWidth = median(widths.length ? widths : lineTokens.map((token) => token.bbox[2]))
  const xHeightAsWidth = median(heights.length ? heights : lineTokens.map((token) => token.bbox[3])) *
    SOURCE_HEIGHT / SOURCE_WIDTH
  const pairGaps = lineTokens.slice(1).map((token, index) => {
    const previous = lineTokens[index]
    if (closingPunctuation.has(token.char) || openingPunctuation.has(previous.char)) return 0
    return Math.max(0, token.bbox[0] - (previous.bbox[0] + previous.bbox[2]))
  })
  const eligible = pairGaps.filter((gap) => gap > 0.0015).sort((first, second) => first - second)
  const compactPopulation = eligible.slice(0, Math.max(1, Math.ceil(eligible.length * 0.58)))
  const compactGap = median(compactPopulation)
  let threshold = clamp(
    Math.max(
      typicalWidth * 0.62,
      xHeightAsWidth * 0.34,
      compactGap + Math.max(0.0055, compactGap * 0.3),
    ),
    0.016,
    0.058,
  )

  if (eligible.length >= 2) {
    let bestSplit: { threshold: number; strength: number } | null = null
    for (let index = 0; index < eligible.length - 1; index += 1) {
      const lower = eligible.slice(0, index + 1)
      const upper = eligible.slice(index + 1)
      const lowerCenter = median(lower)
      const upperCenter = median(upper)
      const separation = upperCenter - lowerCenter
      const lowerDeviations = lower.map((gap) => Math.abs(gap - lowerCenter))
      const compactVariation = median(lowerDeviations)
      const balanced = Math.min(lower.length, upper.length) / Math.max(lower.length, upper.length)
      const minimumSeparation = Math.max(0.006, xHeightAsWidth * 0.085, compactVariation * 2.8)
      const sufficientlyDistinct = (
        separation >= minimumSeparation &&
        upperCenter >= lowerCenter * 1.62 + 0.0035 &&
        // A single naturally wider join inside an unknown name used to form
        // its own statistical cluster and could lower the threshold below a
        // third of a normal glyph width. Require the larger cluster to also
        // look like physical whitespace at the current writing scale. Compact
        // genuine word gaps remain available; small intra-word variation no
        // longer becomes a boundary merely because it is the largest gap.
        // A lone detached join inside one handwritten word is often the
        // largest gap on the line. It must not become whitespace merely by
        // forming its own one-item cluster. Use a conservative absolute
        // letter-width floor here; later lexical partitioning can still
        // recover compact boundaries between two known words, and the neural
        // line path supplies independent evidence for unknown phrases.
        upperCenter >= Math.max(typicalWidth * 0.65, xHeightAsWidth * 0.24)
      )
      if (!sufficientlyDistinct) continue
      const strength = separation / Math.max(0.004, lowerCenter + compactVariation) * (0.72 + balanced * 0.28)
      const candidate = {
        threshold: (lower.at(-1)! + upper[0]) / 2,
        strength,
      }
      if (!bestSplit || candidate.strength > bestSplit.strength) bestSplit = candidate
    }
    if (bestSplit) threshold = clamp(bestSplit.threshold, 0.0135, 0.058)
  }

  return { gaps: pairGaps, compactGap, threshold }
}

const arrangeTextTokens = (tokens: RecognitionToken[]) => {
  const clean = tokens
    .filter((token) => !token.isLayout)
    .map((token) => ({
      ...token,
      alternatives: token.alternatives.map((alternative) => ({ ...alternative })),
      layout: undefined,
      spaceBefore: false,
      lineBreakBefore: false,
    }))
  const lines: TextLine[] = []

  ;[...clean]
    .sort((first, second) => second.bbox[3] - first.bbox[3])
    .forEach((token) => {
      const [, y, , height] = token.bbox
      const centerY = y + height / 2
      const matching = lines
        .map((line) => {
          const overlap = Math.min(y + height, line.maxY) - Math.max(y, line.minY)
          const tolerance = Math.max(0.05, Math.min(0.135, line.referenceHeight * 0.58 + height * 0.2))
          return { line, distance: Math.abs(centerY - line.centerY), overlap, tolerance }
        })
        .filter((entry) => entry.overlap > Math.min(height, entry.line.referenceHeight) * 0.08 || entry.distance <= entry.tolerance)
        .sort((first, second) => first.distance - second.distance)[0]

      if (!matching) {
        lines.push({ tokens: [token], minY: y, maxY: y + height, centerY, referenceHeight: height })
        return
      }

      matching.line.tokens.push(token)
      matching.line.minY = Math.min(matching.line.minY, y)
      matching.line.maxY = Math.max(matching.line.maxY, y + height)
      matching.line.centerY = median(matching.line.tokens.map((entry) => entry.bbox[1] + entry.bbox[3] / 2))
      matching.line.referenceHeight = median(matching.line.tokens.map((entry) => entry.bbox[3]))
    })

  const closingPunctuation = new Set(['.', ',', ';', ':', '!', '?', ')', ']'])
  const openingPunctuation = new Set(['(', '['])
  const ordered: RecognitionToken[] = []

  lines
    .sort((first, second) => first.centerY - second.centerY)
    .forEach((line, lineIndex) => {
      const lineTokens = line.tokens.sort((first, second) => first.bbox[0] - second.bbox[0])
      const gapAnalysis = analyzeTextGaps(lineTokens, closingPunctuation, openingPunctuation)

      lineTokens.forEach((token, tokenIndex) => {
        if (tokenIndex === 0) {
          token.lineBreakBefore = lineIndex > 0
        } else {
          const previous = lineTokens[tokenIndex - 1]
          const gap = gapAnalysis.gaps[tokenIndex - 1]
          token.spaceBefore = (
            gap >= gapAnalysis.threshold &&
            !closingPunctuation.has(token.char) &&
            !openingPunctuation.has(previous.char)
          )
        }
        ordered.push(token)
      })
    })

  return ordered
}

const refineTextSpacing = (
  tokens: RecognitionToken[],
  language: RecognitionLanguage,
) => {
  const closingPunctuation = new Set(['.', ',', ';', ':', '!', '?', ')', ']'])
  const openingPunctuation = new Set(['(', '['])
  const lines: RecognitionToken[][] = []
  tokens.forEach((token) => {
    if (!lines.length || token.lineBreakBefore) lines.push([])
    lines.at(-1)!.push(token)
  })
  let changed = false

  lines.forEach((lineTokens) => {
    if (lineTokens.length < 2) return
    const gapAnalysis = analyzeTextGaps(lineTokens, closingPunctuation, openingPunctuation)
    const isLetter = (token: RecognitionToken) => /^\p{L}$/u.test(token.char)
    const wordStart = (index: number) => {
      let start = index
      while (
        start > 0 &&
        !lineTokens[start].spaceBefore &&
        isLetter(lineTokens[start - 1]) &&
        isLetter(lineTokens[start])
      ) start -= 1
      return start
    }
    const wordEnd = (index: number) => {
      let end = index
      while (
        end + 1 < lineTokens.length &&
        !lineTokens[end + 1].spaceBefore &&
        isLetter(lineTokens[end]) &&
        isLetter(lineTokens[end + 1])
      ) end += 1
      return end
    }
    const value = (start: number, end: number) =>
      lineTokens.slice(start, end + 1).map((token) => token.char).join('')

    // Remove a geometrically marginal false space when joining both sides
    // produces a real word. This is especially important for detached
    // cursive joins and narrow letters.
    for (let index = 1; index < lineTokens.length; index += 1) {
      const token = lineTokens[index]
      if (!token.spaceBefore || !isLetter(lineTokens[index - 1]) || !isLetter(token)) continue
      const leftStart = wordStart(index - 1)
      const rightEnd = wordEnd(index)
      const left = lexicalWordEvidence(value(leftStart, index - 1), language)
      const right = lexicalWordEvidence(value(index, rightEnd), language)
      const joined = lexicalWordEvidence(value(leftStart, rightEnd), language)
      const gap = gapAnalysis.gaps[index - 1]
      const bothFragmentsUnknown = !left.knownWord && !right.knownWord
      const marginalBoundary = gap <= Math.max(
        gapAnalysis.threshold * (bothFragmentsUnknown ? 1.9 : 1.42),
        gapAnalysis.compactGap + (bothFragmentsUnknown ? 0.024 : 0.014),
      )
      if (joined.knownWord && (!left.knownWord || !right.knownWord) && marginalBoundary) {
        token.spaceBefore = false
        changed = true
      }
    }

    // Recover a missing boundary only when geometry is locally salient and
    // both resulting words are known. Unknown names and technical terms are
    // therefore not fragmented merely to satisfy the dictionary.
    let segmentStart = 0
    while (segmentStart < lineTokens.length) {
      while (segmentStart < lineTokens.length && !isLetter(lineTokens[segmentStart])) segmentStart += 1
      if (segmentStart >= lineTokens.length) break
      let segmentEnd = segmentStart
      while (
        segmentEnd + 1 < lineTokens.length &&
        !lineTokens[segmentEnd + 1].spaceBefore &&
        isLetter(lineTokens[segmentEnd + 1])
      ) segmentEnd += 1
      if (segmentEnd - segmentStart >= 3) {
        const joined = lexicalWordEvidence(value(segmentStart, segmentEnd), language)
        if (!joined.knownWord) {
          const length = segmentEnd - segmentStart + 1
          const partitions: ({ score: number; cuts: number[] } | null)[] = Array.from(
            { length: length + 1 },
            () => null,
          )
          partitions[0] = { score: 0, cuts: [] }
          for (let end = 2; end <= length; end += 1) {
            for (let start = 0; start <= end - 2; start += 1) {
              const previous = partitions[start]
              if (!previous) continue
              const evidence = lexicalWordEvidence(
                value(segmentStart + start, segmentStart + end - 1),
                language,
              )
              if (!evidence.knownWord) continue
              if (start > 0) {
                const boundaryIndex = segmentStart + start
                const gap = gapAnalysis.gaps[boundaryIndex - 1]
                const salientGap = gap >= Math.max(
                  gapAnalysis.threshold * 0.72,
                  gapAnalysis.compactGap * 1.55 + 0.0035,
                )
                if (!salientGap) continue
              }
              const boundaryBonus = start > 0
                ? gapAnalysis.gaps[segmentStart + start - 1] /
                  Math.max(0.006, gapAnalysis.threshold) * 0.25
                : 0
              const candidate = {
                score: previous.score + evidence.score - 0.12 + boundaryBonus,
                cuts: start > 0
                  ? [...previous.cuts, segmentStart + start]
                  : previous.cuts,
              }
              if (!partitions[end] || candidate.score > partitions[end]!.score) partitions[end] = candidate
            }
          }
          const partition = partitions[length]
          if (partition?.cuts.length) {
            partition.cuts.forEach((index) => { lineTokens[index].spaceBefore = true })
            changed = true
          }
        }
      }
      segmentStart = segmentEnd + 1
    }
  })
  return changed
}

type TextCandidate = {
  label: LabelDefinition
  confidence: number
  baseConfidence: number
  personalSupport: number
  personalConfidence: number
}

const candidatesForTextToken = (
  token: RecognitionToken,
  labelMap: Map<string, LabelDefinition>,
): TextCandidate[] => {
  const byId = new Map<string, Omit<TextCandidate, 'label'>>()
  const add = (
    labelId: string,
    confidence: number,
    baseConfidence = 0,
    personalSupport = 0,
    personalConfidence = 0,
  ) => {
    const previous = byId.get(labelId)
    byId.set(labelId, previous ? {
      confidence: Math.max(previous.confidence, confidence),
      baseConfidence: Math.max(previous.baseConfidence, baseConfidence),
      personalSupport: Math.max(previous.personalSupport, personalSupport),
      personalConfidence: Math.max(previous.personalConfidence, personalConfidence),
    } : { confidence, baseConfidence, personalSupport, personalConfidence })
  }
  add(
    token.labelId,
    token.confidence,
    token.baseConfidence ?? 0,
    token.personalSupport ?? 0,
    token.personalConfidence ?? 0,
  )
  token.alternatives.forEach((alternative) => add(
    alternative.labelId,
    alternative.confidence,
    alternative.baseConfidence ?? 0,
    alternative.personalSupport ?? 0,
    alternative.personalConfidence ?? 0,
  ))
  const candidates = [...byId.entries()]
    .flatMap(([labelId, evidence]) => {
      const label = labelMap.get(labelId)
      return isTextLabel(label) ? [{ label: label!, ...evidence }] : []
    })
    .sort((first, second) => second.confidence - first.confidence)
  const peak = candidates[0]?.confidence ?? 0
  const plausible = candidates
    // A word may decide between visually similar glyphs, but it must not pull
    // an implausible class from the tail of the recognizer into the result.
    .filter((candidate, index) => index === 0 || candidate.confidence >= Math.max(22, peak - 30))
  const lowercase = plausible.filter((candidate) => (
    isLetterLabel(candidate.label) &&
    candidate.label.char === candidate.label.char.toLocaleLowerCase('de') &&
    candidate.label.char !== candidate.label.char.toLocaleUpperCase('de')
  ))
  const uppercase = plausible.filter((candidate) => (
    isLetterLabel(candidate.label) &&
    candidate.label.char === candidate.label.char.toLocaleUpperCase('de') &&
    candidate.label.char !== candidate.label.char.toLocaleLowerCase('de')
  ))
  const digits = plausible.filter((candidate) => isDigitLabel(candidate.label))
  const diverse = [
    ...plausible.slice(0, 6),
    ...lowercase.slice(0, 12),
    ...uppercase.slice(0, 6),
    ...digits.slice(0, 5),
  ]
  return [...new Map(diverse.map((candidate) => [candidate.label.id, candidate])).values()].slice(0, 24)
}

const wordRanks = (words: Set<string>) => new Map(
  [...words].map((word, index, entries) => [word, 1 - index / Math.max(1, entries.length - 1)]),
)

const wordPrefixes = (words: Set<string>) => {
  const prefixes = new Set<string>()
  words.forEach((word) => {
    for (let length = 2; length <= word.length; length += 1) prefixes.add(word.slice(0, length))
  })
  return prefixes
}

const LANGUAGE_PROFILES = {
  de: {
    locale: 'de',
    words: GERMAN_COMMON_WORDS,
    ranks: wordRanks(GERMAN_COMMON_WORDS),
    prefixes: wordPrefixes(GERMAN_COMMON_WORDS),
    bigrams: GERMAN_COMMON_BIGRAMS,
    trigrams: GERMAN_COMMON_TRIGRAMS,
  },
  en: {
    locale: 'en',
    words: ENGLISH_COMMON_WORDS,
    ranks: wordRanks(ENGLISH_COMMON_WORDS),
    prefixes: wordPrefixes(ENGLISH_COMMON_WORDS),
    bigrams: ENGLISH_COMMON_BIGRAMS,
    trigrams: ENGLISH_COMMON_TRIGRAMS,
  },
} satisfies Record<RecognitionLanguage, {
  locale: string
  words: Set<string>
  ranks: Map<string, number>
  prefixes: Set<string>
  bigrams: Set<string>
  trigrams: Set<string>
}>

const normalizedWord = (value: string, language: RecognitionLanguage) => {
  const lower = normalizeGermanSharpS(value).toLocaleLowerCase(LANGUAGE_PROFILES[language].locale)
  return language === 'de'
    ? lower.replace(/^[^a-zäöü]+|[^a-zäöü]+$/giu, '')
    : lower.replace(/^[^a-z]+|[^a-z]+$/giu, '')
}

const languageTransitionScore = (
  value: string,
  next: string,
  position: number,
  language: RecognitionLanguage,
) => {
  if (!/^\p{L}$/u.test(next)) return 0
  const profile = LANGUAGE_PROFILES[language]
  const lowerNext = next.toLocaleLowerCase(profile.locale)
  const lower = `${value}${lowerNext}`.toLocaleLowerCase(profile.locale)
  let score = 0
  const pair = lower.slice(-2)
  const triple = lower.slice(-3)
  if (profile.bigrams.has(pair)) score += 0.105
  if (profile.trigrams.has(triple)) score += 0.17
  if (lower.length >= 2) score += profile.prefixes.has(lower)
    ? Math.min(0.32, 0.17 + lower.length * 0.035)
    : -0.055
  if (position > 0 && next === next.toLocaleUpperCase(profile.locale) && next !== lowerNext) score -= 0.22
  return score
}

const lexicalWordEvidence = (value: string, language: RecognitionLanguage) => {
  const word = normalizedWord(value, language)
  const profile = LANGUAGE_PROFILES[language]
  const rank = profile.ranks.get(word)
  if (rank !== undefined) {
    return {
      word,
      knownWord: true,
      score: 1.22 + rank * 0.42 + Math.min(0.34, word.length * 0.045),
    }
  }

  // Plausible inflections and German compounds help decoding, but only an
  // exact dictionary word is considered strong enough for self-training.
  const inflectionSuffixes = language === 'de'
    ? ['e', 'en', 'er', 'es', 'em', 'n', 's', 'st', 't']
    : ['s', 'es', 'ed', 'er', 'ing', 'ly']
  const hasKnownStem = word.length >= 5 && inflectionSuffixes.some((suffix) => {
    if (!word.endsWith(suffix) || word.length - suffix.length < 3) return false
    return profile.words.has(word.slice(0, -suffix.length))
  })
  if (hasKnownStem) return { word, knownWord: false, score: 0.54 }

  if (language === 'de' && word.length >= 7) {
    for (let split = 3; split <= word.length - 3; split += 1) {
      if (profile.words.has(word.slice(0, split)) && profile.words.has(word.slice(split))) {
        return { word, knownWord: false, score: 0.62 }
      }
    }
  }
  return { word, knownWord: false, score: 0 }
}

type TextBeam = {
  value: string
  visualScore: number
  languageScore: number
  score: number
  choices: TextCandidate[]
  evidence?: ReturnType<typeof lexicalWordEvidence>
}

const textGeometryCandidateScore = (
  token: RecognitionToken,
  candidate: TextCandidate,
  chunk: RecognitionToken[],
  position: number,
) => {
  const substantial = chunk.filter((entry) => entry.bbox[3] >= 0.025)
  const referenceHeight = Math.max(0.025, median(
    (substantial.length ? substantial : chunk).map((entry) => entry.bbox[3]),
  ))
  const baseline = median(
    (substantial.length ? substantial : chunk).map((entry) => entry.bbox[1] + entry.bbox[3]),
  )
  const [, y, , height] = token.bbox
  const centerY = y + height / 2
  const relativeHeight = height / referenceHeight
  const char = candidate.label.char
  let score = 0

  const strokeBoundsWithExtent = token.strokes
    .filter((stroke) => stroke.points.length)
    .map((stroke) => {
      const bounds = strokeBounds(stroke)
      return {
        bounds,
        extent: Math.max(
          (bounds.maxX - bounds.minX) * SOURCE_WIDTH,
          (bounds.maxY - bounds.minY) * SOURCE_HEIGHT,
        ),
      }
    })
    .sort((first, second) => second.extent - first.extent)
  const primaryBody = strokeBoundsWithExtent[0]
  const detachedUpperDots = primaryBody
    ? strokeBoundsWithExtent.slice(1).filter((entry) => (
        entry.extent <= Math.max(60, primaryBody.extent * 0.55) &&
        resemblesTextDotPair(primaryBody.bounds, entry.bounds)
      )).length
    : 0

  if (/^\p{Lu}$/u.test(char)) {
    if (position === 0) score += relativeHeight >= 1.08 ? 0.16 : -0.04
    else score += relativeHeight >= 1.16 ? -0.04 : -0.28
  } else if (/^\p{Ll}$/u.test(char)) {
    if (position > 0 && relativeHeight <= 1.12) score += 0.12
    if (position === 0 && relativeHeight >= 1.2) score -= 0.08
  }

  if (candidate.label.id === 'punctuation_underscore') {
    const distanceFromBaseline = centerY - baseline
    score += distanceFromBaseline >= -referenceHeight * 0.16 ? 0.48 : -0.5
  } else if (candidate.label.id === 'operator_minus') {
    const expectedCenter = baseline - referenceHeight * 0.46
    const normalizedDistance = Math.abs(centerY - expectedCenter) / referenceHeight
    score += normalizedDistance <= 0.25 ? 0.31 : -Math.min(0.38, normalizedDistance * 0.34)
  }
  // A delayed i/j dot is independent geometric evidence and must survive a
  // word split.  Square-normalized glyph crops otherwise make dotted i look
  // almost identical to l/I/1. Two detached upper dots similarly distinguish
  // a real umlaut from its undiacritized base letter.
  if (detachedUpperDots === 1) {
    if (/^[ij]$/u.test(char)) score += 0.42
    if (/^[lI1]$/u.test(char)) score -= 0.4
  } else if (detachedUpperDots >= 2) {
    if (/^[ÄÖÜäöü]$/u.test(char)) score += 0.5
    if (/^[AaOoUu]$/u.test(char)) score -= 0.38
    if (/^[ij]$/u.test(char)) score -= 0.2
  }
  return score
}

const rerankTextChunk = (
  chunk: RecognitionToken[],
  labelMap: Map<string, LabelDefinition>,
  language: RecognitionLanguage,
) => {
  if (chunk.length === 0) return
  if (chunk.length === 1) {
    const token = chunk[0]
    const personalCandidates = [{
      labelId: token.labelId,
      confidence: token.visualConfidence ?? token.confidence,
      baseConfidence: token.baseConfidence ?? 0,
      personalSupport: token.personalSupport ?? 0,
      personalConfidence: token.personalConfidence ?? 0,
    }, ...token.alternatives.map((alternative) => ({
      labelId: alternative.labelId,
      confidence: alternative.confidence,
      baseConfidence: alternative.baseConfidence ?? 0,
      personalSupport: alternative.personalSupport ?? 0,
      personalConfidence: alternative.personalConfidence ?? 0,
    }))]
      .filter((candidate) => {
        if (candidate.labelId === token.labelId) return true
        const candidateLabel = labelMap.get(candidate.labelId)
        return Boolean(
          candidateLabel &&
          /^\p{L}$/u.test(token.char) &&
          candidateLabel.char.toLocaleLowerCase('de') === token.char.toLocaleLowerCase('de')
        )
      })
      .filter((candidate) => candidate.personalSupport >= 2 && candidate.personalConfidence > 0)
      .filter((candidate) => candidate.confidence >= (token.visualConfidence ?? token.confidence) - 8)
    const strongestBaseConfidence = personalCandidates.reduce((peak, candidate) => (
      Math.max(peak, candidate.baseConfidence)
    ), 0)
    personalCandidates.sort((first, second) => {
      const score = (candidate: typeof first) => (
        candidate.personalConfidence +
        Math.min(18, Math.log2(candidate.personalSupport + 1) * 5) +
        candidate.confidence * 0.16 +
        calibratePersonalBaseEvidence(candidate, strongestBaseConfidence).scoreAdjustment * 30
      )
      return score(second) - score(first)
    })
    const selected = personalCandidates[0]
    const label = selected ? labelMap.get(selected.labelId) : undefined
    if (selected && label) {
      token.labelId = label.id
      token.char = label.char
      token.name = label.name
      token.latex = label.latex
      token.confidence = Math.max(selected.confidence, selected.personalConfidence)
      token.baseConfidence = selected.baseConfidence
      token.personalSupport = selected.personalSupport
      token.personalConfidence = selected.personalConfidence
    }
    // A single isolated glyph has no word context. Running it through the
    // language beam previously lowercased trained P/S forms or changed digits
    // merely because a one-letter dictionary prior cannot exist.
    return
  }
  const candidateLists = chunk.map((token) => candidatesForTextToken(token, labelMap))
  if (candidateLists.some((candidates) => candidates.length === 0)) return
  const likelyLetters = candidateLists.filter((candidates) => candidates.some((candidate) => isLetterLabel(candidate.label))).length
  const likelyDigits = candidateLists.filter((candidates) => candidates.some((candidate) => isDigitLabel(candidate.label))).length
  const kind = likelyLetters >= Math.ceil(chunk.length * 0.6)
    ? 'word'
    : likelyDigits >= Math.ceil(chunk.length * 0.6) ? 'number' : 'mixed'

  let beams: TextBeam[] = [{ value: '', visualScore: 0, languageScore: 0, score: 0, choices: [] }]
  candidateLists.forEach((candidates, position) => {
    beams = beams.flatMap((beam) => candidates.map((candidate) => {
      let visualScore = beam.visualScore + Math.log(0.08 + clamp(candidate.confidence / 100)) * 2.25
      if (kind === 'word' && isDigitLabel(candidate.label)) visualScore -= 0.34
      if (kind === 'number' && isLetterLabel(candidate.label)) visualScore -= 0.34
      visualScore += textGeometryCandidateScore(chunk[position], candidate, chunk, position)
      const languageScore = beam.languageScore + languageTransitionScore(
        beam.value,
        candidate.label.char,
        position,
        language,
      )
      return {
        value: beam.value + candidate.label.char,
        visualScore,
        languageScore,
        score: visualScore + languageScore,
        choices: [...beam.choices, candidate],
      }
    }))
      .sort((first, second) => second.score - first.score)
      .slice(0, 256)
  })

  beams.forEach((beam) => {
    const evidence = lexicalWordEvidence(beam.value, language)
    beam.evidence = evidence
    beam.languageScore += evidence.score
    if (/^\p{Lu}{3,}$/u.test(beam.value)) beam.languageScore -= 0.16
    beam.score = beam.visualScore + beam.languageScore
  })

  const ranked = beams.sort((first, second) => second.score - first.score)
  const languageBest = ranked[0]
  const visualBest = [...beams].sort((first, second) => second.visualScore - first.visualScore)[0]
  const visualWord = visualBest?.value ?? ''
  const visualLooksLikeProperName = (
    /^\p{Lu}\p{Ll}{2,}$/u.test(visualWord) &&
    !lexicalWordEvidence(visualWord, language).knownWord
  )
  const visualNameCharacters = Array.from(visualWord.toLocaleLowerCase(LANGUAGE_PROFILES[language].locale))
  const languageNameCharacters = Array.from(
    (languageBest?.value ?? '').toLocaleLowerCase(LANGUAGE_PROFILES[language].locale),
  )
  const visualNameChanges = visualNameCharacters.length === languageNameCharacters.length
    ? visualNameCharacters.filter((character, index) => character !== languageNameCharacters[index]).length
    : Number.POSITIVE_INFINITY
  const languageOverwritesVisualName = Boolean(
    visualLooksLikeProperName &&
    languageBest &&
    languageBest.value !== visualWord &&
    (
      !/^\p{Lu}\p{Ll}{2,}$/u.test(languageBest.value) ||
      visualNameChanges >= 2
    )
  )
  // A dictionary/prefix prior may disambiguate letters inside an ordinary
  // word, but it must not lowercase a complete visually title-cased unknown
  // word. Otherwise names such as "Fabio" drift towards frequent tokenizer
  // fragments (for example "taboo") even though every visible glyph was
  // individually correct. Keeping the purely visual beam here still allows
  // Tost -> Test because both hypotheses retain title case.
  const languageVisualLabels = languageBest?.choices.map((candidate) => candidate.label.id) ?? []
  const languageChangedIndexes = languageVisualLabels.flatMap((labelId, index) => (
    labelId === (chunk[index].visualLabelId ?? chunk[index].labelId) ? [] : [index]
  ))
  const languageChangedVisualLosses = languageChangedIndexes.map((index) => {
    const visualLabelId = chunk[index].visualLabelId ?? chunk[index].labelId
    const visualConfidence = chunk[index].visualConfidence ??
      chunk[index].alternatives.find((alternative) => alternative.labelId === visualLabelId)?.confidence ??
      chunk[index].confidence
    return Math.max(0, visualConfidence - (languageBest?.choices[index]?.confidence ?? 0))
  })
  const shortWord = chunk.length <= 2
  const maximumLanguageChanges = shortWord ? 1 : Math.max(1, Math.ceil(chunk.length * 0.34))
  const maximumLossPerChangedGlyph = shortWord ? 3 : 24
  const languageCorrectionHasVisualSupport = Boolean(
    languageBest?.evidence?.knownWord &&
    languageChangedIndexes.length <= maximumLanguageChanges &&
    languageChangedVisualLosses.every((loss) => loss <= maximumLossPerChangedGlyph) &&
    languageChangedIndexes.every((index) => languageBest!.choices[index].confidence >= 32)
  )
  // Very short dictionary entries carry a disproportionately large prior:
  // without this gate a clear `ac` became `an`, `os` became `an`, and two
  // lower-confidence letters could turn into an unrelated common word.  A
  // language prior may resolve genuinely close shapes, but it cannot replace
  // multiple visible glyphs or pay a large visual penalty. Longer words keep
  // the wider one-letter ambiguity needed for corrections such as Tost→Test.
  const best = languageOverwritesVisualName || (
    languageChangedIndexes.length > 0 && !languageCorrectionHasVisualSupport
  ) ? visualBest : languageBest
  if (!best) return
  const runnerUp = ranked.find((beam) => beam.value !== best.value)
  const scoreMargin = Math.max(0, best.score - (runnerUp?.score ?? best.score - 2))
  const visualLabels = chunk.map((token) => token.visualLabelId ?? token.labelId)
  const changedCount = best.choices.filter((candidate, index) => candidate.label.id !== visualLabels[index]).length
  const exactKnownWord = Boolean(best.evidence?.knownWord && (best.evidence.word.length ?? 0) >= 2)
  const safeWordDecision = exactKnownWord && (best.evidence?.word.length ?? 0) >= 3 && scoreMargin >= 0.5 && changedCount <= Math.max(1, Math.ceil(chunk.length * 0.34))

  best?.choices.forEach((candidate, index) => {
    const token = chunk[index]
    const visualLabelId = token.visualLabelId ?? token.labelId
    const visualConfidence = token.visualConfidence ?? token.confidence
    const changed = candidate.label.id !== visualLabelId
    const visualRunnerUp = token.alternatives
      .filter((alternative) => alternative.labelId !== visualLabelId)
      .sort((first, second) => second.confidence - first.confidence)[0]
    const rawMargin = visualConfidence - (visualRunnerUp?.confidence ?? 0)
    const visuallyPlausibleCorrection = candidate.confidence >= Math.max(32, visualConfidence - 24)
    const confidentlyUnchanged = !changed && visualConfidence >= 90 && rawMargin >= 10
    const autoLearn = (
      /^\p{L}$/u.test(candidate.label.char) &&
      safeWordDecision &&
      (changed ? visuallyPlausibleCorrection : confidentlyUnchanged)
    )
    token.labelId = candidate.label.id
    token.char = candidate.label.char
    token.name = candidate.label.name
    token.latex = candidate.label.latex
    token.confidence = candidate.confidence
    token.baseConfidence = candidate.baseConfidence
    token.personalSupport = candidate.personalSupport
    token.personalConfidence = candidate.personalConfidence
    token.context = {
      word: best.evidence?.word ?? normalizedWord(best.value, language),
      knownWord: exactKnownWord,
      changed,
      scoreMargin: Math.round(scoreMargin * 1_000) / 1_000,
      autoLearn,
    }
  })
}

export const applyTextReranking = (
  tokens: RecognitionToken[],
  labels: LabelDefinition[],
  language: RecognitionLanguage,
) => {
  const result = arrangeTextTokens(tokens)
  const labelMap = new Map(labels.map((label) => [label.id, label]))
  refineTextSpacing(result, language)
  const rerankWords = () => {
    let chunk: RecognitionToken[] = []
    const flush = () => {
      rerankTextChunk(chunk, labelMap, language)
      chunk = []
    }

    result.forEach((token) => {
      if (token.spaceBefore || token.lineBreakBefore) flush()
      chunk.push(token)
      if (/^[.,;:!?)]$/u.test(token.char)) flush()
    })
    flush()
  }

  rerankWords()
  if (refineTextSpacing(result, language)) rerankWords()
  return result
}

export const recognizeExpression = (
  strokes: Stroke[],
  model: RecognitionModel,
  labels: LabelDefinition[],
  mode: RecognitionMode = 'math',
  layoutExamples: MathLayoutExample[] = [],
  language: RecognitionLanguage = 'de',
  textCharacterCountHint?: number,
  textCharacterHint?: string,
  textSegmentationCandidateIndex = 0,
): RecognitionToken[] => {
  const clusters = segmentStrokes(strokes, mode)
  const labelMap = new Map(labels.map((label) => [label.id, label]))

  const classifyCluster = (cluster: StrokeCluster, id: string) => {
    const rendered = renderCluster(cluster)
    if (cluster.fraction?.role === 'bar') {
      const token: RecognitionToken = {
        id: `${id}-fraction-bar-${cluster.minX.toFixed(4)}-${cluster.maxX.toFixed(4)}`,
        strokes: cloneStrokes(cluster.strokes),
        imageData: rendered.imageData,
        bbox: rendered.bbox,
        labelId: '',
        char: '―',
        name: 'Bruchstrich',
        latex: '',
        confidence: 100,
        alternatives: [],
        isLayout: true,
        layout: cluster.fraction,
      }
      return { token, distance: 0, aspectFit: 0 }
    }
    const feature = featureFromCanvas(rendered.canvas)
    const geometry = geometryFromStrokes(cluster.strokes)
    const physicalAspect = physicalInkAspect(cluster.strokes)
    const recognitionVariants = [{ feature, geometry, strokeCount: cluster.strokes.length }]
    if (mode === 'text' && cluster.detachedTextConnectorStrokes?.length) {
      const connectors = new Set(cluster.detachedTextConnectorStrokes)
      const body = clusterFromStrokes(cluster.strokes.filter((stroke) => !connectors.has(stroke)))
      if (body?.strokes.length) {
        recognitionVariants.push({
          feature: featureFromCanvas(renderCluster(body).canvas),
          geometry: geometryFromStrokes(body.strokes),
          strokeCount: body.strokes.length,
        })
      }
    }
    const personalPrototypeRanking = [...model.prototypeSets.entries()]
      .filter(([labelId]) => mode !== 'text' || isTextLabel(labelMap.get(labelId)))
      .map(([labelId, prototypes]) => ({
        labelId,
        distance: Math.min(...prototypes.flatMap((prototype) => (
          recognitionVariants.map((variant, index) => (
            featureDistance(
              variant.feature,
              prototype,
              variant.strokeCount,
              variant.geometry,
              model.weights,
            ) + (index === 0 ? 0 : 0.004)
          ))
        ))),
      }))
      .sort((first, second) => first.distance - second.distance)
    const prototypeDistanceByLabel = new Map(
      personalPrototypeRanking.map((entry) => [entry.labelId, entry.distance]),
    )
    const personalShortlist = new Set(
      personalPrototypeRanking
        .filter((entry, index, entries) => (
          index < 18 &&
          (index < 8 || entry.distance <= (entries[0]?.distance ?? entry.distance) + 0.24)
        ))
        .map((entry) => entry.labelId),
    )
    const byLabel = new Map<string, {
      distance: number
      standard: boolean
      trust: number
      createdAt: number
    }[]>()
    const classifierEntries = model.classifierEntries.length ? model.classifierEntries : model
    classifierEntries.forEach((entry) => {
      if (!entry.standard && !personalShortlist.has(entry.labelId)) return
      const distances = byLabel.get(entry.labelId) ?? []
      distances.push({
        distance: Math.min(...recognitionVariants.map((variant, index) => (
          featureDistance(
            variant.feature,
            entry,
            variant.strokeCount,
            variant.geometry,
            model.weights,
          ) + (index === 0 ? 0 : 0.004)
        ))) + (entry.standard ? 0 : (1 - entry.trust) * 0.082),
        standard: entry.standard,
        trust: entry.trust,
        createdAt: entry.createdAt,
      })
      byLabel.set(entry.labelId, distances)
    })

    const ranked = [...byLabel.entries()]
      .map(([labelId, candidates]) => {
        const personal = candidates.filter((candidate) => !candidate.standard)
        const standard = candidates.filter((candidate) => candidate.standard)
        const sortedCandidates = [...(personal.length ? personal : candidates)]
          .sort((first, second) => (
            first.distance - second.distance ||
            second.trust - first.trust ||
            second.createdAt - first.createdAt
          ))
        const sorted = sortedCandidates.map((candidate) => candidate.distance)
        // Generic handwriting styles are intentionally diverse. A close
        // zero-shot style must not be diluted by unrelated font variants of
        // the same character. Personal samples use both the closest example
        // and a robust local consensus, so one mislabeled outlier cannot own
        // an entire class while a real recurring writing style remains strong.
        const weights = personal.length ? [0.62, 0.25, 0.13] : [0.92, 0.08]
        const selected = sorted.slice(0, weights.length)
        const weightTotal = weights.slice(0, selected.length).reduce((sum, weight) => sum + weight, 0)
        let aggregate = selected.reduce((sum, distance, index) => sum + distance * weights[index], 0) / weightTotal
        // Preserve an independent base-model measurement even after a class
        // has personal examples. Previously the generic candidates vanished
        // from this point onward, so later fusion could not distinguish
        // personal/base consensus from a real conflict.
        const standardDistances = standard
          .map((candidate) => candidate.distance)
          .sort((first, second) => first - second)
        const standardWeights = [0.92, 0.08]
        const selectedStandard = standardDistances.slice(0, standardWeights.length)
        const standardWeightTotal = standardWeights
          .slice(0, selectedStandard.length)
          .reduce((sum, weight) => sum + weight, 0)
        const baseAggregate = selectedStandard.length
          ? selectedStandard.reduce((sum, distance, index) => (
              sum + distance * standardWeights[index]
            ), 0) / standardWeightTotal
          : null
        const prototypes = model.prototypeSets.get(labelId) ?? (
          model.prototypes.get(labelId) ? [model.prototypes.get(labelId)!] : []
        )
        const stats = model.labelStats.get(labelId)
        const aspectStats = model.aspectStats.get(labelId)
        // Accidental merges expand a crop horizontally. Deliberately narrow
        // or compressed handwriting must remain valid, so this is an upper
        // envelope rather than a symmetric distance from the median.
        const aspectLogDistance = aspectStats
          ? Math.max(0, Math.log(physicalAspect / Math.max(0.035, aspectStats.median)))
          : 0
        const aspectFit = aspectStats
          ? Math.exp(-Math.pow(aspectLogDistance / Math.max(0.18, aspectStats.spread + 0.1), 2))
          : 0
        const bestPersonalDistance = personal.length
          ? sorted[0] + PERSONAL_SAMPLE_DISTANCE_BONUS
          : null
        const personalFit = bestPersonalDistance === null
          ? 0
          : clamp(1 - bestPersonalDistance / Math.max(0.08, (stats?.radius ?? 0.19) * 1.75))
        const reliability = stats?.reliability ?? (personal.length ? 0.58 : 0)
        if (personal.length && prototypes.length) {
          // Already computed above to form the personal shortlist. Reusing
          // it avoids another full prototype/variant comparison per label
          // for every candidate segment in a connected word.
          const cachedPrototypeDistance = prototypeDistanceByLabel.get(labelId)
          const prototypeDistance = cachedPrototypeDistance ?? Math.min(...prototypes.flatMap((prototype) => (
            recognitionVariants.map((variant, index) => (
              featureDistance(
                variant.feature,
                prototype,
                variant.strokeCount,
                variant.geometry,
                model.weights,
              ) + (index === 0 ? 0 : 0.004)
            ))
          )))
          aggregate = aggregate * 0.78 + prototypeDistance * 0.22
          aggregate -= Math.min(0.034, 0.009 + Math.log2(personal.length + 1) * 0.005) *
            (0.38 + reliability * 0.42 + personalFit * 0.2)
          aggregate += (1 - reliability) * 0.024 + (1 - personalFit) * 0.012
          // Square normalization can make two adjacent letters resemble one
          // well trained glyph. Penalize only the portion outside the robust
          // personal aspect band; ordinary size changes remain untouched.
          aggregate += Math.max(0, aspectLogDistance - aspectStats!.spread - 0.1) * 0.3
        } else if (aspectStats) {
          // Generic handwriting references also retain their physical shape.
          // Their wider style spread receives a lighter penalty than the
          // writer-specific model, but still rejects obvious multi-glyph crops.
          aggregate += Math.max(0, aspectLogDistance - aspectStats.spread - 0.14) * 0.14
        }
        const geometryAdjustment = (
          mode === 'math'
            ? mathGeometryAdjustment(labelId, cluster)
            : textGeometryAdjustment(labelId, cluster)
        )
        aggregate = Math.max(0, aggregate + geometryAdjustment)
        const baseDistance = baseAggregate === null
          ? null
          : Math.max(0, baseAggregate + geometryAdjustment)
        const baseConfidence = baseDistance === null
          ? 0
          : Math.round(clamp(1 - baseDistance / 0.62) * 100)
        const personalConfidence = bestPersonalDistance === null
          ? 0
          : Math.round(clamp(personalFit * (0.72 + reliability * 0.28)) * 100)
        return {
          labelId,
          distance: aggregate,
          baseConfidence,
          // A class may still have historical training statistics while its
          // personal shapes were rejected by the input-specific shortlist.
          // In that case only the base references actually matched, so do not
          // misreport dormant training as direct evidence for this crop.
          personalSupport: personal.length ? (stats?.trustedCount ?? personal.length) : 0,
          personalConfidence,
          aspectFit,
        }
      })
      .sort((a, b) => a.distance - b.distance)

    const rankedForMode = mode === 'text'
      ? ranked.filter((entry) => isTextLabel(labelMap.get(entry.labelId)))
      : ranked
    const activeRanking = rankedForMode.length ? rankedForMode : ranked
    const best = activeRanking[0]
    const runnerUp = activeRanking[1]
    const bestLabel = best ? labelMap.get(best.labelId) : undefined
    const absoluteCertainty = best ? clamp(1 - best.distance / 0.62) : 0
    const marginCertainty = best && runnerUp
      ? clamp((runnerUp.distance - best.distance) / 0.24)
      : absoluteCertainty
    const confidence = Math.round(clamp(absoluteCertainty * 0.72 + marginCertainty * 0.28) * 100)

    const alternatives = activeRanking.slice(0, 32).flatMap((entry) => {
      const label = labelMap.get(entry.labelId)
      if (!label) return []
      return [{
        labelId: label.id,
        char: label.char,
        name: label.name,
        confidence: Math.round(clamp(1 - entry.distance / 0.62) * 100),
        baseConfidence: entry.baseConfidence,
        personalSupport: entry.personalSupport,
        personalConfidence: entry.personalConfidence,
      }]
    })

    const token: RecognitionToken = {
      id: `${id}-${cluster.strokes.length}-${cluster.minX.toFixed(4)}-${cluster.maxX.toFixed(4)}`,
      strokes: cloneStrokes(cluster.strokes),
      imageData: rendered.imageData,
      bbox: rendered.bbox,
      labelId: bestLabel?.id ?? '',
      char: bestLabel?.char ?? '?',
      name: bestLabel?.name ?? 'Unbekannt',
      latex: bestLabel?.latex ?? '?',
      confidence,
      alternatives,
      visualLabelId: bestLabel?.id ?? '',
      visualConfidence: confidence,
      baseConfidence: best?.baseConfidence ?? 0,
      personalSupport: best?.personalSupport ?? 0,
      personalConfidence: best?.personalConfidence ?? 0,
      layout: cluster.fraction,
    }
    return { token, distance: best?.distance ?? 1, aspectFit: best?.aspectFit ?? 0 }
  }

  const textHypothesisScore = (
    source: StrokeCluster,
    classified: { token: RecognitionToken; distance: number; aspectFit: number }[],
    independentSegmentationEvidence = 0,
  ) => {
    const reranked = applyTextReranking(classified.map((entry) => entry.token), labels, language)
    const value = recognizedSentence(reranked).replace(/\s+/gu, '')
    const evidence = lexicalWordEvidence(value, language)
    const averageConfidence = reranked.reduce((sum, token) => sum + token.confidence, 0) / Math.max(1, reranked.length)
    const averageDistance = classified.reduce((sum, entry) => sum + entry.distance, 0) / Math.max(1, classified.length)
    const physicalWidth = (source.maxX - source.minX) * SOURCE_WIDTH
    const physicalHeight = Math.max(1, (source.maxY - source.minY) * SOURCE_HEIGHT)
    const aspect = physicalWidth / physicalHeight
    const strongBoundaries = strongInternalTextBoundaries(source)
    const expectedParts = Math.max(1, Math.min(10, Math.round(aspect / 0.78)))
    const referenceTokenHeight = Math.max(0.01, median(
      reranked
        .filter((token) => /^\p{L}$/u.test(token.char))
        .map((token) => token.bbox[3]),
    ))
    const widthPenalty = reranked.reduce((penalty, token) => {
      const ratio = token.bbox[2] * SOURCE_WIDTH / Math.max(1, token.bbox[3] * SOURCE_HEIGHT)
      const relativeHeight = token.bbox[3] / referenceTokenHeight
      if (/^\p{L}$/u.test(token.char) && relativeHeight < 0.48) {
        penalty += (0.48 - relativeHeight) * 1.55
      }
      if (ratio < 0.075) return penalty + (0.075 - ratio) * 2.2
      if (ratio > 1.35) return penalty + (ratio - 1.35) * 0.18
      return penalty
    }, 0)
    let score = averageConfidence / 100 * 1.18 + (1 - clamp(averageDistance / 0.62)) * 0.42
      + independentSegmentationEvidence
    score -= widthPenalty
    const untouchedPersonalGlyph = classified.length === 1 ? classified[0].token : null
    if (
      untouchedPersonalGlyph &&
      (untouchedPersonalGlyph.personalSupport ?? 0) >= 2 &&
      hasReliableSelectedPersonalEvidence(untouchedPersonalGlyph) &&
      untouchedPersonalGlyph.confidence >= 56 &&
      (
        (untouchedPersonalGlyph.personalConfidence ?? 0) >= 4 ||
        source.strokes.length >= 2
      )
    ) {
      // A repeatedly trained broad glyph (B, m, W, …) can contain the same
      // narrow passages as several cursive letters. Previously the dictionary
      // bonus for an invented word such as "ist" or "der" always beat that
      // complete personal shape. Preserve strong whole-glyph evidence while
      // still letting genuinely long connected words win through their aspect
      // and lexical score.
      const personalFit = clamp((untouchedPersonalGlyph.personalConfidence ?? 0) / 100)
      const support = clamp(Math.log2((untouchedPersonalGlyph.personalSupport ?? 0) + 1) / 4)
      const aspectPlausibility = 1 - clamp((aspect - 1.55) / 1.35)
      score += (
        0.86 +
        untouchedPersonalGlyph.confidence / 100 * 0.5 +
        personalFit * 0.66 +
        support * 0.18
      ) * (0.78 + aspectPlausibility * 0.22) * (
        0.22 + classified[0].aspectFit * 0.78
      )
      const decisiveRepeatedWholeGlyph = (
        (untouchedPersonalGlyph.personalSupport ?? 0) >= 3 &&
        untouchedPersonalGlyph.confidence >= 80 &&
        (untouchedPersonalGlyph.personalConfidence ?? 0) >= 20
      )
      if (decisiveRepeatedWholeGlyph) {
        // The complete personal classifier is independent evidence that this
        // broad ink is one glyph.  Do not let a coincidental internal valley
        // plus a two-letter dictionary word split a 93%-certain trained n into
        // "in", or d into "Ja".  Real connected words do not pass all three
        // repeated whole-form gates at once.
        score += 1.28 * (0.65 + aspectPlausibility * 0.35)
      }
    }
    if (reranked.length === 1) {
      // A close physical match to either the personal or generic reference is
      // independent whole-glyph evidence. It prevents internal loops in a/c/o
      // and arches in m/u from winning merely because their fragments spell a
      // frequent short dictionary word.
      score += classified[0].aspectFit * 0.36
      if (aspect > 1.12) score -= Math.min(0.72, (aspect - 1.12) * 0.3)
      if (strongBoundaries.length) {
        const boundaryStrength = strongBoundaries.reduce((best, candidate) => (
          Math.max(best, candidate.source === 'ink-gap'
            ? 1
            : clamp((0.34 - candidate.score) / 0.34))
        ), 0)
        score -= boundaryStrength * 0.46 * (1 - classified[0].aspectFit * 0.82)
      }
    }
    if (reranked.length > 1) {
      score -= (reranked.length - 1) * 0.026
      // A cut through a cursive connector can look like a surprisingly
      // plausible extra letter. The physical word aspect is therefore a real
      // segmentation prior, not merely a tiny tie breaker.
      score -= Math.abs(reranked.length - expectedParts) * 0.16
      if (evidence.knownWord && evidence.word.length >= 2) {
        score += 0.62 + Math.min(0.2, evidence.word.length * 0.025)
      } else {
        score += evidence.score * 0.16
      }
      const letterRatio = reranked.filter((token) => /^\p{L}$/u.test(token.char)).length / reranked.length
      if (letterRatio >= 0.8) score += 0.08
      const penLiftBodyCount = penLiftTextBodyClusters(source).length
      if (penLiftBodyCount >= 2 && reranked.length === penLiftBodyCount) {
        // Complete pen-lift bodies are independent segmentation evidence.
        // This prevents two quickly written, slightly touching letters from
        // collapsing into one broad glyph while leaving one-stroke cursive
        // words and tightly parallel integral signs unchanged.
        score += 0.52
      }
    }
    return { tokens: reranked, score }
  }

  let wholeTextAssessmentTokens: RecognitionToken[] | null = null
  const tokens = mode === 'text'
    ? (() => {
        const guidedClusterCounts = (
          Number.isInteger(textCharacterCountHint) &&
          textCharacterCountHint! >= clusters.length &&
          clusters.length > 1
        ) ? (() => {
            // Reserve one character for every detached ink cluster, then
            // distribute the remaining line count by physical width. This
            // turns an eight-character line made from a six-character
            // connected body plus two detached letters into 6+1+1 instead
            // of blindly splitting the wide body into eight and returning
            // ten tokens overall.
            const counts = clusters.map(() => 1)
            const remaining = textCharacterCountHint! - clusters.length
            const widths = clusters.map((cluster) => Math.max(0.001, cluster.maxX - cluster.minX))
            const widthTotal = widths.reduce((sum, width) => sum + width, 0)
            const quotas = widths.map((width) => remaining * width / widthTotal)
            quotas.forEach((quota, index) => { counts[index] += Math.floor(quota) })
            let unassigned = textCharacterCountHint! - counts.reduce((sum, count) => sum + count, 0)
            quotas
              .map((quota, index) => ({ index, remainder: quota - Math.floor(quota) }))
              .sort((first, second) => second.remainder - first.remainder)
              .forEach(({ index }) => {
                if (unassigned <= 0) return
                counts[index] += 1
                unassigned -= 1
              })
            return counts
          })()
          : null
        const options = clusters.map((cluster, clusterIndex) => {
          const clusterCharacterCountHint = clusters.length === 1
            ? textCharacterCountHint
            : guidedClusterCounts?.[clusterIndex]
          const clusterAspect = (
            (cluster.maxX - cluster.minX) * SOURCE_WIDTH /
            Math.max(1, (cluster.maxY - cluster.minY) * SOURCE_HEIGHT)
          )
          const wholeAssessment = clusterCharacterCountHint === undefined
            ? classifyCluster(cluster, `${clusterIndex}-whole-assessment`)
            : null
          if (clusters.length === 1 && wholeAssessment) {
            // Keep the untouched full-ink assessment until after the same
            // single-character reranking used by the count=1 path.  The raw
            // classifier can contain the trained glyph as its visual winner
            // while its final personal confidence is only established by
            // that reranker; testing the raw token here used to miss exactly
            // the broad trained d/n shapes that were later split into Ja/in.
            wholeTextAssessmentTokens = [wholeAssessment.token]
          }
          const compactWholeAssessment = clusterAspect < 1.62 ? wholeAssessment : null
          const allowCompactDensitySplit = Boolean(compactWholeAssessment && (
            compactWholeAssessment.token.confidence < 48 ||
            (
              (compactWholeAssessment.token.personalSupport ?? 0) >= 2 &&
              compactWholeAssessment.aspectFit < 0.24
            )
          ))
          const decisiveRepeatedWholeGlyph = Boolean(wholeAssessment && (
            (wholeAssessment.token.personalSupport ?? 0) >= 3 &&
            hasReliableSelectedPersonalEvidence(wholeAssessment.token) &&
            wholeAssessment.token.confidence >= 80
          ))
          const hypotheses = clusterCharacterCountHint === 1 || decisiveRepeatedWholeGlyph
            ? [[cluster]]
            : connectedTextSegmentationHypotheses(
                cluster,
                clusterCharacterCountHint,
                allowCompactDensitySplit,
              )
          const scored = hypotheses
            .map((hypothesis, hypothesisIndex) => {
              const wholePenLiftPartition = hypothesis.length >= 2 && (
                hypothesis.reduce((sum, part) => sum + part.strokes.length, 0) === cluster.strokes.length &&
                hypothesis.every((part) => part.strokes.every((stroke) => cluster.strokes.includes(stroke)))
              )
              const spatialEvidence = textSegmentationEvidence(cluster, hypothesis)
              return textHypothesisScore(
                cluster,
                hypothesis.length === 1 && hypothesis[0] === cluster && wholeAssessment
                  ? [wholeAssessment]
                  : hypothesis.map((part, partIndex) => classifyCluster(part, `${clusterIndex}-${hypothesisIndex}-${partIndex}`)),
                Math.max(wholePenLiftPartition ? 0.62 : 0, spatialEvidence),
              )
            })
            .sort((first, second) => second.score - first.score)
          const competitive = scored
            .filter((entry, index, entries) => index < 3 && (index === 0 || entry.score >= entries[0].score - 0.48))
          const exactGuided = Number.isInteger(clusterCharacterCountHint)
            ? scored.find((entry) => entry.tokens.length === clusterCharacterCountHint)
            : undefined
          return exactGuided && !competitive.includes(exactGuided)
            ? [...competitive, exactGuided]
            : competitive
        })

        // A line can contain several geometric clusters even though it is one
        // connected word (large pen lifts, a detached dot, or an unusually
        // wide intra-letter gap). Per-cluster beams cannot guarantee a global
        // character count in that case. Keep them, but add one bounded
        // whole-line segmentation so the neural count prior is genuinely
        // evaluated across all ink on the line.
        const combinedLineOptions = Number.isInteger(textCharacterCountHint)
          && textCharacterCountHint! > 0
          && clusters.length > 1
          ? (() => {
              const combined = clusterFromStrokes(strokes)
              if (!combined) return []
              const scored = connectedTextSegmentationHypotheses(combined, textCharacterCountHint)
                .map((hypothesis, hypothesisIndex) => textHypothesisScore(
                  combined,
                  hypothesis.map((part, partIndex) => classifyCluster(
                    part,
                    `combined-${hypothesisIndex}-${partIndex}`,
                  )),
                  textSegmentationEvidence(combined, hypothesis),
                ))
                .sort((first, second) => second.score - first.score)
              const exact = scored.filter((entry) => entry.tokens.length === textCharacterCountHint)
              return (exact.length ? exact : scored).slice(0, 3)
            })()
          : []

        type SegmentationBeam = { tokens: RecognitionToken[]; localScore: number; choices: number }
        let beams: SegmentationBeam[] = [{ tokens: [], localScore: 0, choices: 0 }]
        options.forEach((clusterOptions) => {
          beams = beams
            .flatMap((beam) => clusterOptions.map((option) => ({
              tokens: [...beam.tokens, ...option.tokens],
              localScore: beam.localScore + option.score,
              choices: beam.choices + 1,
            })))
            .sort((first, second) => (
              second.localScore / Math.max(1, second.choices) -
              first.localScore / Math.max(1, first.choices)
            ))
            .slice(0, 64)
        })
        if (combinedLineOptions.length) {
          const combinedBeams = combinedLineOptions.map((option) => ({
            tokens: option.tokens,
            localScore: option.score,
            choices: 1,
          }))
          // Reserve the bounded global alternatives. Sorting everything and
          // slicing first allowed 64 locally plausible combinations to evict
          // the only beams that actually satisfied the requested line count.
          beams = [...beams.slice(0, Math.max(0, 64 - combinedBeams.length)), ...combinedBeams]
        }

        const evaluated = beams.map((beam) => {
          const reranked = applyTextReranking(beam.tokens.map((token) => ({
            ...token,
            alternatives: token.alternatives.map((alternative) => ({ ...alternative })),
            context: token.context ? { ...token.context } : undefined,
          })), labels, language)
          const sentence = recognizedSentence(reranked)
          const words = sentence
            .split(/[\s.,;:!?()[\]{}]+/u)
            .map((word) => normalizedWord(word, language))
            .filter(Boolean)
          const lexical = words.reduce((sum, word) => sum + lexicalWordEvidence(word, language).score, 0)
          const knownWords = words.filter((word) => lexicalWordEvidence(word, language).knownWord).length
          const unknownLongWords = words.filter((word) => (
            word.length >= 3 && !lexicalWordEvidence(word, language).knownWord
          )).length
          const localAverage = beam.localScore / Math.max(1, beam.choices)
          const excessivePieces = Math.max(0, reranked.length - strokes.length * 4)
          const hintedLengthPenalty = Number.isInteger(textCharacterCountHint) && textCharacterCountHint! > 0
            ? Math.abs(reranked.length - textCharacterCountHint!) * 0.34
            : 0
          const hintCharacters = Array.from(normalizeGermanSharpS(textCharacterHint ?? ''))
            .filter((character) => !/\s/u.test(character))
          const hintCompatibility = hintCharacters.length === reranked.length && hintCharacters.length > 0
            ? reranked.reduce((sum, token, index) => {
                const expected = hintCharacters[index]
                const candidates = [{
                  char: token.char,
                  confidence: token.confidence,
                  personalSupport: token.personalSupport ?? 0,
                  personalConfidence: token.personalConfidence ?? 0,
                }, ...token.alternatives.map((alternative) => ({
                  char: alternative.char,
                  confidence: alternative.confidence,
                  personalSupport: alternative.personalSupport ?? 0,
                  personalConfidence: alternative.personalConfidence ?? 0,
                }))]
                const matching = candidates
                  .filter((candidate) => candidate.char === expected)
                  .sort((first, second) => (
                    second.confidence + second.personalConfidence * 0.18 + Math.min(12, second.personalSupport * 1.5) -
                    first.confidence - first.personalConfidence * 0.18 - Math.min(12, first.personalSupport * 1.5)
                  ))[0]
                return sum + (matching
                  ? matching.confidence / 100 + Math.min(0.18, matching.personalConfidence / 500)
                  : -0.34)
              }, 0) / hintCharacters.length
            : 0
          return {
            tokens: reranked,
            score: (
              localAverage +
              lexical * 0.52 +
              knownWords * 0.28 -
              unknownLongWords * 0.08 -
              excessivePieces * 0.025 -
              hintedLengthPenalty +
              hintCompatibility * 0.58
            ),
          }
        })
        const exactCombinedLine = Number.isInteger(textCharacterCountHint)
          ? combinedLineOptions.filter((entry) => entry.tokens.length === textCharacterCountHint)
          : []
        if (exactCombinedLine.length) {
          return exactCombinedLine[Math.min(
            Math.max(0, textSegmentationCandidateIndex),
            exactCombinedLine.length - 1,
          )].tokens
        }
        const exactLength = Number.isInteger(textCharacterCountHint) && textCharacterCountHint! > 0
          ? evaluated.filter((entry) => entry.tokens.length === textCharacterCountHint)
          : []
        // This is an alternative beam, not the sole recognition path: callers
        // retain the unrestricted segmentation beside it. If a line model has
        // supplied a concrete length and an exact personal segmentation
        // exists, returning a different length here merely duplicates the
        // unrestricted beam and lets a plausible short dictionary word erase
        // trained characters.
        const rankedCandidates = (exactLength.length ? exactLength : evaluated)
          .sort((first, second) => second.score - first.score)
        return rankedCandidates[Math.min(
          Math.max(0, textSegmentationCandidateIndex),
          Math.max(0, rankedCandidates.length - 1),
        )]?.tokens ?? []
      })()
    : clusters.map((cluster, index) => classifyCluster(cluster, String(index)).token)

  if (mode === 'text') {
    const reranked = applyTextReranking(tokens, labels, language)
    const visibleCount = reranked.filter((token) => !token.isLayout).length
    // The assessment is assigned inside the segmentation callback. Preserve
    // its explicit nullable type because TypeScript's closure flow analysis
    // cannot observe that synchronous assignment.
    const completeWholeAssessment = wholeTextAssessmentTokens as RecognitionToken[] | null
    if (visibleCount > 1 && completeWholeAssessment) {
      const rerankedWhole = applyTextReranking(completeWholeAssessment.map((token) => ({
        ...token,
        alternatives: token.alternatives.map((alternative) => ({ ...alternative })),
        context: token.context ? { ...token.context } : undefined,
      })), labels, language)
      const whole = rerankedWhole.find((token) => !token.isLayout)
      if (
        whole &&
        (whole.personalSupport ?? 0) >= 3 &&
        hasReliableSelectedPersonalEvidence(whole) &&
        whole.confidence >= 80 &&
        (whole.personalConfidence ?? 0) >= 20
      ) {
        // A later line-level lexical pass must not reintroduce alternatives
        // that the decisive complete-glyph gate already ruled out locally.
        return rerankedWhole
      }
    }
    if (
      Number.isInteger(textCharacterCountHint) &&
      textCharacterCountHint! > 0 &&
      visibleCount !== textCharacterCountHint
    ) {
      // A guided candidate is deliberately evaluated beside the unrestricted
      // segmentation by the caller. Therefore it must honour its advertised
      // character count. Multi-cluster beam combinations can occasionally
      // escape the inner exact-length filter; rebuild one bounded whole-line
      // candidate here instead of returning the same wrong-length sequence a
      // second time.
      const combined = clusterFromStrokes(strokes)
      const exactCandidates = combined
        ? connectedTextSegmentationHypotheses(combined, textCharacterCountHint)
          .filter((hypothesis) => hypothesis.length === textCharacterCountHint)
          .map((hypothesis, hypothesisIndex) => textHypothesisScore(
            combined,
            hypothesis.map((part, partIndex) => classifyCluster(
              part,
              `guided-fallback-${hypothesisIndex}-${partIndex}`,
            )),
            textSegmentationEvidence(combined, hypothesis),
          ))
          .sort((first, second) => second.score - first.score)
        : []
      const exact = exactCandidates[Math.min(
        Math.max(0, textSegmentationCandidateIndex),
        Math.max(0, exactCandidates.length - 1),
      )]
      if (exact) return exact.tokens
    }
    return reranked
  }
  return applyContextualReranking(tokens, labels, layoutExamples)
}

const correctionTokenFromCluster = (
  cluster: StrokeCluster,
  template: RecognitionToken,
  index: number,
): RecognitionToken => {
  const rendered = renderCluster(cluster)
  return {
    ...template,
    id: `${template.id}-correction-segment-${index}`,
    strokes: cloneStrokes(cluster.strokes),
    imageData: rendered.imageData,
    bbox: rendered.bbox,
    labelId: '',
    char: '?',
    name: 'Korrektursegment',
    latex: '?',
    confidence: 0,
    alternatives: [],
    visualLabelId: '',
    visualConfidence: 0,
    personalSupport: 0,
    personalConfidence: 0,
    isLayout: false,
    layout: undefined,
    context: undefined,
    spaceBefore: index === 0 ? template.spaceBefore : false,
    lineBreakBefore: index === 0 ? template.lineBreakBefore : false,
  }
}

const resegmentTextTokenGroup = (
  tokens: RecognitionToken[],
  targetCount: number,
) => {
  if (!tokens.length || targetCount <= 0) return null
  if (tokens.length === targetCount) return tokens
  const cluster = clusterFromStrokes(tokens.flatMap((token) => token.strokes))
  if (!cluster) return null
  if (targetCount === 1) return [correctionTokenFromCluster(cluster, tokens[0], 0)]

  const candidates = textCutCandidates(cluster)
  const snapped = snappedTextBoundaries(candidates, cluster.minX, cluster.maxX, targetCount)
  const uniform = Array.from({ length: targetCount - 1 }, (_, index) => (
    cluster.minX + (cluster.maxX - cluster.minX) * (index + 1) / targetCount
  ))
  const hypotheses = [
    ...connectedTextSegmentationHypotheses(cluster).filter((entry) => entry.length === targetCount),
    ...(snapped.length === targetCount - 1 ? [splitTextCluster(cluster, snapped)] : []),
    splitTextCluster(cluster, uniform),
  ].filter((entry) => entry.length === targetCount)
  if (!hypotheses.length) return null
  const best = hypotheses
    .map((parts) => {
      const widths = parts.map((part) => Math.max(1, (part.maxX - part.minX) * SOURCE_WIDTH))
      const average = widths.reduce((sum, width) => sum + width, 0) / widths.length
      const spread = widths.reduce((sum, width) => sum + Math.abs(width - average), 0) /
        Math.max(1, widths.length * average)
      const tiny = widths.filter((width) => width < Math.max(4, average * 0.16)).length
      return { parts, score: spread + tiny * 0.8 }
    })
    .sort((first, second) => first.score - second.score)[0]?.parts
  return best?.map((part, index) => correctionTokenFromCluster(part, tokens[0], index)) ?? null
}

/**
 * Reconstructs trainable glyph crops when a line recognizer merged or split
 * characters differently from the user's confirmed transcription.
 */
export const resegmentTextTokensForCorrection = (
  tokens: RecognitionToken[],
  targetWordLengths: number[],
) => {
  const visible = tokens.filter((token) => !token.isLayout)
  const targetCount = targetWordLengths.reduce((sum, length) => sum + length, 0)
  if (!visible.length || targetCount <= 0) return null
  const groups: RecognitionToken[][] = []
  visible.forEach((token) => {
    if (!groups.length || token.spaceBefore || token.lineBreakBefore) groups.push([])
    groups.at(-1)!.push(token)
  })
  if (groups.length === targetWordLengths.length) {
    const segmented = groups.map((group, index) => resegmentTextTokenGroup(group, targetWordLengths[index]))
    if (segmented.every(Boolean)) return segmented.flatMap((entry) => entry!)
  }
  return resegmentTextTokenGroup(visible, targetCount)
}

export const recognizeMathDocument = (
  strokes: Stroke[],
  model: RecognitionModel,
  labels: LabelDefinition[],
  layoutExamples: MathLayoutExample[] = [],
  language: RecognitionLanguage = 'de',
) => {
  const lines = groupRecognitionLines(strokes)
  if (lines.length <= 1) {
    return recognizeExpression(strokes, model, labels, 'math', layoutExamples, language)
  }
  return lines.flatMap((line, lineIndex) => {
    const tokens = recognizeExpression(line.strokes, model, labels, 'math', layoutExamples, language)
    if (lineIndex > 0 && tokens[0]) tokens[0].lineBreakBefore = true
    return tokens
  })
}

type FormattedAtom = {
  value: string
  bbox: [number, number, number, number]
  sourceId?: string
  labelId?: string
  char?: string
}

type MathLayoutItem = {
  key: string
  bbox: [number, number, number, number]
  token?: RecognitionToken
  value?: string
  isCompound?: boolean
  labelId?: string
}

const scriptRole = (
  base: FormattedAtom,
  candidate: FormattedAtom,
  layoutExamples: MathLayoutExample[] = [],
) => {
  const [baseX, baseY, baseWidth, baseHeight] = base.bbox
  const [candidateX, candidateY, candidateWidth, candidateHeight] = candidate.bbox
  if (candidateHeight > baseHeight * 0.76) return null

  const candidateCenterX = candidateX + candidateWidth / 2
  const candidateCenterY = candidateY + candidateHeight / 2
  const candidateBottom = candidateY + candidateHeight
  const baseBottom = baseY + baseHeight
  const nearBase = (
    candidateCenterX >= baseX + baseWidth * 0.34 &&
    candidateX <= baseX + baseWidth + Math.max(0.12, baseWidth * 1.4)
  )
  if (!nearBase) return null

  // A smaller following letter is not a subscript merely because a tall
  // capital/ascender gives it a lower centre. Real handwriting has noticeably
  // more baseline jitter than rendered type: six percent of the base height
  // was small enough to turn an ordinary `Ha` into `H_{a}`. Require a clear
  // displacement relative to both glyphs. Eleven percent still classified
  // roughly one in six realistic height/jitter combinations as a script in a
  // systematic baseline sweep. Sixteen percent covers ordinary pen drift but
  // remains far below the displacement of genuine indices and limits.
  // Learned layout examples may refine
  // a genuinely displaced candidate below, but never relax this hard gate.
  const verticalProtrusion = Math.max(
    0.005,
    baseHeight * 0.16,
    candidateHeight * 0.2,
  )
  const supportsSuperscript = (
    candidateY <= baseY - verticalProtrusion &&
    candidateBottom <= baseY + baseHeight * 0.58
  )
  const supportsSubscript = (
    candidateBottom >= baseBottom + verticalProtrusion &&
    candidateY >= baseY + baseHeight * 0.42
  )
  if (!supportsSuperscript && !supportsSubscript) return null

  const learnedSuperscript = learnedRelationDistance(
    base.labelId,
    candidate.labelId,
    base.bbox,
    candidate.bbox,
    'superscript',
    layoutExamples,
  )
  const learnedSubscript = learnedRelationDistance(
    base.labelId,
    candidate.labelId,
    base.bbox,
    candidate.bbox,
    'subscript',
    layoutExamples,
  )
  const learnedBest = Math.min(learnedSuperscript, learnedSubscript)
  if (learnedBest < 0.68) {
    if (learnedSuperscript <= learnedSubscript && supportsSuperscript) return 'superscript' as const
    if (learnedSubscript < learnedSuperscript && supportsSubscript) return 'subscript' as const
    // A previously learned relation may rank the wrong side after a noisy
    // sample. Geometry remains the hard safety boundary; training can refine
    // a valid script position but can no longer turn baseline text into one.
    if (supportsSuperscript && learnedSuperscript < 0.68) return 'superscript' as const
    if (supportsSubscript && learnedSubscript < 0.68) return 'subscript' as const
  }
  if (supportsSuperscript && candidateCenterY <= baseY + baseHeight * 0.31) return 'superscript' as const
  if (supportsSubscript && candidateCenterY >= baseY + baseHeight * 0.69) return 'subscript' as const
  return null
}

const isLatinWordAtom = (atom: FormattedAtom) => Boolean(
  atom.char && /^\p{L}$/u.test(atom.char) && (
    atom.labelId?.startsWith('latin_') || atom.labelId?.startsWith('german_')
  ),
)

const wordAtomNeighbour = (first: FormattedAtom, second: FormattedAtom) => {
  if (!isLatinWordAtom(first) || !isLatinWordAtom(second)) return false
  const gap = second.bbox[0] - (first.bbox[0] + first.bbox[2])
  const physicalXHeight = Math.min(first.bbox[3], second.bbox[3]) * SOURCE_HEIGHT / SOURCE_WIDTH
  return gap <= clamp(physicalXHeight * 0.46, 0.018, 0.05)
}

/**
 * A tall capital or ascender and the x-height body of the next letter can
 * satisfy a pairwise subscript test even though both belong to one ordinary
 * word.  Verify such a relation against the complete local letter run: a
 * dictionary-backed/title-cased run whose candidate and base still share the
 * run's baseline is prose, not a script.  A real `x_{max}` keeps its separate
 * lower baseline and its substantially smaller glyphs, so it is not blocked.
 */
const ordinaryWordScriptConflict = (
  atoms: FormattedAtom[],
  baseIndex: number,
  candidateIndex: number,
) => {
  const base = atoms[baseIndex]
  const candidate = atoms[candidateIndex]
  if (!base || !candidate || !isLatinWordAtom(base) || !isLatinWordAtom(candidate)) return false

  let start = baseIndex
  while (start > 0 && wordAtomNeighbour(atoms[start - 1], atoms[start])) start -= 1
  let end = candidateIndex
  while (end + 1 < atoms.length && wordAtomNeighbour(atoms[end], atoms[end + 1])) end += 1
  const run = atoms.slice(start, end + 1)
  if (run.length < 3 || !run.every(isLatinWordAtom)) return false

  const word = run.map((atom) => atom.char).join('')
  const lexicalScore = Math.max(
    lexicalWordEvidence(word, 'de').score,
    lexicalWordEvidence(word, 'en').score,
  )
  const titleCased = /^[A-ZÄÖÜ][a-zäöü]{2,}$/u.test(word)
  const pureLetterLine = atoms.length >= 4 && atoms.every(isLatinWordAtom)
  if (lexicalScore < 0.5 && !titleCased && !pureLetterLine) return false

  const bottoms = run.map((atom) => atom.bbox[1] + atom.bbox[3])
  const heights = run.map((atom) => atom.bbox[3])
  const baseline = median(bottoms)
  const referenceHeight = median(heights)
  // Compare the candidate with the local x-height, not only with the first
  // glyph. A capital or tall ascender may legitimately be more than twice as
  // high as the following lowercase bodies. The old 56% base-height gate
  // therefore rejected real words before their shared baseline could be
  // considered. A true multi-letter index still forms a separate baseline,
  // so its base falls outside this deliberately bounded tolerance.
  if (candidate.bbox[3] < Math.max(base.bbox[3] * 0.36, referenceHeight * 0.52)) return false
  const tolerance = Math.max(0.012, referenceHeight * 0.52)
  const baseBottom = base.bbox[1] + base.bbox[3]
  const candidateBottom = candidate.bbox[1] + candidate.bbox[3]
  if (
    Math.abs(baseBottom - baseline) > tolerance ||
    Math.abs(candidateBottom - baseline) > tolerance
  ) return false

  const aligned = run.filter((atom) => (
    Math.abs(atom.bbox[1] + atom.bbox[3] - baseline) <= tolerance
  ))
  if (aligned.length < Math.max(3, Math.ceil(run.length * 0.75))) return false

  return run.some((atom, index) => {
    const absoluteIndex = start + index
    return absoluteIndex !== baseIndex && absoluteIndex !== candidateIndex &&
      Math.abs(atom.bbox[1] + atom.bbox[3] - candidateBottom) <= tolerance
  })
}

const combinedItemBounds = (
  items: MathLayoutItem[],
  fallback: [number, number, number, number],
) => items.reduce<[number, number, number, number]>((bounds, item) => {
  const [x, y, width, height] = item.bbox
  const minX = Math.min(bounds[0], x)
  const minY = Math.min(bounds[1], y)
  const maxX = Math.max(bounds[0] + bounds[2], x + width)
  const maxY = Math.max(bounds[1] + bounds[3], y + height)
  return [minX, minY, maxX - minX, maxY - minY]
}, [...fallback])

const itemValue = (item: MathLayoutItem, mode: 'text' | 'latex') => {
  if (item.value !== undefined) return item.value
  if (!item.token) return ''
  return mode === 'latex' ? item.token.latex : item.token.char
}

type LimitRole = 'upper' | 'lower'

const collectLimitItems = (
  anchor: MathLayoutItem,
  items: MathLayoutItem[],
  role: LimitRole,
  layoutExamples: MathLayoutExample[],
) => {
  const [anchorX, anchorY, anchorWidth, anchorHeight] = anchor.bbox
  const anchorRight = anchorX + anchorWidth
  const candidates = items.filter((item) => {
    if (item === anchor || item.token?.isLayout || (item.token && LARGE_OPERATOR_IDS.has(item.token.labelId))) {
      return false
    }
    const [x, y, width, height] = item.bbox
    if (height > anchorHeight * 0.8 && !item.isCompound) return false
    const centerX = x + width / 2
    const centerY = y + height / 2
    const learnedUpper = learnedRelationDistance(
      anchor.token?.labelId ?? anchor.labelId,
      item.token?.labelId ?? item.labelId,
      anchor.bbox,
      item.bbox,
      'upper_limit',
      layoutExamples,
    )
    const learnedLower = learnedRelationDistance(
      anchor.token?.labelId ?? anchor.labelId,
      item.token?.labelId ?? item.labelId,
      anchor.bbox,
      item.bbox,
      'lower_limit',
      layoutExamples,
    )
    const learnedBest = Math.min(learnedUpper, learnedLower)
    if (learnedBest < 0.72) {
      return role === 'upper' ? learnedUpper <= learnedLower : learnedLower < learnedUpper
    }
    if (centerX < anchorX - anchorWidth * 0.55) return false
    if (centerX > anchorRight + Math.max(0.18, anchorWidth * 2.8)) return false
    return role === 'upper'
      ? centerY <= anchorY + anchorHeight * 0.33
      : centerY >= anchorY + anchorHeight * 0.67
  })
  const selected = candidates.filter((item) => {
    const learnedDistance = learnedRelationDistance(
      anchor.token?.labelId ?? anchor.labelId,
      item.token?.labelId ?? item.labelId,
      anchor.bbox,
      item.bbox,
      role === 'upper' ? 'upper_limit' : 'lower_limit',
      layoutExamples,
    )
    if (learnedDistance < 0.72) return true
    const centerX = item.bbox[0] + item.bbox[2] / 2
    return centerX <= anchorRight + anchorWidth * 0.72 + 0.008
  })
  if (selected.length === 0) return []

  const selectedKeys = new Set(selected.map((item) => item.key))
  const maximumGap = Math.max(0.018, anchorWidth * 0.34)
  let changed = true
  while (changed) {
    changed = false
    candidates.forEach((candidate) => {
      if (selectedKeys.has(candidate.key)) return
      const [candidateX, candidateY, candidateWidth, candidateHeight] = candidate.bbox
      const candidateCenterY = candidateY + candidateHeight / 2
      const connected = selected.some((item) => {
        const [x, y, width, height] = item.bbox
        const gap = Math.max(candidateX - (x + width), x - (candidateX + candidateWidth), 0)
        const verticallyAligned = Math.abs(candidateCenterY - (y + height / 2)) <= anchorHeight * 0.28
        return gap <= maximumGap && verticallyAligned
      })
      if (connected) {
        selected.push(candidate)
        selectedKeys.add(candidate.key)
        changed = true
      }
    })
  }
  return selected.sort((first, second) => first.bbox[0] - second.bbox[0])
}

const groupLargeOperatorLimits = (
  items: MathLayoutItem[],
  mode: 'text' | 'latex',
  depth: number,
  layoutExamples: MathLayoutExample[],
) => {
  const working = [...items]
  const anchors = items
    .filter((item) => item.token && LARGE_OPERATOR_IDS.has(item.token.labelId))
    .sort((first, second) => first.bbox[0] - second.bbox[0])

  anchors.forEach((anchor) => {
    if (!working.some((item) => item.key === anchor.key)) return
    const upper = collectLimitItems(anchor, working, 'upper', layoutExamples)
    const upperKeys = new Set(upper.map((item) => item.key))
    const lower = collectLimitItems(
      anchor,
      working.filter((item) => !upperKeys.has(item.key)),
      'lower',
      layoutExamples,
    )
    if (upper.length === 0 && lower.length === 0) return

    const upperValue = formatMathItems(upper, mode, depth + 1, layoutExamples)
    const lowerValue = formatMathItems(lower, mode, depth + 1, layoutExamples)
    const baseValue = itemValue(anchor, mode)
    const value = mode === 'latex'
      ? `${baseValue}${lowerValue ? `_{${lowerValue}}` : ''}${upperValue ? `^{${upperValue}}` : ''}`
      : `${baseValue}${lowerValue ? `_${lower.length > 1 || lower.some((item) => item.isCompound) ? `(${lowerValue})` : lowerValue}` : ''}${upperValue ? `^${upper.length > 1 || upper.some((item) => item.isCompound) ? `(${upperValue})` : upperValue}` : ''}`
    const members = [anchor, ...upper, ...lower]
    const memberKeys = new Set(members.map((item) => item.key))
    for (let index = working.length - 1; index >= 0; index -= 1) {
      if (memberKeys.has(working[index].key)) working.splice(index, 1)
    }
    working.push({
      key: `limits-${anchor.key}`,
      bbox: combinedItemBounds(members, anchor.bbox),
      value,
      isCompound: true,
      labelId: anchor.token?.labelId ?? anchor.labelId,
    })
  })
  return working
}

function formatLinearItems(
  items: MathLayoutItem[],
  mode: 'text' | 'latex',
  depth: number,
  layoutExamples: MathLayoutExample[],
) {
  const sorted = groupLargeOperatorLimits(items, mode, depth, layoutExamples)
    .filter((item) => !item.token?.isLayout)
    .sort((a, b) => a.bbox[0] - b.bbox[0])
  const consumed = new Set<number>()
  const atoms: FormattedAtom[] = []
  let absoluteBarIndex = 0

  sorted.forEach((item, index) => {
    if (consumed.has(index)) return
    if (item.token?.labelId !== 'operator_sqrt') {
      const value = mode === 'latex' && item.token?.labelId === 'absolute_bar'
        ? absoluteBarIndex++ % 2 === 0 ? '\\lvert' : '\\rvert'
        : itemValue(item, mode)
      atoms.push({
        value,
        bbox: item.bbox,
        sourceId: item.token?.id ?? item.key,
        labelId: item.token?.labelId ?? item.labelId,
        char: item.token?.char,
      })
      return
    }

    const [rootX, rootY, rootWidth, rootHeight] = item.bbox
    const innerItems: MathLayoutItem[] = []
    for (let childIndex = index + 1; childIndex < sorted.length; childIndex += 1) {
      const child = sorted[childIndex]
      const [childX, childY, childWidth, childHeight] = child.bbox
      const centerX = childX + childWidth / 2
      const centerY = childY + childHeight / 2
      const isInside = (
        centerX > rootX + rootWidth * 0.22 &&
        centerX < rootX + rootWidth * 0.98 &&
        centerY > rootY + rootHeight * 0.08 &&
        centerY < rootY + rootHeight * 1.05
      )
      if (isInside) {
        innerItems.push(child)
        consumed.add(childIndex)
      }
    }
    const inner = formatMathItems(innerItems, mode, depth + 1, layoutExamples)
    const value = mode === 'latex'
      ? inner ? `\\sqrt{${inner}}` : '\\sqrt{}'
      : `√${innerItems.length > 1 || innerItems.some((child) => child.isCompound) ? `(${inner})` : inner}`
    atoms.push({ value, bbox: combinedItemBounds(innerItems, item.bbox), labelId: item.token.labelId })
  })

  const groups: { base: FormattedAtom; superscript: FormattedAtom[]; subscript: FormattedAtom[] }[] = []
  atoms.forEach((atom, atomIndex) => {
    const previous = groups.at(-1)
    if (previous) {
      const role = scriptRole(previous.base, atom, layoutExamples)
      const baseIndex = atoms.indexOf(previous.base)
      if (role && !ordinaryWordScriptConflict(atoms, baseIndex, atomIndex)) {
        previous[role].push(atom)
        return
      }
    }
    groups.push({ base: atom, superscript: [], subscript: [] })
  })

  return groups.map((group) => {
    const superscript = group.superscript.map((atom) => atom.value).join(mode === 'latex' ? ' ' : '')
    const subscript = group.subscript.map((atom) => atom.value).join(mode === 'latex' ? ' ' : '')
    if (mode === 'latex') {
      return `${group.base.value}${subscript ? `_{${subscript}}` : ''}${superscript ? `^{${superscript}}` : ''}`
    }
    const textSubscript = subscript ? `_${group.subscript.length > 1 ? `(${subscript})` : subscript}` : ''
    const textSuperscript = superscript ? `^${group.superscript.length > 1 ? `(${superscript})` : superscript}` : ''
    return `${group.base.value}${textSubscript}${textSuperscript}`
  }).join(mode === 'latex' ? ' ' : '')
}

const fractionParts = (bar: MathLayoutItem, items: MathLayoutItem[]) => {
  const [barX, barY, barWidth, barHeight] = bar.bbox
  const barCenterY = barY + barHeight / 2
  const marginX = Math.max(0.006, barWidth * 0.045)
  const toleranceY = Math.max(0.006, barHeight * 0.8)
  const candidates = items.filter((item) => {
    if (item === bar) return false
    const [x, , width] = item.bbox
    const centerX = x + width / 2
    return centerX >= barX - marginX && centerX <= barX + barWidth + marginX
  })
  const numerator = candidates.filter((item) => {
    const [, y, , height] = item.bbox
    return y + height <= barCenterY + toleranceY && y + height / 2 < barCenterY
  })
  const denominator = candidates.filter((item) => {
    const [, y, , height] = item.bbox
    return y >= barCenterY - toleranceY && y + height / 2 > barCenterY
  })
  return { numerator, denominator }
}

function formatMathItems(
  items: MathLayoutItem[],
  mode: 'text' | 'latex',
  depth = 0,
  layoutExamples: MathLayoutExample[] = [],
): string {
  if (items.length === 0) return ''
  if (depth > 8) return formatLinearItems(items, mode, depth, layoutExamples)
  const working = [...items]

  while (true) {
    const match = working
      .filter((item) => item.token?.isLayout && item.token.layout?.role === 'bar')
      .map((bar) => ({ bar, ...fractionParts(bar, working) }))
      .filter((entry) => entry.numerator.length > 0 && entry.denominator.length > 0)
      .sort((first, second) => second.bar.bbox[2] - first.bar.bbox[2])[0]
    if (!match) break

    const numeratorValue = formatMathItems(match.numerator, mode, depth + 1, layoutExamples)
    const denominatorValue = formatMathItems(match.denominator, mode, depth + 1, layoutExamples)
    const value = mode === 'latex'
      ? `\\frac{${numeratorValue}}{${denominatorValue}}`
      : `${match.numerator.length > 1 ? `(${numeratorValue})` : numeratorValue}/${match.denominator.length > 1 ? `(${denominatorValue})` : denominatorValue}`
    const members = [match.bar, ...match.numerator, ...match.denominator]
    const memberKeys = new Set(members.map((item) => item.key))
    const fractionBounds = combinedItemBounds(members, match.bar.bbox)
    for (let index = working.length - 1; index >= 0; index -= 1) {
      if (memberKeys.has(working[index].key)) working.splice(index, 1)
    }
    working.push({
      key: `formatted-${match.bar.key}`,
      bbox: fractionBounds,
      value,
      isCompound: true,
    })
  }

  return formatLinearItems(working, mode, depth, layoutExamples)
}

const formatExpression = (
  tokens: RecognitionToken[],
  mode: 'text' | 'latex',
  layoutExamples: MathLayoutExample[] = [],
) => {
  const lines: RecognitionToken[][] = [[]]
  tokens.forEach((token) => {
    if (token.lineBreakBefore && lines.at(-1)?.length) lines.push([])
    lines.at(-1)!.push(token)
  })
  const values = lines
    .filter((line) => line.length)
    .map((line) => {
      const items = line.map<MathLayoutItem>((token) => ({
        key: token.id,
        bbox: token.bbox,
        token,
      }))
      return formatMathItems(items, mode, 0, layoutExamples)
    })
  if (values.length <= 1) return values[0] ?? ''
  return mode === 'latex'
    ? `\\begin{aligned}${values.join('\\\\')}\\end{aligned}`
    : values.join('\n')
}

export const recognizedText = (
  tokens: RecognitionToken[],
  layoutExamples: MathLayoutExample[] = [],
) => formatExpression(tokens, 'text', layoutExamples)

export const recognizedLatex = (
  tokens: RecognitionToken[],
  layoutExamples: MathLayoutExample[] = [],
) => formatExpression(tokens, 'latex', layoutExamples)

export const isLargeMathOperator = (labelId: string) => LARGE_OPERATOR_IDS.has(labelId)

export const suggestMathLayoutAssignments = (
  tokens: RecognitionToken[],
  layoutExamples: MathLayoutExample[] = [],
): MathLayoutAssignment[] => {
  const usable = tokens.filter((token) => !token.isLayout && token.labelId)
  const items = usable.map<MathLayoutItem>((token) => ({ key: token.id, bbox: token.bbox, token }))
  const wordAtoms = [...usable]
    .sort((first, second) => first.bbox[0] - second.bbox[0])
    .map<FormattedAtom>((token) => ({
      value: token.char,
      char: token.char,
      bbox: token.bbox,
      sourceId: token.id,
      labelId: token.labelId,
    }))
  const assignments: MathLayoutAssignment[] = []
  const assignedTokens = new Set<string>()

  items
    .filter((item) => item.token && LARGE_OPERATOR_IDS.has(item.token.labelId))
    .sort((first, second) => first.bbox[0] - second.bbox[0])
    .forEach((anchor) => {
      const available = items.filter((item) => !assignedTokens.has(item.key))
      const upper = collectLimitItems(anchor, available, 'upper', layoutExamples)
      upper.forEach((item) => {
        assignments.push({ tokenId: item.key, anchorId: anchor.key, role: 'upper_limit' })
        assignedTokens.add(item.key)
      })
      const lower = collectLimitItems(
        anchor,
        available.filter((item) => !assignedTokens.has(item.key)),
        'lower',
        layoutExamples,
      )
      lower.forEach((item) => {
        assignments.push({ tokenId: item.key, anchorId: anchor.key, role: 'lower_limit' })
        assignedTokens.add(item.key)
      })
    })

  const sorted = usable.sort((first, second) => first.bbox[0] - second.bbox[0])
  sorted.forEach((candidate, candidateIndex) => {
    if (assignedTokens.has(candidate.id) || LARGE_OPERATOR_IDS.has(candidate.labelId)) return
    const bases = sorted
      .slice(0, candidateIndex)
      .filter((base) => !assignedTokens.has(base.id) && base.bbox[3] > candidate.bbox[3] * 1.28)
      .sort((first, second) => (
        Math.abs(candidate.bbox[0] - (first.bbox[0] + first.bbox[2])) -
        Math.abs(candidate.bbox[0] - (second.bbox[0] + second.bbox[2]))
      ))
    const base = bases.find((entry) => scriptRole(
      { value: entry.char, bbox: entry.bbox, labelId: entry.labelId },
      { value: candidate.char, bbox: candidate.bbox, labelId: candidate.labelId },
      layoutExamples,
    ))
    if (!base) return
    const role = scriptRole(
      { value: base.char, bbox: base.bbox, labelId: base.labelId },
      { value: candidate.char, bbox: candidate.bbox, labelId: candidate.labelId },
      layoutExamples,
    )
    if (!role) return
    const baseAtomIndex = wordAtoms.findIndex((atom) => atom.sourceId === base.id)
    const candidateAtomIndex = wordAtoms.findIndex((atom) => atom.sourceId === candidate.id)
    if (ordinaryWordScriptConflict(wordAtoms, baseAtomIndex, candidateAtomIndex)) return
    assignments.push({
      tokenId: candidate.id,
      anchorId: base.id,
      role,
    })
    assignedTokens.add(candidate.id)
  })
  return assignments
}

export const createMathLayoutExamples = (
  tokens: RecognitionToken[],
  assignments: MathLayoutAssignment[],
): MathLayoutExample[] => {
  const tokenMap = new Map(tokens.map((token) => [token.id, token]))
  const now = new Date().toISOString()
  return assignments.flatMap((assignment, index) => {
    const anchor = tokenMap.get(assignment.anchorId)
    const child = tokenMap.get(assignment.tokenId)
    if (!anchor?.labelId || !child?.labelId || anchor.id === child.id) return []
    const vector = relationVector(anchor.bbox, child.bbox)
    return [{
      id: `layout-${Date.now()}-${index}-${Math.random().toString(16).slice(2, 8)}`,
      anchorLabelId: anchor.labelId,
      childLabelId: child.labelId,
      role: assignment.role,
      relativeCenterX: Math.round(vector.relativeCenterX * 100_000) / 100_000,
      relativeCenterY: Math.round(vector.relativeCenterY * 100_000) / 100_000,
      relativeWidth: Math.round(vector.relativeWidth * 100_000) / 100_000,
      relativeHeight: Math.round(vector.relativeHeight * 100_000) / 100_000,
      createdAt: now,
    }]
  })
}

export const recognizedSentence = (tokens: RecognitionToken[]) => {
  const closingPunctuation = new Set(['.', ',', ';', ':', '!', '?', ')', ']'])
  const openingPunctuation = new Set(['(', '['])
  let previousChar = ''
  return normalizeGermanSharpS(tokens
    .filter((token) => !token.isLayout)
    .map((token) => {
      const char = token.labelId === 'operator_minus' ? '-' : token.char
      const separator = token.lineBreakBefore
        ? '\n'
        : token.spaceBefore && !closingPunctuation.has(char) && !openingPunctuation.has(previousChar) ? ' ' : ''
      previousChar = char
      return `${separator}${char}`
    })
    .join(''))
}

export type AutomaticRecognitionResult = {
  mode: RecognitionMode
  tokens: RecognitionToken[]
  value: string
  textValue: string
  mathValue: string
  confidence: number
  reason: string
  textScore: number
  mathScore: number
  evidence?: AutomaticRecognitionEvidence
}

export type AutomaticRecognitionEvidence = {
  text: {
    visibleCharacters: number
    letters: number
    digits: number
    letterRatio: number
    words: number
    knownWords: number
    plausibleWords?: number
    knownWordRatio: number
    baselineAlignment: number
    lines: number
    strongSentence: boolean
  }
  math: {
    visibleCharacters: number
    digits: number
    operators: number
    balancedOperators: number
    strongSymbols: number
    largeOperators: number
    relations: number
    fractions: number
    layoutAssignments: number
    lines: number
    latexStructure: boolean
    decisiveStructure: boolean
  }
}

const AUTOMATIC_STRONG_MATH_IDS = new Set([
  ...LARGE_OPERATOR_IDS,
  'operator_sqrt',
  'operator_partial',
  'operator_nabla',
  'symbol_infinity',
  'relation_equal',
  'relation_not_equal',
  'relation_less_equal',
  'relation_greater_equal',
  'relation_approx',
  'relation_equiv',
  'relation_proportional',
  'set_element',
  'set_not_element',
  'set_subset',
  'set_subset_equal',
  'set_union',
  'set_intersection',
  'logic_forall',
  'logic_exists',
  'arrow_implies',
  'arrow_iff',
  'geometry_parallel',
  'geometry_perpendicular',
])

const AUTOMATIC_MATH_OPERATOR_IDS = new Set([
  'operator_plus',
  'operator_minus',
  'operator_multiply',
  'operator_dot',
  'operator_divide',
  'operator_plus_minus',
  'operator_caret',
  'operator_factorial',
  'operator_percent',
  'operator_slash',
  'decimal_point',
  'decimal_comma',
  'relation_less',
  'relation_greater',
])

type CertainRawInfixOperator = {
  labelId: 'operator_plus' | 'relation_equal'
  bounds: ReturnType<typeof strokeBounds>
}

/**
 * Finds only high-precision operator shapes in the original pen strokes.
 * This evidence is deliberately independent from glyph classification: a
 * plus may otherwise lose its horizontal bar during clustering and appear as
 * `l`, while an equals sign may initially resemble `e`/`o`.  Requiring two
 * distinct, substantive bodies on the left and right prevents a crossbar in
 * one connected word from becoming an infix operator.
 */
const certainRawInfixOperators = (strokes: Stroke[]): CertainRawInfixOperator[] => {
  const entries = strokes.flatMap((stroke) => {
    if (stroke.points.length < 2) return []
    const bounds = strokeBounds(stroke)
    const width = (bounds.maxX - bounds.minX) * SOURCE_WIDTH
    const height = (bounds.maxY - bounds.minY) * SOURCE_HEIGHT
    let horizontalTravel = 0
    let verticalTravel = 0
    stroke.points.slice(1).forEach((point, index) => {
      horizontalTravel += Math.abs(point.x - stroke.points[index].x) * SOURCE_WIDTH
      verticalTravel += Math.abs(point.y - stroke.points[index].y) * SOURCE_HEIGHT
    })
    return [{
      stroke,
      bounds,
      width,
      height,
      horizontal: resemblesStraightHorizontalAccessoryStroke(stroke, bounds),
      vertical: height >= 18 && width <= height * 0.52 &&
        verticalTravel >= Math.max(12, horizontalTravel * 1.65),
    }]
  })
  const bodyOnEachSide = (
    bounds: ReturnType<typeof strokeBounds>,
    operatorStrokes: Set<Stroke>,
  ) => {
    const centerX = (bounds.minX + bounds.maxX) / 2
    const centerY = (bounds.minY + bounds.maxY) / 2
    const isBody = (entry: (typeof entries)[number]) => (
      !operatorStrokes.has(entry.stroke) &&
      (entry.width >= 9 || entry.height >= 18) &&
      Math.abs((entry.bounds.minY + entry.bounds.maxY) / 2 - centerY) <= 0.16
    )
    const left = entries.some((entry) => isBody(entry) && entry.bounds.maxX <= centerX - 0.008)
    const right = entries.some((entry) => isBody(entry) && entry.bounds.minX >= centerX + 0.008)
    return left && right
  }
  const result: CertainRawInfixOperator[] = []
  entries.forEach((horizontal, horizontalIndex) => {
    if (!horizontal.horizontal) return
    entries.forEach((vertical, verticalIndex) => {
      if (verticalIndex === horizontalIndex || !vertical.vertical) return
      const bounds = combinedBounds(horizontal.bounds, vertical.bounds)
      const horizontalCenterY = (horizontal.bounds.minY + horizontal.bounds.maxY) / 2
      const verticalHeight = vertical.bounds.maxY - vertical.bounds.minY
      const overlapsX = Math.min(horizontal.bounds.maxX, vertical.bounds.maxX) -
        Math.max(horizontal.bounds.minX, vertical.bounds.minX) >= -0.006
      const overlapsY = Math.min(horizontal.bounds.maxY, vertical.bounds.maxY) -
        Math.max(horizontal.bounds.minY, vertical.bounds.minY) >= -0.006
      const centered = horizontalCenterY >= vertical.bounds.minY + verticalHeight * 0.38 &&
        horizontalCenterY <= vertical.bounds.maxY - verticalHeight * 0.32
      const balancedArms = horizontal.width >= vertical.height * 0.45
      if (
        overlapsX && overlapsY && centered && balancedArms &&
        bodyOnEachSide(bounds, new Set([horizontal.stroke, vertical.stroke]))
      ) {
        result.push({ labelId: 'operator_plus', bounds })
      }
    })
  })
  entries.forEach((first, firstIndex) => {
    if (!first.horizontal) return
    entries.slice(firstIndex + 1).forEach((second) => {
      if (!second.horizontal) return
      const overlap = Math.min(first.bounds.maxX, second.bounds.maxX) -
        Math.max(first.bounds.minX, second.bounds.minX)
      const firstWidth = first.bounds.maxX - first.bounds.minX
      const secondWidth = second.bounds.maxX - second.bounds.minX
      const centerDistance = Math.abs(
        (first.bounds.minY + first.bounds.maxY) / 2 -
        (second.bounds.minY + second.bounds.maxY) / 2,
      ) * SOURCE_HEIGHT
      const similarWidths = Math.min(first.width, second.width) >= Math.max(first.width, second.width) * 0.56
      const bounds = combinedBounds(first.bounds, second.bounds)
      if (
        overlap >= Math.min(firstWidth, secondWidth) * 0.54 &&
        similarWidths && centerDistance >= 6 && centerDistance <= 54 &&
        bodyOnEachSide(bounds, new Set([first.stroke, second.stroke]))
      ) {
        result.push({ labelId: 'relation_equal', bounds })
      }
    })
  })
  return result.filter((candidate, index, candidates) => candidates.findIndex((other) => (
    other.labelId === candidate.labelId &&
    Math.abs(other.bounds.minX - candidate.bounds.minX) < 0.004 &&
    Math.abs(other.bounds.maxX - candidate.bounds.maxX) < 0.004
  )) === index)
}

const averageTokenConfidence = (tokens: RecognitionToken[]) => {
  const visible = tokens.filter((token) => !token.isLayout)
  return visible.length
    ? visible.reduce((sum, token) => sum + token.confidence, 0) / visible.length
    : 0
}

export const recognizeAutomaticExpression = (
  strokes: Stroke[],
  model: RecognitionModel,
  labels: LabelDefinition[],
  layoutExamples: MathLayoutExample[] = [],
  language: RecognitionLanguage = 'de',
  fallbackMode: RecognitionMode = 'text',
  textCharacterCountHint?: number,
  textCharacterHint?: string,
): AutomaticRecognitionResult => {
  let textTokens = recognizeExpression(
    strokes,
    model,
    labels,
    'text',
    layoutExamples,
    language,
    textCharacterCountHint,
    textCharacterHint,
  )
  const hintedCharacters = Array.from(normalizeGermanSharpS(textCharacterHint ?? ''))
    .filter((character) => !/\s/u.test(character))
  const visibleHintedTokens = textTokens.filter((token) => !token.isLayout)
  if (
    hintedCharacters.length >= 1 &&
    hintedCharacters.length === visibleHintedTokens.length &&
    hintedCharacters.every((character) => /^\p{L}$/u.test(character))
  ) {
    let visibleIndex = 0
    textTokens = textTokens.map((token) => {
      if (token.isLayout) return token
      const expected = hintedCharacters[visibleIndex++]
      if (token.char === expected) return token
      const matching = token.alternatives
        .filter((alternative) => alternative.char === expected)
        .sort((first, second) => (
          (second.personalConfidence ?? 0) + second.confidence + Math.min(18, second.personalSupport ?? 0) -
          (first.personalConfidence ?? 0) - first.confidence - Math.min(18, first.personalSupport ?? 0)
        ))[0]
      if (!matching || (
        (matching.personalSupport ?? 0) === 0 &&
        matching.confidence < Math.max(18, token.confidence - 30)
      )) return token
      const label = labels.find((entry) => entry.id === matching.labelId)
      if (!label) return token
      return {
        ...token,
        labelId: label.id,
        char: label.char,
        name: label.name,
        latex: label.latex,
        confidence: Math.max(token.confidence, matching.confidence),
        baseConfidence: matching.baseConfidence ?? 0,
        personalSupport: matching.personalSupport ?? 0,
        personalConfidence: matching.personalConfidence ?? 0,
        context: {
          word: textCharacterHint ?? '',
          knownWord: false,
          changed: true,
          scoreMargin: Math.max(0, matching.confidence - token.confidence + 30) / 10,
          autoLearn: false,
        },
      }
    })
  }
  const rawInfixOperators = certainRawInfixOperators(strokes)
  const mathTokens = recognizeMathDocument(strokes, model, labels, layoutExamples, language)
  rawInfixOperators.forEach((operator) => {
    const centerX = (operator.bounds.minX + operator.bounds.maxX) / 2
    const centerY = (operator.bounds.minY + operator.bounds.maxY) / 2
    const token = mathTokens
      .filter((candidate) => !candidate.isLayout)
      .map((candidate) => ({
        candidate,
        distance: Math.abs(candidate.bbox[0] + candidate.bbox[2] / 2 - centerX) * SOURCE_WIDTH +
          Math.abs(candidate.bbox[1] + candidate.bbox[3] / 2 - centerY) * SOURCE_HEIGHT * 0.35,
      }))
      .filter(({ candidate }) => (
        candidate.bbox[0] <= operator.bounds.maxX + 0.015 &&
        candidate.bbox[0] + candidate.bbox[2] >= operator.bounds.minX - 0.015 &&
        candidate.bbox[1] <= operator.bounds.maxY + 0.025 &&
        candidate.bbox[1] + candidate.bbox[3] >= operator.bounds.minY - 0.025
      ))
      .sort((first, second) => first.distance - second.distance)[0]?.candidate
    const label = labels.find((entry) => entry.id === operator.labelId)
    if (!token || !label) return
    const alternative = token.alternatives.find((entry) => entry.labelId === label.id)
    token.labelId = label.id
    token.char = label.char
    token.name = label.name
    token.latex = label.latex
    token.confidence = Math.max(token.confidence, alternative?.confidence ?? 74)
    if (!alternative) {
      token.alternatives = [{
        labelId: label.id,
        char: label.char,
        name: label.name,
        confidence: token.confidence,
      }, ...token.alternatives]
    }
  })
  const textValue = recognizedSentence(textTokens).trim()
  const mathValue = recognizedLatex(mathTokens, layoutExamples).trim()
  const visibleText = textTokens.filter((token) => !token.isLayout)
  const visibleMath = mathTokens.filter((token) => !token.isLayout)
  const textConfidence = averageTokenConfidence(textTokens)
  const mathConfidence = averageTokenConfidence(mathTokens)
  const textLetters = visibleText.filter((token) => /^\p{L}$/u.test(token.char)).length
  const textDigits = visibleText.filter((token) => /^\d$/u.test(token.char)).length
  const textLetterRatio = textLetters / Math.max(1, visibleText.length)
  const exactIncrementalTextSequence = (
    Number.isInteger(textCharacterCountHint) &&
    textCharacterCountHint! >= 2 &&
    visibleText.length === textCharacterCountHint &&
    textLetters === visibleText.length
  )
  const wordParts = textValue.split(/\s+/u).filter((part) => /\p{L}{2,}/u.test(part))
  const lexicalTextWords = (
    textValue.match(language === 'de' ? /[a-zäöü]{2,}/giu : /[a-z]{2,}/giu) ?? []
  )
  const lexicalTextEvidence = lexicalTextWords.map((word) => lexicalWordEvidence(word, language))
  const knownTextWords = lexicalTextWords.filter((_, index) => lexicalTextEvidence[index].knownWord)
  const plausibleTextWords = lexicalTextWords.filter((_, index) => lexicalTextEvidence[index].score >= 0.5)
  const knownTextWordRatio = knownTextWords.length / Math.max(1, lexicalTextWords.length)
  const hasStrongSingleWord = (
    lexicalTextWords.length === 1 &&
    knownTextWords.length === 1 &&
    textLetters >= 3 &&
    textLetterRatio >= 0.8
  )
  const longLetterSequence = (
    textLetters >= 8 &&
    textLetterRatio >= 0.78 &&
    lexicalTextWords.some((word) => Array.from(word).length >= 7)
  )
  const strongSentenceText = (
    textLetters >= 5 &&
    textLetterRatio >= 0.68 &&
    (
      knownTextWords.length >= 2 ||
      (knownTextWords.length >= 1 && knownTextWordRatio >= 0.5) ||
      (wordParts.length >= 2 && textLetters >= 8 && /[aeiouyäöü]/iu.test(textValue)) ||
      longLetterSequence
    )
  )
  const strongMathTokens = visibleMath.filter((token) => AUTOMATIC_STRONG_MATH_IDS.has(token.labelId))
  const mathOperators = visibleMath.filter((token) => AUTOMATIC_MATH_OPERATOR_IDS.has(token.labelId))
  const hasDecisiveMathRelation = visibleMath.some((token) => (
    token.labelId === 'relation_equal' ||
    token.labelId === 'relation_not_equal' ||
    token.labelId === 'relation_less_equal' ||
    token.labelId === 'relation_greater_equal' ||
    token.labelId === 'relation_approx' ||
    token.labelId === 'relation_equiv' ||
    token.labelId === 'relation_proportional'
  ))
  const strongMathAlternatives = visibleMath.filter((token) => token.alternatives.some((alternative) => (
    AUTOMATIC_STRONG_MATH_IDS.has(alternative.labelId) &&
    alternative.confidence >= Math.max(38, token.confidence - 7)
  )))
  const fractionParts = mathTokens.filter((token) => token.isLayout || token.layout?.type === 'fraction').length
  const layoutAssignments = suggestMathLayoutAssignments(mathTokens, layoutExamples)
  const hasMathCommandStructure = /\\(?:frac|sqrt|int|iint|iiint|oint|sum|prod|partial|nabla|infty|bigcup|bigcap)\b/u.test(mathValue)
  const mathDigits = visibleMath.filter((token) => token.labelId.startsWith('digit_')).length
  const largeMathOperators = visibleMath.filter((token) => LARGE_OPERATOR_IDS.has(token.labelId))
  const relationTokens = visibleMath.filter((token) => (
    token.labelId.startsWith('relation_') ||
    token.labelId === 'arrow_implies' ||
    token.labelId === 'arrow_iff'
  ))
  const mathLineCount = Math.max(1, visibleMath.filter((token) => token.lineBreakBefore).length + 1)
  const textLineCount = Math.max(1, visibleText.filter((token) => token.lineBreakBefore).length + 1)
  const substantialTextTokens = visibleText.filter((token) => (
    /^(?:\p{L}|\d)$/u.test(token.char) && token.bbox[3] >= 0.012
  ))
  const textReferenceHeight = Math.max(0.02, median(substantialTextTokens.map((token) => token.bbox[3])))
  const textBaseline = median(substantialTextTokens.map((token) => token.bbox[1] + token.bbox[3]))
  const baselineAlignedTextTokens = substantialTextTokens.filter((token) => (
    Math.abs(token.bbox[1] + token.bbox[3] - textBaseline) <= textReferenceHeight * 0.34
  )).length
  const textBaselineAlignment = baselineAlignedTextTokens / Math.max(1, substantialTextTokens.length)
  const dominantProseText = (
    textLetters >= 5 &&
    textLetterRatio >= 0.68 &&
    textBaselineAlignment >= 0.7 &&
    visibleText.length >= visibleMath.length + 2 &&
    lexicalTextWords.some((word) => Array.from(word).length >= 4)
  )
  const mathOperand = (token: RecognitionToken) => (
    token.labelId.startsWith('digit_') ||
    token.labelId.startsWith('latin_') ||
    token.labelId.startsWith('german_') ||
    token.labelId.startsWith('greek_') ||
    token.labelId === 'symbol_infinity'
  )
  const verticallyCompatible = (first: RecognitionToken, second: RecognitionToken) => {
    const overlap = Math.min(first.bbox[1] + first.bbox[3], second.bbox[1] + second.bbox[3]) -
      Math.max(first.bbox[1], second.bbox[1])
    return overlap >= Math.min(first.bbox[3], second.bbox[3]) * 0.2
  }
  const balancedMathOperators = visibleMath.filter((operator) => {
    if (!AUTOMATIC_MATH_OPERATOR_IDS.has(operator.labelId) && !operator.labelId.startsWith('relation_')) return false
    const center = operator.bbox[0] + operator.bbox[2] / 2
    const numericSeparator = operator.labelId === 'decimal_point' || operator.labelId === 'decimal_comma'
    const left = visibleMath.some((candidate) => (
      candidate !== operator &&
      mathOperand(candidate) &&
      candidate.bbox[0] + candidate.bbox[2] <= center &&
      (verticallyCompatible(operator, candidate) || (numericSeparator && candidate.labelId.startsWith('digit_')))
    ))
    const right = visibleMath.some((candidate) => (
      candidate !== operator &&
      mathOperand(candidate) &&
      candidate.bbox[0] >= center &&
      (verticallyCompatible(operator, candidate) || (numericSeparator && candidate.labelId.startsWith('digit_')))
    ))
    return left && right
  })
  const hasRadicalStructure = visibleMath.some((token) => token.labelId === 'operator_sqrt') && visibleMath.length >= 2
  // Suggested assignments alone are intentionally not decisive: ascenders,
  // i-dots, and uneven text baselines can create weak script suggestions.
  // The formatted math path must actually accept a script relation before it
  // is allowed to block a complete text-line result.
  const rawHasScriptStructure = /[_^]\{/u.test(mathValue)
  const mathContainsOnlyScriptOperands = visibleMath.every((token) => (
    token.labelId.startsWith('digit_') ||
    token.labelId.startsWith('latin_') ||
    token.labelId.startsWith('german_') ||
    token.labelId.startsWith('greek_')
  ))
  const alignedKnownTextWord = (
    textLetters >= 3 &&
    knownTextWords.length === lexicalTextWords.length &&
    textBaselineAlignment >= 0.72
  )
  const alignedUnknownTextSequence = (
    textLetters >= 4 &&
    textBaselineAlignment >= 0.82
  )
  const compactTextValue = textValue.normalize('NFC').replace(/\s+/gu, '')
  const completeKnownTextWords = (
    lexicalTextWords.length >= 1 &&
    knownTextWords.length === lexicalTextWords.length &&
    textLetters >= 3
  )
  const completePlausibleTextWords = (
    lexicalTextWords.length >= 1 &&
    plausibleTextWords.length === lexicalTextWords.length &&
    textLetters >= 4
  )
  const properNameTextSequence = (
    lexicalTextWords.length === 1 &&
    textLetters >= 4 &&
    /^[A-ZÄÖÜ][a-zäöü]+$/u.test(compactTextValue)
  )
  const baselineWordContradictsScript = (
    rawHasScriptStructure &&
    !hasMathCommandStructure &&
    fractionParts === 0 &&
    relationTokens.length === 0 &&
    mathOperators.length === 0 &&
    mathContainsOnlyScriptOperands &&
    lexicalTextWords.length >= 1 &&
    textLetterRatio >= 0.86 &&
    (
      completeKnownTextWords ||
      completePlausibleTextWords ||
      properNameTextSequence ||
      strongSentenceText ||
      alignedKnownTextWord ||
      alignedUnknownTextSequence
    )
  )
  const hasScriptStructure = rawHasScriptStructure && !baselineWordContradictsScript
  const hasLatexStructure = hasMathCommandStructure || hasScriptStructure
  const hasLimitedLargeOperator = largeMathOperators.length > 0 && layoutAssignments.some((assignment) => (
    assignment.role === 'upper_limit' || assignment.role === 'lower_limit'
  ))
  const hasStandaloneLargeOperator = (
    largeMathOperators.length === 1 &&
    visibleMath.length === 1 &&
    visibleText.length <= 2 &&
    !visibleMath.some((token) => {
      const cluster = clusterFromStrokes(token.strokes)
      return Boolean(cluster && resemblesUppercaseT(cluster))
    })
  )
  const hasMultilineMathStructure = mathLineCount > 1 && (
    relationTokens.length > 0 || mathOperators.length > 0 || strongMathTokens.length > 0
  )
  const hasHardMathStructure = (
    fractionParts > 0 ||
    hasRadicalStructure ||
    hasDecisiveMathRelation ||
    rawInfixOperators.length > 0 ||
    hasScriptStructure ||
    hasLimitedLargeOperator ||
    hasStandaloneLargeOperator ||
    hasMultilineMathStructure
  )
  const hasBalancedNumericOperator = (
    balancedMathOperators.length > 0 && mathDigits > 0 && !dominantProseText
  )
  const hasDecisiveMathStructure = hasHardMathStructure || hasBalancedNumericOperator
  const strongProseText = strongSentenceText || dominantProseText
  const unambiguousUppercaseT = (
    visibleMath.length === 1 &&
    visibleMath[0].strokes.length === 2 &&
    Boolean(clusterFromStrokes(visibleMath[0].strokes) && resemblesUppercaseT(clusterFromStrokes(visibleMath[0].strokes)!))
  )
  const combinedAutomaticCluster = clusterFromStrokes(strokes)
  const independentPenLiftBodyCount = combinedAutomaticCluster
    ? penLiftTextBodyClusters(combinedAutomaticCluster).length
    : 0
  const mathIsPureNumber = visibleMath.length > 0 && visibleMath.every((token) => (
    token.labelId.startsWith('digit_')
  ))
  const exactIndependentTextSequence = (
    independentPenLiftBodyCount >= 2 &&
    visibleText.length === independentPenLiftBodyCount &&
    textLetters === visibleText.length &&
    !mathIsPureNumber
  )

  let textScore = textConfidence / 100 * 1.65
  let mathScore = mathConfidence / 100 * 1.65
  const textReasons: string[] = []
  const mathReasons: string[] = []

  if (textLetters >= 3 && textLetterRatio >= 0.66) {
    textScore += 1.65
    textReasons.push('zusammenhängende Buchstaben')
  }
  if (hasStrongSingleWord) {
    textScore += 1.25
    textReasons.unshift('bekanntes vollständiges Wort')
  }
  if (baselineWordContradictsScript) {
    textScore += 1.15
    mathScore -= 0.8
    textReasons.unshift('vollständiges Wort statt scheinbarer Indexe')
  }
  if (exactIncrementalTextSequence) {
    // Live handwriting is evaluated after every pen lift.  When a new glyph
    // is appended to an already stable text sequence, the previous length is
    // independent segmentation evidence.  Without it, two or three joined
    // letters can collapse into one visually plausible infinity/integral and
    // flip the whole preview to mathematics until the next letter arrives.
    // The hint only opens an exact-length text beam; every resulting part must
    // still classify as a letter, so digits/operators and real math layouts do
    // not receive this protection.
    textScore += 2.35 + Math.min(0.72, Math.max(0, textLetters - 2) * 0.24)
    textReasons.unshift('stabile wachsende Buchstabenfolge')
  }
  if (exactIndependentTextSequence) {
    textScore += 2.25 + Math.min(0.5, Math.max(0, independentPenLiftBodyCount - 2) * 0.16)
    textReasons.unshift('getrennte Buchstabenkörper')
    if (
      visibleMath.length < visibleText.length &&
      !fractionParts &&
      !hasDecisiveMathRelation &&
      layoutAssignments.length === 0
    ) mathScore -= 1.15
  }
  if (unambiguousUppercaseT && visibleText.length === 1) {
    textScore += 3.4
    mathScore -= 2.8
    textReasons.unshift('eindeutige T-Geometrie')
  }
  if (
    wordParts.length >= 2 ||
    (/\s/u.test(textValue) && textLetters >= 3 && textLetterRatio >= 0.5)
  ) {
    textScore += 1.15
    textReasons.push('Wortabstände')
  } else if (wordParts.some((word) => word.length >= 4)) {
    textScore += 0.62
    textReasons.push('Wortstruktur')
  }
  if (/[.!?]$/u.test(textValue) && textLetters >= 3) textScore += 0.38
  if (textLetters >= 6 && /[aeiouyäöü]/iu.test(textValue)) textScore += 0.45
  if (strongSentenceText) {
    textScore += Math.min(
      2.8,
      1.65 + knownTextWords.length * 0.38 + Math.max(0, wordParts.length - 1) * 0.18,
    )
    textReasons.unshift(
      knownTextWords.length
        ? 'sinnvolle Wortfolge'
        : longLetterSequence ? 'lange Buchstabenfolge' : 'mehrteiliger Textsatz',
    )
  }
  if (textLetters >= 3 && textBaselineAlignment >= 0.78) {
    textScore += 0.48
    textReasons.push('gemeinsame Textgrundlinie')
  }

  if (fractionParts) {
    mathScore += 3.15
    mathReasons.push('Bruchanordnung')
  }
  if (rawInfixOperators.length) {
    mathScore += Math.min(4.2, 3.15 + (rawInfixOperators.length - 1) * 0.35)
    mathReasons.unshift('eindeutiger Operator zwischen getrennten Operanden')
  }
  if (hasLatexStructure) {
    mathScore += strongProseText && !hasHardMathStructure ? 0.45 : 2.65
    mathReasons.push('Formelstruktur')
  }
  if (layoutAssignments.length) {
    mathScore += baselineWordContradictsScript
      ? Math.min(0.12, layoutAssignments.length * 0.03)
      : strongProseText && !hasHardMathStructure
      ? Math.min(0.42, layoutAssignments.length * 0.08)
      : Math.min(2.2, 0.9 + layoutAssignments.length * 0.42)
    if (!baselineWordContradictsScript) mathReasons.push('Hoch-/Tiefstellung oder Grenzen')
  }
  if (strongMathTokens.length) {
    mathScore += strongProseText && !hasHardMathStructure
      ? Math.min(0.58, strongMathTokens.length * 0.16)
      : Math.min(2.8, 1.35 + strongMathTokens.length * 0.48)
    mathReasons.push('mathematische Symbole')
  } else if (strongMathAlternatives.length) {
    mathScore += strongProseText
      ? Math.min(0.24, strongMathAlternatives.length * 0.05)
      : Math.min(1.45, strongMathAlternatives.length * 0.42)
    mathReasons.push('wahrscheinliche mathematische Symbole')
  }
  if (mathOperators.length && (visibleMath.some((token) => token.labelId.startsWith('digit_')) || visibleMath.length >= 3)) {
    mathScore += strongProseText && !hasHardMathStructure
      ? Math.min(0.34, mathOperators.length * 0.08)
      : Math.min(1.65, 0.72 + mathOperators.length * 0.28)
    mathReasons.push('Operatorfolge')
  }
  if (balancedMathOperators.length) {
    mathScore += strongProseText && !hasHardMathStructure
      ? Math.min(0.28, balancedMathOperators.length * 0.08)
      : Math.min(1.55, 0.82 + balancedMathOperators.length * 0.3)
    mathReasons.unshift('Operator zwischen Operanden')
  }
  if (visibleMath.length > 0 && visibleMath.every((token) => token.labelId.startsWith('digit_'))) {
    mathScore += 0.72
    mathReasons.push('Zahlenfolge')
  }
  if (textDigits > textLetters && mathOperators.length) textScore -= 0.45
  if (strongProseText && !hasDecisiveMathStructure) mathScore -= 1.15
  if (
    exactIncrementalTextSequence &&
    visibleMath.length < visibleText.length &&
    !fractionParts &&
    !hasDecisiveMathRelation &&
    layoutAssignments.length === 0
  ) {
    // A single math glyph must not erase several independently segmented
    // letters merely because their combined outline resembles ∞, ∫ or Σ.
    mathScore -= 2.4
  }
  if (textConfidence >= mathConfidence + 7) textScore += 0.52
  if (mathConfidence >= textConfidence + 7) mathScore += 0.52

  const margin = Math.abs(mathScore - textScore)
  const mode = margin < 0.52 ? fallbackMode : mathScore > textScore ? 'math' : 'text'
  const selectedTokens = mode === 'math' ? mathTokens : textTokens
  const selectedValue = mode === 'math' ? mathValue : textValue
  const reason = mode === 'math'
    ? mathReasons[0] ?? (fallbackMode === 'math' && margin < 0.52 ? 'zuletzt verwendeter Modus' : 'Zeichenanordnung')
    : textReasons[0] ?? (fallbackMode === 'text' && margin < 0.52 ? 'zuletzt verwendeter Modus' : 'Buchstabenfolge')
  const confidence = Math.round(clamp(54 + margin * 11 + Math.max(textConfidence, mathConfidence) * 0.12, 55, 98))

  return {
    mode,
    tokens: selectedTokens,
    value: selectedValue,
    textValue,
    mathValue,
    confidence,
    reason,
    textScore: Math.round(textScore * 100) / 100,
    mathScore: Math.round(mathScore * 100) / 100,
    evidence: {
      text: {
        visibleCharacters: visibleText.length,
        letters: textLetters,
        digits: textDigits,
        letterRatio: Math.round(textLetterRatio * 1_000) / 1_000,
        words: lexicalTextWords.length,
        knownWords: knownTextWords.length,
        plausibleWords: plausibleTextWords.length,
        knownWordRatio: Math.round(knownTextWordRatio * 1_000) / 1_000,
        baselineAlignment: Math.round(textBaselineAlignment * 1_000) / 1_000,
        lines: textLineCount,
        strongSentence: strongSentenceText,
      },
      math: {
        visibleCharacters: visibleMath.length,
        digits: mathDigits,
        operators: mathOperators.length,
        balancedOperators: balancedMathOperators.length,
        strongSymbols: strongMathTokens.length,
        largeOperators: largeMathOperators.length,
        relations: relationTokens.length,
        fractions: fractionParts,
        layoutAssignments: layoutAssignments.length,
        lines: mathLineCount,
        latexStructure: hasLatexStructure,
        decisiveStructure: hasDecisiveMathStructure,
      },
    },
  }
}
