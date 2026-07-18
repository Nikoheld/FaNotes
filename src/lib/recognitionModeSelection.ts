import type { AutomaticRecognitionResult } from './recognition'

export type NeuralTextModeEvidence = {
  confidence: number
  wordCount?: number
  knownWordRatio?: number
}

export type PersonalizedTextModeEvidence = {
  confidence: number
  source?: 'personalized' | 'neural' | 'classical' | 'hybrid'
  personalizedCharacters?: number
}

export const hasDecisiveMathLayout = (mathValue: string) => (
  /\\(?:frac|sqrt)\b|[=≤≥]/u.test(mathValue)
  || (/\d/u.test(mathValue) && /[+×÷]/u.test(mathValue))
)

export const hasStrongNeuralWordEvidence = (
  neural: NeuralTextModeEvidence,
  letters: number,
  wordLike: boolean,
) => (
  neural.confidence >= 50
  && (neural.wordCount ?? 0) >= 1
  && (neural.knownWordRatio ?? 0) >= 0.7
  && letters >= 3
  && wordLike
)

export const hasStrongNeuralSentenceEvidence = (
  neural: NeuralTextModeEvidence,
  letters: number,
  wordLike: boolean,
) => (
  neural.confidence >= 76
  && (neural.wordCount ?? 0) >= 2
  && (neural.knownWordRatio ?? 0) >= 0.45
  && letters >= 6
  && wordLike
)

/**
 * A personal glyph decision is independent evidence, not another spelling
 * guess from the line model. In particular, a line model that initially calls
 * a trained `T` an integral must not be allowed to veto the corrected result
 * merely by reporting zero known words. Requiring every short result (and at
 * least half of a longer result) to be backed by personal glyphs keeps actual
 * formulas out of text mode while making explicit user training visible.
 */
export const hasStrongPersonalizedTextEvidence = (
  evidence: PersonalizedTextModeEvidence,
  letters: number,
  visibleCharacters: number,
  explicitMath: boolean,
) => {
  const personalizedCharacters = Math.max(0, evidence.personalizedCharacters ?? 0)
  const requiredCharacters = letters <= 2 ? letters : Math.ceil(letters * 0.5)
  return (
    !explicitMath
    && letters >= 1
    && letters === visibleCharacters
    && evidence.confidence >= 24
    && (evidence.source === 'personalized' || evidence.source === 'hybrid')
    && personalizedCharacters >= requiredCharacters
  )
}

/**
 * A normal sentence used to be trapped in math mode when isolated tall
 * letters were geometrically mistaken for integrals. Complete line evidence
 * may correct that decision, but actual equations, fractions and radicals
 * remain protected.
 */
export const neuralTextMayOverrideAutomaticMode = (
  neural: NeuralTextModeEvidence,
  automatic: AutomaticRecognitionResult | null,
  letters: number,
  wordLike: boolean,
) => (
  !automatic
  || automatic.mathScore - automatic.textScore < 2.2
  || (
    (
      hasStrongNeuralSentenceEvidence(neural, letters, wordLike)
      || hasStrongNeuralWordEvidence(neural, letters, wordLike)
    )
    && !hasDecisiveMathLayout(automatic.mathValue)
  )
)
