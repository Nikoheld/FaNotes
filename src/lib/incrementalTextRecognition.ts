import type { Stroke } from '../types'

export type IncrementalTextRecognitionState = {
  strokes: Stroke[]
  characterCount: number
  text: string
  pendingStrokeIndex: number
  prefixText: string
}

export type IncrementalTextCharacterHint = {
  characterCount: number
  beginsNewGlyph: boolean
  addedStrokes: Stroke[]
  previousText: string
  pendingStrokeIndex: number
}

type Extent = {
  minX: number
  maxX: number
  minY: number
  maxY: number
}

const strokeExtent = (strokes: Stroke[]): Extent | null => {
  const points = strokes.flatMap((stroke) => stroke.points)
  if (!points.length) return null
  return {
    minX: Math.min(...points.map((point) => point.x)),
    maxX: Math.max(...points.map((point) => point.x)),
    minY: Math.min(...points.map((point) => point.y)),
    maxY: Math.max(...points.map((point) => point.y)),
  }
}

const widthOf = (extent: Extent) => extent.maxX - extent.minX
const heightOf = (extent: Extent) => extent.maxY - extent.minY

const sameStrokeTrajectory = (first: Stroke, second: Stroke) => (
  first.baseWidth === second.baseWidth &&
  first.pressureEnabled === second.pressureEnabled &&
  first.points.length === second.points.length &&
  first.points.every((point, index) => {
    const candidate = second.points[index]
    return Boolean(candidate) &&
      point.x === candidate.x &&
      point.y === candidate.y &&
      point.t === candidate.t &&
      point.pressure === candidate.pressure &&
      point.pointerType === candidate.pointerType
  })
)

/**
 * Derives a high-precision count hint only from append-only pen input.
 *
 * A count hint is treated as an exact segmentation constraint downstream, so
 * ambiguity is more damaging than missing a hint.  In particular, a rapid
 * multi-stroke T may contain a bar reaching back over the previous letter,
 * while two quickly appended body strokes may already be two new letters.
 * The former is recognized from its single substantial body; the latter
 * returns no hint and is left to the independent text/line recognizers.
 */
