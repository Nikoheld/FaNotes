import type { Stroke, StrokePoint } from '../types'

/**
 * Snapshot of one text preview. `text` is the latest automatic guess.
 * `prefixText` is the only part that may be fed back, and only the slice
 * covered by `confirmedPrefixLength` was explicitly accepted by the user.
 */
export type IncrementalTextRecognitionState = {
  strokes: Stroke[]
  characterCount: number
  text: string
  pendingStrokeIndex: number
  prefixText: string
  confirmedPrefixLength?: number
  uncertainCarryCount?: number
}

type InkExtent = {
  minX: number
  maxX: number
  minY: number
  maxY: number
}

const characters = (value: string) => Array.from(value.normalize('NFC'))

const commonPrefix = (left: string, right: string) => {
  const first = characters(left)
  const second = characters(right)
  let index = 0
  while (index < first.length && index < second.length && first[index] === second[index]) index += 1
  return first.slice(0, index).join('')
}

const samePoint = (first: StrokePoint, second: StrokePoint) => (
  first.x === second.x &&
  first.y === second.y &&
  first.t === second.t &&
  first.pressure === second.pressure
)

const sameStrokeInk = (first: Stroke, second: Stroke) => (
  first.points.length === second.points.length &&
  first.points.every((point, index) => samePoint(point, second.points[index]))
)

const inkExtent = (strokes: Stroke[]): InkExtent | null => {
  const points = strokes.flatMap((stroke) => stroke.points)
  if (!points.length) return null
  return {
    minX: Math.min(...points.map((point) => point.x)),
    maxX: Math.max(...points.map((point) => point.x)),
    minY: Math.min(...points.map((point) => point.y)),
    maxY: Math.max(...points.map((point) => point.y)),
  }
}

const overlapsWritingLine = (before: InkExtent, added: InkExtent) => {
  const lineHeight = Math.max(0.012, before.maxY - before.minY)
  return added.maxY >= before.minY - lineHeight * 0.35
    && added.minY <= before.maxY + lineHeight * 0.35
}

const beginsAtRightEdge = (before: InkExtent, added: InkExtent) => {
  const lineHeight = Math.max(0.012, before.maxY - before.minY)
  return added.minX >= before.maxX - Math.max(0.018, lineHeight * 0.34)
}

const isHorizontalAccessory = (box: InkExtent, lineHeight: number) => {
  const width = box.maxX - box.minX
  const height = box.maxY - box.minY
  return width >= Math.max(0.012, lineHeight * 0.2) && height <= Math.max(0.012, width * 0.45)
}

const isTallTextBody = (box: InkExtent, lineHeight: number) => {
  const width = Math.max(0.0001, box.maxX - box.minX)
  const height = box.maxY - box.minY
  return height >= lineHeight * 0.45 && height >= width * 0.8 && !isHorizontalAccessory(box, lineHeight)
}

/**
 * A new body may confirm only the letter that was already visible in the
 * previous snapshot, and only one such step. An accessory stroke and a
 * contradicted guess must not grow the prefix. An explicitly confirmed
 * prefix survives a later automatic letter that disagrees with it.
 */
export const advanceStableTextPrefix = (
  previous: IncrementalTextRecognitionState | null,
  nextText: string,
  beginsNewGlyph: boolean,
) => {
  if (!previous) return ''
  if (!beginsNewGlyph) return previous.prefixText
  const confirmedLength = Math.max(0, previous.confirmedPrefixLength ?? 0)
  const confirmed = characters(previous.prefixText).slice(0, confirmedLength).join('')
  const agreed = commonPrefix(previous.prefixText, nextText)
  const kept = characters(agreed).length >= confirmedLength ? agreed : confirmed
  const observed = previous.text.normalize('NFC')
  const next = nextText.normalize('NFC')
  const prefix = previous.prefixText.normalize('NFC')
  if (
    next.startsWith(observed) &&
    observed.startsWith(prefix) &&
    characters(observed).length === characters(prefix).length + 1
  ) return observed
  return kept
}

/**
 * A token correction confirms exactly that token, and only when it continues
 * the already confirmed prefix with no gap. The character comes from the
 * corrected text at that index, never from an earlier automatic guess.
 */
export const textPrefixAfterTokenCorrection = (
  previous: IncrementalTextRecognitionState | null,
  correctedText: string,
  visibleIndex: number,
) => {
  const confirmedPrefixLength = Math.max(0, previous?.confirmedPrefixLength ?? 0)
  const existingPrefix = previous?.prefixText ?? ''
  const corrected = characters(correctedText)
  const correctedCharacter = corrected[visibleIndex]
  if (
    visibleIndex !== confirmedPrefixLength ||
    !correctedCharacter ||
    !/^\p{L}$/u.test(correctedCharacter)
  ) {
    return { prefixText: existingPrefix, confirmedPrefixLength }
  }
  return {
    prefixText: `${characters(existingPrefix).slice(0, confirmedPrefixLength).join('')}${correctedCharacter}`,
    confirmedPrefixLength: confirmedPrefixLength + 1,
  }
}

