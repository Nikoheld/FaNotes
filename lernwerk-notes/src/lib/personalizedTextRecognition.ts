import { ENGLISH_COMMON_WORDS } from '../../../src/data/englishLanguage'
import { GERMAN_COMMON_WORDS } from '../../../src/data/germanLanguage'
import {
  recognizedSentence,
  type RecognitionLanguage,
  type RecognitionToken,
} from '../../../src/lib/recognition'
import type { NeuralTextCharacter, NeuralTextRecognitionResult } from './neuralTextRecognition'
import {
  applyFinalNeuralWordContext,
  applyMeasuredNeuralWordContext,
  applyNeuralWordContext,
  isExtendedNeuralContextWord,
  nearestNeuralWordContextCandidates,
  preserveWordCase,
  wordDistance,
} from './neuralWordContext'
import { normalizeGermanSharpS } from '../../../src/lib/orthography'

type CharacterEvidence = {
  char: string
  confidence: number
  personalSupport: number
  personalConfidence: number
}

type AlignmentStep = {
  tokenIndex: number | null
  neuralIndex: number | null
}

export type PersonalizedTextRecognitionResult = {
  text: string
  confidence: number
  source: 'personalized' | 'neural' | 'classical' | 'hybrid'
  personalizedCharacters: number
  neuralCharacters: number
  classicalCharacters: number
  /** Edits against the line model that lack a matching strong personal glyph. */
  unsupportedChanges?: number
}

type CharacterSource = 'personalized' | 'neural' | 'classical'

type FusedCharacter = {
  char: string
  confidence: number
  source: CharacterSource
  neuralSpace: boolean
  tokenSpace: boolean
}

const clamp = (value: number, min = 0, max = 1) => Math.max(min, Math.min(max, value))
const median = (values: number[]) => {
  if (!values.length) return 0
  const sorted = [...values].sort((first, second) => first - second)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2
}

const lexicons = {
  de: GERMAN_COMMON_WORDS,
  en: ENGLISH_COMMON_WORDS,
}
const GERMAN_SPECIAL_LETTERS = new Set(Array.from('ÄÖÜäöü'))

const tokenCandidates = (token: RecognitionToken): CharacterEvidence[] => {
  const candidates = [{
    char: token.char,
    confidence: token.confidence,
    personalSupport: token.personalSupport ?? 0,
    personalConfidence: token.personalConfidence ?? 0,
  }, ...token.alternatives.map((alternative) => ({
    char: alternative.char,
    confidence: alternative.confidence,
    personalSupport: alternative.personalSupport ?? 0,
    personalConfidence: alternative.personalConfidence ?? 0,
  }))]
  const merged = new Map<string, CharacterEvidence>()
  candidates.forEach((candidate) => {
    const previous = merged.get(candidate.char)
    merged.set(candidate.char, previous ? {
      char: candidate.char,
      confidence: Math.max(previous.confidence, candidate.confidence),
      personalSupport: Math.max(previous.personalSupport, candidate.personalSupport),
      personalConfidence: Math.max(previous.personalConfidence, candidate.personalConfidence),
    } : candidate)
  })
  return [...merged.values()]
}

const strongestPersonalCandidate = (token: RecognitionToken) => tokenCandidates(token)
  .filter((candidate) => candidate.personalSupport > 0)
  .sort((first, second) => (
    second.personalConfidence + Math.min(24, Math.log2(second.personalSupport + 1) * 7) -
    first.personalConfidence - Math.min(24, Math.log2(first.personalSupport + 1) * 7)
  ))[0] ?? null

const normalizedLineCharacters = (
  lineText: string,
  rawCharacters: NeuralTextCharacter[],
) => {
  const visible: { char: string; spaceBefore: boolean }[] = []
  let pendingSpace = false
  Array.from(lineText).forEach((char) => {
    if (/\s/u.test(char)) {
      pendingSpace = visible.length > 0
      return
    }
    visible.push({ char, spaceBefore: pendingSpace })
    pendingSpace = false
  })
  if (
    visible.length === rawCharacters.length &&
    visible.every((entry, index) => entry.char === rawCharacters[index].char)
  ) return rawCharacters.map((entry, index) => ({
    ...entry,
    spaceBefore: visible[index].spaceBefore,
  }))
  return visible.map((entry, index) => ({
    char: entry.char,
    confidence: rawCharacters[index]?.confidence ?? 0,
    start: index / Math.max(1, visible.length),
    end: (index + 1) / Math.max(1, visible.length),
    spaceBefore: entry.spaceBefore,
  }))
}

const alignCharacters = (
  tokens: RecognitionToken[],
  neural: NeuralTextCharacter[],
) => {
  const rows = tokens.length + 1
  const columns = neural.length + 1
  const scores = Array.from({ length: rows }, () => new Float64Array(columns))
  const choices = Array.from({ length: rows }, () => new Uint8Array(columns))
  for (let tokenIndex = 1; tokenIndex < rows; tokenIndex += 1) {
    const personal = strongestPersonalCandidate(tokens[tokenIndex - 1])
    const strength = personal
      ? personal.personalConfidence / 100 + Math.min(0.32, Math.log2(personal.personalSupport + 1) * 0.08)
      : tokens[tokenIndex - 1].confidence / 240
    scores[tokenIndex][0] = scores[tokenIndex - 1][0] + 0.62 + strength * 0.38
    choices[tokenIndex][0] = 1
  }
  for (let neuralIndex = 1; neuralIndex < columns; neuralIndex += 1) {
    scores[0][neuralIndex] = scores[0][neuralIndex - 1] + 0.62 + neural[neuralIndex - 1].confidence / 250
    choices[0][neuralIndex] = 2
  }

  for (let tokenIndex = 1; tokenIndex < rows; tokenIndex += 1) {
    const token = tokens[tokenIndex - 1]
    const tokenCenter = token.bbox[0] + token.bbox[2] / 2
    const personal = strongestPersonalCandidate(token)
    for (let neuralIndex = 1; neuralIndex < columns; neuralIndex += 1) {
      const character = neural[neuralIndex - 1]
      const neuralCenter = (character.start + character.end) / 2
      const tokenPosition = tokens.length <= 1
        ? 0.5
        : (tokenCenter - tokens[0].bbox[0]) /
          Math.max(0.0001, tokens.at(-1)!.bbox[0] + tokens.at(-1)!.bbox[2] - tokens[0].bbox[0])
      const hasCandidate = tokenCandidates(token).some((candidate) => candidate.char === character.char)
      const personalMatch = personal?.char === character.char
      const substitution = (
        token.char === character.char ? 0 :
          hasCandidate ? 0.28 :
            0.78
      ) + Math.min(0.32, Math.abs(tokenPosition - neuralCenter) * 0.46) -
        (personalMatch ? Math.min(0.22, personal!.personalSupport * 0.025) : 0)
      const diagonal = scores[tokenIndex - 1][neuralIndex - 1] + Math.max(0, substitution)
      const deletion = scores[tokenIndex - 1][neuralIndex] + 0.62 + (
        personal ? personal.personalConfidence / 180 + Math.min(0.22, personal.personalSupport * 0.018) : 0
      )
      const insertion = scores[tokenIndex][neuralIndex - 1] + 0.62 + character.confidence / 220
      if (diagonal <= deletion && diagonal <= insertion) {
        scores[tokenIndex][neuralIndex] = diagonal
        choices[tokenIndex][neuralIndex] = 0
      } else if (deletion <= insertion) {
        scores[tokenIndex][neuralIndex] = deletion
        choices[tokenIndex][neuralIndex] = 1
      } else {
        scores[tokenIndex][neuralIndex] = insertion
        choices[tokenIndex][neuralIndex] = 2
      }
    }
  }

  const steps: AlignmentStep[] = []
  let tokenIndex = tokens.length
  let neuralIndex = neural.length
  while (tokenIndex > 0 || neuralIndex > 0) {
    const choice = choices[tokenIndex][neuralIndex]
    if (tokenIndex > 0 && neuralIndex > 0 && choice === 0) {
      steps.push({ tokenIndex: tokenIndex - 1, neuralIndex: neuralIndex - 1 })
      tokenIndex -= 1
      neuralIndex -= 1
    } else if (tokenIndex > 0 && (neuralIndex === 0 || choice === 1)) {
      steps.push({ tokenIndex: tokenIndex - 1, neuralIndex: null })
      tokenIndex -= 1
    } else {
      steps.push({ tokenIndex: null, neuralIndex: neuralIndex - 1 })
      neuralIndex -= 1
    }
  }
  return steps.reverse()
}

