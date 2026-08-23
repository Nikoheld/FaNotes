import type { Stroke } from '../../../src/types'

export type EnhancedMathImage = {
  pixels: Uint8Array
  width: number
  height: number
}

const MAX_IMAGE_WIDTH = 792
const MAX_IMAGE_HEIGHT = 192
const MIN_IMAGE_WIDTH = 64
const MIN_IMAGE_HEIGHT = 48
const MARGIN = 8

const finitePoints = (strokes: Stroke[]) => strokes.flatMap((stroke) => (
  stroke.points.filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y))
))

/**
 * Renders a complete 2-D formula without first segmenting it into glyphs.
 * PosFormer was trained on tightly cropped black-on-white formula images.
 * A large fixed canvas would make short formulae almost entirely white and
 * trigger the native runtime's 100k-pixel downscaler, erasing thin strokes.
 * Keep the original aspect ratio and return a tight, training-like crop.
 */
export const renderEnhancedMathImage = (
  strokes: Stroke[],
  sourceWidth: number,
  sourceHeight: number,
): EnhancedMathImage | null => {
  const points = finitePoints(strokes)
  if (!points.length || !Number.isFinite(sourceWidth) || !Number.isFinite(sourceHeight)) return null
  const minX = Math.min(...points.map((point) => point.x * sourceWidth))
  const maxX = Math.max(...points.map((point) => point.x * sourceWidth))
  const minY = Math.min(...points.map((point) => point.y * sourceHeight))
  const maxY = Math.max(...points.map((point) => point.y * sourceHeight))
  const inkWidth = Math.max(1, maxX - minX)
  const inkHeight = Math.max(1, maxY - minY)
  const scale = Math.min(
    (MAX_IMAGE_WIDTH - MARGIN * 2) / inkWidth,
    (MAX_IMAGE_HEIGHT - MARGIN * 2) / inkHeight,
  )
  if (!Number.isFinite(scale) || scale <= 0) return null
  const width = Math.max(MIN_IMAGE_WIDTH, Math.min(
    MAX_IMAGE_WIDTH,
    Math.ceil(inkWidth * scale + MARGIN * 2),
  ))
  const height = Math.max(MIN_IMAGE_HEIGHT, Math.min(
    MAX_IMAGE_HEIGHT,
    Math.ceil(inkHeight * scale + MARGIN * 2),
  ))
  const offsetX = (width - inkWidth * scale) / 2 - minX * scale
  const offsetY = (height - inkHeight * scale) / 2 - minY * scale
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (!context) return null
  context.fillStyle = '#ffffff'
  context.fillRect(0, 0, width, height)
  context.strokeStyle = '#000000'
  context.fillStyle = '#000000'
  context.lineCap = 'round'
  context.lineJoin = 'round'

  for (const stroke of strokes) {
    const usable = stroke.points.filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y))
    if (!usable.length) continue
    const baseWidth = Math.max(0.8, Math.min(24, Number(stroke.baseWidth) || 3))
    const widthFor = (pressure: number) => {
      const factor = stroke.pressureEnabled && Number.isFinite(pressure)
        ? 0.62 + Math.max(0, Math.min(1, pressure)) * 0.76
        : 1
      return Math.max(1.35, Math.min(8, baseWidth * scale * factor))
    }
    if (usable.length === 1) {
      const point = usable[0]
      context.beginPath()
      context.arc(
        offsetX + point.x * sourceWidth * scale,
        offsetY + point.y * sourceHeight * scale,
        widthFor(point.pressure) / 2,
        0,
        Math.PI * 2,
      )
      context.fill()
      continue
    }
    for (let index = 1; index < usable.length; index += 1) {
      const previous = usable[index - 1]
      const point = usable[index]
      context.beginPath()
      context.moveTo(
        offsetX + previous.x * sourceWidth * scale,
        offsetY + previous.y * sourceHeight * scale,
      )
      context.lineTo(
        offsetX + point.x * sourceWidth * scale,
        offsetY + point.y * sourceHeight * scale,
      )
      context.lineWidth = widthFor((previous.pressure + point.pressure) / 2)
      context.stroke()
    }
  }

  const rgba = context.getImageData(0, 0, width, height).data
  const pixels = new Uint8Array(width * height)
  for (let index = 0; index < pixels.length; index += 1) pixels[index] = rgba[index * 4]
  return { pixels, width, height }
}
