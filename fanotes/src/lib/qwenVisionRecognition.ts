import type { Stroke } from '../../../src/types'

export type QwenVisionImage = {
  pixels: Uint8Array
  width: number
  height: number
}

const MAX_IMAGE_WIDTH = 960
const MAX_IMAGE_HEIGHT = 960
const MIN_IMAGE_WIDTH = 64
const MIN_IMAGE_HEIGHT = 64
const MARGIN = 16

const finitePoints = (strokes: Stroke[]) => strokes.flatMap((stroke) => (
  stroke.points.filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y))
))

/**
 * Renders handwriting strokes to an RGB crop for Qwen3-VL.
 * Tight black-on-white crops keep NPU tokens small and power low.
 */
export const renderQwenVisionImage = (
  strokes: Stroke[],
  sourceWidth: number,
  sourceHeight: number,
): QwenVisionImage | null => {
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
    3,
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
  context.strokeStyle = '#111111'
  context.fillStyle = '#111111'
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
      return Math.max(1.4, Math.min(9, baseWidth * scale * factor))
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
  const pixels = new Uint8Array(width * height * 3)
  for (let index = 0, out = 0; index < rgba.length; index += 4, out += 3) {
    pixels[out] = rgba[index]
    pixels[out + 1] = rgba[index + 1]
    pixels[out + 2] = rgba[index + 2]
  }
  return { pixels, width, height }
}

export const shouldPreferQwenVisionText = (
  classicalText: string,
  visionText: string,
): boolean => {
  const classical = classicalText.trim()
  const vision = visionText.trim()
  if (!vision) return false
  if (!classical || classical.includes('?')) return true
  // Prefer vision when it recovers substantially more readable content.
  if (vision.length >= classical.length + 3 && /[\p{L}\p{N}]/u.test(vision)) return true
  if (vision.split(/\s+/u).length >= classical.split(/\s+/u).length + 1 && !/[?]{2,}/u.test(vision)) {
    return true
  }
  return false
}