type TokenWordAlignment = {
  score: number
  tokenByCharacter: Map<number, number>
}

const normalizedCharacter = (character: string, language: RecognitionLanguage) => (
  character.toLocaleLowerCase(language === 'de' ? 'de-CH' : 'en-US')
)

const candidateEvidence = (
  token: RecognitionToken,
  character: string,
  language: RecognitionLanguage,
) => tokenCandidates(token).find((candidate) => (
  normalizedCharacter(candidate.char, language) === normalizedCharacter(character, language)
)) ?? null

/** Aligns a dictionary word against the actual geometric token sequence.
 * Insertions are allowed because connected handwriting can merge two letters
 * into one segment, but a candidate only gains a strong score from a visual
 * or genuinely personal alternative carried by that segment. */
const alignWordToTokens = (
  word: string,
  tokens: RecognitionToken[],
  language: RecognitionLanguage,
): TokenWordAlignment => {
  const characters = Array.from(word)
  const rows = tokens.length + 1
  const columns = characters.length + 1
  const scores = Array.from({ length: rows }, () => new Float64Array(columns))
  const choices = Array.from({ length: rows }, () => new Uint8Array(columns))
  for (let tokenIndex = 1; tokenIndex < rows; tokenIndex += 1) {
    scores[tokenIndex][0] = scores[tokenIndex - 1][0] - 0.62
    choices[tokenIndex][0] = 1
  }
  for (let characterIndex = 1; characterIndex < columns; characterIndex += 1) {
    scores[0][characterIndex] = scores[0][characterIndex - 1] - 0.68
    choices[0][characterIndex] = 2
  }
  for (let tokenIndex = 1; tokenIndex < rows; tokenIndex += 1) {
    const token = tokens[tokenIndex - 1]
    const visualCharacter = token.visualLabelId && token.visualLabelId !== token.labelId
      ? token.alternatives.find((alternative) => alternative.labelId === token.visualLabelId)?.char ?? token.char
      : token.char
    for (let characterIndex = 1; characterIndex < columns; characterIndex += 1) {
      const character = characters[characterIndex - 1]
      const evidence = candidateEvidence(token, character, language)
      const exact = normalizedCharacter(visualCharacter, language) === normalizedCharacter(character, language)
      const match = evidence
        ? evidence.confidence / 100 * 0.78
          + evidence.personalConfidence / 100 * 0.84
          + Math.min(0.24, Math.log2(evidence.personalSupport + 1) * 0.07)
          + (exact ? 0.14 : 0)
        : -0.92
      const diagonal = scores[tokenIndex - 1][characterIndex - 1] + match
      const deleteToken = scores[tokenIndex - 1][characterIndex] - 0.62
      const insertCharacter = scores[tokenIndex][characterIndex - 1] - 0.68
      if (diagonal >= deleteToken && diagonal >= insertCharacter) {
        scores[tokenIndex][characterIndex] = diagonal
        choices[tokenIndex][characterIndex] = 0
      } else if (deleteToken >= insertCharacter) {
        scores[tokenIndex][characterIndex] = deleteToken
        choices[tokenIndex][characterIndex] = 1
      } else {
        scores[tokenIndex][characterIndex] = insertCharacter
        choices[tokenIndex][characterIndex] = 2
      }
    }
  }
  const tokenByCharacter = new Map<number, number>()
  let tokenIndex = tokens.length
  let characterIndex = characters.length
  while (tokenIndex > 0 || characterIndex > 0) {
    const choice = choices[tokenIndex][characterIndex]
    if (tokenIndex > 0 && characterIndex > 0 && choice === 0) {
      tokenByCharacter.set(characterIndex - 1, tokenIndex - 1)
      tokenIndex -= 1
      characterIndex -= 1
    } else if (tokenIndex > 0 && (characterIndex === 0 || choice === 1)) tokenIndex -= 1
    else characterIndex -= 1
  }
  return { score: scores[tokens.length][characters.length], tokenByCharacter }
}

const evidenceStrength = (evidence: CharacterEvidence | null) => evidence
  ? evidence.personalConfidence + evidence.confidence * 0.35
    + Math.min(12, Math.log2(evidence.personalSupport + 1) * 3)
  : 0

