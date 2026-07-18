import { ENGLISH_COMMON_WORDS } from '../../../src/data/englishLanguage'
import { GERMAN_COMMON_WORDS } from '../../../src/data/germanLanguage'
import { BASE_CATALOG } from '../../../src/data/catalog'
import type { RecognitionLanguage } from '../../../src/lib/recognition'
import type { Sample, Stroke } from '../../../src/types'
import {
  isExtendedNeuralContextWord,
  nearestNeuralWordContextCandidates,
  preserveWordCase,
  wordDistance,
} from './neuralWordContext'
import { loadSpellingWordContext } from './spelling'

export type PersonalRasterSample = Pick<Sample, 'labelId' | 'label' | 'imageData'>

export type PersonalRasterCandidate = {
  targetCount: number
  visualText: string
  text: string
  score: number
  averageVisualCost: number
  cutInk: number
  alignedNeural: Array<string | null>
  sequenceBeams: Array<{
    value: string
    score: number
    known: boolean
    visualCost: number
    neuralMatches: number
  }>
  segments: Array<{
    range: [number, number]
    selected: string
    alternatives: Array<{ char: string; cost: number }>
  }>
}

export type PersonalRasterRecognition = {
  prediction: string
  candidates: PersonalRasterCandidate[]
  columnBandCount: number
}

type PreparedImage = {
  inkBox: [number, number, number, number]
  columnBands: Array<[number, number]>
  sourceMask: Uint8Array
  sourceWidth: number
  sourceHeight: number
  minX: number
  minY: number
}

type RasterDescriptor = {
  raster: Uint8Array
  inkIndexes: Uint16Array
  distance: Float32Array
  projectionX: Float32Array
  projectionY: Float32Array
  ink: number
  aspect: number
}

type PersonalTemplate = RasterDescriptor & {
  labelId: string
  char: string
  count: number
}

type RasterClass = {
  labelId: string
  char: string
  cost: number
  support: number
}

type RasterSegment = {
  start: number
  end: number
  classes: RasterClass[]
}

const RASTER_SIZE = 32
const RASTER_MARGIN = 3
const LINE_IMAGE_HEIGHT = 128
const MAX_IMAGE_WIDTH = 4_096
const MAX_IMAGE_HEIGHT = 1_024
const MAX_IMAGE_PIXELS = MAX_IMAGE_WIDTH * MAX_IMAGE_HEIGHT
const TEMPLATE_BATCH_SIZE = 24
const MAX_TEMPLATES_PER_CLASS = 10
const MAX_PERSONAL_TEMPLATES = 512
const MAX_RASTER_CHARACTERS = 24
const MAX_RASTER_PARTS_PER_BAND = 16
const RASTER_SEGMENTATION_BEAM = 28
const RASTER_BOUNDARIES_PER_CUT = 14
const COMMON_WORDS = { de: GERMAN_COMMON_WORDS, en: ENGLISH_COMMON_WORDS }
const CATALOG_BY_CHARACTER = new Map(BASE_CATALOG.map((entry) => [entry.char, entry]))

const clamp = (value: number, minimum: number, maximum: number) => (
  Math.max(minimum, Math.min(maximum, value))
)

const loadImage = async (source: string) => {
  const image = new Image()
  image.decoding = 'async'
  image.src = source
  await image.decode()
  return image
}

/** Lightweight counterpart of the neural line renderer. The caller already
 * supplies one physical row, so this module does not pull the ONNX/TrOCR graph
 * into a personal-segmentation-only conversion or its regression bundle. */
