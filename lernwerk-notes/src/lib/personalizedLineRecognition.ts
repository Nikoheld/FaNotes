import type {
  RecognitionLanguage,
  RecognitionToken,
} from '../../../src/lib/recognition'
import type { Stroke } from '../../../src/types'
import type { RecognitionResources } from './handwritingDb'
import type { NeuralTextRecognitionResult } from './neuralTextRecognition'
import {
  fusePersonalizedTextRecognition,
  personalizedTextFusionSelectionScore,
  type PersonalizedTextRecognitionResult,
} from './personalizedTextRecognition'

export type PersonalizedLineRecognition = {
  tokens: RecognitionToken[]
  fusion: PersonalizedTextRecognitionResult
}

type RecognitionModule = typeof import('../../../src/lib/recognition')

/**
 * Uses only conspicuously wide physical gaps to divide a line into the same
 * number of words as the neural line model. Exact-count personalization can
 * then align each word independently instead of moving a cut from the end of
 * one word into the beginning of the next. Ambiguous gaps deliberately return
 * null so connected cursive remains on the unrestricted full-line path.
 */
const recognizePhysicallySeparatedWords = (
  physicalLines: ReturnType<RecognitionModule['groupRecognitionLines']>,
  neural: NeuralTextRecognitionResult,
  resources: RecognitionResources,
  language: RecognitionLanguage,
  recognition: RecognitionModule,
): RecognitionToken[][] => {
  if (physicalLines.length !== neural.lines.length) return []
  let usedWordPartition = false
  const linePlans: Array<{
    neuralWords: string[]
    wordStrokes: Stroke[][]
    neuralCounts: number[]
    measuredCounts: Array<number | null>
  }> = []

  for (let lineIndex = 0; lineIndex < physicalLines.length; lineIndex += 1) {
    const line = physicalLines[lineIndex]
    const neuralWords = neural.lines[lineIndex].text.trim().split(/\s+/u).filter(Boolean)
    if (neuralWords.length === 0 || neuralWords.length > 12) return []

    let wordStrokes: Stroke[][]
    if (neuralWords.length === 1) wordStrokes = [line.strokes]
    else {
      const clusters = recognition.segmentStrokes(line.strokes, 'text')
      if (clusters.length < neuralWords.length) return []
      const lineMinY = Math.min(...clusters.map((cluster) => cluster.minY))
      const lineMaxY = Math.max(...clusters.map((cluster) => cluster.maxY))
      const lineHeight = Math.max(0.001, lineMaxY - lineMinY)
      const gaps = clusters.slice(0, -1).map((cluster, index) => ({
        index,
        gap: clusters[index + 1].minX - cluster.maxX,
      }))
      const selected = [...gaps]
        .sort((first, second) => second.gap - first.gap)
        .slice(0, neuralWords.length - 1)
      const smallestSelectedGap = Math.min(...selected.map(({ gap }) => gap))
      const selectedIndexes = new Set(selected.map(({ index }) => index))
      const largestInternalGap = Math.max(
        0,
        ...gaps.filter(({ index }) => !selectedIndexes.has(index)).map(({ gap }) => gap),
      )
      const minimumWordGap = Math.max(0.012, lineHeight * 0.22)
      const isDistinctFromLetterGaps = largestInternalGap === 0
        || smallestSelectedGap >= largestInternalGap * 1.45
      if (smallestSelectedGap < minimumWordGap || !isDistinctFromLetterGaps) return []

      const groupedClusters: typeof clusters[] = [[]]
      clusters.forEach((cluster, index) => {
        groupedClusters.at(-1)!.push(cluster)
        if (selectedIndexes.has(index)) groupedClusters.push([])
      })
      if (
        groupedClusters.length !== neuralWords.length
        || groupedClusters.some((group) => group.length === 0)
      ) return []
      wordStrokes = groupedClusters.map((group) => group.flatMap((cluster) => cluster.strokes))
      usedWordPartition = true
    }

    const neuralCounts = neuralWords.map((word) => (
      Array.from(word).filter((character) => !/\s/u.test(character)).length
    ))
    if (neuralCounts.some((count) => count === 0)) return []
    const measuredCounts = wordStrokes.map((ink, wordIndex) => {
      const measured = recognition.estimatePenLiftTextCharacterCount(ink)
      const neuralCount = neuralCounts[wordIndex]
      // A connected word can legitimately have one ink island. Accept the
      // physical count only when it remains close to the line-model length;
      // otherwise it is a component count, not a character count.
      return measured
        && Math.abs(measured - neuralCount) <= 2
        && measured >= Math.max(2, Math.ceil(neuralCount * 0.55))
        ? measured
        : null
    })
    linePlans.push({ neuralWords, wordStrokes, neuralCounts, measuredCounts })
  }

  if (!usedWordPartition) return []
  const hasMeasuredAlternative = linePlans.some(({ neuralCounts, measuredCounts }) => (
    measuredCounts.some((count, index) => count !== null && count !== neuralCounts[index])
  ))
  const recognizeWord = (ink: Stroke[], characterCount: number) => recognition.recognizeExpression(
    ink,
    resources.model,
    resources.labels,
    'text',
    resources.layoutExamples,
    language,
    characterCount,
    // The neural word supplies only its length here. Supplying its letters
    // would let a fluent but wrong guess steer the personal segmentation
    // away from the writer's actual glyph sequence.
    undefined,
    0,
  )
  const neuralWordTokens = linePlans.map(({ wordStrokes, neuralCounts }) => (
    wordStrokes.map((ink, wordIndex) => recognizeWord(ink, neuralCounts[wordIndex]))
  ))
  const tokenMatrices: RecognitionToken[][][][] = [neuralWordTokens]
  if (hasMeasuredAlternative) {
    tokenMatrices.push(linePlans.map(({ wordStrokes, neuralCounts, measuredCounts }, lineIndex) => (
      wordStrokes.map((ink, wordIndex) => {
        const measured = measuredCounts[wordIndex]
        return measured && measured !== neuralCounts[wordIndex]
          ? recognizeWord(ink, measured)
          : neuralWordTokens[lineIndex][wordIndex]
      })
    )))
  }
  const maximumSuspiciousWords = resources.sampleCount >= 240 ? 2 : 1
  const suspiciousWords = neuralWordTokens.flatMap((lineTokens, lineIndex) => (
    lineTokens.flatMap((tokens, wordIndex) => {
      const neuralWord = linePlans[lineIndex].neuralWords[wordIndex]
      if (!/^\p{L}{3,24}$/u.test(neuralWord)) return []
      const visible = tokens.filter((token) => !token.isLayout)
      const malformedPersonalWord = visible.some((token) => !/^\p{L}$/u.test(token.char))
      const averageConfidence = visible.reduce((sum, token) => sum + token.confidence, 0)
        / Math.max(1, visible.length)
      return malformedPersonalWord || averageConfidence < 42
        ? [{ lineIndex, wordIndex }]
        : []
    })
  )).slice(0, maximumSuspiciousWords)
  suspiciousWords.forEach(({ lineIndex, wordIndex }) => {
    const plan = linePlans[lineIndex]
    const neuralCount = plan.neuralCounts[wordIndex]
    const addNeighbour = (delta: number) => {
      const count = neuralCount + delta
      if (count < 2 || count > 24) return []
      const matrix = neuralWordTokens.map((line) => line.map((tokens) => tokens))
      const tokens = recognizeWord(plan.wordStrokes[wordIndex], count)
      matrix[lineIndex][wordIndex] = tokens
      tokenMatrices.push(matrix)
      return tokens
    }
    const reduced = addNeighbour(-1)
    const reducedIsKnownWord = (
      reduced.length > 0 &&
      reduced.every((token) => /^\p{L}$/u.test(token.char)) &&
      reduced.some((token) => token.context?.knownWord)
    )
    // An insertion is the common failure when exact-count segmentation leaves
    // punctuation inside an otherwise textual word. Only pay for the opposite
    // neighbour when the reduced candidate is still not a complete known word
    // and the writer has enough repeated examples to judge the extra cut.
    const samplesPerClass = resources.sampleCount / Math.max(1, resources.classCount)
    if (!reducedIsKnownWord && samplesPerClass >= 2) addNeighbour(1)
  })
  return tokenMatrices.map((matrix) => {
    const result: RecognitionToken[] = []
    matrix.forEach((line, lineIndex) => {
      line.forEach((tokens, wordIndex) => {
        if (wordIndex > 0 && tokens[0]) tokens[0].spaceBefore = true
        if (lineIndex > 0 && wordIndex === 0 && tokens[0]) tokens[0].lineBreakBefore = true
        result.push(...tokens)
      })
    })
    return result
  }).filter((candidate) => candidate.length > 0)
}

