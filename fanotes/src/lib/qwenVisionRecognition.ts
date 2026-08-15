import type { Stroke } from '../../../src/types'

export type QwenVisionImage = {
  pixels: Uint8Array
  width: number
  height: number
  lineCount: number
}

const MAX_IMAGE_WIDTH = 1_600
const MAX_IMAGE_HEIGHT = 1_600
const MIN_IMAGE_WIDTH = 160
const MIN_IMAGE_HEIGHT = 128
const MARGIN = 40
const MAX_UPSCALE = 6
const LINE_GAP_FACTOR = 0.72

const finitePoints = (strokes: Stroke[]) => strokes.flatMap((stroke) => (
  stroke.points.filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y))
))

const letterCount = (value: string) => (value.match(/[\p{L}\p{N}]/gu) ?? []).length
const wordCount = (value: string) => value.trim().split(/\s+/u).filter(Boolean).length

type LineCluster = {
  strokes: Stroke[]
  minX: number
  maxX: number
  minY: number
  maxY: number
}

const median = (values: number[]) => {
  if (!values.length) return 0
  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

/** Group ink into reading-order lines so the VLM sees clear, separated rows. */
export const clusterHandwritingLines = (
  strokes: Stroke[],
  sourceWidth: number,
  sourceHeight: number,
): LineCluster[] => {
  const items = strokes.flatMap((stroke) => {
    const usable = stroke.points.filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y))
    if (!usable.length) return []
    const xs = usable.map((point) => point.x * sourceWidth)
    const ys = usable.map((point) => point.y * sourceHeight)
    const minY = Math.min(...ys)
    const maxY = Math.max(...ys)
    return [{
      stroke,
      minX: Math.min(...xs),
      maxX: Math.max(...xs),
      minY,
      maxY,
      midY: (minY + maxY) / 2,
      height: Math.max(1, maxY - minY),
    }]
  }).sort((left, right) => left.midY - right.midY || left.minX - right.minX)
  if (!items.length) return []

  const typicalHeight = Math.max(12, median(items.map((item) => item.height)) || sourceHeight * 0.03)
  const joinDistance = Math.max(14, typicalHeight * 0.72)
  const lines: LineCluster[] = []
  for (const item of items) {
    const current = lines.at(-1)
    const currentMid = current ? (current.minY + current.maxY) / 2 : 0
    if (current && Math.abs(item.midY - currentMid) <= joinDistance) {
      current.strokes.push(item.stroke)
      current.minX = Math.min(current.minX, item.minX)
      current.maxX = Math.max(current.maxX, item.maxX)
      current.minY = Math.min(current.minY, item.minY)
      current.maxY = Math.max(current.maxY, item.maxY)
    } else {
      lines.push({
        strokes: [item.stroke],
        minX: item.minX,
        maxX: item.maxX,
        minY: item.minY,
        maxY: item.maxY,
      })
    }
  }
  return lines
}

export const estimateQwenVisionLineCount = (
  strokes: Stroke[],
  sourceWidth: number,
  sourceHeight: number,
) => Math.max(1, clusterHandwritingLines(strokes, sourceWidth, sourceHeight).length)

const isLowQualityClassical = (text: string) => {
  const trimmed = text.trim()
  if (!trimmed) return true
  if (/[?]{1,}/u.test(trimmed) && letterCount(trimmed) < 8) return true
  if (letterCount(trimmed) <= 1 && trimmed.length <= 3) return true
  if ((trimmed.match(/\uFFFD|□/gu) ?? []).length >= 1) return true
  return false
}

const looksLikeGarbageVision = (text: string) => {
  const trimmed = text.trim()
  if (!trimmed) return true
  const letters = letterCount(trimmed)
  if (letters < 1) return true
  if (letters / Math.max(1, trimmed.replace(/\s/gu, '').length) < 0.25 && letters < 6) return true
  if (/^(?:n\/?a|none|null|empty|kein text|no text|nicht lesbar)\.?$/iu.test(trimmed)) return true
  return false
}