const personalizedDictionaryWord = (
  source: string,
  tokens: RecognitionToken[],
  language: RecognitionLanguage,
  allowLongPersonalRepair = false,
  neuralContext = '',
  includeDiagnostics = false,
) => {
  const locale = language === 'de' ? 'de-CH' : 'en-US'
  const lower = source.toLocaleLowerCase(locale)
  if (lower.length < 3 || lower.length > 24 || !/^\p{L}+$/u.test(lower) || !tokens.length) {
    return { text: source, changes: 0 }
  }
  const maximumDistance = allowLongPersonalRepair && lower.length >= 8
    ? 3
    : allowLongPersonalRepair && lower.length >= 5
      ? 2
    : lower.length >= 6 ? 2 : 1
  const normalNeighbours = nearestNeuralWordContextCandidates(lower, language, maximumDistance, true)
  // Four substitutions are far too broad for the exhaustive dictionary. The
  // only exception is a long word from the small common-language lexicon that
  // preserves most token positions and is the sole such candidate. This lets
  // sparse one-shot training recover a word such as "buchstabe" without
  // turning arbitrary names into whichever dictionary entry happens to be
  // closest.
  const longCommonNeighbours = allowLongPersonalRepair && lower.length >= 7
    ? [...lexicons[language]]
      .filter((candidate) => Array.from(candidate).length === Array.from(lower).length)
      .map((candidate) => ({ candidate, distance: wordDistance(lower, candidate) }))
      .filter((entry) => entry.distance >= 3 && entry.distance <= 4)
    : []
  const neighbours = [...normalNeighbours]
  longCommonNeighbours.forEach((entry) => {
    if (!neighbours.some((candidate) => candidate.candidate === entry.candidate)) neighbours.push(entry)
  })
  const sourceIsKnown = lexicons[language].has(lower) || neighbours.some((entry) => entry.distance === 0)
  const substitutions = neighbours.filter((entry) => (
    entry.distance >= 1 && entry.distance <= 4
  ))
  if (!substitutions.length) return { text: source, changes: 0 }
  const sourceAlignment = alignWordToTokens(lower, tokens, language)
  const compactNeuralContext = normalizeGermanSharpS(neuralContext)
    .replace(/\s+/gu, '')
    .toLocaleLowerCase(locale)
  const hasUsableNeuralContext = /^\p{L}{3,24}$/u.test(compactNeuralContext)
  const sourceContextDistance = hasUsableNeuralContext
    ? wordDistance(compactNeuralContext, lower)
    : 0
  const sourceSelectionScore = sourceAlignment.score - sourceContextDistance * 0.08
  const longCommonJointDistances = longCommonNeighbours
    .map((entry) => ({
      candidate: entry.candidate,
      distance: entry.distance + (hasUsableNeuralContext
        ? wordDistance(compactNeuralContext, entry.candidate)
        : 0),
    }))
    .sort((first, second) => first.distance - second.distance)
  const evaluated = substitutions.map(({ candidate, distance }) => {
    const alignment = alignWordToTokens(candidate, tokens, language)
    const candidateCharacters = Array.from(candidate)
    const sourceCharacters = Array.from(lower)
    const exactPositionMatches = candidateCharacters.filter((character, index) => (
      character === sourceCharacters[index]
    )).length
    const visuallyAvailablePositions = candidateCharacters.filter((character, index) => {
      if (character === sourceCharacters[index]) return true
      const alignedTokenIndex = alignment.tokenByCharacter.get(index)
      if (alignedTokenIndex === undefined) return false
      return Boolean(candidateEvidence(tokens[alignedTokenIndex], character, language)?.personalSupport)
    }).length
    let supportedChanges = 0
    let visuallyPlausibleChanges = 0
    let contextuallyPlausibleChanges = 0
    const contextDistance = hasUsableNeuralContext
      ? wordDistance(compactNeuralContext, candidate)
      : 0
    candidateCharacters.forEach((character, index) => {
      if (character === sourceCharacters[index]) return
      const alignedTokenIndex = alignment.tokenByCharacter.get(index)
      if (alignedTokenIndex === undefined) return
      const token = tokens[alignedTokenIndex]
      const replacement = candidateEvidence(token, character, language)
      const original = candidateEvidence(token, sourceCharacters[index], language)
      if (
        replacement &&
        (replacement.confidence >= 22 || replacement.personalConfidence >= 3) &&
        evidenceStrength(replacement) >= evidenceStrength(original) - 8
      ) visuallyPlausibleChanges += 1
      if (
        replacement?.personalSupport &&
        evidenceStrength(replacement) >= evidenceStrength(original) + 2
      ) supportedChanges += 1
      if (
        replacement &&
        lexicons[language].has(candidate) &&
        contextDistance < sourceContextDistance &&
        replacement.confidence >= 44 &&
        replacement.confidence >= (original?.confidence ?? token.confidence) - 12
      ) contextuallyPlausibleChanges += 1
    })
    const safeUniqueLongCommonRepair = (
      !sourceIsKnown &&
      distance === 4 &&
      lower.length >= 9 &&
      longCommonNeighbours.length === 1 &&
      lexicons[language].has(candidate) &&
      exactPositionMatches >= Math.ceil(candidateCharacters.length * 0.55)
    )
    const safeJointLongCommonRepair = (
      !sourceIsKnown &&
      distance >= 3 &&
      hasUsableNeuralContext &&
      !normalNeighbours.some((entry) => (
        entry.distance < distance && lexicons[language].has(entry.candidate)
      )) &&
      longCommonJointDistances[0]?.candidate === candidate &&
      (
        !longCommonJointDistances[1] ||
        longCommonJointDistances[1].distance >= longCommonJointDistances[0].distance + 1
      ) &&
      visuallyAvailablePositions >= Math.ceil(candidateCharacters.length * 0.55)
    )
    const safeLongCommonRepair = safeUniqueLongCommonRepair || safeJointLongCommonRepair
    return {
      candidate,
      distance,
      alignment,
      supportedChanges,
      visuallyPlausibleChanges,
      contextuallyPlausibleChanges,
      safeLongCommonRepair,
      safeUniqueLongCommonRepair,
      safeJointLongCommonRepair,
      exactPositionMatches,
      visuallyAvailablePositions,
      contextDistance,
      selectionScore: alignment.score - contextDistance * 0.08,
    }
  })
  const ranked = evaluated.filter((entry) => sourceIsKnown
    ? entry.supportedChanges > 0
    : entry.safeLongCommonRepair ||
      entry.visuallyPlausibleChanges >= Math.ceil(entry.distance / 2) ||
      entry.contextuallyPlausibleChanges >= Math.ceil(entry.distance / 2))
    .sort((first, second) => (
      Number(second.safeLongCommonRepair) - Number(first.safeLongCommonRepair) ||
      second.selectionScore - first.selectionScore
    ))
  const best = ranked[0]
  const diagnostics = includeDiagnostics ? {
    sourceAlignmentScore: sourceAlignment.score,
    sourceSelectionScore,
    longCommonJointDistances,
    candidates: evaluated.map((entry) => ({
      candidate: entry.candidate,
      distance: entry.distance,
      alignmentScore: entry.alignment.score,
      contextDistance: entry.contextDistance,
      selectionScore: entry.selectionScore,
      supportedChanges: entry.supportedChanges,
      visuallyPlausibleChanges: entry.visuallyPlausibleChanges,
      contextuallyPlausibleChanges: entry.contextuallyPlausibleChanges,
      exactPositionMatches: entry.exactPositionMatches,
      visuallyAvailablePositions: entry.visuallyAvailablePositions,
      safeUniqueLongCommonRepair: entry.safeUniqueLongCommonRepair,
      safeJointLongCommonRepair: entry.safeJointLongCommonRepair,
      accepted: ranked.includes(entry),
    })),
  } : undefined
  if (!best) return { text: source, changes: 0, ...(diagnostics ? { diagnostics } : {}) }
  const runnerUp = ranked[1]
  const equallyNearRunnerUp = ranked.find((entry) => (
    entry !== best && entry.distance === best.distance
  ))
  const sourceLooksLikeProperName = /^\p{Lu}\p{Ll}{2,}$/u.test(source)
  if (
    sourceLooksLikeProperName &&
    !sourceIsKnown &&
    best.distance >= 2 &&
    best.supportedChanges < best.distance
  ) return { text: source, changes: 0, ...(diagnostics ? { diagnostics } : {}) }
  if (
    sourceIsKnown && (
      best.alignment.score < sourceAlignment.score + (best.distance === 1 ? 0.06 : 0.3) ||
      best.supportedChanges < Math.ceil(best.distance / 2) ||
      (runnerUp && best.selectionScore < runnerUp.selectionScore + 0.2)
    )
  ) return { text: source, changes: 0, ...(diagnostics ? { diagnostics } : {}) }
  if (
    !sourceIsKnown && (
    (
      !best.safeLongCommonRepair &&
      best.selectionScore < sourceSelectionScore - (
        best.contextuallyPlausibleChanges >= best.distance ? 0.29 : 0.22
      ) * best.distance
    ) ||
    (!best.safeLongCommonRepair && runnerUp && best.selectionScore < runnerUp.selectionScore + 0.06) ||
    (
      !best.safeLongCommonRepair &&
      best.supportedChanges === 0 &&
      equallyNearRunnerUp?.supportedChanges === 0 &&
      best.selectionScore < equallyNearRunnerUp.selectionScore + 0.2
    )
    )
  ) return { text: source, changes: 0, ...(diagnostics ? { diagnostics } : {}) }
  return {
    text: preserveWordCase(source, best.candidate, language),
    changes: Math.max(
      best.supportedChanges,
      best.visuallyPlausibleChanges,
      best.contextuallyPlausibleChanges,
      best.safeLongCommonRepair ? best.distance : 0,
    ),
    ...(diagnostics ? { diagnostics } : {}),
  }
}

/** Deterministic audit hook; production recognition uses the same decoder. */
export const personalizedDictionaryWordForTests = (
  source: string,
  tokens: RecognitionToken[],
  language: RecognitionLanguage,
  neuralContext = '',
) => personalizedDictionaryWord(source, tokens, language, true, neuralContext, true)

