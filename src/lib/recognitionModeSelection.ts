import type { AutomaticRecognitionResult, RecognitionLanguage } from './recognition'

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

export type NeuralTextModeAssessment = {
  shouldUseText: boolean
  letters: number
  digits: number
  visibleCharacters: number
  words: number
  letterRatio: number
  wordLike: boolean
  explicitFormulaSyntax: boolean
  reason: 'personalized' | 'known-word' | 'sentence' | 'letter-sequence' | 'insufficient' | 'formula'
}

export const hasDecisiveMathLayout = (mathValue: string) => (
  /\\(?:frac|sqrt|begin|matrix|cases)\b|[_^]\{|[=≤≥≠≈]/u.test(mathValue)
  || /\\(?:int|iint|iiint|oint|sum|prod|lim)\b[^\n]*[_^]\{/u.test(mathValue)
  || /(?:[\p{L}\d}\)])\s*(?:[+×÷]|\\(?:times|div|cdot|pm)\b)\s*(?:[\p{L}\d\\({])/u.test(mathValue)
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
) => {
  if (!automatic) return true
  if (automatic.evidence?.math.decisiveStructure === true || hasDecisiveMathLayout(automatic.mathValue)) {
    return false
  }
  return (
    automatic.mathScore - automatic.textScore < 2.2 ||
    hasStrongNeuralSentenceEvidence(neural, letters, wordLike) ||
    hasStrongNeuralWordEvidence(neural, letters, wordLike)
  )
}

const explicitFormulaSyntax = (value: string) => (
  /[=+×÷√∫∑Σ∏Π∞^_≤≥≠≈]/u.test(value)
  || /\d\s*[*/]\s*(?:\p{L}|\d)/u.test(value)
  || /(?:^|\s)\p{L}\s*[*/]\s*\p{L}(?:\s|$)/u.test(value)
)

/**
 * One shared arbitration gate is used by FaNotes and embedded GlyphenWerk.
 * It evaluates the complete line result instead of treating every tall glyph
 * as an independent mode vote.  Strong prose may overrule isolated false
 * integral hypotheses; formulas with relations, radicals, fractions, scripts,
 * limits, or balanced operators remain protected by the automatic evidence.
 */
export const assessNeuralTextModeCandidate = (
  text: string,
  language: RecognitionLanguage,
  neural: NeuralTextModeEvidence,
  automatic: AutomaticRecognitionResult | null,
  personalized?: PersonalizedTextModeEvidence,
): NeuralTextModeAssessment => {
  const normalized = text.normalize('NFC').trim()
  const visible = Array.from(normalized).filter((character) => !/\s/u.test(character))
  const letters = visible.filter((character) => /^\p{L}$/u.test(character)).length
  const digits = visible.filter((character) => /^\d$/u.test(character)).length
  const words = normalized.match(language === 'de' ? /[A-Za-zÄÖÜäöü]{2,}/gu : /[A-Za-z]{2,}/gu) ?? []
  const letterRatio = letters / Math.max(1, visible.length)
  const wordLike = letters >= Math.max(2, Math.ceil(visible.length * 0.55))
  const formulaSyntax = explicitFormulaSyntax(normalized)
  const strongPersonalized = personalized
    ? hasStrongPersonalizedTextEvidence(personalized, letters, visible.length, formulaSyntax)
    : false
  const strongKnownWord = hasStrongNeuralWordEvidence(neural, letters, wordLike)
  const strongSentence = hasStrongNeuralSentenceEvidence(neural, letters, wordLike) || (
    neural.confidence >= 38 &&
    words.length >= 2 &&
    letters >= 6 &&
    letterRatio >= 0.68
  )
  const strongLetterSequence = (
    neural.confidence >= 64 &&
    letters >= 4 &&
    letterRatio >= 0.8 &&
    words.length >= 1
  )
  const proseDominatesCandidateFormula = (
    formulaSyntax &&
    strongSentence &&
    words.length >= 3 &&
    letters >= 9 &&
    letters >= digits * 2 &&
    !/[√∫∑Σ∏Π∞^_≤≥≠≈]/u.test(normalized)
  )
  const safeCandidate = !formulaSyntax || proseDominatesCandidateFormula
  const enoughTextEvidence = strongPersonalized || strongKnownWord || strongSentence || strongLetterSequence
  const decisiveAutomaticMath = Boolean(
    automatic && (() => {
      const math = automatic.evidence?.math
      // A bare integral-like glyph has no mathematical context of its own.
      // When the independent text beam sees the same letter, or a complete
      // multi-letter personal sequence contradicts the collapsed operator,
      // explicit GlyphenWerk evidence wins. Limits, relations, fractions,
      // scripts, operands and real formulas remain decisive.
      const bareLargeOperatorConflict = Boolean(
        strongPersonalized
        && math
        && math.visibleCharacters <= 2
        && math.largeOperators >= 1
        && math.digits === 0
        && math.operators === 0
        && math.relations === 0
        && math.fractions === 0
        && math.layoutAssignments === 0
        && !/[_^]\{/u.test(automatic.mathValue)
        && (
          letters >= 2
          || automatic.textValue.normalize('NFC').replace(/\s+/gu, '') === normalized.replace(/\s+/gu, '')
        )
      )
      return !bareLargeOperatorConflict && (
        math?.decisiveStructure === true || hasDecisiveMathLayout(automatic.mathValue)
      )
    })(),
  )
  const mayOverride = neuralTextMayOverrideAutomaticMode(neural, automatic, letters, wordLike)
  const shouldUseText = safeCandidate && enoughTextEvidence && !decisiveAutomaticMath && (
    automatic?.mode === 'text' || mayOverride || strongPersonalized
  )
  const reason: NeuralTextModeAssessment['reason'] = !safeCandidate
    ? 'formula'
    : strongPersonalized
      ? 'personalized'
      : strongSentence
        ? 'sentence'
        : strongKnownWord
          ? 'known-word'
          : strongLetterSequence
            ? 'letter-sequence'
            : 'insufficient'
  return {
    shouldUseText,
    letters,
    digits,
    visibleCharacters: visible.length,
    words: words.length,
    letterRatio,
    wordLike,
    explicitFormulaSyntax: formulaSyntax,
    reason,
  }
}