/** Host text may replace local tokens only when both describe the same letters. */
export const textProjectionMatchesTokens = (hostText: string, localTokenText: string) => {
  const host = hostText.normalize('NFC').replace(/\s+/gu, '')
  const local = localTokenText.normalize('NFC').replace(/\s+/gu, '')
  return host.length > 0 && host === local
}

/** Earlier ink must be unchanged. New strokes may only be appended after it. */
export const isAppendOnlyTextInk = (
  previous: IncrementalTextRecognitionState | null,
  current: Stroke[],
) => Boolean(
  previous &&
  current.length >= previous.strokes.length &&
  previous.strokes.every((stroke, index) => sameStrokeInk(stroke, current[index])),
)

/**
 * One uncertain preview may keep the last stable prefix, but the ink snapshot
 * still advances so the next stroke is judged against the current canvas.
 */
export const carryStableTextPrefixAcrossUncertainInk = (
  previous: IncrementalTextRecognitionState | null,
  strokes: Stroke[],
): IncrementalTextRecognitionState => {
  const base = previous ?? {
    strokes: [],
    characterCount: 0,
    text: '',
    pendingStrokeIndex: 0,
    prefixText: '',
  }
  return {
    ...base,
    strokes: strokes.slice(),
    pendingStrokeIndex: strokes.length,
    uncertainCarryCount: (base.uncertainCarryCount ?? 0) + 1,
  }
}

/** A second uncertain preview in a row, or ink that leaves the line, drops the carry. */
export const canCarryUncertainTextState = (
  previous: IncrementalTextRecognitionState | null,
  strokes: Stroke[],
) => Boolean(
  previous &&
  (previous.uncertainCarryCount ?? 0) < 1 &&
  (hasLooseTextContinuation(previous, strokes) || isAppendOnlyTextInk(previous, strokes)),
)

/**
 * A continuation on the same writing line and to the right of the previous
 * word may still see a confirmed prefix. A new line or a rewrite to the left
 * may not.
 */
export const hasLooseTextContinuation = (
  previous: IncrementalTextRecognitionState | null,
  current: Stroke[],
) => {
  if (!previous || current.length <= previous.strokes.length) return false
  const before = inkExtent(previous.strokes)
  const added = inkExtent(current.slice(previous.strokes.length))
  if (!before || !added || !overlapsWritingLine(before, added)) return false
  return beginsAtRightEdge(before, added) && added.maxX > before.maxX - 0.004
}

/**
 * Safe append evidence for the classical text path. The returned previousText
 * is only the already stable prefix, never the latest full guess, and two new
 * bodies at once produce no hard count.
 */
export const incrementalTextCharacterHint = (
  previous: IncrementalTextRecognitionState | null,
  current: Stroke[],
) => {
  if (
    !previous ||
    previous.characterCount < 1 ||
    previous.characterCount >= 24 ||
    !isAppendOnlyTextInk(previous, current) ||
    current.length <= previous.strokes.length
  ) return undefined
  const before = inkExtent(previous.strokes)
  const addedStrokes = current.slice(previous.strokes.length)
  const added = inkExtent(addedStrokes)
  if (!before || !added || !overlapsWritingLine(before, added)) return undefined
  const lineHeight = Math.max(0.012, before.maxY - before.minY)
  let newBodies = 0
  for (const stroke of addedStrokes) {
    const box = inkExtent([stroke])
    if (!box || !isTallTextBody(box, lineHeight)) continue
    // A tall mark that stays inside the previous word is a rewrite, not a
    // confirmed extra letter and not proof that the old count is still exact.
    const extendsPastWord = box.maxX > before.maxX + Math.max(0.004, lineHeight * 0.035)
    if (!extendsPastWord) return undefined
    newBodies += 1
  }
  if (newBodies >= 2) return undefined
  const beginsNewGlyph = newBodies === 1
  return {
    characterCount: beginsNewGlyph ? previous.characterCount + 1 : previous.characterCount,
    beginsNewGlyph,
    pendingStrokeIndex: beginsNewGlyph
      ? previous.strokes.length
      : Math.max(0, Math.min(previous.pendingStrokeIndex, previous.strokes.length)),
    previousText: previous.prefixText,
    addedStrokes,
  }
}

/**
 * The iframe may post only a stable letter prefix. Counts and freshly guessed
 * words stay on the host side so they cannot be fed back into the next guess.
 */
export const embeddedTextRecognitionHints = (
  hint?: { previousText?: string } | null,
) => {
  const previousText = hint?.previousText
  if (typeof previousText !== 'string' || previousText.length < 1 || previousText.length > 320) {
    return { textPrefixHint: undefined as string | undefined }
  }
  const normalized = previousText.normalize('NFC')
  if (
    normalized.length > 320 ||
    /[ßẞ]/u.test(normalized) ||
    !/^\p{L}{1,320}$/u.test(normalized)
  ) {
    return { textPrefixHint: undefined as string | undefined }
  }
  return { textPrefixHint: normalized }
}
