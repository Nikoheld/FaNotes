/**
 * Upright OCR for scanned pages with the bundled line model. The model reads
 * one text line at a time and cannot read a turned page. The orientation is
 * chosen from the shape of the letters (ascenders above, descenders below the
 * x-height), which needs no recognition and cannot be fooled by a model that
 * invents plausible words for an upside-down line. TrOCR reports no confidence; the share of
 * word-like tokens is used as an estimate and labelled as such in the UI.
 */
import { segmentPdfOcrLines, type PdfOcrLine } from '../pdfOcr'

export type Rotation = 0 | 90 | 180 | 270
export type RecognizeLine = (pixels: Uint8ClampedArray, width: number, height: number) => Promise<string>

/** Turns an RGBA bitmap clockwise. */
export const rotatePixels = (pixels: Uint8ClampedArray, width: number, height: number, rotation: Rotation) => {
  if (rotation === 0) return { pixels, width, height }
  const turned = rotation === 180 ? { width, height } : { width: height, height: width }
  const out = new Uint8ClampedArray(pixels.length)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let tx: number
      let ty: number
      if (rotation === 90) { tx = height - 1 - y; ty = x }
      else if (rotation === 180) { tx = width - 1 - x; ty = height - 1 - y }
      else { tx = y; ty = width - 1 - x }
      const from = (y * width + x) * 4
      const to = (ty * turned.width + tx) * 4
      out[to] = pixels[from]!
      out[to + 1] = pixels[from + 1]!
      out[to + 2] = pixels[from + 2]!
      out[to + 3] = pixels[from + 3]!
    }
  }
  return { pixels: out, ...turned }
}

