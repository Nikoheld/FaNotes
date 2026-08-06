import type { Stroke } from '../types'

export type IncrementalTextRecognitionState = {
  strokes: Stroke[]
  characterCount: number
  text: string
  pendingStrokeIndex: number
  prefixText: string
  /** Number of leading prefix characters explicitly confirmed by the user. */
  confirmedPrefixLength?: number
  /** At most one non-text preview may be bridged before the prefix expires. */
  uncertainCarryCount?: number
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

export const isAppendOnlyTextInk = (
  previous: IncrementalTextRecognitionState | null,
  current: Stroke[],
) => Boolean(
  previous &&
  current.length >= previous.strokes.length &&
  previous.strokes.every((stroke, index) => sameStrokeTrajectory(stroke, current[index])),
)

/**
 * A prefix belongs only to a loose continuation of the same physical line.
 * This is deliberately broader than the one-new-body heuristic (multi-stroke
 * letters are allowed) but rejects a new line, left-side rewrite, or unrelated
 * canvas region.
 */
export const hasLooseTextContinuation = (
  previous: IncrementalTextRecognitionState | null,
  current: Stroke[],
) => {
  if (!isAppendOnlyTextInk(previous, current) || !previous) return false
  if (current.length === previous.strokes.length) return true
  const before = strokeExtent(previous.strokes)
  const added = strokeExtent(current.slice(previous.strokes.length))
  if (!before || !added) return false
  const lineHeight = Math.max(0.012, heightOf(before))
  const overlapsLine = added.maxY >= before.minY - lineHeight * 0.65 &&
    added.minY <= before.maxY + lineHeight * 0.65
  const addedCenterX = (added.minX + added.maxX) / 2
  const remainsAtWritingEdge = (
    added.maxX >= before.maxX - lineHeight * 0.72 &&
    addedCenterX >= before.maxX - lineHeight
  )
  return overlapsLine && remainsAtWritingEdge
}

export const canCarryUncertainTextState = (
  previous: IncrementalTextRecognitionState | null,
  current: Stroke[],
) => Boolean(
  previous &&
  (previous.uncertainCarryCount ?? 0) < 1 &&
  hasLooseTextContinuation(previous, current),
)

const commonTextPrefixLength = (first: string[], second: string[]) => {
  const limit = Math.min(first.length, second.length)
  let length = 0
  while (length < limit && first[length] === second[length]) length += 1
  return length
}

/**
 * Advances a stable prefix only after append geometry and two consecutive
 * recognition snapshots agree. Merely removing the newest character from a
 * first preview is unsafe: one connected stroke may already have been guessed
 * as several letters. Explicit user corrections may still store the complete
 * corrected text directly in the state.
 */
export const advanceStableTextPrefix = (
  previous: IncrementalTextRecognitionState | null,
  currentText: string,
  beginsNewGlyph: boolean,
) => {
  const current = Array.from(currentText.normalize('NFC'))
  if (
    !previous ||
    !current.length ||
    current.length > 24 ||
    !/^\p{L}{1,24}$/u.test(current.join(''))
  ) return ''

  const previousText = Array.from(previous.text.normalize('NFC'))
  const previousStable = Array.from(previous.prefixText.normalize('NFC'))
  const confirmedLength = Math.max(
    0,
    Math.min(previous.confirmedPrefixLength ?? 0, previousStable.length),
  )
  const confirmed = previousStable.slice(0, confirmedLength)
  const currentPreservesConfirmation = confirmed.every((character, index) => current[index] === character)
  // Automatic recognition may be temporarily wrong, but it may never erase
  // a user-confirmed correction. A rewritten/non-append canvas is filtered by
  // isAppendOnlyTextInk before this function is called.
  if (!currentPreservesConfirmation) return confirmed.join('')

  const retainedLength = commonTextPrefixLength(previousStable, current)
  if (!beginsNewGlyph) {
    return current.slice(0, Math.max(confirmedLength, retainedLength)).join('')
  }

  // Promotion may consume only characters that existed in the preceding
  // preview and still agree now. The newest current character stays
  // provisional unless it came from an explicit correction.
  const observedTwice = commonTextPrefixLength(previousText, current)
  const promotableLength = Math.min(observedTwice, Math.max(0, current.length - 1))
  return current.slice(0, Math.max(confirmedLength, retainedLength, promotableLength)).join('')
}

/**
 * Records only the contiguous leading range that was genuinely corrected.
 * Correcting character three cannot implicitly confirm characters one and
 * two; correcting the next unconfirmed character extends the range by one.
 */
export const textPrefixAfterTokenCorrection = (
  previous: IncrementalTextRecognitionState | null,
  currentText: string,
  correctedCharacterIndex: number,
) => {
  const characters = Array.from(currentText.normalize('NFC'))
  const previousStable = previous
    ? Array.from(previous.prefixText.normalize('NFC'))
    : []
  const previousStableLength = previousStable.length
  const previousConfirmedLength = previous
    ? Math.max(0, Math.min(previous.confirmedPrefixLength ?? 0, previousStableLength))
    : 0
  const confirmed = previousStable.slice(0, previousConfirmedLength)
  if (
    correctedCharacterIndex >= 0 &&
    correctedCharacterIndex < previousConfirmedLength &&
    characters[correctedCharacterIndex]
  ) {
    // The user deliberately corrected an already confirmed position.
    confirmed[correctedCharacterIndex] = characters[correctedCharacterIndex]
  } else if (
    correctedCharacterIndex === previousConfirmedLength &&
    characters[correctedCharacterIndex]
  ) {
    confirmed.push(characters[correctedCharacterIndex])
  }
  const confirmedPrefixLength = confirmed.length
  const stableLength = Math.max(previousStableLength, confirmedPrefixLength)
  const automaticSuffix = characters.slice(confirmedPrefixLength, stableLength)
  return {
    prefixText: [...confirmed, ...automaticSuffix].join(''),
    confirmedPrefixLength,
  }
}

/** A projected sentence is safe to display/train only when its actual local
 * token sequence spells the same NFC text, including case and line breaks. */
export const textProjectionMatchesTokens = (projectedText: string, tokenText: string) => (
  projectedText.normalize('NFC') === tokenText.normalize('NFC')
)

/**
 * Advances only the ink snapshot after an uncertain automatic result. The
 * previously stable letters remain unchanged, so another appended body can
 * still use them without promoting the intervening math/unknown guess.
 */
export const carryStableTextPrefixAcrossUncertainInk = (
  previous: IncrementalTextRecognitionState,
  current: Stroke[],
): IncrementalTextRecognitionState => ({
  ...previous,
  strokes: current.slice(),
  pendingStrokeIndex: current.length,
  uncertainCarryCount: (previous.uncertainCarryCount ?? 0) + 1,
})

/**
 * Derives a conservative append hypothesis from append-only pen input.
 *
 * The diagnostic count is intentionally never sent as an exact segmentation
 * constraint: a continuous cursive stroke may contain several letters and a
 * slowly written glyph may contain several bodies. The structural result is
 * used only to carry an older, already stable prefix into a bounded soft
 * comparison; ambiguous geometry remains free to be resegmented.
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
    // The last automatic character can still be an unfinished multi-stroke
    // glyph. Only the older, already conservative prefix is safe to reuse.
    previousText: previous.prefixText,
    pendingStrokeIndex: previous.strokes.length,
  }
}

export const embeddedTextRecognitionHints = (
  incrementalHint: Pick<IncrementalTextCharacterHint, 'previousText'> | undefined,
) => {
  const rawPrefix = incrementalHint?.previousText
  const prefix = rawPrefix && rawPrefix.length <= 320
    ? rawPrefix.normalize('NFC')
    : undefined
  return {
    // Counts from both the incremental geometry and the classical text branch
    // are hypotheses, not independent measurements. A connected pair can be
    // one continuous stroke and a slowly written glyph can contain two body
    // strokes, so neither may constrain downstream segmentation exactly.
    // Only the already stable prefix survives, with explicit prefix semantics
    // in the recognizer; newly guessed ink is never fed back into itself.
    textPrefixHint: prefix
      && prefix.length <= 320
      && !/[ßẞ]/u.test(prefix)
      && /^\p{L}{1,320}$/u.test(prefix)
      ? prefix
      : undefined,
  }
}
