import type { AutomaticRecognitionResult } from './recognition'

export type NeuralTextModeEvidence = {
  confidence: number
  wordCount?: number
  knownWordRatio?: number
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