/**
 * Runs the generic line model and the user's GlyphenWerk model through one
 * shared sequence decision. Keeping this in one module prevents the embedded
 * GlyphenWerk test from displaying raw TrOCR text while the FaNotes canvas
 * uses the trained personal shapes for the exact same ink.
 */
export const recognizePersonalizedTextLine = async (
  strokes: Stroke[],
  resources: RecognitionResources,
  neural: NeuralTextRecognitionResult,
  language: RecognitionLanguage,
): Promise<PersonalizedLineRecognition> => {
  const recognition = await import('../../../src/lib/recognition')
  let primary: RecognitionToken[] | null = null
  const getPrimary = () => {
    primary ??= recognition.recognizeExpression(
      strokes,
      resources.model,
      resources.labels,
      'text',
      resources.layoutExamples,
      language,
    )
    return primary
  }
  const candidates: RecognitionToken[][] = []
  const neuralCharacterCount = Array.from(neural.text)
    .filter((character) => !/\s/u.test(character)).length

  // The line model provides a useful length prior for connected cursive ink.
  // Verified physical word partitions avoid the much more expensive global
  // beam; ambiguous/connected lines retain that unrestricted fallback so one
  // missing neural character cannot erase a repeatedly trained personal glyph.
  const physicalLines = recognition.groupRecognitionLines(strokes)
  const penLiftCounts = physicalLines.map((line, lineIndex) => {
    const measured = recognition.estimatePenLiftTextCharacterCount(line.strokes)
    const neuralLine = neural.lines[lineIndex]
    if (!measured || !neuralLine) return measured
    const visibleCharacters = Array.from(neuralLine.text)
      .filter((character) => !/\s/u.test(character)).length
    const visibleWords = neuralLine.text.trim().split(/\s+/u).filter(Boolean).length
    // On a multi-word line the wide blank bands can be the only distinct ink
    // gaps. In that case the pen-lift estimator returns the number of words,
    // not the number of letters (for example 3 for "morgen lernen wir").
    // Treating that value as a character count heavily penalized the correct
    // neural-length segmentation and made extensive personal training appear
    // ineffective. Keep genuine letter counts, but reject this unambiguous
    // word-count collapse.
    const collapsedToWordCount = (
      visibleWords >= 2 &&
      measured <= visibleWords + 1 &&
      visibleCharacters >= measured * 2
    )
    return collapsedToWordCount ? null : measured
  })
  if (
    neural.lines.length > 0
    && neural.lines.length === physicalLines.length
    && neural.confidence >= 38
    && neuralCharacterCount > 0
    && neuralCharacterCount <= 320
  ) {
    const separatedWordCandidates = recognizePhysicallySeparatedWords(
      physicalLines,
      neural,
      resources,
      language,
      recognition,
    )
    separatedWordCandidates.forEach((candidate) => {
      const value = recognition.recognizedSentence(candidate)
      if (!candidates.some((existing) => recognition.recognizedSentence(existing) === value)) {
        candidates.push(candidate)
      }
    })

    if (!separatedWordCandidates.length) {
      const primaryCandidate = getPrimary()
      candidates.push(primaryCandidate)
      // Unknown/uncertain neural words commonly contain one insertion or
      // deletion. Test the exact length and its immediate neighbours. The
      // bounded alternatives only activate for suspicious lines; confident
      // dictionary words keep the single fast path.
      const primaryVisible = primaryCandidate.filter((token) => !token.isLayout)
      const primaryPersonalRatio = primaryVisible.filter((token) => (
        (token.personalSupport ?? 0) > 0 ||
        token.alternatives.some((alternative) => (alternative.personalSupport ?? 0) > 0)
      )).length / Math.max(1, primaryVisible.length)
      const hasPersonalSequencePrior = resources.sampleCount > 0 && primaryPersonalRatio >= 0.45
      const neuralLooksSuspicious = neural.confidence < 78 || (neural.knownWordRatio ?? 0) < 0.72
      const primaryCountMismatch = Math.abs(primaryVisible.length - neuralCharacterCount)
      const hasDistinctPenLiftPrior = hasPersonalSequencePrior && penLiftCounts.some((count, index) => {
        if (!count) return false
        const neuralCount = Array.from(neural.lines[index].text).filter((character) => !/\s/u.test(character)).length
        return count !== neuralCount && Math.abs(count - neuralCount) <= 2
      })
      const penLiftIntermediateDeltas = [...new Set(penLiftCounts.flatMap((count, index) => {
        if (!count) return []
        const neuralCount = Array.from(neural.lines[index].text).filter((character) => !/\s/u.test(character)).length
        const difference = count - neuralCount
        return Math.abs(difference) === 2 ? [Math.sign(difference)] : []
      }))]
      // A directly measured blank band is a better count prior than blindly
      // trying both neighbouring line-model lengths. Keep the neural length as
      // a competing hypothesis, then add the measured pen-lift length below.
      const countDeltas = hasDistinctPenLiftPrior
        ? [0, ...penLiftIntermediateDeltas]
        : hasPersonalSequencePrior && primaryCountMismatch >= 2
        ? [0, -1, 1, -2, 2]
        : hasPersonalSequencePrior || neuralLooksSuspicious
          ? [0, -1, 1]
          : [0]
      const strategies: Array<{ delta: number; penLift: boolean; segmentationIndex: number }> = countDeltas
        .map((delta) => ({ delta, penLift: false, segmentationIndex: 0 }))
      if (
        penLiftCounts.some((count, index) => {
          if (!count) return false
          const neuralCount = Array.from(neural.lines[index].text).filter((character) => !/\s/u.test(character)).length
          return count !== neuralCount
        })
      ) {
        const hasLargePenLiftDisagreement = penLiftCounts.some((count, index) => {
          if (!count) return false
          const neuralCount = Array.from(neural.lines[index].text)
            .filter((character) => !/\s/u.test(character)).length
          return Math.abs(count - neuralCount) >= 2
        })
        // Deeper exact-count cuts are expensive and often identical. Run them
        // only when the line model produced an unknown word and independently
        // disagrees with the measured count by at least two characters. This
        // recovers difficult connected words without taxing normal text lines.
        const segmentationIndexes = hasLargePenLiftDisagreement && (neural.knownWordRatio ?? 0) < 0.5
          ? [0, 1, 2]
          : [0]
        segmentationIndexes.forEach((segmentationIndex) => {
          strategies.push({ delta: 0, penLift: true, segmentationIndex })
        })
      }

      // Without a verified word partition, keep the unrestricted primary and
      // bounded whole-line beams as fallbacks.
      strategies.forEach((strategy) => {
        const hinted = physicalLines.flatMap((line, lineIndex) => {
          const neuralLine = neural.lines[lineIndex]
          const neuralLineCharacterCount = Array.from(neuralLine.text)
            .filter((character) => !/\s/u.test(character)).length
          const characterCount = strategy.penLift
            ? penLiftCounts[lineIndex] ?? neuralLineCharacterCount
            : Math.max(1, neuralLineCharacterCount + strategy.delta)
          const tokens = recognition.recognizeExpression(
            line.strokes,
            resources.model,
            resources.labels,
            'text',
            resources.layoutExamples,
            language,
            characterCount,
            !strategy.penLift && strategy.delta === 0 ? neuralLine.text : undefined,
            strategy.segmentationIndex,
          )
          if (lineIndex > 0 && tokens[0]) tokens[0].lineBreakBefore = true
          return tokens
        })
        const value = recognition.recognizedSentence(hinted)
        if (!candidates.some((candidate) => recognition.recognizedSentence(candidate) === value)) {
          candidates.push(hinted)
        }
      })
    }
  }

  if (!candidates.length) candidates.push(getPrimary())

  const measuredCharacterCount = penLiftCounts.length > 0 && penLiftCounts.every(Boolean)
    ? penLiftCounts.reduce<number>((sum, count) => sum + (count ?? 0), 0)
    : null

  return candidates
    .map((tokens) => {
      const fusion = fusePersonalizedTextRecognition(
        tokens,
        neural,
        language,
        measuredCharacterCount ?? undefined,
      )
      const visibleTokenCount = tokens.filter((token) => !token.isLayout).length
      const penLiftMismatch = measuredCharacterCount === null
        ? 0
        : Math.abs(visibleTokenCount - measuredCharacterCount)
      return {
        tokens,
        fusion,
        score: personalizedTextFusionSelectionScore(fusion, neural, language) - penLiftMismatch * 0.22,
      }
    })
    .sort((first, second) => second.score - first.score)[0]
}