const looksLikeHallucination = (text: string, strokeCount: number) => {
  const words = wordCount(text)
  if (strokeCount > 0 && strokeCount < 10 && words > Math.max(10, strokeCount * 2.4)) return true
  if (/(?:^|\s)(\p{L}{2,})(?:\s+\1){2,}/u.test(text)) return true
  return false
}

const mapPoint = (
  point: { x: number; y: number },
  line: LineCluster,
  layoutY: number,
  originX: number,
  scale: number,
  sourceWidth: number,
  sourceHeight: number,
) => ({
  x: (point.x * sourceWidth - originX) * scale + MARGIN,
  y: (point.y * sourceHeight - line.minY) * scale + layoutY + MARGIN,
})

const paintStroke = (
  context: CanvasRenderingContext2D,
  stroke: Stroke,
  line: LineCluster,
  layoutY: number,
  originX: number,
  scale: number,
  sourceWidth: number,
  sourceHeight: number,
) => {
  const usable = stroke.points.filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y))
  if (!usable.length) return
  const baseWidth = Math.max(0.9, Math.min(28, Number(stroke.baseWidth) || 3))
  const widthFor = (pressure: number) => {
    const factor = stroke.pressureEnabled && Number.isFinite(pressure)
      ? 0.72 + Math.max(0, Math.min(1, pressure)) * 0.68
      : 1
    return Math.max(2.6, Math.min(16, baseWidth * scale * factor * 1.22))
  }
  if (usable.length === 1) {
    const point = mapPoint(usable[0], line, layoutY, originX, scale, sourceWidth, sourceHeight)
    context.beginPath()
    context.arc(point.x, point.y, widthFor(usable[0].pressure) / 2, 0, Math.PI * 2)
    context.fill()
    return
  }
  context.beginPath()
  const first = mapPoint(usable[0], line, layoutY, originX, scale, sourceWidth, sourceHeight)
  context.moveTo(first.x, first.y)
  for (let index = 1; index < usable.length; index += 1) {
    const point = mapPoint(usable[index], line, layoutY, originX, scale, sourceWidth, sourceHeight)
    const pressure = (usable[index - 1].pressure + usable[index].pressure) / 2
    context.lineWidth = widthFor(pressure)
    if (index === usable.length - 1) {
      context.lineTo(point.x, point.y)
    } else {
      const next = mapPoint(usable[index + 1], line, layoutY, originX, scale, sourceWidth, sourceHeight)
      context.quadraticCurveTo(point.x, point.y, (point.x + next.x) / 2, (point.y + next.y) / 2)
    }
  }
  context.stroke()
}

/**
 * Renders handwriting to a high-contrast RGB crop for Qwen3-VL.
 * Multi-line notes are re-stacked with extra gap so the VLM can read row by row.
 */