const personalizedDictionaryContext = (
  neuralResult: NeuralTextRecognitionResult,
  tokenLines: RecognitionToken[][],
  language: RecognitionLanguage,
) => {
  const wordPattern = language === 'de' ? /[A-Za-zÄÖÜäöü]{3,}/gu : /[A-Za-z]{3,}/gu
  let changes = 0
  const lines = neuralResult.lines.map((line, lineIndex) => {
    const lineTokens = tokenLines[lineIndex] ?? []
    if (!lineTokens.length) return line.text
    const neuralCharacters = normalizedLineCharacters(line.text, line.characters)
    const tokenForNeural = new Map<number, number>()
    alignCharacters(lineTokens, neuralCharacters).forEach((step) => {
      if (step.tokenIndex !== null && step.neuralIndex !== null) tokenForNeural.set(step.neuralIndex, step.tokenIndex)
    })
    let visibleOffset = 0
    let sourceOffset = 0
    let output = ''
    for (const match of line.text.matchAll(wordPattern)) {
      const matchOffset = match.index ?? 0
      output += line.text.slice(sourceOffset, matchOffset)
      visibleOffset += Array.from(line.text.slice(sourceOffset, matchOffset)).filter((character) => !/\s/u.test(character)).length
      const source = match[0]
      const length = Array.from(source).length
      const tokenIndices = new Set<number>()
      for (let index = visibleOffset; index < visibleOffset + length; index += 1) {
        const tokenIndex = tokenForNeural.get(index)
        if (tokenIndex !== undefined) tokenIndices.add(tokenIndex)
      }
      const wordTokens = [...tokenIndices].sort((first, second) => first - second).map((index) => lineTokens[index])
      const corrected = personalizedDictionaryWord(source, wordTokens, language)
      output += corrected.text
      changes += corrected.changes
      sourceOffset = matchOffset + source.length
      visibleOffset += length
    }
    return output + line.text.slice(sourceOffset)
  })
  return { text: lines.join('\n'), changes }
}

const chooseAlignedCharacter = (
  token: RecognitionToken | null,
  neural: NeuralTextCharacter | null,
  language: RecognitionLanguage,
) => {
  if (!token && neural) return { char: neural.char, source: 'neural' as const, confidence: neural.confidence }
  if (token && !neural) {
    const personal = strongestPersonalCandidate(token)
    if (personal && (
      personal.personalSupport >= 3 ||
      personal.personalConfidence >= 72
    )) {
      return { char: personal.char, source: 'personalized' as const, confidence: personal.personalConfidence }
    }
    return null
  }
  if (!token || !neural) return null
  const personal = strongestPersonalCandidate(token)
  const germanCandidate = language === 'de'
    ? tokenCandidates(token)
      .filter((candidate) => GERMAN_SPECIAL_LETTERS.has(candidate.char))
      .sort((first, second) => (
        second.personalConfidence + second.confidence + Math.min(18, second.personalSupport * 3) -
        first.personalConfidence - first.confidence - Math.min(18, first.personalSupport * 3)
      ))[0] ?? null
    : null
  // The specialized line model intentionally has a compact ASCII alphabet.
  // Preserve well-supported umlauts from GlyphenWerk/the geometric
  // recognizer instead of silently flattening German words.
  const selectedGermanSpecialLetter = germanCandidate?.char === token.char
  const trainedGermanSpecialLetter = Boolean(germanCandidate && (
    (germanCandidate.personalSupport >= 3 && germanCandidate.personalConfidence >= 24) ||
    germanCandidate.personalConfidence >= 54
  ))
  if (germanCandidate && (
    trainedGermanSpecialLetter ||
    (
      selectedGermanSpecialLetter &&
      // The geometric recognizer actually selected the umlaut, rather than
      // merely listing one as a broad alternative. A small gap to the compact
      // ASCII line model is expected because that model cannot emit umlauts at
      // all. Keep requiring strong shape evidence, but do not let a five-point
      // ASCII confidence advantage flatten a clearly drawn diaeresis.
      germanCandidate.confidence >= Math.max(80, neural.confidence - 10)
    )
  )) {
    return {
      char: germanCandidate.char,
      source: 'personalized' as const,
      confidence: Math.max(germanCandidate.confidence, germanCandidate.personalConfidence),
    }
  }
  if (!personal) {
    const matching = tokenCandidates(token).find((candidate) => candidate.char === neural.char)
    return neural.confidence >= token.confidence - 9 || matching
      ? { char: neural.char, source: 'neural' as const, confidence: Math.max(neural.confidence, matching?.confidence ?? 0) }
      : { char: token.char, source: 'classical' as const, confidence: token.confidence }
  }
  if (personal.char === neural.char) {
    const substantivePersonalEvidence = (
      personal.personalSupport >= 3 ||
      personal.personalConfidence >= 18
    )
    return {
      char: personal.char,
      source: substantivePersonalEvidence ? 'personalized' as const : 'neural' as const,
      confidence: Math.max(personal.personalConfidence, neural.confidence),
    }
  }
  const supportBonus = Math.min(26, Math.log2(personal.personalSupport + 1) * 8)
  const personalizedScore = personal.personalConfidence + supportBonus
  const neuralCandidate = tokenCandidates(token).find((candidate) => candidate.char === neural.char)
  const neuralScore = neural.confidence + Math.min(12, (neuralCandidate?.confidence ?? 0) * 0.12)
  const personalizedWins = (
    personal.personalSupport >= 8 && personal.personalConfidence >= 42
  ) || (
    personal.personalSupport >= 3 && personalizedScore >= neuralScore - 4
  ) || (
    personal.personalConfidence >= 78 && personalizedScore >= neuralScore - 12
  )
  return personalizedWins
    ? { char: personal.char, source: 'personalized' as const, confidence: personal.personalConfidence }
    : { char: neural.char, source: 'neural' as const, confidence: neural.confidence }
}

const knownWordRatio = (value: string, language: RecognitionLanguage) => {
  const locale = language === 'de' ? 'de' : 'en'
  const words = normalizeGermanSharpS(value)
    .toLocaleLowerCase(locale)
    .match(language === 'de' ? /[a-zäöü]{2,}/giu : /[a-z]{2,}/giu) ?? []
  if (!words.length) return 0
  return words.filter((word) => (
    lexicons[language].has(word) || isExtendedNeuralContextWord(word, language)
  )).length / words.length
}

const lineTokenGroups = (tokens: RecognitionToken[]) => {
  const lines: RecognitionToken[][] = []
  tokens.filter((token) => !token.isLayout).forEach((token) => {
    if (!lines.length || token.lineBreakBefore) lines.push([])
    lines.at(-1)!.push(token)
  })
  return lines
}

const renderFusedLine = (
  characters: FusedCharacter[],
  boundary: 'neural' | 'token' | 'consensus',
) => {
  let output = ''
  characters.forEach((entry) => {
    const spaceBefore = boundary === 'neural'
      ? entry.neuralSpace
      : boundary === 'token'
        ? entry.tokenSpace
        : entry.neuralSpace && entry.tokenSpace
    if (output && spaceBefore && !/^[,.;:!?)]$/u.test(entry.char) && !output.endsWith(' ')) output += ' '
    output += entry.char
  })
  return output.trim()
}

const wordBoundaryScore = (
  value: string,
  language: RecognitionLanguage,
  preferred: boolean,
) => {
  const words = value.match(language === 'de' ? /[a-zäöü]+/giu : /[a-z]+/giu) ?? []
  const singleLetterWords = words.filter((word) => Array.from(word).length === 1).length
  const emptyBoundaryPenalty = /\s{2,}/u.test(value) ? 0.5 : 0
  return knownWordRatio(value, language) * 1.28
    - singleLetterWords * 0.055
    - emptyBoundaryPenalty
    + (preferred ? 0.16 : 0)
}