const WORD = /^[\p{L}][\p{L}'’-]{2,}$/u
const VOWEL = /[aeiouyäöüàâéèêëîïôûœæ]/iu

/** 0–1: share of tokens that look like words (letters only, ≥ 3, with a vowel). */
export const wordQuality = (text: string) => {
  const tokens = text.split(/[\s.,;:!?()[\]{}"„“”«»]+/u).filter(Boolean)
  if (!tokens.length) return 0
  const good = tokens.filter((token) => WORD.test(token) && VOWEL.test(token)).length
  return good / tokens.length
}

export const letterCount = (text: string) => (text.match(/\p{L}/gu) ?? []).length

/**
 * Latin script has more ink above the x-height band (capitals, b d f h k l t)
 * than below the baseline (g j p q y). Positive: upright; negative: upside down.
 * Needs no recognition, so it cannot be fooled by a model inventing words.
 */
export const ascenderBias = (lines: readonly PdfOcrLine[]) => {
  let total = 0
  for (const line of lines.slice(0, 20)) {
    const rows = new Float64Array(line.height)
    let max = 0
    for (let y = 0; y < line.height; y += 1) {
      let ink = 0
      for (let x = 0; x < line.width; x += 1) {
        const at = (y * line.width + x) * 4
        const lum = 0.299 * line.pixels[at]! + 0.587 * line.pixels[at + 1]! + 0.114 * line.pixels[at + 2]!
        if (lum < 128) ink += 1
      }
      rows[y] = ink
      if (ink > max) max = ink
    }
    if (max < 4) continue
    let first = -1
    let last = -1
    for (let y = 0; y < line.height; y += 1) {
      if (rows[y]! >= max * 0.45) { if (first < 0) first = y; last = y }
    }
    if (first < 0) continue
    let above = 0
    let below = 0
    for (let y = 0; y < first; y += 1) above += rows[y]!
    for (let y = last + 1; y < line.height; y += 1) below += rows[y]!
    // Only long, flat bands are text lines; squarish fragments (letters cut
    // the wrong way) get no vote.
    const lineLike = Math.min(1, Math.max(0, (line.width / Math.max(1, line.height) - 2) / 6))
    total += lineLike * (above - below) / Math.max(1, above + below)
  }
  return total
}

export type OrientedResult = {
  text: string
  rotation: Rotation
  /** Estimated from word quality, 0–1. */
  confidence: number
  lines: number
}

const SAMPLE_LINES = 3
const GOOD_ENOUGH = 0.55

type Bitmap = { pixels: Uint8ClampedArray; width: number; height: number }

/** Orientation ranking plus the text lines of any orientation, computed on demand. */
export type PreparedPage = {
  ranked: Array<[Rotation, number]>
  lines: (rotation: Rotation) => Promise<PdfOcrLine[]>
  release?: () => void
}

export type PreparePage = (input: Bitmap, maxLines: number) => Promise<PreparedPage>

/**
 * Pure pixel work: turn, find text lines, score orientations. Runs in the
 * OCR-preparation worker in the app (see ocrPrepWorker.ts) and inline in tests.
 */
export const preparePageSync = (input: Bitmap, maxLines: number) => {
  const views = new Map<Rotation, PdfOcrLine[]>()
  const view = (rotation: Rotation) => {
    let found = views.get(rotation)
    if (!found) {
      const turned = rotatePixels(input.pixels, input.width, input.height, rotation)
      found = segmentPdfOcrLines(turned.pixels, turned.width, turned.height).slice(0, maxLines)
      views.set(rotation, found)
    }
    return found
  }
  // Letters stand upright where ink sits above the x-height band (see
  // ascenderBias). Turning a view by 180° flips the sign, so two views
  // score all four orientations. Recognition quality only breaks near-ties.
  const upright = ascenderBias(view(0))
  const sideways = ascenderBias(view(90))
  const ranked = ([[0, upright], [180, -upright], [90, sideways], [270, -sideways]] as Array<[Rotation, number]>)
    .sort((left, right) => right[1] - left[1])
  return { ranked, view }
}

export const preparePageLocal: PreparePage = async (input, maxLines) => {
  const { ranked, view } = preparePageSync(input, maxLines)
  return { ranked, lines: async (rotation) => view(rotation) }
}

/**
 * Picks the orientation, then reads every line once. Lines read while choosing
 * are reused, so an upright page costs no extra recognition.
 */
export const recognizeOriented = async (
  input: Bitmap,
  recognize: RecognizeLine,
  shouldStop: () => boolean = () => false,
  maxLines = 40,
  prepare: PreparePage = preparePageLocal,
): Promise<OrientedResult> => {
  const prepared = await prepare(input, maxLines)
  try {
    const order: Rotation[] = [prepared.ranked[0]![0], prepared.ranked[1]![0]]
    const read = new Map<Rotation, string[]>()
    const readLines = async (rotation: Rotation, count: number) => {
      const lines = await prepared.lines(rotation)
      const done = read.get(rotation) ?? []
      for (let index = done.length; index < Math.min(count, lines.length); index += 1) {
        if (shouldStop()) break
        const line = lines[index]!
        const text = (await recognize(line.pixels, line.width, line.height)).replace(/\s+/gu, ' ').trim()
        done.push(text.slice(0, 500))
      }
      read.set(rotation, done)
      return done
    }
    let chosen = order[0]!
    const first = await readLines(order[0]!, SAMPLE_LINES)
    if (wordQuality(first.join(' ')) < GOOD_ENOUGH && !shouldStop()) {
      const second = await readLines(order[1]!, SAMPLE_LINES)
      if (wordQuality(second.join(' ')) > wordQuality(first.join(' ')) + 0.15) chosen = order[1]!
    }
    const all = await readLines(chosen, maxLines)
    const text = all.filter(Boolean).join('\n')
    return {
      text,
      rotation: chosen,
      confidence: Math.round(Math.min(0.95, Math.max(0.05, wordQuality(text))) * 100) / 100,
      lines: (await prepared.lines(chosen)).length,
    }
  } finally {
    prepared.release?.()
  }
}
