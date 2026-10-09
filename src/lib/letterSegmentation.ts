/**
 * Letter spans for GlyphenWerk and FaNotes.
 *
 * Pointer-up keeps the ink strokes. The recognizer then:
 * 1. groups writing lines (`groupRecognitionLines`);
 * 2. clusters touching strokes into glyphs (`segmentStrokes`);
 * 3. proposes connected cuts (`connectedTextSegmentationHypotheses`:
 *    density valleys, pen lifts, uniform slices);
 * 4. matches each part to personal GlyphenWerk samples and the offline
 *    standard prototypes (`recognizeExpression`);
 * 5. optionally reads the whole line with TrOCR / the personal raster model;
 * 6. rescores de/en word candidates (`applyTextReranking`).
 *
 * The stage that dropped or merged letters was step 5's index slice. A line
 * string was expanded with `normalizeGermanSharpS` (ß → ss) and then written
 * onto glyph tokens by character index, or the segmentation was forced to
 * that character count. A shorter string deleted letters; a longer one
 * invented cuts; ß became two letters.
 *
 * This module replaces that slice. Cuts stay the geometric spans. A line
 * character may label a span only when that span already supports it. A
 * length mismatch is not forced. A single glyph with no personal sample and
 * no clear base-model margin stays `undecidable` instead of receiving a
 * guessed letter. Connected ink can remain one stroke object; each emitted
 * span still carries its own box.
 */
import { preservedReadingCharacters } from './orthography'
import {
  recognizeExpression,
  type RecognitionLanguage,
  type RecognitionModel,
  type RecognitionToken,
} from './recognition'
import type { LabelDefinition, Stroke } from '../types'

export type LetterSpanStatus = 'labeled' | 'undecidable'

export type LetterSpan = {
  id: string
  char: string
  labelId: string
  name: string
  confidence: number
  cutConfidence: number
  status: LetterSpanStatus
  bbox: [number, number, number, number]
  lineBreakBefore: boolean
  spaceBefore: boolean
}

const clampScore = (value: number) => Math.max(0, Math.min(100, Math.round(value)))

const rivalMargin = (token: RecognitionToken) => {
  const rival = token.alternatives.find((alternative) => alternative.labelId !== token.labelId && alternative.char !== token.char)
  return token.confidence - (rival?.confidence ?? 0)
}

const sameCharacter = (left: string, right: string) => left.normalize('NFC') === right.normalize('NFC')

/** A line character is admissible only when this span already lists it. */
export const spanSupportsCharacter = (token: RecognitionToken, character: string) => {
  if (sameCharacter(token.char, character)) return true
  return token.alternatives.some((alternative) => (
    sameCharacter(alternative.char, character) &&
    (
      (alternative.personalSupport ?? 0) > 0 ||
      alternative.confidence >= Math.max(22, token.confidence - 18)
    )
  ))
}

/**
 * Isolated glyphs abstain when neither a GlyphenWerk sample nor a clear
 * base-model margin supports a letter. A multi-letter line keeps the
 * geometric labels so a connected reading is not silently deleted.
 */
export const decideLetterSpans = (tokens: RecognitionToken[]): RecognitionToken[] => {
  const visible = tokens.filter((token) => !token.isLayout)
  return tokens.map((token) => {
    if (token.isLayout) return token
    const personal = token.personalSupport ?? 0
    const margin = rivalMargin(token)
    const punctuation = /^[\p{P}\p{S}]$/u.test(token.char)
    const personalLetter = personal > 0 && token.confidence >= 24
    const clearBaseLetter = personal === 0
      && margin >= (punctuation ? 28 : 18)
      && token.confidence >= (punctuation ? 84 : 55)
    const keepLineLetter = visible.length >= 2 && token.char.length > 0
    if (personalLetter || clearBaseLetter || keepLineLetter) {
      return {
        ...token,
        letterStatus: 'labeled' as const,
        cutConfidence: clampScore(personalLetter ? Math.max(margin, 48) : Math.max(margin, 8)),
      }
    }
    return {
      ...token,
      letterStatus: 'undecidable' as const,
      labelId: '',
      cutConfidence: clampScore(Math.min(44, Math.max(0, margin))),
    }
  })
}

/**
 * Replaces index-slicing a line string onto tokens. Equal lengths may confirm
 * a character the span already supports. Any other length keeps the geometric
 * spans and does not drop, merge, or invent letters to fit the string.
 */
export const reconcileLetterReading = (
  geometric: RecognitionToken[],
  hinted: RecognitionToken[],
  lineText?: string,
): RecognitionToken[] => {
  const geometricVisible = geometric.filter((token) => !token.isLayout)
  const hintedVisible = hinted.filter((token) => !token.isLayout)
  const reading = lineText === undefined ? null : preservedReadingCharacters(lineText)
  const sameLength = geometricVisible.length === hintedVisible.length
    && (reading === null || reading.length === geometricVisible.length)
  if (!sameLength) return decideLetterSpans(geometric)

  let visibleIndex = 0
  const confirmed = geometric.map((token) => {
    if (token.isLayout) return token
    const expected = reading ? reading[visibleIndex] : hintedVisible[visibleIndex]?.char
    visibleIndex += 1
    if (!expected || !spanSupportsCharacter(token, expected) || sameCharacter(token.char, expected)) {
      return token
    }
    const alternative = token.alternatives.find((entry) => sameCharacter(entry.char, expected))
    return {
      ...token,
      char: expected,
      labelId: alternative?.labelId || token.labelId,
      name: alternative?.name || expected,
      confidence: Math.max(token.confidence, alternative?.confidence ?? 0),
      personalSupport: alternative?.personalSupport ?? token.personalSupport,
      personalConfidence: alternative?.personalConfidence ?? token.personalConfidence,
      baseConfidence: alternative?.baseConfidence ?? token.baseConfidence,
    }
  })
  return decideLetterSpans(confirmed)
}

export const letterSpansFromTokens = (tokens: RecognitionToken[]): LetterSpan[] => (
  tokens.filter((token) => !token.isLayout).map((token) => ({
    id: token.id,
    char: token.letterStatus === 'undecidable' ? '' : token.char,
    labelId: token.labelId,
    name: token.letterStatus === 'undecidable' ? 'nicht entscheidbar' : token.name,
    confidence: token.confidence,
    cutConfidence: token.cutConfidence ?? 0,
    status: token.letterStatus ?? 'labeled',
    bbox: token.bbox,
    lineBreakBefore: Boolean(token.lineBreakBefore),
    spaceBefore: Boolean(token.spaceBefore),
  }))
)

/** Geometric letter spans for one stroke list. Optional line text cannot resize them. */
export const segmentHandwritingLetters = (
  strokes: Stroke[],
  model: RecognitionModel,
  labels: LabelDefinition[],
  language: RecognitionLanguage = 'de',
  lineText?: string,
) => {
  const geometric = recognizeExpression(strokes, model, labels, 'text', [], language)
  const tokens = reconcileLetterReading(geometric, geometric, lineText)
  return {
    tokens,
    letters: letterSpansFromTokens(tokens),
  }
}