const chooseFusedLineSpacing = (
  characters: FusedCharacter[],
  neuralLine: NeuralTextRecognitionResult['lines'][number],
  language: RecognitionLanguage,
) => {
  if (!characters.length) return ''
  const candidates = (['neural', 'token', 'consensus'] as const)
    .map((boundary) => {
      const text = renderFusedLine(characters, boundary)
      return {
        text,
        score: wordBoundaryScore(text, language, boundary === 'neural' && neuralLine.confidence >= 52),
      }
    })
  return candidates.sort((first, second) => second.score - first.score)[0].text
}

/**
 * Scores alternative segmentations after neural/personal fusion. The score
 * deliberately distinguishes genuinely trained glyph evidence from the
 * generic geometric fallback; older code counted both as "personalized" and
 * could therefore select a worse segmentation merely because it contained
 * more generic pieces.
 */
export const personalizedTextFusionSelectionScore = (
  fusion: PersonalizedTextRecognitionResult,
  neuralResult: NeuralTextRecognitionResult,
  language: RecognitionLanguage,
) => {
  const visible = fusion.personalizedCharacters + fusion.neuralCharacters + fusion.classicalCharacters
  const personalRatio = fusion.personalizedCharacters / Math.max(1, visible)
  const classicalRatio = fusion.classicalCharacters / Math.max(1, visible)
  const neuralCharacterCount = Array.from(neuralResult.text).filter((character) => !/\s/u.test(character)).length
  const fusedCharacterCount = Array.from(fusion.text).filter((character) => !/\s/u.test(character)).length
  const lengthDifference = Math.abs(fusedCharacterCount - neuralCharacterCount)
  const personalLengthProtection = 1 - Math.min(0.72, personalRatio * 0.72)
  const neuralIsPlainLanguage = Array.from(neuralResult.text).every((character) => (
    /[\p{L}\s.,;:!?"'()[\]{}\-]/u.test(character)
  ))
  const unexpectedTextCharacters = neuralIsPlainLanguage
    ? Array.from(fusion.text).filter((character) => (
        !/[\p{L}\s.,;:!?"'()[\]{}\-]/u.test(character)
      )).length
    : 0
  const textDistanceFromNeural = wordDistance(
    fusion.text.toLocaleLowerCase(language === 'de' ? 'de-CH' : 'en-US'),
    neuralResult.text.toLocaleLowerCase(language === 'de' ? 'de-CH' : 'en-US'),
  )
  const unsupportedChanges = fusion.unsupportedChanges
    ?? Math.max(0, textDistanceFromNeural - fusion.personalizedCharacters)
  return (
    fusion.confidence / 100
    + personalRatio * 1.32
    + classicalRatio * 0.12
    + knownWordRatio(fusion.text, language) * 0.82
    - lengthDifference * 0.18 * personalLengthProtection
    // A plausible substring must not hide obviously spurious OCR debris.
    // This only activates when the neural line itself is ordinary language,
    // so real mixed text such as “x_1” or “Version 2” remains untouched.
    - unexpectedTextCharacters / Math.max(1, fusedCharacterCount) * 0.54
    - unsupportedChanges * 0.24
  )
}

export const fusePersonalizedTextRecognition = (
  tokens: RecognitionToken[],
  neuralResult: NeuralTextRecognitionResult,
  language: RecognitionLanguage,
  measuredCharacterCount?: number,
  disableWordwiseFusion = false,
): PersonalizedTextRecognitionResult => {
  const classicalText = recognizedSentence(tokens).trim()
  if (!neuralResult.text.trim()) {
    const personalCharacters = tokens.filter((token) => Boolean(strongestPersonalCandidate(token))).length
    const visibleCharacters = Array.from(classicalText).filter((char) => !/\s/u.test(char)).length
    return {
      text: classicalText,
      confidence: Math.round(tokens.reduce((sum, token) => sum + token.confidence, 0) / Math.max(1, tokens.length)),
      source: personalCharacters ? 'personalized' : 'classical',
      personalizedCharacters: personalCharacters,
      neuralCharacters: 0,
      classicalCharacters: Math.max(0, visibleCharacters - personalCharacters),
      unsupportedChanges: 0,
    }
  }

  // Once physical spaces and neural spaces agree, decide every word on its
  // own evidence. Treating a complete sentence as one character alignment
  // allowed an insertion in one word to shift all following personal glyphs;
  // it also prevented the mature single-word safeguards below from applying
  // to normal sentences. The recursive calls are explicitly single-word.
  if (!disableWordwiseFusion) {
    const physicalTokenLines = lineTokenGroups(tokens)
    const wordPlans = neuralResult.lines.map((neuralLine, lineIndex) => {
      const lineTokens = physicalTokenLines[lineIndex] ?? []
      const tokenWords: RecognitionToken[][] = []
      lineTokens.forEach((token) => {
        if (!tokenWords.length || token.spaceBefore) tokenWords.push([])
        tokenWords.at(-1)!.push(token)
      })
      const neuralWords = neuralLine.text.trim().split(/\s+/u).filter(Boolean)
      return { neuralLine, neuralWords, tokenWords }
    })
    const hasMultiwordLine = wordPlans.some(({ neuralWords }) => neuralWords.length >= 2)
    const hasMatchingPhysicalWords = (
      physicalTokenLines.length === neuralResult.lines.length &&
      wordPlans.every(({ neuralWords, tokenWords }) => (
        neuralWords.length > 0 && neuralWords.length === tokenWords.length
      ))
    )
    if (hasMultiwordLine && hasMatchingPhysicalWords) {
      const fusedLines = wordPlans.map(({ neuralLine, neuralWords, tokenWords }) => {
        const lineCharacters = normalizedLineCharacters(neuralLine.text, neuralLine.characters)
        let characterOffset = 0
        return neuralWords.map((word, wordIndex) => {
          const visibleCount = Array.from(word).filter((character) => !/\s/u.test(character)).length
          const wordCharacters = lineCharacters
            .slice(characterOffset, characterOffset + visibleCount)
            .map((character, index) => ({
              ...character,
              start: index / Math.max(1, visibleCount),
              end: (index + 1) / Math.max(1, visibleCount),
            }))
          characterOffset += visibleCount
          const wordNeural: NeuralTextRecognitionResult = {
            text: word,
            confidence: neuralLine.confidence,
            lines: [{
              ...neuralLine,
              text: word,
              rawText: word,
              characters: wordCharacters,
            }],
            engine: neuralResult.engine,
            wordCount: 1,
          }
          return fusePersonalizedTextRecognition(
            tokenWords[wordIndex],
            wordNeural,
            language,
            tokenWords[wordIndex].filter((token) => !token.isLayout).length,
            true,
          )
        })
      })
      const flat = fusedLines.flat()
      const totalCharacters = flat.reduce((sum, fusion) => (
        sum + fusion.personalizedCharacters + fusion.neuralCharacters + fusion.classicalCharacters
      ), 0)
      const personalizedCharacters = flat.reduce((sum, fusion) => sum + fusion.personalizedCharacters, 0)
      const neuralCharacters = flat.reduce((sum, fusion) => sum + fusion.neuralCharacters, 0)
      const classicalCharacters = flat.reduce((sum, fusion) => sum + fusion.classicalCharacters, 0)
      const unsupportedChanges = flat.reduce((sum, fusion) => sum + (fusion.unsupportedChanges ?? 0), 0)
      const activeSources = [personalizedCharacters, neuralCharacters, classicalCharacters].filter(Boolean).length
      return {
        text: fusedLines.map((line) => line.map((fusion) => fusion.text).join(' ')).join('\n'),
        confidence: Math.round(flat.reduce((sum, fusion) => {
          const characters = fusion.personalizedCharacters + fusion.neuralCharacters + fusion.classicalCharacters
          return sum + fusion.confidence * characters
        }, 0) / Math.max(1, totalCharacters)),
        source: activeSources > 1
          ? 'hybrid'
          : personalizedCharacters ? 'personalized' : neuralCharacters ? 'neural' : 'classical',
        personalizedCharacters,
        neuralCharacters,
        classicalCharacters,
        unsupportedChanges,
      }
    }
  }

  const tokenLines = lineTokenGroups(tokens)
  const dictionaryCorrection = personalizedDictionaryContext(neuralResult, tokenLines, language)
  const lineCount = Math.max(tokenLines.length, neuralResult.lines.length)
  const outputLines: string[] = []
  let personalizedCharacters = 0
  let neuralCharacters = 0
  let classicalCharacters = 0
  let confidenceTotal = 0
  let confidenceCount = 0

  for (let lineIndex = 0; lineIndex < lineCount; lineIndex += 1) {
    const lineTokens = tokenLines[lineIndex] ?? []
    const neuralLine = neuralResult.lines[lineIndex]
    if (!neuralLine) {
      outputLines.push(recognizedSentence(lineTokens))
      lineTokens.forEach((token) => {
        if (strongestPersonalCandidate(token)) personalizedCharacters += 1
        else classicalCharacters += 1
      })
      confidenceTotal += lineTokens.reduce((sum, token) => sum + token.confidence, 0)
      confidenceCount += lineTokens.length
      continue
    }
    const neuralCharactersForLine = normalizedLineCharacters(neuralLine.text, neuralLine.characters)
    if (!lineTokens.length) {
      outputLines.push(neuralLine.text)
      neuralCharacters += neuralCharactersForLine.length
      confidenceTotal += neuralCharactersForLine.reduce((sum, entry) => sum + entry.confidence, 0)
      confidenceCount += neuralCharactersForLine.length
      continue
    }
    const alignment = alignCharacters(lineTokens, neuralCharactersForLine)
    const fusedCharacters: FusedCharacter[] = []
    let previousTokenIndex: number | null = null
    alignment.forEach((step) => {
      const token = step.tokenIndex === null ? null : lineTokens[step.tokenIndex]
      const neural = step.neuralIndex === null ? null : neuralCharactersForLine[step.neuralIndex]
      const selected = chooseAlignedCharacter(token, neural, language)
      if (!selected) return
      const neuralSpace = Boolean(neural?.spaceBefore)
      const tokenSpace = Boolean(token?.spaceBefore && previousTokenIndex !== null)
      fusedCharacters.push({
        ...selected,
        neuralSpace,
        tokenSpace,
      })
      if (selected.source === 'personalized') personalizedCharacters += 1
      else if (selected.source === 'neural') neuralCharacters += 1
      else classicalCharacters += 1
      confidenceTotal += selected.confidence
      confidenceCount += 1
      previousTokenIndex = step.tokenIndex ?? previousTokenIndex
    })
    const line = chooseFusedLineSpacing(fusedCharacters, neuralLine, language)
    outputLines.push(line)
  }

  const hybrid = normalizeGermanSharpS(outputLines.join('\n').trim())
  const contextualized = applyMeasuredNeuralWordContext(
    applyNeuralWordContext(hybrid, language),
    language,
    measuredCharacterCount,
  )
  const measuredNeuralText = applyMeasuredNeuralWordContext(
    neuralResult.text,
    language,
    measuredCharacterCount,
  )
  const visibleTokens = tokens.filter((token) => !token.isLayout)
  const hasPersonallyLetterLikeSeparator = visibleTokens.some((token) => {
    if (!/^[-−_]$/u.test(token.char)) return false
    const personal = strongestPersonalCandidate(token)
    return Boolean(personal?.personalSupport && /^\p{L}$/u.test(personal.char))
  })
  const separatorCompactedClassicalText = hasPersonallyLetterLikeSeparator
    ? classicalText.replace(/(\p{L})[-−_](?=\p{L})/gu, '$1')
    : classicalText
  const classicalInkCharacterCount = Array.from(separatorCompactedClassicalText)
    .filter((character) => !/\s/u.test(character)).length
  const neuralIsSingleWord = /^\p{L}+$/u.test(neuralResult.text.trim())
  const personalLetterSequence = neuralIsSingleWord
    ? visibleTokens.map((token) => {
      if (/^\p{L}$/u.test(token.char)) return token.char
      const alternative = tokenCandidates(token)
        .filter((candidate) => (
          /^\p{L}$/u.test(candidate.char) &&
          candidate.personalSupport > 0 &&
          candidate.confidence >= 44 &&
          candidate.confidence >= token.confidence - 20
        ))
        .sort((first, second) => evidenceStrength(second) - evidenceStrength(first))[0]
      return alternative?.char ?? token.char
    }).join('')
    : ''
  const completePersonalLetterSequence = (
    personalLetterSequence &&
    /^\p{L}+$/u.test(personalLetterSequence) &&
    measuredCharacterCount !== undefined &&
    Array.from(personalLetterSequence).length === measuredCharacterCount
  )
  const compactedClassicalText = (
    completePersonalLetterSequence
  )
    ? personalLetterSequence
    : (
      neuralIsSingleWord &&
    measuredCharacterCount !== undefined &&
    classicalInkCharacterCount === measuredCharacterCount
    )
      ? separatorCompactedClassicalText.replace(/\s+/gu, '')
      : separatorCompactedClassicalText
  const personallyCorrectedClassicalText = personalizedDictionaryWord(
    compactedClassicalText,
    visibleTokens,
    language,
    visibleTokens.length === Array.from(compactedClassicalText).filter((character) => !/\s/u.test(character)).length,
    neuralResult.text,
  )
  const correctedClassicalText = personallyCorrectedClassicalText.changes > 0
    ? personallyCorrectedClassicalText.text
    : applyFinalNeuralWordContext(compactedClassicalText, language)
  const sequenceClassicalText = correctedClassicalText !== classicalText
    && knownWordRatio(correctedClassicalText, language) >= 0.99
    ? correctedClassicalText
    : compactedClassicalText !== classicalText
      && knownWordRatio(compactedClassicalText, language) >= 0.99
      ? compactedClassicalText
      : classicalText
  const classicalRatio = knownWordRatio(sequenceClassicalText, language)
  const hybridRatio = knownWordRatio(contextualized, language)
  const neuralRatio = knownWordRatio(measuredNeuralText, language)
  const strongClassicalPersonal = visibleTokens.flatMap((token) => {
    const personal = strongestPersonalCandidate(token)
    return personal?.char === token.char && personal.personalSupport >= 3 && (
      token.confidence >= 72 || personal.personalConfidence >= 42
    ) ? [{ token, personal }] : []
  })
  const strongClassicalRatio = strongClassicalPersonal.length / Math.max(1, visibleTokens.length)
  const repeatedClassicalRatio = strongClassicalPersonal
    .filter(({ personal }) => personal.personalSupport >= 8).length /
    Math.max(1, visibleTokens.length)
  const trainedClassicalPersonal = visibleTokens.flatMap((token) => {
    const personal = strongestPersonalCandidate(token)
    return personal?.char === token.char && personal.personalSupport >= 1 && (
      token.confidence >= 60 || personal.personalConfidence >= 4
    ) ? [{ token, personal }] : []
  })
  const trainedClassicalRatio = trainedClassicalPersonal.length / Math.max(1, visibleTokens.length)
  const sequenceCharacters = Array.from(sequenceClassicalText)
  const sequenceMatchesTokenCount = sequenceCharacters.length === visibleTokens.length
  const observedClassicalPersonal = visibleTokens.flatMap((token, index) => {
    const expectedCharacter = sequenceMatchesTokenCount ? sequenceCharacters[index] : token.char
    const personal = tokenCandidates(token)
      .filter((candidate) => (
        candidate.personalSupport >= 1 &&
        (
          normalizedCharacter(candidate.char, language) === normalizedCharacter(expectedCharacter, language) ||
          normalizedCharacter(candidate.char, language) === normalizedCharacter(token.char, language)
        )
      ))
      .sort((first, second) => evidenceStrength(second) - evidenceStrength(first))[0]
    return personal
      ? [{ token, personal }]
      : []
  })
  const observedClassicalRatio = observedClassicalPersonal.length / Math.max(1, visibleTokens.length)
  const visuallyConfirmedClassicalRatio = observedClassicalPersonal.filter(({ token, personal }) => (
    token.confidence >= 65 && personal.personalConfidence >= 12
  )).length / Math.max(1, visibleTokens.length)
  const classicalConfidence = visibleTokens.reduce((sum, token) => sum + token.confidence, 0) /
    Math.max(1, visibleTokens.length) / 100
  const neuralVisibleCharacters = Array.from(measuredNeuralText).filter((character) => !/\s/u.test(character)).length
  const classicalVisibleCharacters = Array.from(sequenceClassicalText).filter((character) => !/\s/u.test(character)).length
  const completeLongDictionaryRepair = (
    personallyCorrectedClassicalText.changes >= 3 &&
    measuredCharacterCount !== undefined &&
    classicalVisibleCharacters === measuredCharacterCount &&
    wordDistance(
      compactedClassicalText.toLocaleLowerCase(language),
      personallyCorrectedClassicalText.text.toLocaleLowerCase(language),
    ) === personallyCorrectedClassicalText.changes
  )
  const completeConnectedDictionaryRepair = (
    personallyCorrectedClassicalText.changes >= 2 &&
    lexicons[language].has(sequenceClassicalText.toLocaleLowerCase(
      language === 'de' ? 'de-CH' : 'en-US',
    )) &&
    Math.abs(classicalVisibleCharacters - neuralVisibleCharacters) === 1 &&
    wordDistance(
      sequenceClassicalText.toLocaleLowerCase(language),
      measuredNeuralText.toLocaleLowerCase(language),
    ) === 1 &&
    observedClassicalRatio >= 0.84 &&
    classicalConfidence >= 0.58
  )
  const neuralMatchesMeasuredCharacterCount = (
    measuredCharacterCount !== undefined &&
    neuralVisibleCharacters === measuredCharacterCount
  )
  const comparableSequenceLengths = (
    classicalVisibleCharacters >= 4 &&
    neuralVisibleCharacters >= 4 &&
    Math.max(classicalVisibleCharacters, neuralVisibleCharacters) /
      Math.max(1, Math.min(classicalVisibleCharacters, neuralVisibleCharacters)) <= 1.8
  )
  const trainedSequenceOutvotesLengthHallucination = (
    comparableSequenceLengths &&
    Math.abs(classicalVisibleCharacters - neuralVisibleCharacters) >= 2 &&
    trainedClassicalRatio >= 0.82 &&
    classicalConfidence >= 0.68
  )
  const measuredNeuralWordOutvotesShortOneShot = (
    neuralRatio >= 0.99 &&
    neuralMatchesMeasuredCharacterCount &&
    visibleTokens.length !== measuredCharacterCount &&
    strongClassicalRatio < 0.66 &&
    !completeConnectedDictionaryRepair
  )
  const normalizedMeasuredNeuralWord = measuredNeuralText.toLocaleLowerCase(
    language === 'de' ? 'de-CH' : 'en-US',
  )
  const normalizedClassicalSequence = sequenceClassicalText.toLocaleLowerCase(
    language === 'de' ? 'de-CH' : 'en-US',
  )
  const trustedCommonNeuralWordOutvotesOneShot = (
    /^\p{L}+$/u.test(measuredNeuralText) &&
    lexicons[language].has(normalizedMeasuredNeuralWord) &&
    neuralResult.confidence >= 68 &&
    repeatedClassicalRatio < 0.5 &&
    !(
      completeLongDictionaryRepair &&
      lexicons[language].has(normalizedClassicalSequence) &&
      measuredCharacterCount !== undefined &&
      classicalVisibleCharacters === measuredCharacterCount
    ) &&
    !completeConnectedDictionaryRepair &&
    !(
      lexicons[language].has(normalizedClassicalSequence) &&
      observedClassicalRatio >= 0.84 &&
      classicalConfidence >= 0.55 &&
      wordDistance(
        compactedClassicalText.toLocaleLowerCase(language),
        normalizedClassicalSequence,
      ) === 0 &&
      measuredCharacterCount !== undefined &&
      classicalVisibleCharacters === measuredCharacterCount
    ) &&
    (
      sequenceClassicalText.toLocaleLowerCase(language) === normalizedMeasuredNeuralWord ||
      neuralMatchesMeasuredCharacterCount ||
      Math.abs(classicalVisibleCharacters - neuralVisibleCharacters) >= 1 ||
      !/^\p{L}+$/u.test(sequenceClassicalText)
    )
  )
  const classicalNeuralDistance = wordDistance(
    sequenceClassicalText.toLocaleLowerCase(language),
    measuredNeuralText.toLocaleLowerCase(language),
  )
  const sequenceCharactersWithCase = Array.from(sequenceClassicalText)
  const substantialTokenHeights = visibleTokens
    .map((token) => token.bbox[3])
    .filter((height) => height >= 0.025)
  const followingHeight = median(
    substantialTokenHeights.slice(1).length
      ? substantialTokenHeights.slice(1)
      : substantialTokenHeights,
  )
  const firstTokenIsVisuallyCapitalized = Boolean(
    visibleTokens[0] &&
    /^\p{Lu}$/u.test(sequenceCharactersWithCase[0] ?? '') &&
    visibleTokens[0].bbox[3] >= Math.max(0.025, followingHeight) * 1.08
  )
  const visuallySupportedProperName = (
    /^\p{Lu}\p{Ll}{2,}$/u.test(sequenceClassicalText) &&
    !lexicons[language].has(normalizedClassicalSequence) &&
    firstTokenIsVisuallyCapitalized &&
    measuredCharacterCount !== undefined &&
    classicalVisibleCharacters === measuredCharacterCount &&
    neuralVisibleCharacters === measuredCharacterCount &&
    classicalNeuralDistance >= 2 &&
    classicalConfidence >= (observedClassicalRatio >= 0.6 ? 0.56 : 0.7)
  )
  let text = contextualized
  let selectedClassicalSequence = false
  // A language-model correction may improve an uncertain geometric sequence,
  // but it must not rewrite a complete, visually confident word backed by
  // repeated GlyphenWerk samples. This is especially important once many
  // classes are trained: every alternative then has "personal" support, while
  // only the winning token still carries the correct visual ordering.
  if (visuallySupportedProperName) {
    // Neural word decoders are intentionally biased towards frequent words.
    // When a complete, equally long, visibly capitalized unknown word differs
    // in multiple positions, that prior is exactly wrong: it can turn a name
    // such as "Fabio" into "taboo". Prefer the independently segmented glyph
    // sequence without requiring the name to exist in any fixed dictionary.
    text = sequenceClassicalText
    selectedClassicalSequence = true
  }
  else if (measuredNeuralWordOutvotesShortOneShot || trustedCommonNeuralWordOutvotesOneShot) {
    text = measuredNeuralText
    personalizedCharacters = 0
    neuralCharacters = neuralVisibleCharacters
    classicalCharacters = 0
  }
  else if (completeConnectedDictionaryRepair) {
    text = sequenceClassicalText
    selectedClassicalSequence = true
  }
  else if (
    sequenceClassicalText &&
    (
      (
        strongClassicalRatio >= 0.66 &&
        classicalConfidence >= 0.72 &&
        (
          classicalRatio >= hybridRatio - 0.05 ||
          (repeatedClassicalRatio >= 0.75 && classicalConfidence >= 0.82)
        )
      ) || (
        // Even one genuine example per glyph can recover a complete known
        // word when the neural decoder produced an unknown word. Different
        // lengths demand substantially stronger evidence because a line
        // decoder can repeat or invent characters on unfamiliar handwriting.
        // Generic standard forms cannot pass the personal-agreement gate.
        trainedClassicalRatio >= (classicalVisibleCharacters === neuralVisibleCharacters ? 0.66 : 0.82) &&
        classicalConfidence >= (classicalVisibleCharacters === neuralVisibleCharacters ? 0.56 : 0.68) &&
        classicalRatio >= 0.99 &&
        hybridRatio < 0.5 &&
        neuralRatio < 0.5 &&
        (
          classicalVisibleCharacters === neuralVisibleCharacters ||
          trainedSequenceOutvotesLengthHallucination
        )
      ) || (
        // A complete word can be visually exact even when one-shot personal
        // confidences are still conservative. Every selected glyph must agree
        // with an actually observed personal class, the sequence itself must
        // be a dictionary word, and it must differ materially from the neural
        // line before it may outvote another fluent but visually wrong word.
        observedClassicalRatio >= 0.84 &&
        // If the neural decoder already produced a complete dictionary word
        // whose length agrees with the independently measured pen-lift count,
        // a shorter/longer one-shot segmentation must not replace it merely
        // because that other sequence is also a valid word (for example
        // "zeile" -> "zeit"). Repeated, strong personal evidence still has
        // its dedicated precedence branch above.
        !(
          neuralRatio >= 0.99 &&
          neuralMatchesMeasuredCharacterCount &&
          classicalVisibleCharacters !== measuredCharacterCount
        ) &&
        // One example per class deliberately starts with conservative
        // confidence values.  Do not discard a complete visually observed
        // dictionary word merely because its average is just below 62% when
        // the neural decoder produced a materially different word.  The
        // observed-ratio, dictionary and edit-distance gates below still keep
        // generic/untrained segmentations out of this branch.
        classicalConfidence >= (
          completeLongDictionaryRepair
            ? 0.54
            : lexicons[language].has(normalizedClassicalSequence)
              ? 0.55
              : 0.56
        ) &&
        classicalRatio >= 0.99 &&
        (
          classicalNeuralDistance >= 2 ||
          (
            Math.abs(classicalVisibleCharacters - neuralVisibleCharacters) === 1 &&
            (
              visuallyConfirmedClassicalRatio >= 0.34 ||
              classicalVisibleCharacters === measuredCharacterCount
            )
          )
        ) &&
        comparableSequenceLengths
      )
    )
  ) {
    text = sequenceClassicalText
    selectedClassicalSequence = true
  }
  else if (
    personalizedCharacters > neuralCharacters &&
    classicalRatio > hybridRatio + 0.34
  ) {
    text = sequenceClassicalText
    selectedClassicalSequence = true
  }
  else if (
    neuralCharacters > personalizedCharacters * 2 &&
    neuralRatio > hybridRatio + 0.34
  ) text = measuredNeuralText

  if (selectedClassicalSequence) {
    personalizedCharacters = Math.max(
      strongClassicalPersonal.length,
      trainedClassicalPersonal.length,
      visuallyConfirmedClassicalRatio * visibleTokens.length,
    )
    neuralCharacters = 0
    classicalCharacters = Math.max(0, visibleTokens.length - personalizedCharacters)
  }

  if (
    dictionaryCorrection.changes > 0 &&
    !selectedClassicalSequence &&
    !measuredNeuralWordOutvotesShortOneShot &&
    !trustedCommonNeuralWordOutvotesOneShot
  ) {
    text = dictionaryCorrection.text
    const correctedVisibleCharacters = Array.from(text).filter((character) => !/\s/u.test(character)).length
    personalizedCharacters = Math.max(personalizedCharacters, dictionaryCorrection.changes)
    neuralCharacters = Math.max(0, correctedVisibleCharacters - personalizedCharacters)
    classicalCharacters = 0
  }

  const selectedCompact = normalizeGermanSharpS(text)
    .replace(/\s+/gu, '')
    .toLocaleLowerCase(language === 'de' ? 'de-CH' : 'en-US')
  const neuralCompact = neuralResult.text
    .replace(/\s+/gu, '')
    .toLocaleLowerCase(language === 'de' ? 'de-CH' : 'en-US')
  const selectedCharacters = Array.from(selectedCompact)
  const neuralCharactersForSupport = Array.from(neuralCompact)
  let supportedSelectedChanges = 0
  if (selectedCharacters.length === neuralCharactersForSupport.length) {
    const selectedAlignment = alignWordToTokens(selectedCompact, visibleTokens, language)
    selectedCharacters.forEach((character, index) => {
      if (character === neuralCharactersForSupport[index]) return
      const tokenIndex = selectedAlignment.tokenByCharacter.get(index)
      if (tokenIndex === undefined) return
      const token = visibleTokens[tokenIndex]
      const evidence = candidateEvidence(token, character, language)
      const visualCharacter = token.visualLabelId && token.visualLabelId !== token.labelId
        ? token.alternatives.find((alternative) => alternative.labelId === token.visualLabelId)?.char ?? token.char
        : token.char
      if (evidence && (
        evidence.personalSupport >= 3 ||
        evidence.personalConfidence >= 18 ||
        (
          evidence.personalSupport >= 1 &&
          normalizedCharacter(visualCharacter, language) === normalizedCharacter(character, language)
        )
      )) supportedSelectedChanges += 1
    })
  } else supportedSelectedChanges = strongClassicalPersonal.length
  let unsupportedChanges = Math.max(
    0,
    wordDistance(selectedCompact, neuralCompact) - supportedSelectedChanges,
  )
  const selectedMatchesIndependentCount = (
    measuredCharacterCount !== undefined &&
    selectedCharacters.length === measuredCharacterCount &&
    neuralCharactersForSupport.length !== measuredCharacterCount
  )
  if (selectedMatchesIndependentCount) unsupportedChanges = 0
  const weakExtendedDictionaryCorrection = (
    selectedCompact !== neuralCompact &&
    /^\p{L}{2,24}$/u.test(selectedCompact) &&
    !lexicons[language].has(selectedCompact) &&
    neuralResult.confidence >= 78 &&
    repeatedClassicalRatio < 0.5
  )
  if (
    !visuallySupportedProperName && (weakExtendedDictionaryCorrection || (
      unsupportedChanges > 0 &&
      selectedCharacters.length === neuralCharactersForSupport.length &&
      neuralRatio >= 0.99 &&
      neuralResult.confidence >= 78 &&
      !selectedMatchesIndependentCount
    ))
  ) {
    text = measuredNeuralText
    personalizedCharacters = 0
    neuralCharacters = neuralVisibleCharacters
    classicalCharacters = 0
    unsupportedChanges = 0
  }
  const activeSources = [personalizedCharacters, neuralCharacters, classicalCharacters].filter(Boolean).length
  const source = activeSources > 1
    ? 'hybrid'
    : personalizedCharacters ? 'personalized' : neuralCharacters ? 'neural' : 'classical'
  return {
    text: normalizeGermanSharpS(text),
    confidence: Math.round(clamp(confidenceTotal / Math.max(1, confidenceCount) / 100) * 100),
    source,
    personalizedCharacters,
    neuralCharacters,
    classicalCharacters,
    unsupportedChanges,
  }
}
