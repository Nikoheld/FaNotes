import { applyFinalNeuralWordContext } from '../../src/lib/neuralWordContext'
import {
  recognizePersonalRasterPixels,
  type PersonalRasterSample,
} from '../../src/lib/personalizedRasterRecognition'
import { loadSpellingWordContext } from '../../src/lib/spelling'
import {
  loadBrowserSpellingResources,
  loadBrowserSpellingWordCandidates,
} from '../../src/lib/spellingResources'

type HoldoutCase = {
  id: string
  image: string
}

type PreparedImage = {
  pixels: Uint8ClampedArray
  width: number
  height: number
  sourcePixels: Uint8ClampedArray
  sourceWidth: number
  sourceHeight: number
  inkBox: [number, number, number, number]
  columnBands: Array<[number, number]>
}

type GlyphManifestRow = {
  image: string
  label_id: string
  unicode: string
}

const MODEL_HEIGHT = 128
const MAX_MODEL_WIDTH = 4_096

if (!window.fanotes) Object.assign(window, {
  fanotes: {
    platform: 'web',
    loadSpellingResources: loadBrowserSpellingResources,
    loadSpellingWordCandidates: loadBrowserSpellingWordCandidates,
  },
})

const loadImage = async (source: string) => {
  const image = new Image()
  image.decoding = 'async'
  image.src = source
  await image.decode()
  return image
}

const clamp = (value: number, minimum: number, maximum: number) => (
  Math.max(minimum, Math.min(maximum, value))
)

/** Mirrors the production raster mask while retaining the normalized TrOCR
 * pixels and raw screenshot pixels as two independent inputs. */
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

const prepareImageData = (imageData: ImageData): PreparedImage => {
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
  if (maxX < minX || maxY < minY) throw new Error('Das Holdout-Bild enthält keine erkennbare Handschrift.')

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

  const marginX = clamp(Math.round(contentHeight * 0.22), 5, 48)
  const marginY = clamp(Math.round(contentHeight * 0.40), 4, 36)
  const outputWidth = clamp(
    Math.ceil(MODEL_HEIGHT * (contentWidth + marginX * 2) / (contentHeight + marginY * 2)),
    32,
    MAX_MODEL_WIDTH,
  )
  const output = document.createElement('canvas')
  output.width = outputWidth
  output.height = MODEL_HEIGHT
  const outputContext = output.getContext('2d', { willReadFrequently: true })
  if (!outputContext) throw new Error('Das Holdout-Bild konnte nicht normalisiert werden.')
  outputContext.fillStyle = '#fff'
  outputContext.fillRect(0, 0, output.width, output.height)
  outputContext.fillStyle = '#000'
  const scaleX = output.width / (contentWidth + marginX * 2)
  const scaleY = output.height / (contentHeight + marginY * 2)
  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      if (!mask[y * sourceWidth + x]) continue
      const left = Math.floor((x - minX + marginX) * scaleX)
      const top = Math.floor((y - minY + marginY) * scaleY)
      const right = Math.max(left + 1, Math.ceil((x - minX + marginX + 1) * scaleX))
      const bottom = Math.max(top + 1, Math.ceil((y - minY + marginY + 1) * scaleY))
      outputContext.fillRect(left, top, right - left, bottom - top)
    }
  }
  return {
    pixels: outputContext.getImageData(0, 0, output.width, output.height).data,
    width: output.width,
    height: output.height,
    sourcePixels: Uint8ClampedArray.from(imageData.data),
    sourceWidth,
    sourceHeight,
    inkBox: [minX, minY, contentWidth, contentHeight],
    columnBands,
  }
}

const prepareImage = async (source: string) => {
  const image = await loadImage(source)
  const canvas = document.createElement('canvas')
  canvas.width = image.naturalWidth
  canvas.height = image.naturalHeight
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (!context) throw new Error('Das Holdout-Bild konnte nicht gelesen werden.')
  context.drawImage(image, 0, 0)
  return prepareImageData(context.getImageData(0, 0, canvas.width, canvas.height))
}

const loadPersonalSamples = async (manifestUrl: string) => {
  const response = await fetch(manifestUrl)
  if (!response.ok) throw new Error('Der persönliche GlyphenWerk-Export konnte nicht geladen werden.')
  const rows = (await response.text()).trim().split(/\r?\n/u)
    .map((line) => JSON.parse(line) as GlyphManifestRow)
    .filter((row) => /^[A-Za-zÄÖÜäöü]$/u.test(row.unicode))
  const root = new URL('.', new URL(manifestUrl, document.baseURI))
  return rows.map((row) => ({
    labelId: row.label_id,
    label: row.unicode,
    imageData: new URL(row.image, root).href,
  } satisfies PersonalRasterSample))
}

export const runNasHandwritingHoldout = async (cases: HoldoutCase[], manifestUrl: string) => {
  const { recognizeTrocrLine } = await import('../../src/lib/trocrClient')
  const [, samples] = await Promise.all([
    loadSpellingWordContext('de'),
    loadPersonalSamples(manifestUrl),
  ])
  const results = []
  for (const item of cases) {
    const prepared = await prepareImage(item.image)
    const startedAt = performance.now()
    const rawPrediction = (await recognizeTrocrLine(
      prepared.pixels,
      prepared.width,
      prepared.height,
      120_000,
    )).normalize('NFC').replace(/\s+/gu, ' ').trim()
    const prediction = applyFinalNeuralWordContext(rawPrediction, 'de')
    const personal = await recognizePersonalRasterPixels({
      pixels: prepared.sourcePixels,
      width: prepared.sourceWidth,
      height: prepared.sourceHeight,
    }, samples, rawPrediction, 'de')
    results.push({
      id: item.id,
      rawPrediction,
      prediction,
      personalizedPrediction: personal?.prediction ?? prediction,
      personalizedCandidates: personal?.candidates ?? [],
      width: prepared.width,
      height: prepared.height,
      inkBox: prepared.inkBox,
      columnBands: prepared.columnBands,
      durationMs: Math.round(performance.now() - startedAt),
    })
  }
  return results
}