export const renderPersonalRasterLine = (
  strokes: Stroke[],
  sourceWidth: number,
  sourceHeight: number,
) => {
  const visible = strokes.filter((stroke) => stroke.points.length)
  if (!visible.length) return null
  const points = visible.flatMap((stroke) => stroke.points)
  const minX = Math.min(...points.map((point) => point.x * sourceWidth))
  const minY = Math.min(...points.map((point) => point.y * sourceHeight))
  const maxX = Math.max(...points.map((point) => point.x * sourceWidth))
  const maxY = Math.max(...points.map((point) => point.y * sourceHeight))
  const contentWidth = Math.max(1, maxX - minX)
  const contentHeight = Math.max(1, maxY - minY)
  const marginY = clamp(contentHeight * 0.40, 4, 36)
  const marginX = clamp(contentHeight * 0.22, 5, 48)
  const imageWidth = contentWidth + marginX * 2
  const imageHeight = contentHeight + marginY * 2
  const width = clamp(Math.ceil(LINE_IMAGE_HEIGHT * imageWidth / imageHeight), 32, MAX_IMAGE_WIDTH)
  const scaleX = width / imageWidth
  const scaleY = LINE_IMAGE_HEIGHT / imageHeight
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = LINE_IMAGE_HEIGHT
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (!context) throw new Error('Die persönliche Handschriftzeile konnte nicht gerendert werden.')
  context.fillStyle = '#fff'
  context.fillRect(0, 0, width, LINE_IMAGE_HEIGHT)
  context.strokeStyle = '#000'
  context.fillStyle = '#000'
  context.lineCap = 'round'
  context.lineJoin = 'round'
  visible.forEach((stroke) => {
    const mapped = stroke.points.map((point) => ({
      x: (point.x * sourceWidth - minX + marginX) * scaleX,
      y: (point.y * sourceHeight - minY + marginY) * scaleY,
    }))
    context.lineWidth = clamp(stroke.baseWidth * Math.sqrt(scaleX * scaleY), 1, 10)
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
  return {
    pixels: context.getImageData(0, 0, width, LINE_IMAGE_HEIGHT).data,
    width,
    height: LINE_IMAGE_HEIGHT,
  }
}

/**
 * Isolates the pen without depending on a theme. Coloured FaNotes ink is
 * selected before the neutral fallback so screenshot borders and resize
 * handles cannot become apparent letters. The fallback handles the black ink
 * produced by the local line renderer and ordinary scans.
 */
const handwritingMask = (source: ImageData) => {
  const { width, height, data } = source
  const mask = new Uint8Array(width * height)
  let chromaticPixels = 0
  for (let index = 0; index < mask.length; index += 1) {
    const red = data[index * 4]
    const green = data[index * 4 + 1]
    const blue = data[index * 4 + 2]
    if (
      Math.max(red, green, blue) < 190
      && green - red >= 8
      && blue - red >= 8
      && Math.abs(green - blue) <= 8
    ) {
      mask[index] = 1
      chromaticPixels += 1
    }
  }
  if (chromaticPixels >= Math.max(32, width * height * 0.0005)) return mask

  for (let index = 0; index < mask.length; index += 1) {
    const x = index % width
    const y = Math.floor(index / width)
    const red = data[index * 4]
    const green = data[index * 4 + 1]
    const blue = data[index * 4 + 2]
    const luminance = red * 0.2126 + green * 0.7152 + blue * 0.0722
    const edgeBand = x < 3 || y < 3 || x >= width - 3 || y >= height - 3
    mask[index] = luminance < 150 && !edgeBand ? 1 : 0
  }
  return mask
}

const prepareImageData = (imageData: ImageData): PreparedImage | null => {
  const sourceWidth = imageData.width
  const sourceHeight = imageData.height
  const mask = handwritingMask(imageData)
  let minX = sourceWidth
  let minY = sourceHeight
  let maxX = -1
  let maxY = -1
  for (let index = 0; index < mask.length; index += 1) {
    if (!mask[index]) continue
    const x = index % sourceWidth
    const y = Math.floor(index / sourceWidth)
    minX = Math.min(minX, x)
    minY = Math.min(minY, y)
    maxX = Math.max(maxX, x)
    maxY = Math.max(maxY, y)
  }
  if (maxX < minX || maxY < minY) return null

  const contentWidth = maxX - minX + 1
  const contentHeight = maxY - minY + 1
  const occupiedColumns = Array.from({ length: contentWidth }, (_, offset) => {
    const x = minX + offset
    for (let y = minY; y <= maxY; y += 1) {
      if (mask[y * sourceWidth + x]) return true
    }
    return false
  })
  const columnBands: Array<[number, number]> = []
  occupiedColumns.forEach((occupied, offset) => {
    if (occupied && !occupiedColumns[offset - 1]) columnBands.push([offset, offset + 1])
    else if (occupied) columnBands.at(-1)![1] = offset + 1
  })
  return {
    inkBox: [minX, minY, contentWidth, contentHeight],
    columnBands,
    sourceMask: mask,
    sourceWidth,
    sourceHeight,
    minX,
    minY,
  }
}

const distanceTransform = (raster: Uint8Array) => {
  const result = new Float32Array(raster.length)
  result.fill(RASTER_SIZE * 2)
  for (let index = 0; index < raster.length; index += 1) {
    if (raster[index]) result[index] = 0
  }
  const diagonal = Math.SQRT2
  for (let y = 0; y < RASTER_SIZE; y += 1) {
    for (let x = 0; x < RASTER_SIZE; x += 1) {
      const index = y * RASTER_SIZE + x
      if (x > 0) result[index] = Math.min(result[index], result[index - 1] + 1)
      if (y > 0) result[index] = Math.min(result[index], result[index - RASTER_SIZE] + 1)
      if (x > 0 && y > 0) result[index] = Math.min(result[index], result[index - RASTER_SIZE - 1] + diagonal)
      if (x + 1 < RASTER_SIZE && y > 0) result[index] = Math.min(result[index], result[index - RASTER_SIZE + 1] + diagonal)
    }
  }
  for (let y = RASTER_SIZE - 1; y >= 0; y -= 1) {
    for (let x = RASTER_SIZE - 1; x >= 0; x -= 1) {
      const index = y * RASTER_SIZE + x
      if (x + 1 < RASTER_SIZE) result[index] = Math.min(result[index], result[index + 1] + 1)
      if (y + 1 < RASTER_SIZE) result[index] = Math.min(result[index], result[index + RASTER_SIZE] + 1)
      if (x + 1 < RASTER_SIZE && y + 1 < RASTER_SIZE) result[index] = Math.min(result[index], result[index + RASTER_SIZE + 1] + diagonal)
      if (x > 0 && y + 1 < RASTER_SIZE) result[index] = Math.min(result[index], result[index + RASTER_SIZE - 1] + diagonal)
    }
  }
  return result
}

const describeRaster = (
  mask: Uint8Array,
  sourceWidth: number,
  box: [number, number, number, number],
): RasterDescriptor => {
  const [left, top, right, bottom] = box
  const width = Math.max(1, right - left)
  const height = Math.max(1, bottom - top)
  const scale = Math.min(
    (RASTER_SIZE - RASTER_MARGIN * 2) / width,
    (RASTER_SIZE - RASTER_MARGIN * 2) / height,
  )
  const drawWidth = width * scale
  const drawHeight = height * scale
  const offsetX = (RASTER_SIZE - drawWidth) / 2
  const offsetY = (RASTER_SIZE - drawHeight) / 2
  const raster = new Uint8Array(RASTER_SIZE * RASTER_SIZE)
  for (let y = top; y < bottom; y += 1) {
    for (let x = left; x < right; x += 1) {
      if (!mask[y * sourceWidth + x]) continue
      const targetX = clamp(Math.round(offsetX + (x - left) * scale), 0, RASTER_SIZE - 1)
      const targetY = clamp(Math.round(offsetY + (y - top) * scale), 0, RASTER_SIZE - 1)
      raster[targetY * RASTER_SIZE + targetX] = 1
    }
  }
  const closed = Uint8Array.from(raster)
  for (let y = 1; y < RASTER_SIZE - 1; y += 1) {
    for (let x = 1; x < RASTER_SIZE - 1; x += 1) {
      const index = y * RASTER_SIZE + x
      if (raster[index]) continue
      if (
        (raster[index - 1] && raster[index + 1])
        || (raster[index - RASTER_SIZE] && raster[index + RASTER_SIZE])
      ) closed[index] = 1
    }
  }
  const projectionX = new Float32Array(RASTER_SIZE)
  const projectionY = new Float32Array(RASTER_SIZE)
  const inkIndexes: number[] = []
  for (let index = 0; index < closed.length; index += 1) {
    if (!closed[index]) continue
    inkIndexes.push(index)
    projectionX[index % RASTER_SIZE] += 1 / RASTER_SIZE
    projectionY[Math.floor(index / RASTER_SIZE)] += 1 / RASTER_SIZE
  }
  return {
    raster: closed,
    inkIndexes: Uint16Array.from(inkIndexes),
    distance: distanceTransform(closed),
    projectionX,
    projectionY,
    ink: inkIndexes.length,
    aspect: width / height,
  }
}

const descriptorFromImage = async (source: string) => {
  const image = await loadImage(source)
  if (
    image.naturalWidth < 1 || image.naturalHeight < 1
    || image.naturalWidth > MAX_IMAGE_WIDTH || image.naturalHeight > MAX_IMAGE_WIDTH
    || image.naturalWidth * image.naturalHeight > MAX_IMAGE_PIXELS
  ) throw new Error('Ein persönliches Glyphenbild besitzt eine ungültige Größe.')
  const canvas = document.createElement('canvas')
  canvas.width = image.naturalWidth
  canvas.height = image.naturalHeight
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (!context) throw new Error('Ein persönliches Glyphenbild konnte nicht gelesen werden.')
  context.drawImage(image, 0, 0)
  const data = context.getImageData(0, 0, canvas.width, canvas.height).data
  const mask = new Uint8Array(canvas.width * canvas.height)
  let minX = canvas.width
  let minY = canvas.height
  let maxX = -1
  let maxY = -1
  for (let index = 0; index < mask.length; index += 1) {
    const red = data[index * 4]
    const green = data[index * 4 + 1]
    const blue = data[index * 4 + 2]
    if (red * 0.2126 + green * 0.7152 + blue * 0.0722 >= 190) continue
    mask[index] = 1
    const x = index % canvas.width
    const y = Math.floor(index / canvas.width)
    minX = Math.min(minX, x)
    minY = Math.min(minY, y)
    maxX = Math.max(maxX, x)
    maxY = Math.max(maxY, y)
  }
  if (maxX < minX || maxY < minY) throw new Error('Ein persönliches Glyphenbild ist leer.')
  return describeRaster(mask, canvas.width, [minX, minY, maxX + 1, maxY + 1])
}

const personalTemplateCache = new WeakMap<readonly PersonalRasterSample[], Promise<PersonalTemplate[]>>()

const loadPersonalTemplates = (samples: readonly PersonalRasterSample[]) => {
  let pending = personalTemplateCache.get(samples)
  if (pending) return pending
  pending = (async () => {
    const byClass = new Map<string, PersonalRasterSample[]>()
    samples.forEach((sample) => {
      if (!/^[A-Za-zÄÖÜäöü]$/u.test(sample.label)) return
      const entries = byClass.get(sample.labelId) ?? []
      if (entries.length < MAX_TEMPLATES_PER_CLASS) entries.push(sample)
      byClass.set(sample.labelId, entries)
    })
    // Round-robin preserves coverage when a very large import contains many
    // classes, while the per-class cap prevents one frequently retrained
    // letter from dominating decode memory and distance work.
    const usable: PersonalRasterSample[] = []
    for (let index = 0; usable.length < MAX_PERSONAL_TEMPLATES; index += 1) {
      let added = false
      byClass.forEach((entries) => {
        if (usable.length >= MAX_PERSONAL_TEMPLATES || !entries[index]) return
        usable.push(entries[index])
        added = true
      })
      if (!added) break
    }
    const classCounts = new Map<string, number>()
    usable.forEach((sample) => classCounts.set(sample.labelId, (classCounts.get(sample.labelId) ?? 0) + 1))
    const templates: PersonalTemplate[] = []
    // Avoid decoding hundreds of data URLs simultaneously. This path stays
    // lazy, and the bounded batches yield so conversion cannot freeze the UI.
    for (let offset = 0; offset < usable.length; offset += TEMPLATE_BATCH_SIZE) {
      const batch = usable.slice(offset, offset + TEMPLATE_BATCH_SIZE)
      templates.push(...await Promise.all(batch.map(async (sample) => ({
        ...await descriptorFromImage(sample.imageData),
        labelId: sample.labelId,
        char: sample.label,
        count: classCounts.get(sample.labelId) ?? 1,
      } satisfies PersonalTemplate))))
      if (offset + TEMPLATE_BATCH_SIZE < usable.length) {
        await new Promise<void>((resolve) => globalThis.setTimeout(resolve, 0))
      }
    }
    return templates
  })().catch((error) => {
    personalTemplateCache.delete(samples)
    throw error
  })
  personalTemplateCache.set(samples, pending)
  return pending
}

const rasterDistance = (first: RasterDescriptor, second: RasterDescriptor) => {
  let firstToSecond = 0
  let secondToFirst = 0
  for (let index = 0; index < first.inkIndexes.length; index += 1) {
    firstToSecond += second.distance[first.inkIndexes[index]]
  }
  for (let index = 0; index < second.inkIndexes.length; index += 1) {
    secondToFirst += first.distance[second.inkIndexes[index]]
  }
  const chamfer = (
    firstToSecond / Math.max(1, first.ink)
    + secondToFirst / Math.max(1, second.ink)
  ) / (RASTER_SIZE * 0.5)
  let projection = 0
  for (let index = 0; index < RASTER_SIZE; index += 1) {
    projection += Math.abs(first.projectionX[index] - second.projectionX[index])
      + Math.abs(first.projectionY[index] - second.projectionY[index])
  }
  projection /= RASTER_SIZE
  const aspect = Math.abs(Math.log(Math.max(0.05, first.aspect) / Math.max(0.05, second.aspect)))
  return chamfer * 0.72 + projection * 0.18 + aspect * 0.10
}

const classifyRaster = (descriptor: RasterDescriptor, templates: PersonalTemplate[]) => {
  const byLabel = new Map<string, { char: string; support: number; costs: number[] }>()
  templates.forEach((template) => {
    const entry = byLabel.get(template.labelId) ?? { char: template.char, support: template.count, costs: [] }
    const cost = rasterDistance(descriptor, template)
    const insertion = entry.costs.findIndex((value) => cost < value)
    if (insertion < 0) entry.costs.push(cost)
    else entry.costs.splice(insertion, 0, cost)
    if (entry.costs.length > 3) entry.costs.length = 3
    byLabel.set(template.labelId, entry)
  })
  return [...byLabel.entries()].map(([labelId, entry]) => {
    const weights = [0.72, 0.20, 0.08].slice(0, entry.costs.length)
    const weight = weights.reduce((sum, value) => sum + value, 0)
    const rawCost = entry.costs.reduce((sum, value, index) => sum + value * weights[index], 0) / weight
    // Repeated, internally consistent examples are stronger writer evidence
    // than a single generic-looking form. Keep the bonus bounded below one
    // ordinary close-shape margin: repetition may resolve a near tie, but can
    // never make a visibly unrelated class win merely through sample count.
    const repeatedEvidenceBonus = Math.min(0.075, Math.log2(Math.max(1, entry.support)) * 0.023)
    return {
      labelId,
      char: entry.char,
      cost: Math.max(0, rawCost - repeatedEvidenceBonus),
      support: entry.support,
    }
  }).sort((first, second) => first.cost - second.cost).slice(0, 10)
}

const personalCostForCharacter = (segment: RasterSegment, char: string, language: RecognitionLanguage) => {
  const locale = language === 'de' ? 'de-CH' : 'en-US'
  const exact = segment.classes.find((entry) => entry.char === char)
  const folded = segment.classes.find((entry) => (
    entry.char.toLocaleLowerCase(locale) === char.toLocaleLowerCase(locale)
  ))
  if (exact && folded && exact !== folded) {
    // Handwritten upper- and lowercase forms can legitimately share their
    // geometry (notably V/v, C/c and S/s). Do not discard a much closer
    // personal shape merely because the line model supplied the other case;
    // retain a small explicit case cost so genuinely distinct forms still win.
    return Math.min(exact.cost, folded.cost + 0.012)
  }
  return (exact ?? folded)?.cost ?? (segment.classes[0]?.cost ?? 0.2) + 0.14
}

const alignNeuralCharacters = (
  segments: RasterSegment[],
  neural: string[],
  language: RecognitionLanguage,
) => {
  if (segments.length === neural.length) return [...neural]
  const alignmentCost = (aligned: Array<string | null>) => aligned.reduce((sum, char, index) => {
    if (!char) return sum + 0.075
    const segment = segments[index]
    return sum + Math.max(0, personalCostForCharacter(segment, char, language) - segment.classes[0].cost)
  }, 0)
  if (neural.length === segments.length + 1) {
    return neural.map((_, removed) => neural.filter((_char, index) => index !== removed))
      .map((aligned, removed) => ({ aligned, removed, cost: alignmentCost(aligned) }))
      .sort((first, second) => first.cost - second.cost || second.removed - first.removed)[0].aligned
  }
  if (neural.length + 1 === segments.length) {
    return Array.from({ length: segments.length }, (_, inserted) => [
      ...neural.slice(0, inserted), null, ...neural.slice(inserted),
    ] as Array<string | null>)
      .map((aligned, inserted) => ({ aligned, inserted, cost: alignmentCost(aligned) }))
      .sort((first, second) => first.cost - second.cost || second.inserted - first.inserted)[0].aligned
  }
  type Cell = { cost: number; previous: [number, number] | null; char: string | null }
  const rows: Cell[][] = Array.from({ length: neural.length + 1 }, () => (
    Array.from({ length: segments.length + 1 }, () => ({ cost: Number.POSITIVE_INFINITY, previous: null, char: null }))
  ))
  rows[0][0].cost = 0
  for (let source = 0; source <= neural.length; source += 1) {
    for (let target = 0; target <= segments.length; target += 1) {
      const current = rows[source][target]
      if (!Number.isFinite(current.cost)) continue
      const update = (nextSource: number, nextTarget: number, cost: number, char: string | null) => {
        if (cost >= rows[nextSource][nextTarget].cost) return
        rows[nextSource][nextTarget] = { cost, previous: [source, target], char }
      }
      if (source < neural.length && target < segments.length) {
        const segment = segments[target]
        const relative = personalCostForCharacter(segment, neural[source], language) - segment.classes[0].cost
        update(source + 1, target + 1, current.cost + Math.max(0, relative), neural[source])
      }
      if (source < neural.length) update(source + 1, target, current.cost + 0.055, null)
      if (target < segments.length) update(source, target + 1, current.cost + 0.075, '')
    }
  }
  const aligned = Array.from<string | null>({ length: segments.length }).fill(null)
  let source = neural.length
  let target = segments.length
  while (source > 0 || target > 0) {
    const cell = rows[source][target]
    if (!cell.previous) break
    if (target > cell.previous[1]) aligned[target - 1] = cell.char || null
    ;[source, target] = cell.previous
  }
  return aligned
}

const fuseRasterSequence = (
  segments: RasterSegment[],
  neural: string[],
  language: RecognitionLanguage,
) => {
  const locale = language === 'de' ? 'de-CH' : 'en-US'
  const alignedNeural = alignNeuralCharacters(segments, neural, language)
  const alignedValue = alignedNeural.every(Boolean) ? alignedNeural.join('') : ''
  const neuralLengthVariants = neural.length === segments.length + 1
    ? neural.map((_character, removed) => neural.filter((_value, index) => index !== removed).join(''))
    : neural.length === segments.length
      ? [neural.join('')]
      : []
  const dictionaryWord = (value: string) => {
    const lower = value.toLocaleLowerCase(locale)
    return COMMON_WORDS[language].has(lower) || isExtendedNeuralContextWord(lower, language)
  }
  const exactGermanCompound = (value: string) => {
    if (language !== 'de') return false
    const lower = value.toLocaleLowerCase(locale)
    if (!/^\p{L}{10,32}$/u.test(lower)) return false
    for (let boundary = 3; boundary <= lower.length - 3; boundary += 1) {
      const left = lower.slice(0, boundary)
      const right = lower.slice(boundary)
      if (dictionaryWord(left) && dictionaryWord(right)) return true
      if (
        left.endsWith('s') && left.length >= 4
        && dictionaryWord(left.slice(0, -1)) && dictionaryWord(right)
      ) return true
    }
    return false
  }
  const exactKnown = (value: string) => dictionaryWord(value) || exactGermanCompound(value)
  const lexicallyProjectedValues = new Set<string>()
  const scoreCharacter = (segment: RasterSegment, char: string, index: number) => {
    const bestCost = segment.classes[0].cost
    const visualCost = Math.max(0, personalCostForCharacter(segment, char, language) - bestCost)
    const personalWeight = bestCost <= 0.08 ? 1.75 : 0.25
    const aligned = alignedNeural[index]
    const neuralMatch = aligned === char
    const foldedMatch = Boolean(aligned && aligned.toLocaleLowerCase(locale) === char.toLocaleLowerCase(locale))
    const casePenalty = index === 0
      ? (/^\p{Ll}$/u.test(char) ? 0.012 : 0)
      : (/^\p{Lu}$/u.test(char) ? 0.07 : 0)
    return {
      cost: visualCost * personalWeight + casePenalty - (neuralMatch ? 0.027 : foldedMatch ? 0.014 : 0),
      visualCost,
      neuralMatch,
    }
  }
  const scoreValue = (value: string) => {
    const characters = Array.from(value)
    if (characters.length !== segments.length) return null
    const scored = characters.map((char, index) => scoreCharacter(segments[index], char, index))
    const cost = scored.reduce((sum, entry) => sum + entry.cost, 0)
    const known = exactKnown(value)
    const decisiveDisagreements = segments.filter((segment, index) => {
      const aligned = alignedNeural[index]
      if (!aligned || segment.classes[0].cost > 0.08) return false
      return segment.classes[0].char !== aligned
        && personalCostForCharacter(segment, aligned, language) - segment.classes[0].cost >= 0.05
    }).length
    const reliableOneGlyphRemoval = (
      neural.length === segments.length + 1
      && neuralLengthVariants.includes(value)
      && decisiveDisagreements <= Math.max(1, Math.floor(segments.length * 0.2))
    )
    const knownWordBonus = known ? (neural.length === 0 ? 0.36 : 0.29) : 0
    const lexicalProjectionBonus = lexicallyProjectedValues.has(value) ? 0.12 : 0
    return {
      value,
      visualCost: scored.reduce((sum, entry) => sum + entry.visualCost, 0),
      neuralMatches: scored.filter((entry) => entry.neuralMatch).length,
      known,
      score: cost - knownWordBonus - lexicalProjectionBonus - (reliableOneGlyphRemoval ? 0.22 : 0),
    }
  }
  type Beam = { value: string; cost: number; visualCost: number; neuralMatches: number }
  let beams: Beam[] = [{ value: '', cost: 0, visualCost: 0, neuralMatches: 0 }]
  segments.forEach((segment, index) => {
    const aligned = alignedNeural[index]
    const options = [...segment.classes.slice(0, 8)]
    if (aligned && !options.some((entry) => entry.char === aligned)) options.push({
      labelId: CATALOG_BY_CHARACTER.get(aligned)?.id ?? '',
      char: aligned,
      cost: personalCostForCharacter(segment, aligned, language),
      support: 0,
    })
    beams = beams.flatMap((beam) => options.map((option) => {
      const scored = scoreCharacter(segment, option.char, index)
      return {
        value: beam.value + option.char,
        cost: beam.cost + scored.cost,
        visualCost: beam.visualCost + scored.visualCost,
        neuralMatches: beam.neuralMatches + Number(scored.neuralMatch),
      }
    })).sort((first, second) => first.cost - second.cost).slice(0, 512)
  })
  // A dictionary entry may be one glyph longer than the physical word (for
  // example the conventional spelling "Rendezvous" while the user literally
  // wrote "Rendevous"). Use the known word only as a character-context guide:
  // project it onto the measured segment count and rescore every retained
  // letter against the personal glyphs. This never inserts an unwritten glyph
  // and preserves the literal handwriting.
  const lexicalSources = Math.abs(neural.length - segments.length) <= 1
    ? [...new Set([alignedValue, beams[0]?.value].filter(Boolean))]
    : neural.length === 0
      ? [beams[0]?.value].filter(Boolean)
      : []
  lexicalSources.forEach((source) => {
    const maximumDistance = source.length >= 11 ? 3 : 2
    nearestNeuralWordContextCandidates(
      source.toLocaleLowerCase(locale), language, maximumDistance, false, 32,
    ).forEach(({ candidate }) => {
      const contextual = preserveWordCase(source, candidate, language)
      const characters = Array.from(contextual)
      const addProjectedValue = (value: string) => {
        // When a text model supplied a complete literal, dictionary context
        // may clarify nearby ambiguous letters but must never replace an
        // unknown name/technical term with a distant valid word.
        if (
          neuralLengthVariants.length
          && Math.min(...neuralLengthVariants.map((variant) => wordDistance(
            value.toLocaleLowerCase(locale), variant.toLocaleLowerCase(locale),
          ))) > (segments.length >= 11 ? 3 : 2)
        ) return
        lexicallyProjectedValues.add(value)
      }
      if (characters.length === segments.length) {
        addProjectedValue(contextual)
        return
      }
      if (characters.length === segments.length + 1) {
        characters.forEach((_character, removed) => {
          addProjectedValue(characters.filter((_value, index) => index !== removed).join(''))
        })
      }
    })
  })
  // Evaluate every one-character deletion when the line model inserted a
  // glyph. Selecting one alignment before applying visual and lexical scores
  // made a wrong early deletion irreversible (for example Glykosei).
  const contextualSources = [...new Set([alignedValue, ...neuralLengthVariants].filter(Boolean))]
  const contextualValues = contextualSources.flatMap((source) => (
    nearestNeuralWordContextCandidates(
      source.toLocaleLowerCase(locale), language, 2, true, 64,
    )
      // The exhaustive OCR lexicon may contain thousands of two-edit words
      // of the same length. Only the closest bounded set can influence this
      // visual beam; retaining the full array caused avoidable memory spikes.
      .map(({ candidate }) => preserveWordCase(source, candidate, language))
  ))
  const hybridValues: string[] = []
  if (alignedValue) {
    const source = Array.from(alignedValue)
    const differing = segments.flatMap((segment, index) => (
      segment.classes[0].char !== source[index] ? [index] : []
    ))
    const visit = (offset: number, remaining: number, current: string[]) => {
      if (remaining === 0) {
        hybridValues.push(current.join(''))
        return
      }
      for (let position = offset; position <= differing.length - remaining; position += 1) {
        const index = differing[position]
        const next = [...current]
        next[index] = segments[index].classes[0].char
        visit(position + 1, remaining - 1, next)
      }
    }
    for (let replacements = 1; replacements <= Math.min(3, differing.length); replacements += 1) {
      visit(0, replacements, source)
    }
  }
  const values = [...new Set([
    ...beams.map((beam) => beam.value), alignedValue, ...neuralLengthVariants,
    ...contextualValues, ...lexicallyProjectedValues, ...hybridValues,
  ].filter(Boolean))]
  const ranked = values.flatMap((value) => {
    const scored = scoreValue(value)
    return scored ? [scored] : []
  }).sort((first, second) => first.score - second.score)
  return {
    text: ranked[0]?.value ?? '',
    known: ranked[0]?.known ?? false,
    alignedNeural,
    beams: ranked.slice(0, 8),
  }
}

const recognizePersonalRaster = (
  image: PreparedImage,
  templates: PersonalTemplate[],
  neuralText: string,
  language: RecognitionLanguage,
  characterCountHints: readonly number[],
): PersonalRasterRecognition => {
  const rangeCache = new Map<string, RasterSegment | null>()
  const classifyRange = (start: number, end: number) => {
    const key = `${start}:${end}`
    if (rangeCache.has(key)) return rangeCache.get(key) ?? null
    const left = image.minX + start
    const right = image.minX + end
    let top = image.sourceHeight
    let bottom = -1
    let ink = 0
    for (let y = image.minY; y < image.minY + image.inkBox[3]; y += 1) {
      for (let x = left; x < right; x += 1) {
        if (!image.sourceMask[y * image.sourceWidth + x]) continue
        ink += 1
        top = Math.min(top, y)
        bottom = Math.max(bottom, y)
      }
    }
    if (ink < 12 || bottom < top) {
      rangeCache.set(key, null)
      return null
    }
    const descriptor = describeRaster(image.sourceMask, image.sourceWidth, [left, top, right, bottom + 1])
    const result = { start, end, classes: classifyRaster(descriptor, templates) }
    rangeCache.set(key, result)
    return result
  }

  const columnInk = Array.from({ length: image.inkBox[2] }, (_, offset) => {
    const x = image.minX + offset
    let count = 0
    for (let y = image.minY; y < image.minY + image.inkBox[3]; y += 1) {
      count += image.sourceMask[y * image.sourceWidth + x]
    }
    return count
  })
  type BandOption = { count: number; segments: RasterSegment[]; cost: number; cutInk: number }
  const rawLetters = Array.from(neuralText).filter((character) => /^\p{L}$/u.test(character))
  const exactCountHints = [...new Set(characterCountHints.filter((hint) => (
    Number.isSafeInteger(hint) && hint >= 1 && hint <= MAX_RASTER_CHARACTERS
  )))]
  // If the line model returned only mathematics, there is no linguistic
  // length prior. The personal glyph aspect still supplies a bounded estimate;
  // the exact projection-band count remains an independent candidate. This
  // opens recovery without supplying the expected word or trying all 24
  // possible lengths.
  const templateAspects = templates
    .map((template) => template.aspect)
    .filter((aspect) => Number.isFinite(aspect) && aspect >= 0.08 && aspect <= 1.5)
    .sort((first, second) => first - second)
  const medianTemplateAspect = templateAspects[Math.floor(templateAspects.length / 2)] ?? 0.42
  const lineAspect = image.inkBox[2] / Math.max(1, image.inkBox[3])
  const aspectCount = Math.round(lineAspect / Math.max(0.32, Math.min(0.58, medianTemplateAspect)))
  const countHintConflictsWithAspect = exactCountHints.length > 0
    && exactCountHints.every((hint) => Math.abs(hint - aspectCount) >= 2)
  const boundedCountHints = exactCountHints
  const blindAspectCounts = rawLetters.length === 0 && (
    exactCountHints.length === 0 || countHintConflictsWithAspect
  )
    ? [aspectCount - 2, aspectCount - 1, aspectCount, aspectCount + 1, aspectCount + 2]
    : []
  const candidateCounts = [...new Set([
    image.columnBands.length,
    ...boundedCountHints,
    ...blindAspectCounts,
    rawLetters.length - 1,
    rawLetters.length,
    rawLetters.length + 1,
  ])].filter((count) => count >= image.columnBands.length && count <= MAX_RASTER_CHARACTERS)
  const maximumTargetCount = Math.max(image.columnBands.length, ...candidateCounts)

  /**
   * A projection band is not the same thing as a character. In cursive ink a
   * complete word can occupy one uninterrupted band because every joining
   * stroke fills the gap between two glyph bodies. The previous raster path
   * could split each band only once, which made a four-letter connected word
   * impossible even when the line model supplied the correct length.
   *
   * Build a bounded left-to-right beam around every expected boundary. Low
   * ink valleys are preferred, but uniform positions remain available for a
   * perfectly continuous connector. Every resulting piece is still scored
   * against the writer's personal glyph templates, so the length prior does
   * not get to invent unsupported characters by itself.
   */
  const segmentBand = (start: number, end: number, count: number): BandOption | null => {
    const whole = classifyRange(start, end)
    if (count === 1) {
      return whole
        ? { count: 1, segments: [whole], cost: whole.classes[0].cost, cutInk: 0 }
        : null
    }
    const width = end - start
    if (count === 2) {
      // Preserve the mature exhaustive two-body split. A band containing two
      // merely touching neighbours has a much wider natural letter-width
      // distribution than a long cursive word, so the uniform-boundary beam
      // below is unnecessarily restrictive for this common case.
      const minimumPiece = Math.max(7, Math.floor(width * 0.2))
      const cutCandidates = Array.from(
        { length: Math.max(0, width - minimumPiece * 2) },
        (_, index) => start + minimumPiece + index,
      ).sort((first, second) => (
        columnInk[first] - columnInk[second]
        || Math.abs(first - (start + end) / 2) - Math.abs(second - (start + end) / 2)
      )).slice(0, 48)
      return cutCandidates.flatMap((cut) => {
        const left = classifyRange(start, cut)
        const right = classifyRange(cut, end)
        if (!left?.classes.length || !right?.classes.length) return []
        const cutInk = columnInk[cut] / Math.max(1, image.inkBox[3])
        return [{
          count: 2,
          segments: [left, right],
          cost: left.classes[0].cost + right.classes[0].cost + cutInk * 0.16 + 0.012,
          cutInk,
        } satisfies BandOption]
      }).sort((first, second) => first.cost - second.cost)[0] ?? null
    }
    if (width < count * 4) return null
    const expectedWidth = width / count
    const minimumPiece = Math.max(
      4,
      Math.floor(Math.min(expectedWidth * 0.22, image.inkBox[3] * 0.045)),
    )
    if (width < count * minimumPiece) return null

    type PartialBand = {
      end: number
      segments: RasterSegment[]
      cost: number
      cutInk: number
    }
    let beam: PartialBand[] = [{ end: start, segments: [], cost: 0, cutInk: 0 }]
    for (let boundaryIndex = 1; boundaryIndex < count; boundaryIndex += 1) {
      const target = start + expectedWidth * boundaryIndex
      const searchRadius = Math.max(6, expectedWidth * 0.72)
      const remainingPieces = count - boundaryIndex
      const minimumCut = start + minimumPiece * boundaryIndex
      const maximumCut = end - minimumPiece * remainingPieces
      const candidates = Array.from(
        { length: Math.max(0, Math.floor(maximumCut) - Math.ceil(minimumCut) + 1) },
        (_, index) => Math.ceil(minimumCut) + index,
      ).filter((cut) => Math.abs(cut - target) <= searchRadius)
        .sort((first, second) => {
          const firstInk = columnInk[first] / Math.max(1, image.inkBox[3])
          const secondInk = columnInk[second] / Math.max(1, image.inkBox[3])
          const firstScore = firstInk * 0.76 + Math.abs(first - target) / expectedWidth * 0.24
          const secondScore = secondInk * 0.76 + Math.abs(second - target) / expectedWidth * 0.24
          return firstScore - secondScore || Math.abs(first - target) - Math.abs(second - target)
        })
        .slice(0, RASTER_BOUNDARIES_PER_CUT)
      const uniformCut = clamp(Math.round(target), Math.ceil(minimumCut), Math.floor(maximumCut))
      if (!candidates.includes(uniformCut)) candidates.push(uniformCut)

      const next = beam.flatMap((state) => candidates.flatMap((cut) => {
        if (
          cut - state.end < minimumPiece
          || end - cut < minimumPiece * remainingPieces
        ) return []
        const segment = classifyRange(state.end, cut)
        if (!segment?.classes.length) return []
        const cutInk = columnInk[cut] / Math.max(1, image.inkBox[3])
        const pieceWidth = cut - state.end
        const widthDeviation = Math.abs(Math.log(Math.max(0.15, pieceWidth / expectedWidth)))
        return [{
          end: cut,
          segments: [...state.segments, segment],
          cost: state.cost + segment.classes[0].cost + cutInk * 0.16 + widthDeviation * 0.012 + 0.006,
          cutInk: state.cutInk + cutInk,
        } satisfies PartialBand]
      })).sort((first, second) => first.cost - second.cost)
        .slice(0, RASTER_SEGMENTATION_BEAM)
      if (!next.length) return null
      beam = next
    }

    return beam.flatMap((state) => {
      if (end - state.end < minimumPiece) return []
      const segment = classifyRange(state.end, end)
      if (!segment?.classes.length) return []
      const pieceWidth = end - state.end
      const widthDeviation = Math.abs(Math.log(Math.max(0.15, pieceWidth / expectedWidth)))
      return [{
        count,
        segments: [...state.segments, segment],
        cost: state.cost + segment.classes[0].cost + widthDeviation * 0.012,
        cutInk: state.cutInk,
      } satisfies BandOption]
    }).sort((first, second) => first.cost - second.cost)[0] ?? null
  }

  const options = image.columnBands.map(([start, end]) => {
    const width = end - start
    const aspectLimit = Math.max(
      1,
      Math.ceil(width / Math.max(5, image.inkBox[3] * 0.20)),
    )
    const maximumPieces = Math.min(
      MAX_RASTER_PARTS_PER_BAND,
      maximumTargetCount - image.columnBands.length + 1,
      // Always let the line-model length open the exact connected-word path;
      // the aspect estimate only adds a small guard against pathological
      // screenshots with a one-pixel horizontal border.
      Math.max(aspectLimit, rawLetters.length - image.columnBands.length + 1),
    )
    return Array.from({ length: maximumPieces }, (_, index) => segmentBand(start, end, index + 1))
      .filter((entry): entry is BandOption => Boolean(entry))
  })

  const candidates = candidateCounts.flatMap((targetCount) => {
    type State = { count: number; segments: RasterSegment[]; cost: number; cutInk: number }
    let states: State[] = [{ count: 0, segments: [], cost: 0, cutInk: 0 }]
    options.forEach((bandOptions) => {
      const next = new Map<number, State>()
      states.forEach((state) => bandOptions.forEach((option) => {
        const count = state.count + option.count
        if (count > targetCount) return
        const candidate = {
          count,
          segments: [...state.segments, ...option.segments],
          cost: state.cost + option.cost,
          cutInk: state.cutInk + option.cutInk,
        }
        const current = next.get(count)
        if (!current || candidate.cost < current.cost) next.set(count, candidate)
      }))
      states = [...next.values()]
    })
    const state = states.find((entry) => entry.count === targetCount)
    if (!state) return []
    const visualText = state.segments.map((segment) => segment.classes[0].char).join('')
    const fusion = fuseRasterSequence(state.segments, rawLetters, language)
    const text = rawLetters.length
      ? preserveWordCase(rawLetters.join(''), fusion.text, language)
      : fusion.text
    const averageVisualCost = state.cost / Math.max(1, state.count)
    const lengthPriors = rawLetters.length
      ? [{ count: rawLetters.length, weight: 0.018 }]
      : [
          ...exactCountHints.map((count) => ({ count, weight: 0.06 })),
          { count: image.columnBands.length, weight: 0.05 },
          ...(blindAspectCounts.length ? [{ count: aspectCount, weight: 0.04 }] : []),
        ]
    const countPenalty = Math.min(...lengthPriors.map(({ count, weight }) => (
      Math.abs(targetCount - count) * weight
    )))
    const foldedText = text.toLocaleLowerCase(language === 'de' ? 'de-CH' : 'en-US')
    const supportedRawDeletion = rawLetters.length === targetCount + 1 && rawLetters.some((_character, removed) => (
      (removed === 0 || removed === rawLetters.length - 1)
      && rawLetters.filter((_value, index) => index !== removed).join('')
        .toLocaleLowerCase(language === 'de' ? 'de-CH' : 'en-US') === foldedText
    ))
    const score = averageVisualCost + countPenalty + state.cutInk * 0.22
      - (fusion.known ? 0.025 : 0)
      - (supportedRawDeletion ? 0.045 : 0)
    return [{
      targetCount,
      visualText,
      text,
      score,
      averageVisualCost,
      cutInk: state.cutInk,
      alignedNeural: fusion.alignedNeural,
      sequenceBeams: fusion.beams,
      segments: state.segments.map((segment, index) => ({
        range: [segment.start, segment.end] as [number, number],
        selected: Array.from(text)[index] ?? segment.classes[0].char,
        alternatives: segment.classes.slice(0, 5).map(({ char, cost }) => ({ char, cost })),
      })),
    } satisfies PersonalRasterCandidate]
  }).sort((first, second) => first.score - second.score)
  return {
    prediction: candidates[0]?.text ?? neuralText,
    candidates,
    columnBandCount: image.columnBands.length,
  }
}

/**
 * Resolves merged or partly stolen letters in a rendered one-word line. It is
 * deliberately independent from expected text and learns exclusively from
 * the user's imported GlyphenWerk samples. The already computed line-model
 * text remains a weak length and language prior.
 */
export const recognizePersonalRasterPixels = async (
  image: { pixels: Uint8ClampedArray; width: number; height: number },
  samples: readonly PersonalRasterSample[],
  neuralText: string,
  language: RecognitionLanguage,
  characterCountHints: readonly number[] = [],
): Promise<PersonalRasterRecognition | null> => {
  if (
    image.width < 8 || image.height < 8
    || image.width > MAX_IMAGE_WIDTH || image.height > MAX_IMAGE_HEIGHT
    || image.width * image.height > MAX_IMAGE_PIXELS
    || image.pixels.byteLength !== image.width * image.height * 4
  ) throw new Error('Die gerenderte persönliche Textzeile ist ungültig.')
  // Permit one trailing punctuation mark because a line decoder can invent it
  // from the final flourish. The raster sequence still emits letters only;
  // internal punctuation, formula syntax and multi-word text remain excluded.
  const letterPattern = language === 'de'
    ? /^[A-Za-zÄÖÜäöü]{2,24}[.,;:!?]?$/u
    : /^[A-Za-z]{2,24}[.,;:!?]?$/u
  // A mathematical raw guess such as `∫∫` must not veto personal text
  // recognition. Invalid text priors are discarded completely; they are never
  // converted into letters or used as a hidden expected value.
  const safeNeuralText = letterPattern.test(neuralText.trim()) ? neuralText.trim() : ''
  await loadSpellingWordContext(language)
  const templates = await loadPersonalTemplates(samples)
  if (!templates.length) return null
  const prepared = prepareImageData(new ImageData(
    Uint8ClampedArray.from(image.pixels), image.width, image.height,
  ))
  return prepared
    ? recognizePersonalRaster(prepared, templates, safeNeuralText, language, characterCountHints)
    : null
}