export const renderQwenVisionImage = (
  strokes: Stroke[],
  sourceWidth: number,
  sourceHeight: number,
): QwenVisionImage | null => {
  const points = finitePoints(strokes)
  if (!points.length || !Number.isFinite(sourceWidth) || !Number.isFinite(sourceHeight)) return null
  const lines = clusterHandwritingLines(strokes, sourceWidth, sourceHeight)
  if (!lines.length) return null

  const originX = Math.min(...lines.map((line) => line.minX))
  const contentWidth = Math.max(1, Math.max(...lines.map((line) => line.maxX)) - originX)
  const typicalHeight = median(lines.map((line) => Math.max(1, line.maxY - line.minY)))
  const extraGap = lines.length > 1 ? Math.max(16, typicalHeight * LINE_GAP_FACTOR) : 0
  let stackedHeight = 0
  const layoutY = lines.map((line, index) => {
    const y = stackedHeight
    stackedHeight += Math.max(1, line.maxY - line.minY)
    if (index < lines.length - 1) stackedHeight += extraGap
    return y
  })

  const scale = Math.min(
    (MAX_IMAGE_WIDTH - MARGIN * 2) / contentWidth,
    (MAX_IMAGE_HEIGHT - MARGIN * 2) / stackedHeight,
    MAX_UPSCALE,
  )
  if (!Number.isFinite(scale) || scale <= 0) return null
  const width = Math.max(MIN_IMAGE_WIDTH, Math.min(
    MAX_IMAGE_WIDTH,
    Math.ceil(contentWidth * scale + MARGIN * 2),
  ))
  const height = Math.max(MIN_IMAGE_HEIGHT, Math.min(
    MAX_IMAGE_HEIGHT,
    Math.ceil(stackedHeight * scale + MARGIN * 2),
  ))
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d', { willReadFrequently: true, alpha: false })
  if (!context) return null
  context.imageSmoothingEnabled = true
  context.imageSmoothingQuality = 'high'
  context.fillStyle = '#ffffff'
  context.fillRect(0, 0, width, height)
  context.strokeStyle = '#111111'
  context.fillStyle = '#111111'
  context.lineCap = 'round'
  context.lineJoin = 'round'
  context.miterLimit = 2

  lines.forEach((line, index) => {
    for (const stroke of line.strokes) {
      paintStroke(context, stroke, line, layoutY[index] * scale, originX, scale, sourceWidth, sourceHeight)
    }
  })

  const rgba = context.getImageData(0, 0, width, height).data
  const pixels = new Uint8Array(width * height * 3)
  for (let index = 0, out = 0; index < rgba.length; index += 4, out += 3) {
    const gray = rgba[index] * 0.299 + rgba[index + 1] * 0.587 + rgba[index + 2] * 0.114
    // Keep antialiased edges; only crush near-white paper and near-black ink.
    const value = gray > 238 ? 255 : gray < 28 ? 0 : Math.round(gray)
    pixels[out] = value
    pixels[out + 1] = value
    pixels[out + 2] = value
  }
  return { pixels, width, height, lineCount: lines.length }
}

/**
 * Qwen3-VL is the recommended text engine: take its reading unless it is empty,
 * garbage, or an obvious hallucination.
 */
export const shouldPreferQwenVisionText = (
  classicalText: string,
  visionText: string,
  strokeCount = 0,
): boolean => {
  const classical = classicalText.trim()
  const vision = visionText.trim()
  if (!vision || looksLikeGarbageVision(vision) || looksLikeHallucination(vision, strokeCount)) return false
  if (!classical || isLowQualityClassical(classical)) return true

  const visionLetters = letterCount(vision)
  const classicalLetters = letterCount(classical)
  const visionWords = wordCount(vision)
  const classicalWords = wordCount(classical)

  // Classical recovered a clearly richer page while vision collapsed.
  if (classicalLetters > visionLetters * 1.7 && classicalWords > visionWords + 2 && classicalLetters >= 8) {
    return false
  }

  return true
}

/** Strip common VLM chat wrappers without inventing content. */
export const cleanQwenVisionText = (value: string): string => {
  let text = value.normalize('NFC').replace(/\r\n/gu, '\n').trim()
  if (!text) return ''
  text = text
    .replace(/^```(?:text|plain|markdown)?\s*/iu, '')
    .replace(/\s*```$/u, '')
    .replace(/^["'„“”«»]+|["'„“”«»]+$/gu, '')
    .replace(/^(?:the (?:handwritten )?(?:text|content) (?:is|reads|says)\s*[:\-]?\s*)/iu, '')
    .replace(/^(?:transcri(?:ption|bed text|be)\s*[:\-]?\s*)/iu, '')
    .replace(/^(?:erkannte[rs]? text\s*[:\-]?\s*)/iu, '')
    .replace(/^(?:hier ist der text\s*[:\-]?\s*)/iu, '')
    .replace(/^(?:der text lautet\s*[:\-]?\s*)/iu, '')
    .replace(/^(?:here is the (?:transcribed )?text\s*[:\-]?\s*)/iu, '')
    .trim()
  if (
    (text.startsWith('"') && text.endsWith('"'))
    || (text.startsWith('“') && text.endsWith('”'))
    || (text.startsWith('„') && text.endsWith('“'))
  ) {
    text = text.slice(1, -1).trim()
  }
  return text.replace(/\n{3,}/gu, '\n\n')
}
