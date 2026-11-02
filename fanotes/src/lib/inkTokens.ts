import type { RecognitionToken } from '../../../src/lib/recognition'
import type { InkRecognitionResult } from './inkRecognition'

const INK_LABEL_PREFIX = 'ink:'

export const isInkLabelId = (labelId: string) => labelId.startsWith(INK_LABEL_PREFIX)
export const inkLabelChar = (labelId: string) => labelId.slice(INK_LABEL_PREFIX.length)
export const isInkToken = (token: RecognitionToken) => token.id.startsWith('ink-')

/**
 * Character tokens of an ink reading for the conversion panel: each visible character with its
 * confidence and the model's visual alternatives. Spaces become `spaceBefore` and line starts
 * `lineBreakBefore`, so `recognizedSentence` rebuilds the same text.
 */
export const inkRecognitionTokens = (result: InkRecognitionResult): RecognitionToken[] => {
  const tokens: RecognitionToken[] = []
  result.lines.forEach((line, lineIndex) => {
    let pendingSpace = false
    let lineStart = true
    line.characters.forEach((character, index) => {
      if (character.char === ' ') {
        pendingSpace = true
        return
      }
      const choices = [
        { char: character.char, confidence: character.confidence },
        ...character.alternatives.filter((alternative) => alternative.char !== character.char && alternative.char !== ' '),
      ].slice(0, 4)
      tokens.push({
        id: `ink-${lineIndex}-${index}`,
        strokes: [],
        imageData: '',
        bbox: character.bbox ?? line.bbox,
        labelId: `${INK_LABEL_PREFIX}${character.char}`,
        char: character.char,
        name: character.char,
        latex: character.char,
        confidence: character.confidence,
        alternatives: choices.map((choice) => ({
          labelId: `${INK_LABEL_PREFIX}${choice.char}`,
          char: choice.char,
          name: choice.char,
          confidence: choice.confidence,
        })),
        spaceBefore: pendingSpace && !lineStart,
        lineBreakBefore: lineStart && lineIndex > 0,
      })
      pendingSpace = false
      lineStart = false
    })
  })
  return tokens
}

/** Replaces the character of one ink token; returns `null` when `labelId` is not an ink label. */
export const correctInkToken = (token: RecognitionToken, labelId: string): RecognitionToken | null => {
  if (!isInkLabelId(labelId)) return null
  const char = inkLabelChar(labelId)
  if (!char) return null
  return {
    ...token,
    labelId,
    char,
    name: char,
    latex: char,
    confidence: token.alternatives.find((alternative) => alternative.labelId === labelId)?.confidence ?? token.confidence,
    context: undefined,
  }
}