export const incrementalTextCharacterHint = (
  previous: IncrementalTextRecognitionState | null,
  current: Stroke[],
): IncrementalTextCharacterHint | undefined => {
  if (
    !previous ||
    previous.characterCount < 1 ||
    previous.characterCount >= 24 ||
    current.length <= previous.strokes.length ||
    previous.strokes.some((stroke, index) => !sameStrokeTrajectory(stroke, current[index]))
  ) return undefined

  const appendedStrokes = current.slice(previous.strokes.length)
  const before = strokeExtent(previous.strokes)
  const added = strokeExtent(appendedStrokes)
  if (!before || !added) return undefined

  const lineHeight = Math.max(0.012, heightOf(before))
  const overlapsLine = added.maxY >= before.minY - lineHeight * 0.35
    && added.minY <= before.maxY + lineHeight * 0.35
  if (!overlapsLine) return undefined

  const extensionThreshold = Math.max(0.004, lineHeight * 0.035)
  const extendsWord = added.maxX >= before.maxX + extensionThreshold
  const appendedExtents = appendedStrokes.flatMap((stroke) => {
    const extent = strokeExtent([stroke])
    return extent ? [{ stroke, extent }] : []
  })

  // A dot or crossbar belonging to the current glyph may overhang its body a
  // little.  This is the only ambiguous-looking case where retaining the old
  // count is safe; a substantive stroke that reaches right is never silently
  // collapsed into the previous glyph.
  const accessoryReach = Math.max(0.018, lineHeight * 0.5)
  const allAccessorySized = appendedExtents.every(({ extent }) => (
    heightOf(extent) <= lineHeight * 0.3 &&
    widthOf(extent) <= lineHeight * 1.25
  ))
  const accessoryNearCurrentGlyph = (
    allAccessorySized &&
    added.minX >= before.maxX - lineHeight * 0.95 &&
    added.maxX <= before.maxX + accessoryReach
  )
  if (accessoryNearCurrentGlyph) {
    const pendingStrokeIndex = Math.max(
      0,
      Math.min(previous.pendingStrokeIndex, previous.strokes.length),
    )
    return {
      characterCount: previous.characterCount,
      beginsNewGlyph: false,
      addedStrokes: current.slice(pendingStrokeIndex),
      previousText: previous.prefixText,
      pendingStrokeIndex,
    }
  }
  // Substantive ink that does not extend the right edge could be an inserted
  // letter, a correction, or a rewritten body. None of those proves that the
  // old count stayed exact.
  if (!extendsWord) return undefined

  const bodyEntries = appendedExtents.filter(({ extent }) => (
    heightOf(extent) >= Math.max(0.009, lineHeight * 0.34)
  ))
  // Zero or several newly appended bodies do not prove exactly one new
  // character.  Refusing an exact count here fixes the feedback loop where a
  // connected pair was forced into one glyph and then classified as ∫/∬.
  if (bodyEntries.length !== 1) return undefined

  const body = bodyEntries[0].extent
  const bodyCenterX = (body.minX + body.maxX) / 2
  const anchoredAtRightEdge = (
    bodyCenterX >= before.maxX - Math.max(0.018, lineHeight * 0.24) &&
    body.minX >= before.maxX - Math.max(0.028, lineHeight * 0.65) &&
    body.maxX >= before.maxX + extensionThreshold
  )
  if (!anchoredAtRightEdge) return undefined

  // Every remaining stroke must plausibly be an accessory of that body.  A
  // second full body was rejected above; this spatial guard also rejects a
  // far-away dot/bar that could belong to another quickly written glyph.
  const accessoryMargin = Math.max(0.024, lineHeight * 0.58)
  const accessoriesBelongToBody = appendedExtents.every(({ extent }) => (
    extent === body || (
      heightOf(extent) <= lineHeight * 0.3 &&
      extent.maxX >= body.minX - accessoryMargin &&
      extent.minX <= body.maxX + accessoryMargin
    )
  ))
  if (!accessoriesBelongToBody) return undefined

  return {
    characterCount: previous.characterCount + 1,
    beginsNewGlyph: true,
    addedStrokes: appendedStrokes,
    previousText: previous.text,
    pendingStrokeIndex: previous.strokes.length,
  }
}

/**
 * Extracts a count only from the recognizer's parallel text branch.  Selected
 * math tokens are deliberately not accepted: otherwise a mistaken `∬` (one
 * math token) becomes a hard one-character prior for the neural text pass.
 */
export const independentTextCharacterCount = (
  compactText: string,
  evidence: {
    visibleCharacters?: number
    letters?: number
  } | undefined,
) => {
  const characters = Array.from(compactText)
  if (
    characters.length < 1 ||
    characters.length > 320 ||
    !characters.every((character) => /^\p{L}$/u.test(character)) ||
    evidence?.visibleCharacters !== characters.length ||
    evidence.letters !== characters.length
  ) return undefined
  return characters.length
}

export const embeddedTextRecognitionHints = (
  incrementalHint: Pick<IncrementalTextCharacterHint, 'characterCount'> | undefined,
  compactText: string,
  textEvidence: {
    visibleCharacters?: number
    letters?: number
  } | undefined,
  selectedMode: 'text' | 'math',
  incrementalTextHint?: string,
) => {
  const textBranchCharacterCount = independentTextCharacterCount(compactText, textEvidence)
  return {
    textCharacterCountHint: incrementalHint?.characterCount ?? textBranchCharacterCount,
    // The parallel text branch may safely contribute its count while math is
    // selected, but not its guessed letters. This lets the independent neural
    // recognizer recover `Te` from a transient `∬` without circularly forcing
    // the classical content itself.
    textCharacterHint: incrementalTextHint ?? (
      selectedMode === 'text' && textBranchCharacterCount !== undefined
        ? compactText
        : undefined
    ),
  }
}
