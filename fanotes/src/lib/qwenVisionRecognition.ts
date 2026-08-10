import type { Stroke } from '../../../src/types'

export type QwenVisionImage = {
  pixels: Uint8Array
  width: number
  height: number
}

const MAX_IMAGE_WIDTH = 1_280
const MAX_IMAGE_HEIGHT = 1_280
const MIN_IMAGE_WIDTH = 96
const MIN_IMAGE_HEIGHT = 96
const MARGIN = 28
const MAX_UPSCALE = 4.5

const finitePoints = (strokes: Stroke[]) => strokes.flatMap((stroke) => (
  stroke.points.filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y))
))

const letterCount = (value: string) => (value.match(/[\p{L}\p{N}]/gu) ?? []).length
const wordCount = (value: string) => value.trim().split(/\s+/u).filter(Boolean).length

const isLowQualityClassical = (text: string) => {
  const trimmed = text.trim()
  if (!trimmed) return true
  if (/[?]{1,}/u.test(trimmed) && letterCount(trimmed) < 8) return true
  if (letterCount(trimmed) <= 1 && trimmed.length <= 3) return true
  // Many replacement/unknown glyph markers
  if ((trimmed.match(/\uFFFD|□/gu) ?? []).length >= 1) return true
  return false
}

const looksLikeGarbageVision = (text: string) => {
  const trimmed = text.trim()
  if (!trimmed) return true
  const letters = letterCount(trimmed)
  if (letters < 1) return true
  // Entirely symbolic or path-like noise
  if (letters / Math.max(1, trimmed.replace(/\s/gu, '').length) < 0.25 && letters < 6) return true
  if (/^(?:n\/?a|none|null|empty|kein text|no text)\.?$/iu.test(trimmed)) return true
  return false
}

/**
 * Renders handwriting strokes to a high-contrast RGB crop for Qwen3-VL.
 * Smooth, slightly bold black-on-white ink improves VLM OCR accuracy.
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
    MAX_UPSCALE,
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
  const context = canvas.getContext('2d', { willReadFrequently: true, alpha: false })
  if (!context) return null
  context.imageSmoothingEnabled = true
  context.imageSmoothingQuality = 'high'
  context.fillStyle = '#ffffff'
  context.fillRect(0, 0, width, height)
  // Near-black ink with slight softness via wider strokes for thin pens.
  context.strokeStyle = '#0a0a0a'
  context.fillStyle = '#0a0a0a'
  context.lineCap = 'round'
  context.lineJoin = 'round'
  context.miterLimit = 2

  for (const stroke of strokes) {
    const usable = stroke.points.filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y))
    if (!usable.length) continue
    const baseWidth = Math.max(0.9, Math.min(28, Number(stroke.baseWidth) || 3))
    const widthFor = (pressure: number) => {
      const factor = stroke.pressureEnabled && Number.isFinite(pressure)
        ? 0.68 + Math.max(0, Math.min(1, pressure)) * 0.7
        : 1
      // Keep strokes bold enough for VLM resolution after downscale.
      return Math.max(2.2, Math.min(14, baseWidth * scale * factor * 1.12))
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
    // Quadratic smoothing between midpoints — closer to real pen trajectories.
    context.beginPath()
    const first = usable[0]
    let prevX = offsetX + first.x * sourceWidth * scale
    let prevY = offsetY + first.y * sourceHeight * scale
    context.moveTo(prevX, prevY)
    for (let index = 1; index < usable.length; index += 1) {
      const point = usable[index]
      const x = offsetX + point.x * sourceWidth * scale
      const y = offsetY + point.y * sourceHeight * scale
      const pressure = (usable[index - 1].pressure + point.pressure) / 2
      context.lineWidth = widthFor(pressure)
      if (index === usable.length - 1) {
        context.lineTo(x, y)
      } else {
        const next = usable[index + 1]
        const midX = (x + offsetX + next.x * sourceWidth * scale) / 2
        const midY = (y + offsetY + next.y * sourceHeight * scale) / 2
        context.quadraticCurveTo(x, y, midX, midY)
      }
      prevX = x
      prevY = y
    }
    context.stroke()
  }

  const rgba = context.getImageData(0, 0, width, height).data
  const pixels = new Uint8Array(width * height * 3)
  for (let index = 0, out = 0; index < rgba.length; index += 4, out += 3) {
    // Mild contrast stretch toward pure B/W for cleaner VLM tokens.
    const gray = (rgba[index] * 0.299 + rgba[index + 1] * 0.587 + rgba[index + 2] * 0.114)
    const value = gray > 210 ? 255 : gray < 70 ? 0 : Math.round(gray)
    pixels[out] = value
    pixels[out + 1] = value
    pixels[out + 2] = value
  }
  return { pixels, width, height }
}

/**
 * Decide whether Qwen3-VL text should replace the classical/neural result.
 * When vision looks coherent, prefer it more often — that is the point of enabling it.
 */
export const shouldPreferQwenVisionText = (
  classicalText: string,
  visionText: string,
): boolean => {
  const classical = classicalText.trim()
  const vision = visionText.trim()
  if (!vision || looksLikeGarbageVision(vision)) return false
  if (!classical || isLowQualityClassical(classical)) return true

  const visionLetters = letterCount(vision)
  const classicalLetters = letterCount(classical)
  const visionWords = wordCount(vision)
  const classicalWords = wordCount(classical)

  // Vision recovered a clearly richer reading.
  if (visionLetters >= classicalLetters + 2 && visionLetters >= 2) return true
  if (visionWords >= classicalWords + 1 && visionLetters >= 3) return true

  // Classical looks broken (question marks / short junk) while vision is fine.
  if ((classical.match(/[?]/gu) ?? []).length > 0 && !(vision.match(/[?]/gu) ?? []).length) {
    return true
  }

  // Comparable content: prefer vision when it is at least as long and letter-rich.
  if (
    visionLetters >= Math.max(2, classicalLetters)
    && vision.length >= classical.length - 1
    && !/[?]{2,}/u.test(vision)
  ) {
    return true
  }

  // Same word count, vision has higher alphanumeric density.
  if (
    visionWords === classicalWords
    && visionWords >= 1
    && visionLetters > classicalLetters
  ) {
    return true
  }

  return false
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
    .trim()
  // Drop a single wrapping pair of quotes around the whole answer.
  if (
    (text.startsWith('"') && text.endsWith('"'))
    || (text.startsWith('“') && text.endsWith('”'))
    || (text.startsWith('„') && text.endsWith('“'))
  ) {
    text = text.slice(1, -1).trim()
  }
  return text
}
